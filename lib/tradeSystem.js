import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";

import { calculateRisk } from "./riskManager.js";
import { logTrade, logSystemEvent } from "./logger.js";
import { getVolatility, getVolatilityRegime } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";
import { buildTimeframeContext, multiTFScore } from "./timeframe.js";

import { getLiquidityZones } from "./liquidityEngine.js";
import { getLiquidationZones } from "./liquidationEngine.js";
import { calculateConfluence } from "./confluenceEngine.js";
import { fetchFunding } from "./funding.js";

import {
  getMTFRSI,
  getRSISignal
} from "./rsiEngine.js";

import {
  sendEntry,
  sendExit
} from "./discordNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";

// ================= STRATEGY VERSION =================
// Verhoog deze string zodra je filters/logica wijzigt.
// Dan reset de runtime audit automatisch, zodat oude trades niet door nieuwe optimalisatie lopen.
const STRATEGY_VERSION = "TS_V7_STRICT_A_TP_DISTANCE_NO_SCALE";

// ================= CACHE =================
const apiCache = new Map();

async function cachedFetch(key, fn, ttl = 30000) {
  const cached = apiCache.get(key);

  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }

  const data = await fn();
  apiCache.set(key, { data, ts: Date.now() });

  return data;
}

// ================= CONSTANTEN =================
const COOLDOWN_MS = 45 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;

const MAX_SPREAD_PCT = 0.0025;
const MIN_DEPTH_USD_1P = 200000;

const MIN_RR_FLOOR = 1.0;
const GRADE_A_MIN_RR_FLOOR = 1.0;
const GRADE_B_MIN_RR_FLOOR = 1.05;
const GRADE_C_MIN_RR_FLOOR = 1.10;
const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.20;

// Entry-class thresholds
const GOD_MIN_SNIPER = 88;
const GOD_MIN_CONFLUENCE = 88;
const GOD_MIN_RR = 1.20;

const A_MIN_SNIPER = 74;
const A_MIN_CONFLUENCE = 78;
const A_MIN_RR = 1.15;

const B_MIN_SNIPER = 68;
const B_MIN_CONFLUENCE = 72;
const B_MIN_RR = 1.15;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  fetchFailed: true
};

const TRADE_SYSTEM_FILTERS = Object.freeze([
  {
    phase: "CANDIDATE",
    filter: "UI_ONLY",
    rule: "uiOnly must be false",
    blockReason: "candidate_removed_before_process"
  },
  {
    phase: "CANDIDATE",
    filter: "STAGE",
    rule: "stage must be scanner-entry or scanner-almost",
    blockReason: "candidate_removed_before_process"
  },
  {
    phase: "CANDIDATE",
    filter: "SCORE",
    rule: "moveScore >= 50 before tradeSystem processing",
    blockReason: "candidate_removed_before_process"
  },
  {
    phase: "POSITION",
    filter: "OPEN POSITION TRACKING",
    rule: "open memory positions are always processed before new-entry filters",
    blockReason: "HOLD / EXIT"
  },
  {
    phase: "BTC",
    filter: "BTC DIRECTION GATE",
    rule: "block weak counter-BTC trades",
    blockReason: "BTC_*"
  },
  {
    phase: "RSI",
    filter: "RSI DATA",
    rule: "15m + 1h RSI must be valid",
    blockReason: "RSI_DATA_INVALID"
  },
  {
    phase: "RSI",
    filter: "HTF RSI BLOCK",
    rule: "block extreme 4h RSI against direction",
    blockReason: "RSI_HTF_BLOCKED"
  },
  {
    phase: "RSI",
    filter: "LONG TOO HIGH",
    rule: "long blocked in UPPER zones",
    blockReason: "RSI_LONG_TOO_HIGH"
  },
  {
    phase: "RSI",
    filter: "RSI EDGE",
    rule: "long needs LOWER/early/trend-continuation; short needs UPPER/early/trend-continuation",
    blockReason: "RSI_LONG_NO_EDGE / RSI_SHORT_NO_EDGE"
  },
  {
    phase: "RSI",
    filter: "MID ZONE",
    rule: "MID only allowed with strong trend-continuation",
    blockReason: "RSI_MID_NO_EDGE"
  },
  {
    phase: "OB",
    filter: "ORDERBOOK",
    rule: "orderbook fetch must succeed",
    blockReason: "ORDERBOOK_FETCH_FAILED"
  },
  {
    phase: "MOMENTUM",
    filter: "MOMENTUM",
    rule: "requires strong or soft momentum",
    blockReason: "NO_MOMENTUM"
  },
  {
    phase: "FAKE BREAKOUT",
    filter: "FAKE BREAKOUT / TREND",
    rule: "non-trend setups need fake-breakout context",
    blockReason: "NO_FAKE_BREAKOUT"
  },
  {
    phase: "ENTRY GUARDS",
    filter: "OPEN / LOCK / COOLDOWN",
    rule: "no duplicate symbol, lock, symbol cooldown, recent signal",
    blockReason: "SYMBOL_ALREADY_OPEN / COOLDOWN / SYMBOL_COOLDOWN / RECENT_SIGNAL_COOLDOWN"
  },
  {
    phase: "QUALITY",
    filter: "RR",
    rule: "rr must meet dynamic floor unless override",
    blockReason: "LOW_RR"
  },
  {
    phase: "QUALITY",
    filter: "VOL / FLOW / TF",
    rule: "avoid weak low-vol, no-flow and weak-TF setups",
    blockReason: "LOW_VOL / NO_FLOW / ENTRY_FILTERED_TF_WEAK"
  },
  {
    phase: "QUALITY",
    filter: "CONFLUENCE",
    rule: "confluence >= 62",
    blockReason: "LOW_CONFLUENCE"
  },
  {
    phase: "QUALITY",
    filter: "OB AGAINST / MARKET QUALITY",
    rule: "block OB-against or bad spread/depth unless confluence is high",
    blockReason: "OB_AGAINST / BAD_MARKET_QUALITY"
  },
  {
    phase: "QUALITY",
    filter: "FUNDING",
    rule: "block crowded/extreme funding unless confluence is high",
    blockReason: "EXTREME_FUNDING / BULL_CROWDED_FUNDING / BEAR_CROWDED_FUNDING"
  },
  {
    phase: "ENTRY",
    filter: "A/B/GOD ONLY",
    rule: "GOD, A or B setup only. No C_ENTRY. No scaling. A/B separated by setupClass.",
    blockReason: "SETUP_NOT_READY"
  }
]);

// ================= RUNTIME STATE =================
function createAuditState() {
  return {
    strategyVersion: STRATEGY_VERSION,
    startedAt: Date.now(),
    runs: 0,

    entries: 0,
    exits: 0,
    wins: 0,
    losses: 0,

    rTotal: 0,
    pnlPctTotal: 0,

    entryReasonCounts: {},
    entrySetupClassCounts: {},
    exitReasonCounts: {},

    lastSnapshotAt: 0
  };
}

function createRuntimeState() {
  return {
    strategyVersion: STRATEGY_VERSION,
    memory: new Map(),
    notifyState: new Map(),
    cooldownMap: new Map(),
    symbolCooldownMap: new Map(),
    processingLocks: new Set(),
    lastSignalMap: new Map(),
    audit: createAuditState()
  };
}

const globalKey = "__TRADE_SYSTEM_RUNTIME_STATE__";
const runtimeState = globalThis[globalKey] || createRuntimeState();

if (runtimeState.strategyVersion !== STRATEGY_VERSION) {
  runtimeState.strategyVersion = STRATEGY_VERSION;
  runtimeState.memory = new Map();
  runtimeState.notifyState = new Map();
  runtimeState.cooldownMap = new Map();
  runtimeState.symbolCooldownMap = new Map();
  runtimeState.processingLocks = new Set();
  runtimeState.lastSignalMap = new Map();
  runtimeState.audit = createAuditState();

  console.log(`TRADE SYSTEM RESET: new strategyVersion=${STRATEGY_VERSION}`);
}

