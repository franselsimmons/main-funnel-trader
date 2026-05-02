// tradeSystem.js - TS_V6_RSI_STRICT_ELITE
// - Geen C_ENTRY
// - Geen scaling / bijkopen
// - Open posities altijd TP/SL tracking
// - Position management vóór entry-blocks
// - Confluence vóór sniper
// - Liquidation price meegegeven
// - BTC/regime uit options
// - Scanner-entry blijft alleen candidate, geen echte entry
// - Audit reset automatisch bij STRATEGY_VERSION wijziging
// - Vercel logs: reject table, open positions, trade events, audit snapshot

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

// ================= VERSION =================
const STRATEGY_VERSION = "TS_V6_RSI_STRICT_ELITE";

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
    rule: "long needs LOWER/early/strict trend-continuation; short needs UPPER/early/strict trend-continuation",
    blockReason: "RSI_LONG_NO_EDGE / RSI_SHORT_NO_EDGE"
  },
  {
    phase: "RSI",
    filter: "MID ZONE",
    rule: "MID only allowed with strict trend-continuation",
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
    filter: "A/B ONLY",
    rule: "A or B setup only. No C_ENTRY. No scaling.",
    blockReason: "SETUP_NOT_READY"
  }
]);

// ================= STATE =================
const memory = new Map();
const notifyState = new Map();
const cooldownMap = new Map();
const symbolCooldownMap = new Map();
const processingLocks = new Set();
const lastSignalMap = new Map();

const runtime = globalThis.__TRADE_SYSTEM_RUNTIME__ || {
  strategyVersion: STRATEGY_VERSION,
  audit: createEmptyAudit()
};

globalThis.__TRADE_SYSTEM_RUNTIME__ = runtime;

// ================= AUDIT =================
function createEmptyAudit() {
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
    exitReasonCounts: {},

    tradeEvents: [],
    lastRunId: null
  };
}

function resetRuntimeForNewVersion() {
  if (runtime.strategyVersion === STRATEGY_VERSION) return;

  memory.clear();
  notifyState.clear();
  cooldownMap.clear();
  symbolCooldownMap.clear();
  processingLocks.clear();
  lastSignalMap.clear();
  apiCache.clear();

  runtime.strategyVersion = STRATEGY_VERSION;
  runtime.audit = createEmptyAudit();

  console.log("========== TRADE SYSTEM STRATEGY RESET ==========");
  console.log(
    JSON.stringify({
      tag: "TS_STRATEGY_RESET",
      strategyVersion: STRATEGY_VERSION,
      reason: "strategy_version_changed",
      ts: Date.now()
    })
  );
}

function incrementCounter(map, key) {
  const k = String(key || "UNKNOWN");
  map[k] = Number(map[k] || 0) + 1;
}

function pushTradeEvent(event) {
  const row = {
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),
    ...event
  };

  runtime.audit.tradeEvents.push(row);

  if (runtime.audit.tradeEvents.length > 250) {
    runtime.audit.tradeEvents.shift();
  }

  console.log("TS_TRADE_EVENT", JSON.stringify(row));
}

function calculateExitStats({ pos, exitPrice, isBull, reason }) {
  const entry = Number(pos.entry || 0);
  const sl = Number(pos.sl || 0);
  const tp = Number(pos.tp || 0);
  const exit = Number(exitPrice || 0);

  if (!entry || !sl || !tp || !exit) {
    return {
      result: reason === "TP" ? "WIN" : "LOSS",
      rMultiple: 0,
      pnlPct: 0
    };
  }

  const risk = Math.abs(entry - sl);
  const pnl = isBull
    ? exit - entry
    : entry - exit;

  const rMultiple = risk > 0 ? pnl / risk : 0;
  const pnlPct = isBull
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;

  return {
    result: reason === "TP" ? "WIN" : "LOSS",
    rMultiple: Number.isFinite(rMultiple) ? rMultiple : 0,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0
  };
}

function getOpenPositionRows() {
  const rows = [];

  for (const [, pos] of memory.entries()) {
    rows.push({
      symbol: pos.symbol,
      side: pos.side,
      grade: pos.grade,
      reason: pos.entryReason || pos.reason || "UNKNOWN",
      entry: pos.entry,
      sl: pos.sl,
      tp: pos.tp,
      rr: formatRR(pos.rr),
      score: pos.score || pos.moveScore || 0,
      conf: pos.confluence || 0,
      sniper: pos.sniperScore || 0,
      rsiZone: pos.rsiZone || "UNKNOWN",
      strategyVersion: pos.strategyVersion || STRATEGY_VERSION
    });
  }

  return rows;
}

