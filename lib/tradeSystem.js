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
// Reset bewust: clean execution audit. TP/SL sluiten op geplande level; trigger-price apart gelogd.
const STRATEGY_VERSION = "TS_V11_4_BULLISH_MID_TREND_PROBE";

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

const MAX_SPREAD_PCT = 0.00175;
const MID_BULL_MAX_SPREAD_PCT = 0.00110;      // aangescherpt
const MIN_DEPTH_USD_1P = 200000;

const MIN_RR_FLOOR = 1.0;

const GRADE_A_MIN_RR_FLOOR = 1.10;
const GRADE_B_MIN_RR_FLOOR = 1.05;
const GRADE_C_MIN_RR_FLOOR = 1.10;

const A_ENTRY_MIN_RR = 1.20;                 // verlaagd
const B_ENTRY_MIN_RR = 1.20;
const GOD_ENTRY_MIN_RR = 1.45;

const A_MIN_SNIPER = 59;                     // verlaagd
const A_MIN_CONFLUENCE = 66;                 // verlaagd
const B_MIN_SNIPER = 72;
const B_MIN_CONFLUENCE = 75;

const GOD_MIN_SNIPER = 85;
const GOD_MIN_CONFLUENCE = 85;

const MID_RSI_MIN_CONFLUENCE = 66;           // verlaagd
const TREND_CONTINUATION_MIN_CONFLUENCE = 65;
const TREND_CONTINUATION_MIN_SNIPER = 55;

const A_FINAL_MIN_RR = 1.35;
const A_GOD_MAX_TP_REWARD_MULTIPLIER = 1.30;

const ENABLE_B_ENTRIES = true;

// ================= BULLISH MID TREND PROBE =================
// Controlled real-data probe. Alleen voor bull MID trend-continuation in bullish BTC.
const ENABLE_BULLISH_MID_TREND_PROBES = true;

const BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE = 62;
const BULLISH_MID_TREND_PROBE_MIN_SNIPER = 45;
const BULLISH_MID_TREND_PROBE_MIN_RR = 1.20;             // verlaagd
const BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT = 0.00110;  // aangescherpt
const BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P = 100_000;

const BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH = true;

const BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT = 0.08;
const BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT = 0.80;
const BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT = 0.0010;

// ================= V11_3 FINAL DEPTH / ANTI-CHASE / BTC-BEAR EXCEPTION =================
// Hard final gates. MIN_DEPTH_USD_1P blijft bestaan voor bestaande scoring/quality logic.
const MIN_DEPTH_USD_1P_ABSOLUTE = 25_000;
const A_MIN_DEPTH_USD_1P = 50_000;
const BULL_TREND_MIN_DEPTH_USD_1P = 100_000;

const REQUIRE_BULL_TREND_PULLBACK = true;
const MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT = 0.012;

const ENABLE_BTC_BULLISH_BEAR_EXCEPTION = true;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P = 100_000;
const BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT = 0.0008;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_RR = 1.25;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF = 50;
const BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF = 72;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER = TREND_CONTINUATION_MIN_SNIPER;

// A-only tuning: shorts in oversold RSI-zones zijn te laat in de move.
// KNC / DOOD / OPEN zaten exact in dit profiel.
const SHORT_BLOCKED_RSI_ZONES = ["LOWER_2", "LOWER_3"];

const BREAK_EVEN_TRIGGER_R = 0.50;
const BREAK_EVEN_LOCK_R = 0.05;

const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.20;

// Performance tuning tijdens live-test: lagere limieten voor audit arrays
const MAX_CLOSED_TRADE_AUDIT_ROWS = 300;
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

// Legacy monolith key. Alleen nog voor migratie-load.
const RUNTIME_STORE_KEY = `tradeSystem:runtime:${STRATEGY_VERSION}`;

const RUNTIME_CORE_KEY = `tradeSystem:runtime-core:${STRATEGY_VERSION}`;
const RUNTIME_RECENT_KEY = `tradeSystem:runtime-recent:${STRATEGY_VERSION}`;

const RUNTIME_CLOSED_META_KEY = `tradeSystem:runtime-closed-meta:${STRATEGY_VERSION}`;
const RUNTIME_CLOSED_CHUNK_PREFIX = `tradeSystem:runtime-closed:${STRATEGY_VERSION}:`;

const RUNTIME_FEATURE_META_KEY = `tradeSystem:runtime-features-meta:${STRATEGY_VERSION}`;
const RUNTIME_FEATURE_CHUNK_PREFIX = `tradeSystem:runtime-features:${STRATEGY_VERSION}:`;

const RUNTIME_SHADOW_META_KEY = `tradeSystem:runtime-shadow-meta:${STRATEGY_VERSION}`;
const RUNTIME_SHADOW_CHUNK_PREFIX = `tradeSystem:runtime-shadow:${STRATEGY_VERSION}:`;

const RUNTIME_LOCK_KEY = `tradeSystem:runtime-lock:${STRATEGY_VERSION}`;

const DURABLE_MAX_CHUNK_BYTES = 650_000;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  fetchFailed: true
};

// ================= FEATURE STORE CONSTANTS =================
// Verlaagde limieten tijdens live-test
const MAX_FEATURE_STORE_ROWS = 5000;
const MAX_SHADOW_OUTCOME_ROWS = 2500;

const SHADOW_MONITOR_MS = 4 * 60 * 60 * 1000;
const SHADOW_MAX_MONITOR_PER_RUN = 24;

const SHADOW_DIRECTIONAL_WIN_PCT = 0.60;
const SHADOW_DIRECTIONAL_LOSS_PCT = -0.40;

const BEST_SETUP_MIN_SAMPLE_LOW = 5;
const BEST_SETUP_MIN_SAMPLE_MEDIUM = 12;
const BEST_SETUP_MIN_SAMPLE_HIGH = 30;

const BEST_SETUP_MIN_WINRATE = 0.60;
const BEST_SETUP_MIN_AVG_R = 0.20;

const BAD_SETUP_MAX_WINRATE = 0.42;
const BAD_SETUP_MAX_AVG_R = -0.15;

// ================= FINAL FILTER DECISION CONSTANTS =================
// Alleen logging/advice. Deze waarden passen live filters niet automatisch aan.
const FINAL_DECISION_MIN_COMPLETED = 12;
const FINAL_DECISION_TARGET_COMPLETED = 60;
const FINAL_DECISION_TOP_N = 12;

// ================= FULL FILTER OPTIMIZER (MASTER SIMULATOR) =================
// Eén master-log met volledige historische simulatie. Beam-search voorkomt explosieve Cartesian grid.
const FILTER_OPTIMIZER_MIN_COMPLETED = 12;
const FILTER_OPTIMIZER_TARGET_COMPLETED = 80;
const FILTER_OPTIMIZER_BEAM_WIDTH = 32;
const FILTER_OPTIMIZER_BEAM_PASSES = 2;

// MASTER SIMULATOR GUARDRAILS (tegen overfit)
const MASTER_MIN_COMPLETED_PASS_ROWS = 30;
const MASTER_MIN_KEEP_RATIO = 0.015;
const MASTER_MAX_KEEP_RATIO = 0.35;
const MASTER_MIN_TOTAL_R = 3;
const MASTER_MIN_AVG_R = 0.08;
const MASTER_MIN_PROFIT_FACTOR_R = 1.15;
const MASTER_MAX_DIRECT_SL_PCT = 0.35;

// Hardcoded live filters expliciet maken
const CANDIDATE_MIN_SCORE = 50;

const BTC_BEARISH_LONG_MIN_SCORE = 75;
const BTC_NEUTRAL_MIN_SCORE = 65;

const EARLY_RSI_MIN_SNIPER = 75;
const TREND_CONTINUATION_MIN_RR = 1.00;

const SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE = 78;
const SHORT_LOWER1_CONTINUATION_MIN_SNIPER = 75;
const SHORT_LOWER1_CONTINUATION_MIN_RR = 1.25;
const SHORT_LOWER1_ALLOWED_BTC_STATES = ["BEARISH", "STRONG_BEAR", "NEUTRAL"];

const LONG_LOWER2_MAX_1H_CHANGE = -0.05;
const SHORT_UPPER2_MIN_1H_CHANGE = 0.20;

const STRONG_MOMENTUM_MIN_1H_MOVE_PCT = 0.25;
const STRONG_MOMENTUM_MIN_24H_MOVE_PCT = 2.00;
const SOFT_MOMENTUM_MIN_1H_MOVE_PCT = 0.15;
const SOFT_MOMENTUM_MIN_24H_MOVE_PCT = 1.50;
const ELITE_MOMENTUM_MIN_CONFLUENCE = 78;
const ELITE_MOMENTUM_MIN_1H_MOVE_PCT = 0.10;

const LOW_VOL_MIN_CONFLUENCE = 60;
const NO_FLOW_MIN_CONFLUENCE = 68;
const TF_MIN_STRENGTH = 1;
const GLOBAL_MIN_CONFLUENCE = 62;

const OB_AGAINST_MIN_CONFLUENCE = 78;
const BAD_MARKET_QUALITY_MIN_CONFLUENCE = 75;
const OB_NEUTRAL_MIN_CONFLUENCE = 55;

const MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE = 82;
const MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER = 75;

const EXTREME_FUNDING_ABS_MAX = 0.015;
const BULL_CROWDED_FUNDING_MAX = 0.012;
const BEAR_CROWDED_FUNDING_MIN = -0.012;
const CROWDED_FUNDING_MIN_CONFLUENCE = 85;

const SETUP_GRADE_A_MIN_POINTS = 9;
const SETUP_GRADE_B_MIN_POINTS = 7;

const NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE = 80;
const NEUTRAL_OB_A_EXCEPTION_MIN_RR = 1.30;
const NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER = 75;

const NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE = 84;
const NEUTRAL_OB_B_EXCEPTION_MIN_RR = 1.15;
const NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER = 80;
const NEUTRAL_OB_B_EXCEPTION_MIN_SCORE = 82;

// Shadow deduplication
const SHADOW_DUPLICATE_COOLDOWN_MS = 30 * 60 * 1000;

const CURRENT_FILTER_VALUES = Object.freeze({
  STRATEGY_VERSION,
  MAX_SPREAD_PCT,
  MID_BULL_MAX_SPREAD_PCT,
  MIN_DEPTH_USD_1P,
  MIN_DEPTH_USD_1P_ABSOLUTE,
  A_MIN_DEPTH_USD_1P,
  BULL_TREND_MIN_DEPTH_USD_1P,

  REQUIRE_BULL_TREND_PULLBACK,
  MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT,

  ENABLE_BTC_BULLISH_BEAR_EXCEPTION,
  BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P,
  BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT,
  BTC_BULLISH_BEAR_EXCEPTION_MIN_RR,
  BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF,
  BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF,
  BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER,

  MIN_RR_FLOOR,
  GRADE_A_MIN_RR_FLOOR,
  GRADE_B_MIN_RR_FLOOR,
  GRADE_C_MIN_RR_FLOOR,
  A_ENTRY_MIN_RR,
  B_ENTRY_MIN_RR,
  GOD_ENTRY_MIN_RR,
  A_FINAL_MIN_RR,
  A_GOD_MAX_TP_REWARD_MULTIPLIER,
  ENABLE_B_ENTRIES,
  SHORT_BLOCKED_RSI_ZONES,
  BREAK_EVEN_TRIGGER_R,
  BREAK_EVEN_LOCK_R,
  COUNTERTREND_MIN_RR_FLOOR,
  BUILDUP_MIN_RR_FLOOR,
  A_MIN_SNIPER,
  A_MIN_CONFLUENCE,
  B_MIN_SNIPER,
  B_MIN_CONFLUENCE,
  B_MIN_EFFECTIVE_RR: B_ENTRY_MIN_RR,
  GOD_MIN_SNIPER,
  GOD_MIN_CONFLUENCE,
  MID_RSI_MIN_CONFLUENCE,
  TREND_CONTINUATION_MIN_CONFLUENCE,
  TREND_CONTINUATION_MIN_SNIPER,
  MAX_FEATURE_STORE_ROWS,
  MAX_SHADOW_OUTCOME_ROWS,
  SHADOW_MONITOR_MS,
  SHADOW_DIRECTIONAL_WIN_PCT,
  SHADOW_DIRECTIONAL_LOSS_PCT,
  BEST_SETUP_MIN_WINRATE,
  BEST_SETUP_MIN_AVG_R,
  FINAL_DECISION_MIN_COMPLETED,
  FINAL_DECISION_TARGET_COMPLETED,
  FINAL_DECISION_TOP_N,

  // BULLISH MID TREND PROBE
  ENABLE_BULLISH_MID_TREND_PROBES,
  BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE,
  BULLISH_MID_TREND_PROBE_MIN_SNIPER,
  BULLISH_MID_TREND_PROBE_MIN_RR,
  BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT,
  BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P,
  BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH,
  BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT,
  BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT,
  BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT,
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
    rule: "long needs LOWER/early/trend-continuation; short needs UPPER/early/trend-continuation. Short LOWER zones blocked during A-only tuning.",
    blockReason: "RSI_LONG_NO_EDGE / RSI_SHORT_NO_EDGE / RSI_SHORT_TOO_LOW_A_ONLY"
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
    rule: "rr must meet dynamic floor and final adjusted RR must be strong for A/GOD",
    blockReason: "LOW_RR / LOW_FINAL_RR"
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
    rule: "block OB-against, bad spread/depth, and wide MID-bull spread unless confluence is high",
    blockReason: "OB_AGAINST / BAD_MARKET_QUALITY / MID_BULL_SPREAD_TOO_WIDE"
  },
  {
    phase: "QUALITY",
    filter: "FUNDING",
    rule: "block crowded/extreme funding unless confluence is high",
    blockReason: "EXTREME_FUNDING / BULL_CROWDED_FUNDING / BEAR_CROWDED_FUNDING"
  },
  {
    phase: "QUALITY",
    filter: "FINAL DEPTH HARD GATE",
    rule: "hard block missing/garbage depth, thin A/GOD books, and bull trend entries below final depth floor",
    blockReason: "DEPTH_MISSING_FINAL / DEPTH_TOO_LOW_ABSOLUTE / A_DEPTH_TOO_LOW_FINAL / BULL_TREND_DEPTH_TOO_LOW"
  },
  {
    phase: "QUALITY",
    filter: "BULL ANTI-CHASE",
    rule: "bull trend MID RSI entries in bullish BTC need pullback/sweep/retest confirmation",
    blockReason: "BULL_RSI_EXTENSION_BLOCK / BULL_TREND_NO_PULLBACK / BULL_TREND_PROBE_NO_SOFT_PULLBACK / BULL_TOO_FAR_FROM_PULLBACK_ZONE"
  },
  {
    phase: "ENTRY",
    filter: "BTC-BULLISH BEAR EXCEPTION",
    rule: "bear entries during BTC bullish states only allowed through controlled high-liquidity exception",
    blockReason: "BTC_BULLISH_WEAK_SHORT / BTC_BULLISH_BEAR_EXCEPTION"
  },
  {
    phase: "ENTRY",
    filter: "A/GOD/B+ ONLY",
    rule: "GOD, A, strict B+, BTC bullish bear exception, or controlled B_TREND_PROBE. No C_ENTRY. No scaling.",
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

    // Full feature-store: elke coin/action/setupprofiel.
    featureStore: [],

    // Shadow outcomes voor WAIT/blokkades: wat zou er gebeurd zijn.
    shadowOutcomes: [],

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

// ================= DURABLE KV / UPSTASH (CHUNKED) =================
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

  const text = await res.text();

  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json?.error) {
    console.error("REDIS_COMMAND_ERROR:", JSON.stringify({
      status: res.status,
      statusText: res.statusText,
      command: Array.isArray(command) ? command[0] : "UNKNOWN",
      key: Array.isArray(command) ? command[1] : null,
      responseText: text?.slice(0, 1000),
      json
    }));

    throw new Error(json?.error || text?.slice(0, 500) || `redis_error_${res.status}`);
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

  if (!Array.isArray(auditState.featureStore)) {
    auditState.featureStore = [];
  }

  if (!Array.isArray(auditState.shadowOutcomes)) {
    auditState.shadowOutcomes = [];
  }

  if (auditState.recentEntries.length > MAX_RECENT_ENTRY_AUDIT_ROWS) {
    auditState.recentEntries = auditState.recentEntries.slice(-MAX_RECENT_ENTRY_AUDIT_ROWS);
  }

  if (auditState.closedTrades.length > MAX_CLOSED_TRADE_AUDIT_ROWS) {
    auditState.closedTrades = auditState.closedTrades.slice(-MAX_CLOSED_TRADE_AUDIT_ROWS);
  }

  if (auditState.featureStore.length > MAX_FEATURE_STORE_ROWS) {
    auditState.featureStore = auditState.featureStore.slice(-MAX_FEATURE_STORE_ROWS);
  }

  if (auditState.shadowOutcomes.length > MAX_SHADOW_OUTCOME_ROWS) {
    auditState.shadowOutcomes = auditState.shadowOutcomes.slice(-MAX_SHADOW_OUTCOME_ROWS);
  }
}

// ----- Chunking helpers -----
function jsonByteLength(value) {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value);

  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(text, "utf8");
  }

  return text.length;
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function redisSetJson(key, payload) {
  const serialized = JSON.stringify(payload);
  const bytes = jsonByteLength(serialized);

  await redisCommand(["SET", key, serialized]);

  return bytes;
}

async function redisGetJson(key) {
  const result = await redisCommand(["GET", key]);
  return safeJsonParse(result);
}

function compactPositionForStore(pos) {
  if (!pos || typeof pos !== "object") return pos;

  return {
    ...pos,
    pricePathSample: Array.isArray(pos.pricePathSample)
      ? pos.pricePathSample.slice(-20)
      : []
  };
}

function compactClosedTradeForStore(trade) {
  if (!trade || typeof trade !== "object") return trade;

  const postExitMonitor = trade.postExitMonitor
    ? {
        ...trade.postExitMonitor,
        path: Array.isArray(trade.postExitMonitor.path)
          ? trade.postExitMonitor.path.slice(-20)
          : []
      }
    : trade.postExitMonitor;

  return {
    ...trade,
    pricePathSample: Array.isArray(trade.pricePathSample)
      ? trade.pricePathSample.slice(-8)
      : [],
    postExitMonitor
  };
}

function buildRuntimeCorePayload() {
  trimAuditArrays();

  return {
    strategyVersion: STRATEGY_VERSION,
    updatedAt: Date.now(),

    memory: Array.from(memory.entries()).map(([key, pos]) => [
      key,
      compactPositionForStore(pos)
    ]),

    notifyState: Array.from(notifyState.entries()),
    cooldownMap: Array.from(cooldownMap.entries()),
    symbolCooldownMap: Array.from(symbolCooldownMap.entries()),
    lastSignalMap: Array.from(lastSignalMap.entries()),

    auditCounters: {
      strategyVersion: STRATEGY_VERSION,
      startedAt: auditState.startedAt,
      runs: auditState.runs,

      entries: auditState.entries,
      exits: auditState.exits,
      wins: auditState.wins,
      losses: auditState.losses,

      rTotal: auditState.rTotal,
      pnlPctTotal: auditState.pnlPctTotal,

      entryReasonCounts: auditState.entryReasonCounts || {},
      entrySetupClassCounts: auditState.entrySetupClassCounts || {},
      exitReasonCounts: auditState.exitReasonCounts || {},

      lastSnapshotAt: auditState.lastSnapshotAt
    }
  };
}