globalThis[globalKey] = runtimeState;

const memory = runtimeState.memory;
const notifyState = runtimeState.notifyState;
const cooldownMap = runtimeState.cooldownMap;
const symbolCooldownMap = runtimeState.symbolCooldownMap;
const processingLocks = runtimeState.processingLocks;
const lastSignalMap = runtimeState.lastSignalMap;
const auditState = runtimeState.audit;

// ================= HELPERS =================
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBitgetSymbol(raw) {
  let s = String(raw || "").toUpperCase().trim();

  s = s
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!s.endsWith("USDT") && !s.endsWith("USDC")) {
    s = `${s}USDT`;
  }

  return s;
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) return 0.001;
  if (s > 0.05) s = s / 100;

  return s;
}

function formatRR(rr) {
  const n = Number(rr || 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function stageRank(stage) {
  if (stage === "entry") return 4;
  if (stage === "almost") return 3;
  if (stage === "buildup") return 2;
  if (stage === "radar") return 1;
  return 0;
}

function getSniperScore(sniper) {
  return Number(sniper?.score || 0);
}

function getRegimeKey(regimeObj, scannerRegime) {
  const raw = regimeObj?.level || regimeObj || scannerRegime || "NORMAL";
  return String(raw).toUpperCase();
}

function getRegimeValueForConfluence(regime, scannerRegime) {
  const raw = String(regime?.level || regime || scannerRegime || "NORMAL").toUpperCase();

  if (raw === "HIGH_VOL" || raw === "HIGH") return "HIGH";
  if (raw === "LOW_VOL" || raw === "LOW") return "LOW";

  return raw;
}

function isObWithSide(ob, isBull) {
  return (
    (isBull && ob?.bias === "BULLISH") ||
    (!isBull && ob?.bias === "BEARISH")
  );
}

function isObAgainstSide(ob, isBull) {
  return (
    (isBull && ob?.bias === "BEARISH") ||
    (!isBull && ob?.bias === "BULLISH")
  );
}

function incrementMapCount(map, key) {
  const k = String(key || "UNKNOWN");
  map[k] = Number(map[k] || 0) + 1;
}

function cleanExpiredGuards() {
  const now = Date.now();

  for (const [key, until] of cooldownMap) {
    if (now >= until) cooldownMap.delete(key);
  }

  for (const [symbol, until] of symbolCooldownMap) {
    if (now >= until) symbolCooldownMap.delete(symbol);
  }

  for (const [symbol, until] of lastSignalMap) {
    if (now >= until) lastSignalMap.delete(symbol);
  }
}

function hasAnyOpenPositionForSymbol(symbol) {
  const s = normalizeBaseSymbol(symbol);

  for (const key of memory.keys()) {
    if (key.startsWith(`${s}_`)) return true;
  }

  return false;
}

function getOpenPositionSideForSymbol(symbol) {
  const s = normalizeBaseSymbol(symbol);

  for (const key of memory.keys()) {
    if (key.startsWith(`${s}_`)) {
      return key.split("_")[1] || "unknown";
    }
  }

  return null;
}

function getTimeframeMeta(c) {
  let ctx = {};
  let tfScore = 0;

  try {
    ctx = buildTimeframeContext(c) || {};
  } catch {
    ctx = {};
  }

  if (Number.isFinite(Number(ctx?.score))) {
    tfScore = Number(ctx.score);
  } else if (Number.isFinite(Number(c?.tfScore))) {
    tfScore = Number(c.tfScore);
  } else {
    tfScore = Number(multiTFScore(c) || 0);
  }

  return {
    ctx,
    tfScore,
    tfStrength: Math.abs(tfScore),
    tfAlignment: String(ctx?.alignment || c?.tfAlignment || "UNKNOWN")
  };
}

function getRsiZone(rsiSignal) {
  const rsi = Number(rsiSignal?.rsi);
  const zones = rsiSignal?.zones;

  if (!Number.isFinite(rsi) || !zones) return "MID";

  if (rsi <= zones.L3) return "LOWER_3";
  if (rsi <= zones.L2) return "LOWER_2";
  if (rsi <= zones.L1) return "LOWER_1";

  if (rsi >= zones.U3) return "UPPER_3";
  if (rsi >= zones.U2) return "UPPER_2";
  if (rsi >= zones.U1) return "UPPER_1";

  return "MID";
}

function getActionPriority(action) {
  const a = String(action?.action || "").toUpperCase();
  const setupClass = String(action?.setupClass || "NONE").toUpperCase();

  if (a === "ENTRY" && setupClass === "GOD") return 7000;
  if (a === "ENTRY" && setupClass === "A") return 6000;
  if (a === "ENTRY" && setupClass === "B") return 5000;
  if (a === "EXIT") return 4000;
  if (a === "HOLD") return 3000;
  if (a === "WAIT") return 1000;

  return 0;
}

function sortActions(actions) {
  return [...actions].sort((a, b) => {
    const priorityDiff = getActionPriority(b) - getActionPriority(a);
    if (priorityDiff !== 0) return priorityDiff;

    const confDiff = Number(b.confluence || 0) - Number(a.confluence || 0);
    if (confDiff !== 0) return confDiff;

    return Number(b.score || 0) - Number(a.score || 0);
  });
}

function adjustTpDistance(entry, tp, isBull, factor) {
  const e = Number(entry || 0);
  const t = Number(tp || 0);
  const f = Number(factor || 1);

  if (!e || !t || !Number.isFinite(f) || f <= 0) return t || 0;

  const dist = Math.abs(t - e);
  if (!dist) return t;

  return isBull
    ? e + (dist * f)
    : e - (dist * f);
}

function buildCommonPayload(c, flow, sniper, funding, ob) {
  return {
    symbol: c.symbol,
    side: c.side,
    stage: c.stage,
    scannerStage: c.scannerStage || c.stage,
    stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly),

    score: Number(c.moveScore || 0),
    price: c.price,

    flow: flow?.type || c.flow || "NEUTRAL",
    sniper: sniper?.type || "NONE",
    sniperScore: Number(sniper?.score || 0),

    setupClass: c.setupClass || null,

    funding: Number(funding?.rate || 0),

    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null,

    tfScore: Number(c?.tfScore || 0),
    tfStrength: Number(c?.tfStrength || 0),
    tfAlignment: c?.tfAlignment || "UNKNOWN",

    minRrRequired: Number(c?.minRrFloor || 0),
    rsiZone: c._debugRsiZone || null,
    fakeBreakout: c._debugFakeBreakout ?? null,
    analysisType: c.analysisType || "DEEP",
    fromOpenPosition: Boolean(c.fromOpenPosition),

    strategyVersion: STRATEGY_VERSION,
    ts: Date.now()
  };
}

function buildWait(
  c,
  reason,
  flow,
  sniper,
  confluence,
  rr,
  funding,
  ob,
  risk,
  setupGrade,
  requiredConfluence,
  requiredRR
) {
  const payload = {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "WAIT",
    reason,

    grade: setupGrade?.grade || "C",
    gradePoints: setupGrade?.points || 0,
    recommendedRisk: setupGrade?.recommendedRisk || "watch",

    confluence,
    rr: formatRR(rr),

    entry: risk?.entry ?? c.price ?? null,
    sl: risk?.sl ?? null,
    tp: risk?.tp ?? null,

    slSource: risk?.slSource || "liquidity/orderbook",
    tpSource: risk?.tpSource || "liquidity/liquidation",

    requiredConfluence: requiredConfluence ?? null,
    requiredRR: requiredRR ?? null,
    reasonScore: null
  };

  if (reason === "LOW_CONFLUENCE" && requiredConfluence !== null && confluence !== null) {
    payload.reasonScore = Number(confluence) - Number(requiredConfluence);
  }

  if (reason === "LOW_RR" && requiredRR !== null && rr !== null) {
    payload.reasonScore = Number(rr) - Number(requiredRR);
  }

  console.log(
    `🚫 BLOCK: ${c.symbol} | ${reason} | setup=${c.setupClass || "NONE"} | rsiZone=${c._debugRsiZone || "?"} | sniper=${sniper?.score || 0} | conf=${confluence} | rr=${formatRR(rr)} | fake=${c._debugFakeBreakout} | flow=${flow?.type}`
  );

  return payload;
}

async function logAction(actionPayload, regimeLevel, btcState, shouldLog) {
  if (!shouldLog || !actionPayload) return;

  await logSystemEvent({
    ...actionPayload,
    regime: regimeLevel,
    btcState
  });
}

function updateOrderbookMemorySafe(symbol, raw, analyzed) {
  try {
    updateOrderbookMemory(symbol, {
      bids: Array.isArray(raw?.bids) ? raw.bids : [],
      asks: Array.isArray(raw?.asks) ? raw.asks : [],
      mid: Number(analyzed?.mid || 0),
      analyzed: analyzed || null
    });
  } catch (e) {
    console.warn(`Orderbook memory update failed for ${symbol}:`, e.message);
  }
}

// ================= FETCH CANDLES =================
async function fetchCandles(symbol, timeframe = "1h", limit = 100) {
  const tfMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H"
  };

  const granularity = tfMap[timeframe] || "1H";
  const clean = normalizeBitgetSymbol(symbol);

  const url =
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429 || res.status === 400) {
        console.warn(`⚠️ BITGET candle limit (${res.status}) voor ${clean}, attempt ${attempt + 1}`);
        await sleep(250);
        continue;
      }

      const json = await res.json();

      if (!Array.isArray(json?.data)) return [];

      return json.data.map(c => ({
        openTime: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0)
      }));
    } catch (e) {
      console.error(`Candle fetch error voor ${clean}:`, e.message);
      return [];
    }
  }

  return [];
}