function buildAuditSnapshot({ runId, btcState, candidates, actions }) {
  const audit = runtime.audit;
  const exits = Number(audit.exits || 0);
  const wins = Number(audit.wins || 0);
  const losses = Number(audit.losses || 0);

  const reasonCounts = {};
  const reasonExamples = {};

  for (const row of actions || []) {
    const action = String(row?.action || "UNKNOWN").toUpperCase();
    const reason = String(row?.reason || "NO_REASON").toUpperCase();
    const key = action === "WAIT" ? reason : `${action}_${reason}`;

    reasonCounts[key] = Number(reasonCounts[key] || 0) + 1;

    if (!reasonExamples[key]) reasonExamples[key] = [];
    if (reasonExamples[key].length < 10) {
      reasonExamples[key].push(`${row.symbol}_${row.side}_${row.stage}_${row.score}`);
    }
  }

  const total = Array.isArray(actions) ? actions.length : 0;
  const reasonTable = Object.entries(reasonCounts)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "0%",
      examples: reasonExamples[reason]?.join(", ") || ""
    }))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0));

  return {
    tag: "TS_AUDIT_SNAPSHOT",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,

    runs: audit.runs,
    candidates: Array.isArray(candidates) ? candidates.length : 0,
    actions: total,

    actionCounts: countActions(actions),

    entries: audit.entries,
    exits: audit.exits,
    wins,
    losses,
    winrate: exits > 0 ? `${((wins / exits) * 100).toFixed(1)}%` : "0.0%",

    rTotal: Number(audit.rTotal.toFixed(3)),
    avgR: exits > 0 ? Number((audit.rTotal / exits).toFixed(3)) : 0,

    pnlPctTotal: Number(audit.pnlPctTotal.toFixed(3)),
    avgPnlPct: exits > 0 ? Number((audit.pnlPctTotal / exits).toFixed(3)) : 0,

    openPositions: memory.size,

    entryReasonCounts: audit.entryReasonCounts,
    exitReasonCounts: audit.exitReasonCounts,

    biggestCurrentReason: reasonTable[0] || null,

    startedAt: audit.startedAt,
    ts: Date.now()
  };
}

function countActions(actions) {
  const counts = {};

  for (const row of actions || []) {
    const action = String(row?.action || "UNKNOWN").toUpperCase();
    counts[action] = Number(counts[action] || 0) + 1;
  }

  return counts;
}

function logTradeSystemAudit({ runId, btcState, candidates, actions, prefilterStats }) {
  const rows = Array.isArray(actions) ? actions : [];
  const total = rows.length || 0;

  const reasonCounts = {};
  const reasonExamples = {};
  const entryRows = [];

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

    if (action === "ENTRY") {
      entryRows.push({
        symbol: row.symbol,
        side: row.side,
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

  const reasonTable = Object.entries(reasonCounts)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "0%",
      examples: reasonExamples[reason]?.join(", ") || ""
    }))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0));

  console.log("========== TRADE SYSTEM PREFILTER ==========");
  if (prefilterStats?.table?.length) console.table(prefilterStats.table);
  console.log("TRADE SYSTEM prefilter json:", JSON.stringify(prefilterStats || {}));

  console.log("========== TRADE SYSTEM FILTERS ==========");
  console.table(TRADE_SYSTEM_FILTERS);

  console.log("========== TRADE SYSTEM REJECT / ACTION TABLE ==========");
  console.table(reasonTable.slice(0, 60));
  console.log("TRADE SYSTEM reason json:", JSON.stringify(reasonTable.slice(0, 60)));

  if (entryRows.length) {
    console.log("========== TRADE SYSTEM ENTRIES ==========");
    console.table(entryRows);
  } else {
    console.log("TRADE SYSTEM entries: 0");
  }

  const openRows = getOpenPositionRows();

  if (openRows.length) {
    console.log("========== TRADE SYSTEM OPEN POSITIONS ==========");
    console.table(openRows);
  } else {
    console.log("TRADE SYSTEM open positions: 0");
  }

  const snapshot = buildAuditSnapshot({
    runId,
    btcState,
    candidates,
    actions: rows
  });

  console.log("========== TRADE SYSTEM AUDIT SNAPSHOT ==========");
  console.log("TS_AUDIT_SNAPSHOT", JSON.stringify(snapshot));
}