function buildJsonArrayChunks(rows, maxBytes = DURABLE_MAX_CHUNK_BYTES) {
  const arr = Array.isArray(rows) ? rows : [];
  const chunks = [];

  let current = [];
  let currentBytes = 2;

  for (const row of arr) {
    const rowJson = JSON.stringify(row);
    const rowBytes = jsonByteLength(rowJson) + 1;

    if (current.length && currentBytes + rowBytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }

    current.push(row);
    currentBytes += rowBytes;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

async function writeJsonArrayChunks({
  metaKey,
  chunkPrefix,
  rows,
  previousChunkCount = 0
}) {
  const chunks = buildJsonArrayChunks(rows);
  const bytesByChunk = [];

  for (let i = 0; i < chunks.length; i++) {
    const bytes = await redisSetJson(`${chunkPrefix}${i}`, chunks[i]);
    bytesByChunk.push(bytes);
  }

  for (let i = chunks.length; i < previousChunkCount; i++) {
    await redisCommand(["DEL", `${chunkPrefix}${i}`]).catch(e => {
      console.warn("DURABLE_OLD_CHUNK_DELETE_FAILED:", e.message);
    });
  }

  const bytesTotal = bytesByChunk.reduce((sum, n) => sum + n, 0);

  await redisSetJson(metaKey, {
    strategyVersion: STRATEGY_VERSION,
    updatedAt: Date.now(),
    chunks: chunks.length,
    rows: Array.isArray(rows) ? rows.length : 0,
    bytesTotal,
    bytesByChunk
  });

  return {
    chunks: chunks.length,
    rows: Array.isArray(rows) ? rows.length : 0,
    bytesTotal
  };
}

async function readJsonArrayChunks(metaKey, chunkPrefix) {
  const meta = await redisGetJson(metaKey);

  if (!meta || meta.strategyVersion !== STRATEGY_VERSION) {
    return [];
  }

  const chunkCount = Number(meta.chunks || 0);

  if (!chunkCount) {
    return [];
  }

  const reads = [];

  for (let i = 0; i < chunkCount; i++) {
    reads.push(
      redisGetJson(`${chunkPrefix}${i}`).catch(e => {
        console.warn("DURABLE_CHUNK_LOAD_FAILED:", JSON.stringify({
          metaKey,
          index: i,
          error: e.message
        }));

        return [];
      })
    );
  }

  const chunks = await Promise.all(reads);

  return chunks
    .filter(Array.isArray)
    .flat();
}

// Legacy hydrate (monolith) voor migratie
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
  if (!Array.isArray(auditState.featureStore)) auditState.featureStore = [];
  if (!Array.isArray(auditState.shadowOutcomes)) auditState.shadowOutcomes = [];

  auditState.entryReasonCounts = auditState.entryReasonCounts || {};
  auditState.entrySetupClassCounts = auditState.entrySetupClassCounts || {};
  auditState.exitReasonCounts = auditState.exitReasonCounts || {};

  trimAuditArrays();

  runtimeState.durableLoadedAt = Date.now();

  console.log("TRADE SYSTEM DURABLE LOAD LEGACY:", JSON.stringify({
    strategyVersion: STRATEGY_VERSION,
    openPositions: memory.size,
    entries: auditState.entries,
    exits: auditState.exits,
    wins: auditState.wins,
    losses: auditState.losses,
    closedTrades: auditState.closedTrades.length,
    featureRows: auditState.featureStore.length,
    shadowRows: auditState.shadowOutcomes.length
  }));

  return true;
}

function hydrateSplitRuntimeState({
  core,
  recentEntries,
  closedTrades,
  featureStore,
  shadowOutcomes
}) {
  if (!core || core.strategyVersion !== STRATEGY_VERSION) {
    return false;
  }

  replaceMapContents(memory, core.memory);
  replaceMapContents(notifyState, core.notifyState);
  replaceMapContents(cooldownMap, core.cooldownMap);
  replaceMapContents(symbolCooldownMap, core.symbolCooldownMap);
  replaceMapContents(lastSignalMap, core.lastSignalMap);

  const freshAudit = createAuditState();

  for (const key of Object.keys(auditState)) {
    delete auditState[key];
  }

  Object.assign(auditState, freshAudit, core.auditCounters || {}, {
    strategyVersion: STRATEGY_VERSION,
    recentEntries: Array.isArray(recentEntries) ? recentEntries : [],
    closedTrades: Array.isArray(closedTrades) ? closedTrades : [],
    featureStore: Array.isArray(featureStore) ? featureStore : [],
    shadowOutcomes: Array.isArray(shadowOutcomes) ? shadowOutcomes : []
  });

  auditState.entryReasonCounts = auditState.entryReasonCounts || {};
  auditState.entrySetupClassCounts = auditState.entrySetupClassCounts || {};
  auditState.exitReasonCounts = auditState.exitReasonCounts || {};

  trimAuditArrays();

  runtimeState.durableLoadedAt = Date.now();

  console.log("TRADE SYSTEM DURABLE LOAD SPLIT:", JSON.stringify({
    strategyVersion: STRATEGY_VERSION,
    openPositions: memory.size,
    entries: auditState.entries,
    exits: auditState.exits,
    wins: auditState.wins,
    losses: auditState.losses,
    recentEntries: auditState.recentEntries.length,
    closedTrades: auditState.closedTrades.length,
    featureRows: auditState.featureStore.length,
    shadowRows: auditState.shadowOutcomes.length
  }));

  return true;
}

async function loadDurableRuntimeState() {
  if (!hasRedis()) {
    console.warn("TRADE SYSTEM DURABLE STORE DISABLED: Redis env missing");
    return false;
  }

  try {
    const core = await redisGetJson(RUNTIME_CORE_KEY);

    if (core?.strategyVersion === STRATEGY_VERSION) {
      const [
        recentEntries,
        closedTrades,
        featureStore,
        shadowOutcomes
      ] = await Promise.all([
        redisGetJson(RUNTIME_RECENT_KEY).then(v => Array.isArray(v) ? v : []).catch(() => []),
        readJsonArrayChunks(RUNTIME_CLOSED_META_KEY, RUNTIME_CLOSED_CHUNK_PREFIX),
        readJsonArrayChunks(RUNTIME_FEATURE_META_KEY, RUNTIME_FEATURE_CHUNK_PREFIX),
        readJsonArrayChunks(RUNTIME_SHADOW_META_KEY, RUNTIME_SHADOW_CHUNK_PREFIX)
      ]);

      return hydrateSplitRuntimeState({
        core,
        recentEntries,
        closedTrades,
        featureStore,
        shadowOutcomes
      });
    }

    const legacyPayload = await redisGetJson(RUNTIME_STORE_KEY);

    if (!legacyPayload) {
      console.log("TRADE SYSTEM DURABLE LOAD: empty state");
      return false;
    }

    return hydrateRuntimeState(legacyPayload);
  } catch (e) {
    console.error("TRADE SYSTEM DURABLE LOAD ERROR:", e.message);
    return false;
  }
}

async function saveDurableRuntimeState() {
  if (!hasRedis()) return false;

  try {
    trimAuditArrays();

    const [
      previousClosedMeta,
      previousFeatureMeta,
      previousShadowMeta
    ] = await Promise.all([
      redisGetJson(RUNTIME_CLOSED_META_KEY).catch(() => null),
      redisGetJson(RUNTIME_FEATURE_META_KEY).catch(() => null),
      redisGetJson(RUNTIME_SHADOW_META_KEY).catch(() => null)
    ]);

    const corePayload = buildRuntimeCorePayload();

    const recentEntries = Array.isArray(auditState.recentEntries)
      ? auditState.recentEntries
      : [];

    const closedTrades = Array.isArray(auditState.closedTrades)
      ? auditState.closedTrades.map(compactClosedTradeForStore)
      : [];

    const featureStore = Array.isArray(auditState.featureStore)
      ? auditState.featureStore
      : [];

    const shadowOutcomes = Array.isArray(auditState.shadowOutcomes)
      ? auditState.shadowOutcomes
      : [];

    const coreBytes = await redisSetJson(RUNTIME_CORE_KEY, corePayload);
    const recentBytes = await redisSetJson(RUNTIME_RECENT_KEY, recentEntries);

    const closedInfo = await writeJsonArrayChunks({
      metaKey: RUNTIME_CLOSED_META_KEY,
      chunkPrefix: RUNTIME_CLOSED_CHUNK_PREFIX,
      rows: closedTrades,
      previousChunkCount: Number(previousClosedMeta?.chunks || 0)
    });

    const featureInfo = await writeJsonArrayChunks({
      metaKey: RUNTIME_FEATURE_META_KEY,
      chunkPrefix: RUNTIME_FEATURE_CHUNK_PREFIX,
      rows: featureStore,
      previousChunkCount: Number(previousFeatureMeta?.chunks || 0)
    });

    const shadowInfo = await writeJsonArrayChunks({
      metaKey: RUNTIME_SHADOW_META_KEY,
      chunkPrefix: RUNTIME_SHADOW_CHUNK_PREFIX,
      rows: shadowOutcomes,
      previousChunkCount: Number(previousShadowMeta?.chunks || 0)
    });

    runtimeState.durableSavedAt = Date.now();

    console.log("TRADE SYSTEM DURABLE SAVE SPLIT:", JSON.stringify({
      strategyVersion: STRATEGY_VERSION,
      openPositions: memory.size,
      entries: auditState.entries,
      exits: auditState.exits,
      wins: auditState.wins,
      losses: auditState.losses,

      rows: {
        recentEntries: recentEntries.length,
        closedTrades: closedTrades.length,
        featureStore: featureStore.length,
        shadowOutcomes: shadowOutcomes.length
      },

      chunks: {
        closed: closedInfo.chunks,
        featureStore: featureInfo.chunks,
        shadowOutcomes: shadowInfo.chunks
      },

      bytes: {
        core: coreBytes,
        recent: recentBytes,
        closed: closedInfo.bytesTotal,
        featureStore: featureInfo.bytesTotal,
        shadowOutcomes: shadowInfo.bytesTotal,
        total:
          coreBytes +
          recentBytes +
          closedInfo.bytesTotal +
          featureInfo.bytesTotal +
          shadowInfo.bytesTotal
      }
    }));

    return true;
  } catch (e) {
    console.error("TRADE SYSTEM DURABLE SAVE ERROR FULL:", {
      message: e.message,
      stack: e.stack
    });

    return false;
  }
}

// ================= SHADOW DEDUPLICATION =================
function getShadowDedupeKey(row) {
  return [
    normalizeBaseSymbol(row.symbol),
    String(row.side || "").toLowerCase(),
    String(row.reason || "UNKNOWN").toUpperCase(),
    String(row.rsiZone || "UNKNOWN").toUpperCase(),
    String(row.confBucket || "CONF_NA"),
    String(row.rrBucket || "RR_NA")
  ].join("|");
}

function hasRecentShadowOutcome(row) {
  const key = getShadowDedupeKey(row);
  const since = Date.now() - SHADOW_DUPLICATE_COOLDOWN_MS;

  return (auditState.shadowOutcomes || []).some(existing => {
    const existingKey = existing.shadowDedupeKey || getShadowDedupeKey(existing);

    return (
      existingKey === key &&
      Number(existing.createdAt || existing.ts || 0) >= since &&
      String(existing.status || "OPEN").toUpperCase() === "OPEN"
    );
  });
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

function isBtcBullishState(btcState) {
  return ["BULLISH", "STRONG_BULL"].includes(String(btcState || "").toUpperCase());
}

function getRecentRangeFromCandles(candles, lookback = 20) {
  const rows = Array.isArray(candles)
    ? candles.slice(-lookback).filter(row =>
        Number.isFinite(Number(row?.high)) &&
        Number.isFinite(Number(row?.low))
      )
    : [];

  if (!rows.length) {
    return {
      recentHigh: 0,
      recentLow: 0,
      rangePct: 0
    };
  }

  const recentHigh = Math.max(...rows.map(row => Number(row.high)));
  const recentLow = Math.min(...rows.map(row => Number(row.low)));

  const rangePct = recentHigh > 0
    ? Math.max(0, (recentHigh - recentLow) / recentHigh)
    : 0;

  return {
    recentHigh,
    recentLow,
    rangePct
  };
}

function getBullPullbackMeta({ c, candles15m, fakeBreakoutConfirmed }) {
  const price = Number(c?.price || 0);
  const { recentHigh, recentLow, rangePct } = getRecentRangeFromCandles(candles15m, 20);

  if (!price || !recentHigh || !recentLow) {
    return {
      recentHigh,
      recentLow,
      rangePct,
      distanceFromLocalHighPct: 0,
      distanceFromLocalLowPct: 0,
      pullbackConfirmed: false,
      sweepConfirmed: Boolean(fakeBreakoutConfirmed),
      retestConfirmed: false
    };
  }

  const distanceFromLocalHighPct = Math.max(0, (recentHigh - price) / recentHigh);
  const distanceFromLocalLowPct = Math.max(0, (price - recentLow) / recentLow);

  const pullbackConfirmed =
    distanceFromLocalHighPct >= 0.003 &&
    distanceFromLocalHighPct <= MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT &&
    price > recentLow;

  const retestConfirmed =
    distanceFromLocalLowPct >= 0 &&
    distanceFromLocalLowPct <= 0.010;

  return {
    recentHigh,
    recentLow,
    rangePct: Number(rangePct.toFixed(5)),
    distanceFromLocalHighPct: Number(distanceFromLocalHighPct.toFixed(5)),
    distanceFromLocalLowPct: Number(distanceFromLocalLowPct.toFixed(5)),
    pullbackConfirmed,
    sweepConfirmed: Boolean(fakeBreakoutConfirmed),
    retestConfirmed
  };
}

function validateFinalDepth(candidate) {
  const depth = Number(candidate.depthMinUsd1p ?? 0);
  const side = String(candidate.side || "").toLowerCase();
  const flow = String(candidate.flow || "").toUpperCase();
  const setupClass = String(candidate.setupClass || "").toUpperCase();

  if (depth <= 0) {
    return { ok: false, reason: "DEPTH_MISSING_FINAL" };
  }

  if (depth < MIN_DEPTH_USD_1P_ABSOLUTE) {
    return { ok: false, reason: "DEPTH_TOO_LOW_ABSOLUTE" };
  }

  if (side === "bull" && flow === "TREND" && depth < BULL_TREND_MIN_DEPTH_USD_1P) {
    return { ok: false, reason: "BULL_TREND_DEPTH_TOO_LOW" };
  }

  if (["A", "GOD"].includes(setupClass) && depth < A_MIN_DEPTH_USD_1P) {
    return { ok: false, reason: "A_DEPTH_TOO_LOW_FINAL" };
  }

  return { ok: true };
}

function validateBullAntiChase(candidate) {
  const side = String(candidate.side || "").toLowerCase();

  if (side !== "bull") return { ok: true };

  const rsiZone = String(candidate.rsiZone || "").toUpperCase();

  if (["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) {
    return { ok: false, reason: "BULL_RSI_EXTENSION_BLOCK" };
  }

  if (!REQUIRE_BULL_TREND_PULLBACK) {
    return { ok: true };
  }

  const isBullMarket = isBtcBullishState(candidate.btcState);
  const isTrendLong = String(candidate.flow || "").toUpperCase() === "TREND";
  const isMidRsi = rsiZone === "MID";

  if (!isBullMarket || !isTrendLong || !isMidRsi) {
    return { ok: true };
  }

  const distanceFromLocalHighPct = Number(candidate.distanceFromLocalHighPct ?? 0);
  const isProbe = Boolean(candidate.bullishMidTrendProbeOk);

  const regularPullback =
    candidate.pullbackConfirmed === true ||
    candidate.sweepConfirmed === true ||
    candidate.retestConfirmed === true ||
    candidate.fakeBreakoutConfirmed === true;

  const probeSoftPullback =
    isProbe &&
    distanceFromLocalHighPct >= BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT &&
    distanceFromLocalHighPct <= MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT;

  const hasPullback = regularPullback || probeSoftPullback;

  if (!hasPullback) {
    return {
      ok: false,
      reason: isProbe
        ? "BULL_TREND_PROBE_NO_SOFT_PULLBACK"
        : "BULL_TREND_NO_PULLBACK"
    };
  }

  if (distanceFromLocalHighPct > MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT) {
    return { ok: false, reason: "BULL_TOO_FAR_FROM_PULLBACK_ZONE" };
  }

  return { ok: true };
}

function validateBtcBullishShortException(candidate) {
  const side = String(candidate.side || "").toLowerCase();

  if (side !== "bear") {
    return { ok: true, exception: false, reason: "NOT_BEAR_EXCEPTION" };
  }

  const btcBullish = isBtcBullishState(candidate.btcState);

  if (!btcBullish) {
    return { ok: true, exception: false, reason: "BTC_NOT_BULLISH" };
  }

  if (!ENABLE_BTC_BULLISH_BEAR_EXCEPTION) {
    return { ok: false, exception: false, reason: "BTC_BULLISH_WEAK_SHORT" };
  }

  const rsiZone = String(candidate.rsiZone || "").toUpperCase();
  const flow = String(candidate.flow || "").toUpperCase();
  const obBias = String(candidate.obBias || "NEUTRAL").toUpperCase();
  const stage = String(candidate.stage || "").toLowerCase();

  const checks = {
    validStage: ["entry", "almost"].includes(stage),
    validRsi: ["MID", "LOWER_1", "LOWER_2"].includes(rsiZone),
    validFlow: ["TREND", "BUILDING"].includes(flow),
    validOb: ["NEUTRAL", "BEARISH"].includes(obBias),
    tightSpread: normalizeSpread(candidate.spreadPct) <= BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT,
    goodDepth: Number(candidate.depthMinUsd1p || 0) >= BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P,
    validConf:
      Number(candidate.confluence || 0) >= BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF &&
      Number(candidate.confluence || 0) <= BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF,
    validRR: Number(candidate.plannedRR || 0) >= BTC_BULLISH_BEAR_EXCEPTION_MIN_RR,
    validSniper: Number(candidate.sniperScore || 0) >= BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER
  };

  const passed = Object.values(checks).every(Boolean);

  if (!passed) {
    return {
      ok: false,
      exception: false,
      reason: "BTC_BULLISH_WEAK_SHORT",
      checks
    };
  }

  return {
    ok: true,
    exception: true,
    reason: "BTC_BULLISH_BEAR_EXCEPTION_OK",
    checks
  };
}

function validateBullishMidTrendProbe(candidate) {
  const side = String(candidate.side || "").toLowerCase();
  const stage = String(candidate.stage || "").toLowerCase();
  const rsiZone = String(candidate.rsiZone || "").toUpperCase();
  const flow = String(candidate.flow || "").toUpperCase();
  const obBias = String(candidate.obBias || "UNKNOWN").toUpperCase();

  const confluence = Number(candidate.confluence || 0);
  const sniperScore = Number(candidate.sniperScore || 0);
  const plannedRR = Number(candidate.plannedRR || 0);
  const spread = normalizeSpread(candidate.spreadPct);
  const depth = Number(candidate.depthMinUsd1p || 0);

  const checks = {
    enabled: ENABLE_BULLISH_MID_TREND_PROBES,
    validSide: side === "bull",
    validStage: ["entry", "almost"].includes(stage),
    validBtc:
      !BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH ||
      isBtcBullishState(candidate.btcState),
    validRsi: rsiZone === "MID",
    validFlow: flow === "TREND",
    validConfluence: confluence >= BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE,
    validSniper: sniperScore >= BULLISH_MID_TREND_PROBE_MIN_SNIPER,
    validRR: plannedRR >= BULLISH_MID_TREND_PROBE_MIN_RR,
    tightSpread: spread <= BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT,
    goodDepth: depth >= BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P,

    // OB against mag alleen als confluence niet zwak is.
    validOb:
      obBias !== "BEARISH" ||
      confluence >= BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE + 3
  };

  const ok = Object.values(checks).every(Boolean);

  return {
    ok,
    reason: ok ? "BULLISH_MID_TREND_PROBE_OK" : "BULLISH_MID_TREND_PROBE_BLOCKED",
    checks
  };
}

function isBullishMidTrendProbeRow(row) {
  return (
    row?.setupClass === "B_TREND_PROBE" ||
    row?.entryReason === "BULLISH_MID_TREND_PROBE" ||
    Boolean(row?.bullishMidTrendProbe)
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
  if (a === "ENTRY" && setupClass === "A_SHORT_EXCEPTION") return 5600;
  if (a === "ENTRY" && setupClass === "B") return 5000;
  if (a === "ENTRY" && setupClass === "B_TREND_PROBE") return 4800;
  if (a === "ENTRY") return 4500;
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
    pullbackConfirmed: c._debugPullbackConfirmed ?? null,
    sweepConfirmed: c._debugSweepConfirmed ?? null,
    retestConfirmed: c._debugRetestConfirmed ?? null,
    distanceFromLocalHighPct: c._debugDistanceFromLocalHighPct ?? null,

    btcBullishBearException: Boolean(c._debugBtcBullishBearException),
    btcBullishBearExceptionReason: c._debugBtcBullishBearExceptionReason || null,
    btcBullishBearExceptionChecks: c._debugBtcBullishBearExceptionChecks || null,

    bullishMidTrendProbe: Boolean(c._debugBullishMidTrendProbe),
    bullishMidTrendProbeReason: c._debugBullishMidTrendProbeReason || null,
    bullishMidTrendProbeChecks: c._debugBullishMidTrendProbeChecks || null,

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

  if ((reason === "LOW_RR" || reason === "LOW_FINAL_RR") && requiredRR !== null && rr !== null) {
    payload.reasonScore = Number(rr) - Number(requiredRR);

    // ===== CATI DEBUG: extra velden voor LOW_RR / LOW_FINAL_RR =====
    payload.plannedRR = Number(rr || 0);
    payload.requiredRR = Number(requiredRR || 0);
    payload.effectiveRR = Number(rr || 0);
    payload.baseRR = Number(rr || 0);
    payload.entry = Number(c?.price || 0);
    payload.sl = Number(risk?.sl || 0);
    payload.tp = Number(risk?.tp || 0);
    payload.confluence = Number(confluence || 0);
    payload.sniperScore = Number(sniper?.score || 0);
    payload.rsiZone = c?._debugRsiZone || "UNKNOWN";
    payload.spreadPct = Number(ob?.spreadPct || 0);
    payload.depthMinUsd1p = Number(ob?.depthMinUsd1p || 0);
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

// ================= FETCH CANDLES (SORTED) =================
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

      return json.data
        .map(c => ({
          openTime: Number(c[0]),
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5] || 0)
        }))
        .filter(c =>
          Number.isFinite(c.openTime) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
        .sort((a, b) => a.openTime - b.openTime);
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

    if (score < CANDIDATE_MIN_SCORE) {
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

  // console.log("TS_PREFILTER", JSON.stringify({ // UITGESCHAKELD
  //   ...prefilterStats,
  //   finalCandidates: candidates.length
  // }));

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

function getInitialRiskSl(pos) {
  return Number(pos?.initialSl || pos?.originalSl || pos?.sl || 0);
}

function calculateExitR(pos, exitPrice, isBull) {
  const entry = Number(pos?.entry || 0);
  const sl = getInitialRiskSl(pos);
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

  if (setupClass === "A" || setupClass === "GOD") {
    return clamp(multiplier, 1.20, A_GOD_MAX_TP_REWARD_MULTIPLIER);
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

  if (points >= SETUP_GRADE_A_MIN_POINTS) {
    grade = "A";
    recommendedRisk = "normal";
  } else if (points >= SETUP_GRADE_B_MIN_POINTS) {
    grade = "B";
    recommendedRisk = "small";
  }

  if (grade === "A" && confluence < A_MIN_CONFLUENCE) {
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
    confluence >= NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE &&
    rr >= NEUTRAL_OB_A_EXCEPTION_MIN_RR &&
    sniper?.valid &&
    sniperScore >= NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER
  ) {
    return true;
  }

  if (
    setupGrade.grade === "B" &&
    confluence >= NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE &&
    rr >= NEUTRAL_OB_B_EXCEPTION_MIN_RR &&
    sniper?.valid &&
    sniperScore >= NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER &&
    Number(c.moveScore || 0) >= NEUTRAL_OB_B_EXCEPTION_MIN_SCORE
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
  const sl = getInitialRiskSl(position);
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

function applyBreakEvenRule(position, isBull) {
  if (!position) return position;

  const setupClass = String(position.setupClass || "").toUpperCase();

  if (setupClass !== "A" && setupClass !== "GOD") {
    return position;
  }

  if (position.breakEvenActivated) {
    return position;
  }

  const entry = Number(position.entry || 0);
  const initialSl = getInitialRiskSl(position);
  const currentSl = Number(position.sl || 0);
  const currentR = Number(position.currentR || 0);

  if (!entry || !initialSl || !currentSl) {
    return position;
  }

  if (currentR < BREAK_EVEN_TRIGGER_R) {
    return position;
  }

  const riskDist = Math.abs(entry - initialSl);

  if (!riskDist) {
    return position;
  }

  const breakEvenSl = isBull
    ? entry + riskDist * BREAK_EVEN_LOCK_R
    : entry - riskDist * BREAK_EVEN_LOCK_R;

  const shouldMove = isBull
    ? breakEvenSl > currentSl
    : breakEvenSl < currentSl;

  if (!shouldMove) {
    return position;
  }

  position.breakEvenActivated = true;
  position.breakEvenAt = Date.now();
  position.breakEvenTriggerR = BREAK_EVEN_TRIGGER_R;
  position.breakEvenLockR = BREAK_EVEN_LOCK_R;
  position.breakEvenSl = Number(breakEvenSl);
  position.slBeforeBreakEven = currentSl;
  position.sl = Number(breakEvenSl);

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

    breakEvenActivated: Boolean(pos?.breakEvenActivated),
    breakEvenStop: exitReason === "BE_SL",
    breakEvenSl: pos?.breakEvenSl ?? null,
    slBeforeBreakEven: pos?.slBeforeBreakEven ?? null,

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
  const sl = Number(trade?.initialSl || trade?.sl || 0);
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

  if (exitReason === "SL" || exitReason === "BE_SL") {
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
  const slTrades = monitored.filter(t => ["SL", "BE_SL"].includes(String(t.exitReason || "").toUpperCase()));

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
      triggerR: t.triggerR,
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
      slProtected: t.postExitMonitor?.slProtected,
      breakEvenActivated: Boolean(t.breakEvenActivated),
      breakEvenStop: Boolean(t.breakEvenStop)
    }))
  };
}

// ================= FEATURE STORE / SHADOW OPTIMIZER =================
function pctText(value) {
  const n = Number(value || 0);
  return `${(n * 100).toFixed(1)}%`;
}

function cleanBucketText(value) {
  return String(value)
    .replace(/\./g, "p")
    .replace(/-/g, "m")
    .replace(/\s+/g, "_")
    .toUpperCase();
}

function bucketByStep(value, step, label, decimals = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return `${label}_NA`;

  const lower = Math.floor(n / step) * step;
  const upper = lower + step;

  return cleanBucketText(`${label}_${lower.toFixed(decimals)}_${upper.toFixed(decimals)}`);
}

function bucketDepthUsd(depth) {
  const d = Number(depth || 0);

  if (d < 10000) return "DEPTH_LT_10K";
  if (d < 50000) return "DEPTH_10K_50K";
  if (d < 100000) return "DEPTH_50K_100K";
  if (d < 200000) return "DEPTH_100K_200K";
  if (d < 500000) return "DEPTH_200K_500K";

  return "DEPTH_GT_500K";
}

function bucketSpreadPct(spreadPct) {
  const bps = normalizeSpread(spreadPct) * 10000;

  if (bps < 8) return "SPREAD_LT_8BPS";
  if (bps < 12) return "SPREAD_8_12BPS";
  if (bps < 16) return "SPREAD_12_16BPS";
  if (bps < 22) return "SPREAD_16_22BPS";
  if (bps < 30) return "SPREAD_22_30BPS";

  return "SPREAD_GT_30BPS";
}

function bucketFunding(rate) {
  const r = Number(rate || 0);

  if (r <= -0.015) return "FUNDING_NEG_EXTREME";
  if (r <= -0.008) return "FUNDING_NEG_HIGH";
  if (r < -0.002) return "FUNDING_NEG";
  if (r <= 0.002) return "FUNDING_NEUTRAL";
  if (r < 0.008) return "FUNDING_POS";
  if (r < 0.015) return "FUNDING_POS_HIGH";

  return "FUNDING_POS_EXTREME";
}

function getObSideRelation(side, obBias) {
  const s = String(side || "").toLowerCase();
  const ob = String(obBias || "NEUTRAL").toUpperCase();

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "NEUTRAL";

  if (
    (s === "bull" && ob === "BULLISH") ||
    (s === "bear" && ob === "BEARISH")
  ) {
    return "WITH";
  }

  if (
    (s === "bull" && ob === "BEARISH") ||
    (s === "bear" && ob === "BULLISH")
  ) {
    return "AGAINST";
  }

  return "NEUTRAL";
}

function enrichFeatureBuckets(row) {
  const enriched = {
    ...row
  };

  enriched.confBucket = bucketByStep(enriched.confluence, 5, "CONF", 0);
  enriched.sniperBucket = bucketByStep(enriched.sniperScore, 5, "SNIPER", 0);
  enriched.scoreBucket = bucketByStep(enriched.score, 5, "SCORE", 0);
  enriched.rrBucket = bucketByStep(enriched.plannedRR, 0.25, "RR", 2);
  enriched.finalRrBucket = bucketByStep(enriched.finalRr, 0.25, "FINAL_RR", 2);
  enriched.tfBucket = bucketByStep(enriched.tfStrength, 0.5, "TF", 1);
  enriched.rsiValueBucket = bucketByStep(enriched.rsi, 5, "RSI", 0);

  enriched.spreadBucket = bucketSpreadPct(enriched.spreadPct);
  enriched.depthBucket = bucketDepthUsd(enriched.depthMinUsd1p);
  enriched.fundingBucket = bucketFunding(enriched.funding);

  enriched.obSideRelation = getObSideRelation(enriched.side, enriched.obBias);

  enriched.isMidRsi = enriched.rsiZone === "MID";
  enriched.isLowerRsi = String(enriched.rsiZone || "").startsWith("LOWER");
  enriched.isUpperRsi = String(enriched.rsiZone || "").startsWith("UPPER");

  enriched.isBull = enriched.side === "bull";
  enriched.isBear = enriched.side === "bear";

  enriched.isObWithSide = enriched.obSideRelation === "WITH";
  enriched.isObAgainstSide = enriched.obSideRelation === "AGAINST";
  enriched.isObNeutral = enriched.obSideRelation === "NEUTRAL";

  enriched.isBadSpread = normalizeSpread(enriched.spreadPct) > MAX_SPREAD_PCT;
  enriched.isBadDepth = Number(enriched.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;

  enriched.isCounterBtc =
    (enriched.btcState === "BULLISH" && enriched.side === "bear") ||
    (enriched.btcState === "BEARISH" && enriched.side === "bull") ||
    (enriched.btcState === "STRONG_BULL" && enriched.side === "bear") ||
    (enriched.btcState === "STRONG_BEAR" && enriched.side === "bull");

  return enriched;
}

function buildFeatureRowFromAction(action, btcState, runId) {
  const entry = Number(action.entry ?? action.price ?? 0);
  const sl = Number(action.sl || 0);
  const tp = Number(action.tp || 0);
  const side = String(action.side || "").toLowerCase();

  const hasRiskGeometry =
    entry > 0 &&
    sl > 0 &&
    tp > 0 &&
    Math.abs(entry - sl) > 0;

  const plannedRR = Number(action.rr || 0);
  const finalRr = Number(action.finalRr || action.rr || 0);

  const row = {
    id: `feat_${runId}_${action.symbol}_${side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    ts: Number(action.ts || Date.now()),

    source: "ACTION",
    action: String(action.action || "UNKNOWN").toUpperCase(),
    reason: String(action.reason || "UNKNOWN").toUpperCase(),

    symbol: normalizeBaseSymbol(action.symbol),
    side,

    setupClass: String(action.setupClass || "NONE").toUpperCase(),
    grade: action.grade || "N/A",
    gradePoints: Number(action.gradePoints || 0),

    entryReason: String(action.reason || "UNKNOWN").toUpperCase(),

    stage: String(action.stage || "unknown").toLowerCase(),
    scannerStage: String(action.scannerStage || action.stage || "unknown").toLowerCase(),
    stageSource: action.stageSource || "unknown",

    score: Number(action.score || 0),
    confluence: Number(action.confluence || 0),
    sniper: action.sniper || "NONE",
    sniperScore: Number(action.sniperScore || 0),

    flow: String(action.flow || "UNKNOWN").toUpperCase(),
    btcState: String(action.btcState || btcState || "UNKNOWN").toUpperCase(),
    regime: String(action.regime || "UNKNOWN").toUpperCase(),

    rsi: Number(action.rsi || 0),
    rsiHTF: Number(action.rsiHTF || 0),
    rsiZone: String(action.rsiZone || "UNKNOWN").toUpperCase(),

    obBias: String(action.obBias || "UNKNOWN").toUpperCase(),
    spreadPct: Number(action.spreadPct || 0),
    depthMinUsd1p: Number(action.depthMinUsd1p || 0),

    funding: Number(action.funding || 0),

    tfScore: Number(action.tfScore || 0),
    tfStrength: Number(action.tfStrength || 0),
    tfAlignment: String(action.tfAlignment || "UNKNOWN").toUpperCase(),

    minRrRequired: Number(action.minRrRequired || 0),
    plannedRR,
    finalRr,

    entry,
    sl,
    tp,
    hasRiskGeometry,

    fakeBreakout: Boolean(action.fakeBreakout),
    pullbackConfirmed: Boolean(action.pullbackConfirmed),
    sweepConfirmed: Boolean(action.sweepConfirmed),
    retestConfirmed: Boolean(action.retestConfirmed),
    distanceFromLocalHighPct: Number(action.distanceFromLocalHighPct || 0),

    btcBullishBearException: Boolean(action.btcBullishBearException),
    btcBullishBearExceptionReason: action.btcBullishBearExceptionReason || null,

    bullishMidTrendProbe: Boolean(action.bullishMidTrendProbe),
    bullishMidTrendProbeReason: action.bullishMidTrendProbeReason || null,

    fromOpenPosition: Boolean(action.fromOpenPosition),
    analysisType: action.analysisType || "DEEP",

    strategyVersion: STRATEGY_VERSION
  };

  return enrichFeatureBuckets(row);
}

// ================= SHADOW ELIGIBILITY (tightened) =================
function isShadowEligible(row) {
  if (!row) return false;
  if (row.action !== "WAIT") return false;
  if (row.fromOpenPosition) return false;
  if (!row.symbol || !row.side) return false;
  if (!row.hasRiskGeometry) return false;

  return (
    Number(row.entry || 0) > 0 &&
    Number(row.sl || 0) > 0 &&
    Number(row.tp || 0) > 0
  );
}

function createShadowOutcome(row) {
  return {
    ...row,

    id: `shadow_${row.runId}_${row.symbol}_${row.side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    shadowDedupeKey: getShadowDedupeKey(row),

    source: "SHADOW",
    status: "OPEN",

    createdAt: Date.now(),
    monitorUntil: Date.now() + SHADOW_MONITOR_MS,
    lastCheckedAt: 0,

    ticks: 0,

    exit: null,
    exitR: null,
    pnlPct: null,

    win: false,
    loss: false,
    flat: false,

    mfeR: 0,
    maeR: 0,
    maxPnlPct: 0,
    minPnlPct: 0,

    maxPrice: Number(row.entry || 0),
    minPrice: Number(row.entry || 0),

    hitTP: false,
    hitSL: false,

    completedAt: null
  };
}

function calculateShadowR(row, price) {
  if (!row?.hasRiskGeometry) return null;

  const entry = Number(row.entry || 0);
  const sl = Number(row.sl || 0);
  const current = Number(price || 0);

  if (!entry || !sl || !current) return null;

  const riskDist = Math.abs(entry - sl);
  if (!riskDist) return null;

  const move = row.side === "bull"
    ? current - entry
    : entry - current;

  const r = move / riskDist;

  return Number.isFinite(r) ? r : null;
}

function calculateShadowPnlPct(row, price) {
  const entry = Number(row.entry || 0);
  const current = Number(price || 0);

  if (!entry || !current) return 0;

  const pnl = row.side === "bull"
    ? ((current - entry) / entry) * 100
    : ((entry - current) / entry) * 100;

  return Number.isFinite(pnl) ? pnl : 0;
}

function completeShadowOutcome(row, status, price, r, pnlPct) {
  row.status = status;
  row.exit = Number(price || 0);
  row.exitR = Number.isFinite(Number(r)) ? Number(Number(r).toFixed(3)) : null;
  row.pnlPct = Number(Number(pnlPct || 0).toFixed(3));

  row.win =
    Number.isFinite(Number(row.exitR))
      ? Number(row.exitR) > 0
      : Number(row.pnlPct) >= SHADOW_DIRECTIONAL_WIN_PCT;

  row.loss =
    Number.isFinite(Number(row.exitR))
      ? Number(row.exitR) < 0
      : Number(row.pnlPct) <= SHADOW_DIRECTIONAL_LOSS_PCT;

  row.flat = !row.win && !row.loss;
  row.completedAt = Date.now();

  return row;
}

function updateShadowOutcomeWithPrice(row, price) {
  if (!row || row.status !== "OPEN") return row;

  const now = Date.now();
  const currentPrice = Number(price || 0);

  if (!currentPrice) return row;

  const currentR = calculateShadowR(row, currentPrice);
  const pnlPct = calculateShadowPnlPct(row, currentPrice);

  row.ticks++;
  row.lastCheckedAt = now;

  row.maxPrice = Math.max(Number(row.maxPrice || currentPrice), currentPrice);
  row.minPrice = Math.min(Number(row.minPrice || currentPrice), currentPrice);

  row.maxPnlPct = Math.max(Number(row.maxPnlPct || 0), pnlPct);
  row.minPnlPct = Math.min(Number(row.minPnlPct || 0), pnlPct);

  if (Number.isFinite(Number(currentR))) {
    row.mfeR = Math.max(Number(row.mfeR || 0), currentR);
    row.maeR = Math.min(Number(row.maeR || 0), currentR);
  }

  if (row.hasRiskGeometry) {
    const hitTP = row.side === "bull"
      ? currentPrice >= Number(row.tp || 0)
      : currentPrice <= Number(row.tp || 0);

    const hitSL = row.side === "bull"
      ? currentPrice <= Number(row.sl || 0)
      : currentPrice >= Number(row.sl || 0);

    if (hitTP) {
      row.hitTP = true;
      return completeShadowOutcome(row, "HIT_TP", currentPrice, currentR, pnlPct);
    }

    if (hitSL) {
      row.hitSL = true;
      return completeShadowOutcome(row, "HIT_SL", currentPrice, currentR, pnlPct);
    }
  }

  if (now >= Number(row.monitorUntil || 0)) {
    return completeShadowOutcome(row, "HORIZON_DONE", currentPrice, currentR, pnlPct);
  }

  return row;
}

async function updateShadowFeatureOutcomes() {
  if (!Array.isArray(auditState.shadowOutcomes) || !auditState.shadowOutcomes.length) {
    return;
  }

  const now = Date.now();

  const active = auditState.shadowOutcomes
    .filter(row => row?.status === "OPEN")
    .filter(row => now <= Number(row.monitorUntil || 0))
    .slice(-MAX_SHADOW_OUTCOME_ROWS)
    .slice(0, SHADOW_MAX_MONITOR_PER_RUN);

  for (const row of active) {
    const price = await fetchPostExitPrice(row);
    if (!price) continue;

    updateShadowOutcomeWithPrice(row, price);
  }

  for (const row of auditState.shadowOutcomes) {
    if (row?.status !== "OPEN") continue;

    if (now > Number(row.monitorUntil || 0)) {
      const price = await fetchPostExitPrice(row);
      const fallbackPrice = Number(price || row.entry || 0);

      if (!fallbackPrice) continue;

      const currentR = calculateShadowR(row, fallbackPrice);
      const pnlPct = calculateShadowPnlPct(row, fallbackPrice);

      completeShadowOutcome(row, "HORIZON_DONE", fallbackPrice, currentR, pnlPct);
    }
  }

  trimAuditArrays();
}

function recordActionFeatureRows(actions, btcState, runId) {
  if (!Array.isArray(actions) || !actions.length) return;

  if (!Array.isArray(auditState.featureStore)) {
    auditState.featureStore = [];
  }

  if (!Array.isArray(auditState.shadowOutcomes)) {
    auditState.shadowOutcomes = [];
  }

  for (const action of actions) {
    if (!action?.symbol || !action?.side) continue;

    const actionType = String(action.action || "").toUpperCase();

    if (actionType === "HOLD") continue;

    const row = buildFeatureRowFromAction(action, btcState, runId);

    auditState.featureStore.push(row);

    if (isShadowEligible(row) && !hasRecentShadowOutcome(row)) {
      auditState.shadowOutcomes.push(createShadowOutcome(row));
    }
  }

  trimAuditArrays();
}

function buildOutcomeRowFromClosedTrade(t) {
  const row = {
    id: `real_${t.symbol}_${t.side}_${t.createdAt || 0}_${t.exitedAt || 0}`,
    source: "REAL",
    status: "CLOSED",

    symbol: normalizeBaseSymbol(t.symbol),
    side: String(t.side || "").toLowerCase(),

    action: "ENTRY",
    reason: String(t.entryReason || "UNKNOWN").toUpperCase(),
    entryReason: String(t.entryReason || "UNKNOWN").toUpperCase(),

    setupClass: String(t.setupClass || "UNKNOWN").toUpperCase(),
    grade: t.grade || "N/A",
    gradePoints: Number(t.gradePoints || 0),

    score: Number(t.score || 0),
    confluence: Number(t.confluence || 0),
    sniper: t.sniper || "NONE",
    sniperScore: Number(t.sniperScore || 0),

    flow: String(t.flow || "UNKNOWN").toUpperCase(),
    btcState: String(t.btcState || "UNKNOWN").toUpperCase(),
    regime: String(t.regime || "UNKNOWN").toUpperCase(),

    rsi: Number(t.rsi || 0),
    rsiHTF: Number(t.rsiHTF || 0),
    rsiZone: String(t.rsiZone || "UNKNOWN").toUpperCase(),

    obBias: String(t.obBias || "UNKNOWN").toUpperCase(),
    spreadPct: Number(t.spreadPct || 0),
    depthMinUsd1p: Number(t.depthMinUsd1p || 0),

    funding: Number(t.funding || 0),

    tfScore: Number(t.tfScore || 0),
    tfStrength: Number(t.tfStrength || 0),
    tfAlignment: String(t.tfAlignment || "UNKNOWN").toUpperCase(),

    plannedRR: Number(t.plannedRR || 0),
    finalRr: Number(t.plannedRR || 0),

    entry: Number(t.entry || 0),
    sl: Number(t.initialSl || t.sl || 0),
    tp: Number(t.tp || 0),
    exit: Number(t.exit || 0),

    hasRiskGeometry: true,

    exitReason: String(t.exitReason || "UNKNOWN").toUpperCase(),
    exitR: Number(t.exitR || 0),
    pnlPct: Number(t.pnlPct || 0),

    win: Number(t.exitR || 0) > 0,
    loss: Number(t.exitR || 0) < 0,
    flat: Number(t.exitR || 0) === 0,

    mfeR: Number(t.mfeR || 0),
    maeR: Number(t.maeR || 0),

    directToSL: Boolean(t.directToSL),
    reachedHalfR: Boolean(t.reachedHalfR),
    reachedOneR: Boolean(t.reachedOneR),
    nearTpSeen: Boolean(t.nearTpSeen),
    breakEvenStop: Boolean(t.breakEvenStop),

    holdMinutes: Number(t.holdMinutes || 0),
    createdAt: Number(t.createdAt || 0),
    completedAt: Number(t.exitedAt || 0),

    bullishMidTrendProbe: Boolean(t.bullishMidTrendProbe),
    bullishMidTrendProbeReason: t.bullishMidTrendProbeReason || null,

    btcBullishBearException: Boolean(t.btcBullishBearException),
    btcBullishBearExceptionReason: t.btcBullishBearExceptionReason || null,

    strategyVersion: t.strategyVersion || STRATEGY_VERSION
  };

  return enrichFeatureBuckets(row);
}

function buildOutcomeRowFromShadow(row) {
  if (!row || row.status === "OPEN") return null;

  const outcome = {
    ...row,
    source: String(row.source || "SHADOW").toUpperCase(),
    originSource: String(row.source || "SHADOW").toUpperCase(),
    status: row.status,

    action: "WAIT",
    exitReason: row.status,

    exitR: Number.isFinite(Number(row.exitR)) ? Number(row.exitR) : null,
    pnlPct: Number(row.pnlPct || 0),

    win: Boolean(row.win),
    loss: Boolean(row.loss),
    flat: Boolean(row.flat),

    directToSL: row.status === "HIT_SL" && Number(row.mfeR || 0) < DIRECT_SL_MFE_LIMIT_R,
    reachedHalfR: Number(row.mfeR || 0) >= HALF_R_LEVEL,
    reachedOneR: Number(row.mfeR || 0) >= ONE_R_LEVEL,
    nearTpSeen: row.hasRiskGeometry && Number(row.mfeR || 0) >= Number(row.plannedRR || 0) * NEAR_TP_PROGRESS,

    holdMinutes: row.completedAt
      ? Number(((Number(row.completedAt) - Number(row.createdAt || row.ts || 0)) / 60000).toFixed(1))
      : null
  };

  return enrichFeatureBuckets(outcome);
}

function buildFeatureOutcomeRows() {
  const real = (auditState.closedTrades || [])
    .map(buildOutcomeRowFromClosedTrade)
    .filter(Boolean);

  const shadow = (auditState.shadowOutcomes || [])
    .map(buildOutcomeRowFromShadow)
    .filter(Boolean);

  return {
    real,
    shadow,
    all: [...real, ...shadow]
  };
}

function getProfitFactorR(rows) {
  const rRows = rows
    .map(row => Number(row.exitR))
    .filter(Number.isFinite);

  const grossWin = rRows
    .filter(r => r > 0)
    .reduce((sum, r) => sum + r, 0);

  const grossLoss = Math.abs(
    rRows
      .filter(r => r < 0)
      .reduce((sum, r) => sum + r, 0)
  );

  if (!grossLoss) {
    return grossWin > 0 ? 999 : 0;
  }

  return grossWin / grossLoss;
}

function getOutcomeStats(rows) {
  const arr = Array.isArray(rows) ? rows : [];

  const wins = arr.filter(row => Boolean(row.win)).length;
  const losses = arr.filter(row => Boolean(row.loss)).length;
  const completed = wins + losses;

  const exitRRows = arr
    .map(row => Number(row.exitR))
    .filter(Number.isFinite);

  const pnlRows = arr
    .map(row => Number(row.pnlPct))
    .filter(Number.isFinite);

  const directSL = arr.filter(row => Boolean(row.directToSL)).length;
  const nearTp = arr.filter(row => Boolean(row.nearTpSeen)).length;

  const avgR = safeAvg(exitRRows);
  const totalR = safeSum(exitRRows);

  const avgPnlPct = safeAvg(pnlRows);
  const totalPnlPct = safeSum(pnlRows);

  const winrateNum = completed ? wins / completed : 0;
  const profitFactorR = getProfitFactorR(arr);

  return {
    sample: arr.length,
    completed,
    wins,
    losses,

    winrate: pctText(winrateNum),
    winrateNum: Number(winrateNum.toFixed(4)),

    totalR: Number(totalR.toFixed(3)),
    avgR: Number(avgR.toFixed(3)),

    totalPnlPct: Number(totalPnlPct.toFixed(3)),
    avgPnlPct: Number(avgPnlPct.toFixed(3)),

    avgWinR: Number(safeAvg(exitRRows.filter(r => r > 0)).toFixed(3)),
    avgLossR: Number(safeAvg(exitRRows.filter(r => r < 0)).toFixed(3)),

    profitFactorR: Number(profitFactorR.toFixed(3)),
    expectancyR: Number(avgR.toFixed(3)),

    avgMfeR: Number(safeAvg(arr.map(row => Number(row.mfeR || 0))).toFixed(3)),
    avgMaeR: Number(safeAvg(arr.map(row => Number(row.maeR || 0))).toFixed(3)),

    directSL,
    directSLPct: arr.length ? pctText(directSL / arr.length) : "0.0%",

    nearTp,
    nearTpPct: arr.length ? pctText(nearTp / arr.length) : "0.0%"
  };
}

function scoreOutcomeStats(stats) {
  const winrate = Number(stats.winrateNum || 0);
  const avgR = Number(stats.avgR || 0);
  const avgPnlPct = Number(stats.avgPnlPct || 0);
  const pfNorm = clamp(Number(stats.profitFactorR || 0), 0, 5) / 5;
  const sampleConfidence = clamp(Number(stats.sample || 0) / BEST_SETUP_MIN_SAMPLE_HIGH, 0, 1);
  const directSLPct = parsePct(stats.directSLPct) / 100;

  const score =
    avgR * 45 +
    winrate * 25 +
    pfNorm * 15 +
    sampleConfidence * 10 +
    avgPnlPct * 2 -
    directSLPct * 15;

  return Number(score.toFixed(3));
}

function getFeatureCohortKeys(row) {
  const setup = row.setupClass || "NONE";
  const reason = row.entryReason || row.reason || "UNKNOWN";
  const side = row.side || "unknown";
  const rsiZone = row.rsiZone || "UNKNOWN";
  const btc = row.btcState || "UNKNOWN";
  const flow = row.flow || "UNKNOWN";
  const regime = row.regime || "UNKNOWN";
  const ob = row.obBias || "UNKNOWN";
  const obRel = row.obSideRelation || "UNKNOWN";

  const keys = [
    `SETUP=${setup}|SIDE=${side}|RSI=${rsiZone}|OB_REL=${obRel}|BTC=${btc}`,
    `REASON=${reason}|SIDE=${side}|RSI=${rsiZone}|BTC=${btc}`,
    `CONF=${row.confBucket}|SNIPER=${row.sniperBucket}|RR=${row.rrBucket}|RSI=${rsiZone}`,
    `SIDE=${side}|FLOW=${flow}|RSI=${rsiZone}|CONF=${row.confBucket}`,
    `OB=${ob}|OB_REL=${obRel}|SPREAD=${row.spreadBucket}|DEPTH=${row.depthBucket}|SIDE=${side}`,
    `TF=${row.tfBucket}|REGIME=${regime}|FLOW=${flow}|SIDE=${side}`,
    `FUNDING=${row.fundingBucket}|SIDE=${side}|BTC=${btc}`,
    `SCORE=${row.scoreBucket}|CONF=${row.confBucket}|SNIPER=${row.sniperBucket}`
  ];

  return Array.from(new Set(keys));
}

function buildFeatureCohorts(rows, minSample = BEST_SETUP_MIN_SAMPLE_LOW) {
  const map = new Map();

  for (const row of rows) {
    const keys = getFeatureCohortKeys(row);

    for (const key of keys) {
      if (!map.has(key)) {
        map.set(key, []);
      }

      map.get(key).push(row);
    }
  }

  return Array.from(map.entries())
    .map(([cohortKey, cohortRows]) => {
      const stats = getOutcomeStats(cohortRows);

      return {
        cohortKey,
        ...stats,
        score: scoreOutcomeStats(stats),
        examples: cohortRows
          .slice(-8)
          .map(row => `${row.source}_${row.symbol}_${row.side}_${row.reason || row.entryReason}_${row.exitR ?? row.pnlPct}`)
      };
    })
    .filter(row => Number(row.sample || 0) >= minSample)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function evaluateNumericMinOutcomeThreshold(rows, field, currentValue) {
  const usable = rows
    .filter(row => Number.isFinite(Number(row?.[field])))
    .filter(row => Number(row?.[field]) > 0);

  if (usable.length < 5) {
    return {
      field,
      currentValue,
      suggestedValue: currentValue,
      confidence: "LOW",
      reason: "not_enough_rows"
    };
  }

  const values = Array.from(
    new Set(
      usable
        .map(row => Number(Number(row[field]).toFixed(4)))
        .sort((a, b) => a - b)
    )
  );

  const minKept = Math.max(4, Math.ceil(usable.length * 0.25));

  let best = null;

  for (const threshold of values) {
    const kept = usable.filter(row => Number(row[field]) >= threshold);
    if (kept.length < minKept) continue;

    const stats = getOutcomeStats(kept);
    const keepRatio = kept.length / usable.length;
    const score = scoreOutcomeStats(stats) + keepRatio * 5;

    const candidate = {
      threshold,
      kept: kept.length,
      keepRatio: Number(keepRatio.toFixed(3)),
      ...stats,
      score: Number(score.toFixed(3))
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
    suggestedValue: Number(best.threshold.toFixed(4)),
    confidence:
      usable.length >= 60
        ? "HIGH"
        : usable.length >= 25
          ? "MEDIUM"
          : "LOW",
    best
  };
}

function evaluateNumericMaxOutcomeThreshold(rows, field, currentValue) {
  const usable = rows
    .filter(row => Number.isFinite(Number(row?.[field])))
    .filter(row => Number(row?.[field]) > 0);

  if (usable.length < 5) {
    return {
      field,
      currentValue,
      suggestedValue: currentValue,
      confidence: "LOW",
      reason: "not_enough_rows"
    };
  }

  const values = Array.from(
    new Set(
      usable
        .map(row => Number(Number(row[field]).toFixed(6)))
        .sort((a, b) => a - b)
    )
  );

  const minKept = Math.max(4, Math.ceil(usable.length * 0.25));

  let best = null;

  for (const threshold of values) {
    const kept = usable.filter(row => Number(row[field]) <= threshold);
    if (kept.length < minKept) continue;

    const stats = getOutcomeStats(kept);
    const keepRatio = kept.length / usable.length;
    const score = scoreOutcomeStats(stats) + keepRatio * 5;

    const candidate = {
      threshold,
      kept: kept.length,
      keepRatio: Number(keepRatio.toFixed(3)),
      ...stats,
      score: Number(score.toFixed(3))
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
    confidence:
      usable.length >= 60
        ? "HIGH"
        : usable.length >= 25
          ? "MEDIUM"
          : "LOW",
    best
  };
}

function buildFeatureThresholdOptimizer(rows) {
  const usable = rows.filter(row => {
    if (!row) return false;
    if (!Number.isFinite(Number(row.pnlPct))) return false;

    return true;
  });

  const probeRows = usable.filter(row => isBullishMidTrendProbeRow(row));

  const aLikeRows = usable.filter(row => {
    if (isBullishMidTrendProbeRow(row)) return false;

    return (
      row.setupClass === "A" ||
      row.entryReason === "ELITE_ENTRY" ||
      Number(row.score || 0) >= 75
    );
  });

  const midRows = usable.filter(row => row.rsiZone === "MID");
  const midBullRows = usable.filter(row => row.rsiZone === "MID" && row.side === "bull");

  const result = {
    sample: {
      usableRows: usable.length,
      aLikeRows: aLikeRows.length,
      probeRows: probeRows.length,
      midRows: midRows.length,
      midBullRows: midBullRows.length,
      confidence:
        usable.length >= 100
          ? "HIGH"
          : usable.length >= 40
            ? "MEDIUM"
            : "LOW"
    },

    recommendedFilterValues: {
      A_MIN_CONFLUENCE: evaluateNumericMinOutcomeThreshold(
        aLikeRows,
        "confluence",
        CURRENT_FILTER_VALUES.A_MIN_CONFLUENCE
      ),

      A_MIN_SNIPER: evaluateNumericMinOutcomeThreshold(
        aLikeRows,
        "sniperScore",
        CURRENT_FILTER_VALUES.A_MIN_SNIPER
      ),

      A_ENTRY_MIN_RR: evaluateNumericMinOutcomeThreshold(
        aLikeRows,
        "plannedRR",
        A_ENTRY_MIN_RR
      ),

      MAX_SPREAD_PCT: evaluateNumericMaxOutcomeThreshold(
        usable,
        "spreadPct",
        MAX_SPREAD_PCT
      ),

      MID_RSI_MIN_CONFLUENCE: evaluateNumericMinOutcomeThreshold(
        midRows,
        "confluence",
        CURRENT_FILTER_VALUES.MID_RSI_MIN_CONFLUENCE
      ),

      MID_BULL_MAX_SPREAD_PCT: evaluateNumericMaxOutcomeThreshold(
        midBullRows,
        "spreadPct",
        MID_BULL_MAX_SPREAD_PCT
      ),

      // Probe-specific optional thresholds
      BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE: evaluateNumericMinOutcomeThreshold(
        probeRows,
        "confluence",
        BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE
      ),
      BULLISH_MID_TREND_PROBE_MIN_SNIPER: evaluateNumericMinOutcomeThreshold(
        probeRows,
        "sniperScore",
        BULLISH_MID_TREND_PROBE_MIN_SNIPER
      ),
      BULLISH_MID_TREND_PROBE_MIN_RR: evaluateNumericMinOutcomeThreshold(
        probeRows,
        "plannedRR",
        BULLISH_MID_TREND_PROBE_MIN_RR
      ),
      BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT: evaluateNumericMaxOutcomeThreshold(
        probeRows,
        "spreadPct",
        BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT
      )
    }
  };

  return result;
}

function buildBestSetupAdvice() {
  const rows = buildFeatureOutcomeRows();

  const realRows = rows.real;
  const shadowRows = rows.shadow;

  const riskShadowRows = shadowRows.filter(row => row.hasRiskGeometry);

  const optimizerRows = realRows.length >= 20
    ? realRows
    : [...realRows, ...riskShadowRows];

  const minSample =
    optimizerRows.length >= 150
      ? BEST_SETUP_MIN_SAMPLE_HIGH
      : optimizerRows.length >= 60
        ? BEST_SETUP_MIN_SAMPLE_MEDIUM
        : BEST_SETUP_MIN_SAMPLE_LOW;

  const cohorts = buildFeatureCohorts(optimizerRows, minSample);

  const bestSetups = cohorts
    .filter(row => row.winrateNum >= BEST_SETUP_MIN_WINRATE)
    .filter(row => row.avgR >= BEST_SETUP_MIN_AVG_R)
    .slice(0, 15);

  const badSetups = cohorts
    .filter(row => row.winrateNum <= BAD_SETUP_MAX_WINRATE || row.avgR <= BAD_SETUP_MAX_AVG_R)
    .sort((a, b) => Number(a.avgR || 0) - Number(b.avgR || 0))
    .slice(0, 15);

  const blockedButWouldHaveWon = buildFeatureCohorts(
    shadowRows.filter(row => row.win),
    Math.max(3, Math.floor(minSample / 2))
  ).slice(0, 15);

  const blockedAndLost = buildFeatureCohorts(
    shadowRows.filter(row => row.loss),
    Math.max(3, Math.floor(minSample / 2))
  )
    .sort((a, b) => Number(a.avgR || 0) - Number(b.avgR || 0))
    .slice(0, 15);

  const allowedButLost = buildFeatureCohorts(
    realRows.filter(row => row.loss),
    Math.max(3, Math.floor(minSample / 2))
  )
    .sort((a, b) => Number(a.avgR || 0) - Number(b.avgR || 0))
    .slice(0, 15);

  const thresholdOptimizer = buildFeatureThresholdOptimizer(optimizerRows);

  const overallReal = getOutcomeStats(realRows);
  const overallShadow = getOutcomeStats(shadowRows);
  const overallOptimizer = getOutcomeStats(optimizerRows);

  return {
    tag: "TS_BEST_SETUP_ADVICE",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      featureRows: auditState.featureStore?.length || 0,
      shadowRows: auditState.shadowOutcomes?.length || 0,

      realClosedRows: realRows.length,
      shadowCompletedRows: shadowRows.length,
      optimizerRows: optimizerRows.length,

      minCohortSampleUsed: minSample,

      confidence:
        optimizerRows.length >= 150
          ? "HIGH"
          : optimizerRows.length >= 60
            ? "MEDIUM"
            : "LOW"
    },

    overall: {
      real: overallReal,
      shadow: overallShadow,
      optimizer: overallOptimizer
    },

    recommendedFilterValues: thresholdOptimizer.recommendedFilterValues,

    bestSetups,
    badSetups,

    blockedButWouldHaveWon,
    blockedAndLost,
    allowedButLost,

    interpretation: {
      bestSetups: "cohorts met hoogste combinatie van avgR, winrate, profitFactor, PnL en lage directSL",
      badSetups: "cohorts die structureel negatief of lage hitrate zijn",
      blockedButWouldHaveWon: "filters die mogelijk te streng zijn",
      blockedAndLost: "filters die waarschijnlijk terecht blokkeren",
      allowedButLost: "toegelaten setups die je entry-funnel moet aanscherpen"
    }
  };
}

// ================= FINAL FILTER DECISION LOGGER =================
function roundNumber(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function getNumericValues(rows, field) {
  return rows
    .map(row => Number(row?.[field]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function quantile(values, q) {
  if (!Array.isArray(values) || !values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;

  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }

  return sorted[base];
}

function uniqueNumericCandidates(values, decimals = 4) {
  return Array.from(
    new Set(
      values
        .map(Number)
        .filter(Number.isFinite)
        .map(value => roundNumber(value, decimals))
    )
  ).sort((a, b) => a - b);
}

function buildMinThresholdCandidates(rows, field, currentValue, suggestedValue, decimals = 2) {
  const values = getNumericValues(rows, field);

  return uniqueNumericCandidates([
    currentValue,
    suggestedValue,
    quantile(values, 0.50),
    quantile(values, 0.70)
  ], decimals).slice(0, 4);
}

function buildMaxThresholdCandidates(rows, field, currentValue, suggestedValue, decimals = 6) {
  const values = getNumericValues(rows, field);

  return uniqueNumericCandidates([
    currentValue,
    suggestedValue,
    quantile(values, 0.25),
    quantile(values, 0.40)
  ], decimals).slice(0, 4);
}

function buildCurrentFilterPreset() {
  return {
    presetName: "CURRENT_FILTERS",

    A_MIN_CONFLUENCE: CURRENT_FILTER_VALUES.A_MIN_CONFLUENCE,
    A_MIN_SNIPER: CURRENT_FILTER_VALUES.A_MIN_SNIPER,
    A_ENTRY_MIN_RR,

    MAX_SPREAD_PCT,
    MID_RSI_MIN_CONFLUENCE,
    MID_BULL_MAX_SPREAD_PCT
  };
}

function getSuggestedThreshold(recommendedFilterValues, key, fallback) {
  const value = Number(recommendedFilterValues?.[key]?.suggestedValue);
  return Number.isFinite(value) ? value : fallback;
}

function buildPresetKey(preset) {
  return [
    `A_CONF=${preset.A_MIN_CONFLUENCE}`,
    `A_SNIPER=${preset.A_MIN_SNIPER}`,
    `A_RR=${preset.A_ENTRY_MIN_RR}`,
    `MAX_SPREAD=${preset.MAX_SPREAD_PCT}`,
    `MID_CONF=${preset.MID_RSI_MIN_CONFLUENCE}`,
    `MID_SPREAD=${preset.MID_BULL_MAX_SPREAD_PCT}`
  ].join("|");
}

function buildFilterPresetGrid(rows) {
  const thresholdOptimizer = buildFeatureThresholdOptimizer(rows);
  const recommended = thresholdOptimizer?.recommendedFilterValues || {};
  const currentPreset = buildCurrentFilterPreset();

  const aConfValues = buildMinThresholdCandidates(
    rows,
    "confluence",
    currentPreset.A_MIN_CONFLUENCE,
    getSuggestedThreshold(recommended, "A_MIN_CONFLUENCE", currentPreset.A_MIN_CONFLUENCE),
    0
  );

  const aSniperValues = buildMinThresholdCandidates(
    rows,
    "sniperScore",
    currentPreset.A_MIN_SNIPER,
    getSuggestedThreshold(recommended, "A_MIN_SNIPER", currentPreset.A_MIN_SNIPER),
    0
  );

  const aRrValues = buildMinThresholdCandidates(
    rows,
    "plannedRR",
    currentPreset.A_ENTRY_MIN_RR,
    getSuggestedThreshold(recommended, "A_ENTRY_MIN_RR", currentPreset.A_ENTRY_MIN_RR),
    2
  );

  const maxSpreadValues = buildMaxThresholdCandidates(
    rows,
    "spreadPct",
    currentPreset.MAX_SPREAD_PCT,
    getSuggestedThreshold(recommended, "MAX_SPREAD_PCT", currentPreset.MAX_SPREAD_PCT),
    6
  );

  const midConfValues = buildMinThresholdCandidates(
    rows,
    "confluence",
    currentPreset.MID_RSI_MIN_CONFLUENCE,
    getSuggestedThreshold(recommended, "MID_RSI_MIN_CONFLUENCE", currentPreset.MID_RSI_MIN_CONFLUENCE),
    0
  );

  const midSpreadValues = buildMaxThresholdCandidates(
    rows,
    "spreadPct",
    currentPreset.MID_BULL_MAX_SPREAD_PCT,
    getSuggestedThreshold(recommended, "MID_BULL_MAX_SPREAD_PCT", currentPreset.MID_BULL_MAX_SPREAD_PCT),
    6
  );

  const map = new Map();

  function addPreset(presetName, preset) {
    const fullPreset = {
      presetName,
      ...preset
    };

    map.set(buildPresetKey(fullPreset), fullPreset);
  }

  addPreset("CURRENT_FILTERS", currentPreset);

  addPreset("THRESHOLD_OPTIMIZER_DIRECT", {
    A_MIN_CONFLUENCE: getSuggestedThreshold(recommended, "A_MIN_CONFLUENCE", currentPreset.A_MIN_CONFLUENCE),
    A_MIN_SNIPER: getSuggestedThreshold(recommended, "A_MIN_SNIPER", currentPreset.A_MIN_SNIPER),
    A_ENTRY_MIN_RR: getSuggestedThreshold(recommended, "A_ENTRY_MIN_RR", currentPreset.A_ENTRY_MIN_RR),

    MAX_SPREAD_PCT: getSuggestedThreshold(recommended, "MAX_SPREAD_PCT", currentPreset.MAX_SPREAD_PCT),
    MID_RSI_MIN_CONFLUENCE: getSuggestedThreshold(recommended, "MID_RSI_MIN_CONFLUENCE", currentPreset.MID_RSI_MIN_CONFLUENCE),
    MID_BULL_MAX_SPREAD_PCT: getSuggestedThreshold(recommended, "MID_BULL_MAX_SPREAD_PCT", currentPreset.MID_BULL_MAX_SPREAD_PCT)
  });

  for (const A_MIN_CONFLUENCE of aConfValues) {
    for (const A_MIN_SNIPER of aSniperValues) {
      for (const A_ENTRY_MIN_RR of aRrValues) {
        for (const MAX_SPREAD_PCT_VALUE of maxSpreadValues) {
          for (const MID_RSI_MIN_CONFLUENCE_VALUE of midConfValues) {
            for (const MID_BULL_MAX_SPREAD_PCT_VALUE of midSpreadValues) {
              addPreset("GRID_SEARCH_PRESET", {
                A_MIN_CONFLUENCE,
                A_MIN_SNIPER,
                A_ENTRY_MIN_RR,

                MAX_SPREAD_PCT: MAX_SPREAD_PCT_VALUE,
                MID_RSI_MIN_CONFLUENCE: MID_RSI_MIN_CONFLUENCE_VALUE,
                MID_BULL_MAX_SPREAD_PCT: MID_BULL_MAX_SPREAD_PCT_VALUE
              });
            }
          }
        }
      }
    }
  }

  return Array.from(map.values());
}

function rowPassesFilterPreset(row, preset) {
  if (!row) return false;

  const confluence = Number(row.confluence || 0);
  const sniperScore = Number(row.sniperScore || 0);
  const plannedRR = Number(row.plannedRR || 0);
  const spread = normalizeSpread(row.spreadPct);
  const depth = Number(row.depthMinUsd1p || 0);
  const side = String(row.side || "").toLowerCase();
  const rsiZone = String(row.rsiZone || "UNKNOWN").toUpperCase();
  const flow = String(row.flow || "UNKNOWN").toUpperCase();

  if (isBullishMidTrendProbeRow(row)) {
    if (side !== "bull") return false;
    if (rsiZone !== "MID") return false;
    if (flow !== "TREND") return false;
    if (confluence < BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE) return false;
    if (sniperScore < BULLISH_MID_TREND_PROBE_MIN_SNIPER) return false;
    if (plannedRR < BULLISH_MID_TREND_PROBE_MIN_RR) return false;
    if (spread > BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT) return false;
    if (depth < BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P) return false;

    return true;
  }

  if (confluence < Number(preset.A_MIN_CONFLUENCE || 0)) return false;
  if (sniperScore < Number(preset.A_MIN_SNIPER || 0)) return false;
  if (plannedRR < Number(preset.A_ENTRY_MIN_RR || 0)) return false;

  if (spread > Number(preset.MAX_SPREAD_PCT || MAX_SPREAD_PCT)) return false;

  if (
    side === "bull" &&
    rsiZone === "MID" &&
    confluence < Number(preset.MID_RSI_MIN_CONFLUENCE || MID_RSI_MIN_CONFLUENCE)
  ) {
    return false;
  }

  if (
    side === "bull" &&
    rsiZone === "MID" &&
    spread > Number(preset.MID_BULL_MAX_SPREAD_PCT || MID_BULL_MAX_SPREAD_PCT)
  ) {
    return false;
  }

  return true;
}

function scoreFilterPreset(stats, keepRatio) {
  const winrate = Number(stats.winrateNum || 0);
  const avgR = Number(stats.avgR || 0);
  const avgPnlPct = Number(stats.avgPnlPct || 0);
  const totalR = Number(stats.totalR || 0);
  const profitFactor = clamp(Number(stats.profitFactorR || 0), 0, 5);
  const directSLPct = parsePct(stats.directSLPct) / 100;

  const sampleConfidence = clamp(
    Number(stats.completed || 0) / FINAL_DECISION_TARGET_COMPLETED,
    0.15,
    1
  );

  const rawScore =
    winrate * 100 +
    avgR * 45 +
    avgPnlPct * 8 +
    profitFactor * 8 +
    totalR * 0.15 +
    keepRatio * 5 -
    directSLPct * 30;

  return Number((rawScore * sampleConfidence).toFixed(3));
}

function evaluateFilterPreset(rows, preset) {
  const kept = rows.filter(row => rowPassesFilterPreset(row, preset));
  const stats = getOutcomeStats(kept);
  const keepRatio = rows.length ? kept.length / rows.length : 0;

  return {
    presetName: preset.presetName,
    presetKey: buildPresetKey(preset),

    filters: {
      A_MIN_CONFLUENCE: preset.A_MIN_CONFLUENCE,
      A_MIN_SNIPER: preset.A_MIN_SNIPER,
      A_ENTRY_MIN_RR: preset.A_ENTRY_MIN_RR,

      MAX_SPREAD_PCT: preset.MAX_SPREAD_PCT,
      MID_RSI_MIN_CONFLUENCE: preset.MID_RSI_MIN_CONFLUENCE,
      MID_BULL_MAX_SPREAD_PCT: preset.MID_BULL_MAX_SPREAD_PCT
    },

    kept: kept.length,
    rejected: rows.length - kept.length,
    keepRatio: Number(keepRatio.toFixed(3)),

    ...stats,

    decisionScore: scoreFilterPreset(stats, keepRatio),

    examples: kept.slice(-10).map(row => ({
      source: row.source,
      symbol: row.symbol,
      side: row.side,
      reason: row.reason || row.entryReason,
      rsiZone: row.rsiZone,
      confluence: row.confluence,
      sniperScore: row.sniperScore,
      plannedRR: row.plannedRR,
      spreadPct: row.spreadPct,
      exitR: row.exitR,
      pnlPct: row.pnlPct,
      win: row.win,
      loss: row.loss
    }))
  };
}

function buildPresetDiff(currentPreset, bestPreset) {
  return Object.entries(bestPreset.filters || {})
    .map(([key, suggestedValue]) => {
      const currentValue = Number(currentPreset?.[key]);

      return {
        parameter: key,
        currentValue,
        suggestedValue,
        delta: Number.isFinite(currentValue)
          ? roundNumber(Number(suggestedValue) - currentValue, 6)
          : null,
        direction:
          Number.isFinite(currentValue) && Number(suggestedValue) > currentValue
            ? "RAISE"
            : Number.isFinite(currentValue) && Number(suggestedValue) < currentValue
              ? "LOWER"
              : "KEEP"
      };
    });
}

function buildFinalFilterDecision() {
  const outcomeRows = buildFeatureOutcomeRows();

  const realRows = outcomeRows.real || [];
  const completedShadowRows = (outcomeRows.shadow || [])
    .filter(row => row?.status !== "OPEN")
    .filter(row => row?.hasRiskGeometry)
    .filter(row => Boolean(row.win) || Boolean(row.loss));

  const optimizerRows = realRows.length >= 20
    ? realRows
    : [...realRows, ...completedShadowRows];

  const usableRows = optimizerRows
    .filter(row => row?.hasRiskGeometry)
    .filter(row => Boolean(row.win) || Boolean(row.loss))
    .filter(row => Number.isFinite(Number(row.pnlPct)));

  const currentPreset = buildCurrentFilterPreset();

  if (usableRows.length < FINAL_DECISION_MIN_COMPLETED) {
    return {
      tag: "TS_FINAL_FILTER_DECISION",
      strategyVersion: STRATEGY_VERSION,
      ts: Date.now(),

      decision: "NO_FINAL_DECISION_SAMPLE_TOO_SMALL",
      adviceOnly: true,
      shouldApplyAutomatically: false,

      sample: {
        usableRows: usableRows.length,
        realRows: realRows.length,
        completedShadowRows: completedShadowRows.length,
        minRequired: FINAL_DECISION_MIN_COMPLETED,
        confidence: "LOW"
      },

      currentFilters: currentPreset,
      conclusion: "keep collecting data; final preset ranking disabled until minimum sample is reached"
    };
  }

  const presets = buildFilterPresetGrid(usableRows);

  const evaluated = presets
    .map(preset => evaluateFilterPreset(usableRows, preset))
    .filter(row => Number(row.completed || 0) >= FINAL_DECISION_MIN_COMPLETED)
    .sort((a, b) => Number(b.decisionScore || 0) - Number(a.decisionScore || 0));

  const best = evaluated[0] || null;

  const currentEval = evaluated.find(row => row.presetKey === buildPresetKey(currentPreset)) || null;

  if (!best) {
    return {
      tag: "TS_FINAL_FILTER_DECISION",
      strategyVersion: STRATEGY_VERSION,
      ts: Date.now(),

      decision: "NO_VALID_PRESET_FOUND",
      adviceOnly: true,
      shouldApplyAutomatically: false,

      sample: {
        usableRows: usableRows.length,
        realRows: realRows.length,
        completedShadowRows: completedShadowRows.length,
        confidence: "LOW"
      },

      currentFilters: currentPreset
    };
  }

  const deltaVsCurrent = currentEval
    ? {
        winrateDeltaPct: Number(((Number(best.winrateNum || 0) - Number(currentEval.winrateNum || 0)) * 100).toFixed(1)),
        avgRDelta: Number((Number(best.avgR || 0) - Number(currentEval.avgR || 0)).toFixed(3)),
        avgPnlPctDelta: Number((Number(best.avgPnlPct || 0) - Number(currentEval.avgPnlPct || 0)).toFixed(3)),
        profitFactorDelta: Number((Number(best.profitFactorR || 0) - Number(currentEval.profitFactorR || 0)).toFixed(3)),
        decisionScoreDelta: Number((Number(best.decisionScore || 0) - Number(currentEval.decisionScore || 0)).toFixed(3))
      }
    : null;

  return {
    tag: "TS_FINAL_FILTER_DECISION",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    decision: "BEST_FILTER_PRESET_FOR_WINRATE_AND_PNL",
    adviceOnly: true,
    shouldApplyAutomatically: false,

    method: {
      objective: "maximize combined winrate + avgR + avgPnlPct + profitFactorR, penalize directSL and low sample",
      dataUsed:
        realRows.length >= 20
          ? "REAL_CLOSED_TRADES_ONLY"
          : "REAL_CLOSED_TRADES_PLUS_COMPLETED_SHADOW_OUTCOMES",
      note: "this ranks filter presets only; it does not change live constants"
    },

    sample: {
      usableRows: usableRows.length,
      realRows: realRows.length,
      completedShadowRows: completedShadowRows.length,
      presetsTested: presets.length,
      presetsValid: evaluated.length,
      confidence:
        usableRows.length >= 150
          ? "HIGH"
          : usableRows.length >= 60
            ? "MEDIUM"
            : "LOW"
    },

    conclusion: {
      setFiltersTo: best.filters,
      expectedWinrate: best.winrate,
      expectedAvgR: best.avgR,
      expectedTotalR: best.totalR,
      expectedAvgPnlPct: best.avgPnlPct,
      expectedTotalPnlPct: best.totalPnlPct,
      expectedProfitFactorR: best.profitFactorR,
      expectedDirectSLPct: best.directSLPct,
      expectedKeepRatio: best.keepRatio,
      completedSample: best.completed,
      decisionScore: best.decisionScore
    },

    currentComparison: {
      current: currentEval,
      deltaVsCurrent
    },

    changesVsCurrent: buildPresetDiff(currentPreset, best),

    rankedPresets: evaluated.slice(0, FINAL_DECISION_TOP_N)
  };
}

// ================= FULL FILTER OPTIMIZER (MASTER) =================
function buildCurrentFullFilterPreset() {
  return {
    CANDIDATE_MIN_SCORE,

    BTC_BEARISH_LONG_MIN_SCORE,
    BTC_NEUTRAL_MIN_SCORE,

    MAX_SPREAD_PCT,
    MID_BULL_MAX_SPREAD_PCT,
    MIN_DEPTH_USD_1P,
    MIN_DEPTH_USD_1P_ABSOLUTE,
    A_MIN_DEPTH_USD_1P,
    BULL_TREND_MIN_DEPTH_USD_1P,

    MIN_RR_FLOOR,
    GRADE_A_MIN_RR_FLOOR,
    GRADE_B_MIN_RR_FLOOR,
    GRADE_C_MIN_RR_FLOOR,
    COUNTERTREND_MIN_RR_FLOOR,
    BUILDUP_MIN_RR_FLOOR,

    A_ENTRY_MIN_RR,
    A_FINAL_MIN_RR,
    A_MIN_SNIPER,
    A_MIN_CONFLUENCE,

    B_ENTRY_MIN_RR,
    B_MIN_SNIPER,
    B_MIN_CONFLUENCE,
    ENABLE_B_ENTRIES,

    GOD_ENTRY_MIN_RR,
    GOD_MIN_SNIPER,
    GOD_MIN_CONFLUENCE,

    MID_RSI_MIN_CONFLUENCE,
    EARLY_RSI_MIN_SNIPER,
    TREND_CONTINUATION_MIN_CONFLUENCE,
    TREND_CONTINUATION_MIN_SNIPER,
    TREND_CONTINUATION_MIN_RR,

    SHORT_BLOCKED_RSI_ZONES,
    SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE,
    SHORT_LOWER1_CONTINUATION_MIN_SNIPER,
    SHORT_LOWER1_CONTINUATION_MIN_RR,
    SHORT_LOWER1_ALLOWED_BTC_STATES,

    LONG_LOWER2_MAX_1H_CHANGE,
    SHORT_UPPER2_MIN_1H_CHANGE,

    STRONG_MOMENTUM_MIN_1H_MOVE_PCT,
    STRONG_MOMENTUM_MIN_24H_MOVE_PCT,
    SOFT_MOMENTUM_MIN_1H_MOVE_PCT,
    SOFT_MOMENTUM_MIN_24H_MOVE_PCT,
    ELITE_MOMENTUM_MIN_CONFLUENCE,
    ELITE_MOMENTUM_MIN_1H_MOVE_PCT,

    LOW_VOL_MIN_CONFLUENCE,
    NO_FLOW_MIN_CONFLUENCE,
    TF_MIN_STRENGTH,
    GLOBAL_MIN_CONFLUENCE,

    OB_AGAINST_MIN_CONFLUENCE,
    BAD_MARKET_QUALITY_MIN_CONFLUENCE,
    OB_NEUTRAL_MIN_CONFLUENCE,

    MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE,
    MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER,

    EXTREME_FUNDING_ABS_MAX,
    BULL_CROWDED_FUNDING_MAX,
    BEAR_CROWDED_FUNDING_MIN,
    CROWDED_FUNDING_MIN_CONFLUENCE,

    SETUP_GRADE_A_MIN_POINTS,
    SETUP_GRADE_B_MIN_POINTS,

    NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE,
    NEUTRAL_OB_A_EXCEPTION_MIN_RR,
    NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER,
    NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE,
    NEUTRAL_OB_B_EXCEPTION_MIN_RR,
    NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER,
    NEUTRAL_OB_B_EXCEPTION_MIN_SCORE,

    REQUIRE_BULL_TREND_PULLBACK,
    MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT,

    ENABLE_BTC_BULLISH_BEAR_EXCEPTION,
    BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P,
    BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT,
    BTC_BULLISH_BEAR_EXCEPTION_MIN_RR,
    BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF,
    BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF,
    BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER,

    ENABLE_BULLISH_MID_TREND_PROBES,
    BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE,
    BULLISH_MID_TREND_PROBE_MIN_SNIPER,
    BULLISH_MID_TREND_PROBE_MIN_RR,
    BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT,
    BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P,
    BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH,
    BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT,
    BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT,
    BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT,

    A_GOD_MAX_TP_REWARD_MULTIPLIER,
    BREAK_EVEN_TRIGGER_R,
    BREAK_EVEN_LOCK_R
  };
}

const FULL_FILTER_SEARCH_SPACE = Object.freeze({
  CANDIDATE_MIN_SCORE: [45, 50, 55, 60],

  BTC_BEARISH_LONG_MIN_SCORE: [70, 75, 80],
  BTC_NEUTRAL_MIN_SCORE: [55, 60, 65, 70],

  MAX_SPREAD_PCT: [0.0011, 0.00135, 0.00175, 0.002],
  MID_BULL_MAX_SPREAD_PCT: [0.00085, 0.001, 0.0011, 0.00125],
  MIN_DEPTH_USD_1P: [100000, 150000, 200000, 250000],
  MIN_DEPTH_USD_1P_ABSOLUTE: [15000, 25000, 40000],
  A_MIN_DEPTH_USD_1P: [30000, 50000, 75000],
  BULL_TREND_MIN_DEPTH_USD_1P: [75000, 100000, 150000],

  GRADE_A_MIN_RR_FLOOR: [1.0, 1.05, 1.1, 1.2],
  GRADE_B_MIN_RR_FLOOR: [1.0, 1.05, 1.1, 1.2],
  GRADE_C_MIN_RR_FLOOR: [1.0, 1.1, 1.2, 1.3],
  COUNTERTREND_MIN_RR_FLOOR: [1.25, 1.35, 1.4, 1.5],
  BUILDUP_MIN_RR_FLOOR: [1.1, 1.2, 1.3],

  A_ENTRY_MIN_RR: [1.15, 1.2, 1.25, 1.35, 1.5],
  A_FINAL_MIN_RR: [1.25, 1.3, 1.35, 1.45, 1.6],
  A_MIN_SNIPER: [55, 59, 62, 65, 70],
  A_MIN_CONFLUENCE: [62, 64, 66, 68, 70, 72],

  B_ENTRY_MIN_RR: [1.15, 1.2, 1.25, 1.35, 1.5],
  B_MIN_SNIPER: [68, 72, 75, 78],
  B_MIN_CONFLUENCE: [70, 75, 78, 80],
  ENABLE_B_ENTRIES: [true, false],

  GOD_ENTRY_MIN_RR: [1.35, 1.45, 1.55],
  GOD_MIN_SNIPER: [82, 85, 88],
  GOD_MIN_CONFLUENCE: [82, 85, 88],

  MID_RSI_MIN_CONFLUENCE: [62, 64, 66, 68, 70],
  EARLY_RSI_MIN_SNIPER: [70, 75, 80],
  TREND_CONTINUATION_MIN_CONFLUENCE: [62, 65, 68, 70],
  TREND_CONTINUATION_MIN_SNIPER: [50, 55, 60, 65],
  TREND_CONTINUATION_MIN_RR: [1.0, 1.1, 1.2],

  SHORT_BLOCKED_RSI_ZONES: [
    ["LOWER_2", "LOWER_3"],
    ["LOWER_3"],
    []
  ],
  SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE: [72, 75, 78, 80],
  SHORT_LOWER1_CONTINUATION_MIN_SNIPER: [70, 75, 80],
  SHORT_LOWER1_CONTINUATION_MIN_RR: [1.15, 1.25, 1.35],

  LONG_LOWER2_MAX_1H_CHANGE: [-0.1, -0.05, 0],
  SHORT_UPPER2_MIN_1H_CHANGE: [0.1, 0.2, 0.3],

  STRONG_MOMENTUM_MIN_1H_MOVE_PCT: [0.2, 0.25, 0.3],
  STRONG_MOMENTUM_MIN_24H_MOVE_PCT: [1.5, 2.0, 2.5],
  SOFT_MOMENTUM_MIN_1H_MOVE_PCT: [0.1, 0.15, 0.2],
  SOFT_MOMENTUM_MIN_24H_MOVE_PCT: [1.0, 1.5, 2.0],
  ELITE_MOMENTUM_MIN_CONFLUENCE: [74, 78, 82],
  ELITE_MOMENTUM_MIN_1H_MOVE_PCT: [0.05, 0.1, 0.15],

  LOW_VOL_MIN_CONFLUENCE: [55, 60, 65],
  NO_FLOW_MIN_CONFLUENCE: [64, 68, 72],
  TF_MIN_STRENGTH: [0.5, 1, 1.5],
  GLOBAL_MIN_CONFLUENCE: [58, 60, 62, 65],

  OB_AGAINST_MIN_CONFLUENCE: [74, 78, 82],
  BAD_MARKET_QUALITY_MIN_CONFLUENCE: [70, 75, 80],
  OB_NEUTRAL_MIN_CONFLUENCE: [50, 55, 60],

  MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE: [78, 82, 85],
  MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER: [70, 75, 80],

  EXTREME_FUNDING_ABS_MAX: [0.012, 0.015, 0.02],
  BULL_CROWDED_FUNDING_MAX: [0.01, 0.012, 0.015],
  BEAR_CROWDED_FUNDING_MIN: [-0.015, -0.012, -0.01],
  CROWDED_FUNDING_MIN_CONFLUENCE: [80, 85, 88],

  SETUP_GRADE_A_MIN_POINTS: [8, 9, 10],
  SETUP_GRADE_B_MIN_POINTS: [6, 7, 8],

  REQUIRE_BULL_TREND_PULLBACK: [true, false],
  MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT: [0.008, 0.012, 0.016],

  ENABLE_BTC_BULLISH_BEAR_EXCEPTION: [true, false],
  BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P: [75000, 100000, 150000],
  BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT: [0.0008, 0.001, 0.0012],
  BTC_BULLISH_BEAR_EXCEPTION_MIN_RR: [1.15, 1.25, 1.35],
  BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF: [45, 50, 55],
  BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF: [70, 72, 75],
  BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER: [50, 55, 60],

  ENABLE_BULLISH_MID_TREND_PROBES: [true, false],
  BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE: [58, 62, 65, 68],
  BULLISH_MID_TREND_PROBE_MIN_SNIPER: [40, 45, 50, 55],
  BULLISH_MID_TREND_PROBE_MIN_RR: [1.1, 1.2, 1.25, 1.35],
  BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT: [0.00085, 0.001, 0.0011, 0.00125],
  BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P: [75000, 100000, 150000],
  BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH: [true, false],
  BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT: [0.05, 0.08, 0.12],
  BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT: [0.5, 0.8, 1.2],
  BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT: [0.0005, 0.001, 0.0015],

  A_GOD_MAX_TP_REWARD_MULTIPLIER: [1.2, 1.25, 1.3, 1.35],
  BREAK_EVEN_TRIGGER_R: [0.4, 0.5, 0.6],
  BREAK_EVEN_LOCK_R: [0.02, 0.05, 0.1]
});

function stablePresetKey(preset) {
  return JSON.stringify(
    Object.keys(preset)
      .sort()
      .reduce((obj, key) => {
        obj[key] = preset[key];
        return obj;
      }, {})
  );
}

function fullFilterKeys() {
  return Object.keys(buildCurrentFullFilterPreset());
}

function getFullFilterCandidates(key, currentValue) {
  const values = FULL_FILTER_SEARCH_SPACE[key];

  if (!Array.isArray(values) || !values.length) {
    return [currentValue];
  }

  const map = new Map();

  for (const value of [currentValue, ...values]) {
    map.set(JSON.stringify(value), value);
  }

  return Array.from(map.values());
}

function getPresetGrade(row, preset) {
  const points = Number(row.gradePoints || 0);
  const confluence = Number(row.confluence || 0);

  if (
    points >= Number(preset.SETUP_GRADE_A_MIN_POINTS || 9) &&
    confluence >= Number(preset.A_MIN_CONFLUENCE || 0)
  ) {
    return "A";
  }

  if (points >= Number(preset.SETUP_GRADE_B_MIN_POINTS || 7)) {
    return "B";
  }

  return "C";
}

function getPresetSniperAdjustedRR(sniperScore, baseRR, setupClassHint) {
  const score = Number(sniperScore || 0);

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

function getPresetDynamicMinRrFloor(row, preset, grade) {
  let floor = Number(preset.MIN_RR_FLOOR || 1);

  if (grade === "A") floor = Number(preset.GRADE_A_MIN_RR_FLOOR || floor);
  else if (grade === "B") floor = Number(preset.GRADE_B_MIN_RR_FLOOR || floor);
  else floor = Number(preset.GRADE_C_MIN_RR_FLOOR || floor);

  if (String(row.stage || "").toLowerCase() === "buildup") {
    floor = Math.max(floor, Number(preset.BUILDUP_MIN_RR_FLOOR || floor));
  }

  if (Boolean(row.isCounterBtc)) {
    floor = Math.max(floor, Number(preset.COUNTERTREND_MIN_RR_FLOOR || floor));
  }

  const flow = String(row.flow || "").toUpperCase();
  const confluence = Number(row.confluence || 0);
  const sniperScore = Number(row.sniperScore || 0);
  const sniperValid = row.sniperValid !== false;

  if (
    String(row.stage || "").toLowerCase() === "entry" &&
    flow === "TREND" &&
    !Boolean(row.isCounterBtc) &&
    grade === "A" &&
    confluence >= 88 &&
    sniperValid &&
    sniperScore >= 80
  ) {
    floor = Math.max(floor, 1.20);
  }

  const setupClassHint = grade === "A" ? "A" : grade === "B" ? "B" : "C";

  return clamp(
    getPresetSniperAdjustedRR(sniperScore, floor, setupClassHint),
    1.00,
    1.70
  );
}

function getPresetBtcBullishBearExceptionOk(row, preset) {
  const side = String(row.side || "").toLowerCase();
  const btcState = String(row.btcState || "").toUpperCase();

  if (side !== "bear") return false;
  if (!isBtcBullishState(btcState)) return false;
  if (!preset.ENABLE_BTC_BULLISH_BEAR_EXCEPTION) return false;

  const rsiZone = String(row.rsiZone || "").toUpperCase();
  const flow = String(row.flow || "").toUpperCase();
  const obBias = String(row.obBias || "NEUTRAL").toUpperCase();
  const stage = String(row.stage || "").toLowerCase();
  const spread = normalizeSpread(row.spreadPct);
  const depth = Number(row.depthMinUsd1p || 0);
  const confluence = Number(row.confluence || 0);
  const rr = Number(row.plannedRR || row.rr || 0);
  const sniperScore = Number(row.sniperScore || 0);

  return (
    ["entry", "almost"].includes(stage) &&
    ["MID", "LOWER_1", "LOWER_2"].includes(rsiZone) &&
    ["TREND", "BUILDING"].includes(flow) &&
    ["NEUTRAL", "BEARISH"].includes(obBias) &&
    spread <= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT || 0) &&
    depth >= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P || 0) &&
    confluence >= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF || 0) &&
    confluence <= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF || 999) &&
    rr >= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_RR || 0) &&
    sniperScore >= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER || 0)
  );
}

function getPresetBullishMidTrendProbeOk(row, preset) {
  if (!preset.ENABLE_BULLISH_MID_TREND_PROBES) return false;

  const side = String(row.side || "").toLowerCase();
  const stage = String(row.stage || "").toLowerCase();
  const btcState = String(row.btcState || "").toUpperCase();
  const rsiZone = String(row.rsiZone || "").toUpperCase();
  const flow = String(row.flow || "").toUpperCase();
  const obBias = String(row.obBias || "UNKNOWN").toUpperCase();

  const confluence = Number(row.confluence || 0);
  const sniperScore = Number(row.sniperScore || 0);
  const rr = Number(row.plannedRR || row.rr || 0);
  const spread = normalizeSpread(row.spreadPct);
  const depth = Number(row.depthMinUsd1p || 0);

  return (
    side === "bull" &&
    ["entry", "almost"].includes(stage) &&
    (
      !preset.BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH ||
      isBtcBullishState(btcState)
    ) &&
    rsiZone === "MID" &&
    flow === "TREND" &&
    confluence >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE || 0) &&
    sniperScore >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_SNIPER || 0) &&
    rr >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_RR || 0) &&
    spread <= Number(preset.BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT || 0) &&
    depth >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P || 0) &&
    (
      obBias !== "BEARISH" ||
      confluence >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE || 0) + 3
    )
  );
}

function estimateFinalRrForPreset(row, setupClass, preset) {
  const baseRR = Number(row.baseRR || row.plannedRR || row.rr || 0);
  const sniperScore = Number(row.sniperScore || 0);
  const rsi = Number(row.rsi || 50);
  const side = String(row.side || "").toLowerCase();
  const isBull = side === "bull";

  if (!baseRR) return 0;

  let multiplier = 1.0;

  const tpSetupClass =
    setupClass === "A_SHORT_EXCEPTION"
      ? "A"
      : setupClass === "B_TREND_PROBE"
        ? "B"
        : setupClass;

  if (tpSetupClass === "GOD") multiplier = 1.45;
  else if (tpSetupClass === "A") multiplier = 1.25;
  else if (tpSetupClass === "B") multiplier = 1.05;

  if (tpSetupClass === "A" || tpSetupClass === "GOD") {
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

  if (tpSetupClass === "B") {
    multiplier = clamp(multiplier, 1.00, 1.15);
  } else if (tpSetupClass === "A" || tpSetupClass === "GOD") {
    multiplier = clamp(
      multiplier,
      1.20,
      Number(preset.A_GOD_MAX_TP_REWARD_MULTIPLIER || 1.30)
    );
  } else {
    multiplier = clamp(multiplier, 0.95, 1.20);
  }

  return Number((baseRR * multiplier).toFixed(4));
}

function rowPassesFullFilterPreset(row, preset) {
  if (!row) return false;
  if (!row.hasRiskGeometry) return false;

  const side = String(row.side || "").toLowerCase();
  const isBull = side === "bull";
  const stage = String(row.stage || "").toLowerCase();
  const score = Number(row.score || 0);
  const btcState = String(row.btcState || "UNKNOWN").toUpperCase();

  const confluence = Number(row.confluence || 0);
  const sniperScore = Number(row.sniperScore || 0);
  const sniperValid = row.sniperValid !== false && sniperScore > 0;

  const rsiZone = String(row.rsiZone || "UNKNOWN").toUpperCase();
  const flow = String(row.flow || "UNKNOWN").toUpperCase();
  const structure = String(row.structure || "NEUTRAL").toUpperCase();

  const rr = Number(row.plannedRR || row.rr || 0);
  const spread = normalizeSpread(row.spreadPct);
  const depth = Number(row.depthMinUsd1p || 0);
  const funding = Number(row.funding || 0);
  const tfStrength = Number(row.tfStrength || 0);
  const change1h = Number(row.change1h || 0);
  const change24 = Number(row.change24 || 0);

  if (!["bull", "bear"].includes(side)) return false;
  if (!["entry", "almost"].includes(stage)) return false;
  if (Boolean(row.uiOnly)) return false;
  if (score < Number(preset.CANDIDATE_MIN_SCORE || 0)) return false;

  if (btcState === "STRONG_BEAR" && isBull) return false;

  if (
    btcState === "BEARISH" &&
    isBull &&
    score < Number(preset.BTC_BEARISH_LONG_MIN_SCORE || 0)
  ) {
    return false;
  }

  if (
    btcState === "NEUTRAL" &&
    score < Number(preset.BTC_NEUTRAL_MIN_SCORE || 0)
  ) {
    return false;
  }

  if (row.rsiValid === false) return false;
  if (row.rsiHtfBlocked === true) return false;

  if (isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) {
    return false;
  }

  const btcBullishBearExceptionOk = getPresetBtcBullishBearExceptionOk(row, preset);
  const bullishMidTrendProbeOk = getPresetBullishMidTrendProbeOk(row, preset);

  const allowLowerOneShortContinuation =
    !isBull &&
    rsiZone === "LOWER_1" &&
    flow === "TREND" &&
    confluence >= Number(preset.SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE || 0) &&
    sniperScore >= Number(preset.SHORT_LOWER1_CONTINUATION_MIN_SNIPER || 0) &&
    rr >= Number(preset.SHORT_LOWER1_CONTINUATION_MIN_RR || 0) &&
    Array.isArray(preset.SHORT_LOWER1_ALLOWED_BTC_STATES) &&
    preset.SHORT_LOWER1_ALLOWED_BTC_STATES.includes(btcState);

  if (
    !isBull &&
    Array.isArray(preset.SHORT_BLOCKED_RSI_ZONES) &&
    preset.SHORT_BLOCKED_RSI_ZONES.includes(rsiZone) &&
    !allowLowerOneShortContinuation &&
    !btcBullishBearExceptionOk
  ) {
    return false;
  }

  const trendContinuationRSI =
    (
      flow === "TREND" &&
      confluence >= Number(preset.TREND_CONTINUATION_MIN_CONFLUENCE || 0) &&
      rr >= Number(preset.TREND_CONTINUATION_MIN_RR || 0) &&
      sniperScore >= Number(preset.TREND_CONTINUATION_MIN_SNIPER || 0) &&
      (
        (isBull && ["MID", "LOWER_1"].includes(rsiZone)) ||
        (!isBull && ["MID", "UPPER_1"].includes(rsiZone))
      )
    ) ||
    bullishMidTrendProbeOk;

  const earlyRSI =
    (isBull && rsiZone === "LOWER_1" && sniperScore >= Number(preset.EARLY_RSI_MIN_SNIPER || 0)) ||
    (!isBull && rsiZone === "UPPER_1" && sniperScore >= Number(preset.EARLY_RSI_MIN_SNIPER || 0));

  if (isBull) {
    const rsiOK =
      ["LOWER_2", "LOWER_3"].includes(rsiZone) ||
      earlyRSI ||
      trendContinuationRSI;

    if (!rsiOK) return false;
  }

  if (!isBull) {
    const rsiOK =
      ["UPPER_2", "UPPER_3"].includes(rsiZone) ||
      earlyRSI ||
      trendContinuationRSI ||
      allowLowerOneShortContinuation ||
      btcBullishBearExceptionOk;

    if (!rsiOK) return false;
  }

  if (
    isBull &&
    rsiZone === "LOWER_2" &&
    change1h > Number(preset.LONG_LOWER2_MAX_1H_CHANGE || -0.05)
  ) {
    return false;
  }

  if (
    !isBull &&
    rsiZone === "UPPER_2" &&
    change1h < Number(preset.SHORT_UPPER2_MIN_1H_CHANGE || 0.2)
  ) {
    return false;
  }

  if (
    rsiZone === "MID" &&
    !trendContinuationRSI &&
    confluence < Number(preset.MID_RSI_MIN_CONFLUENCE || 0)
  ) {
    return false;
  }

  if ((isBull && structure === "BEARISH") || (!isBull && structure === "BULLISH")) {
    return false;
  }

  const strongMomentum =
    Math.abs(change1h) > Number(preset.STRONG_MOMENTUM_MIN_1H_MOVE_PCT || 0) &&
    Math.abs(change24) > Number(preset.STRONG_MOMENTUM_MIN_24H_MOVE_PCT || 0) &&
    ["TREND", "BUILDING"].includes(flow);

  const softMomentum =
    Math.abs(change1h) > Number(preset.SOFT_MOMENTUM_MIN_1H_MOVE_PCT || 0) &&
    Math.abs(change24) > Number(preset.SOFT_MOMENTUM_MIN_24H_MOVE_PCT || 0) &&
    flow === "TREND";

  const eliteMomentumBypass =
    flow === "TREND" &&
    confluence >= Number(preset.ELITE_MOMENTUM_MIN_CONFLUENCE || 0) &&
    sniperScore >= Number(preset.A_MIN_SNIPER || 0) &&
    rr >= Number(preset.A_ENTRY_MIN_RR || 0) &&
    Math.abs(change1h) >= Number(preset.ELITE_MOMENTUM_MIN_1H_MOVE_PCT || 0);

  const probeMomentumBypass =
    bullishMidTrendProbeOk &&
    flow === "TREND" &&
    Math.abs(change1h) >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT || 0) &&
    Math.abs(change24) >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT || 0) &&
    score >= 75;

  if (!strongMomentum && !softMomentum && !eliteMomentumBypass && !probeMomentumBypass) {
    return false;
  }

  if (!Boolean(row.fakeBreakout) && flow !== "TREND") {
    return false;
  }

  const grade = getPresetGrade(row, preset);
  const minRrFloor = getPresetDynamicMinRrFloor(row, preset, grade);
  const rrOverride = confluence >= 90 && sniperScore >= 86 && rr >= 1.15;

  if (rr < minRrFloor && !rrOverride) return false;

  if (
    String(row.vol || "").toUpperCase() === "LOW" &&
    confluence < Number(preset.LOW_VOL_MIN_CONFLUENCE || 0)
  ) {
    return false;
  }

  if (
    flow === "NEUTRAL" &&
    confluence < Number(preset.NO_FLOW_MIN_CONFLUENCE || 0)
  ) {
    return false;
  }

  if (tfStrength < Number(preset.TF_MIN_STRENGTH || 0)) return false;

  if (confluence < Number(preset.GLOBAL_MIN_CONFLUENCE || 0)) return false;

  const obRel = String(row.obSideRelation || getObSideRelation(side, row.obBias)).toUpperCase();
  const obBias = String(row.obBias || "UNKNOWN").toUpperCase();

  if (
    obRel === "AGAINST" &&
    confluence < Number(preset.OB_AGAINST_MIN_CONFLUENCE || 0) &&
    !bullishMidTrendProbeOk
  ) {
    return false;
  }

  const badSpread = spread > Number(preset.MAX_SPREAD_PCT || 0);
  const badDepth = depth < Number(preset.MIN_DEPTH_USD_1P || 0);

  const midBullSpreadException =
    isBull &&
    rsiZone === "MID" &&
    flow === "TREND" &&
    confluence >= Number(preset.MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE || 0) &&
    sniperScore >= Number(preset.MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER || 0) &&
    rr >= Number(preset.A_ENTRY_MIN_RR || 0);

  if (
    isBull &&
    rsiZone === "MID" &&
    spread > Number(preset.MID_BULL_MAX_SPREAD_PCT || 0) &&
    !midBullSpreadException
  ) {
    return false;
  }

  if (
    (badSpread || badDepth) &&
    confluence < Number(preset.BAD_MARKET_QUALITY_MIN_CONFLUENCE || 0) &&
    !bullishMidTrendProbeOk
  ) {
    return false;
  }

  const neutralObException =
    (
      grade === "A" &&
      confluence >= Number(preset.NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE || 0) &&
      rr >= Number(preset.NEUTRAL_OB_A_EXCEPTION_MIN_RR || 0) &&
      sniperValid &&
      sniperScore >= Number(preset.NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER || 0)
    ) ||
    (
      grade === "B" &&
      confluence >= Number(preset.NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE || 0) &&
      rr >= Number(preset.NEUTRAL_OB_B_EXCEPTION_MIN_RR || 0) &&
      sniperValid &&
      sniperScore >= Number(preset.NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER || 0) &&
      score >= Number(preset.NEUTRAL_OB_B_EXCEPTION_MIN_SCORE || 0)
    );

  if (
    obBias === "NEUTRAL" &&
    confluence < Number(preset.OB_NEUTRAL_MIN_CONFLUENCE || 0) &&
    !neutralObException
  ) {
    return false;
  }

  if (
    Math.abs(funding) > Number(preset.EXTREME_FUNDING_ABS_MAX || 0) &&
    confluence < Number(preset.CROWDED_FUNDING_MIN_CONFLUENCE || 0)
  ) {
    return false;
  }

  if (
    isBull &&
    funding > Number(preset.BULL_CROWDED_FUNDING_MAX || 0) &&
    confluence < Number(preset.CROWDED_FUNDING_MIN_CONFLUENCE || 0)
  ) {
    return false;
  }

  if (
    !isBull &&
    funding < Number(preset.BEAR_CROWDED_FUNDING_MIN || 0) &&
    confluence < Number(preset.CROWDED_FUNDING_MIN_CONFLUENCE || 0)
  ) {
    return false;
  }

  const aSetupValid =
    grade === "A" &&
    !Boolean(row.spoof) &&
    rr >= Math.max(minRrFloor, Number(preset.A_ENTRY_MIN_RR || 0));

  const eliteEntry =
    aSetupValid &&
    sniperValid &&
    sniperScore >= Number(preset.A_MIN_SNIPER || 0) &&
    confluence >= Number(preset.A_MIN_CONFLUENCE || 0) &&
    rr >= Number(preset.A_ENTRY_MIN_RR || 0) &&
    tfStrength >= Number(preset.TF_MIN_STRENGTH || 0);

  const bSetupValid =
    grade === "B" &&
    !Boolean(row.spoof) &&
    rr >= Number(preset.B_ENTRY_MIN_RR || 0);

  const bEntry =
    preset.ENABLE_B_ENTRIES &&
    !eliteEntry &&
    bSetupValid &&
    sniperValid &&
    sniperScore >= Number(preset.B_MIN_SNIPER || 0) &&
    confluence >= Number(preset.B_MIN_CONFLUENCE || 0) &&
    rr >= Number(preset.B_ENTRY_MIN_RR || 0) &&
    tfStrength >= Number(preset.TF_MIN_STRENGTH || 0) &&
    flow === "TREND" &&
    obRel !== "AGAINST";

  const godModeEntry =
    eliteEntry &&
    sniperScore >= Number(preset.GOD_MIN_SNIPER || 0) &&
    confluence >= Number(preset.GOD_MIN_CONFLUENCE || 0) &&
    rr >= Number(preset.GOD_ENTRY_MIN_RR || 0);

  const btcExceptionEntry =
    btcBullishBearExceptionOk &&
    !Boolean(row.spoof) &&
    tfStrength >= Number(preset.TF_MIN_STRENGTH || 0) &&
    rr >= Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_RR || 0);

  const probeEntry =
    bullishMidTrendProbeOk &&
    !Boolean(row.spoof) &&
    tfStrength >= Number(preset.TF_MIN_STRENGTH || 0) &&
    rr >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_RR || 0);

  const shouldEnter =
    eliteEntry ||
    bEntry ||
    btcExceptionEntry ||
    probeEntry;

  if (!shouldEnter) return false;

  const setupClass = godModeEntry
    ? "GOD"
    : eliteEntry
      ? "A"
      : bEntry
        ? "B"
        : probeEntry
          ? "B_TREND_PROBE"
          : btcExceptionEntry
            ? "A_SHORT_EXCEPTION"
            : "NONE";

  if (depth <= 0) return false;
  if (depth < Number(preset.MIN_DEPTH_USD_1P_ABSOLUTE || 0)) return false;

  if (
    isBull &&
    flow === "TREND" &&
    depth < Number(preset.BULL_TREND_MIN_DEPTH_USD_1P || 0)
  ) {
    return false;
  }

  if (
    ["A", "GOD"].includes(setupClass) &&
    depth < Number(preset.A_MIN_DEPTH_USD_1P || 0)
  ) {
    return false;
  }

  if (isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) {
    return false;
  }

  if (
    isBull &&
    preset.REQUIRE_BULL_TREND_PULLBACK &&
    isBtcBullishState(btcState) &&
    flow === "TREND" &&
    rsiZone === "MID"
  ) {
    const distanceFromHigh = Number(row.distanceFromLocalHighPct || 0);

    const regularPullback =
      Boolean(row.pullbackConfirmed) ||
      Boolean(row.sweepConfirmed) ||
      Boolean(row.retestConfirmed) ||
      Boolean(row.fakeBreakout);

    const probeSoftPullback =
      probeEntry &&
      distanceFromHigh >= Number(preset.BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT || 0) &&
      distanceFromHigh <= Number(preset.MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT || 0);

    if (!regularPullback && !probeSoftPullback) return false;

    if (distanceFromHigh > Number(preset.MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT || 0)) {
      return false;
    }
  }

  const finalRr = estimateFinalRrForPreset(row, setupClass, preset);

  if (
    ["A", "GOD"].includes(setupClass) &&
    finalRr < Number(preset.A_FINAL_MIN_RR || 0)
  ) {
    return false;
  }

  if (
    setupClass === "A_SHORT_EXCEPTION" &&
    finalRr < Number(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_RR || 0)
  ) {
    return false;
  }

  if (
    setupClass === "B_TREND_PROBE" &&
    finalRr < Number(preset.BULLISH_MID_TREND_PROBE_MIN_RR || 0)
  ) {
    return false;
  }

  return true;
}

function scoreFullFilterStats(stats, keepRatio) {
  const winrate = Number(stats.winrateNum || 0);
  const avgR = Number(stats.avgR || 0);
  const totalR = Number(stats.totalR || 0);
  const profitFactor = clamp(Number(stats.profitFactorR || 0), 0, 5);
  const directSLPct = parsePct(stats.directSLPct) / 100;

  const sampleConfidence = clamp(
    Number(stats.completed || 0) / FILTER_OPTIMIZER_TARGET_COMPLETED,
    0.15,
    1
  );

  const rawScore =
    winrate * 100 +
    avgR * 50 +
    totalR * 0.20 +
    profitFactor * 8 +
    keepRatio * 8 -
    directSLPct * 35;

  return Number((rawScore * sampleConfidence).toFixed(4));
}

function evaluateFullFilterPreset(rows, preset) {
  const kept = rows.filter(row => rowPassesFullFilterPreset(row, preset));
  const stats = getOutcomeStats(kept);
  const keepRatio = rows.length ? kept.length / rows.length : 0;

  return {
    preset,
    kept: kept.length,
    rejected: rows.length - kept.length,
    keepRatio: Number(keepRatio.toFixed(4)),
    ...stats,
    decisionScore: scoreFullFilterStats(stats, keepRatio)
  };
}

function buildOptimizerUsableRows() {
  const outcomeRows = buildFeatureOutcomeRows();

  const realRows = outcomeRows.real || [];

  const completedShadowRows = (outcomeRows.shadow || [])
    .filter(row => row?.hasRiskGeometry)
    .filter(row => Boolean(row.win) || Boolean(row.loss))
    .filter(row => Number.isFinite(Number(row.pnlPct)));

  return realRows.length >= 25
    ? realRows
    : [...realRows, ...completedShadowRows];
}

function buildBestFullFilterPresetDecision() {
  const rows = buildOptimizerUsableRows()
    .filter(row => row?.hasRiskGeometry)
    .filter(row => Boolean(row.win) || Boolean(row.loss))
    .filter(row => Number.isFinite(Number(row.pnlPct)));

  const currentPreset = buildCurrentFullFilterPreset();
  const currentEval = evaluateFullFilterPreset(rows, currentPreset);

  if (rows.length < FILTER_OPTIMIZER_MIN_COMPLETED) {
    return {
      decision: "SAMPLE_TOO_SMALL_KEEP_CURRENT",
      sample: {
        usableRows: rows.length,
        minRequired: FILTER_OPTIMIZER_MIN_COMPLETED,
        confidence: "LOW"
      },
      best: currentEval,
      current: currentEval,
      missingFilters: [],
      testedFilterCount: fullFilterKeys().length
    };
  }

  let beam = [currentPreset];

  for (let pass = 0; pass < FILTER_OPTIMIZER_BEAM_PASSES; pass++) {
    const candidates = new Map();

    for (const preset of beam) {
      candidates.set(stablePresetKey(preset), preset);

      for (const key of fullFilterKeys()) {
        const currentValue = preset[key];
        const values = getFullFilterCandidates(key, currentValue);

        for (const value of values) {
          const nextPreset = {
            ...preset,
            [key]: value
          };

          candidates.set(stablePresetKey(nextPreset), nextPreset);
        }
      }
    }

    beam = Array.from(candidates.values())
      .map(preset => evaluateFullFilterPreset(rows, preset))
      .filter(result => Number(result.completed || 0) >= FILTER_OPTIMIZER_MIN_COMPLETED)
      .sort((a, b) => Number(b.decisionScore || 0) - Number(a.decisionScore || 0))
      .slice(0, FILTER_OPTIMIZER_BEAM_WIDTH)
      .map(result => result.preset);

    if (!beam.length) {
      beam = [currentPreset];
      break;
    }
  }

  const evaluated = beam
    .map(preset => evaluateFullFilterPreset(rows, preset))
    .sort((a, b) => Number(b.decisionScore || 0) - Number(a.decisionScore || 0));

  const best = evaluated[0] || currentEval;

  const missingFilters = fullFilterKeys().filter(key => {
    return !Object.prototype.hasOwnProperty.call(best.preset, key);
  });

  const deltaVsCurrent = {
    winrateDeltaPct: Number(((Number(best.winrateNum || 0) - Number(currentEval.winrateNum || 0)) * 100).toFixed(2)),
    avgRDelta: Number((Number(best.avgR || 0) - Number(currentEval.avgR || 0)).toFixed(4)),
    totalRDelta: Number((Number(best.totalR || 0) - Number(currentEval.totalR || 0)).toFixed(4)),
    profitFactorDelta: Number((Number(best.profitFactorR || 0) - Number(currentEval.profitFactorR || 0)).toFixed(4)),
    decisionScoreDelta: Number((Number(best.decisionScore || 0) - Number(currentEval.decisionScore || 0)).toFixed(4))
  };

  return {
    decision: missingFilters.length
      ? "BEST_PRESET_FOUND_BUT_FILTER_COVERAGE_INCOMPLETE"
      : "BEST_FULL_FILTER_AFSTELLING",

    sample: {
      usableRows: rows.length,
      confidence:
        rows.length >= 150
          ? "HIGH"
          : rows.length >= 60
            ? "MEDIUM"
            : "LOW"
    },

    best,
    current: currentEval,
    deltaVsCurrent,

    missingFilters,
    testedFilterCount: fullFilterKeys().length
  };
}

function buildPatchLinesFromPreset(preset) {
  return fullFilterKeys().map(key => {
    const value = preset[key];

    if (Array.isArray(value)) {
      return `const ${key} = ${JSON.stringify(value)};`;
    }

    if (typeof value === "string") {
      return `const ${key} = ${JSON.stringify(value)};`;
    }

    return `const ${key} = ${value};`;
  });
}

function buildMasterBestAfstellingLog({ btcState, runId }) {
  const decision = buildBestFullFilterPresetDecision();
  const bestPreset = decision.best?.preset || buildCurrentFullFilterPreset();

  return {
    tag: "TS_MASTER_BEST_AFSTELLING",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,
    ts: Date.now(),

    decision: decision.decision,

    sample: decision.sample,

    expectedPerformance: {
      completed: decision.best?.completed || 0,
      wins: decision.best?.wins || 0,
      losses: decision.best?.losses || 0,
      winrate: decision.best?.winrate || "0.0%",
      avgR: decision.best?.avgR || 0,
      totalR: decision.best?.totalR || 0,
      profitFactorR: decision.best?.profitFactorR || 0,
      directSLPct: decision.best?.directSLPct || "0.0%",
      keepRatio: decision.best?.keepRatio || 0,
      decisionScore: decision.best?.decisionScore || 0
    },

    deltaVsCurrent: decision.deltaVsCurrent || null,

    coverage: {
      testedFilterCount: decision.testedFilterCount,
      missingFilters: decision.missingFilters
    },

    bestAfstelling: bestPreset,

    patchLines: buildPatchLinesFromPreset(bestPreset)
  };
}

// ================= SCAN OBSERVATION (elke coin vóór filters) =================
function buildScanObservationRow({
  c,
  flow,
  sniper,
  confluence,
  rr,
  funding,
  ob,
  risk,
  btcState,
  regimeLevel,
  rsi,
  rsiHTF,
  rsiZone,
  rsiValid,
  rsiHtfBlocked,
  hasLiquidationData,
  isValidFakeBreakout,
  bullPullbackMeta,
  setupGrade,
  runId
}) {
  const entry = Number(c.price || risk?.entry || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);
  const side = String(c.side || "").toLowerCase();

  const hasRiskGeometry =
    entry > 0 &&
    sl > 0 &&
    tp > 0 &&
    Math.abs(entry - sl) > 0;

  const row = {
    id: `scan_${runId}_${c.symbol}_${side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    ts: Date.now(),

    source: "SCAN",
    action: "OBSERVE",
    reason: "SCAN_OBSERVED",
    entryReason: "SCAN_OBSERVED",

    symbol: normalizeBaseSymbol(c.symbol),
    side,

    stage: String(c.stage || "unknown").toLowerCase(),
    scannerStage: String(c.scannerStage || c.stage || "unknown").toLowerCase(),
    stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly),

    setupClass: "OBSERVED",
    grade: setupGrade?.grade || "C",
    gradePoints: Number(setupGrade?.points || 0),

    score: Number(c.moveScore || 0),
    confluence: Number(confluence || 0),

    sniper: sniper?.type || "NONE",
    sniperScore: Number(sniper?.score || 0),
    sniperValid: Boolean(sniper?.valid),

    flow: String(flow?.type || c.flow || "UNKNOWN").toUpperCase(),
    btcState: String(btcState || "UNKNOWN").toUpperCase(),
    regime: String(regimeLevel || "UNKNOWN").toUpperCase(),

    rsi: Number(rsi || 0),
    rsiHTF: Number(rsiHTF || 0),
    rsiZone: String(rsiZone || "UNKNOWN").toUpperCase(),
    rsiValid: Boolean(rsiValid),
    rsiHtfBlocked: Boolean(rsiHtfBlocked),

    structure: String(c.structure || "NEUTRAL").toUpperCase(),

    obBias: String(ob?.bias || "UNKNOWN").toUpperCase(),
    obSideRelation: getObSideRelation(side, ob?.bias || "UNKNOWN"),
    spreadPct: Number(ob?.spreadPct || 0),
    depthMinUsd1p: Number(ob?.depthMinUsd1p || 0),
    spoof: Boolean(ob?.spoof),
    obFetchFailed: Boolean(ob?.fetchFailed),

    funding: Number(funding?.rate || 0),

    tfScore: Number(c.tfScore || 0),
    tfStrength: Number(c.tfStrength || 0),
    tfAlignment: String(c.tfAlignment || "UNKNOWN").toUpperCase(),

    change1h: Number(c.change1h || 0),
    change24: Number(c.change24 || 0),
    vol: String(getVolatility(c) || "UNKNOWN").toUpperCase(),

    plannedRR: Number(rr || 0),
    baseRR: Number(rr || 0),
    finalRr: Number(rr || 0),

    entry,
    sl,
    tp,
    hasRiskGeometry,

    hasLiquidationData: Boolean(hasLiquidationData),
    fakeBreakout: Boolean(isValidFakeBreakout),

    pullbackConfirmed: Boolean(bullPullbackMeta?.pullbackConfirmed),
    sweepConfirmed: Boolean(bullPullbackMeta?.sweepConfirmed),
    retestConfirmed: Boolean(bullPullbackMeta?.retestConfirmed),
    distanceFromLocalHighPct: Number(bullPullbackMeta?.distanceFromLocalHighPct || 0),

    isCounterBtc:
      (String(btcState).toUpperCase() === "BULLISH" && side === "bear") ||
      (String(btcState).toUpperCase() === "BEARISH" && side === "bull") ||
      (String(btcState).toUpperCase() === "STRONG_BULL" && side === "bear") ||
      (String(btcState).toUpperCase() === "STRONG_BEAR" && side === "bull"),

    fromOpenPosition: false,
    analysisType: c.analysisType || "DEEP",

    strategyVersion: STRATEGY_VERSION
  };

  return enrichFeatureBuckets(row);
}

function createScanShadowOutcome(row) {
  return {
    ...row,

    id: `scan_shadow_${row.runId}_${row.symbol}_${row.side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    shadowDedupeKey: getShadowDedupeKey(row),

    source: "SCAN_SHADOW",
    action: "OBSERVE",
    status: "OPEN",

    createdAt: Date.now(),
    monitorUntil: Date.now() + SHADOW_MONITOR_MS,
    lastCheckedAt: 0,

    ticks: 0,

    exit: null,
    exitR: null,
    pnlPct: null,

    win: false,
    loss: false,
    flat: false,

    mfeR: 0,
    maeR: 0,
    maxPnlPct: 0,
    minPnlPct: 0,

    maxPrice: Number(row.entry || 0),
    minPrice: Number(row.entry || 0),

    hitTP: false,
    hitSL: false,

    completedAt: null
  };
}

function recordScanObservation(row) {
  if (!row?.symbol || !row?.side) return;

  if (!Array.isArray(auditState.featureStore)) {
    auditState.featureStore = [];
  }

  if (!Array.isArray(auditState.shadowOutcomes)) {
    auditState.shadowOutcomes = [];
  }

  auditState.featureStore.push(row);

  if (row.hasRiskGeometry && !hasRecentShadowOutcome(row)) {
    auditState.shadowOutcomes.push(createScanShadowOutcome(row));
  }

  trimAuditArrays();
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
    initialSl: position.initialSl,
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
    strategyVersion: STRATEGY_VERSION,

    // Probe and exception flags
    bullishMidTrendProbe: Boolean(position.bullishMidTrendProbe),
    bullishMidTrendProbeReason: position.bullishMidTrendProbeReason || null,
    btcBullishBearException: Boolean(position.btcBullishBearException),
    btcBullishBearExceptionReason: position.btcBullishBearExceptionReason || null
  });

  if (auditState.recentEntries.length > MAX_RECENT_ENTRY_AUDIT_ROWS) {
    auditState.recentEntries.shift();
  }
}