// ================= CANDIDATES =================
function buildCandidateExample(c) {
  return `${normalizeBaseSymbol(c?.symbol)}_${String(c?.side || "?").toLowerCase()}_${String(c?.stage || "?").toLowerCase()}_${Number(c?.moveScore || 0)}`;
}

function createPrefilterStats(rawCount) {
  return {
    strategyVersion: STRATEGY_VERSION,
    rawCount,
    acceptedCount: 0,
    removed: {
      MISSING: 0,
      UI_ONLY: 0,
      STAGE: 0,
      SCORE: 0
    },
    examples: {
      MISSING: [],
      UI_ONLY: [],
      STAGE: [],
      SCORE: []
    },
    openPositionInjected: 0
  };
}

function pushPrefilterReject(stats, reason, coin) {
  stats.removed[reason] = Number(stats.removed[reason] || 0) + 1;

  if (stats.examples[reason] && stats.examples[reason].length < 10) {
    stats.examples[reason].push(buildCandidateExample(coin));
  }
}

function dedupeCandidates(coins) {
  const map = new Map();

  for (const raw of Array.isArray(coins) ? coins : []) {
    if (!raw?.symbol || !raw?.side) continue;

    const symbol = normalizeBaseSymbol(raw.symbol);
    const side = String(raw.side).toLowerCase();
    const stage = String(raw.stage || "radar").toLowerCase();

    if (side !== "bull" && side !== "bear") continue;

    const normalized = {
      ...raw,
      symbol,
      side,
      stage
    };

    const key = `${symbol}_${side}`;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, normalized);
      continue;
    }

    const prevStage = stageRank(prev.stage);
    const newStage = stageRank(stage);
    const prevScore = Number(prev.moveScore || 0);
    const newScore = Number(normalized.moveScore || 0);

    if (newStage > prevStage || (newStage === prevStage && newScore > prevScore)) {
      map.set(key, normalized);
    }
  }

  return Array.from(map.values()).sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
}

function buildTradeCandidates(candidatesRaw) {
  const raw = Array.isArray(candidatesRaw) ? candidatesRaw : [];
  const prefilterStats = createPrefilterStats(raw.length);

  const filtered = [];

  for (const c of raw) {
    if (!c?.symbol || !c?.side) {
      pushPrefilterReject(prefilterStats, "MISSING", c);
      continue;
    }

    if (Boolean(c.uiOnly)) {
      pushPrefilterReject(prefilterStats, "UI_ONLY", c);
      continue;
    }

    const stage = String(c.stage || "").toLowerCase();
    const score = Number(c.moveScore || 0);

    if (stage !== "entry" && stage !== "almost") {
      pushPrefilterReject(prefilterStats, "STAGE", c);
      continue;
    }

    if (score < 50) {
      pushPrefilterReject(prefilterStats, "SCORE", c);
      continue;
    }

    filtered.push(c);
  }

  const map = new Map();

  for (const c of dedupeCandidates(filtered)) {
    const key = `${normalizeBaseSymbol(c.symbol)}_${String(c.side).toLowerCase()}`;

    map.set(key, {
      ...c,
      setupClass: null,
      analysisType: "DEEP",
      fromOpenPosition: false
    });
  }

  for (const [key, pos] of memory.entries()) {
    if (map.has(key)) continue;

    prefilterStats.openPositionInjected++;

    map.set(key, {
      symbol: pos.symbol,
      side: pos.side,
      stage: "entry",
      scannerStage: "open_position",
      stageSource: "memory",
      uiOnly: false,
      moveScore: Number(pos.score || pos.moveScore || 100),
      price: pos.entry,
      rawBitgetSymbol: pos.rawBitgetSymbol || pos.symbol,
      setupClass: pos.setupClass || "OPEN",
      analysisType: "DEEP",
      fromOpenPosition: true
    });
  }

  const candidates = Array.from(map.values()).sort((a, b) => {
    if (a.fromOpenPosition !== b.fromOpenPosition) {
      return a.fromOpenPosition ? -1 : 1;
    }

    return Number(b.moveScore || 0) - Number(a.moveScore || 0);
  });

  prefilterStats.acceptedCount = candidates.filter(c => !c.fromOpenPosition).length;

  console.table([
    { type: "raw", count: prefilterStats.rawCount },
    { type: "accepted", count: prefilterStats.acceptedCount },
    { type: "removed_missing", count: prefilterStats.removed.MISSING },
    { type: "removed_ui_only", count: prefilterStats.removed.UI_ONLY },
    { type: "removed_stage", count: prefilterStats.removed.STAGE },
    { type: "removed_score", count: prefilterStats.removed.SCORE }
  ]);

  console.log("TRADE SYSTEM prefilter json:", JSON.stringify(prefilterStats));

  return {
    candidates,
    prefilterStats
  };
}