function finalizeResult({ actions, candidates, runId, btcState, prefilterStats }) {
  const finalActions = actions.length > 0
    ? actions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    : candidates.map(c => ({
        symbol: c.symbol,
        side: c.side,
        action: "WAIT",
        reason: "NO_VALID_SETUPS",
        score: c.moveScore || 0,
        ts: Date.now(),
        analysisType: c.analysisType || "DEEP",
        strategyVersion: STRATEGY_VERSION
      }));

  if (actions.length === 0 && candidates.length > 0) {
    console.warn("⚠️ NO ACTIONS from tradeSystem – fallback WAIT generated");
  }

  logTradeSystemAudit({
    runId,
    btcState,
    candidates,
    actions: finalActions,
    prefilterStats
  });

  return {
    actions: finalActions,
    candidatesCount: candidates.length,
    strategyVersion: STRATEGY_VERSION,
    runId
  };
}

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
    `🚫 BLOCK: ${c.symbol} | ${reason} | rsiZone=${c._debugRsiZone || "?"} | sniper=${sniper?.score || 0} | conf=${confluence} | rr=${formatRR(rr)} | fake=${c._debugFakeBreakout} | flow=${flow?.type}`
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

  const removed = {
    MISSING: [],
    UI_ONLY: [],
    STAGE: [],
    SCORE: []
  };

  const filtered = [];

  for (const c of raw) {
    const label = `${c?.symbol || "?"}_${c?.side || "?"}_${c?.stage || "?"}_${c?.moveScore || 0}`;

    if (!c?.symbol || !c?.side) {
      removed.MISSING.push(label);
      continue;
    }

    if (Boolean(c.uiOnly)) {
      removed.UI_ONLY.push(label);
      continue;
    }

    const stage = String(c.stage || "").toLowerCase();
    const score = Number(c.moveScore || 0);

    if (stage !== "entry" && stage !== "almost") {
      removed.STAGE.push(label);
      continue;
    }

    if (score < 50) {
      removed.SCORE.push(label);
      continue;
    }

    filtered.push(c);
  }

  const map = new Map();

  for (const c of dedupeCandidates(filtered)) {
    const key = `${normalizeBaseSymbol(c.symbol)}_${String(c.side).toLowerCase()}`;

    map.set(key, {
      ...c,
      analysisType: "DEEP",
      fromOpenPosition: false
    });
  }

  let openPositionInjected = 0;

  for (const [key, pos] of memory.entries()) {
    if (map.has(key)) continue;

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
      analysisType: "DEEP",
      fromOpenPosition: true
    });

    openPositionInjected++;
  }

  const candidates = Array.from(map.values()).sort((a, b) => {
    if (a.fromOpenPosition !== b.fromOpenPosition) {
      return a.fromOpenPosition ? -1 : 1;
    }

    return Number(b.moveScore || 0) - Number(a.moveScore || 0);
  });

  const stats = {
    strategyVersion: STRATEGY_VERSION,
    rawCount: raw.length,
    acceptedCount: candidates.length,
    removed: {
      MISSING: removed.MISSING.length,
      UI_ONLY: removed.UI_ONLY.length,
      STAGE: removed.STAGE.length,
      SCORE: removed.SCORE.length
    },
    examples: {
      MISSING: removed.MISSING.slice(0, 10),
      UI_ONLY: removed.UI_ONLY.slice(0, 10),
      STAGE: removed.STAGE.slice(0, 10),
      SCORE: removed.SCORE.slice(0, 10)
    },
    openPositionInjected,
    table: [
      { type: "raw", count: raw.length },
      { type: "accepted", count: candidates.length },
      { type: "removed_missing", count: removed.MISSING.length },
      { type: "removed_ui_only", count: removed.UI_ONLY.length },
      { type: "removed_stage", count: removed.STAGE.length },
      { type: "removed_score", count: removed.SCORE.length }
    ]
  };

  return {
    candidates,
    prefilterStats: stats
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
    confluence >= 88 &&
    sniper?.valid &&
    getSniperScore(sniper) >= 80
  ) {
    floor = Math.min(floor, 0.95);
  }

  return clamp(floor, 0.95, 1.50);
}

