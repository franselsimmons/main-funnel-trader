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
// Bewust gelijk gehouden. Alleen logging/audit aangepast, geen entry-logica reset.
const STRATEGY_VERSION = "TS_V9_DURABLE_A_RR_HIGHER_NO_SCALE";

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

// A-coins RR verhoogd.
const GRADE_A_MIN_RR_FLOOR = 1.10;
const GRADE_B_MIN_RR_FLOOR = 1.05;
const GRADE_C_MIN_RR_FLOOR = 1.10;

const A_ENTRY_MIN_RR = 1.25;
const B_ENTRY_MIN_RR = 1.05;
const GOD_ENTRY_MIN_RR = 1.45;

const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.20;

const MAX_CLOSED_TRADE_AUDIT_ROWS = 500;
const MAX_RECENT_ENTRY_AUDIT_ROWS = 250;
const MAX_PRICE_PATH_SAMPLES = 60;

const POST_EXIT_MONITOR_MS = 4 * 60 * 60 * 1000;
const POST_EXIT_MAX_MONITOR_ROWS = 120;
const POST_EXIT_MAX_MONITOR_PER_RUN = 18;

const TP_FOLLOW_THROUGH_R = 0.50;
const TP_BIG_FOLLOW_THROUGH_R = 1.00;

const SL_RECOVERY_HALF_R = 0.50;
const SL_RECOVERY_ONE_R = 1.00;
const SL_DEEP_ADVERSE_R = -2.00;

const NEAR_TP_PROGRESS = 0.80;
const HALF_R_LEVEL = 0.50;
const ONE_R_LEVEL = 1.00;
const DIRECT_SL_MFE_LIMIT_R = 0.25;

const DURABLE_LOCK_TTL_MS = 90 * 1000;
const DURABLE_LOCK_ATTEMPTS = 12;
const DURABLE_LOCK_RETRY_MS = 500;

const RUNTIME_STORE_KEY = `tradeSystem:runtime:${STRATEGY_VERSION}`;
const RUNTIME_LOCK_KEY = `tradeSystem:runtime-lock:${STRATEGY_VERSION}`;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  fetchFailed: true
};

const CURRENT_FILTER_VALUES = Object.freeze({
  STRATEGY_VERSION,
  MAX_SPREAD_PCT,
  MIN_DEPTH_USD_1P,
  MIN_RR_FLOOR,
  GRADE_A_MIN_RR_FLOOR,
  GRADE_B_MIN_RR_FLOOR,
  GRADE_C_MIN_RR_FLOOR,
  A_ENTRY_MIN_RR,
  B_ENTRY_MIN_RR,
  GOD_ENTRY_MIN_RR,
  COUNTERTREND_MIN_RR_FLOOR,
  BUILDUP_MIN_RR_FLOOR,
  A_MIN_SNIPER: 70,
  A_MIN_CONFLUENCE: 75,
  B_MIN_SNIPER: 62,
  B_MIN_CONFLUENCE: 68,
  GOD_MIN_SNIPER: 85,
  GOD_MIN_CONFLUENCE: 85,
  MID_RSI_MIN_CONFLUENCE: 72,
  TREND_CONTINUATION_MIN_CONFLUENCE: 65,
  TREND_CONTINUATION_MIN_SNIPER: 55
});

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
    rule: "GOD, A or B setup only. No C_ENTRY. No scaling. A RR is stricter.",
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

    recentEntries: [],
    closedTrades: [],

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
    audit: createAuditState(),
    durableLoadedAt: 0,
    durableSavedAt: 0
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
  runtimeState.durableLoadedAt = 0;
  runtimeState.durableSavedAt = 0;

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

// ================= DURABLE KV / UPSTASH =================
function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}

function hasRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("redis_env_missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `redis_error_${res.status}`);
  }

  return json?.result;
}

function replaceMapContents(targetMap, entries) {
  targetMap.clear();

  if (!Array.isArray(entries)) return;

  for (const item of entries) {
    if (!Array.isArray(item) || item.length < 2) continue;
    targetMap.set(item[0], item[1]);
  }
}

function trimAuditArrays() {
  if (!Array.isArray(auditState.recentEntries)) {
    auditState.recentEntries = [];
  }

  if (!Array.isArray(auditState.closedTrades)) {
    auditState.closedTrades = [];
  }

  if (auditState.recentEntries.length > MAX_RECENT_ENTRY_AUDIT_ROWS) {
    auditState.recentEntries = auditState.recentEntries.slice(-MAX_RECENT_ENTRY_AUDIT_ROWS);
  }

  if (auditState.closedTrades.length > MAX_CLOSED_TRADE_AUDIT_ROWS) {
    auditState.closedTrades = auditState.closedTrades.slice(-MAX_CLOSED_TRADE_AUDIT_ROWS);
  }
}

function serializeRuntimeState() {
  trimAuditArrays();

  return {
    strategyVersion: STRATEGY_VERSION,
    updatedAt: Date.now(),

    memory: Array.from(memory.entries()),
    notifyState: Array.from(notifyState.entries()),
    cooldownMap: Array.from(cooldownMap.entries()),
    symbolCooldownMap: Array.from(symbolCooldownMap.entries()),
    lastSignalMap: Array.from(lastSignalMap.entries()),

    audit: {
      ...auditState,
      strategyVersion: STRATEGY_VERSION,
      recentEntries: auditState.recentEntries || [],
      closedTrades: auditState.closedTrades || []
    }
  };
}

function hydrateRuntimeState(payload) {
  if (!payload || payload.strategyVersion !== STRATEGY_VERSION) {
    return false;
  }

  replaceMapContents(memory, payload.memory);
  replaceMapContents(notifyState, payload.notifyState);
  replaceMapContents(cooldownMap, payload.cooldownMap);
  replaceMapContents(symbolCooldownMap, payload.symbolCooldownMap);
  replaceMapContents(lastSignalMap, payload.lastSignalMap);

  const freshAudit = createAuditState();

  for (const key of Object.keys(auditState)) {
    delete auditState[key];
  }

  Object.assign(auditState, freshAudit, payload.audit || {}, {
    strategyVersion: STRATEGY_VERSION
  });

  if (!Array.isArray(auditState.recentEntries)) auditState.recentEntries = [];
  if (!Array.isArray(auditState.closedTrades)) auditState.closedTrades = [];

  auditState.entryReasonCounts = auditState.entryReasonCounts || {};
  auditState.entrySetupClassCounts = auditState.entrySetupClassCounts || {};
  auditState.exitReasonCounts = auditState.exitReasonCounts || {};

  trimAuditArrays();

  runtimeState.durableLoadedAt = Date.now();

  console.log(
    "TRADE SYSTEM DURABLE LOAD:",
    JSON.stringify({
      strategyVersion: STRATEGY_VERSION,
      openPositions: memory.size,
      entries: auditState.entries,
      exits: auditState.exits,
      wins: auditState.wins,
      losses: auditState.losses,
      closedTrades: auditState.closedTrades.length
    })
  );

  return true;
}

async function loadDurableRuntimeState() {
  if (!hasRedis()) {
    console.warn("TRADE SYSTEM DURABLE STORE DISABLED: Redis env missing");
    return false;
  }

  try {
    const result = await redisCommand(["GET", RUNTIME_STORE_KEY]);

    if (!result) {
      console.log("TRADE SYSTEM DURABLE LOAD: empty state");
      return false;
    }

    const parsed = typeof result === "string"
      ? JSON.parse(result)
      : result;

    return hydrateRuntimeState(parsed);
  } catch (e) {
    console.error("TRADE SYSTEM DURABLE LOAD ERROR:", e.message);
    return false;
  }
}

async function saveDurableRuntimeState() {
  if (!hasRedis()) return false;

  try {
    const payload = serializeRuntimeState();

    await redisCommand([
      "SET",
      RUNTIME_STORE_KEY,
      JSON.stringify(payload)
    ]);

    runtimeState.durableSavedAt = Date.now();

    console.log(
      "TRADE SYSTEM DURABLE SAVE:",
      JSON.stringify({
        strategyVersion: STRATEGY_VERSION,
        openPositions: memory.size,
        entries: auditState.entries,
        exits: auditState.exits,
        wins: auditState.wins,
        losses: auditState.losses,
        closedTrades: auditState.closedTrades.length
      })
    );

    return true;
  } catch (e) {
    console.error("TRADE SYSTEM DURABLE SAVE ERROR:", e.message);
    return false;
  }
}

async function acquireRuntimeLock(owner) {
  if (!hasRedis()) return false;

  for (let attempt = 0; attempt < DURABLE_LOCK_ATTEMPTS; attempt++) {
    try {
      const result = await redisCommand([
        "SET",
        RUNTIME_LOCK_KEY,
        owner,
        "NX",
        "PX",
        DURABLE_LOCK_TTL_MS
      ]);

      if (result === "OK") {
        return true;
      }
    } catch (e) {
      console.warn("TRADE SYSTEM LOCK ATTEMPT ERROR:", e.message);
    }

    await sleep(DURABLE_LOCK_RETRY_MS);
  }

  return false;
}