// ================= RISK / RR =================
function calculateFallbackRR(c, risk, isBull) {
  const price = Number(c.price || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);

  if (!price || !sl || !tp) return 0;

  const raw = isBull
    ? (tp - price) / (price - sl)
    : (price - tp) / (sl - price);

  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

function calculateExitR(pos, exitPrice, isBull) {
  const entry = Number(pos?.entry || 0);
  const sl = Number(pos?.sl || 0);
  const exit = Number(exitPrice || 0);

  if (!entry || !sl || !exit) return 0;

  const risk = Math.abs(entry - sl);
  if (!risk) return 0;

  const pnl = isBull
    ? exit - entry
    : entry - exit;

  return pnl / risk;
}

function calculatePnlPct(pos, exitPrice, isBull) {
  const entry = Number(pos?.entry || 0);
  const exit = Number(exitPrice || 0);

  if (!entry || !exit) return 0;

  const raw = isBull
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;

  return Number.isFinite(raw) ? raw : 0;
}

function getDynamicBreakoutBufferPct(c, regimeObj, vol, ob) {
  const ch1Abs = Math.abs(Number(c.change1h || 0));
  const ch24Abs = Math.abs(Number(c.change24 || 0));
  const spread = normalizeSpread(ob?.spreadPct);
  const regimeKey = getRegimeKey(regimeObj, null);

  let pct = 0.0025;

  pct += clamp((ch1Abs / 100) * 0.70, 0, 0.0050);
  pct += clamp((ch24Abs / 100) * 0.10, 0, 0.0030);
  pct += clamp(spread * 0.60, 0, 0.0015);

  if (vol === "HIGH") pct += 0.0010;
  if (regimeKey === "HIGH_VOL" || regimeKey === "HIGH") pct += 0.0010;
  if (regimeKey === "LOW_VOL" || regimeKey === "LOW") pct -= 0.0005;

  return clamp(pct, 0.0025, 0.0120);
}

function getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull }) {
  let points = 0;

  const tfStrength = Number(c?.tfStrength || 0);
  const sniperScore = getSniperScore(sniper);

  if (confluence >= 85) points += 4;
  else if (confluence >= 75) points += 3;
  else if (confluence >= 65) points += 2;
  else if (confluence >= 55) points += 1;

  if (flow.type === "TREND") points += 2;
  else if (flow.type === "BUILDING") points += 1;

  if (sniper?.valid) points += 2;
  if (sniperScore >= 75) points += 1;

  if (tfStrength >= 2) points += 2;
  else if (tfStrength >= 1) points += 1;

  if (isObWithSide(ob, isBull)) points += 2;
  if (isObAgainstSide(ob, isBull)) points -= 2;

  if (hasLiquidationData) points += 1;

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  if (spread <= MAX_SPREAD_PCT && depth >= MIN_DEPTH_USD_1P) points += 1;
  if (spread > MAX_SPREAD_PCT || depth < MIN_DEPTH_USD_1P) points -= 2;

  if (c.stage === "entry") points += 1;
  if (rr >= 1.4) points += 1;
  if (rr < 0.8) points -= 1;

  let grade = "C";
  let recommendedRisk = "watch";

  if (points >= 9) {
    grade = "A";
    recommendedRisk = "normal";
  } else if (points >= 7) {
    grade = "B";
    recommendedRisk = "small";
  }

  if (grade === "A" && confluence < 70) {
    grade = "B";
    recommendedRisk = "small";
  }

  return {
    grade,
    points,
    recommendedRisk
  };
}

function getDynamicMinRrFloor({ c, setupGrade, flow, sniper, confluence, counterTrend }) {
  let floor = MIN_RR_FLOOR;

  if (setupGrade?.grade === "A") floor = GRADE_A_MIN_RR_FLOOR;
  else if (setupGrade?.grade === "B") floor = GRADE_B_MIN_RR_FLOOR;
  else floor = GRADE_C_MIN_RR_FLOOR;

  if (c.stage === "buildup") {
    floor = Math.max(floor, BUILDUP_MIN_RR_FLOOR);
  }

  if (counterTrend) {
    floor = Math.max(floor, COUNTERTREND_MIN_RR_FLOOR);
  }

  if (
    c.stage === "entry" &&
    flow?.type === "TREND" &&
    !counterTrend &&
    setupGrade?.grade === "A" &&
    confluence >= 90 &&
    sniper?.valid &&
    getSniperScore(sniper) >= 85
  ) {
    floor = Math.min(floor, 1.00);
  }

  return clamp(floor, 0.95, 1.50);
}

function getSniperAdjustedRR(sniper, baseRR) {
  const score = Number(sniper?.score || 0);

  if (score >= 90) return Math.max(1.00, baseRR - 0.12);
  if (score >= 80) return Math.max(1.03, baseRR - 0.05);
  if (score >= 70) return Math.max(1.08, baseRR);

  return baseRR + 0.10;
}

function isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend }) {
  const sniperScore = getSniperScore(sniper);

  if (c.stage !== "entry") return false;
  if (flow.type !== "TREND") return false;
  if (counterTrend) return false;

  if (
    setupGrade.grade === "A" &&
    confluence >= 84 &&
    rr >= 1.15 &&
    sniper?.valid &&
    sniperScore >= 78
  ) {
    return true;
  }

  if (
    setupGrade.grade === "B" &&
    confluence >= 86 &&
    rr >= 1.20 &&
    sniper?.valid &&
    sniperScore >= 82 &&
    Number(c.moveScore || 0) >= 84
  ) {
    return true;
  }

  return false;
}

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

// ================= AUDIT =================
function recordEntry(entryPayload, position) {
  auditState.entries++;
  incrementMapCount(auditState.entryReasonCounts, entryPayload.reason);
  incrementMapCount(auditState.entrySetupClassCounts, position.setupClass || "UNKNOWN");
}

function recordExit(exitPayload, pos, exitPrice, isBull) {
  const r = calculateExitR(pos, exitPrice, isBull);
  const pnlPct = calculatePnlPct(pos, exitPrice, isBull);

  auditState.exits++;
  auditState.rTotal += r;
  auditState.pnlPctTotal += pnlPct;

  if (exitPayload.reason === "TP") auditState.wins++;
  if (exitPayload.reason === "SL") auditState.losses++;

  incrementMapCount(auditState.exitReasonCounts, exitPayload.reason);

  exitPayload.exitR = Number(r.toFixed(3));
  exitPayload.pnlPct = Number(pnlPct.toFixed(3));
  exitPayload.setupClass = pos.setupClass || "UNKNOWN";
  exitPayload.strategyVersion = pos.strategyVersion || STRATEGY_VERSION;
}

function buildOpenPositionRows() {
  return Array.from(memory.values()).map(pos => ({
    symbol: pos.symbol,
    side: pos.side,
    setupClass: pos.setupClass || "UNKNOWN",
    grade: pos.grade || "N/A",
    reason: pos.reason || pos.entryReason || "N/A",
    entry: pos.entry,
    sl: pos.sl,
    tp: pos.tp,
    rr: formatRR(pos.rr),
    score: pos.score || pos.moveScore || 0,
    conf: pos.confluence || 0,
    sniper: pos.sniperScore || 0,
    rsiZone: pos.rsiZone || null,
    strategyVersion: pos.strategyVersion || STRATEGY_VERSION
  }));
}

function buildReasonTable(actions) {
  const rows = Array.isArray(actions) ? actions : [];
  const total = rows.length || 0;

  const reasonCounts = {};
  const reasonExamples = {};

  for (const row of rows) {
    const action = String(row?.action || "UNKNOWN").toUpperCase();
    const reason = String(row?.reason || "NO_REASON").toUpperCase();
    const reasonKey = action === "WAIT" ? reason : `${action}_${reason}`;

    reasonCounts[reasonKey] = Number(reasonCounts[reasonKey] || 0) + 1;

    if (!reasonExamples[reasonKey]) {
      reasonExamples[reasonKey] = [];
    }

    if (reasonExamples[reasonKey].length < 10) {
      reasonExamples[reasonKey].push(`${row.symbol}_${row.side}_${row.stage}_${row.score}`);
    }
  }

  return Object.entries(reasonCounts)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "0%",
      examples: reasonExamples[reason]?.join(", ") || ""
    }))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
}

function buildSetupClassTable(actions) {
  const rows = Array.isArray(actions) ? actions : [];
  const entries = rows.filter(r => String(r?.action || "").toUpperCase() === "ENTRY");
  const total = entries.length || 0;

  const counts = {};
  const examples = {};

  for (const row of entries) {
    const setupClass = String(row?.setupClass || "UNKNOWN").toUpperCase();
    counts[setupClass] = Number(counts[setupClass] || 0) + 1;

    if (!examples[setupClass]) examples[setupClass] = [];

    if (examples[setupClass].length < 10) {
      examples[setupClass].push(`${row.symbol}_${row.side}_${row.reason}_${row.score}`);
    }
  }

  return Object.entries(counts)
    .map(([setupClass, count]) => ({
      setupClass,
      count,
      pct: total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "0%",
      examples: examples[setupClass]?.join(", ") || ""
    }))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
}