function getSniperAdjustedRR(sniper, baseRR) {
  const score = Number(sniper?.score || 0);

  if (score >= 90) return Math.max(1.00, baseRR - 0.15);
  if (score >= 80) return Math.max(1.02, baseRR - 0.08);
  if (score >= 70) return Math.max(1.05, baseRR - 0.03);

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
    sniperScore >= 80
  ) {
    return true;
  }

  if (
    setupGrade.grade === "B" &&
    confluence >= 88 &&
    rr >= 1.20 &&
    sniper?.valid &&
    sniperScore >= 84 &&
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

// ================= CORE =================
export async function processTrades(input, options = {}) {
  resetRuntimeForNewVersion();

  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  runtime.audit.runs++;
  runtime.audit.lastRunId = runId;

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

  const { candidates, prefilterStats } = buildTradeCandidates(candidatesRaw);
  const actions = [];

  if (candidates.length === 0) {
    return finalizeResult({
      actions: [],
      candidates: [],
      runId,
      btcState: scanBtc?.state || "UNKNOWN",
      prefilterStats
    });
  }

  let market = { trend: "NEUTRAL" };

  try {
    market = await getMarketContext("BTCUSDT", 0);
  } catch (e) {
    console.warn("Market context fallback:", e.message);
  }

  const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

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

      if (!Number(c.price || 0)) {
        actions.push({
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "HOLD",
          reason: "PRICE_INVALID_OPEN_POSITION",
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
        const exitStats = calculateExitStats({
          pos,
          exitPrice: c.price,
          isBull,
          reason
        });

        const exitPayload = {
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "EXIT",
          reason,
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence: pos.confluence || 0,
          rr: formatRR(pos.rr),
          realizedR: Number(exitStats.rMultiple.toFixed(3)),
          pnlPct: Number(exitStats.pnlPct.toFixed(3)),
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          exit: c.price,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A",
          rsi: pos.rsi,
          rsiHTF: pos.rsiHTF,
          rsiZone: pos.rsiZone
        };

        runtime.audit.exits++;
        incrementCounter(runtime.audit.exitReasonCounts, reason);

        if (reason === "TP") runtime.audit.wins++;
        if (reason === "SL") runtime.audit.losses++;

        runtime.audit.rTotal += exitStats.rMultiple;
        runtime.audit.pnlPctTotal += exitStats.pnlPct;

        pushTradeEvent({
          type: "EXIT",
          runId,
          symbol: c.symbol,
          side: c.side,
          result: exitStats.result,
          reason,
          entry: pos.entry,
          exit: c.price,
          sl: pos.sl,
          tp: pos.tp,
          rr: formatRR(pos.rr),
          realizedR: Number(exitStats.rMultiple.toFixed(3)),
          pnlPct: Number(exitStats.pnlPct.toFixed(3)),
          grade: pos.grade || "N/A",
          score: pos.score || pos.moveScore || 0,
          confluence: pos.confluence || 0,
          sniperScore: pos.sniperScore || 0,
          rsiZone: pos.rsiZone || "UNKNOWN",
          obBiasAtExit: obData.bias,
          btcState,
          regime: pos.regime || "N/A",
          entryReason: pos.entryReason || "UNKNOWN",
          heldMs: Date.now() - Number(pos.createdAt || Date.now())
        });

        if (shouldLog) {
          await logTrade({
            symbol: c.symbol,
            side: c.side,
            entry: pos.entry,
            exit: c.price,
            sl: pos.sl,
            tp: pos.tp,
            result: hitTP ? "WIN" : "LOSS",
            reason,
            rr: pos.rr,
            realizedR: exitStats.rMultiple,
            pnlPct: exitStats.pnlPct,
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

    // ================= RSI LOGIC V6 =================
    const directionalImpulse = isBull
      ? Number(c.change1h || 0) > 0.20
      : Number(c.change1h || 0) < -0.20;

    const trendContinuationRSI =
      flow.type === "TREND" &&
      confluence >= 72 &&
      rr >= 1.10 &&
      sniperScore >= 68 &&
      Boolean(rsiSignal?.trend) &&
      directionalImpulse &&
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
        (rsiZone === "LOWER_1" && flow.type === "TREND" && confluence >= 78 && sniperScore >= 78);

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

    if (rsiZone === "MID" && !trendContinuationRSI && confluence < 76) {
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

    const rrOverride = confluence >= 90 && sniperScore >= 86;

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

    // ================= A/B ENTRY ONLY - V6 STRICT =================
    const aSetupValid =
      stageOK &&
      setupGrade.grade === "A" &&
      !obData.spoof &&
      rr >= minRrFloor;

    const elitePullbackEntry =
      aSetupValid &&
      sniper?.valid &&
      sniperScore >= 76 &&
      confluence >= 80 &&
      rr >= 1.12 &&
      c.tfStrength >= 1 &&
      (
        (isBull && ["LOWER_1", "LOWER_2", "LOWER_3"].includes(rsiZone)) ||
        (!isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone))
      );

    const eliteContinuationEntry =
      aSetupValid &&
      sniper?.valid &&
      sniperScore >= 82 &&
      confluence >= 88 &&
      rr >= 1.20 &&
      c.tfStrength >= 2 &&
      trendContinuationRSI;

    const eliteEntry = elitePullbackEntry || eliteContinuationEntry;

    const bSetupValid =
      stageOK &&
      setupGrade.grade === "B" &&
      !obData.spoof &&
      rr >= 1.05;

    const bEntry =
      !eliteEntry &&
      bSetupValid &&
      sniper?.valid &&
      sniperScore >= 70 &&
      confluence >= 75 &&
      rr >= 1.10 &&
      c.tfStrength >= 1 &&
      (
        (isBull && ["LOWER_1", "LOWER_2"].includes(rsiZone)) ||
        (!isBull && ["UPPER_1", "UPPER_2"].includes(rsiZone))
      );

    const godModeEntry =
      eliteEntry &&
      sniperScore >= 88 &&
      confluence >= 88 &&
      rr >= 1.25;

    const shouldEnter = eliteEntry || bEntry;

    const reasonEntry = godModeEntry
      ? "GOD_MODE"
      : eliteEntry
        ? "ELITE_ENTRY"
        : bEntry
          ? "B_ENTRY"
          : "NONE";

    console.log(
      `🔍 ${c.symbol} (${c.analysisType || "DEEP"}): sniper=${sniperScore}, conf=${confluence}, rr=${formatRR(rr)}, grade=${setupGrade.grade}, elite=${eliteEntry}, b=${bEntry}, godmode=${godModeEntry}, rsiZone=${rsiZone}, fakeBreakout=${isValidFakeBreakout}`
    );

    if (!shouldEnter) {
      actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    // ================= DIRECT ENTRY =================
    let finalTp = riskBase.tp;

    if (certaintyMode === "safe") {
      finalTp *= 0.95;
    } else {
      if (sniperScore >= 90) finalTp *= 0.92;
      else if (sniperScore >= 80) finalTp *= 0.96;

      if (isBull) {
        if (rsi < 30) finalTp *= 1.10;
        else if (rsi < 45) finalTp *= 1.04;
      } else {
        if (rsi > 70) finalTp *= 0.90;
        else if (rsi > 55) finalTp *= 0.96;
      }
    }

    const position = {
      symbol: c.symbol,
      side: c.side,
      stage: c.stage,
      scannerStage: c.scannerStage || c.stage,
      stageSource: c.stageSource || "unknown",
      uiOnly: Boolean(c.uiOnly),
      rawBitgetSymbol: contractSymbol,

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
      btcState,
      strategyVersion: STRATEGY_VERSION,
      entryReason: reasonEntry,
      runId
    };

    const entryPayload = {
      ...buildCommonPayload(c, flow, sniper, funding, obData),
      action: "ENTRY",
      reason: reasonEntry,
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

      runtime.audit.entries++;
      incrementCounter(runtime.audit.entryReasonCounts, reasonEntry);

      symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
      cooldownMap.set(key, Date.now() + COOLDOWN_MS);
      lastSignalMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

      pushTradeEvent({
        type: "ENTRY",
        runId,
        symbol: c.symbol,
        side: c.side,
        reason: reasonEntry,
        grade: position.grade,
        score: position.score,
        confluence,
        sniperScore,
        rr: formatRR(rr),
        entry: position.entry,
        sl: position.sl,
        tp: position.tp,
        rsi,
        rsiHTF: position.rsiHTF,
        rsiZone,
        obBias: obData.bias,
        spreadPct: obData.spreadPct,
        depthMinUsd1p: obData.depthMinUsd1p,
        flow: flow.type,
        btcState,
        regime: regimeLevel,
        fakeBreakout: isValidFakeBreakout,
        trendContinuationRSI,
        elitePullbackEntry,
        eliteContinuationEntry,
        bEntry
      });

      await logAction(entryPayload, regimeLevel, btcState, shouldLog);

      if (notify && !notifyState.get(key)) {
        await sendEntry({
          symbol: c.symbol,
          side: c.side,
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

  return finalizeResult({
    actions,
    candidates,
    runId,
    btcState,
    prefilterStats
  });
}