async function releaseRuntimeLock(owner) {
  if (!hasRedis()) return false;

  try {
    const currentOwner = await redisCommand(["GET", RUNTIME_LOCK_KEY]);

    if (currentOwner === owner) {
      await redisCommand(["DEL", RUNTIME_LOCK_KEY]);
      return true;
    }

    return false;
  } catch (e) {
    console.warn("TRADE SYSTEM LOCK RELEASE ERROR:", e.message);
    return false;
  }
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

function formatWinrate(wins, total) {
  if (!total) return "0.0%";
  return `${((wins / total) * 100).toFixed(1)}%`;
}

function safeAvg(values) {
  const arr = values
    .map(Number)
    .filter(Number.isFinite);

  if (!arr.length) return 0;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function safeSum(values) {
  return values
    .map(Number)
    .filter(Number.isFinite)
    .reduce((a, b) => a + b, 0);
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

function topCountFromRows(rows, field) {
  const counts = {};
  const examples = {};

  for (const row of rows) {
    const key = String(row?.[field] || "UNKNOWN").toUpperCase();

    counts[key] = Number(counts[key] || 0) + 1;

    if (!examples[key]) examples[key] = [];
    if (examples[key].length < 8) {
      examples[key].push(`${row.symbol}_${row.side}_${row.entryReason || row.reason || "?"}`);
    }
  }

  const sorted = Object.entries(counts)
    .map(([key, count]) => ({
      value: key,
      count,
      examples: examples[key]?.join(", ") || ""
    }))
    .sort((a, b) => b.count - a.count);

  return sorted[0] || null;
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

  console.log("TS_PREFILTER", JSON.stringify({
    ...prefilterStats,
    finalCandidates: candidates.length
  }));

  return {
    candidates,
    prefilterStats
  };
}

// ================= RISK / RR =================
function calculateRRFromPrices(entry, sl, tp, isBull) {
  const e = Number(entry || 0);
  const s = Number(sl || 0);
  const t = Number(tp || 0);

  if (!e || !s || !t) return 0;

  const risk = Math.abs(e - s);
  if (!risk) return 0;

  const reward = isBull
    ? t - e
    : e - t;

  if (!Number.isFinite(reward) || reward <= 0) return 0;

  return reward / risk;
}

function calculateFallbackRR(c, risk, isBull) {
  return calculateRRFromPrices(c?.price, risk?.sl, risk?.tp, isBull);
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

function buildAdjustedTp(entry, baseTp, rewardMultiplier, isBull) {
  const e = Number(entry || 0);
  const t = Number(baseTp || 0);
  const m = Number(rewardMultiplier || 1);

  if (!e || !t || !Number.isFinite(m)) return t;

  const rewardDist = Math.abs(t - e);
  if (!rewardDist) return t;

  return isBull
    ? e + (rewardDist * m)
    : e - (rewardDist * m);
}

function getTpRewardMultiplier({ setupClass, certaintyMode, sniperScore, rsi, isBull }) {
  if (certaintyMode === "safe") {
    return 0.95;
  }

  let multiplier = 1.0;

  if (setupClass === "GOD") multiplier = 1.45;
  else if (setupClass === "A") multiplier = 1.25;
  else if (setupClass === "B") multiplier = 1.05;

  if (setupClass === "A" || setupClass === "GOD") {
    if (sniperScore >= 90) multiplier += 0.10;
    else if (sniperScore >= 80) multiplier += 0.05;
  }

  if (isBull) {
    if (rsi < 30) multiplier += 0.08;
    else if (rsi < 45) multiplier += 0.03;
  } else {
    if (rsi > 70) multiplier += 0.08;
    else if (rsi > 55) multiplier += 0.03;
  }

  if (setupClass === "B") {
    return clamp(multiplier, 1.00, 1.15);
  }

  if (setupClass === "A") {
    return clamp(multiplier, 1.20, 1.45);
  }

  if (setupClass === "GOD") {
    return clamp(multiplier, 1.40, 1.75);
  }

  return clamp(multiplier, 0.95, 1.20);
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
    floor = Math.max(floor, 1.20);
  }

  return clamp(floor, 1.00, 1.70);
}

function getSniperAdjustedRR(sniper, baseRR, setupClassHint = null) {
  const score = Number(sniper?.score || 0);

  if (setupClassHint === "A" || setupClassHint === "GOD") {
    if (score >= 90) return Math.max(1.20, baseRR - 0.05);
    if (score >= 80) return Math.max(1.22, baseRR);
    if (score >= 70) return Math.max(1.25, baseRR + 0.03);

    return baseRR + 0.10;
  }

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
    confluence >= 80 &&
    rr >= 1.30 &&
    sniper?.valid &&
    sniperScore >= 75
  ) {
    return true;
  }

  if (
    setupGrade.grade === "B" &&
    confluence >= 84 &&
    rr >= 1.15 &&
    sniper?.valid &&
    sniperScore >= 80 &&
    Number(c.moveScore || 0) >= 82
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

// ================= MFE / MAE POSITION TRACKING =================
function initializePositionPathMetrics(position) {
  if (!position) return position;

  position.mfeR = Number.isFinite(Number(position.mfeR)) ? Number(position.mfeR) : 0;
  position.maeR = Number.isFinite(Number(position.maeR)) ? Number(position.maeR) : 0;
  position.currentR = Number.isFinite(Number(position.currentR)) ? Number(position.currentR) : 0;

  position.maxTpProgress = Number.isFinite(Number(position.maxTpProgress)) ? Number(position.maxTpProgress) : 0;
  position.maxSlProgress = Number.isFinite(Number(position.maxSlProgress)) ? Number(position.maxSlProgress) : 0;

  position.ticksObserved = Number.isFinite(Number(position.ticksObserved)) ? Number(position.ticksObserved) : 0;
  position.favorableTicks = Number.isFinite(Number(position.favorableTicks)) ? Number(position.favorableTicks) : 0;
  position.adverseTicks = Number.isFinite(Number(position.adverseTicks)) ? Number(position.adverseTicks) : 0;
  position.neutralTicks = Number.isFinite(Number(position.neutralTicks)) ? Number(position.neutralTicks) : 0;

  position.reachedHalfR = Boolean(position.reachedHalfR);
  position.reachedOneR = Boolean(position.reachedOneR);
  position.nearTpSeen = Boolean(position.nearTpSeen);

  if (!Array.isArray(position.pricePathSample)) {
    position.pricePathSample = [];
  }

  return position;
}

function updatePositionPathMetrics(position, price, isBull) {
  if (!position || !Number(price || 0)) return position;

  initializePositionPathMetrics(position);

  const now = Date.now();
  const entry = Number(position.entry || 0);
  const sl = Number(position.sl || 0);
  const tp = Number(position.tp || 0);
  const currentPrice = Number(price || 0);

  if (!entry || !sl || !tp || !currentPrice) return position;

  const riskDist = Math.abs(entry - sl);
  const rewardDist = Math.abs(tp - entry);

  if (!riskDist || !rewardDist) return position;

  const directionalMove = isBull
    ? currentPrice - entry
    : entry - currentPrice;

  const currentR = directionalMove / riskDist;
  const tpProgress = directionalMove / rewardDist;

  const adverseMove = directionalMove < 0 ? Math.abs(directionalMove) : 0;
  const slProgress = adverseMove / riskDist;

  position.currentR = Number(currentR.toFixed(4));
  position.ticksObserved++;

  if (currentR > 0) {
    position.favorableTicks++;
    if (!position.firstFavorableAt) position.firstFavorableAt = now;
  } else if (currentR < 0) {
    position.adverseTicks++;
    if (!position.firstAdverseAt) position.firstAdverseAt = now;
  } else {
    position.neutralTicks++;
  }

  if (currentR > Number(position.mfeR || 0)) {
    position.mfeR = Number(currentR.toFixed(4));
    position.mfePrice = currentPrice;
    position.mfeAt = now;
    position.ticksToMfe = position.ticksObserved;
  }

  if (currentR < Number(position.maeR || 0)) {
    position.maeR = Number(currentR.toFixed(4));
    position.maePrice = currentPrice;
    position.maeAt = now;
    position.ticksToMae = position.ticksObserved;
  }

  if (tpProgress > Number(position.maxTpProgress || 0)) {
    position.maxTpProgress = Number(tpProgress.toFixed(4));
    position.maxTpProgressAt = now;
  }

  if (slProgress > Number(position.maxSlProgress || 0)) {
    position.maxSlProgress = Number(slProgress.toFixed(4));
    position.maxSlProgressAt = now;
  }

  if (currentR >= HALF_R_LEVEL && !position.reachedHalfR) {
    position.reachedHalfR = true;
    position.firstHalfRAt = now;
    position.ticksToHalfR = position.ticksObserved;
  }

  if (currentR >= ONE_R_LEVEL && !position.reachedOneR) {
    position.reachedOneR = true;
    position.firstOneRAt = now;
    position.ticksToOneR = position.ticksObserved;
  }

  if (tpProgress >= NEAR_TP_PROGRESS && !position.nearTpSeen) {
    position.nearTpSeen = true;
    position.nearTpAt = now;
    position.nearTpPrice = currentPrice;
    position.ticksToNearTp = position.ticksObserved;
  }

  if (isBull) {
    position.maxFavorablePrice = Math.max(Number(position.maxFavorablePrice || entry), currentPrice);
    position.maxAdversePrice = Math.min(Number(position.maxAdversePrice || entry), currentPrice);
  } else {
    position.maxFavorablePrice = Math.min(Number(position.maxFavorablePrice || entry), currentPrice);
    position.maxAdversePrice = Math.max(Number(position.maxAdversePrice || entry), currentPrice);
  }

  position.pricePathSample.push({
    ts: now,
    price: Number(currentPrice),
    r: Number(currentR.toFixed(3)),
    tpProgress: Number(tpProgress.toFixed(3)),
    slProgress: Number(slProgress.toFixed(3))
  });

  if (position.pricePathSample.length > MAX_PRICE_PATH_SAMPLES) {
    position.pricePathSample = position.pricePathSample.slice(-MAX_PRICE_PATH_SAMPLES);
  }

  return position;
}

function buildPathExitFields(pos, exitReason) {
  const createdAt = Number(pos?.createdAt || Date.now());
  const mfeAt = Number(pos?.mfeAt || 0);
  const maeAt = Number(pos?.maeAt || 0);
  const nearTpAt = Number(pos?.nearTpAt || 0);

  const mfeR = Number(pos?.mfeR || 0);
  const maeR = Number(pos?.maeR || 0);

  const directToSL =
    exitReason === "SL" &&
    mfeR < DIRECT_SL_MFE_LIMIT_R &&
    !Boolean(pos?.reachedHalfR) &&
    !Boolean(pos?.nearTpSeen);

  const slAfterHalfR =
    exitReason === "SL" &&
    Boolean(pos?.reachedHalfR);

  const slAfterOneR =
    exitReason === "SL" &&
    Boolean(pos?.reachedOneR);

  const slAfterNearTp =
    exitReason === "SL" &&
    Boolean(pos?.nearTpSeen);

  const estimatedAdverse15mCandles = pos?.ticksToMae
    ? Number((Number(pos.ticksToMae || 0) / 3).toFixed(1))
    : null;

  return {
    mfeR: Number(mfeR.toFixed(3)),
    maeR: Number(maeR.toFixed(3)),
    currentR: Number(Number(pos?.currentR || 0).toFixed(3)),

    maxTpProgress: Number(Number(pos?.maxTpProgress || 0).toFixed(3)),
    maxSlProgress: Number(Number(pos?.maxSlProgress || 0).toFixed(3)),

    reachedHalfR: Boolean(pos?.reachedHalfR),
    reachedOneR: Boolean(pos?.reachedOneR),
    nearTpSeen: Boolean(pos?.nearTpSeen),

    directToSL,
    slAfterHalfR,
    slAfterOneR,
    slAfterNearTp,

    ticksObserved: Number(pos?.ticksObserved || 0),
    favorableTicks: Number(pos?.favorableTicks || 0),
    adverseTicks: Number(pos?.adverseTicks || 0),
    neutralTicks: Number(pos?.neutralTicks || 0),

    ticksToMfe: Number(pos?.ticksToMfe || 0),
    ticksToMae: Number(pos?.ticksToMae || 0),
    ticksToHalfR: Number(pos?.ticksToHalfR || 0),
    ticksToOneR: Number(pos?.ticksToOneR || 0),
    ticksToNearTp: Number(pos?.ticksToNearTp || 0),

    estimatedAdverse15mCandles,

    minutesToMfe: mfeAt ? Number(((mfeAt - createdAt) / 60000).toFixed(1)) : null,
    minutesToMae: maeAt ? Number(((maeAt - createdAt) / 60000).toFixed(1)) : null,
    minutesToNearTp: nearTpAt ? Number(((nearTpAt - createdAt) / 60000).toFixed(1)) : null,

    maxFavorablePrice: pos?.maxFavorablePrice ?? null,
    maxAdversePrice: pos?.maxAdversePrice ?? null,
    mfePrice: pos?.mfePrice ?? null,
    maePrice: pos?.maePrice ?? null,
    nearTpPrice: pos?.nearTpPrice ?? null,

    pricePathSample: Array.isArray(pos?.pricePathSample)
      ? pos.pricePathSample.slice(-20)
      : []
  };
}

// ================= POST-EXIT MONITORING =================
function initializePostExitFields(trade) {
  if (!trade) return trade;

  const now = Date.now();
  const exitedAt = Number(trade.exitedAt || now);

  trade.postExitMonitor = {
    enabled: true,
    status: "ACTIVE",
    startedAt: exitedAt,
    until: exitedAt + POST_EXIT_MONITOR_MS,
    lastCheckedAt: 0,

    ticks: 0,

    maxR: Number(trade.exitR || 0),
    minR: Number(trade.exitR || 0),

    maxPrice: Number(trade.exit || 0),
    minPrice: Number(trade.exit || 0),

    maxRAt: exitedAt,
    minRAt: exitedAt,

    tpFollowThroughR: 0,
    tpBigFollowThrough: false,
    tpPerfectExit: false,

    slRecoveredHalfR: false,
    slRecoveredOneR: false,
    slStopHunt: false,
    slProtected: false,

    firstHalfRecoveryAt: null,
    firstOneRecoveryAt: null,

    path: []
  };

  return trade;
}

function calculateTradeRFromPrice(trade, price) {
  const entry = Number(trade?.entry || 0);
  const sl = Number(trade?.sl || 0);
  const current = Number(price || 0);
  const side = String(trade?.side || "").toLowerCase();

  if (!entry || !sl || !current) return 0;

  const riskDist = Math.abs(entry - sl);
  if (!riskDist) return 0;

  const move = side === "bull"
    ? current - entry
    : entry - current;

  const r = move / riskDist;
  return Number.isFinite(r) ? r : 0;
}

function updatePostExitTrade(trade, price) {
  if (!trade?.postExitMonitor?.enabled) return trade;

  const now = Date.now();
  const monitor = trade.postExitMonitor;

  if (now > Number(monitor.until || 0)) {
    monitor.status = "DONE";
    monitor.enabled = false;
    return trade;
  }

  const currentPrice = Number(price || 0);
  if (!currentPrice) return trade;

  const currentR = calculateTradeRFromPrice(trade, currentPrice);

  monitor.ticks++;
  monitor.lastCheckedAt = now;

  if (currentR > Number(monitor.maxR || -999)) {
    monitor.maxR = Number(currentR.toFixed(4));
    monitor.maxPrice = currentPrice;
    monitor.maxRAt = now;
  }

  if (currentR < Number(monitor.minR || 999)) {
    monitor.minR = Number(currentR.toFixed(4));
    monitor.minPrice = currentPrice;
    monitor.minRAt = now;
  }

  monitor.path.push({
    ts: now,
    price: currentPrice,
    r: Number(currentR.toFixed(3))
  });

  if (monitor.path.length > MAX_PRICE_PATH_SAMPLES) {
    monitor.path = monitor.path.slice(-MAX_PRICE_PATH_SAMPLES);
  }

  const exitReason = String(trade.exitReason || "").toUpperCase();
  const exitR = Number(trade.exitR || 0);

  if (exitReason === "TP") {
    const followThroughR = Number(monitor.maxR || 0) - exitR;

    monitor.tpFollowThroughR = Number(Math.max(0, followThroughR).toFixed(3));
    monitor.tpBigFollowThrough = monitor.tpFollowThroughR >= TP_BIG_FOLLOW_THROUGH_R;

    monitor.tpPerfectExit =
      monitor.tpFollowThroughR < TP_FOLLOW_THROUGH_R &&
      Number(monitor.minR || 0) <= exitR - 0.25;
  }

  if (exitReason === "SL") {
    if (Number(monitor.maxR || 0) >= SL_RECOVERY_HALF_R && !monitor.slRecoveredHalfR) {
      monitor.slRecoveredHalfR = true;
      monitor.firstHalfRecoveryAt = now;
    }

    if (Number(monitor.maxR || 0) >= SL_RECOVERY_ONE_R && !monitor.slRecoveredOneR) {
      monitor.slRecoveredOneR = true;
      monitor.firstOneRecoveryAt = now;
    }

    monitor.slStopHunt =
      monitor.slRecoveredHalfR ||
      monitor.slRecoveredOneR ||
      Number(monitor.maxR || 0) >= 0;

    monitor.slProtected = Number(monitor.minR || 0) <= SL_DEEP_ADVERSE_R;
  }

  return trade;
}

async function fetchPostExitPrice(trade) {
  const symbol = normalizeBitgetSymbol(trade?.rawBitgetSymbol || trade?.symbol);
  if (!symbol) return 0;

  try {
    const raw = await cachedFetch(`post_exit_ob_${symbol}`, () => fetchOrderBook(symbol), 12000);
    const analyzed = raw ? analyzeOrderBookAdvanced(raw) : null;

    if (Number(analyzed?.mid || 0) > 0) {
      return Number(analyzed.mid);
    }
  } catch {}

  return 0;
}

async function updatePostExitMonitors() {
  const closed = auditState.closedTrades || [];
  if (!closed.length) return;

  const now = Date.now();

  const active = closed
    .filter(t => t?.postExitMonitor?.enabled)
    .filter(t => now <= Number(t?.postExitMonitor?.until || 0))
    .slice(-POST_EXIT_MAX_MONITOR_ROWS)
    .slice(0, POST_EXIT_MAX_MONITOR_PER_RUN);

  for (const trade of active) {
    const price = await fetchPostExitPrice(trade);
    if (!price) continue;

    updatePostExitTrade(trade, price);
  }

  for (const trade of closed) {
    if (!trade?.postExitMonitor?.enabled) continue;

    if (now > Number(trade.postExitMonitor.until || 0)) {
      trade.postExitMonitor.status = "DONE";
      trade.postExitMonitor.enabled = false;
    }
  }
}

function buildPostExitReport() {
  const closed = auditState.closedTrades || [];
  const monitored = closed.filter(t => t?.postExitMonitor);
  const completed = monitored.filter(t => t?.postExitMonitor?.status === "DONE" || !t?.postExitMonitor?.enabled);

  const tpTrades = monitored.filter(t => String(t.exitReason || "").toUpperCase() === "TP");
  const slTrades = monitored.filter(t => String(t.exitReason || "").toUpperCase() === "SL");

  const tpFollowThrough = tpTrades.filter(t => Number(t?.postExitMonitor?.tpFollowThroughR || 0) >= TP_FOLLOW_THROUGH_R);
  const tpBigFollowThrough = tpTrades.filter(t => Boolean(t?.postExitMonitor?.tpBigFollowThrough));
  const tpPerfect = tpTrades.filter(t => Boolean(t?.postExitMonitor?.tpPerfectExit));

  const slStopHunts = slTrades.filter(t => Boolean(t?.postExitMonitor?.slStopHunt));
  const slRecoveredHalf = slTrades.filter(t => Boolean(t?.postExitMonitor?.slRecoveredHalfR));
  const slRecoveredOne = slTrades.filter(t => Boolean(t?.postExitMonitor?.slRecoveredOneR));
  const slProtected = slTrades.filter(t => Boolean(t?.postExitMonitor?.slProtected));

  return {
    tag: "TS_OPTIMIZER_POST_EXIT",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      monitoredTrades: monitored.length,
      completedMonitors: completed.length,
      activeMonitors: monitored.length - completed.length,
      tpTrades: tpTrades.length,
      slTrades: slTrades.length,
      confidence:
        monitored.length >= 30
          ? "HIGH"
          : monitored.length >= 15
            ? "MEDIUM"
            : "LOW"
    },

    tpExitQuality: {
      followThroughCount: tpFollowThrough.length,
      followThroughPct: tpTrades.length ? `${((tpFollowThrough.length / tpTrades.length) * 100).toFixed(1)}%` : "0.0%",
      bigFollowThroughCount: tpBigFollowThrough.length,
      bigFollowThroughPct: tpTrades.length ? `${((tpBigFollowThrough.length / tpTrades.length) * 100).toFixed(1)}%` : "0.0%",
      perfectExitCount: tpPerfect.length,
      perfectExitPct: tpTrades.length ? `${((tpPerfect.length / tpTrades.length) * 100).toFixed(1)}%` : "0.0%",
      avgFollowThroughR: Number(safeAvg(tpTrades.map(t => Number(t?.postExitMonitor?.tpFollowThroughR || 0))).toFixed(3)),
      examplesTooEarly: tpFollowThrough.slice(-10).map(t => `${t.symbol}_${t.side}_exitR=${t.exitR}_postMaxR=${t.postExitMonitor.maxR}_extra=${t.postExitMonitor.tpFollowThroughR}`),
      examplesPerfect: tpPerfect.slice(-10).map(t => `${t.symbol}_${t.side}_exitR=${t.exitR}_postMaxR=${t.postExitMonitor.maxR}_postMinR=${t.postExitMonitor.minR}`)
    },

    slExitQuality: {
      stopHuntCount: slStopHunts.length,
      stopHuntPct: slTrades.length ? `${((slStopHunts.length / slTrades.length) * 100).toFixed(1)}%` : "0.0%",
      recoveredHalfRCount: slRecoveredHalf.length,
      recoveredHalfRPct: slTrades.length ? `${((slRecoveredHalf.length / slTrades.length) * 100).toFixed(1)}%` : "0.0%",
      recoveredOneRCount: slRecoveredOne.length,
      recoveredOneRPct: slTrades.length ? `${((slRecoveredOne.length / slTrades.length) * 100).toFixed(1)}%` : "0.0%",
      protectedCount: slProtected.length,
      protectedPct: slTrades.length ? `${((slProtected.length / slTrades.length) * 100).toFixed(1)}%` : "0.0%",
      avgPostExitMaxR: Number(safeAvg(slTrades.map(t => Number(t?.postExitMonitor?.maxR || 0))).toFixed(3)),
      avgPostExitMinR: Number(safeAvg(slTrades.map(t => Number(t?.postExitMonitor?.minR || 0))).toFixed(3)),
      examplesStopHunt: slStopHunts.slice(-10).map(t => `${t.symbol}_${t.side}_exitR=${t.exitR}_postMaxR=${t.postExitMonitor.maxR}_postMinR=${t.postExitMonitor.minR}`),
      examplesProtected: slProtected.slice(-10).map(t => `${t.symbol}_${t.side}_exitR=${t.exitR}_postMaxR=${t.postExitMonitor.maxR}_postMinR=${t.postExitMonitor.minR}`)
    },

    decisions: {
      tpTooConservative:
        tpTrades.length >= 5 &&
        tpFollowThrough.length / Math.max(1, tpTrades.length) >= 0.40,

      tpGood:
        tpTrades.length >= 5 &&
        tpPerfect.length / Math.max(1, tpTrades.length) >= 0.50,

      slTooTight:
        slTrades.length >= 5 &&
        slStopHunts.length / Math.max(1, slTrades.length) >= 0.40,

      slWorking:
        slTrades.length >= 5 &&
        slProtected.length / Math.max(1, slTrades.length) >= 0.40
    },

    recommendedActions: [
      tpTrades.length >= 5 && tpFollowThrough.length / Math.max(1, tpTrades.length) >= 0.40
        ? "TP_TOO_EARLY: increase TP multiplier or add trailing runner after TP1"
        : null,
      tpTrades.length >= 5 && tpPerfect.length / Math.max(1, tpTrades.length) >= 0.50
        ? "TP_GOOD: keep TP geometry"
        : null,
      slTrades.length >= 5 && slStopHunts.length / Math.max(1, slTrades.length) >= 0.40
        ? "SL_TOO_TIGHT_OR_ENTRY_EARLY: widen SL slightly or delay entry until sweep confirmation"
        : null,
      slTrades.length >= 5 && slProtected.length / Math.max(1, slTrades.length) >= 0.40
        ? "SL_WORKING: do not widen SL for this cohort"
        : null
    ].filter(Boolean),

    sampleRows: monitored.slice(-30).map(t => ({
      symbol: t.symbol,
      side: t.side,
      setupClass: t.setupClass,
      exitReason: t.exitReason,
      exitR: t.exitR,
      mfeR: t.mfeR,
      maeR: t.maeR,
      postStatus: t.postExitMonitor?.status,
      postTicks: t.postExitMonitor?.ticks,
      postMaxR: t.postExitMonitor?.maxR,
      postMinR: t.postExitMonitor?.minR,
      tpFollowThroughR: t.postExitMonitor?.tpFollowThroughR,
      tpBigFollowThrough: t.postExitMonitor?.tpBigFollowThrough,
      tpPerfectExit: t.postExitMonitor?.tpPerfectExit,
      slStopHunt: t.postExitMonitor?.slStopHunt,
      slRecoveredHalfR: t.postExitMonitor?.slRecoveredHalfR,
      slRecoveredOneR: t.postExitMonitor?.slRecoveredOneR,
      slProtected: t.postExitMonitor?.slProtected
    }))
  };
}

// ================= AUDIT =================
function recordEntry(entryPayload, position) {
  auditState.entries++;
  incrementMapCount(auditState.entryReasonCounts, entryPayload.reason);
  incrementMapCount(auditState.entrySetupClassCounts, position.setupClass || "UNKNOWN");

  initializePositionPathMetrics(position);

  auditState.recentEntries.push({
    symbol: position.symbol,
    side: position.side,
    setupClass: position.setupClass || "UNKNOWN",
    entryReason: position.entryReason || entryPayload.reason,
    entry: position.entry,
    sl: position.sl,
    tp: position.tp,
    rr: Number(position.rr || 0),
    baseRR: Number(position.baseRR || 0),
    tpRewardMultiplier: Number(position.tpRewardMultiplier || 1),
    score: Number(position.score || position.moveScore || 0),
    confluence: Number(position.confluence || 0),
    sniperScore: Number(position.sniperScore || 0),
    rsi: Number(position.rsi || 0),
    rsiHTF: Number(position.rsiHTF || 0),
    rsiZone: position.rsiZone || null,
    obBias: position.obBias || "UNKNOWN",
    spreadPct: Number(position.spreadPct || 0),
    depthMinUsd1p: Number(position.depthMinUsd1p || 0),
    flow: position.flow || "UNKNOWN",
    funding: Number(position.funding || 0),
    btcState: position.btcState || "UNKNOWN",
    regime: position.regime || "UNKNOWN",
    createdAt: position.createdAt,
    strategyVersion: STRATEGY_VERSION
  });

  if (auditState.recentEntries.length > MAX_RECENT_ENTRY_AUDIT_ROWS) {
    auditState.recentEntries.shift();
  }
}

function recordExit(exitPayload, pos, exitPrice, isBull) {
  const r = calculateExitR(pos, exitPrice, isBull);
  const pnlPct = calculatePnlPct(pos, exitPrice, isBull);
  const holdMs = Date.now() - Number(pos.createdAt || Date.now());
  const pathFields = buildPathExitFields(pos, exitPayload.reason);

  auditState.exits++;
  auditState.rTotal += r;
  auditState.pnlPctTotal += pnlPct;

  if (exitPayload.reason === "TP") auditState.wins++;
  if (exitPayload.reason === "SL") auditState.losses++;

  incrementMapCount(auditState.exitReasonCounts, exitPayload.reason);

  exitPayload.exitR = Number(r.toFixed(3));
  exitPayload.pnlPct = Number(pnlPct.toFixed(3));
  exitPayload.holdMinutes = Number((holdMs / 60000).toFixed(1));
  exitPayload.setupClass = pos.setupClass || "UNKNOWN";
  exitPayload.strategyVersion = pos.strategyVersion || STRATEGY_VERSION;

  Object.assign(exitPayload, pathFields);

  const closedTrade = initializePostExitFields({
    symbol: pos.symbol,
    side: pos.side,
    rawBitgetSymbol: pos.rawBitgetSymbol || pos.symbol,

    setupClass: pos.setupClass || "UNKNOWN",
    entryReason: pos.entryReason || pos.reason || "UNKNOWN",
    exitReason: exitPayload.reason,

    entry: Number(pos.entry || 0),
    exit: Number(exitPrice || 0),
    sl: Number(pos.sl || 0),
    tp: Number(pos.tp || 0),

    plannedRR: Number(pos.rr || 0),
    baseRR: Number(pos.baseRR || 0),
    tpRewardMultiplier: Number(pos.tpRewardMultiplier || 1),

    exitR: Number(r.toFixed(3)),
    pnlPct: Number(pnlPct.toFixed(3)),
    holdMinutes: Number((holdMs / 60000).toFixed(1)),

    ...pathFields,

    grade: pos.grade || "N/A",
    gradePoints: Number(pos.gradePoints || 0),
    recommendedRisk: pos.recommendedRisk || "N/A",

    score: Number(pos.score || pos.moveScore || 0),
    confluence: Number(pos.confluence || 0),
    sniper: pos.sniper || "UNKNOWN",
    sniperScore: Number(pos.sniperScore || 0),

    rsi: Number(pos.rsi || 0),
    rsiHTF: Number(pos.rsiHTF || 0),
    rsiZone: pos.rsiZone || "UNKNOWN",

    obBias: pos.obBias || "UNKNOWN",
    spreadPct: Number(pos.spreadPct || 0),
    depthMinUsd1p: Number(pos.depthMinUsd1p || 0),

    flow: pos.flow || "UNKNOWN",
    funding: Number(pos.funding || 0),
    regime: pos.regime || "UNKNOWN",
    btcState: pos.btcState || "UNKNOWN",

    createdAt: pos.createdAt || null,
    exitedAt: Date.now(),
    strategyVersion: pos.strategyVersion || STRATEGY_VERSION
  });

  auditState.closedTrades.push(closedTrade);

  if (auditState.closedTrades.length > MAX_CLOSED_TRADE_AUDIT_ROWS) {
    auditState.closedTrades.shift();
  }
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
    currentR: Number(Number(pos.currentR || 0).toFixed(3)),
    mfeR: Number(Number(pos.mfeR || 0).toFixed(3)),
    maeR: Number(Number(pos.maeR || 0).toFixed(3)),
    maxTpProgress: Number(Number(pos.maxTpProgress || 0).toFixed(3)),
    reachedHalfR: Boolean(pos.reachedHalfR),
    reachedOneR: Boolean(pos.reachedOneR),
    nearTpSeen: Boolean(pos.nearTpSeen),
    ticksObserved: Number(pos.ticksObserved || 0),
    adverseTicks: Number(pos.adverseTicks || 0),
    score: pos.score || pos.moveScore || 0,
    conf: pos.confluence || 0,
    sniper: pos.sniperScore || 0,
    rsiZone: pos.rsiZone || null,
    obBias: pos.obBias || "UNKNOWN",
    btcState: pos.btcState || "UNKNOWN",
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

function getTradeStats(rows) {
  const trades = Array.isArray(rows) ? rows : [];
  const wins = trades.filter(t => t.exitReason === "TP" || Number(t.exitR || 0) > 0).length;
  const losses = trades.filter(t => t.exitReason === "SL" || Number(t.exitR || 0) < 0).length;
  const total = wins + losses;

  const directSL = trades.filter(t => Boolean(t.directToSL)).length;
  const slAfterHalfR = trades.filter(t => Boolean(t.slAfterHalfR)).length;
  const slAfterOneR = trades.filter(t => Boolean(t.slAfterOneR)).length;
  const slAfterNearTp = trades.filter(t => Boolean(t.slAfterNearTp)).length;
  const nearTp = trades.filter(t => Boolean(t.nearTpSeen)).length;
  const reachedHalfR = trades.filter(t => Boolean(t.reachedHalfR)).length;
  const reachedOneR = trades.filter(t => Boolean(t.reachedOneR)).length;

  return {
    trades: trades.length,
    wins,
    losses,
    winrate: formatWinrate(wins, total),

    totalR: Number(safeSum(trades.map(t => Number(t.exitR || 0))).toFixed(3)),
    avgR: Number(safeAvg(trades.map(t => Number(t.exitR || 0))).toFixed(3)),

    totalPnlPct: Number(safeSum(trades.map(t => Number(t.pnlPct || 0))).toFixed(3)),
    avgPnlPct: Number(safeAvg(trades.map(t => Number(t.pnlPct || 0))).toFixed(3)),

    avgMfeR: Number(safeAvg(trades.map(t => Number(t.mfeR || 0))).toFixed(3)),
    avgMaeR: Number(safeAvg(trades.map(t => Number(t.maeR || 0))).toFixed(3)),
    avgPlannedRR: Number(safeAvg(trades.map(t => Number(t.plannedRR || 0))).toFixed(3)),
    avgBaseRR: Number(safeAvg(trades.map(t => Number(t.baseRR || 0))).toFixed(3)),

    avgHoldMinutes: Number(safeAvg(trades.map(t => Number(t.holdMinutes || 0))).toFixed(1)),
    avgTicksObserved: Number(safeAvg(trades.map(t => Number(t.ticksObserved || 0))).toFixed(1)),
    avgAdverseTicks: Number(safeAvg(trades.map(t => Number(t.adverseTicks || 0))).toFixed(1)),
    avgTicksToMae: Number(safeAvg(trades.map(t => Number(t.ticksToMae || 0))).toFixed(1)),
    avgEstimatedAdverse15mCandles: Number(safeAvg(trades.map(t => Number(t.estimatedAdverse15mCandles || 0))).toFixed(1)),

    directSL,
    directSLPct: trades.length ? `${((directSL / trades.length) * 100).toFixed(1)}%` : "0.0%",

    nearTp,
    nearTpPct: trades.length ? `${((nearTp / trades.length) * 100).toFixed(1)}%` : "0.0%",

    reachedHalfR,
    reachedHalfRPct: trades.length ? `${((reachedHalfR / trades.length) * 100).toFixed(1)}%` : "0.0%",

    reachedOneR,
    reachedOneRPct: trades.length ? `${((reachedOneR / trades.length) * 100).toFixed(1)}%` : "0.0%",

    slAfterHalfR,
    slAfterOneR,
    slAfterNearTp
  };
}

function buildSetupClassStats() {
  const closed = auditState.closedTrades || [];
  const classes = new Set([
    ...Object.keys(auditState.entrySetupClassCounts || {}),
    ...closed.map(t => String(t.setupClass || "UNKNOWN").toUpperCase())
  ]);

  const result = {};

  for (const setupClass of classes) {
    const rows = closed.filter(t => String(t.setupClass || "UNKNOWN").toUpperCase() === setupClass);
    const baseStats = getTradeStats(rows);
    const entries = Number(auditState.entrySetupClassCounts?.[setupClass] || 0);

    result[setupClass] = {
      entries,
      exits: rows.length,
      ...baseStats,
      avgScore: Number(safeAvg(rows.map(t => Number(t.score || 0))).toFixed(1)),
      avgConfluence: Number(safeAvg(rows.map(t => Number(t.confluence || 0))).toFixed(1)),
      avgSniper: Number(safeAvg(rows.map(t => Number(t.sniperScore || 0))).toFixed(1))
    };
  }

  return result;
}

function buildLoserProfile() {
  const losers = (auditState.closedTrades || []).filter(t => {
    return t.exitReason === "SL" || Number(t.exitR || 0) < 0;
  });

  if (!losers.length) {
    return {
      losses: 0,
      mostCommonRsiZone: null,
      mostCommonObBias: null,
      mostCommonBtcState: null,
      mostCommonSetupClass: null,
      mostCommonEntryReason: null,
      mostCommonSide: null,
      avgLossR: 0,
      avgLossPnlPct: 0,
      avgMfeR: 0,
      avgMaeR: 0,
      directSLCount: 0,
      slAfterHalfRCount: 0,
      slAfterNearTpCount: 0
    };
  }

  return {
    losses: losers.length,
    mostCommonRsiZone: topCountFromRows(losers, "rsiZone"),
    mostCommonObBias: topCountFromRows(losers, "obBias"),
    mostCommonBtcState: topCountFromRows(losers, "btcState"),
    mostCommonSetupClass: topCountFromRows(losers, "setupClass"),
    mostCommonEntryReason: topCountFromRows(losers, "entryReason"),
    mostCommonSide: topCountFromRows(losers, "side"),
    avgLossR: Number(safeAvg(losers.map(t => Number(t.exitR || 0))).toFixed(3)),
    avgLossPnlPct: Number(safeAvg(losers.map(t => Number(t.pnlPct || 0))).toFixed(3)),
    avgMfeR: Number(safeAvg(losers.map(t => Number(t.mfeR || 0))).toFixed(3)),
    avgMaeR: Number(safeAvg(losers.map(t => Number(t.maeR || 0))).toFixed(3)),
    avgTicksToMae: Number(safeAvg(losers.map(t => Number(t.ticksToMae || 0))).toFixed(1)),
    avgAdverseTicks: Number(safeAvg(losers.map(t => Number(t.adverseTicks || 0))).toFixed(1)),
    directSLCount: losers.filter(t => Boolean(t.directToSL)).length,
    slAfterHalfRCount: losers.filter(t => Boolean(t.slAfterHalfR)).length,
    slAfterOneRCount: losers.filter(t => Boolean(t.slAfterOneR)).length,
    slAfterNearTpCount: losers.filter(t => Boolean(t.slAfterNearTp)).length,
    directSLExamples: losers.filter(t => Boolean(t.directToSL)).slice(-8).map(t => `${t.symbol}_${t.side}_${t.mfeR}mfe_${t.maeR}mae`),
    pullbackAfterProfitExamples: losers.filter(t => Boolean(t.slAfterHalfR) || Boolean(t.slAfterNearTp)).slice(-8).map(t => `${t.symbol}_${t.side}_${t.mfeR}mfe_${t.maeR}mae`)
  };
}

function buildWinnerProfile() {
  const winners = (auditState.closedTrades || []).filter(t => {
    return t.exitReason === "TP" || Number(t.exitR || 0) > 0;
  });

  if (!winners.length) {
    return {
      wins: 0,
      mostCommonRsiZone: null,
      mostCommonObBias: null,
      mostCommonBtcState: null,
      mostCommonSetupClass: null,
      mostCommonEntryReason: null,
      mostCommonSide: null,
      avgWinR: 0,
      avgWinPnlPct: 0,
      avgMfeR: 0,
      avgMaeR: 0
    };
  }

  return {
    wins: winners.length,
    mostCommonRsiZone: topCountFromRows(winners, "rsiZone"),
    mostCommonObBias: topCountFromRows(winners, "obBias"),
    mostCommonBtcState: topCountFromRows(winners, "btcState"),
    mostCommonSetupClass: topCountFromRows(winners, "setupClass"),
    mostCommonEntryReason: topCountFromRows(winners, "entryReason"),
    mostCommonSide: topCountFromRows(winners, "side"),
    avgWinR: Number(safeAvg(winners.map(t => Number(t.exitR || 0))).toFixed(3)),
    avgWinPnlPct: Number(safeAvg(winners.map(t => Number(t.pnlPct || 0))).toFixed(3)),
    avgMfeR: Number(safeAvg(winners.map(t => Number(t.mfeR || 0))).toFixed(3)),
    avgMaeR: Number(safeAvg(winners.map(t => Number(t.maeR || 0))).toFixed(3)),
    avgTicksToMfe: Number(safeAvg(winners.map(t => Number(t.ticksToMfe || 0))).toFixed(1)),
    avgAdverseTicks: Number(safeAvg(winners.map(t => Number(t.adverseTicks || 0))).toFixed(1))
  };
}

function parsePct(pctText) {
  return Number(String(pctText || "0").replace("%", "")) || 0;
}

function diagnosePerformance({ completed, winrateNum, avgR }) {
  if (completed < 10) {
    return {
      problem: "SAMPLE_TOO_SMALL",
      priority: "KEEP_RUNNING",
      note: "less_than_10_closed_trades"
    };
  }

  if (avgR < 0 && winrateNum < 45) {
    return {
      problem: "ENTRY_QUALITY_TOO_LOW",
      priority: "TIGHTEN_ENTRY_QUALITY",
      note: "low_winrate_and_negative_avgR"
    };
  }

  if (avgR < 0 && winrateNum >= 50) {
    return {
      problem: "PAYOFF_TOO_LOW",
      priority: "IMPROVE_TP_SL_GEOMETRY",
      note: "winrate_ok_but_payout_negative"
    };
  }

  if (avgR < 0 && winrateNum >= 45 && winrateNum < 50) {
    return {
      problem: "WINRATE_AND_PAYOFF_WEAK",
      priority: "TIGHTEN_A_AND_REVIEW_TP",
      note: "borderline_winrate_negative_avgR"
    };
  }

  if (avgR >= 0 && winrateNum < 45) {
    return {
      problem: "PAYOFF_SAVING_SYSTEM_BUT_WINRATE_LOW",
      priority: "TIGHTEN_LOSS_PROFILE",
      note: "positive_avgR_but_low_hit_rate"
    };
  }

  if (avgR >= 0 && winrateNum >= 45) {
    return {
      problem: "HEALTHY_ENOUGH",
      priority: "KEEP_SAMPLE_GROWING",
      note: "positive_avgR_with_usable_winrate"
    };
  }

  return {
    problem: "UNKNOWN",
    priority: "COLLECT_MORE_DATA",
    note: "no_clear_diagnosis"
  };
}

function evaluateMinThreshold(rows, field, currentValue) {
  const values = rows
    .map(r => Number(r?.[field]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (values.length < 4) {
    return {
      field,
      currentValue,
      suggestedValue: currentValue,
      confidence: "LOW",
      reason: "not_enough_rows"
    };
  }

  const unique = Array.from(new Set(values.map(v => Number(v.toFixed(3)))));
  const minKept = Math.max(3, Math.ceil(rows.length * 0.35));

  let best = null;

  for (const threshold of unique) {
    const kept = rows.filter(r => Number(r?.[field]) >= threshold);
    if (kept.length < minKept) continue;

    const stats = getTradeStats(kept);
    const winrateNum = parsePct(stats.winrate);
    const keepRatio = kept.length / rows.length;
    const score = Number(stats.avgR || 0) + (winrateNum / 100) * 0.50 + keepRatio * 0.15;

    const candidate = {
      threshold,
      kept: kept.length,
      keepRatio: Number(keepRatio.toFixed(3)),
      winrate: stats.winrate,
      avgR: stats.avgR,
      totalR: stats.totalR,
      score: Number(score.toFixed(4))
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  if (!best) {
    return {
      field,
      currentValue,
      suggestedValue: currentValue,
      confidence: "LOW",
      reason: "no_valid_threshold"
    };
  }

  return {
    field,
    currentValue,
    suggestedValue: Number(best.threshold.toFixed(3)),
    confidence: rows.length >= 20 ? "HIGH" : rows.length >= 10 ? "MEDIUM" : "LOW",
    best
  };
}

function evaluateMaxThreshold(rows, field, currentValue) {
  const values = rows
    .map(r => Number(r?.[field]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (values.length < 4) {
    return {
      field,
      currentValue,
      suggestedValue: currentValue,
      confidence: "LOW",
      reason: "not_enough_rows"
    };
  }

  const unique = Array.from(new Set(values.map(v => Number(v.toFixed(6)))));
  const minKept = Math.max(3, Math.ceil(rows.length * 0.35));

  let best = null;

  for (const threshold of unique) {
    const kept = rows.filter(r => Number(r?.[field]) <= threshold);
    if (kept.length < minKept) continue;

    const stats = getTradeStats(kept);
    const winrateNum = parsePct(stats.winrate);
    const keepRatio = kept.length / rows.length;
    const score = Number(stats.avgR || 0) + (winrateNum / 100) * 0.50 + keepRatio * 0.15;

    const candidate = {
      threshold,
      kept: kept.length,
      keepRatio: Number(keepRatio.toFixed(3)),
      winrate: stats.winrate,
      avgR: stats.avgR,
      totalR: stats.totalR,
      score: Number(score.toFixed(4))
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  if (!best) {
    return {
      field,
      currentValue,
      suggestedValue: currentValue,
      confidence: "LOW",
      reason: "no_valid_threshold"
    };
  }

  return {
    field,
    currentValue,
    suggestedValue: Number(best.threshold.toFixed(6)),
    confidence: rows.length >= 20 ? "HIGH" : rows.length >= 10 ? "MEDIUM" : "LOW",
    best
  };
}

function buildMfeMaeReport() {
  const closed = auditState.closedTrades || [];
  const losers = closed.filter(t => t.exitReason === "SL" || Number(t.exitR || 0) < 0);
  const winners = closed.filter(t => t.exitReason === "TP" || Number(t.exitR || 0) > 0);

  const directSL = losers.filter(t => Boolean(t.directToSL));
  const slAfterHalfR = losers.filter(t => Boolean(t.slAfterHalfR));
  const slAfterOneR = losers.filter(t => Boolean(t.slAfterOneR));
  const slAfterNearTp = losers.filter(t => Boolean(t.slAfterNearTp));

  return {
    tag: "TS_OPTIMIZER_MFE_MAE",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      closedTrades: closed.length,
      winners: winners.length,
      losers: losers.length,
      confidence:
        closed.length >= 20
          ? "HIGH"
          : closed.length >= 10
            ? "MEDIUM"
            : "LOW"
    },

    overall: getTradeStats(closed),
    winners: getTradeStats(winners),
    losers: getTradeStats(losers),

    answers: {
      didLosersGoPositiveFirst: {
        count: losers.filter(t => Number(t.mfeR || 0) > 0).length,
        reachedHalfR: slAfterHalfR.length,
        reachedOneR: slAfterOneR.length,
        examplesHalfR: slAfterHalfR.slice(-10).map(t => `${t.symbol}_${t.side}_mfe=${t.mfeR}_mae=${t.maeR}`),
        examplesOneR: slAfterOneR.slice(-10).map(t => `${t.symbol}_${t.side}_mfe=${t.mfeR}_mae=${t.maeR}`)
      },

      didLosersGoDirectToSL: {
        count: directSL.length,
        pctOfLosers: losers.length ? `${((directSL.length / losers.length) * 100).toFixed(1)}%` : "0.0%",
        examples: directSL.slice(-10).map(t => `${t.symbol}_${t.side}_mfe=${t.mfeR}_mae=${t.maeR}_ticksToMae=${t.ticksToMae}`)
      },

      didLosersAlmostHitTPBeforeSL: {
        count: slAfterNearTp.length,
        pctOfLosers: losers.length ? `${((slAfterNearTp.length / losers.length) * 100).toFixed(1)}%` : "0.0%",
        examples: slAfterNearTp.slice(-10).map(t => `${t.symbol}_${t.side}_tpProgress=${t.maxTpProgress}_mfe=${t.mfeR}_mae=${t.maeR}`)
      },

      adverseMoveSpeed: {
        avgLoserTicksToMae: Number(safeAvg(losers.map(t => Number(t.ticksToMae || 0))).toFixed(1)),
        avgLoserAdverseTicks: Number(safeAvg(losers.map(t => Number(t.adverseTicks || 0))).toFixed(1)),
        avgEstimatedAdverse15mCandles: Number(safeAvg(losers.map(t => Number(t.estimatedAdverse15mCandles || 0))).toFixed(1)),
        note: "ticks are tradeSystem scan observations; estimatedAdverse15mCandles = ticksToMae / 3"
      }
    },

    decisionRules: {
      ifDirectSLDominates: "tighten entry filters: sniper/confluence/RSI/OB before touching TP",
      ifSLAfterHalfRDominates: "add break-even or trailing after +0.5R",
      ifSLAfterNearTPDominates: "reduce TP multiplier or take partial/exit at 80% TP progress",
      ifWinnersMfeMuchHigherThanExitR: "TP can be increased for that cohort",
      ifLosersMfeVeryLow: "higher RR will not fix it; entry quality is the issue"
    },

    closedTradeMfeMaeSample: closed.slice(-30).map(t => ({
      symbol: t.symbol,
      side: t.side,
      setupClass: t.setupClass,
      entryReason: t.entryReason,
      exitReason: t.exitReason,
      exitR: t.exitR,
      mfeR: t.mfeR,
      maeR: t.maeR,
      maxTpProgress: t.maxTpProgress,
      reachedHalfR: t.reachedHalfR,
      reachedOneR: t.reachedOneR,
      nearTpSeen: t.nearTpSeen,
      directToSL: t.directToSL,
      slAfterHalfR: t.slAfterHalfR,
      slAfterNearTp: t.slAfterNearTp,
      ticksObserved: t.ticksObserved,
      ticksToMae: t.ticksToMae,
      adverseTicks: t.adverseTicks,
      estimatedAdverse15mCandles: t.estimatedAdverse15mCandles,
      rsiZone: t.rsiZone,
      obBias: t.obBias,
      btcState: t.btcState,
      confluence: t.confluence,
      sniperScore: t.sniperScore,
      score: t.score,
      plannedRR: t.plannedRR
    }))
  };
}

function buildRecommendedFilterValues({ reasonTable }) {
  const closed = auditState.closedTrades || [];
  const aRows = closed.filter(t => String(t.setupClass || "").toUpperCase() === "A");
  const bRows = closed.filter(t => String(t.setupClass || "").toUpperCase() === "B");
  const godRows = closed.filter(t => String(t.setupClass || "").toUpperCase() === "GOD");

  const overallStats = getTradeStats(closed);
  const aStats = getTradeStats(aRows);
  const bStats = getTradeStats(bRows);
  const godStats = getTradeStats(godRows);
  const mfeReport = buildMfeMaeReport();

  const recommendations = [];

  function pushRecommendation({
    parameter,
    currentValue,
    suggestedValue,
    confidence,
    reason,
    action
  }) {
    recommendations.push({
      parameter,
      currentValue,
      suggestedValue,
      confidence,
      action,
      reason
    });
  }

  const aConf = evaluateMinThreshold(aRows, "confluence", CURRENT_FILTER_VALUES.A_MIN_CONFLUENCE);
  const aSniper = evaluateMinThreshold(aRows, "sniperScore", CURRENT_FILTER_VALUES.A_MIN_SNIPER);
  const aRR = evaluateMinThreshold(aRows, "plannedRR", A_ENTRY_MIN_RR);

  const bConf = evaluateMinThreshold(bRows, "confluence", CURRENT_FILTER_VALUES.B_MIN_CONFLUENCE);
  const bSniper = evaluateMinThreshold(bRows, "sniperScore", CURRENT_FILTER_VALUES.B_MIN_SNIPER);
  const bRR = evaluateMinThreshold(bRows, "plannedRR", B_ENTRY_MIN_RR);

  const spreadMax = evaluateMaxThreshold(closed, "spreadPct", MAX_SPREAD_PCT);

  if (aRows.length >= 5) {
    pushRecommendation({
      parameter: "A_MIN_CONFLUENCE",
      currentValue: CURRENT_FILTER_VALUES.A_MIN_CONFLUENCE,
      suggestedValue: aConf.suggestedValue,
      confidence: aConf.confidence,
      action: aConf.suggestedValue > CURRENT_FILTER_VALUES.A_MIN_CONFLUENCE ? "RAISE" : "KEEP_OR_LOWER",
      reason: `A sample exits=${aRows.length}, winrate=${aStats.winrate}, avgR=${aStats.avgR}`
    });

    pushRecommendation({
      parameter: "A_MIN_SNIPER",
      currentValue: CURRENT_FILTER_VALUES.A_MIN_SNIPER,
      suggestedValue: aSniper.suggestedValue,
      confidence: aSniper.confidence,
      action: aSniper.suggestedValue > CURRENT_FILTER_VALUES.A_MIN_SNIPER ? "RAISE" : "KEEP_OR_LOWER",
      reason: `A sniper threshold backtest on closed sample. avgSniper=${aStats.avgSniper || "n/a"}`
    });

    pushRecommendation({
      parameter: "A_ENTRY_MIN_RR",
      currentValue: A_ENTRY_MIN_RR,
      suggestedValue: aRR.suggestedValue,
      confidence: aRR.confidence,
      action: aRR.suggestedValue > A_ENTRY_MIN_RR ? "RAISE" : "KEEP_OR_LOWER",
      reason: `A RR threshold backtest. avgPlannedRR=${aStats.avgPlannedRR}`
    });
  }

  if (bRows.length >= 3) {
    pushRecommendation({
      parameter: "B_MIN_CONFLUENCE",
      currentValue: CURRENT_FILTER_VALUES.B_MIN_CONFLUENCE,
      suggestedValue: bConf.suggestedValue,
      confidence: bConf.confidence,
      action: bConf.suggestedValue > CURRENT_FILTER_VALUES.B_MIN_CONFLUENCE ? "RAISE" : "KEEP_OR_LOWER",
      reason: `B sample exits=${bRows.length}, winrate=${bStats.winrate}, avgR=${bStats.avgR}`
    });

    pushRecommendation({
      parameter: "B_MIN_SNIPER",
      currentValue: CURRENT_FILTER_VALUES.B_MIN_SNIPER,
      suggestedValue: bSniper.suggestedValue,
      confidence: bSniper.confidence,
      action: bSniper.suggestedValue > CURRENT_FILTER_VALUES.B_MIN_SNIPER ? "RAISE" : "KEEP_OR_LOWER",
      reason: `B sniper threshold backtest`
    });

    pushRecommendation({
      parameter: "B_ENTRY_MIN_RR",
      currentValue: B_ENTRY_MIN_RR,
      suggestedValue: bRR.suggestedValue,
      confidence: bRR.confidence,
      action: bRR.suggestedValue > B_ENTRY_MIN_RR ? "RAISE" : "KEEP_OR_LOWER",
      reason: `B RR threshold backtest`
    });
  }

  if (closed.length >= 5) {
    pushRecommendation({
      parameter: "MAX_SPREAD_PCT",
      currentValue: MAX_SPREAD_PCT,
      suggestedValue: spreadMax.suggestedValue,
      confidence: spreadMax.confidence,
      action: spreadMax.suggestedValue < MAX_SPREAD_PCT ? "LOWER_MAX_SPREAD" : "KEEP_OR_RELAX",
      reason: `Spread threshold backtest on closed sample`
    });
  }

  const losers = closed.filter(t => t.exitReason === "SL" || Number(t.exitR || 0) < 0);
  const directSLCount = losers.filter(t => Boolean(t.directToSL)).length;
  const slAfterHalfRCount = losers.filter(t => Boolean(t.slAfterHalfR)).length;
  const slAfterNearTpCount = losers.filter(t => Boolean(t.slAfterNearTp)).length;

  if (losers.length >= 3) {
    if (directSLCount / losers.length >= 0.50) {
      pushRecommendation({
        parameter: "ENTRY_QUALITY",
        currentValue: "current",
        suggestedValue: "raise sniper/confluence; do not raise TP yet",
        confidence: closed.length >= 20 ? "HIGH" : "MEDIUM",
        action: "TIGHTEN_ENTRY",
        reason: `${directSLCount}/${losers.length} losers went direct-to-SL with MFE < ${DIRECT_SL_MFE_LIMIT_R}R`
      });
    }

    if (slAfterHalfRCount / losers.length >= 0.35) {
      pushRecommendation({
        parameter: "BREAK_EVEN_RULE",
        currentValue: "disabled",
        suggestedValue: "move SL to entry after +0.5R for A/GOD only",
        confidence: closed.length >= 20 ? "HIGH" : "MEDIUM",
        action: "ADD_BE_AFTER_HALF_R",
        reason: `${slAfterHalfRCount}/${losers.length} losers first reached +0.5R then hit SL`
      });
    }

    if (slAfterNearTpCount / losers.length >= 0.25) {
      pushRecommendation({
        parameter: "TP_REWARD_MULTIPLIER",
        currentValue: "current",
        suggestedValue: "reduce A/GOD TP multiplier slightly or exit at 80% TP progress",
        confidence: closed.length >= 20 ? "HIGH" : "MEDIUM",
        action: "REDUCE_TP_OR_TRAIL",
        reason: `${slAfterNearTpCount}/${losers.length} losers nearly hit TP before SL`
      });
    }
  }

  if (!recommendations.length) {
    pushRecommendation({
      parameter: "SAMPLE",
      currentValue: closed.length,
      suggestedValue: "run until 10 closed trades soft / 20 hard",
      confidence: "LOW",
      action: "KEEP_RUNNING",
      reason: "not enough closed trades for stable value optimization"
    });
  }

  return {
    tag: "TS_OPTIMIZER_RECOMMENDED_VALUES",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),
    currentValues: CURRENT_FILTER_VALUES,
    sample: {
      closedTrades: closed.length,
      aTrades: aRows.length,
      bTrades: bRows.length,
      godTrades: godRows.length,
      confidence:
        closed.length >= 20
          ? "HIGH"
          : closed.length >= 10
            ? "MEDIUM"
            : "LOW"
    },
    cohortStats: {
      overall: overallStats,
      A: aStats,
      B: bStats,
      GOD: godStats
    },
    thresholdBacktests: {
      A: {
        confluence: aConf,
        sniperScore: aSniper,
        plannedRR: aRR
      },
      B: {
        confluence: bConf,
        sniperScore: bSniper,
        plannedRR: bRR
      },
      marketQuality: {
        spreadPct: spreadMax
      }
    },
    mfeMaeSummary: {
      overall: mfeReport.overall,
      winners: mfeReport.winners,
      losers: mfeReport.losers,
      answers: mfeReport.answers
    },
    rejectPressure: {
      topReason: reasonTable[0] || null,
      top3: reasonTable.slice(0, 3)
    },
    recommendations
  };
}

function buildActionHints({ setupClassStats, loserProfile, winnerProfile, reasonTable, completed, avgR, winrateNum }) {
  const hints = [];

  const topReason = reasonTable[0] || null;
  const topReasonPct = parsePct(topReason?.pct);

  const a = setupClassStats.A || null;
  const b = setupClassStats.B || null;
  const god = setupClassStats.GOD || null;

  const mfeReport = buildMfeMaeReport();
  const directSLCount = mfeReport?.answers?.didLosersGoDirectToSL?.count || 0;
  const slAfterHalfRCount = mfeReport?.answers?.didLosersGoPositiveFirst?.reachedHalfR || 0;
  const slAfterNearTpCount = mfeReport?.answers?.didLosersAlmostHitTPBeforeSL?.count || 0;
  const losses = loserProfile?.losses || 0;

  if (completed < 10) {
    hints.push({
      priority: 1,
      target: "SAMPLE",
      change: "keep running until at least 10 closed trades for soft tuning; 20 for hard tuning",
      why: "sample too small for hard parameter tuning"
    });
  }

  if (losses >= 3 && directSLCount / losses >= 0.50) {
    hints.push({
      priority: 1,
      target: "DIRECT_TO_SL",
      change: "raise entry quality filters first: A sniper/confluence/RSI timing",
      why: `${directSLCount}/${losses} losers went direct to SL with low MFE`
    });
  }

  if (losses >= 3 && slAfterHalfRCount / losses >= 0.35) {
    hints.push({
      priority: 1,
      target: "GIVEBACK_AFTER_PROFIT",
      change: "add break-even after +0.5R for A/GOD",
      why: `${slAfterHalfRCount}/${losses} losers reached +0.5R before SL`
    });
  }

  if (losses >= 3 && slAfterNearTpCount / losses >= 0.25) {
    hints.push({
      priority: 1,
      target: "NEAR_TP_THEN_SL",
      change: "reduce TP multiplier or trail after 80% TP progress",
      why: `${slAfterNearTpCount}/${losses} losers nearly hit TP before SL`
    });
  }

  if (a && a.exits >= 5 && a.avgR < 0 && parsePct(a.winrate) < 50) {
    hints.push({
      priority: 2,
      target: "A_ENTRY_QUALITY",
      change: "raise A confluence +2 or A sniper +2; do not lower A RR",
      why: `A cohort negative: winrate=${a.winrate}, avgR=${a.avgR}`
    });
  }

  if (a && a.exits >= 5 && a.avgR > 0 && parsePct(a.winrate) >= 45) {
    hints.push({
      priority: 3,
      target: "A_RR",
      change: "A RR increase is acceptable only if MFE supports it",
      why: `A cohort usable: winrate=${a.winrate}, avgR=${a.avgR}, avgMfeR=${a.avgMfeR}`
    });
  }

  if (b && b.exits >= 3 && b.avgR < 0) {
    hints.push({
      priority: 2,
      target: "B_ENTRY",
      change: "raise B_MIN_SNIPER +4 or disable B temporarily",
      why: `B cohort underperforms: winrate=${b.winrate}, avgR=${b.avgR}`
    });
  }

  if (god && god.exits >= 3 && god.avgR > 0.5) {
    hints.push({
      priority: 4,
      target: "GOD_ENTRY",
      change: "keep GOD rules unchanged",
      why: `GOD cohort strong: winrate=${god.winrate}, avgR=${god.avgR}`
    });
  }

  if (avgR < 0 && winrateNum >= 50) {
    hints.push({
      priority: 2,
      target: "TP_SL_GEOMETRY",
      change: "increase TP reward-distance or reduce SL distance slightly",
      why: "winrate is acceptable but avgR is negative"
    });
  }

  if (avgR < 0 && winrateNum < 45) {
    hints.push({
      priority: 2,
      target: "ENTRY_FILTERS",
      change: "tighten RSI/OB/confluence before changing TP",
      why: "low winrate and negative avgR means bad entries dominate"
    });
  }

  if (topReason?.reason === "RSI_LONG_TOO_HIGH" && topReasonPct >= 25) {
    hints.push({
      priority: 3,
      target: "RSI_LONG_TOO_HIGH",
      change: "do not relax tradeSystem RSI; fix scanner timing or require pullback before long",
      why: `late long pressure is high: ${topReasonPct.toFixed(1)}% current rejects`
    });
  }

  if (topReason?.reason === "RSI_LONG_NO_EDGE" && topReasonPct >= 35) {
    hints.push({
      priority: 4,
      target: "RSI_TREND_CONTINUATION",
      change: "allow only elite trend continuation when confluence >= 78 and sniper >= 75",
      why: `RSI_LONG_NO_EDGE blocks many candidates: ${topReasonPct.toFixed(1)}%`
    });
  }

  if (topReason?.reason === "BTC_NEUTRAL_LOW_SCORE" && topReasonPct >= 20) {
    hints.push({
      priority: 5,
      target: "BTC_NEUTRAL_SCORE_GATE",
      change: "lower neutral BTC score gate only for setupClass A/GOD, not for all candidates",
      why: `neutral BTC gate is high-pressure: ${topReasonPct.toFixed(1)}%`
    });
  }

  if (loserProfile?.mostCommonRsiZone?.value === "MID") {
    hints.push({
      priority: 3,
      target: "MID_RSI_ENTRIES",
      change: "require confluence +3 or sniper +5 for MID RSI entries",
      why: "most losing trades cluster in MID RSI"
    });
  }

  if (loserProfile?.mostCommonObBias?.value === "NEUTRAL") {
    hints.push({
      priority: 3,
      target: "NEUTRAL_OB_ENTRIES",
      change: "raise confluence requirement for NEUTRAL OB entries",
      why: "losses cluster in neutral orderbook context"
    });
  }

  if (winnerProfile?.mostCommonRsiZone?.value && loserProfile?.mostCommonRsiZone?.value) {
    hints.push({
      priority: 6,
      target: "RSI_ZONE_COMPARISON",
      change: `compare winners=${winnerProfile.mostCommonRsiZone.value} vs losers=${loserProfile.mostCommonRsiZone.value}`,
      why: "RSI zone separation can tune winrate without reducing all trades"
    });
  }

  if (!hints.length) {
    hints.push({
      priority: 1,
      target: "NO_CHANGE",
      change: "keep running",
      why: "no strong optimization signal found"
    });
  }

  return hints.sort((a, b) => Number(a.priority || 99) - Number(b.priority || 99));
}

function buildOptimizerReport({ reasonTable, btcState, runId }) {
  const closed = auditState.closedTrades || [];
  const completed = auditState.wins + auditState.losses;

  const winrateNum = completed > 0
    ? (auditState.wins / completed) * 100
    : 0;

  const avgR = auditState.exits > 0
    ? auditState.rTotal / auditState.exits
    : 0;

  const avgPnlPct = auditState.exits > 0
    ? auditState.pnlPctTotal / auditState.exits
    : 0;

  const setupClassStats = buildSetupClassStats();
  const loserProfile = buildLoserProfile();
  const winnerProfile = buildWinnerProfile();
  const mfeMaeReport = buildMfeMaeReport();
  const recommendedValues = buildRecommendedFilterValues({ reasonTable });
  const postExitReport = buildPostExitReport();

  const performanceDiagnosis = {
    winrate: `${winrateNum.toFixed(1)}%`,
    avgR: Number(avgR.toFixed(3)),
    avgPnlPct: Number(avgPnlPct.toFixed(3)),
    ...diagnosePerformance({
      completed,
      winrateNum,
      avgR
    })
  };

  const actionHints = buildActionHints({
    setupClassStats,
    loserProfile,
    winnerProfile,
    reasonTable,
    completed,
    avgR,
    winrateNum
  });

  return {
    tag: "TS_OPTIMIZER_REPORT",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,
    ts: Date.now(),

    durableState: {
      enabled: hasRedis(),
      runtimeStoreKey: RUNTIME_STORE_KEY,
      openPositionsPersisted: memory.size,
      closedTradesPersisted: auditState.closedTrades.length,
      lastLoadedAt: runtimeState.durableLoadedAt,
      lastSavedAt: runtimeState.durableSavedAt
    },

    sampleHealth: {
      closedTrades: completed,
      exits: auditState.exits,
      minSampleOk: completed >= 20,
      softSampleOk: completed >= 10,
      confidence:
        completed >= 20
          ? "HIGH"
          : completed >= 10
            ? "MEDIUM"
            : "LOW",
      note:
        completed >= 20
          ? "enough_for_parameter_tuning"
          : completed >= 10
            ? "enough_for_soft_tuning"
            : "keep_running"
    },

    performanceDiagnosis,

    setupClassStats,

    exitDiagnosis: {
      wins: auditState.wins,
      losses: auditState.losses,
      avgWinR: winnerProfile.avgWinR,
      avgLossR: loserProfile.avgLossR,
      avgWinPnlPct: winnerProfile.avgWinPnlPct,
      avgLossPnlPct: loserProfile.avgLossPnlPct,
      avgWinnerMfeR: winnerProfile.avgMfeR,
      avgLoserMfeR: loserProfile.avgMfeR,
      avgLoserMaeR: loserProfile.avgMaeR,
      payoffGapR: Number((winnerProfile.avgWinR + loserProfile.avgLossR).toFixed(3))
    },

    mfeMaeDiagnosis: mfeMaeReport.answers,

    postExitDiagnosis: {
      tpExitQuality: postExitReport.tpExitQuality,
      slExitQuality: postExitReport.slExitQuality,
      decisions: postExitReport.decisions,
      recommendedActions: postExitReport.recommendedActions
    },

    loserProfile,
    winnerProfile,

    rejectPressure: {
      topReason: reasonTable[0] || null,
      top3: reasonTable.slice(0, 3),
      interpretation:
        reasonTable[0]?.reason === "RSI_LONG_TOO_HIGH"
          ? "scanner_sends_longs_late_after_extension"
          : reasonTable[0]?.reason === "RSI_LONG_NO_EDGE"
            ? "rsi_entry_timing_blocks_many_longs"
            : reasonTable[0]?.reason === "BTC_NEUTRAL_LOW_SCORE"
              ? "btc_neutral_gate_filters_many_mid_score_candidates"
              : "see_top_reason"
    },

    currentFilterValues: CURRENT_FILTER_VALUES,
    recommendedValues: recommendedValues.recommendations,
    actionHints,

    openPositions: buildOpenPositionRows(),

    closedTradeSample: closed.slice(-30)
  };
}

function logOptimizerReport({ reasonTable, btcState, runId }) {
  const report = buildOptimizerReport({
    reasonTable,
    btcState,
    runId
  });

  const mfeMaeReport = buildMfeMaeReport();
  const recommendedValues = buildRecommendedFilterValues({ reasonTable });
  const setupClassStats = buildSetupClassStats();
  const postExitReport = buildPostExitReport();

  console.log("TS_OPTIMIZER_REPORT", JSON.stringify(report));
  console.log("TS_OPTIMIZER_MFE_MAE", JSON.stringify(mfeMaeReport));
  console.log("TS_OPTIMIZER_POST_EXIT", JSON.stringify(postExitReport));
  console.log("TS_OPTIMIZER_RECOMMENDED_VALUES", JSON.stringify(recommendedValues));
  console.log("TS_OPTIMIZER_SETUP_CLASS", JSON.stringify(setupClassStats));
  console.log("TS_OPTIMIZER_REJECT_PRESSURE", JSON.stringify({
    tag: "TS_OPTIMIZER_REJECT_PRESSURE",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,
    top10: reasonTable.slice(0, 10),
    ts: Date.now()
  }));

  if (Array.isArray(report.actionHints) && report.actionHints.length) {
    console.log("TS_OPTIMIZER_ACTION_HINTS", JSON.stringify(report.actionHints));
  }

  return report;
}

function logTradeSystemAudit({ candidates, actions, btcState, runId }) {
  const rows = Array.isArray(actions) ? actions : [];
  const reasonTable = buildReasonTable(rows);
  const setupClassTable = buildSetupClassTable(rows);

  const actionCounts = {};

  for (const row of rows) {
    const action = String(row?.action || "UNKNOWN").toUpperCase();
    actionCounts[action] = Number(actionCounts[action] || 0) + 1;
  }

  auditState.runs++;
  auditState.lastSnapshotAt = Date.now();

  const completed = auditState.wins + auditState.losses;
  const winrate = formatWinrate(auditState.wins, completed);

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

    durableEnabled: hasRedis(),
    runtimeStoreKey: RUNTIME_STORE_KEY,

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
    closedTradeRows: auditState.closedTrades.length,

    entryReasonCounts: auditState.entryReasonCounts,
    entrySetupClassCounts: auditState.entrySetupClassCounts,
    exitReasonCounts: auditState.exitReasonCounts,

    biggestCurrentReason: reasonTable[0] || null,
    setupClassThisRun: setupClassTable,

    startedAt: auditState.startedAt,
    ts: Date.now()
  };

  console.log("TS_AUDIT_SNAPSHOT", JSON.stringify(snapshot));

  logOptimizerReport({
    reasonTable,
    btcState,
    runId
  });
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
    console.warn("NO_ACTIONS_FROM_TRADE_SYSTEM fallback WAIT generated");
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
    strategyVersion: STRATEGY_VERSION,
    durableEnabled: hasRedis()
  };
}

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockOwner = `${runId}_${Math.random().toString(36).slice(2, 8)}`;

  const durableRequired = hasRedis();
  let lockAcquired = false;

  try {
    if (durableRequired) {
      lockAcquired = await acquireRuntimeLock(lockOwner);

      if (!lockAcquired) {
        throw new Error("TRADE_SYSTEM_DURABLE_LOCK_BUSY");
      }
    }

    await loadDurableRuntimeState();
    await updatePostExitMonitors();

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
      return finalizeResult([], [], btcState, runId);
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

        updatePositionPathMetrics(pos, c.price, isBull);

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
              baseRR: pos.baseRR,
              tpRewardMultiplier: pos.tpRewardMultiplier,
              exitR: exitPayload.exitR,
              pnlPct: exitPayload.pnlPct,
              holdMinutes: exitPayload.holdMinutes,

              mfeR: exitPayload.mfeR,
              maeR: exitPayload.maeR,
              maxTpProgress: exitPayload.maxTpProgress,
              reachedHalfR: exitPayload.reachedHalfR,
              reachedOneR: exitPayload.reachedOneR,
              nearTpSeen: exitPayload.nearTpSeen,
              directToSL: exitPayload.directToSL,
              slAfterHalfR: exitPayload.slAfterHalfR,
              slAfterOneR: exitPayload.slAfterOneR,
              slAfterNearTp: exitPayload.slAfterNearTp,
              ticksObserved: exitPayload.ticksObserved,
              ticksToMae: exitPayload.ticksToMae,
              adverseTicks: exitPayload.adverseTicks,
              estimatedAdverse15mCandles: exitPayload.estimatedAdverse15mCandles,

              grade: pos.grade || "N/A",
              gradePoints: pos.gradePoints || 0,
              recommendedRisk: pos.recommendedRisk || "N/A",
              confluence: pos.confluence || 0,
              score: pos.score || pos.moveScore || c.moveScore,
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
          currentR: Number(Number(pos.currentR || 0).toFixed(3)),
          mfeR: Number(Number(pos.mfeR || 0).toFixed(3)),
          maeR: Number(Number(pos.maeR || 0).toFixed(3)),
          maxTpProgress: Number(Number(pos.maxTpProgress || 0).toFixed(3)),
          reachedHalfR: Boolean(pos.reachedHalfR),
          reachedOneR: Boolean(pos.reachedOneR),
          nearTpSeen: Boolean(pos.nearTpSeen),
          ticksObserved: Number(pos.ticksObserved || 0),
          adverseTicks: Number(pos.adverseTicks || 0),
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

      const setupClassHint = setupGrade.grade === "A" ? "A" : setupGrade.grade === "B" ? "B" : "C";

      let minRrFloorBase = getDynamicMinRrFloor({
        c,
        setupGrade,
        flow,
        sniper,
        confluence,
        counterTrend
      });

      let minRrFloor = getSniperAdjustedRR(sniper, minRrFloorBase, setupClassHint);

      if (!isBull && btcState === "BEARISH") {
        minRrFloor = Math.max(1.0, minRrFloor - 0.05);
      }

      c.minRrFloor = minRrFloor;

      const rrOverride = confluence >= 90 && sniperScore >= 86 && rr >= 1.15;

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
      const aSetupValid =
        stageOK &&
        setupGrade.grade === "A" &&
        !obData.spoof &&
        rr >= Math.max(minRrFloor, A_ENTRY_MIN_RR);

      const eliteEntry =
        aSetupValid &&
        sniper?.valid &&
        sniperScore >= 70 &&
        confluence >= 75 &&
        rr >= A_ENTRY_MIN_RR &&
        c.tfStrength >= 1;

      const bSetupValid =
        stageOK &&
        setupGrade.grade === "B" &&
        !obData.spoof &&
        rr >= B_ENTRY_MIN_RR;

      const bEntry =
        !eliteEntry &&
        bSetupValid &&
        sniper?.valid &&
        sniperScore >= 62 &&
        confluence >= 68 &&
        rr >= B_ENTRY_MIN_RR &&
        c.tfStrength >= 1;

      const godModeEntry =
        eliteEntry &&
        sniperScore >= 85 &&
        confluence >= 85 &&
        rr >= GOD_ENTRY_MIN_RR;

      const shouldEnter = eliteEntry || bEntry;

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

      if (!shouldEnter) {
        actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      // ================= DIRECT ENTRY =================
      const tpRewardMultiplier = getTpRewardMultiplier({
        setupClass,
        certaintyMode,
        sniperScore,
        rsi,
        isBull
      });

      const finalTp = buildAdjustedTp(
        c.price,
        riskBase.tp,
        tpRewardMultiplier,
        isBull
      );

      const finalRr = calculateRRFromPrices(
        c.price,
        riskBase.sl,
        finalTp,
        isBull
      ) || rr;

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
        rr: finalRr,
        baseRR: rr,
        tpRewardMultiplier,

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

        rsi,
        rsiHTF: rsiSignal.mean1h || null,
        rsiZone,

        obBias: obData.bias || "UNKNOWN",
        spreadPct: Number(obData.spreadPct || 0),
        depthMinUsd1p: Number(obData.depthMinUsd1p || 0),

        flow: flow.type,
        funding: Number(funding?.rate || 0),

        createdAt: Date.now(),

        regime: regimeLevel,
        btcState
      };

      initializePositionPathMetrics(position);

      const entryPayload = {
        ...buildCommonPayload(c, flow, sniper, funding, obData),
        action: "ENTRY",
        reason: reasonEntry,
        setupClass,
        grade: position.grade,
        gradePoints: position.gradePoints,
        recommendedRisk: position.recommendedRisk,
        confluence,
        rr: formatRR(finalRr),
        baseRR: formatRR(rr),
        tpRewardMultiplier,
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
  } finally {
    await saveDurableRuntimeState();

    if (lockAcquired) {
      await releaseRuntimeLock(lockOwner);
    }
  }
}