function logTradeSystemAudit({ candidates, actions, btcState, runId }) {
  const rows = Array.isArray(actions) ? actions : [];
  const reasonTable = buildReasonTable(rows);
  const setupClassTable = buildSetupClassTable(rows);

  const actionCounts = {};
  const entryRows = [];

  for (const row of rows) {
    const action = String(row?.action || "UNKNOWN").toUpperCase();
    actionCounts[action] = Number(actionCounts[action] || 0) + 1;

    if (action === "ENTRY") {
      entryRows.push({
        symbol: row.symbol,
        side: row.side,
        setupClass: row.setupClass,
        reason: row.reason,
        grade: row.grade,
        score: row.score,
        sniper: row.sniperScore,
        conf: row.confluence,
        rr: row.rr,
        rsiZone: row.rsiZone,
        obBias: row.obBias
      });
    }
  }

  const openPositionRows = buildOpenPositionRows();

  console.log("========== TRADE SYSTEM FILTERS ==========");
  console.table(TRADE_SYSTEM_FILTERS);

  console.log("========== TRADE SYSTEM SUMMARY ==========");
  console.log("TRADE SYSTEM strategyVersion:", STRATEGY_VERSION);
  console.log("TRADE SYSTEM candidates:", Array.isArray(candidates) ? candidates.length : 0);
  console.log("TRADE SYSTEM actions:", rows.length);
  console.log("TRADE SYSTEM action counts:", JSON.stringify(actionCounts));

  if (reasonTable.length) {
    console.log(
      `TRADE SYSTEM biggest reason: ${reasonTable[0].reason} (${reasonTable[0].count} / ${reasonTable[0].pct})`
    );
  }

  console.log("========== TRADE SYSTEM REJECT / ACTION TABLE ==========");
  console.table(reasonTable.slice(0, 60));
  console.log("TRADE SYSTEM reason json:", JSON.stringify(reasonTable.slice(0, 60)));

  console.log("========== TRADE SYSTEM SETUP CLASS TABLE ==========");
  if (setupClassTable.length) {
    console.table(setupClassTable);
  } else {
    console.log("TRADE SYSTEM setupClass entries: 0");
  }
  console.log("TRADE SYSTEM setupClass json:", JSON.stringify(setupClassTable));

  if (entryRows.length) {
    console.log("========== TRADE SYSTEM ENTRIES ==========");
    console.table(entryRows);
  } else {
    console.log("TRADE SYSTEM entries this run: 0");
  }

  console.log("========== TRADE SYSTEM OPEN POSITIONS ==========");
  if (openPositionRows.length) {
    console.table(openPositionRows);
  } else {
    console.log("TRADE SYSTEM open positions: 0");
  }

  auditState.runs++;
  auditState.lastSnapshotAt = Date.now();

  const completed = auditState.wins + auditState.losses;
  const winrate = completed > 0
    ? `${((auditState.wins / completed) * 100).toFixed(1)}%`
    : "0.0%";

  const avgR = auditState.exits > 0
    ? auditState.rTotal / auditState.exits
    : 0;

  const avgPnlPct = auditState.exits > 0
    ? auditState.pnlPctTotal / auditState.exits
    : 0;

  const snapshot = {
    tag: "TS_AUDIT_SNAPSHOT",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,

    runs: auditState.runs,

    candidates: Array.isArray(candidates) ? candidates.length : 0,
    actions: rows.length,
    actionCounts,

    entries: auditState.entries,
    exits: auditState.exits,
    wins: auditState.wins,
    losses: auditState.losses,
    winrate,

    rTotal: Number(auditState.rTotal.toFixed(3)),
    avgR: Number(avgR.toFixed(3)),

    pnlPctTotal: Number(auditState.pnlPctTotal.toFixed(3)),
    avgPnlPct: Number(avgPnlPct.toFixed(3)),

    openPositions: memory.size,

    entryReasonCounts: auditState.entryReasonCounts,
    entrySetupClassCounts: auditState.entrySetupClassCounts,
    exitReasonCounts: auditState.exitReasonCounts,

    biggestCurrentReason: reasonTable[0] || null,

    startedAt: auditState.startedAt,
    ts: Date.now()
  };

  console.log("========== TRADE SYSTEM AUDIT SNAPSHOT ==========");
  console.log("TS_AUDIT_SNAPSHOT", JSON.stringify(snapshot));
}