function recordExit(exitPayload, pos, exitPrice, isBull) {
  const executionPrice = Number(exitPrice || 0);
  const triggerPrice = Number(exitPayload?.triggerPrice || executionPrice || 0);

  const r = calculateExitR(pos, executionPrice, isBull);
  const pnlPct = calculatePnlPct(pos, executionPrice, isBull);

  const triggerR = calculateExitR(pos, triggerPrice, isBull);
  const triggerPnlPct = calculatePnlPct(pos, triggerPrice, isBull);

  const holdMs = Date.now() - Number(pos.createdAt || Date.now());
  const pathFields = buildPathExitFields(pos, exitPayload.reason);

  auditState.exits++;
  auditState.rTotal += r;
  auditState.pnlPctTotal += pnlPct;

  if (r > 0) auditState.wins++;
  else if (r < 0) auditState.losses++;

  incrementMapCount(auditState.exitReasonCounts, exitPayload.reason);

  exitPayload.exit = executionPrice;
  exitPayload.executionPrice = executionPrice;
  exitPayload.triggerPrice = triggerPrice;

  exitPayload.exitR = Number(r.toFixed(3));
  exitPayload.pnlPct = Number(pnlPct.toFixed(3));
  exitPayload.triggerR = Number(triggerR.toFixed(3));
  exitPayload.triggerPnlPct = Number(triggerPnlPct.toFixed(3));

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
    exit: executionPrice,
    executionPrice,
    triggerPrice,
    sl: Number(pos.sl || 0),
    initialSl: Number(pos.initialSl || pos.sl || 0),
    finalSl: Number(pos.sl || 0),
    tp: Number(pos.tp || 0),

    plannedRR: Number(pos.rr || 0),
    baseRR: Number(pos.baseRR || 0),
    tpRewardMultiplier: Number(pos.tpRewardMultiplier || 1),

    exitR: Number(r.toFixed(3)),
    pnlPct: Number(pnlPct.toFixed(3)),
    triggerR: Number(triggerR.toFixed(3)),
    triggerPnlPct: Number(triggerPnlPct.toFixed(3)),
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

    bullishMidTrendProbe: Boolean(pos.bullishMidTrendProbe),
    bullishMidTrendProbeReason: pos.bullishMidTrendProbeReason || null,

    btcBullishBearException: Boolean(pos.btcBullishBearException),
    btcBullishBearExceptionReason: pos.btcBullishBearExceptionReason || null,

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
    initialSl: pos.initialSl,
    tp: pos.tp,
    rr: formatRR(pos.rr),
    currentR: Number(Number(pos.currentR || 0).toFixed(3)),
    mfeR: Number(Number(pos.mfeR || 0).toFixed(3)),
    maeR: Number(Number(pos.maeR || 0).toFixed(3)),
    maxTpProgress: Number(Number(pos.maxTpProgress || 0).toFixed(3)),
    reachedHalfR: Boolean(pos.reachedHalfR),
    reachedOneR: Boolean(pos.reachedOneR),
    nearTpSeen: Boolean(pos.nearTpSeen),
    breakEvenActivated: Boolean(pos.breakEvenActivated),
    breakEvenSl: pos.breakEvenSl ?? null,
    slBeforeBreakEven: pos.slBeforeBreakEven ?? null,
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
      reasonExamples[reasonKey].push(
        `${row.symbol}_${row.side}_${row.stage}_${row.score}_rsi=${row.rsiZone || "NA"}_conf=${row.confluence ?? "NA"}_sniper=${row.sniperScore ?? "NA"}`
      );
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
  const wins = trades.filter(t => Number(t.exitR || 0) > 0).length;
  const losses = trades.filter(t => Number(t.exitR || 0) < 0).length;
  const total = wins + losses;

  const directSL = trades.filter(t => Boolean(t.directToSL)).length;
  const slAfterHalfR = trades.filter(t => Boolean(t.slAfterHalfR)).length;
  const slAfterOneR = trades.filter(t => Boolean(t.slAfterOneR)).length;
  const slAfterNearTp = trades.filter(t => Boolean(t.slAfterNearTp)).length;
  const nearTp = trades.filter(t => Boolean(t.nearTpSeen)).length;
  const reachedHalfR = trades.filter(t => Boolean(t.reachedHalfR)).length;
  const reachedOneR = trades.filter(t => Boolean(t.reachedOneR)).length;
  const breakEvenStops = trades.filter(t => Boolean(t.breakEvenStop)).length;

  return {
    trades: trades.length,
    wins,
    losses,
    winrate: formatWinrate(wins, total),

    totalR: Number(safeSum(trades.map(t => Number(t.exitR || 0))).toFixed(3)),
    avgR: Number(safeAvg(trades.map(t => Number(t.exitR || 0))).toFixed(3)),

    totalPnlPct: Number(safeSum(trades.map(t => Number(t.pnlPct || 0))).toFixed(3)),
    avgPnlPct: Number(safeAvg(trades.map(t => Number(t.pnlPct || 0))).toFixed(3)),

    avgTriggerR: Number(safeAvg(trades.map(t => Number(t.triggerR || 0))).toFixed(3)),
    avgTriggerPnlPct: Number(safeAvg(trades.map(t => Number(t.triggerPnlPct || 0))).toFixed(3)),

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

    breakEvenStops,
    breakEvenStopPct: trades.length ? `${((breakEvenStops / trades.length) * 100).toFixed(1)}%` : "0.0%",

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
    return Number(t.exitR || 0) < 0;
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
      avgTriggerR: 0,
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
    avgTriggerR: Number(safeAvg(losers.map(t => Number(t.triggerR || 0))).toFixed(3)),
    avgTriggerPnlPct: Number(safeAvg(losers.map(t => Number(t.triggerPnlPct || 0))).toFixed(3)),
    avgMfeR: Number(safeAvg(losers.map(t => Number(t.mfeR || 0))).toFixed(3)),
    avgMaeR: Number(safeAvg(losers.map(t => Number(t.maeR || 0))).toFixed(3)),
    avgTicksToMae: Number(safeAvg(losers.map(t => Number(t.ticksToMae || 0))).toFixed(1)),
    avgAdverseTicks: Number(safeAvg(losers.map(t => Number(t.adverseTicks || 0))).toFixed(1)),
    directSLCount: losers.filter(t => Boolean(t.directToSL)).length,
    slAfterHalfRCount: losers.filter(t => Boolean(t.slAfterHalfR)).length,
    slAfterOneRCount: losers.filter(t => Boolean(t.slAfterOneR)).length,
    slAfterNearTpCount: losers.filter(t => Boolean(t.slAfterNearTp)).length,
    directSLExamples: losers.filter(t => Boolean(t.directToSL)).slice(-8).map(t => `${t.symbol}_${t.side}_${t.mfeR}mfe_${t.maeR}mae_triggerR=${t.triggerR}`),
    pullbackAfterProfitExamples: losers.filter(t => Boolean(t.slAfterHalfR) || Boolean(t.slAfterNearTp)).slice(-8).map(t => `${t.symbol}_${t.side}_${t.mfeR}mfe_${t.maeR}mae`)
  };
}