function finalizeResult(actions, candidates, btcState, runId) {
  const finalActions = actions.length > 0
    ? sortActions(actions)
    : candidates.map(c => ({
        symbol: c.symbol,
        side: c.side,
        action: "WAIT",
        reason: "NO_VALID_SETUPS",
        score: c.moveScore || 0,
        setupClass: c.setupClass || null,
        ts: Date.now(),
        analysisType: c.analysisType || "DEEP",
        strategyVersion: STRATEGY_VERSION
      }));

  if (actions.length === 0 && candidates.length > 0) {
    console.warn("⚠️ NO ACTIONS from tradeSystem – fallback WAIT generated");
  }

  logTradeSystemAudit({
    candidates,
    actions: finalActions,
    btcState,
    runId
  });

  return {
    actions: finalActions,
    candidatesCount: candidates.length,
    strategyVersion: STRATEGY_VERSION
  };
}

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let candidatesRaw = [];
  let scanRegime = options.regime || null;
  let scanBtc = options.btc || null;

  if (Array.isArray(input)) {
    candidatesRaw = input;
  } else {
    candidatesRaw = [
      ...(input?.funnel?.bull?.entry || []),
      ...(input?.funnel?.bear?.entry || []),
      ...(input?.funnel?.bull?.almost || []),
      ...(input?.funnel?.bear?.almost || [])
    ];

    scanRegime = input?.regime || scanRegime;
    scanBtc = input?.btc || scanBtc;
  }

  cleanExpiredGuards();

  const { candidates } = buildTradeCandidates(candidatesRaw);
  const actions = [];

  let market = { trend: "NEUTRAL" };

  try {
    market = await getMarketContext("BTCUSDT", 0);
  } catch (e) {
    console.warn("Market context fallback:", e.message);
  }

  const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

  if (candidates.length === 0) {
    logTradeSystemAudit({
      candidates: [],
      actions: [],
      btcState,
      runId
    });

    return {
      actions: [],
      candidatesCount: 0,
      strategyVersion: STRATEGY_VERSION
    };
  }

  // ================= DATA FETCH =================
  const dataMap = new Map();

  const fetchCoinData = async c => {
    const symbol = normalizeBaseSymbol(c.symbol);
    const contractSymbol = normalizeBitgetSymbol(c.rawBitgetSymbol || symbol);

    let ob = { ...DEFAULT_OB };

    try {
      const raw = await cachedFetch(`ob_${contractSymbol}`, async () => {
        let data = null;

        for (let i = 0; i < 2; i++) {
          try {
            data = await fetchOrderBook(contractSymbol);
            if (data) break;
          } catch {}

          await sleep(200);
        }

        return data;
      }, 15000);

      if (raw) {
        const analyzed = analyzeOrderBookAdvanced(raw);

        ob = {
          ...DEFAULT_OB,
          ...(analyzed || {}),
          fetchFailed: false
        };

        updateOrderbookMemorySafe(symbol, raw, analyzed);
      }
    } catch {
      ob = { ...DEFAULT_OB };
    }

    let funding = { rate: 0 };

    try {
      funding = await cachedFetch(
        `fund_${contractSymbol}`,
        () => fetchFunding(contractSymbol),
        120000
      );
    } catch {}

    const candles15m = await cachedFetch(
      `c15_${contractSymbol}`,
      () => fetchCandles(contractSymbol, "15m", 100),
      20000
    );

    const candles1h = await cachedFetch(
      `c1h_${contractSymbol}`,
      () => fetchCandles(contractSymbol, "1h", 100),
      20000
    );

    let candles4h = null;

    if (Number(c.tfStrength || 0) >= 2) {
      candles4h = await cachedFetch(
        `c4h_${contractSymbol}`,
        () => fetchCandles(contractSymbol, "4h", 100),
        30000
      ).catch(() => null);
    }

    const mtfRsi = getMTFRSI({
      m15: candles15m,
      h1: candles1h,
      h4: candles4h
    });

    const rsiData = {
      mtf: mtfRsi,
      structure: { trend: "NEUTRAL" },
      candles15m,
      candles1h
    };

    let liquidation = null;

    try {
      const liqPrice = Number(c.price || c.lastPrice || ob.mid || 0);
      liquidation = await getLiquidationZones(contractSymbol, liqPrice);
    } catch (e) {
      console.warn(`Liquidation fetch failed for ${symbol}:`, e.message);
    }

    dataMap.set(symbol, {
      ob,
      funding,
      rsiData,
      liquidation,
      contractSymbol
    });
  };

  const chunks = chunkArray(candidates, 3);

  for (const chunk of chunks) {
    await Promise.all(chunk.map(fetchCoinData));
  }

  // ================= PROCESS =================
  for (const originalCoin of candidates) {
    const c = {
      ...originalCoin,
      symbol: normalizeBaseSymbol(originalCoin.symbol),
      side: String(originalCoin.side).toLowerCase()
    };

    const key = `${c.symbol}_${c.side}`;
    const symbolLockKey = `LOCK_${c.symbol}`;

    const data = dataMap.get(c.symbol) || {
      ob: DEFAULT_OB,
      funding: { rate: 0 },
      rsiData: null,
      liquidation: null,
      contractSymbol: normalizeBitgetSymbol(c.symbol)
    };

    const {
      ob: obData,
      funding,
      rsiData,
      liquidation,
      contractSymbol
    } = data;

    if (obData?.mid > 0) {
      c.price = obData.mid;
    } else if (!c.price || c.price === 0) {
      c.price = Number(c.lastPrice || 0);
    }

    const isBull = c.side === "bull";
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    c.flow = flow.type;

    // ================= POSITION MANAGEMENT FIRST =================
    if (prev) {
      const pos = { ...prev };
      c.setupClass = pos.setupClass || "OPEN";

      if (!Number(c.price || 0)) {
        actions.push({
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "HOLD",
          reason: "PRICE_INVALID_OPEN_POSITION",
          setupClass: pos.setupClass || "UNKNOWN",
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence: pos.confluence || 0,
          rr: formatRR(pos.rr),
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A",
          rsi: pos.rsi,
          rsiHTF: pos.rsiHTF,
          rsiZone: pos.rsiZone
        });

        continue;
      }

      const hitTP = isBull
        ? c.price >= pos.tp
        : c.price <= pos.tp;

      const hitSL = isBull
        ? c.price <= pos.sl
        : c.price >= pos.sl;

      if (hitTP || hitSL) {
        const reason = hitTP ? "TP" : "SL";

        const exitPayload = {
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "EXIT",
          reason,
          setupClass: pos.setupClass || "UNKNOWN",
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence: pos.confluence || 0,
          rr: formatRR(pos.rr),
          entry: pos.entry,
          exit: c.price,
          sl: pos.sl,
          tp: pos.tp,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A",
          rsi: pos.rsi,
          rsiHTF: pos.rsiHTF,
          rsiZone: pos.rsiZone
        };

        recordExit(exitPayload, pos, c.price, isBull);

        if (shouldLog) {
          await logTrade({
            symbol: c.symbol,
            side: c.side,
            setupClass: pos.setupClass || "UNKNOWN",
            entry: pos.entry,
            exit: c.price,
            sl: pos.sl,
            tp: pos.tp,
            result: hitTP ? "WIN" : "LOSS",
            reason,
            rr: pos.rr,
            exitR: exitPayload.exitR,
            pnlPct: exitPayload.pnlPct,
            grade: pos.grade || "N/A",
            gradePoints: pos.gradePoints || 0,
            recommendedRisk: pos.recommendedRisk || "N/A",
            confluence: pos.confluence || 0,
            score: c.moveScore,
            flow: flow.type,
            sniper: pos.sniper || "N/A",
            sniperScore: pos.sniperScore || 0,
            obBias: obData.bias,
            funding: funding.rate || 0,
            slSource: pos.slSource || "N/A",
            tpSource: pos.tpSource || "N/A",
            regime: pos.regime || "N/A",
            btcState,
            rsi: pos.rsi,
            rsiHTF: pos.rsiHTF,
            rsiZone: pos.rsiZone,
            strategyVersion: pos.strategyVersion || STRATEGY_VERSION
          });
        }

        const exitKey = `${key}_exit`;

        if (notify && !notifyState.get(exitKey)) {
          await sendExit({
            symbol: c.symbol,
            side: c.side,
            setupClass: pos.setupClass || "UNKNOWN",
            reason,
            rr: pos.rr,
            grade: pos.grade,
            entry: pos.entry,
            sl: pos.sl,
            tp: pos.tp
          });

          notifyState.set(exitKey, true);
        }

        memory.delete(key);
        notifyState.delete(key);
        notifyState.delete(`${key}_hold`);
        notifyState.delete(`${key}_exit`);

        cooldownMap.set(key, Date.now() + COOLDOWN_MS);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

        actions.push(exitPayload);
        continue;
      }

      // Geen scaling. Alleen HOLD.
      memory.set(key, pos);

      const runningPayload = {
        ...buildCommonPayload(c, flow, null, funding, obData),
        action: "HOLD",
        reason: "RUNNING",
        setupClass: pos.setupClass || "UNKNOWN",
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        confluence: pos.confluence || 0,
        rr: formatRR(pos.rr),
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp,
        slSource: pos.slSource || "N/A",
        tpSource: pos.tpSource || "N/A",
        rsi: pos.rsi,
        rsiHTF: pos.rsiHTF,
        rsiZone: pos.rsiZone
      };

      await logAction(runningPayload, pos.regime || "N/A", btcState, shouldLog);

      actions.push(runningPayload);
      continue;
    }

    // ================= NEW ENTRY ONLY BELOW =================
    if (!Number(c.price || 0)) {
      actions.push(buildWait(c, "PRICE_INVALID", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    // ================= BTC GATE =================
    if (btcState === "STRONG_BULL" && !isBull) {
      actions.push(buildWait(c, "BTC_STRONG_BULL_BLOCK_SHORT", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "STRONG_BEAR" && isBull) {
      actions.push(buildWait(c, "BTC_STRONG_BEAR_BLOCK_LONG", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "BULLISH" && !isBull && Number(c.moveScore || 0) < 75) {
      actions.push(buildWait(c, "BTC_BULLISH_WEAK_SHORT", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "BEARISH" && isBull && Number(c.moveScore || 0) < 75) {
      actions.push(buildWait(c, "BTC_BEARISH_WEAK_LONG", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "NEUTRAL" && Number(c.moveScore || 0) < 70) {
      actions.push(buildWait(c, "BTC_NEUTRAL_LOW_SCORE", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    // ================= TF META =================
    const tfMeta = getTimeframeMeta(c);

    c.tfStrength = tfMeta.tfStrength;
    c.tfScore = tfMeta.tfScore;
    c.tfAlignment = tfMeta.tfAlignment;
    c.atrPct15m = Number(tfMeta.ctx?.atrPct15m || 0);
    c.atrPct1h = Number(tfMeta.ctx?.atrPct1h || 0);
    c.atrPct4h = Number(tfMeta.ctx?.atrPct4h || 0);
    c.atrPct24h = Number(tfMeta.ctx?.atrPct24h || 0);

    if (!isBull && btcState === "BEARISH") {
      c.tfStrength += 0.5;
      c.moveScore = Number(c.moveScore || 0) + 2;
    }

    // ================= RSI =================
    const rsiSignal = rsiData?.mtf
      ? getRSISignal(rsiData.mtf, c.side)
      : { valid: false, strength: 0 };

    const rsi = Number.isFinite(rsiSignal?.rsi)
      ? rsiSignal.rsi
      : null;

    if (rsi === null) {
      actions.push(buildWait(c, "RSI_DATA_INVALID", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (rsiSignal?.blocked) {
      actions.push(buildWait(c, "RSI_HTF_BLOCKED", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    const rsiZone = getRsiZone(rsiSignal);
    c._debugRsiZone = rsiZone;

    if (isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) {
      actions.push(buildWait(c, "RSI_LONG_TOO_HIGH", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    // ================= CONTEXT =================
    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const regimeLevel = getRegimeKey(regime, scanRegime);
    const regimeForConfluence = getRegimeValueForConfluence(regime, scanRegime);
    const liquidity = getLiquidityZones(c, obData);

    const hasLiquidationData =
      Array.isArray(liquidation?.clusters) &&
      liquidation.clusters.length > 0;

    const rawRsiCtx = rsiData?.mtf?.m15;
    const rsiContext = rawRsiCtx && Number.isFinite(rawRsiCtx.rsi) && rawRsiCtx.zones
      ? {
          valid: true,
          rsi: rawRsiCtx.rsi,
          zones: rawRsiCtx.zones
        }
      : null;

    // Confluence vóór sniper.
    const confluence = calculateConfluence(
      c,
      obData,
      liquidity,
      funding,
      regimeForConfluence,
      hasLiquidationData ? liquidation : null,
      rsiContext
    );

    c.confluence = confluence;

    const sniper = getSniperEntry(c, obData, rsiSignal);
    const sniperScore = getSniperScore(sniper);

    if (obData.fetchFailed) {
      actions.push(buildWait(c, "ORDERBOOK_FETCH_FAILED", flow, sniper, confluence, 0, funding, obData, null, null, null, null));
      continue;
    }

    const riskBase = await calculateRisk(
      c,
      obData,
      liquidity,
      hasLiquidationData ? liquidation : null
    );

    const rr = Number.isFinite(Number(riskBase?.rr))
      ? Math.max(0, Number(riskBase.rr))
      : calculateFallbackRR(c, riskBase, isBull);

    // ================= FAKE BREAKOUT =================
    let fakeBreakout = false;
    const breakoutBufferPct = getDynamicBreakoutBufferPct(c, regime, vol, obData);

    if (hasLiquidationData && liquidation) {
      if (isBull && liquidation.nearestAbove && c.price > liquidation.nearestAbove * (1 + breakoutBufferPct)) {
        fakeBreakout = true;
      }

      if (!isBull && liquidation.nearestBelow && c.price < liquidation.nearestBelow * (1 - breakoutBufferPct)) {
        fakeBreakout = true;
      }
    }

    const candles15m = rsiData?.candles15m || [];
    let candleFakeBreakout = false;

    if (candles15m.length >= 20) {
      const recentHigh = Math.max(...candles15m.slice(-20).map(x => x.high));
      const recentLow = Math.min(...candles15m.slice(-20).map(x => x.low));

      if (isBull && c.price > recentLow && c.price < recentLow * 1.01) {
        candleFakeBreakout = true;
      }

      if (!isBull && c.price < recentHigh && c.price > recentHigh * 0.99) {
        candleFakeBreakout = true;
      }
    }

    const isValidFakeBreakout = fakeBreakout || candleFakeBreakout;
    c._debugFakeBreakout = isValidFakeBreakout;

    console.log(
      `📊 DATA: ${c.symbol} | hasRSI=${!!rsiContext} | conf=${confluence} | sniper=${sniperScore} | rr=${formatRR(rr)} | fake=${isValidFakeBreakout}`
    );

    // ================= RSI LOGIC =================
    const trendContinuationRSI =
      flow.type === "TREND" &&
      confluence >= 65 &&
      rr >= 1.0 &&
      sniperScore >= 55 &&
      (
        (isBull && ["MID", "LOWER_1"].includes(rsiZone)) ||
        (!isBull && ["MID", "UPPER_1"].includes(rsiZone))
      );

    const earlyRSI =
      (isBull && rsiZone === "LOWER_1" && sniperScore >= 75) ||
      (!isBull && rsiZone === "UPPER_1" && sniperScore >= 75);

    if (isBull) {
      const rsiOK =
        ["LOWER_2", "LOWER_3"].includes(rsiZone) ||
        earlyRSI ||
        trendContinuationRSI;

      if (!rsiOK) {
        actions.push(buildWait(c, "RSI_LONG_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
        continue;
      }
    }

    if (!isBull) {
      const rsiOK =
        ["UPPER_2", "UPPER_3"].includes(rsiZone) ||
        earlyRSI ||
        trendContinuationRSI ||
        (rsiZone === "LOWER_1" && flow.type === "TREND" && confluence >= 75);

      if (!rsiOK) {
        actions.push(buildWait(c, "RSI_SHORT_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
        continue;
      }
    }

    if (isBull && rsiZone === "LOWER_2" && Number(c.change1h || 0) > -0.05) {
      actions.push(buildWait(c, "RSI_NOT_DEEP_ENOUGH", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (!isBull && rsiZone === "UPPER_2" && Number(c.change1h || 0) < 0.2) {
      actions.push(buildWait(c, "RSI_NOT_HIGH_ENOUGH", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (rsiZone === "MID" && !trendContinuationRSI && confluence < 72) {
      actions.push(buildWait(c, "RSI_MID_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    // ================= STRUCTURE =================
    const structure = rsiData?.structure || { trend: "NEUTRAL" };
    c.structure = structure.trend;

    if ((isBull && c.structure === "BEARISH") || (!isBull && c.structure === "BULLISH")) {
      actions.push(buildWait(c, "STRUCTURE_AGAINST", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    // ================= MOMENTUM =================
    const strongMomentum =
      Math.abs(Number(c.change1h || 0)) > 0.25 &&
      Math.abs(Number(c.change24 || 0)) > 2 &&
      (flow.type === "TREND" || flow.type === "BUILDING");

    const softMomentum =
      Math.abs(Number(c.change1h || 0)) > 0.15 &&
      Math.abs(Number(c.change24 || 0)) > 1.5 &&
      flow.type === "TREND";

    if (!strongMomentum && !softMomentum) {
      actions.push(buildWait(c, "NO_MOMENTUM", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (!isValidFakeBreakout && flow.type !== "TREND") {
      actions.push(buildWait(c, "NO_FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    // ================= ENTRY GUARDS =================
    if (hasAnyOpenPositionForSymbol(c.symbol)) {
      actions.push(buildWait(c, `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol)}`, flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (processingLocks.has(symbolLockKey)) {
      actions.push(buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (Date.now() < (cooldownMap.get(key) || 0)) {
      actions.push(buildWait(c, "COOLDOWN", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (Date.now() < (symbolCooldownMap.get(c.symbol) || 0)) {
      actions.push(buildWait(c, "SYMBOL_COOLDOWN", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (Date.now() < (lastSignalMap.get(c.symbol) || 0)) {
      actions.push(buildWait(c, "RECENT_SIGNAL_COOLDOWN", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    const allowedStages = certaintyMode === "safe"
      ? ["entry"]
      : ["entry", "almost"];

    const stageOK = allowedStages.includes(c.stage);

    const setupGrade = getSetupGrade({
      c,
      ob: obData,
      flow,
      sniper,
      confluence,
      rr,
      hasLiquidationData,
      isBull
    });

    const counterTrend =
      (btcState === "BULLISH" && !isBull) ||
      (btcState === "BEARISH" && isBull);

    let minRrFloorBase = getDynamicMinRrFloor({
      c,
      setupGrade,
      flow,
      sniper,
      confluence,
      counterTrend
    });

    let minRrFloor = getSniperAdjustedRR(sniper, minRrFloorBase);

    if (!isBull && btcState === "BEARISH") {
      minRrFloor = Math.max(1.0, minRrFloor - 0.05);
    }

    c.minRrFloor = minRrFloor;

    const rrOverride = confluence >= 90 && sniperScore >= 85;

    if (rr < minRrFloor && !rrOverride) {
      actions.push(buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, minRrFloor));
      continue;
    }

    if (vol === "LOW" && confluence < 60) {
      actions.push(buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (flow.type === "NEUTRAL" && confluence < 68) {
      actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (c.tfStrength < 1) {
      actions.push(buildWait(c, "ENTRY_FILTERED_TF_WEAK", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (confluence < 62) {
      actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, 62, null));
      continue;
    }

    const obAgainst = isObAgainstSide(obData, isBull);

    if (obAgainst && confluence < 78) {
      actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    const spread = normalizeSpread(obData.spreadPct);
    const badSpread = spread > MAX_SPREAD_PCT;
    const badDepth = Number(obData.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;

    if ((badSpread || badDepth) && confluence < 75) {
      actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (
      obData.bias === "NEUTRAL" &&
      confluence < 55 &&
      !isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend })
    ) {
      actions.push(buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    const fundingRate = Number(funding?.rate || 0);

    if (Math.abs(fundingRate) > 0.015 && confluence < 85) {
      actions.push(buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (isBull && fundingRate > 0.012 && confluence < 85) {
      actions.push(buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (!isBull && fundingRate < -0.012 && confluence < 85) {
      actions.push(buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    // ================= A/B/GOD ENTRY ONLY =================
    const baseCleanSetup =
      stageOK &&
      sniper?.valid &&
      !obData.spoof &&
      c.tfStrength >= 1;

    const godModeEntry =
      baseCleanSetup &&
      setupGrade.grade === "A" &&
      sniperScore >= GOD_MIN_SNIPER &&
      confluence >= GOD_MIN_CONFLUENCE &&
      rr >= GOD_MIN_RR;

    const eliteEntry =
      !godModeEntry &&
      baseCleanSetup &&
      setupGrade.grade === "A" &&
      sniperScore >= A_MIN_SNIPER &&
      confluence >= A_MIN_CONFLUENCE &&
      rr >= A_MIN_RR;

    const bEntry =
      !godModeEntry &&
      !eliteEntry &&
      baseCleanSetup &&
      setupGrade.grade === "B" &&
      sniperScore >= B_MIN_SNIPER &&
      confluence >= B_MIN_CONFLUENCE &&
      rr >= B_MIN_RR;

    const shouldEnter = godModeEntry || eliteEntry || bEntry;

    const setupClass = godModeEntry
      ? "GOD"
      : eliteEntry
        ? "A"
        : bEntry
          ? "B"
          : "NONE";

    const reasonEntry = godModeEntry
      ? "GOD_MODE"
      : eliteEntry
        ? "ELITE_ENTRY"
        : bEntry
          ? "B_ENTRY"
          : "NONE";

    c.setupClass = setupClass;

    console.log(
      `🔍 ${c.symbol} (${c.analysisType || "DEEP"}): setup=${setupClass}, sniper=${sniperScore}, conf=${confluence}, rr=${formatRR(rr)}, grade=${setupGrade.grade}, elite=${eliteEntry}, b=${bEntry}, godmode=${godModeEntry}, rsiZone=${rsiZone}, fakeBreakout=${isValidFakeBreakout}`
    );

    if (!shouldEnter) {
      actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    // ================= DIRECT ENTRY =================
    let finalTp = riskBase.tp;

    if (certaintyMode === "safe") {
      const safeFactor = setupClass === "B" ? 0.95 : 0.98;
      finalTp = adjustTpDistance(c.price, finalTp, isBull, safeFactor);
    } else if (setupClass === "GOD") {
      finalTp = adjustTpDistance(c.price, finalTp, isBull, 1.08);
    } else if (setupClass === "A") {
      const deepRsiEdge =
        (isBull && rsi < 30) ||
        (!isBull && rsi > 70);

      finalTp = adjustTpDistance(c.price, finalTp, isBull, deepRsiEdge ? 1.06 : 1.00);
    } else if (setupClass === "B") {
      const strongB =
        sniperScore >= 78 &&
        confluence >= 76 &&
        rr >= 1.20;

      finalTp = adjustTpDistance(c.price, finalTp, isBull, strongB ? 1.02 : 0.98);
    }

    const position = {
      symbol: c.symbol,
      side: c.side,
      stage: c.stage,
      scannerStage: c.scannerStage || c.stage,
      stageSource: c.stageSource || "unknown",
      uiOnly: Boolean(c.uiOnly),
      rawBitgetSymbol: contractSymbol,

      strategyVersion: STRATEGY_VERSION,
      setupClass,
      reason: reasonEntry,
      entryReason: reasonEntry,

      score: Number(c.moveScore || 0),
      moveScore: Number(c.moveScore || 0),

      entry: c.price,
      entries: [c.price],
      maxEntries: 1,
      lastEntryAt: Date.now(),

      sl: riskBase.sl,
      initialSl: riskBase.sl,
      tp: finalTp,
      rr,

      grade: setupGrade.grade,
      gradePoints: setupGrade.points,
      recommendedRisk: setupGrade.recommendedRisk,

      confluence,
      sniper: sniper?.type || "NONE",
      sniperScore,

      slSource: riskBase.slSource || "liquidity/orderbook",
      tpSource: riskBase.tpSource || "liquidity/liquidation",

      tfScore: c.tfScore,
      tfStrength: c.tfStrength,
      tfAlignment: c.tfAlignment,

      atrPct15m: c.atrPct15m,
      atrPct1h: c.atrPct1h,
      atrPct4h: c.atrPct4h,
      atrPct24h: c.atrPct24h,

      createdAt: Date.now(),

      rsi,
      rsiHTF: rsiSignal.mean1h || null,
      rsiZone,

      regime: regimeLevel,
      btcState
    };

    const entryPayload = {
      ...buildCommonPayload(c, flow, sniper, funding, obData),
      action: "ENTRY",
      reason: reasonEntry,
      setupClass,
      grade: position.grade,
      gradePoints: position.gradePoints,
      recommendedRisk: position.recommendedRisk,
      confluence,
      rr: formatRR(rr),
      entry: position.entry,
      sl: position.sl,
      tp: position.tp,
      slSource: position.slSource,
      tpSource: position.tpSource,
      rsi: position.rsi,
      rsiHTF: position.rsiHTF,
      rsiZone: position.rsiZone
    };

    processingLocks.add(symbolLockKey);

    try {
      memory.set(key, position);

      symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
      cooldownMap.set(key, Date.now() + COOLDOWN_MS);
      lastSignalMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

      recordEntry(entryPayload, position);

      await logAction(entryPayload, regimeLevel, btcState, shouldLog);

      if (notify && !notifyState.get(key)) {
        await sendEntry({
          symbol: c.symbol,
          side: c.side,
          setupClass,
          entry: position.entry,
          sl: position.sl,
          tp: position.tp,
          rr: position.rr,
          grade: position.grade,
          gradePoints: position.gradePoints,
          recommendedRisk: position.recommendedRisk,
          slSource: position.slSource,
          tpSource: position.tpSource,
          confluence,
          obBias: obData.bias,
          rsi: position.rsi,
          rsiHTF: position.rsiHTF,
          rsiZone: position.rsiZone,
          sniperScore
        });

        notifyState.set(key, true);
      }
    } finally {
      processingLocks.delete(symbolLockKey);
    }

    actions.push(entryPayload);
  }

  return finalizeResult(actions, candidates, btcState, runId);
}