function buildWinnerProfile() {
  const winners = (auditState.closedTrades || []).filter(t => {
    return Number(t.exitR || 0) > 0;
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
      avgTriggerR: 0,
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
    avgTriggerR: Number(safeAvg(winners.map(t => Number(t.triggerR || 0))).toFixed(3)),
    avgTriggerPnlPct: Number(safeAvg(winners.map(t => Number(t.triggerPnlPct || 0))).toFixed(3)),
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
  const losers = closed.filter(t => Number(t.exitR || 0) < 0);
  const winners = closed.filter(t => Number(t.exitR || 0) > 0);

  const directSL = losers.filter(t => Boolean(t.directToSL));
  const slAfterHalfR = losers.filter(t => Boolean(t.slAfterHalfR));
  const slAfterOneR = losers.filter(t => Boolean(t.slAfterOneR));
  const slAfterNearTp = losers.filter(t => Boolean(t.slAfterNearTp));
  const breakEvenStops = closed.filter(t => Boolean(t.breakEvenStop));

  return {
    tag: "TS_OPTIMIZER_MFE_MAE",
    strategyVersion: STRATEGY_VERSION,
    ts: Date.now(),

    sample: {
      closedTrades: closed.length,
      winners: winners.length,
      losers: losers.length,
      breakEvenStops: breakEvenStops.length,
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
        examples: directSL.slice(-10).map(t => `${t.symbol}_${t.side}_mfe=${t.mfeR}_mae=${t.maeR}_ticksToMae=${t.ticksToMae}_triggerR=${t.triggerR}`)
      },

      didLosersAlmostHitTPBeforeSL: {
        count: slAfterNearTp.length,
        pctOfLosers: losers.length ? `${((slAfterNearTp.length / losers.length) * 100).toFixed(1)}%` : "0.0%",
        examples: slAfterNearTp.slice(-10).map(t => `${t.symbol}_${t.side}_tpProgress=${t.maxTpProgress}_mfe=${t.mfeR}_mae=${t.maeR}`)
      },

      breakEvenStops: {
        count: breakEvenStops.length,
        pctOfClosed: closed.length ? `${((breakEvenStops.length / closed.length) * 100).toFixed(1)}%` : "0.0%",
        avgExitR: Number(safeAvg(breakEvenStops.map(t => Number(t.exitR || 0))).toFixed(3)),
        avgTriggerR: Number(safeAvg(breakEvenStops.map(t => Number(t.triggerR || 0))).toFixed(3)),
        examples: breakEvenStops.slice(-10).map(t => `${t.symbol}_${t.side}_exitR=${t.exitR}_triggerR=${t.triggerR}_mfe=${t.mfeR}_mae=${t.maeR}`)
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
      ifBreakEvenStopsTooHigh: "BE works defensively but may cap winners if avg post-exit maxR is high",
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
      triggerR: t.triggerR,
      pnlPct: t.pnlPct,
      triggerPnlPct: t.triggerPnlPct,
      executionPrice: t.executionPrice,
      triggerPrice: t.triggerPrice,
      mfeR: t.mfeR,
      maeR: t.maeR,
      maxTpProgress: t.maxTpProgress,
      reachedHalfR: t.reachedHalfR,
      reachedOneR: t.reachedOneR,
      nearTpSeen: t.nearTpSeen,
      breakEvenActivated: t.breakEvenActivated,
      breakEvenStop: t.breakEvenStop,
      breakEvenSl: t.breakEvenSl,
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
      reason: "Spread threshold backtest on closed sample"
    });
  }

  const losers = closed.filter(t => Number(t.exitR || 0) < 0);
  const directSLCount = losers.filter(t => Boolean(t.directToSL)).length;
  const slAfterHalfRCount = losers.filter(t => Boolean(t.slAfterHalfR)).length;
  const slAfterNearTpCount = losers.filter(t => Boolean(t.slAfterNearTp)).length;
  const breakEvenStops = closed.filter(t => Boolean(t.breakEvenStop));

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
        currentValue: "enabled A/GOD after +0.5R",
        suggestedValue: "keep active; validate with post-exit maxR",
        confidence: closed.length >= 20 ? "HIGH" : "MEDIUM",
        action: "KEEP_BE_AND_MONITOR",
        reason: `${slAfterHalfRCount}/${losers.length} losers first reached +0.5R then hit SL`
      });
    }

    if (slAfterNearTpCount / losers.length >= 0.25) {
      pushRecommendation({
        parameter: "TP_REWARD_MULTIPLIER",
        currentValue: `A/GOD max ${A_GOD_MAX_TP_REWARD_MULTIPLIER}`,
        suggestedValue: "keep cap or exit at 80% TP progress",
        confidence: closed.length >= 20 ? "HIGH" : "MEDIUM",
        action: "REDUCE_TP_OR_TRAIL",
        reason: `${slAfterNearTpCount}/${losers.length} losers nearly hit TP before SL`
      });
    }
  }

  if (breakEvenStops.length >= 5) {
    pushRecommendation({
      parameter: "BREAK_EVEN_RULE",
      currentValue: `${BREAK_EVEN_TRIGGER_R}R trigger / ${BREAK_EVEN_LOCK_R}R lock`,
      suggestedValue: "review post-exit follow-through before tightening",
      confidence: closed.length >= 20 ? "HIGH" : "MEDIUM",
      action: "MONITOR_BE_STOPS",
      reason: `${breakEvenStops.length} BE stops detected`
    });
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
      change: "break-even is active; validate if it improves average R",
      why: `${slAfterHalfRCount}/${losses} losers reached +0.5R before SL`
    });
  }

  if (losses >= 3 && slAfterNearTpCount / losses >= 0.25) {
    hints.push({
      priority: 1,
      target: "NEAR_TP_THEN_SL",
      change: "TP cap is now 1.30; monitor nearTP + BE interaction",
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
      change: "increase TP reward-distance only after post-exit confirms TP too early",
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

  if (topReason?.reason === "MID_BULL_SPREAD_TOO_WIDE" && topReasonPct >= 15) {
    hints.push({
      priority: 4,
      target: "MID_BULL_SPREAD",
      change: "keep filter; MID bull entries need tighter execution quality",
      why: `MID bull spread pressure: ${topReasonPct.toFixed(1)}%`
    });
  }

  if (topReason?.reason === "LOW_FINAL_RR" && topReasonPct >= 15) {
    hints.push({
      priority: 4,
      target: "A_FINAL_RR",
      change: "do not lower final RR until A/GOD sample proves over-filtering",
      why: `final adjusted RR pressure: ${topReasonPct.toFixed(1)}%`
    });
  }

  if (topReason?.reason === "RSI_SHORT_TOO_LOW_A_ONLY" && topReasonPct >= 10) {
    hints.push({
      priority: 2,
      target: "SHORT_LOWER_RSI_BLOCK",
      change: "keep blocking short entries in LOWER RSI zones during A-only tuning",
      why: `oversold shorts are being filtered: ${topReasonPct.toFixed(1)}% current rejects`
    });
  }

  if (topReason?.reason === "B_DISABLED_A_ONLY" && topReasonPct >= 10) {
    hints.push({
      priority: 2,
      target: "A_ONLY_MODE",
      change: "keep B disabled until A cohort has enough clean closed trades",
      why: `B setups are intentionally excluded: ${topReasonPct.toFixed(1)}% current rejects`
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
  const bestSetupAdvice = buildBestSetupAdvice();

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
      avgWinnerTriggerR: winnerProfile.avgTriggerR,
      avgLoserTriggerR: loserProfile.avgTriggerR,
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
            : reasonTable[0]?.reason === "RSI_SHORT_TOO_LOW_A_ONLY"
              ? "oversold_short_entries_blocked_for_a_only_tuning"
              : reasonTable[0]?.reason === "B_DISABLED_A_ONLY"
                ? "b_setups_intentionally_disabled_for_a_only_tuning"
                : reasonTable[0]?.reason === "BTC_NEUTRAL_LOW_SCORE"
                  ? "btc_neutral_gate_filters_many_mid_score_candidates"
                  : reasonTable[0]?.reason === "LOW_FINAL_RR"
                    ? "final_adjusted_rr_filters_weak_A_GOD_payoff"
                    : reasonTable[0]?.reason === "MID_BULL_SPREAD_TOO_WIDE"
                      ? "mid_bull_entries_need_tighter_spread"
                      : "see_top_reason"
    },

    currentFilterValues: CURRENT_FILTER_VALUES,
    recommendedValues: recommendedValues.recommendations,
    actionHints,

    featureOptimizer: bestSetupAdvice,

    openPositions: buildOpenPositionRows(),

    closedTradeSample: closed.slice(-30)
  };
}

function logOptimizerReport({ reasonTable, btcState, runId }) {
  const masterLog = buildMasterBestAfstellingLog({
    btcState,
    runId
  });

  console.log("TS_MASTER_BEST_AFSTELLING", JSON.stringify(masterLog));

  return masterLog;
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

  // console.log("TS_AUDIT_SNAPSHOT", JSON.stringify(snapshot)); // UITGESCHAKELD

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

  recordActionFeatureRows(finalActions, btcState, runId);

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
    await updateShadowFeatureOutcomes();

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
            initialSl: pos.initialSl,
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
        applyBreakEvenRule(pos, isBull);

        const hitTP = isBull
          ? c.price >= pos.tp
          : c.price <= pos.tp;

        const hitSL = isBull
          ? c.price <= pos.sl
          : c.price >= pos.sl;

        if (hitTP || hitSL) {
          const reason = hitTP
            ? "TP"
            : pos.breakEvenActivated
              ? "BE_SL"
              : "SL";

          const triggerPrice = Number(c.price);
          const executionPrice = hitTP
            ? Number(pos.tp)
            : Number(pos.sl);

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
            exit: executionPrice,
            executionPrice,
            triggerPrice,
            sl: pos.sl,
            initialSl: pos.initialSl,
            tp: pos.tp,
            slSource: pos.slSource || "N/A",
            tpSource: pos.tpSource || "N/A",
            rsi: pos.rsi,
            rsiHTF: pos.rsiHTF,
            rsiZone: pos.rsiZone
          };

          recordExit(exitPayload, pos, executionPrice, isBull);

          if (shouldLog) {
            const exitResult = Number(exitPayload.exitR || 0) > 0
              ? "WIN"
              : Number(exitPayload.exitR || 0) < 0
                ? "LOSS"
                : "FLAT";

            await logTrade({
              symbol: c.symbol,
              side: c.side,
              setupClass: pos.setupClass || "UNKNOWN",
              entry: pos.entry,
              exit: executionPrice,
              executionPrice,
              triggerPrice,
              sl: pos.sl,
              initialSl: pos.initialSl,
              tp: pos.tp,
              result: exitResult,
              reason,
              rr: pos.rr,
              baseRR: pos.baseRR,
              tpRewardMultiplier: pos.tpRewardMultiplier,
              exitR: exitPayload.exitR,
              triggerR: exitPayload.triggerR,
              pnlPct: exitPayload.pnlPct,
              triggerPnlPct: exitPayload.triggerPnlPct,
              holdMinutes: exitPayload.holdMinutes,

              mfeR: exitPayload.mfeR,
              maeR: exitPayload.maeR,
              maxTpProgress: exitPayload.maxTpProgress,
              reachedHalfR: exitPayload.reachedHalfR,
              reachedOneR: exitPayload.reachedOneR,
              nearTpSeen: exitPayload.nearTpSeen,
              breakEvenActivated: exitPayload.breakEvenActivated,
              breakEvenStop: exitPayload.breakEvenStop,
              breakEvenSl: exitPayload.breakEvenSl,
              slBeforeBreakEven: exitPayload.slBeforeBreakEven,
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
          breakEvenActivated: Boolean(pos.breakEvenActivated),
          breakEvenSl: pos.breakEvenSl ?? null,
          slBeforeBreakEven: pos.slBeforeBreakEven ?? null,
          entry: pos.entry,
          sl: pos.sl,
          initialSl: pos.initialSl,
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
      // V11_3: BTC-bullish shorts worden niet vroeg geblokt.
      // Ze worden later na RSI/OB/RR/confluence alleen via BTC_BULLISH_BEAR_EXCEPTION toegelaten.
      const btcBullishBearNeedsException =
        !isBull &&
        isBtcBullishState(btcState);

      if (btcState === "STRONG_BEAR" && isBull) {
        actions.push(buildWait(c, "BTC_STRONG_BEAR_BLOCK_LONG", flow, null, 0, 0, funding, obData, null, null, null, null));
        continue;
      }

      if (btcState === "BEARISH" && isBull && Number(c.moveScore || 0) < BTC_BEARISH_LONG_MIN_SCORE) {
        actions.push(buildWait(c, "BTC_BEARISH_WEAK_LONG", flow, null, 0, 0, funding, obData, null, null, null, null));
        continue;
      }

      if (btcState === "NEUTRAL" && Number(c.moveScore || 0) < BTC_NEUTRAL_MIN_SCORE) {
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

      // ================= BTC-BULLISH BEAR EXCEPTION =================
      let btcBullishBearExceptionCheck = {
        ok: true,
        exception: false,
        reason: "BTC_NOT_BULLISH"
      };

      if (btcBullishBearNeedsException) {
        btcBullishBearExceptionCheck = validateBtcBullishShortException({
          symbol: c.symbol,
          side: c.side,
          stage: c.stage,
          btcState,
          rsiZone,
          flow: flow.type,
          obBias: obData.bias,
          spreadPct: obData.spreadPct,
          depthMinUsd1p: obData.depthMinUsd1p,
          confluence,
          plannedRR: rr,
          sniperScore
        });

        c._debugBtcBullishBearException = Boolean(btcBullishBearExceptionCheck.exception);
        c._debugBtcBullishBearExceptionReason = btcBullishBearExceptionCheck.reason;
        c._debugBtcBullishBearExceptionChecks = btcBullishBearExceptionCheck.checks || null;

        if (!btcBullishBearExceptionCheck.ok) {
          actions.push(buildWait(
            c,
            btcBullishBearExceptionCheck.reason || "BTC_BULLISH_WEAK_SHORT",
            flow,
            sniper,
            confluence,
            rr,
            funding,
            obData,
            riskBase,
            null,
            null,
            null
          ));
          continue;
        }
      }

      const btcBullishBearExceptionOk = Boolean(btcBullishBearExceptionCheck.exception);

      // ================= BULLISH MID TREND PROBE CHECK =================
      const bullishMidTrendProbeCheck = validateBullishMidTrendProbe({
        symbol: c.symbol,
        side: c.side,
        stage: c.stage,
        btcState,
        rsiZone,
        flow: flow.type,
        obBias: obData.bias,
        spreadPct: obData.spreadPct,
        depthMinUsd1p: obData.depthMinUsd1p,
        confluence,
        plannedRR: rr,
        sniperScore
      });

      const bullishMidTrendProbeOk = Boolean(bullishMidTrendProbeCheck.ok);

      c._debugBullishMidTrendProbe = bullishMidTrendProbeOk;
      c._debugBullishMidTrendProbeReason = bullishMidTrendProbeCheck.reason;
      c._debugBullishMidTrendProbeChecks = bullishMidTrendProbeCheck.checks;

      // ================= SHORT LOWER RSI BLOCK MET EXCEPTIE =================
      const allowLowerOneShortContinuation =
        !isBull &&
        rsiZone === "LOWER_1" &&
        flow.type === "TREND" &&
        confluence >= SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE &&
        sniperScore >= SHORT_LOWER1_CONTINUATION_MIN_SNIPER &&
        rr >= SHORT_LOWER1_CONTINUATION_MIN_RR &&
        SHORT_LOWER1_ALLOWED_BTC_STATES.includes(btcState);

      if (
        !isBull &&
        SHORT_BLOCKED_RSI_ZONES.includes(rsiZone) &&
        !allowLowerOneShortContinuation &&
        !btcBullishBearExceptionOk
      ) {
        actions.push(buildWait(
          c,
          "RSI_SHORT_TOO_LOW_A_ONLY",
          flow,
          sniper,
          confluence,
          rr,
          funding,
          obData,
          riskBase,
          null,
          null,
          null
        ));
        continue;
      }

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

      const bullPullbackMeta = getBullPullbackMeta({
        c,
        candles15m,
        fakeBreakoutConfirmed: isValidFakeBreakout
      });

      c._debugPullbackConfirmed = bullPullbackMeta.pullbackConfirmed;
      c._debugSweepConfirmed = bullPullbackMeta.sweepConfirmed;
      c._debugRetestConfirmed = bullPullbackMeta.retestConfirmed;
      c._debugDistanceFromLocalHighPct = bullPullbackMeta.distanceFromLocalHighPct;

      // ================= SCAN OBSERVATION (elke coin vóór filters) =================
      const scanSetupGrade = getSetupGrade({
        c,
        ob: obData,
        flow,
        sniper,
        confluence,
        rr,
        hasLiquidationData,
        isBull
      });

      recordScanObservation(buildScanObservationRow({
        c,
        flow,
        sniper,
        confluence,
        rr,
        funding,
        ob: obData,
        risk: riskBase,
        btcState,
        regimeLevel,
        rsi,
        rsiHTF: rsiSignal.mean1h || null,
        rsiZone,
        rsiValid: rsi !== null,
        rsiHtfBlocked: Boolean(rsiSignal?.blocked),
        hasLiquidationData,
        isValidFakeBreakout,
        bullPullbackMeta,
        setupGrade: scanSetupGrade,
        runId
      }));

      // ================= RSI LOGIC =================
      const baseTrendContinuationRSI =
        flow.type === "TREND" &&
        confluence >= TREND_CONTINUATION_MIN_CONFLUENCE &&
        rr >= TREND_CONTINUATION_MIN_RR &&
        sniperScore >= TREND_CONTINUATION_MIN_SNIPER &&
        (
          (isBull && ["MID", "LOWER_1"].includes(rsiZone)) ||
          (!isBull && ["MID", "UPPER_1"].includes(rsiZone))
        );

      const trendContinuationRSI =
        baseTrendContinuationRSI ||
        bullishMidTrendProbeOk;

      const earlyRSI =
        (isBull && rsiZone === "LOWER_1" && sniperScore >= EARLY_RSI_MIN_SNIPER) ||
        (!isBull && rsiZone === "UPPER_1" && sniperScore >= EARLY_RSI_MIN_SNIPER);

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
          allowLowerOneShortContinuation ||
          btcBullishBearExceptionOk;

        if (!rsiOK) {
          actions.push(buildWait(c, "RSI_SHORT_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
          continue;
        }
      }

      if (isBull && rsiZone === "LOWER_2" && Number(c.change1h || 0) > LONG_LOWER2_MAX_1H_CHANGE) {
        actions.push(buildWait(c, "RSI_NOT_DEEP_ENOUGH", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
        continue;
      }

      if (!isBull && rsiZone === "UPPER_2" && Number(c.change1h || 0) < SHORT_UPPER2_MIN_1H_CHANGE) {
        actions.push(buildWait(c, "RSI_NOT_HIGH_ENOUGH", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
        continue;
      }

      if (rsiZone === "MID" && !trendContinuationRSI && confluence < MID_RSI_MIN_CONFLUENCE) {
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
        Math.abs(Number(c.change1h || 0)) > STRONG_MOMENTUM_MIN_1H_MOVE_PCT &&
        Math.abs(Number(c.change24 || 0)) > STRONG_MOMENTUM_MIN_24H_MOVE_PCT &&
        (flow.type === "TREND" || flow.type === "BUILDING");

      const softMomentum =
        Math.abs(Number(c.change1h || 0)) > SOFT_MOMENTUM_MIN_1H_MOVE_PCT &&
        Math.abs(Number(c.change24 || 0)) > SOFT_MOMENTUM_MIN_24H_MOVE_PCT &&
        flow.type === "TREND";

      const eliteMomentumBypass =
        flow.type === "TREND" &&
        confluence >= ELITE_MOMENTUM_MIN_CONFLUENCE &&
        sniperScore >= A_MIN_SNIPER &&
        rr >= A_ENTRY_MIN_RR &&
        Math.abs(Number(c.change1h || 0)) >= ELITE_MOMENTUM_MIN_1H_MOVE_PCT;

      const bullishMidTrendProbeMomentumBypass =
        bullishMidTrendProbeOk &&
        flow.type === "TREND" &&
        Math.abs(Number(c.change1h || 0)) >= BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT &&
        Math.abs(Number(c.change24 || 0)) >= BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT &&
        Number(c.moveScore || 0) >= 75;

      if (
        !strongMomentum &&
        !softMomentum &&
        !eliteMomentumBypass &&
        !bullishMidTrendProbeMomentumBypass
      ) {
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

      if (vol === "LOW" && confluence < LOW_VOL_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if (flow.type === "NEUTRAL" && confluence < NO_FLOW_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if (c.tfStrength < TF_MIN_STRENGTH) {
        actions.push(buildWait(c, "ENTRY_FILTERED_TF_WEAK", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if (confluence < GLOBAL_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, GLOBAL_MIN_CONFLUENCE, null));
        continue;
      }

      const obAgainst = isObAgainstSide(obData, isBull);

      if (obAgainst && confluence < OB_AGAINST_MIN_CONFLUENCE && !bullishMidTrendProbeOk) {
        actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      const spread = normalizeSpread(obData.spreadPct);
      const badSpread = spread > MAX_SPREAD_PCT;
      const badDepth = Number(obData.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;

      // ================= MID BULL SPREAD EXCEPTION =================
      const midBullSpreadException =
        isBull &&
        rsiZone === "MID" &&
        flow.type === "TREND" &&
        confluence >= MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE &&
        sniperScore >= MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER &&
        rr >= A_ENTRY_MIN_RR;

      if (
        isBull &&
        rsiZone === "MID" &&
        spread > MID_BULL_MAX_SPREAD_PCT &&
        !midBullSpreadException
      ) {
        actions.push(buildWait(c, "MID_BULL_SPREAD_TOO_WIDE", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if ((badSpread || badDepth) && confluence < BAD_MARKET_QUALITY_MIN_CONFLUENCE && !bullishMidTrendProbeOk) {
        actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if (
        obData.bias === "NEUTRAL" &&
        confluence < OB_NEUTRAL_MIN_CONFLUENCE &&
        !isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend })
      ) {
        actions.push(buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      const fundingRate = Number(funding?.rate || 0);

      if (Math.abs(fundingRate) > EXTREME_FUNDING_ABS_MAX && confluence < CROWDED_FUNDING_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if (isBull && fundingRate > BULL_CROWDED_FUNDING_MAX && confluence < CROWDED_FUNDING_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      if (!isBull && fundingRate < BEAR_CROWDED_FUNDING_MIN && confluence < CROWDED_FUNDING_MIN_CONFLUENCE) {
        actions.push(buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      // ================= A/GOD/B + BTC-BULLISH BEAR EXCEPTION ENTRY ONLY =================
      const aSetupValid =
        stageOK &&
        setupGrade.grade === "A" &&
        !obData.spoof &&
        rr >= Math.max(minRrFloor, A_ENTRY_MIN_RR);

      const eliteEntry =
        aSetupValid &&
        sniper?.valid &&
        sniperScore >= A_MIN_SNIPER &&
        confluence >= A_MIN_CONFLUENCE &&
        rr >= A_ENTRY_MIN_RR &&
        c.tfStrength >= TF_MIN_STRENGTH;

      const bSetupValid =
        stageOK &&
        setupGrade.grade === "B" &&
        !obData.spoof &&
        rr >= B_ENTRY_MIN_RR;

      const bEntry =
        ENABLE_B_ENTRIES &&
        !eliteEntry &&
        bSetupValid &&
        sniper?.valid &&
        sniperScore >= B_MIN_SNIPER &&
        confluence >= B_MIN_CONFLUENCE &&
        rr >= B_ENTRY_MIN_RR &&
        c.tfStrength >= TF_MIN_STRENGTH &&
        flow.type === "TREND" &&
        !obAgainst;

      const godModeEntry =
        eliteEntry &&
        sniperScore >= GOD_MIN_SNIPER &&
        confluence >= GOD_MIN_CONFLUENCE &&
        rr >= GOD_ENTRY_MIN_RR;

      const btcBullishBearExceptionEntry =
        btcBullishBearExceptionOk &&
        stageOK &&
        !obData.spoof &&
        c.tfStrength >= TF_MIN_STRENGTH &&
        rr >= BTC_BULLISH_BEAR_EXCEPTION_MIN_RR;

      const bullishMidTrendProbeEntry =
        bullishMidTrendProbeOk &&
        stageOK &&
        !obData.spoof &&
        c.tfStrength >= TF_MIN_STRENGTH &&
        rr >= BULLISH_MID_TREND_PROBE_MIN_RR;

      const shouldEnter =
        eliteEntry ||
        bEntry ||
        btcBullishBearExceptionEntry ||
        bullishMidTrendProbeEntry;

      const setupClass = godModeEntry
        ? "GOD"
        : eliteEntry
          ? "A"
          : bEntry
            ? "B"
            : bullishMidTrendProbeEntry
              ? "B_TREND_PROBE"
              : btcBullishBearExceptionEntry
                ? "A_SHORT_EXCEPTION"
                : "NONE";

      const reasonEntry = godModeEntry
        ? "GOD_MODE"
        : eliteEntry
          ? "ELITE_ENTRY"
          : bEntry
            ? "B_ENTRY"
            : bullishMidTrendProbeEntry
              ? "BULLISH_MID_TREND_PROBE"
              : btcBullishBearExceptionEntry
                ? "BTC_BULLISH_BEAR_EXCEPTION"
                : "NONE";

      c.setupClass = setupClass;

      if (!ENABLE_B_ENTRIES && setupGrade.grade === "B" && !eliteEntry) {
        actions.push(buildWait(
          c,
          "B_DISABLED_A_ONLY",
          flow,
          sniper,
          confluence,
          rr,
          funding,
          obData,
          riskBase,
          setupGrade,
          null,
          null
        ));
        continue;
      }

      if (!shouldEnter) {
        actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
        continue;
      }

      // ================= V11_3 FINAL DEPTH HARD GATE =================
      const finalDepthCheck = validateFinalDepth({
        side: c.side,
        flow: flow.type,
        setupClass,
        depthMinUsd1p: obData.depthMinUsd1p
      });

      if (!finalDepthCheck.ok) {
        actions.push(buildWait(
          c,
          finalDepthCheck.reason,
          flow,
          sniper,
          confluence,
          rr,
          funding,
          obData,
          riskBase,
          setupGrade,
          null,
          null
        ));
        continue;
      }

      // ================= V11_3 BULL ANTI-CHASE GATE =================
      const bullAntiChaseCheck = validateBullAntiChase({
        side: c.side,
        flow: flow.type,
        rsiZone,
        btcState,
        pullbackConfirmed: bullPullbackMeta.pullbackConfirmed,
        sweepConfirmed: bullPullbackMeta.sweepConfirmed,
        retestConfirmed: bullPullbackMeta.retestConfirmed,
        fakeBreakoutConfirmed: isValidFakeBreakout,
        distanceFromLocalHighPct: bullPullbackMeta.distanceFromLocalHighPct,
        bullishMidTrendProbeOk
      });

      if (!bullAntiChaseCheck.ok) {
        actions.push(buildWait(
          c,
          bullAntiChaseCheck.reason,
          flow,
          sniper,
          confluence,
          rr,
          funding,
          obData,
          riskBase,
          setupGrade,
          null,
          null
        ));
        continue;
      }

      // ================= DIRECT ENTRY =================
      const tpSetupClass =
        setupClass === "A_SHORT_EXCEPTION"
          ? "A"
          : setupClass === "B_TREND_PROBE"
            ? "B"
            : setupClass;

      const tpRewardMultiplier = getTpRewardMultiplier({
        setupClass: tpSetupClass,
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

      const finalRisk = {
        ...riskBase,
        tp: finalTp,
        rr: finalRr
      };

      if ((setupClass === "A" || setupClass === "GOD") && finalRr < A_FINAL_MIN_RR) {
        actions.push(buildWait(c, "LOW_FINAL_RR", flow, sniper, confluence, finalRr, funding, obData, finalRisk, setupGrade, null, A_FINAL_MIN_RR));
        continue;
      }

      if (setupClass === "A_SHORT_EXCEPTION" && finalRr < BTC_BULLISH_BEAR_EXCEPTION_MIN_RR) {
        actions.push(buildWait(
          c,
          "LOW_FINAL_RR",
          flow,
          sniper,
          confluence,
          finalRr,
          funding,
          obData,
          finalRisk,
          setupGrade,
          null,
          BTC_BULLISH_BEAR_EXCEPTION_MIN_RR
        ));
        continue;
      }

      if (setupClass === "B_TREND_PROBE" && finalRr < BULLISH_MID_TREND_PROBE_MIN_RR) {
        actions.push(buildWait(
          c,
          "LOW_FINAL_RR",
          flow,
          sniper,
          confluence,
          finalRr,
          funding,
          obData,
          finalRisk,
          setupGrade,
          null,
          BULLISH_MID_TREND_PROBE_MIN_RR
        ));
        continue;
      }

      const effectiveGrade =
        setupClass === "A_SHORT_EXCEPTION"
          ? "A_SHORT_EXCEPTION"
          : setupClass === "B_TREND_PROBE"
            ? "B_TREND_PROBE"
            : setupGrade.grade;

      const effectiveGradePoints =
        setupClass === "A_SHORT_EXCEPTION"
          ? setupGrade.points + 1
          : setupClass === "B_TREND_PROBE"
            ? setupGrade.points
            : setupGrade.points;

      const effectiveRecommendedRisk =
        setupClass === "A_SHORT_EXCEPTION" || setupClass === "B_TREND_PROBE"
          ? "reduced"
          : setupGrade.recommendedRisk;

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

        grade: effectiveGrade,
        gradePoints: effectiveGradePoints,
        recommendedRisk: effectiveRecommendedRisk,

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
        btcState,

        btcBullishBearException: Boolean(btcBullishBearExceptionOk),
        btcBullishBearExceptionReason: c._debugBtcBullishBearExceptionReason || null,

        bullishMidTrendProbe: Boolean(bullishMidTrendProbeOk),
        bullishMidTrendProbeReason: c._debugBullishMidTrendProbeReason || null,

        pullbackConfirmed: bullPullbackMeta.pullbackConfirmed,
        sweepConfirmed: bullPullbackMeta.sweepConfirmed,
        retestConfirmed: bullPullbackMeta.retestConfirmed,
        distanceFromLocalHighPct: bullPullbackMeta.distanceFromLocalHighPct
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
        initialSl: position.initialSl,
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
    // Patch: alleen save als lock is verkregen of redis niet vereist is
    if (!durableRequired || lockAcquired) {
      await saveDurableRuntimeState();
    }

    if (lockAcquired) {
      await releaseRuntimeLock(lockOwner);
    }
  }
}