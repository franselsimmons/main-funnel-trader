```javascript
// ================= TRADESYSTEM.JS (DISCOVERY MODE – ALLE FILTERS RELAXED) =================

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

import { sendAnalysisActions } from "./analysisNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";

// Nieuwe rotation gate – importeer de functies
import {
  attachMicroRotationKeys,
  checkTradeSignalAgainstRotation
} from "./microRotationGate.js";

// ================= STRATEGY VERSION =================
const STRATEGY_VERSION = "TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN";


// Discovery mode:
// - stuurt elke coin/action naar analyse-site
// - opent veel meer paper/memory positions
// - Discord blijft uit voor discovery entries tenzij je DISCOVERY_SEND_DISCORD=true zet
const DISCOVERY_MODE = true;
const DISCOVERY_OPEN_MEMORY_POSITIONS = true;
const DISCOVERY_SEND_DISCORD = false;

// ================= OPTIMIZER / FEATURE FLAGS =================
const ENABLE_TS_OPTIMIZER = false;
const ENABLE_FEATURE_STORE = true;
const ENABLE_SHADOW_OUTCOMES = true;
const ENABLE_POST_EXIT_MONITOR = true;

const ENABLE_EXTERNAL_WEEKLY_ROTATION =
  process.env.TS_ENABLE_EXTERNAL_WEEKLY_ROTATION === "true";

// Raw rows alleen aanzetten voor debug. Normaal UIT, anders loopt Redis vol.
const ENABLE_RAW_FEATURE_ROWS = process.env.TS_ENABLE_RAW_FEATURE_ROWS === "true";

// Alleen OPEN shadow rows bewaren. Completed rows worden samengevat en daarna verwijderd.
const MAX_OPEN_SHADOW_OUTCOME_ROWS = Number(process.env.TS_MAX_OPEN_SHADOW_OUTCOME_ROWS || 2500);

// Hoeveel microfamilies per row meetellen.
// Niet alle 10 families pakken, anders verwatert je ranking.
const MICRO_LEARNING_MAX_FAMILIES_PER_ROW = Number(process.env.MICRO_LEARNING_MAX_FAMILIES_PER_ROW || 1);

const MICRO_ROTATION_TOP_N_PER_SIDE = Number(process.env.MICRO_ROTATION_TOP_N_PER_SIDE || 2);

// Niet te laag zetten. Winrate met 3-5 trades is ruis.
const MICRO_ROTATION_MIN_COMPLETED = Number(process.env.MICRO_ROTATION_MIN_COMPLETED || 10);

// Ook bootstrap moet minimaal 10 closed trades hebben.
// Zo voorkom je nep-winnaars zoals 1/1, 2/2, 3/3.
const MICRO_ROTATION_BOOTSTRAP_MIN_COMPLETED = Number(
  process.env.MICRO_ROTATION_BOOTSTRAP_MIN_COMPLETED || 10
);

// Alleen entries toestaan als ze in de actieve microfamilie-rotation zitten.
const MICRO_ROTATION_STRICT_ENTRY_GATE =
  process.env.MICRO_ROTATION_STRICT_ENTRY_GATE !== "false";
const MICRO_ROTATION_PARENT_FALLBACK =
  process.env.MICRO_ROTATION_PARENT_FALLBACK === "true";

// Als er nog geen microfamilies zijn:
// false = niks openen
// true  = tijdelijk alles toestaan
const MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP =
  process.env.MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP === "true";

// Zondag/current-week helper:
// true = gebruik huidige week als er genoeg closed trades zijn
// false = alleen completed previous week gebruiken
const MICRO_ROTATION_USE_CURRENT_WEEK_BOOTSTRAP =
  process.env.MICRO_ROTATION_USE_CURRENT_WEEK_BOOTSTRAP === "true";

// Score is nu winrate-based. 0 betekent: alleen completed-filter gebruiken.
const MICRO_ROTATION_MIN_SCORE = Number(process.env.MICRO_ROTATION_MIN_SCORE || 0);
// Bayesian shrinkage: kleine samples worden richting 50% getrokken.
const MICRO_ROTATION_PRIOR_TRADES = Number(process.env.MICRO_ROTATION_PRIOR_TRADES || 24);
const MICRO_ROTATION_PRIOR_WINRATE = Number(process.env.MICRO_ROTATION_PRIOR_WINRATE || 0.50);

// 1.96 = conservatieve 95% Wilson lower bound.
// Hierdoor is 10/10 niet automatisch beter dan 80/100.
const MICRO_ROTATION_WILSON_Z = Number(process.env.MICRO_ROTATION_WILSON_Z || 1.96);

// Alleen tie-breakers. Winrate blijft dominant.
const MICRO_ROTATION_AVG_R_TIEBREAK_WEIGHT = Number(process.env.MICRO_ROTATION_AVG_R_TIEBREAK_WEIGHT || 5);
const MICRO_ROTATION_DIRECT_SL_PENALTY = Number(process.env.MICRO_ROTATION_DIRECT_SL_PENALTY || 15);
const MICRO_ROTATION_OBSERVATION_WEIGHT = Number(process.env.MICRO_ROTATION_OBSERVATION_WEIGHT || 5);

// Win/loss definitie voor micro-family winrate.
const MICRO_OUTCOME_WIN_R_THRESHOLD = Number(process.env.MICRO_OUTCOME_WIN_R_THRESHOLD || 0);
const MICRO_OUTCOME_LOSS_R_THRESHOLD = Number(process.env.MICRO_OUTCOME_LOSS_R_THRESHOLD || 0);

// ================= RUNTIME / DURABLE / OPTIMIZER DEFAULTS =================

// Durable Redis / Upstash storage
const DURABLE_MAX_CHUNK_BYTES = 400_000;

const RUNTIME_STORE_KEY = `${STRATEGY_VERSION}:runtime:legacy`;
const RUNTIME_CORE_KEY = `${STRATEGY_VERSION}:runtime:core`;
const RUNTIME_RECENT_KEY = `${STRATEGY_VERSION}:runtime:recent_entries`;

const RUNTIME_CLOSED_META_KEY = `${STRATEGY_VERSION}:runtime:closed_trades:meta`;
const RUNTIME_CLOSED_CHUNK_PREFIX = `${STRATEGY_VERSION}:runtime:closed_trades:chunk:`;

const RUNTIME_FEATURE_META_KEY = `${STRATEGY_VERSION}:runtime:feature_store:meta`;
const RUNTIME_FEATURE_CHUNK_PREFIX = `${STRATEGY_VERSION}:runtime:feature_store:chunk:`;

const RUNTIME_SHADOW_META_KEY = `${STRATEGY_VERSION}:runtime:shadow_outcomes:meta`;
const RUNTIME_SHADOW_CHUNK_PREFIX = `${STRATEGY_VERSION}:runtime:shadow_outcomes:chunk:`;

// Durable runtime lock
const RUNTIME_LOCK_KEY = `${STRATEGY_VERSION}:runtime:lock`;
// PATCH 1: increased lock attempts and retry ms
const DURABLE_LOCK_ATTEMPTS = Number(process.env.TS_RUNTIME_LOCK_ATTEMPTS || 90);
const DURABLE_LOCK_RETRY_MS = Number(process.env.TS_RUNTIME_LOCK_RETRY_MS || 1000);

// Audit / feature-store caps
const MAX_RECENT_ENTRY_AUDIT_ROWS = 150;
const MAX_CLOSED_TRADE_AUDIT_ROWS = 1_000;
const MAX_FEATURE_STORE_ROWS = ENABLE_RAW_FEATURE_ROWS ? 1_000 : 0;
const MAX_SHADOW_OUTCOME_ROWS = MAX_OPEN_SHADOW_OUTCOME_ROWS;

// Data-fetch tuning
const DATA_FETCH_CONCURRENCY = 5;

// ================= NEW BITGET CANDLE CONSTANTS =================
const BITGET_API_BASE_URL = process.env.BITGET_API_BASE_URL || "https://api.bitget.com";
const BITGET_PRODUCT_TYPE = process.env.BITGET_PRODUCT_TYPE || "usdt-futures";
const BITGET_CANDLE_TIMEOUT_MS = Number(process.env.BITGET_CANDLE_TIMEOUT_MS || 8000);

// Safe orderbook fallback
const DEFAULT_OB = {
  bias: "NEUTRAL",
  spreadPct: 0.001,
  depthMinUsd1p: 0,
  mid: 0,
  spoof: false,
  fetchFailed: true
};

// Scoring fallback health
const MIN_EXTERNAL_SCORE_HEALTH = 20;

// Risk fallback
const ENABLE_FALLBACK_RISK_GEOMETRY = true;

// Bullish MID trend probe defaults (zwaar verlaagd voor discovery)
const BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE = 0;
const BULLISH_MID_TREND_PROBE_MIN_SNIPER = 0;
const BULLISH_MID_TREND_PROBE_MIN_RR = 0.20;
const BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT = 0.0150;
const BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P = 0;
const BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH = false;
const BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT = -999;
const BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT = -999;
const BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT = 0;

// RSI continuation / exhaustion guards (uit voor discovery)
const SHORT_LOWER1_ALLOWED_BTC_STATES = ["BEARISH", "STRONG_BEAR", "NEUTRAL"];
const LONG_LOWER2_MAX_1H_CHANGE = 1.50;
const SHORT_UPPER2_MIN_1H_CHANGE = -1.50;

// Position path tracking
const HALF_R_LEVEL = 0.50;
const ONE_R_LEVEL = 1.00;
const NEAR_TP_PROGRESS = 0.80;
const DIRECT_SL_MFE_LIMIT_R = 0.25;
const MAX_PRICE_PATH_SAMPLES = 80;

// Break-even defaults
// Keep disabled by default to avoid changing live behavior unintentionally.
const ENABLE_BREAK_EVEN_RULE = false;
const BREAK_EVEN_TRIGGER_R = 0.50;
const BREAK_EVEN_LOCK_R = 0.03;

// Post-exit monitor
const POST_EXIT_MONITOR_MS = 6 * 60 * 60 * 1000;
const POST_EXIT_MAX_MONITOR_ROWS = 500;
const POST_EXIT_MAX_MONITOR_PER_RUN = 20;

const TP_FOLLOW_THROUGH_R = 0.30;
const TP_BIG_FOLLOW_THROUGH_R = 0.75;

const SL_RECOVERY_HALF_R = 0.50;
const SL_RECOVERY_ONE_R = 1.00;
const SL_DEEP_ADVERSE_R = -0.75;

// Shadow outcome monitor
const SHADOW_MONITOR_MS = 6 * 60 * 60 * 1000;
const SHADOW_DUPLICATE_COOLDOWN_MS = 60 * 60 * 1000;
const SHADOW_DIRECTIONAL_WIN_PCT = 0.25;
const SHADOW_DIRECTIONAL_LOSS_PCT = -0.25;
const SHADOW_MAX_MONITOR_PER_RUN = 25;

// Best-setup optimizer thresholds
const BEST_SETUP_MIN_SAMPLE_LOW = 5;
const BEST_SETUP_MIN_SAMPLE_MEDIUM = 12;
const BEST_SETUP_MIN_SAMPLE_HIGH = 30;
const BEST_SETUP_MIN_WINRATE = 0.55;
const BEST_SETUP_MIN_AVG_R = 0.10;
const BAD_SETUP_MAX_WINRATE = 0.45;
const BAD_SETUP_MAX_AVG_R = -0.05;

// Final filter decision optimizer
const FINAL_DECISION_MIN_COMPLETED = 20;
const FINAL_DECISION_TARGET_COMPLETED = 100;
const FINAL_DECISION_TOP_N = 10;

// ================= PATCH 2: MINIMUM PRE-TP GEOMETRY RR =================
const MIN_PRE_TP_GEOMETRY_RR = 0.20;

// ================= CACHE (PATCHED) =================
const API_CACHE_MAX_KEYS = 2000;
const API_INFLIGHT_MAX_KEYS = 500;

const apiCache = new Map();
const apiInFlight = new Map();

function pruneMapToSize(map, maxSize) {
  if (map.size <= maxSize) return;

  const overflow = map.size - maxSize;
  const keys = Array.from(map.keys()).slice(0, overflow);

  for (const key of keys) {
    map.delete(key);
  }
}

async function cachedFetch(key, fn, ttl = 30000) {
  const now = Date.now();
  const cached = apiCache.get(key);

  if (cached && now - cached.ts < ttl) {
    return cached.data;
  }

  if (apiInFlight.has(key)) {
    return apiInFlight.get(key);
  }

  const promise = (async () => {
    const data = await fn();

    apiCache.set(key, {
      data,
      ts: Date.now()
    });

    pruneMapToSize(apiCache, API_CACHE_MAX_KEYS);

    return data;
  })().finally(() => {
    apiInFlight.delete(key);
  });

  apiInFlight.set(key, promise);
  pruneMapToSize(apiInFlight, API_INFLIGHT_MAX_KEYS);

  return promise;
}

// ================= CONSTANTEN (DISCOVERY: ALLES RELAXED) =================
const COOLDOWN_MS = 0;
const SYMBOL_REENTRY_COOLDOWN_MS = 0;

const MAX_SPREAD_PCT = 0.0150;
const MID_BULL_MAX_SPREAD_PCT = 0.0150;
const MIN_DEPTH_USD_1P = 0;

const MIN_RR_FLOOR = 0.20;

const GRADE_A_MIN_RR_FLOOR = 0.20;
const GRADE_B_MIN_RR_FLOOR = 0.20;
const GRADE_C_MIN_RR_FLOOR = 0.20;

const A_ENTRY_MIN_RR = 0.20;
const B_ENTRY_MIN_RR = 0.20;
const GOD_ENTRY_MIN_RR = 0.20;

// PRE-TP BASE RR CONSTANTS (used in inferSetupClass before final TP expansion)
const A_PRE_TP_MIN_BASE_RR = 0.20;
const GOD_PRE_TP_MIN_BASE_RR = 0.20;
const B_PRE_TP_MIN_BASE_RR = 0.20;

const A_MIN_SNIPER = 0;
const A_MIN_CONFLUENCE = 0;

const B_MIN_SNIPER = 0;
const B_MIN_CONFLUENCE = 0;

const GOD_MIN_SNIPER = 0;
const GOD_MIN_CONFLUENCE = 0;

const MID_RSI_MIN_CONFLUENCE = 0;

const TREND_CONTINUATION_MIN_CONFLUENCE = 0;
const TREND_CONTINUATION_MIN_SNIPER = 0;
const TREND_CONTINUATION_MIN_RR = 0.20;

const A_FINAL_MIN_RR = 0.20;
const A_GOD_MAX_TP_REWARD_MULTIPLIER = 1.35;

const ENABLE_B_ENTRIES = true;
const ENABLE_BULLISH_MID_TREND_PROBES = true;

const MIN_DEPTH_USD_1P_ABSOLUTE = 0;
const A_MIN_DEPTH_USD_1P = 0;
const BULL_TREND_MIN_DEPTH_USD_1P = 0;

const REQUIRE_BULL_TREND_PULLBACK = false;
const MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT = 1;

const ENABLE_BTC_BULLISH_BEAR_EXCEPTION = true;

const BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P = 0;
const BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT = 0.0150;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_RR = 0.20;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF = 0;
const BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF = 100;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER = 0;

const SHORT_BLOCKED_RSI_ZONES = [];

const COUNTERTREND_MIN_RR_FLOOR = 0.20;
const BUILDUP_MIN_RR_FLOOR = 0.20;

const CANDIDATE_MIN_SCORE = 0;
const BTC_BEARISH_LONG_MIN_SCORE = 0;
const BTC_NEUTRAL_MIN_SCORE = 0;

const EARLY_RSI_MIN_SNIPER = 0;

const SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE = 0;
const SHORT_LOWER1_CONTINUATION_MIN_SNIPER = 0;
const SHORT_LOWER1_CONTINUATION_MIN_RR = 0.20;

const STRONG_MOMENTUM_MIN_1H_MOVE_PCT = -999;
const STRONG_MOMENTUM_MIN_24H_MOVE_PCT = -999;

const SOFT_MOMENTUM_MIN_1H_MOVE_PCT = -999;
const SOFT_MOMENTUM_MIN_24H_MOVE_PCT = -999;

const ELITE_MOMENTUM_MIN_CONFLUENCE = 0;
const ELITE_MOMENTUM_MIN_1H_MOVE_PCT = -999;

const LOW_VOL_MIN_CONFLUENCE = 0;
const NO_FLOW_MIN_CONFLUENCE = 0;

const TF_MIN_STRENGTH = 0;
const GLOBAL_MIN_CONFLUENCE = 0;

const OB_AGAINST_MIN_CONFLUENCE = 0;
const BAD_MARKET_QUALITY_MIN_CONFLUENCE = 0;
const OB_NEUTRAL_MIN_CONFLUENCE = 0;

const MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE = 0;
const MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER = 0;

const EXTREME_FUNDING_ABS_MAX = 999;
const BULL_CROWDED_FUNDING_MAX = 999;
const BEAR_CROWDED_FUNDING_MIN = -999;
const CROWDED_FUNDING_MIN_CONFLUENCE = 0;

const SETUP_GRADE_A_MIN_POINTS = 0;
const SETUP_GRADE_B_MIN_POINTS = 0;

const NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE = 0;
const NEUTRAL_OB_A_EXCEPTION_MIN_RR = 0.20;
const NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER = 0;

const NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE = 0;
const NEUTRAL_OB_B_EXCEPTION_MIN_RR = 0.20;
const NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER = 0;
const NEUTRAL_OB_B_EXCEPTION_MIN_SCORE = 0;

// ================= NEW EXPOSURE/CORRELATION CAPS (DISCOVERY: ALLES OPEN) =================
const MAX_OPEN_POSITIONS_TOTAL = 999;
const MAX_OPEN_POSITIONS_SAME_SIDE = 999;
const MAX_COUNTER_BTC_OPEN_POSITIONS = 999;

// ================= PATCH 3: nieuwe constante voor MID RSI continuation discount =================
const MID_RSI_CONTINUATION_RR_DISCOUNT = 0.05;

// ================= V12 QUALITY GATES (uit) =================
const ENABLE_ENTRY_QUALITY_GATE_V12 = false;

const QUALITY_LOW_RR_THRESHOLD = 1.15;
const QUALITY_LOW_RR_MIN_SNIPER = 78;
const QUALITY_LOW_RR_MIN_CONFLUENCE = 82;

const QUALITY_MID_NEUTRAL_MIN_SNIPER = 85;
const QUALITY_MID_NEUTRAL_MIN_CONFLUENCE = 88;
const QUALITY_MID_NEUTRAL_MIN_RR = 1.25;
const QUALITY_MID_NEUTRAL_MAX_SPREAD_PCT = 0.0008;
const QUALITY_MID_NEUTRAL_MIN_DEPTH_USD_1P = 100000;

const QUALITY_CHOP_RSI_MIN = 47;
const QUALITY_CHOP_RSI_MAX = 53;
const QUALITY_CHOP_MIN_SNIPER = 82;
const QUALITY_CHOP_MIN_CONFLUENCE = 86;

const QUALITY_LOWER_RSI_LONG_MIN_SNIPER = 78;
const QUALITY_LOWER_RSI_LONG_MIN_CONFLUENCE = 82;

const ENTRY_CONFIRMATION_TTL_MS = 12 * 60 * 1000;
const ENTRY_CONFIRMATION_MIN_SNIPER = 82;
const ENTRY_CONFIRMATION_MIN_CONFLUENCE = 86;

const ENABLE_EARLY_FAILURE_EXIT = false;
const EARLY_FAILURE_MIN_AGE_SEC = 90;
const EARLY_FAILURE_MIN_MFE_R = 0.15;
const EARLY_FAILURE_MAX_MAE_R = -0.30;
const EARLY_FAILURE_MAX_CURRENT_R = -0.18;

const EARLY_OB_FLIP_MIN_AGE_SEC = 120;
const EARLY_OB_FLIP_MIN_MFE_R = 0.25;
const EARLY_OB_FLIP_MAX_CURRENT_R = -0.10;

const BREAK_EVEN_MIN_TICKS = 2;
const BREAK_EVEN_MIN_FAVORABLE_TICKS = 2;

// ================= NEW BTC STATE HELPER =================
function classifyBtcState({ change24, change1h }) {
  const ch24 = Number(change24 || 0);
  const ch1 = Number(change1h || 0);

  if (ch24 > 1.50 && ch1 > 0.50) return "STRONG_BULL";
  if (ch24 < -1.50 && ch1 < -0.50) return "STRONG_BEAR";

  if (ch24 > 0.60 || ch1 > 0.25) return "BULLISH";
  if (ch24 < -0.60 || ch1 < -0.25) return "BEARISH";

  return "NEUTRAL";
}

// ================= RUNTIME STATE (PATCHED: lastSignalMap as Map, coerce helpers) =================
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
    featureStore: [],
    shadowOutcomes: [],

    // Compacte daily/weekly micro-family learning.
    microLearning: createMicroLearningState(),

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

function coerceMap(value) {
  if (value instanceof Map) return value;

  const map = new Map();

  if (value instanceof Set) {
    for (const item of value) {
      map.set(item, true);
    }

    return map;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        map.set(item[0], item[1]);
        continue;
      }

      if (item !== null && item !== undefined) {
        map.set(item, true);
      }
    }

    return map;
  }

  if (value && typeof value === "object") {
    for (const [key, entryValue] of Object.entries(value)) {
      map.set(key, entryValue);
    }
  }

  return map;
}

function coerceSet(value) {
  if (value instanceof Set) return value;

  if (Array.isArray(value)) {
    return new Set(value);
  }

  if (value && typeof value === "object") {
    return new Set(Object.keys(value));
  }

  return new Set();
}

function normalizeAuditState(audit) {
  const normalized = {
    ...createAuditState(),
    ...(audit && typeof audit === "object" ? audit : {}),
    strategyVersion: STRATEGY_VERSION
  };

  if (!Array.isArray(normalized.recentEntries)) normalized.recentEntries = [];
  if (!Array.isArray(normalized.closedTrades)) normalized.closedTrades = [];
  if (!Array.isArray(normalized.featureStore)) normalized.featureStore = [];
  if (!Array.isArray(normalized.shadowOutcomes)) normalized.shadowOutcomes = [];

  normalized.entryReasonCounts = normalized.entryReasonCounts || {};
  normalized.entrySetupClassCounts = normalized.entrySetupClassCounts || {};
  normalized.exitReasonCounts = normalized.exitReasonCounts || {};

  normalized.startedAt = Number(normalized.startedAt || Date.now());
  normalized.runs = Number(normalized.runs || 0);
  normalized.entries = Number(normalized.entries || 0);
  normalized.exits = Number(normalized.exits || 0);
  normalized.wins = Number(normalized.wins || 0);
  normalized.losses = Number(normalized.losses || 0);
  normalized.rTotal = Number(normalized.rTotal || 0);
  normalized.pnlPctTotal = Number(normalized.pnlPctTotal || 0);
  normalized.lastSnapshotAt = Number(normalized.lastSnapshotAt || 0);

  normalized.microLearning = normalizeMicroLearningState(normalized.microLearning);

  return normalized;
}

function normalizeRuntimeContainers(state) {
  if (!state || typeof state !== "object") {
    return createRuntimeState();
  }

  state.strategyVersion = STRATEGY_VERSION;

  state.memory = coerceMap(state.memory);
  state.notifyState = coerceMap(state.notifyState);
  state.cooldownMap = coerceMap(state.cooldownMap);
  state.symbolCooldownMap = coerceMap(state.symbolCooldownMap);
  state.lastSignalMap = coerceMap(state.lastSignalMap);

  state.processingLocks = coerceSet(state.processingLocks);
  state.audit = normalizeAuditState(state.audit);

  state.durableLoadedAt = Number(state.durableLoadedAt || 0);
  state.durableSavedAt = Number(state.durableSavedAt || 0);

  return state;
}

const globalKey = "__TRADE_SYSTEM_RUNTIME_STATE__";

let runtimeState = globalThis[globalKey];

if (!runtimeState || runtimeState.strategyVersion !== STRATEGY_VERSION) {
  runtimeState = createRuntimeState();

  console.log(`TRADE SYSTEM RESET: new strategyVersion=${STRATEGY_VERSION}`);
}

runtimeState = normalizeRuntimeContainers(runtimeState);
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
  if (!(targetMap instanceof Map)) {
    throw new Error("replaceMapContents_target_not_map");
  }

  targetMap.clear();

  if (!entries) return;

  if (entries instanceof Map) {
    for (const [key, value] of entries.entries()) {
      targetMap.set(key, value);
    }

    return;
  }

  if (entries instanceof Set) {
    for (const key of entries.values()) {
      targetMap.set(key, true);
    }

    return;
  }

  if (Array.isArray(entries)) {
    for (const item of entries) {
      if (Array.isArray(item) && item.length >= 2) {
        targetMap.set(item[0], item[1]);
        continue;
      }

      if (item !== null && item !== undefined) {
        targetMap.set(item, true);
      }
    }

    return;
  }

  if (entries && typeof entries === "object") {
    for (const [key, value] of Object.entries(entries)) {
      targetMap.set(key, value);
    }
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

  if (!ENABLE_RAW_FEATURE_ROWS) {
    auditState.featureStore = [];
  } else if (auditState.featureStore.length > MAX_FEATURE_STORE_ROWS) {
    auditState.featureStore = auditState.featureStore.slice(-MAX_FEATURE_STORE_ROWS);
  }

  // Completed shadow outcomes zijn al samengevat naar microLearning.
  // Bewaar alleen OPEN rows plus completed rows die nog niet verwerkt zijn.
  auditState.shadowOutcomes = auditState.shadowOutcomes.filter(row => {
    const status = String(row?.status || "OPEN").toUpperCase();

    if (status === "OPEN") return true;
    return !Boolean(row?.microOutcomeRecorded);
  });

  if (auditState.shadowOutcomes.length > MAX_SHADOW_OUTCOME_ROWS) {
    auditState.shadowOutcomes = auditState.shadowOutcomes
      .sort((a, b) => Number(b.createdAt || b.ts || 0) - Number(a.createdAt || a.ts || 0))
      .slice(0, MAX_SHADOW_OUTCOME_ROWS);
  }
}

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

// ================= REDIS SET MET BYTE CHECK =================
const REDIS_SAFE_MAX_BYTES = Number(process.env.TS_REDIS_SAFE_MAX_BYTES || 8_900_000);
const RUNTIME_CORE_TARGET_BYTES = Number(process.env.TS_RUNTIME_CORE_TARGET_BYTES || 8_250_000);

const MAX_DURABLE_MEMORY_ROWS = Number(process.env.TS_MAX_DURABLE_MEMORY_ROWS || 650);
const MAX_DURABLE_NOTIFY_ROWS = Number(process.env.TS_MAX_DURABLE_NOTIFY_ROWS || 800);
const MAX_DURABLE_COOLDOWN_ROWS = Number(process.env.TS_MAX_DURABLE_COOLDOWN_ROWS || 800);
const MAX_DURABLE_LAST_SIGNAL_ROWS = Number(process.env.TS_MAX_DURABLE_LAST_SIGNAL_ROWS || 600);
const MAX_DURABLE_POSITION_PATH_ROWS = Number(process.env.TS_MAX_DURABLE_POSITION_PATH_ROWS || 6);

const MAX_DURABLE_MICRO_DAILY_FAMILIES = Number(process.env.TS_MAX_DURABLE_MICRO_DAILY_FAMILIES || 900);
const MAX_DURABLE_MICRO_WEEK_FAMILIES = Number(process.env.TS_MAX_DURABLE_MICRO_WEEK_FAMILIES || 1600);
const MAX_DURABLE_MICRO_LAST_WEEK_FAMILIES = Number(process.env.TS_MAX_DURABLE_MICRO_LAST_WEEK_FAMILIES || 1200);
const MAX_DURABLE_MICRO_COUNTER_KEYS = Number(process.env.TS_MAX_DURABLE_MICRO_COUNTER_KEYS || 8);
const MAX_DURABLE_MICRO_EXAMPLES = Number(process.env.TS_MAX_DURABLE_MICRO_EXAMPLES || 3);

async function redisSetJson(key, value) {
  const serialized = JSON.stringify(value);
  const bytes = jsonByteLength(serialized);

  if (bytes > REDIS_SAFE_MAX_BYTES) {
    throw new Error(
      `REDIS_SET_ABORTED_TOO_LARGE key=${key} bytes=${bytes} max=${REDIS_SAFE_MAX_BYTES}`
    );
  }

  await redisCommand(["SET", key, serialized]);

  return bytes;
}

async function redisGetJson(key) {
  const result = await redisCommand(["GET", key]);
  return safeJsonParse(result);
}

function isRedisPayloadTooLargeError(error) {
  const message = String(error?.message || error?.error || error?.reason || "");

  return (
    message.includes("REDIS_SET_ABORTED_TOO_LARGE") ||
    message.includes("REDIS_PAYLOAD_TOO_LARGE") ||
    message.includes("bytes=") && message.includes("max=")
  );
}

function compactCounterObject(value, maxKeys = MAX_DURABLE_MICRO_COUNTER_KEYS) {
  const obj = durableObject(value);

  return Object.fromEntries(
    Object.entries(obj)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, Math.max(0, Number(maxKeys || 0)))
  );
}

function microFamilySortScore(family) {
  return (
    Number(family?.completed || 0) * 1000 +
    Number(family?.wins || 0) * 100 +
    Number(family?.seen || 0)
  );
}

function compactMicroFamilyStats(family = {}, mode = "compact") {
  const maxExamples = mode === "ultra"
    ? 1
    : MAX_DURABLE_MICRO_EXAMPLES;

  return {
    familyId: family.familyId,
    side: family.side,

    seen: Number(family.seen || 0),
    completed: Number(family.completed || 0),
    wins: Number(family.wins || 0),
    losses: Number(family.losses || 0),
    flats: Number(family.flats || 0),

    totalR: Number(Number(family.totalR || 0).toFixed(4)),
    avgR: Number(Number(family.avgR || 0).toFixed(4)),

    winrateNum: Number(Number(family.winrateNum || 0).toFixed(4)),
    bayesianWinrateNum: Number(Number(family.bayesianWinrateNum || 0).toFixed(4)),
    winrateLowerBoundNum: Number(Number(family.winrateLowerBoundNum || 0).toFixed(4)),
    fairWinrateNum: Number(Number(family.fairWinrateNum || 0).toFixed(4)),
    sampleReliability: Number(Number(family.sampleReliability || 0).toFixed(4)),
    observationConfidence: Number(Number(family.observationConfidence || 0).toFixed(4)),

    rotationScore: Number(Number(family.rotationScore || 0).toFixed(4)),
    rankingMode: family.rankingMode || "WINRATE_WILSON_BAYES",

    directSL: Number(family.directSL || 0),
    nearTp: Number(family.nearTp || 0),

    entryReasons: compactCounterObject(family.entryReasons),
    setupClasses: compactCounterObject(family.setupClasses),
    rsiZones: compactCounterObject(family.rsiZones),
    obBiases: compactCounterObject(family.obBiases),

    examples: durableArray(family.examples).slice(-maxExamples),
  };
}

function compactMicroFamilyMap(families = {}, maxFamilies = 1000, mode = "compact") {
  return Object.fromEntries(
    Object.values(durableObject(families))
      .sort((a, b) => microFamilySortScore(b) - microFamilySortScore(a))
      .slice(0, Math.max(0, Number(maxFamilies || 0)))
      .map(family => [
        family.familyId,
        compactMicroFamilyStats(family, mode)
      ])
      .filter(([familyId]) => Boolean(familyId))
  );
}

function compactMicroSummary(summary = {}, maxFamilies = 1000, mode = "compact") {
  const s = durableObject(summary);

  return {
    dayKey: s.dayKey,
    weekKey: s.weekKey,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,

    days: mode === "ultra"
      ? {}
      : Object.fromEntries(
          Object.entries(durableObject(s.days)).slice(-14)
        ),

    families: compactMicroFamilyMap(s.families, maxFamilies, mode),
  };
}

function compactActiveRotationForStore(rotation = {}, mode = "compact") {
  const r = durableObject(rotation);

  if (!r || !Object.keys(r).length) return null;

  const allowedMicroFamilyIds = uniqIds([
    r.allowedMicroFamilyIds,
    r.activeMicroFamilyIds,
    r.familyIds,
    r.activeFamilyIds,
    r.allowlist,
    r.allowed,
    r.active,
  ]);

  const maxFamilyRows = mode === "ultra" ? 4 : MICRO_ROTATION_TOP_N_PER_SIDE;

  return {
    rotationId: r.rotationId,
    activeRotationId: r.activeRotationId,
    weekKey: r.weekKey,
    sourceWeekKey: r.sourceWeekKey,
    source: r.source,
    generatedAt: r.generatedAt,
    refreshedAt: r.refreshedAt,
    bootstrap: Boolean(r.bootstrap),

    rankingMode: r.rankingMode,
    rankingMetric: r.rankingMetric,

    allowedMicroFamilyIds,
    activeMicroFamilyIds: allowedMicroFamilyIds,

    longFamilies: durableArray(r.longFamilies)
      .slice(0, maxFamilyRows)
      .map(family => compactMicroFamilyStats(family, mode)),

    shortFamilies: durableArray(r.shortFamilies)
      .slice(0, maxFamilyRows)
      .map(family => compactMicroFamilyStats(family, mode)),

    sample: durablePick(r.sample, [
      "familyCount",
      "selectedCount",
      "completed",
      "minCompleted",
      "priorTrades",
      "priorWinrate",
      "wilsonZ",
    ]),
  };
}

function compactMicroLearningForStore(value = {}, mode = "compact") {
  const state = normalizeMicroLearningState(value);

  const dailyMax = mode === "ultra"
    ? Math.floor(MAX_DURABLE_MICRO_DAILY_FAMILIES / 3)
    : MAX_DURABLE_MICRO_DAILY_FAMILIES;

  const weekMax = mode === "ultra"
    ? Math.floor(MAX_DURABLE_MICRO_WEEK_FAMILIES / 3)
    : MAX_DURABLE_MICRO_WEEK_FAMILIES;

  const lastWeekMax = mode === "ultra"
    ? Math.floor(MAX_DURABLE_MICRO_LAST_WEEK_FAMILIES / 3)
    : MAX_DURABLE_MICRO_LAST_WEEK_FAMILIES;

  return {
    version: state.version || 1,
    activeDayKey: state.activeDayKey,
    activeWeekKey: state.activeWeekKey,

    daily: compactMicroSummary(state.daily, dailyMax, mode),
    week: compactMicroSummary(state.week, weekMax, mode),

    lastCompletedWeek: state.lastCompletedWeek
      ? compactMicroSummary(state.lastCompletedWeek, lastWeekMax, mode)
      : null,

    activeRotation: compactActiveRotationForStore(state.activeRotation, mode),

    updatedAt: state.updatedAt || Date.now(),
  };
}

function durableMapTail(map, limit) {
  const rows = map instanceof Map ? Array.from(map.entries()) : [];
  const max = Math.max(0, Number(limit || 0));

  if (!max) return [];
  if (rows.length <= max) return rows;

  return rows.slice(-max);
}

function compactPositionForStore(pos) {
  const r = durableObject(pos);

  const microFamilyIds = uniqIds([
    r.analyzerMicroFamilyId,
    r.microFamilyId,
    r.familyId,
    r.microFamilyIds,
    r.familyIds
  ]).slice(0, 12);

  const out = {
    ...durablePick(r, [
      "tradeId",
      "symbol",
      "rawBitgetSymbol",
      "side",

      "entry",
      "sl",
      "initialSl",
      "originalSl",
      "tp",

      "rr",
      "baseRR",
      "tpRewardMultiplier",

      "setupClass",
      "entryReason",
      "reason",
      "grade",
      "gradePoints",
      "recommendedRisk",

      "score",
      "moveScore",
      "confluence",
      "sniper",
      "sniperScore",

      "rsi",
      "rsiHTF",
      "rsiZone",

      "obBias",
      "spreadPct",
      "depthMinUsd1p",

      "flow",
      "funding",
      "btcState",
      "regime",

      "slSource",
      "tpSource",

      "createdAt",
      "strategyVersion",

      "stage",
      "scannerStage",
      "stageSource",

      "tfScore",
      "tfStrength",
      "tfAlignment",

      "change1h",
      "change24",

      "currentR",
      "mfeR",
      "maeR",
      "maxTpProgress",
      "maxSlProgress",

      "reachedHalfR",
      "reachedOneR",
      "nearTpSeen",

      "ticksObserved",
      "favorableTicks",
      "adverseTicks",
      "neutralTicks",

      "breakEvenActivated",
      "breakEvenAt",
      "breakEvenTriggerR",
      "breakEvenLockR",
      "breakEvenSl",
      "slBeforeBreakEven",

      "maxFavorablePrice",
      "maxAdversePrice",
      "mfePrice",
      "maePrice",
      "nearTpPrice",

      "bullishMidTrendProbe",
      "bullishMidTrendProbeReason",
      "btcBullishBearException",
      "btcBullishBearExceptionReason",

      "liveEligible",
      "shadowOnly",

      "rotationSide",
      "tradeSide",

      "familyId",
      "microFamilyId",
      "analyzerMicroFamilyId",
      "parentFamilyId",
      "analyzerParentFamilyId",
      "spreadBps"
    ]),

    microFamilyIds,
    familyIds: microFamilyIds,
    microFamilies: microFamilyIds,
    families: microFamilyIds,

    pricePathSample: durableTail(
      r.pricePathSample,
      MAX_DURABLE_POSITION_PATH_ROWS
    )
  };

  const gate = r.rotationGate || r.rotation;

  if (gate) {
    const compactGate = compactGateResult(gate);

    out.rotationGate = compactGate;
    out.rotationId =
      compactGate.activeRotationId ||
      compactGate.rotationId ||
      null;
  }

  if (r.rotationCandidate) {
    out.rotationCandidate = compactFilterSnapshot(r.rotationCandidate);
  }

  return out;
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

  const memoryRows = durableMapTail(memory, MAX_DURABLE_MEMORY_ROWS)
    .map(([key, pos]) => [
      key,
      compactPositionForStore(pos)
    ]);

  return {
    strategyVersion: STRATEGY_VERSION,
    updatedAt: Date.now(),

    memory: memoryRows,

    notifyState: durableMapTail(notifyState, MAX_DURABLE_NOTIFY_ROWS),
    cooldownMap: durableMapTail(cooldownMap, MAX_DURABLE_COOLDOWN_ROWS),
    symbolCooldownMap: durableMapTail(symbolCooldownMap, MAX_DURABLE_COOLDOWN_ROWS),
    lastSignalMap: durableMapTail(lastSignalMap, MAX_DURABLE_LAST_SIGNAL_ROWS),

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

      entryReasonCounts: compactCounterObject(auditState.entryReasonCounts || {}),
      entrySetupClassCounts: compactCounterObject(auditState.entrySetupClassCounts || {}),
      exitReasonCounts: compactCounterObject(auditState.exitReasonCounts || {}),

      lastSnapshotAt: auditState.lastSnapshotAt,

      microLearning: compactMicroLearningForStore(auditState.microLearning, "compact"),
    },

    coreStats: {
      memoryRows: memoryRows.length,
      memoryTotal: memory.size,
      notifyRows: notifyState.size,
      cooldownRows: cooldownMap.size,
      symbolCooldownRows: symbolCooldownMap.size,
      lastSignalRows: lastSignalMap.size,
    },
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

  // B2: normalize microLearning
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

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

  // B2: normalize microLearning
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

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

    // B1: check for incompatible core payload
    const coreIsCompatible =
      core?.strategyVersion === STRATEGY_VERSION &&
      Array.isArray(core.memory) &&
      core.auditCounters &&
      typeof core.auditCounters === "object";

    if (coreIsCompatible) {
      const [
        recentEntries,
        closedTrades,
        featureStore,
        shadowOutcomes
      ] = await Promise.all([
        redisGetJson(RUNTIME_RECENT_KEY).then(v => Array.isArray(v) ? v : []).catch(() => []),
        readJsonArrayChunks(RUNTIME_CLOSED_META_KEY, RUNTIME_CLOSED_CHUNK_PREFIX),
        ENABLE_FEATURE_STORE
          ? readJsonArrayChunks(RUNTIME_FEATURE_META_KEY, RUNTIME_FEATURE_CHUNK_PREFIX)
          : Promise.resolve([]),
        ENABLE_SHADOW_OUTCOMES
          ? readJsonArrayChunks(RUNTIME_SHADOW_META_KEY, RUNTIME_SHADOW_CHUNK_PREFIX)
          : Promise.resolve([])
      ]);

      return hydrateSplitRuntimeState({
        core,
        recentEntries,
        closedTrades,
        featureStore,
        shadowOutcomes
      });
    }

    if (core?.strategyVersion === STRATEGY_VERSION && !coreIsCompatible) {
      console.warn("TRADE SYSTEM DURABLE CORE IGNORED: incompatible core payload", JSON.stringify({
        strategyVersion: STRATEGY_VERSION,
        hasMemory: Array.isArray(core.memory),
        hasAuditCounters: Boolean(core.auditCounters),
        keys: Object.keys(core || {}).slice(0, 20)
      }));
    }

    const legacyPayload = await redisGetJson(RUNTIME_STORE_KEY);

    if (!legacyPayload) {
      console.log("TRADE SYSTEM DURABLE LOAD: empty state");
      runtimeState.durableLoadedAt = Date.now();
      return true;
    }

    return hydrateRuntimeState(legacyPayload);
  } catch (e) {
    console.error("TRADE SYSTEM DURABLE LOAD ERROR:", e.message);
    return false;
  }
}

async function deleteDisabledOptimizerChunks() {
  if (!hasRedis()) return;

  const metas = [
    {
      enabled: ENABLE_FEATURE_STORE,
      metaKey: RUNTIME_FEATURE_META_KEY,
      prefix: RUNTIME_FEATURE_CHUNK_PREFIX
    },
    {
      enabled: ENABLE_SHADOW_OUTCOMES,
      metaKey: RUNTIME_SHADOW_META_KEY,
      prefix: RUNTIME_SHADOW_CHUNK_PREFIX
    }
  ];

  for (const item of metas) {
    if (item.enabled) continue;

    const meta = await redisGetJson(item.metaKey).catch(() => null);
    const chunks = Number(meta?.chunks || 0);

    for (let i = 0; i < chunks; i++) {
      await redisCommand(["DEL", `${item.prefix}${i}`]).catch(() => null);
    }

    await redisCommand(["DEL", item.metaKey]).catch(() => null);
  }
}

// ================= DURABLE COMPACT HELPERS =================
const DURABLE_LIMITS = {
  openPositions: 450,
  entries: 180,
  exits: 300,
  recentEntries: 120,
  closedTrades: 300,
  shadowRows: 0,
  featureRows: 0,

  // Niet per positie 60 ids opslaan. Dat blaast runtime:core op.
  activeFamilyIds: 8,
  checkedFamilyIds: 5,
};

function durableArray(value) {
  return Array.isArray(value) ? value : [];
}

function durableObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function durableNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function durableBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function durableTail(value, limit) {
  const arr = durableArray(value);
  const max = Math.max(0, durableNumber(limit, 0));

  if (max <= 0) return [];
  if (arr.length <= max) return arr;

  return arr.slice(-max);
}

function durablePick(source, keys) {
  const obj = durableObject(source);
  const out = {};

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      out[key] = obj[key];
    }
  }

  return out;
}

function compactQuality(value = {}) {
  const q = durableObject(value);

  return durablePick(q, [
    "ok",
    "failures",
    "stage",
    "score",
    "confluence",
    "sniperScore",
    "plannedRR",
    "minScore",
    "minEntryScore",
    "minAlmostScore",
    "minConfluence",
    "minSniperScore",
    "minPlannedRR",
  ]);
}

function compactGateResult(value = {}) {
  const gate = durableObject(value);
  const decision = durableObject(gate.decision ?? gate);

  const activeMicroFamilyIds = durableArray(
    decision.activeMicroFamilyIds ?? gate.activeMicroFamilyIds
  );

  const realActiveMicroFamilyIds = durableArray(
    decision.realActiveMicroFamilyIds ?? gate.realActiveMicroFamilyIds
  );

  const checkedMicroFamilyIds = durableArray(
    decision.checkedMicroFamilyIds ?? gate.checkedMicroFamilyIds
  );

  return {
    ok: gate.ok,
    pass: gate.pass,
    allowed: gate.allowed,
    action: gate.action,

    decisionStatus: gate.decisionStatus ?? decision.status,
    reason: gate.reason ?? decision.reason,
    gateReason: gate.gateReason ?? decision.gateReason,
    waitReason: gate.waitReason,

    rotationId: gate.rotationId ?? decision.rotationId,
    activeRotationId: decision.activeRotationId,
    weekKey: decision.weekKey,
    source: decision.source,
    rankingMode: decision.rankingMode,

    microFamilyId: gate.microFamilyId ?? decision.microFamilyId,
    matchedMicroFamilyId: gate.matchedMicroFamilyId ?? decision.matchedMicroFamilyId,

    hasRealMicroAllowlist: gate.hasRealMicroAllowlist ?? decision.hasRealMicroAllowlist,
    bootstrap: gate.bootstrap ?? decision.bootstrap,
    softAllow: gate.softAllow ?? decision.softAllow,
    rotationDisabled: gate.rotationDisabled ?? decision.rotationDisabled,

    activeMicroFamilyCount: activeMicroFamilyIds.length,
    realActiveMicroFamilyCount: realActiveMicroFamilyIds.length,
    checkedMicroFamilyCount: checkedMicroFamilyIds.length,

    activeMicroFamilyIds: activeMicroFamilyIds.slice(0, DURABLE_LIMITS.activeFamilyIds),
    realActiveMicroFamilyIds: realActiveMicroFamilyIds.slice(0, DURABLE_LIMITS.activeFamilyIds),
    checkedMicroFamilyIds: checkedMicroFamilyIds.slice(0, DURABLE_LIMITS.checkedFamilyIds),

    quality: compactQuality(gate.quality ?? decision.quality),
  };
}

function compactFilterSnapshot(value = {}) {
  return durablePick(value, [
    "score",
    "moveScore",
    "entryScore",
    "finalScore",
    "confluence",
    "confluenceScore",
    "effectiveConfluence",
    "sniperScore",
    "rr",
    "baseRR",
    "plannedRR",
    "finalRR",
    "finalRr",
    "spreadBps",
    "spreadPct",
    "depthMinUsd1p",
    "depthUsd",
    "rsi",
    "rsiZone",
    "rsiState",
    "obBias",
    "orderbookBias",
    "flow",
    "flowState",
    "stage",
    "entryStage",
    "btcState",
    "btcRel",
    "fundingState",
    "fundingRate",
    "tfScore",
    "tfStrength",
    "session",
    "familyId",
    "parentFamilyId",
    "microFamilyId",
    "analyzerMicroFamilyId",
  ]);
}

function compactTradeRow(row = {}) {
  const r = durableObject(row);

  const gate =
    r.microRotationGate ??
    r.rotationGate ??
    r.gate ??
    r.gateResult ??
    r.rotationDecision ??
    r.decision;

  return {
    ...durablePick(r, [
      "id",
      "tradeId",
      "positionId",
      "orderId",
      "symbol",
      "side",
      "direction",
      "tradeSide",
      "action",
      "status",
      "stage",
      "setupClass",
      "reason",
      "entryReason",
      "exitReason",

      "score",
      "moveScore",
      "entryScore",
      "finalScore",
      "confluence",
      "effectiveConfluence",
      "sniperScore",

      "rr",
      "baseRR",
      "plannedRR",
      "finalRR",
      "finalRr",
      "riskReward",

      "entry",
      "entryPrice",
      "avgEntryPrice",
      "exit",
      "exitPrice",
      "markPrice",
      "lastPrice",

      "qty",
      "size",
      "notional",
      "leverage",
      "margin",

      "stopLoss",
      "sl",
      "takeProfit",
      "tp",
      "tp1",
      "tp2",
      "tp3",

      "realizedR",
      "pnlR",
      "closedR",
      "resultR",
      "pnlPct",
      "pnlPercent",
      "realizedPnlPct",
      "pnl",

      "openedAt",
      "closedAt",
      "entryTs",
      "exitTs",
      "createdAt",
      "updatedAt",
      "ts",

      "familyId",
      "parentFamilyId",
      "microFamilyId",
      "analyzerMicroFamilyId",
      "rotationFamilyId",
      "rotationId",
      "weekKey",

      "gateReason",
      "waitReason",
    ]),

    filterSnapshot: compactFilterSnapshot(r.filterSnapshot),

    microRotationGate: gate ? compactGateResult(gate) : undefined,
  };
}

function compactOpenPosition(row = {}) {
  const r = durableObject(row);

  return {
    ...durablePick(r, [
      "id",
      "tradeId",
      "positionId",
      "orderId",
      "symbol",
      "side",
      "direction",
      "tradeSide",
      "status",

      "entry",
      "entryPrice",
      "avgEntryPrice",
      "markPrice",
      "lastPrice",

      "qty",
      "size",
      "notional",
      "leverage",
      "margin",

      "stopLoss",
      "sl",
      "takeProfit",
      "tp",
      "tp1",
      "tp2",
      "tp3",
      "trail",
      "trailingStop",
      "breakEven",

      "score",
      "moveScore",
      "confluence",
      "effectiveConfluence",
      "sniperScore",
      "rr",
      "plannedRR",
      "finalRR",
      "finalRr",

      "openedAt",
      "entryTs",
      "createdAt",
      "updatedAt",
      "ts",

      "familyId",
      "parentFamilyId",
      "microFamilyId",
      "analyzerMicroFamilyId",
      "rotationId",
      "weekKey",
    ]),

    filterSnapshot: compactFilterSnapshot(r.filterSnapshot),
  };
}

function buildDurableCoreState(runtimeState = {}) {
  const state = durableObject(runtimeState);

  return {
    strategyVersion: state.strategyVersion,
    savedAt: new Date().toISOString(),

    balances: state.balances,
    equity: state.equity,
    wallet: state.wallet,
    account: state.account,

    stats: state.stats,
    counters: state.counters,
    config: state.config,

    openPositions: durableTail(
      state.openPositions,
      DURABLE_LIMITS.openPositions
    ).map(compactOpenPosition),

    entries: durableTail(
      state.entries,
      DURABLE_LIMITS.entries
    ).map(compactTradeRow),

    exits: durableTail(
      state.exits,
      DURABLE_LIMITS.exits
    ).map(compactTradeRow),

    recentEntries: durableTail(
      state.recentEntries,
      DURABLE_LIMITS.recentEntries
    ).map(compactTradeRow),

    closedTrades: durableTail(
      state.closedTrades,
      DURABLE_LIMITS.closedTrades
    ).map(compactTradeRow),

    // Niet in core. Dit was waarschijnlijk je 10MB killer.
    featureRows: [],
    shadowRows: [],

    meta: {
      originalCounts: {
        openPositions: durableArray(state.openPositions).length,
        entries: durableArray(state.entries).length,
        exits: durableArray(state.exits).length,
        recentEntries: durableArray(state.recentEntries).length,
        closedTrades: durableArray(state.closedTrades).length,
        featureRows: durableArray(state.featureRows).length,
        shadowRows: durableArray(state.shadowRows).length,
      },
    },
  };
}

async function redisSetJsonSafe(key, value) {
  const bytes = durableBytes(value);

  if (bytes > REDIS_SAFE_MAX_BYTES) {
    throw new Error(
      `REDIS_PAYLOAD_TOO_LARGE key=${key} bytes=${bytes} max=${REDIS_SAFE_MAX_BYTES}`
    );
  }

  return redisSetJson(key, value);
}

async function writeRuntimeCoreSafe(core, context = {}) {
  const rawBytes = durableBytes(core);

  if (rawBytes <= RUNTIME_CORE_TARGET_BYTES) {
    const bytes = await redisSetJson(RUNTIME_CORE_KEY, core);

    return {
      ok: true,
      bytes,
      rawBytes,
      compacted: false,
      compactMode: "none",
    };
  }

  console.warn("TRADE_SYSTEM_RUNTIME_CORE_COMPACT_RETRY:", JSON.stringify({
    runId: context.runId || null,
    key: RUNTIME_CORE_KEY,
    rawBytes,
    targetBytes: RUNTIME_CORE_TARGET_BYTES,
    maxBytes: REDIS_SAFE_MAX_BYTES,
    mode: "compact",
    ts: Date.now(),
  }));

  const compactCore = compactRuntimeCorePayload(core, "compact");
  const compactBytes = durableBytes(compactCore);

  if (compactBytes <= REDIS_SAFE_MAX_BYTES) {
    const bytes = await redisSetJson(RUNTIME_CORE_KEY, compactCore);

    console.log("TRADE_SYSTEM_RUNTIME_CORE_COMPACT_OK:", JSON.stringify({
      runId: context.runId || null,
      key: RUNTIME_CORE_KEY,
      rawBytes,
      compactBytes,
      savedBytes: rawBytes - compactBytes,
      mode: "compact",
      ts: Date.now(),
    }));

    return {
      ok: true,
      bytes,
      rawBytes,
      compactBytes,
      compacted: true,
      compactMode: "compact",
      savedBytes: rawBytes - compactBytes,
    };
  }

  console.warn("TRADE_SYSTEM_RUNTIME_CORE_ULTRA_RETRY:", JSON.stringify({
    runId: context.runId || null,
    key: RUNTIME_CORE_KEY,
    rawBytes,
    compactBytes,
    maxBytes: REDIS_SAFE_MAX_BYTES,
    mode: "ultra",
    ts: Date.now(),
  }));

  const ultraCore = compactRuntimeCorePayload(core, "ultra");
  const ultraBytes = durableBytes(ultraCore);

  const bytes = await redisSetJson(RUNTIME_CORE_KEY, ultraCore);

  console.log("TRADE_SYSTEM_RUNTIME_CORE_ULTRA_OK:", JSON.stringify({
    runId: context.runId || null,
    key: RUNTIME_CORE_KEY,
    rawBytes,
    ultraBytes,
    savedBytes: rawBytes - ultraBytes,
    mode: "ultra",
    ts: Date.now(),
  }));

  return {
    ok: true,
    bytes,
    rawBytes,
    compactBytes: ultraBytes,
    compacted: true,
    compactMode: "ultra",
    savedBytes: rawBytes - ultraBytes,
  };
}

// ================= PATCH 4: SAVE DURABLE STATE MET CONDITIONELE CHUNKS (B3) =================
// (Vervangen volgens aanpassing 2)
async function saveDurableRuntimeState(_runtimeState = runtimeState, options = {}) {
  if (!hasRedis()) {
    return {
      ok: false,
      skipped: true,
      reason: "REDIS_DISABLED"
    };
  }

  const strategyVersion =
    options.strategyVersion ??
    runtimeState.strategyVersion ??
    STRATEGY_VERSION;

  const runId =
    options.runId ??
    `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const writeState = async ({
    lockKey = RUNTIME_LOCK_KEY,
    lockOwner = options.lockOwner || null,
    lockReentrant = false
  } = {}) => {
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

    const core = buildRuntimeCorePayload();

    const recentEntries = durableTail(
      auditState.recentEntries,
      MAX_RECENT_ENTRY_AUDIT_ROWS
    ).map(compactTradeRow);

    const closedTrades = durableTail(
      auditState.closedTrades,
      MAX_CLOSED_TRADE_AUDIT_ROWS
    ).map(compactClosedTradeForStore);

    const featureStore =
      ENABLE_FEATURE_STORE && ENABLE_RAW_FEATURE_ROWS
        ? durableTail(auditState.featureStore, MAX_FEATURE_STORE_ROWS)
        : [];

    const shadowOutcomes =
      ENABLE_SHADOW_OUTCOMES
        ? durableTail(auditState.shadowOutcomes, MAX_SHADOW_OUTCOME_ROWS)
        : [];

    const coreWrite = await writeRuntimeCoreSafe(core, { runId });
    const coreBytes = coreWrite.bytes;

    const recentBytes = await redisSetJson(RUNTIME_RECENT_KEY, recentEntries);

    const closedResult = await writeJsonArrayChunks({
      metaKey: RUNTIME_CLOSED_META_KEY,
      chunkPrefix: RUNTIME_CLOSED_CHUNK_PREFIX,
      rows: closedTrades,
      previousChunkCount: Number(previousClosedMeta?.chunks || 0)
    });

    const featureResult = await writeJsonArrayChunks({
      metaKey: RUNTIME_FEATURE_META_KEY,
      chunkPrefix: RUNTIME_FEATURE_CHUNK_PREFIX,
      rows: featureStore,
      previousChunkCount: Number(previousFeatureMeta?.chunks || 0)
    });

    const shadowResult = await writeJsonArrayChunks({
      metaKey: RUNTIME_SHADOW_META_KEY,
      chunkPrefix: RUNTIME_SHADOW_CHUNK_PREFIX,
      rows: shadowOutcomes,
      previousChunkCount: Number(previousShadowMeta?.chunks || 0)
    });

    runtimeState.durableSavedAt = Date.now();

    console.log("TRADE SYSTEM DURABLE SAVE SPLIT:", JSON.stringify({
      strategyVersion,
      runId,
      lockKey,
      lockOwner,
      lockReentrant,
      coreBytes,
      coreRawBytes: coreWrite.rawBytes,
      coreCompacted: Boolean(coreWrite.compacted),
      coreCompactMode: coreWrite.compactMode,
      coreSavedBytes: coreWrite.savedBytes || 0,
      recentBytes,
      memory: memory.size,
      recentEntries: recentEntries.length,
      closedTrades: closedTrades.length,
      featureRows: featureStore.length,
      shadowRows: shadowOutcomes.length,
      closedChunks: closedResult.chunks,
      featureChunks: featureResult.chunks,
      shadowChunks: shadowResult.chunks,
      microLearning: {
        activeWeekKey: auditState.microLearning?.activeWeekKey || null,
        activeDayKey: auditState.microLearning?.activeDayKey || null,
        activeRotationFamilies: auditState.microLearning?.activeRotation?.allowedMicroFamilyIds?.length || 0,
        lastCompletedWeek: auditState.microLearning?.lastCompletedWeek?.weekKey || null
      }
    }));

    return {
      ok: true,
      key: RUNTIME_CORE_KEY,
      coreBytes,
      coreWrite,
      recentBytes,
      closedResult,
      featureResult,
      shadowResult
    };
  };

  // Belangrijk:
  // processTrades heeft de runtime-lock al.
  // Dan mag saveDurableRuntimeState niet opnieuw dezelfde lock proberen te pakken.
  try {
    if (options.lockAlreadyHeld === true) {
      const result = await writeState({
        lockKey: RUNTIME_LOCK_KEY,
        lockOwner: options.lockOwner || "LOCK_ALREADY_HELD"
      });

      return {
        ok: true,
        skipped: false,
        lockAlreadyHeld: true,
        result
      };
    }

    return await withDurableRuntimeLock({
      strategyVersion,
      runId,
      task: writeState
    });
  } catch (error) {
    const tooLarge = isRedisPayloadTooLargeError(error);

    console.error("TRADE_SYSTEM_DURABLE_SAVE_FAILED:", JSON.stringify({
      strategyVersion,
      runId,
      key: RUNTIME_CORE_KEY,
      message: error?.message || String(error),
      name: error?.name || null,
      tooLarge,
      nonFatal: tooLarge,
      ts: Date.now()
    }));

    if (tooLarge) {
      return {
        ok: false,
        skipped: true,
        nonFatal: true,
        durableSaveFailed: true,
        reason: "TRADE_SYSTEM_DURABLE_SAVE_TOO_LARGE",
        error: error?.message || "durable_save_too_large",
        key: RUNTIME_CORE_KEY,
        runId,
        ts: Date.now()
      };
    }

    throw error;
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

// ================= RUNTIME LOCK (REPAIRED) =================
async function acquireRuntimeLock(owner) {
  if (!hasRedis()) return false;

  try {
    const existingOwner = await redisCommand(["GET", RUNTIME_LOCK_KEY]);
    const ttlMs = await redisCommand(["PTTL", RUNTIME_LOCK_KEY]);

    if (existingOwner && ttlMs === -1) {
      console.warn("TRADE SYSTEM STALE LOCK WITHOUT TTL DETECTED, CLEARING:", JSON.stringify({
        key: RUNTIME_LOCK_KEY,
        existingOwner
      }));

      await redisCommand(["DEL", RUNTIME_LOCK_KEY]);
    }
  } catch (e) {
    console.warn("TRADE SYSTEM LOCK PREFLIGHT ERROR:", e.message);
  }

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

      const ttlMs = await redisCommand(["PTTL", RUNTIME_LOCK_KEY]).catch(() => null);

      console.warn("TRADE SYSTEM LOCK BUSY:", JSON.stringify({
        attempt: attempt + 1,
        ttlMs,
        key: RUNTIME_LOCK_KEY
      }));
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

// ================= PATCH 8: LOCK HEARTBEAT =================
function startRuntimeLockHeartbeat(owner) {
  if (!hasRedis()) {
    return () => {};
  }

  const interval = setInterval(async () => {
    try {
      const currentOwner = await redisCommand(["GET", RUNTIME_LOCK_KEY]);

      if (currentOwner !== owner) {
        clearInterval(interval);
        return;
      }

      await redisCommand(["PEXPIRE", RUNTIME_LOCK_KEY, DURABLE_LOCK_TTL_MS]);
    } catch (e) {
      console.warn("TRADE SYSTEM LOCK HEARTBEAT ERROR:", e.message);
    }
  }, Math.max(5000, Math.floor(DURABLE_LOCK_TTL_MS / 3)));

  return () => clearInterval(interval);
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

function updateOrderbookMemorySafe(symbol, raw, analyzed) {
  try {
    if (typeof updateOrderbookMemory !== "function") {
      return false;
    }

    updateOrderbookMemory(normalizeBaseSymbol(symbol), raw, analyzed);
    return true;
  } catch (e) {
    console.warn("ORDERBOOK_MEMORY_UPDATE_FAILED:", JSON.stringify({
      symbol,
      error: e.message
    }));

    return false;
  }
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

function safeNumber(value, defaultValue = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
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

  if (DISCOVERY_MODE && depth <= 0) {
    return {
      ok: true,
      reason: "DEPTH_MISSING_BYPASSED_DISCOVERY"
    };
  }

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

  if (["UPPER_2", "UPPER_3"].includes(rsiZone)) {
    return { ok: false, reason: "BULL_RSI_EXTENSION_BLOCK" };
  }

  if (rsiZone === "UPPER_1" && !Boolean(candidate.rsiContinuationOK)) {
    return { ok: false, reason: "BULL_RSI_UPPER1_NO_CONTINUATION" };
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

// ================= PATCH 2: VERVANGENDE FUNCTIE =================
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

  const confluence = Number(candidate.confluence || 0);
  const sniperScore = Number(candidate.sniperScore || 0);
  const plannedRR = Number(candidate.plannedRR || 0);
  const spread = normalizeSpread(candidate.spreadPct);
  const depth = Number(candidate.depthMinUsd1p || 0);

  const strongNeutralObShort =
    obBias === "NEUTRAL" &&
    confluence >= 85 &&
    sniperScore >= 85;

  const checks = {
    validStage: ["entry", "almost"].includes(stage),
    validRsi: ["MID", "UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone),
    validFlow: ["TREND", "BUILDING", "NEUTRAL"].includes(flow),

    validOb:
      obBias === "BEARISH" ||
      strongNeutralObShort,

    tightSpread: spread <= BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT,
    goodDepth: depth >= BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P,

    validConf:
      confluence >= BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF &&
      confluence <= BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF,

    validRR: plannedRR >= BTC_BULLISH_BEAR_EXCEPTION_MIN_RR,
    validSniper: sniperScore >= BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER
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

// ================= PATCH 3: VALIDATE BULLISH MID TREND PROBE MET MOMENTUM =================
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
    validMomentum:
      Number(candidate.change1h || 0) >= BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT &&
      Number(candidate.change24 || 0) >= BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT,
    validConfluence: confluence >= BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE,
    validSniper: sniperScore >= BULLISH_MID_TREND_PROBE_MIN_SNIPER,
    validRR: plannedRR >= BULLISH_MID_TREND_PROBE_MIN_RR,
    tightSpread: spread <= BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT,
    goodDepth: depth >= BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P,
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

  for (const [key, expiresAt] of lastSignalMap.entries()) {
    const k = String(key || "");

    if (!k.startsWith("CONFIRM_")) continue;

    const expiry = Number(expiresAt || 0);

    if (expiry > 0 && now >= expiry) {
      lastSignalMap.delete(key);
    }
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

// ================= NEW EXPOSURE HELPER FUNCTIONS =================
function isCounterBtcSide(side, btcState) {
  const s = String(side || "").toLowerCase();
  const btc = String(btcState || "NEUTRAL").toUpperCase();

  if (s === "bull" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return true;
  if (s === "bear" && ["BULLISH", "STRONG_BULL"].includes(btc)) return true;

  return false;
}

function getOpenExposureCounts(btcState) {
  const counts = {
    total: 0,
    bull: 0,
    bear: 0,
    counterBtc: 0
  };

  for (const pos of memory.values()) {
    const side = String(pos?.side || "").toLowerCase();

    counts.total++;

    if (side === "bull") counts.bull++;
    if (side === "bear") counts.bear++;

    if (isCounterBtcSide(side, btcState)) {
      counts.counterBtc++;
    }
  }

  return counts;
}

function validateExposureCaps(candidate, btcState) {
  const side = String(candidate?.side || "").toLowerCase();
  const counts = getOpenExposureCounts(btcState);

  if (counts.total >= MAX_OPEN_POSITIONS_TOTAL) {
    return {
      ok: false,
      reason: "MAX_OPEN_POSITIONS_TOTAL"
    };
  }

  if (side === "bull" && counts.bull >= MAX_OPEN_POSITIONS_SAME_SIDE) {
    return {
      ok: false,
      reason: "MAX_OPEN_BULL_POSITIONS"
    };
  }

  if (side === "bear" && counts.bear >= MAX_OPEN_POSITIONS_SAME_SIDE) {
    return {
      ok: false,
      reason: "MAX_OPEN_BEAR_POSITIONS"
    };
  }

  if (
    isCounterBtcSide(side, btcState) &&
    counts.counterBtc >= MAX_COUNTER_BTC_OPEN_POSITIONS
  ) {
    return {
      ok: false,
      reason: "MAX_COUNTER_BTC_POSITIONS"
    };
  }

  return {
    ok: true,
    reason: "EXPOSURE_OK"
  };
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

// ================= PATCH 1: EXIT ALTIJD HOOGSTE PRIORITY =================
function getActionPriority(action) {
  const a = String(action?.action || "").toUpperCase();
  const setupClass = String(action?.setupClass || "NONE").toUpperCase();

  if (a === "EXIT") return 9000;

  if (a === "ENTRY" && setupClass === "GOD") return 7000;
  if (a === "ENTRY" && setupClass === "A") return 6000;
  if (a === "ENTRY" && setupClass === "A_SHORT_EXCEPTION") return 5600;
  if (a === "ENTRY" && setupClass === "B") return 5000;
  if (a === "ENTRY" && setupClass === "B_TREND_PROBE") return 4800;
  if (a === "ENTRY") return 4500;

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

    microFamilyId: extractMicroFamilyIdFromSignal(c),
    microFamily: extractMicroFamilyIdFromSignal(c),
    microFamilyIds: extractMicroFamilyIdFromSignal(c)
      ? [extractMicroFamilyIdFromSignal(c)]
      : [],
    microFamilies: extractMicroFamilyIdFromSignal(c)
      ? [extractMicroFamilyIdFromSignal(c)]
      : [],

    funding: Number(funding?.rate || 0),

    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null,

    tfScore: Number(c?.tfScore || 0),
    tfStrength: Number(c?.tfStrength || 0),
    tfAlignment: c?.tfAlignment || "UNKNOWN",

    minRrRequired: Number(c?.minRrFloor || 0),
    rsiZone: c._debugRsiZone || null,

    rawConfluence: c._debugRawConfluence ?? null,
    effectiveConfluence: c._debugEffectiveConfluence ?? null,
    rsiEntryEdge: c._debugRsiEntryEdge || c._debugRsiEdge || null,
    rsiEdge: c._debugRsiEntryEdge || c._debugRsiEdge || null,
    rsiConfluenceBoost: c._debugRsiConfluenceBonus ?? 0,
    rsiRrDiscount: c._debugRsiRrDiscount ?? 0,
    rsiSniperDiscount: c._debugRsiSniperDiscount ?? 0,
    setupEvalRR: c._debugSetupEvalRR ?? null,

    externalConfluence: c._debugExternalConfluence ?? null,
    fallbackConfluence: c._debugFallbackConfluence ?? null,
    confluenceBlendUsed: Boolean(c._debugConfluenceBlendUsed),
    confluenceSource: c._debugConfluenceSource || null,

    rawSniperScore: c._debugRawSniperScore ?? null,
    fallbackSniperScore: c._debugFallbackSniperScore ?? null,
    sniperBlendUsed: Boolean(c._debugSniperBlendUsed),

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

  if (
    ["LOW_CONFLUENCE", "LOW_GLOBAL_CONFLUENCE", "NEUTRAL_OB_LOW_CONFLUENCE", "OB_AGAINST_SIDE"].includes(reason) &&
    requiredConfluence !== null &&
    confluence !== null
  ) {
    payload.reasonScore = Number(confluence) - Number(requiredConfluence);
  }

  if ((reason === "LOW_RR" || reason === "LOW_FINAL_RR") && requiredRR !== null && rr !== null) {
    payload.reasonScore = Number(rr) - Number(requiredRR);

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

// ================= FIRE-AND-FORGET DISCORD HELPERS =================
function normalizeDiscordResult(result) {
  if (result === undefined || result === null) {
    return {
      ok: true,
      mode: "FIRE_AND_FORGET"
    };
  }

  if (result.discordSent === true || result.ok === true || result.sent === true) {
    return {
      ok: true,
      mode: "CONFIRMED",
      result
    };
  }

  if (result.discordSent === false || result.ok === false || result.sent === false) {
    return {
      ok: false,
      mode: "FAILED",
      result
    };
  }

  return {
    ok: true,
    mode: "UNKNOWN_OK",
    result
  };
}

async function notifyEntrySafe(payload) {
  console.log("TS_DISCORD_ENTRY_ATTEMPT:", JSON.stringify({
    symbol: payload.symbol,
    side: payload.side,
    setupClass: payload.setupClass,
    grade: payload.grade,
    reason: payload.entryType || payload.reason,
    rr: payload.rr
  }));

  try {
    const result = await sendEntry(payload);
    const parsed = normalizeDiscordResult(result);

    if (!parsed.ok) {
      console.warn("TS_DISCORD_ENTRY_FAILED:", JSON.stringify({
        symbol: payload.symbol,
        side: payload.side,
        setupClass: payload.setupClass,
        result: parsed.result
      }));
    }

    return parsed.ok;
  } catch (e) {
    console.error("TS_DISCORD_ENTRY_ERROR:", JSON.stringify({
      symbol: payload.symbol,
      side: payload.side,
      setupClass: payload.setupClass,
      error: e.message
    }));

    return false;
  }
}

async function notifyExitSafe(payload) {
  console.log("TS_DISCORD_EXIT_ATTEMPT:", JSON.stringify({
    symbol: payload.symbol,
    side: payload.side,
    setupClass: payload.setupClass,
    grade: payload.grade,
    reason: payload.reason
  }));

  try {
    const result = await sendExit(payload);
    const parsed = normalizeDiscordResult(result);

    if (!parsed.ok) {
      console.warn("TS_DISCORD_EXIT_FAILED:", JSON.stringify({
        symbol: payload.symbol,
        side: payload.side,
        setupClass: payload.setupClass,
        result: parsed.result
      }));
    }

    return parsed.ok;
  } catch (e) {
    console.error("TS_DISCORD_EXIT_ERROR:", JSON.stringify({
      symbol: payload.symbol,
      side: payload.side,
      setupClass: payload.setupClass,
      error: e.message
    }));

    return false;
  }
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

    const side = String(c.side).toLowerCase();

    if (side !== "bull" && side !== "bear") {
      pushPrefilterReject(prefilterStats, "MISSING", c);
      continue;
    }

    filtered.push({
      ...c,
      stage: String(c.stage || "radar").toLowerCase(),
      moveScore: Number(c.moveScore || c.score || 0),
      analysisType: "DISCOVERY_ALL_COINS"
    });
  }

  const map = new Map();

  for (const c of dedupeCandidates(filtered)) {
    const key = `${normalizeBaseSymbol(c.symbol)}_${String(c.side).toLowerCase()}`;

    map.set(key, {
      ...c,
      setupClass: null,
      analysisType: "DISCOVERY_ALL_COINS",
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

  console.log("TS_PREFILTER_DISCOVERY", JSON.stringify({
    ...prefilterStats,
    finalCandidates: candidates.length,
    mode: "ALL_COINS_RELAXED"
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

// ================= PATCH 6B: TP multiplier voor A_SHORT_EXCEPTION =================
function getTpRewardMultiplier({ setupClass, certaintyMode, sniperScore, rsi, isBull }) {
  if (certaintyMode === "safe") {
    return 0.95;
  }

  const cls = String(setupClass || "").toUpperCase();
  const isAClass = ["A", "A_SHORT_EXCEPTION"].includes(cls);
  const isGodClass = cls === "GOD";

  let multiplier = 1.0;

  if (isGodClass) multiplier = 1.35;
  else if (isAClass) multiplier = 1.20;
  else if (cls === "B") multiplier = 1.05;
  else if (cls === "B_TREND_PROBE") multiplier = 1.03;

  if (isAClass || isGodClass) {
    if (sniperScore >= 90) multiplier += 0.08;
    else if (sniperScore >= 80) multiplier += 0.04;
  }

  if (isBull) {
    if (rsi < 30) multiplier += 0.06;
    else if (rsi < 45) multiplier += 0.03;
  } else {
    if (rsi > 70) multiplier += 0.06;
    else if (rsi > 55) multiplier += 0.03;
  }

  if (cls === "B" || cls === "B_TREND_PROBE") {
    return clamp(multiplier, 1.00, 1.15);
  }

  if (isAClass || isGodClass) {
    return clamp(multiplier, 1.15, A_GOD_MAX_TP_REWARD_MULTIPLIER);
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

// ---- RSI EDGE HELPERS ----
function getRsiZoneRankForSide({ isBull, rsiZone }) {
  const zone = String(rsiZone || "MID").toUpperCase();

  if (isBull) {
    if (zone === "LOWER_3") return 3;
    if (zone === "LOWER_2") return 2;
    if (zone === "LOWER_1") return 1;
    if (zone === "MID") return 0;
    if (zone === "UPPER_1") return -1;
    if (zone === "UPPER_2") return -2;
    if (zone === "UPPER_3") return -3;
  } else {
    if (zone === "UPPER_3") return 3;
    if (zone === "UPPER_2") return 2;
    if (zone === "UPPER_1") return 1;
    if (zone === "MID") return 0;
    if (zone === "LOWER_1") return -1;
    if (zone === "LOWER_2") return -2;
    if (zone === "LOWER_3") return -3;
  }
  return 0;
}

function getRsiEdgeMeta({ isBull, rsiSignal, rsiZone }) {
  const rank = getRsiZoneRankForSide({ isBull, rsiZone });
  const continuationScore = Number(rsiSignal?.continuationScore || 0);
  const slope3 = Number(rsiSignal?.slope3 || 0);
  const continuationOk = continuationScore >= 5 && (isBull ? slope3 >= -0.35 : slope3 <= 0.35);

  let confluenceBonus = 0;
  let rrDiscount = 0;
  let sniperDiscount = 0;

  if (rank === 3) {
    confluenceBonus = 14;
    rrDiscount = 0.08;
    sniperDiscount = 8;
  } else if (rank === 2) {
    confluenceBonus = 10;
    rrDiscount = 0.06;
    sniperDiscount = 5;
  } else if (rank === 1) {
    confluenceBonus = 6;
    rrDiscount = 0.03;
    sniperDiscount = 3;
  } else if (rank === 0) {
    confluenceBonus = continuationOk ? 3 : -4;
    rrDiscount = continuationOk ? MID_RSI_CONTINUATION_RR_DISCOUNT : 0;
    sniperDiscount = continuationOk ? 2 : 0;
  } else if (rank === -1) {
    confluenceBonus = -6;
  } else if (rank === -2) {
    confluenceBonus = -12;
  } else if (rank <= -3) {
    confluenceBonus = -20;
  }

  const hardBlock = rank <= -3 && !continuationOk;

  const gradePoints =
    rank >= 3 ? 2
    : rank >= 2 ? 1
    : rank < 0 ? -1
    : 0;

  return {
    rank,
    continuationOk,
    continuationScore,
    slope3,
    confluenceBonus,
    rrDiscount,
    sniperDiscount,
    gradePoints,
    hardBlock,
    label:
      rank >= 2 ? "RSI_STRONG_EDGE"
      : rank === 1 ? "RSI_EDGE"
      : rank === 0 && continuationOk ? "RSI_CONTINUATION"
      : rank < 0 ? "RSI_AGAINST"
      : "RSI_NEUTRAL"
  };
}

function applyRsiEdgeToConfluence(rawConfluence, rsiEdge) {
  return clamp(
    Math.round(Number(rawConfluence || 0) + Number(rsiEdge?.confluenceBonus || 0)),
    0,
    100
  );
}

function applyRsiEdgeToRequiredRR(
  requiredRR,
  rsiEdge,
  minFloor = MIN_RR_FLOOR
) {
  return clamp(
    Number(requiredRR || 0) - Number(rsiEdge?.rrDiscount || 0),
    minFloor,
    2.50
  );
}

function getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull }) {
  let points = 0;

  const tfStrength = Number(c?.tfStrength || 0);
  const sniperScore = getSniperScore(sniper);
  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  const rsiEdge = c?._debugRsiEdgeMeta || getRsiEdgeMeta({
    isBull,
    rsiZone: c?._debugRsiZone
  });
  points += Number(rsiEdge.gradePoints || 0);

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

  const minDepthForQuality =
    isBull && flow?.type === "TREND"
      ? BULL_TREND_MIN_DEPTH_USD_1P
      : MIN_DEPTH_USD_1P_ABSOLUTE;

  if (spread <= MAX_SPREAD_PCT && depth >= minDepthForQuality) {
    points += 1;
  }

  if (spread > MAX_SPREAD_PCT * 1.35) {
    points -= 2;
  } else if (spread > MAX_SPREAD_PCT) {
    points -= 1;
  }

  if (depth > 0 && depth < MIN_DEPTH_USD_1P_ABSOLUTE) {
    points -= 3;
  } else if (depth > 0 && depth < minDepthForQuality) {
    points -= 1;
  }

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

  // A quality is enforced by sniper/confluence + finalRr after TP multiplier.
  // Do not raise pre-multiplier baseRR here, because fallback risk geometry
  // naturally produces ~1.05 baseRR before TP expansion.
  if (
    c.stage === "entry" &&
    flow?.type === "TREND" &&
    !counterTrend &&
    setupGrade?.grade === "A" &&
    confluence >= 88 &&
    sniper?.valid &&
    getSniperScore(sniper) >= 80
  ) {
    floor = Math.max(floor, A_ENTRY_MIN_RR);
  }

  // FIX: was clamp(floor, 0.50, 0.50)
  return clamp(floor, MIN_RR_FLOOR, 1.70);
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

function isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupClass, counterTrend }) {
  const sniperScore = getSniperScore(sniper);
  const cls = String(setupClass || "").toUpperCase();

  if (c.stage !== "entry") return false;
  if (flow.type !== "TREND") return false;
  if (counterTrend) return false;

  if (["A", "GOD", "A_SHORT_EXCEPTION"].includes(cls)) {
    return (
      confluence >= NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE &&
      rr >= NEUTRAL_OB_A_EXCEPTION_MIN_RR &&
      sniper?.valid &&
      sniperScore >= NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER
    );
  }

  if (["B", "B_TREND_PROBE"].includes(cls)) {
    return (
      confluence >= NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE &&
      rr >= NEUTRAL_OB_B_EXCEPTION_MIN_RR &&
      sniper?.valid &&
      sniperScore >= NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER &&
      Number(c.moveScore || 0) >= NEUTRAL_OB_B_EXCEPTION_MIN_SCORE
    );
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

// ================= PATCH 6A: BREAK-EVEN VOOR A_SHORT_EXCEPTION (met disable flag) =================
function applyBreakEvenRule(position, isBull) {
  if (!ENABLE_BREAK_EVEN_RULE) return position;

  if (!position) return position;

  const setupClass = String(position.setupClass || "").toUpperCase();

  if (!["A", "GOD", "A_SHORT_EXCEPTION"].includes(setupClass)) {
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

  if (Number(position.ticksObserved || 0) < BREAK_EVEN_MIN_TICKS) {
    return position;
  }

  if (Number(position.favorableTicks || 0) < BREAK_EVEN_MIN_FAVORABLE_TICKS) {
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

// ================= POST-EXIT MONITORING (OPTIONAL) =================
function initializePostExitFields(trade) {
  if (!trade) return trade;

  if (!ENABLE_POST_EXIT_MONITOR) {
    return {
      ...trade,
      postExitMonitor: null
    };
  }

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
  if (!ENABLE_POST_EXIT_MONITOR) return;

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

// ================= FEATURE STORE / SHADOW OPTIMIZER (DISABLED) =================
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

  return enrichFeatureBuckets(enrichRowWithMicroRotation(row));
}

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

function createShadowOutcome(row, source = "SHADOW") {
  return {
    ...row,

    id: `shadow_${row.runId}_${row.symbol}_${row.side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    shadowDedupeKey: getShadowDedupeKey(row),

    source,
    originSource: String(row.source || "ACTION").toUpperCase(),
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
  const entry = Number(risk?.entry ?? c?.price ?? 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);
  const side = String(c?.side || "").toLowerCase();

  const hasRiskGeometry =
    entry > 0 &&
    sl > 0 &&
    tp > 0 &&
    Math.abs(entry - sl) > 0;

  const row = {
    id: `scan_${runId}_${normalizeBaseSymbol(c?.symbol)}_${side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    ts: Date.now(),

    source: "SCAN_OBSERVATION",
    action: "WAIT",
    reason: "SCAN_OBSERVATION",

    symbol: normalizeBaseSymbol(c?.symbol),
    side,

    setupClass: String(setupGrade?.grade || "C").toUpperCase(),
    grade: setupGrade?.grade || "C",
    gradePoints: Number(setupGrade?.points || 0),
    recommendedRisk: setupGrade?.recommendedRisk || "watch",

    entryReason: "SCAN_OBSERVATION",

    stage: String(c?.stage || "unknown").toLowerCase(),
    scannerStage: String(c?.scannerStage || c?.stage || "unknown").toLowerCase(),
    stageSource: c?.stageSource || "unknown",

    score: Number(c?.moveScore || 0),
    confluence: Number(confluence || 0),

    sniper: sniper?.type || "NONE",
    sniperScore: Number(sniper?.score || 0),

    flow: String(flow?.type || c?.flow || "UNKNOWN").toUpperCase(),
    btcState: String(btcState || "UNKNOWN").toUpperCase(),
    regime: String(regimeLevel || "UNKNOWN").toUpperCase(),

    rsi: Number(rsi || 0),
    rsiHTF: Number(rsiHTF || 0),
    rsiZone: String(rsiZone || "UNKNOWN").toUpperCase(),

    rsiValid: Boolean(rsiValid),
    rsiBlocked: Boolean(rsiHtfBlocked),
    rsiExhaustedAgainstSide: false,

    obBias: String(ob?.bias || "UNKNOWN").toUpperCase(),
    spreadPct: Number(ob?.spreadPct || 0),
    depthMinUsd1p: Number(ob?.depthMinUsd1p || 0),
    obFetchFailed: Boolean(ob?.fetchFailed),
    spoof: Boolean(ob?.spoof),

    obAgainst: getObSideRelation(side, ob?.bias) === "AGAINST",

    funding: Number(funding?.rate || 0),

    tfScore: Number(c?.tfScore || 0),
    tfStrength: Number(c?.tfStrength || 0),
    tfAlignment: String(c?.tfAlignment || "UNKNOWN").toUpperCase(),

    change1h: Number(c?.change1h || 0),
    change24: Number(c?.change24 || 0),

    plannedRR: Number(rr || 0),
    rr: Number(rr || 0),
    baseRR: Number(rr || 0),
    finalRr: Number(rr || 0),
    minRrRequired: Number(c?.minRrFloor || 0),

    entry,
    sl,
    tp,
    hasRiskGeometry,

    fakeBreakout: Boolean(isValidFakeBreakout),
    hasLiquidationData: Boolean(hasLiquidationData),

    pullbackConfirmed: Boolean(bullPullbackMeta?.pullbackConfirmed),
    sweepConfirmed: Boolean(bullPullbackMeta?.sweepConfirmed),
    retestConfirmed: Boolean(bullPullbackMeta?.retestConfirmed),

    distanceFromLocalHighPct: Number(bullPullbackMeta?.distanceFromLocalHighPct || 0),
    pullbackFromHighPct: Number(bullPullbackMeta?.distanceFromLocalHighPct || 0),

    structureAligned: true,

    liveEligible: false,
    shadowOnly: true,
    scannerHot: Number(c?.moveScore || 0) >= CANDIDATE_MIN_SCORE,

    fromOpenPosition: Boolean(c?.fromOpenPosition),
    analysisType: c?.analysisType || "DEEP",

    strategyVersion: STRATEGY_VERSION
  };

  return enrichFeatureBuckets(enrichRowWithMicroRotation(row));
}

function recordScanObservation(row) {
  if (!row?.symbol || !row?.side) return;

  const enrichedRow = enrichRowWithMicroRotation(row);

  // Elke coin wordt meegeteld in daily micro-family observations.
  recordMicroObservation(enrichedRow);

  if (ENABLE_RAW_FEATURE_ROWS) {
    if (!Array.isArray(auditState.featureStore)) {
      auditState.featureStore = [];
    }

    auditState.featureStore.push(enrichedRow);
  }

  if (
    ENABLE_SHADOW_OUTCOMES &&
    enrichedRow.hasRiskGeometry &&
    !hasRecentShadowOutcome(enrichedRow)
  ) {
    if (!Array.isArray(auditState.shadowOutcomes)) {
      auditState.shadowOutcomes = [];
    }

    auditState.shadowOutcomes.push(createShadowOutcome(enrichedRow, "SCAN_SHADOW"));
  }

  trimAuditArrays();
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

  recordMicroOutcome(row, row.source || "SHADOW");

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
  if (!ENABLE_SHADOW_OUTCOMES) return;

  const rows = Array.isArray(auditState.shadowOutcomes)
    ? auditState.shadowOutcomes
    : [];

  if (!rows.length) return;

  const now = Date.now();

  const active = rows
    .filter(row => String(row.status || "OPEN").toUpperCase() === "OPEN")
    .filter(row => now <= Number(row.monitorUntil || 0))
    .sort((a, b) => Number(a.lastCheckedAt || 0) - Number(b.lastCheckedAt || 0))
    .slice(0, SHADOW_MAX_MONITOR_PER_RUN);

  await mapConcurrent(
    active,
    Math.min(DATA_FETCH_CONCURRENCY, 5),
    async row => {
      const price = await fetchPostExitPrice(row);
      if (!price) return;

      updateShadowOutcomeWithPrice(row, price);
    }
  );

  for (const row of rows) {
    if (String(row.status || "OPEN").toUpperCase() !== "OPEN") continue;
    if (now < Number(row.monitorUntil || 0)) continue;

    const fallbackPrice = Number(row.exit || row.entry || 0);
    const r = calculateShadowR(row, fallbackPrice);
    const pnlPct = calculateShadowPnlPct(row, fallbackPrice);

    completeShadowOutcome(row, "HORIZON_DONE", fallbackPrice, r, pnlPct);
  }
}

function recordActionFeatureRows(actions, btcState, runId) {
  if (!Array.isArray(actions) || !actions.length) return;
  if (!ENABLE_RAW_FEATURE_ROWS && !ENABLE_SHADOW_OUTCOMES) return;

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

    const row = enrichRowWithMicroRotation(
      buildFeatureRowFromAction(action, btcState, runId)
    );

    // Elke action telt mee als observation.
    recordMicroObservation(row);

    if (ENABLE_RAW_FEATURE_ROWS) {
      auditState.featureStore.push(row);
    }

    if (
      ENABLE_SHADOW_OUTCOMES &&
      isShadowEligible(row) &&
      !hasRecentShadowOutcome(row)
    ) {
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

    familyId: t.familyId || null,
    microFamilyId: t.microFamilyId || null,
    familyIds: Array.isArray(t.familyIds) ? t.familyIds : [],
    microFamilyIds: Array.isArray(t.microFamilyIds) ? t.microFamilyIds : [],

    strategyVersion: t.strategyVersion || STRATEGY_VERSION
  };

  return enrichFeatureBuckets(enrichRowWithMicroRotation(row));
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

  return enrichFeatureBuckets(enrichRowWithMicroRotation(outcome));
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

// ================= MICRO ROTATION HELPERS (call forward to new gate) =================
const MICRO_FAMILY_PATHS = [
  "microFamilyId",
  "microfamilyId",
  "microFamily",
  "microfamily",
  "rotationMicroFamilyId",
  "analyzerMicroFamilyId",
  "scannerMicroFamilyId",

  "meta.microFamilyId",
  "meta.microfamilyId",

  "scanner.microFamilyId",
  "scanner.microfamilyId",
  "scannerMeta.microFamilyId",
  "scannerMeta.microfamilyId",

  "analysis.microFamilyId",
  "analysis.microfamilyId",

  "family.microFamilyId",
  "family.microfamilyId",

  "micro.id",
  "micro.familyId",
  "micro.microFamilyId"
];

function getNestedSignalValue(object, dottedPath) {
  if (!object || !dottedPath) return null;

  return dottedPath.split(".").reduce((current, key) => {
    if (!current || typeof current !== "object") return null;
    return current[key];
  }, object);
}

function normalizeMicroFamilyId(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const id = value
    .toUpperCase()
    .replace(/[^A-Z0-9.%+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  // Weekly analyzer rotation gebruikt alleen echte analyzer MICRO_* ids.
  if (!id.startsWith("MICRO_")) return null;

  if (id.startsWith("SUB_")) return null;
  if (id.startsWith("PARENT_")) return null;
  if (id.includes("UNKNOWN")) return null;
  if (/^(LONG|SHORT)_\d+/.test(id)) return null;

  return id;
}

function extractMicroFamilyIdFromSignal(signal = {}) {
  const candidates = [];

  if (Array.isArray(signal.microFamilyIds)) {
    candidates.push(...signal.microFamilyIds);
  }

  if (Array.isArray(signal.microFamilies)) {
    candidates.push(...signal.microFamilies);
  }

  for (const path of MICRO_FAMILY_PATHS) {
    candidates.push(getNestedSignalValue(signal, path));
  }

  for (const candidate of candidates) {
    const microFamilyId = normalizeMicroFamilyId(candidate);
    if (microFamilyId) return microFamilyId;
  }

  return null;
}

// ================= BITGET CANDLE FETCH FUNCTIONS =================
function normalizeBitgetGranularity(timeframe) {
  const tf = String(timeframe || "").trim().toLowerCase();

  const map = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",

    "1h": "1H",
    "60m": "1H",

    "2h": "2H",
    "120m": "2H",

    "4h": "4H",
    "240m": "4H",

    "6h": "6H",
    "12h": "12H",

    "1d": "1D",
    "1day": "1D",

    "3d": "3D",

    "1w": "1W",
    "1week": "1W",

    "1mo": "1M",
    "1mth": "1M",
    "1month": "1M"
  };

  return map[tf] || String(timeframe || "15m");
}

function parseBitgetCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;

  const ts = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  const quoteVolume = Number(row[6] || 0);

  if (
    !Number.isFinite(ts) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  return {
    ts,
    timestamp: ts,
    time: ts,

    open,
    high,
    low,
    close,

    volume: Number.isFinite(volume) ? volume : 0,
    quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0
  };
}

async function fetchBitgetCandleEndpoint({
  path,
  symbol,
  granularity,
  limit
}) {
  const url = new URL(path, BITGET_API_BASE_URL);

  url.searchParams.set("symbol", normalizeBitgetSymbol(symbol));
  url.searchParams.set("productType", BITGET_PRODUCT_TYPE);
  url.searchParams.set("granularity", granularity);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("kLineType", "MARKET");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BITGET_CANDLE_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    const text = await res.text();

    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = new Error(`bitget_candles_http_${res.status}`);
      err.status = res.status;
      err.body = text?.slice(0, 500);
      throw err;
    }

    if (json?.code && json.code !== "00000") {
      const err = new Error(`bitget_candles_api_${json.code}_${json.msg || "unknown"}`);
      err.status = res.status;
      err.body = text?.slice(0, 500);
      throw err;
    }

    return Array.isArray(json?.data) ? json.data : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCandles(symbol, timeframe = "15m", limit = 100) {
  const normalizedSymbol = normalizeBitgetSymbol(symbol);
  const granularity = normalizeBitgetGranularity(timeframe);
  const safeLimit = Math.max(1, Math.min(Number(limit || 100), 1000));

  const endpoints = [
    {
      path: "/api/v2/mix/market/candles",
      limit: safeLimit
    },
    {
      path: "/api/v2/mix/market/history-candles",
      limit: Math.min(safeLimit, 200)
    }
  ];

  let lastError = null;

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rawRows = await fetchBitgetCandleEndpoint({
          path: endpoint.path,
          symbol: normalizedSymbol,
          granularity,
          limit: endpoint.limit
        });

        const candles = rawRows
          .map(parseBitgetCandle)
          .filter(Boolean)
          .sort((a, b) => Number(a.ts) - Number(b.ts));

        if (candles.length) {
          if (process.env.TS_DEBUG_CANDLES === "true") {
            console.log("BITGET_CANDLES_FETCH_OK:", JSON.stringify({
              symbol: normalizedSymbol,
              timeframe,
              granularity,
              endpoint: endpoint.path,
              candles: candles.length,
              firstTs: candles[0]?.ts || null,
              lastTs: candles[candles.length - 1]?.ts || null
            }));
          }

          return candles.slice(-safeLimit);
        }

        break;
      } catch (e) {
        lastError = e;

        const status = Number(e?.status || 0);
        const retryable =
          status === 429 ||
          status >= 500 ||
          e?.name === "AbortError";

        if (!retryable) break;

        await sleep(350 + attempt * 500);
      }
    }
  }

  console.warn("BITGET_CANDLES_FETCH_FAILED:", JSON.stringify({
    symbol: normalizedSymbol,
    timeframe,
    granularity,
    limit: safeLimit,
    error: lastError?.message || "empty_response",
    status: lastError?.status || null
  }));

  return [];
}

// ================= ENTRY CORE SAFE ADAPTERS =================
async function callFirstValid(label, variants, isValid, fallback = null) {
  let lastError = null;

  for (const variant of variants) {
    try {
      const value = await variant();

      if (isValid(value)) {
        return value;
      }
    } catch (e) {
      lastError = e;
    }
  }

  if (lastError && process.env.TS_DEBUG_ENTRY_CORE === "true") {
    console.warn("TS_SAFE_ADAPTER_FAILED:", JSON.stringify({
      label,
      error: lastError.message
    }));
  }

  return fallback;
}

function getDefaultRsiZones() {
  return {
    U1: 60,
    U2: 67,
    U3: 74,

    L1: 40,
    L2: 33,
    L3: 26,

    stress: 0,
    sATR: 0,
    sRSI: 0,
    tComp: 0,

    d1: 10,
    d2: 17,
    d3: 24
  };
}

function normalizeRsiSignalSafe(raw, rsiData) {
  const mtf = rsiData?.mtf || {};
  const m15 = mtf?.m15 || {};
  const h1 = mtf?.h1 || {};

  const rsi = safeNumber(
    raw?.rsi ??
    raw?.m15 ??
    raw?.rsi15m ??
    m15?.rsi,
    50
  );

  const rsiHTF = safeNumber(
    raw?.rsiHTF ??
    raw?.h1 ??
    raw?.rsi1h ??
    h1?.rsi,
    rsi
  );

  const zones = raw?.zones || m15?.zones || getDefaultRsiZones();

  const hasM15 = isValidRsiNumber(rsi);
  const hasH1 = isValidRsiNumber(rsiHTF);
  const structurallyValid = hasM15 && hasH1;

  const continuationScore = safeNumber(
    raw?.continuationScore ??
    m15?.continuationScore,
    0
  );

  const slope3 = safeNumber(
    raw?.slope3 ??
    m15?.slope3,
    0
  );

  const rawInvalid =
    raw?.valid === false ||
    raw?.isValid === false ||
    raw?.invalid === true;

  const rawBlocked = Boolean(
    raw?.blocked ||
    raw?.htfBlocked ||
    raw?.rsiBlocked
  );

  return {
    ...(raw || {}),
    rsi,
    rsiHTF,
    zones,

    continuationScore,
    slope3,

    valid: structurallyValid && !rawInvalid && !rawBlocked,
    blocked: rawBlocked
  };
}

function isValidRsiNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 100;
}

function calculateSimpleRsiFromCandles(candles, period = 14) {
  const closes = Array.isArray(candles)
    ? candles.map(c => Number(c?.close)).filter(Number.isFinite)
    : [];

  if (closes.length < period + 2) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function buildFallbackRsiNode(candles) {
  const rsi = calculateSimpleRsiFromCandles(candles, 14);
  const prevRsi = Array.isArray(candles) && candles.length > 20
    ? calculateSimpleRsiFromCandles(candles.slice(0, -3), 14)
    : null;

  const slope3 =
    isValidRsiNumber(rsi) && isValidRsiNumber(prevRsi)
      ? Number((rsi - prevRsi).toFixed(3))
      : 0;

  return {
    rsi: isValidRsiNumber(rsi) ? Number(rsi.toFixed(2)) : 50,
    valid: isValidRsiNumber(rsi),
    slope3,
    zones: getDefaultRsiZones()
  };
}

function buildFallbackMtfRsi({ candles15m, candles1h, candles4h }) {
  return {
    m15: buildFallbackRsiNode(candles15m),
    h1: buildFallbackRsiNode(candles1h),
    h4: Array.isArray(candles4h) ? buildFallbackRsiNode(candles4h) : null
  };
}

function mergeMtfRsi(primary, fallback) {
  const p = primary || {};
  const f = fallback || {};

  const mergeNode = (a, b) => {
    const aValid = a?.valid === true && isValidRsiNumber(a?.rsi);
    const bValid = b?.valid === true && isValidRsiNumber(b?.rsi);

    const rsi = aValid
      ? Number(a.rsi)
      : bValid
        ? Number(b.rsi)
        : 50;

    return {
      ...(b || {}),
      ...(a || {}),
      rsi,
      valid: aValid || bValid,
      zones: a?.zones || b?.zones || getDefaultRsiZones(),
      slope3: Number.isFinite(Number(a?.slope3))
        ? Number(a.slope3)
        : Number(b?.slope3 || 0)
    };
  };

  return {
    ...p,
    m15: mergeNode(p.m15, f.m15),
    h1: mergeNode(p.h1, f.h1),
    h4: p.h4 || f.h4 || null
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency || 1));
  const results = [];
  let index = 0;

  async function worker() {
    while (index < rows.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(rows[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, rows.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

function isUsableRsiSignal(value) {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(Number(value?.rsi)) &&
    Boolean(value?.zones)
  );
}

async function getSafeRsiSignal({ c, rsiData, isBull, btcState }) {
  const fallback = normalizeRsiSignalSafe(null, rsiData);

  const raw = await callFirstValid(
    "getRSISignal",
    [
      () => getRSISignal(rsiData?.mtf, c.side, btcState),
      () => getRSISignal({
        mtf: rsiData?.mtf,
        side: c.side,
        coin: c,
        c,
        isBull,
        btcState,
        candles15m: rsiData?.candles15m,
        candles1h: rsiData?.candles1h
      }),
      () => getRSISignal(rsiData, c.side, btcState),
      () => getRSISignal(rsiData?.mtf, c.side)
    ],
    isUsableRsiSignal,
    fallback
  );

  return normalizeRsiSignalSafe(raw, rsiData);
}

function buildFallbackSniper({ c, flow, ob, rsiZone, isBull }) {
  let score = 0;

  const moveScore = Number(c.moveScore || 0);
  const stage = String(c.stage || "").toLowerCase();
  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  score += clamp(moveScore * 0.50, 0, 45);

  if (stage === "entry") score += 12;
  else if (stage === "almost") score += 8;

  if (flow?.type === "TREND") score += 12;
  else if (flow?.type === "BUILDING") score += 7;

  if (isObWithSide(ob, isBull)) score += 10;
  else if (isObAgainstSide(ob, isBull)) score -= 12;
  else score += 3;

  if (Number(c.tfStrength || 0) >= 2) score += 6;
  else if (Number(c.tfStrength || 0) >= 1) score += 3;

  if (spread <= MAX_SPREAD_PCT) score += 4;
  else score -= 6;

  if (depth >= BULL_TREND_MIN_DEPTH_USD_1P) score += 4;
  else if (depth >= MIN_DEPTH_USD_1P_ABSOLUTE) score += 2;
  else if (depth > 0) score -= 6;

  if (isBull && ["LOWER_1", "LOWER_2", "LOWER_3"].includes(rsiZone)) score += 10;
  else if (isBull && rsiZone === "MID") score += 6;
  else if (isBull && String(rsiZone).startsWith("UPPER")) score -= 8;

  if (!isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) score += 10;
  else if (!isBull && rsiZone === "MID") score += 6;
  else if (!isBull && String(rsiZone).startsWith("LOWER")) score -= 8;

  score = clamp(Math.round(score), 0, 100);

  return {
    type: "FALLBACK_SNIPER",
    score,
    valid: score >= B_MIN_SNIPER
  };
}

function extractNumericScore(raw, keys = []) {
  if (Number.isFinite(Number(raw))) {
    return Number(raw);
  }

  if (!raw || typeof raw !== "object") {
    return null;
  }

  const preferredKeys = [
    ...keys,
    "score",
    "sniperScore",
    "confluence",
    "confidence",
    "confidenceScore",
    "total",
    "totalScore",
    "final",
    "finalScore",
    "entryScore",
    "qualityScore",
    "value"
  ];

  for (const key of preferredKeys) {
    const n = Number(raw?.[key]);
    if (Number.isFinite(n)) return n;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!/score|conf|confluence|confidence|quality|strength/i.test(key)) continue;

    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  for (const nestedKey of ["result", "data", "payload", "meta"]) {
    const nested = raw?.[nestedKey];
    const n = extractNumericScore(nested, keys);
    if (Number.isFinite(Number(n))) return Number(n);
  }

  return null;
}

async function getSafeSniperEntry({ c, flow, ob, rsiSignal, rsiZone, isBull, btcState }) {
  const fallback = buildFallbackSniper({
    c,
    flow,
    ob,
    rsiZone,
    isBull
  });

  const raw = await callFirstValid(
    "getSniperEntry",
    [
      () => getSniperEntry({
        coin: c,
        c,
        side: c.side,
        isBull,
        btcState,
        flow,
        ob,
        rsiSignal,
        rsiZone
      }),
      () => getSniperEntry(c, flow, ob, rsiSignal),
      () => getSniperEntry(c, flow, ob),
      () => getSniperEntry(c)
    ],
    value => value !== null && value !== undefined,
    fallback
  );

  const rawScore = extractNumericScore(raw, [
    "score",
    "sniperScore",
    "confidence",
    "value"
  ]);

  const externalScore = Number(rawScore || 0);
  const fallbackScore = Number(fallback.score || 0);

  const finalScore = clamp(
    Math.round(Math.max(externalScore, fallbackScore)),
    0,
    100
  );

  const fallbackWon = fallbackScore > externalScore;

  return {
    ...(raw && typeof raw === "object" ? raw : {}),

    type: fallbackWon
      ? "BLENDED_FALLBACK_SNIPER"
      : raw?.type || raw?.signal || fallback.type,

    score: finalScore,
    valid: finalScore >= B_MIN_SNIPER,

    rawSniperScore: externalScore,
    fallbackSniperScore: fallbackScore,
    sniperBlendUsed: fallbackWon
  };
}

async function getSafeLiquidityZones({ contractSymbol, c }) {
  return callFirstValid(
    "getLiquidityZones",
    [
      () => getLiquidityZones(contractSymbol, c.price, c.side),
      () => getLiquidityZones(contractSymbol, c.price),
      () => getLiquidityZones(c.symbol, c.price, c.side),
      () => getLiquidityZones(c)
    ],
    value => value !== null && value !== undefined,
    null
  );
}

function normalizeRiskGeometry(raw, c, isBull) {
  if (!raw || typeof raw !== "object") return null;

  const entry = safeNumber(
    raw.entry ??
    raw.entryPrice ??
    raw.price ??
    c.price,
    0
  );

  const sl = safeNumber(
    raw.sl ??
    raw.stopLoss ??
    raw.stop ??
    raw.stopPrice,
    0
  );

  const tp = safeNumber(
    raw.tp ??
    raw.takeProfit ??
    raw.target ??
    raw.targetPrice ??
    raw.tp1,
    0
  );

  const rr = safeNumber(
    raw.rr ??
    raw.riskReward ??
    raw.riskRewardRatio ??
    calculateRRFromPrices(entry, sl, tp, isBull),
    0
  );

  return {
    ...raw,
    entry,
    sl,
    tp,
    rr,
    slSource: raw.slSource || raw.stopSource || "riskManager",
    tpSource: raw.tpSource || raw.targetSource || "riskManager"
  };
}

function isValidRiskGeometry(risk, isBull) {
  if (!risk) return false;

  const entry = Number(risk.entry || 0);
  const sl = Number(risk.sl || 0);
  const tp = Number(risk.tp || 0);

  if (!entry || !sl || !tp) return false;

  if (isBull && sl >= entry) return false;
  if (isBull && tp <= entry) return false;

  if (!isBull && sl <= entry) return false;
  if (!isBull && tp >= entry) return false;

  return calculateRRFromPrices(entry, sl, tp, isBull) > 0;
}

function buildFallbackRiskGeometry({ c, ob, isBull }) {
  if (!ENABLE_FALLBACK_RISK_GEOMETRY) {
    return null;
  }

  const entry = safeNumber(c.price || ob?.mid, 0);
  if (!entry) return null;

  const spread = normalizeSpread(ob?.spreadPct);
  const change1hAbs = Math.abs(Number(c.change1h || 0));

  const riskPct = clamp(
    0.0055 + spread * 3 + clamp((change1hAbs / 100) * 0.25, 0, 0.006),
    0.0045,
    0.018
  );

  const rewardPct = riskPct * 1.50; // Updated from 1.35 to 1.50

  const sl = isBull
    ? entry * (1 - riskPct)
    : entry * (1 + riskPct);

  const tp = isBull
    ? entry * (1 + rewardPct)
    : entry * (1 - rewardPct);

  return {
    entry,
    sl,
    tp,
    rr: calculateRRFromPrices(entry, sl, tp, isBull),
    slSource: "fallback_dynamic_pct",
    tpSource: "fallback_dynamic_pct"
  };
}

function enforceMinimumBaseRR(risk, isBull, minRR = MIN_PRE_TP_GEOMETRY_RR) {
  if (!isValidRiskGeometry(risk, isBull)) return risk;

  const entry = Number(risk.entry || 0);
  const sl = Number(risk.sl || 0);
  const currentTp = Number(risk.tp || 0);
  const currentRR = calculateRRFromPrices(entry, sl, currentTp, isBull);

  if (currentRR >= minRR) return risk;

  const riskDist = Math.abs(entry - sl);
  if (!riskDist) return risk;

  const tp = isBull
    ? entry + riskDist * minRR
    : entry - riskDist * minRR;

  return {
    ...risk,
    tp,
    rr: calculateRRFromPrices(entry, sl, tp, isBull),
    tpSource: `${risk.tpSource || "unknown"}|min_base_rr_${minRR}`
  };
}

async function getSafeRiskGeometry({
  c,
  isBull,
  liquidity,
  liquidation,
  ob,
  flow,
  sniper,
  rsiSignal
}) {
  const risk = await callFirstValid(
    "calculateRisk",
    [
      async () => normalizeRiskGeometry(
        await calculateRisk({
          coin: c,
          c,
          side: c.side,
          isBull,
          price: c.price,
          liquidity,
          liquidation,
          ob,
          flow,
          sniper,
          rsiSignal
        }),
        c,
        isBull
      ),
      async () => normalizeRiskGeometry(
        await calculateRisk(c, liquidity, liquidation, isBull),
        c,
        isBull
      ),
      async () => normalizeRiskGeometry(
        await calculateRisk(c, liquidity, liquidation, ob),
        c,
        isBull
      ),
      async () => normalizeRiskGeometry(
        await calculateRisk(c, ob, liquidity, liquidation),
        c,
        isBull
      ),
      async () => normalizeRiskGeometry(
        await calculateRisk(c),
        c,
        isBull
      )
    ],
    value => isValidRiskGeometry(value, isBull),
    null
  );

  return risk || buildFallbackRiskGeometry({ c, ob, isBull });
}

function buildFallbackConfluence({ c, flow, sniper, ob, rr, rsiZone, isBull, btcState }) {
  let score = 0;

  const moveScore = Number(c.moveScore || 0);
  const sniperScore = Number(sniper?.score || 0);
  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);
  const tfStrength = Number(c.tfStrength || 0);
  const state = String(btcState || "NEUTRAL").toUpperCase();

  score += clamp(moveScore * 0.38, 0, 38);
  score += clamp(sniperScore * 0.28, 0, 28);

  if (flow?.type === "TREND") score += 12;
  else if (flow?.type === "BUILDING") score += 7;
  else score += 2;

  if (isObWithSide(ob, isBull)) score += 10;
  else if (isObAgainstSide(ob, isBull)) score -= 10;
  else score += 3;

  if (tfStrength >= 2) score += 7;
  else if (tfStrength >= 1) score += 4;

  if (rr >= 1.40) score += 6;
  else if (rr >= 1.15) score += 4;
  else if (rr >= 1.00) score += 2;
  else score -= 5;

  if (spread <= MAX_SPREAD_PCT) score += 4;
  else score -= 8;

  if (depth >= BULL_TREND_MIN_DEPTH_USD_1P) score += 4;
  else if (depth >= MIN_DEPTH_USD_1P_ABSOLUTE) score += 2;
  else if (depth > 0) score -= 8;

  if (isBull && ["LOWER_1", "LOWER_2", "LOWER_3"].includes(rsiZone)) score += 7;
  else if (isBull && rsiZone === "MID") score += 4;
  else if (isBull && String(rsiZone).startsWith("UPPER")) score -= 8;

  if (!isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) score += 7;
  else if (!isBull && rsiZone === "MID") score += 4;
  else if (!isBull && String(rsiZone).startsWith("LOWER")) score -= 8;

  const counterBtc =
    (isBull && ["BEARISH", "STRONG_BEAR"].includes(state)) ||
    (!isBull && ["BULLISH", "STRONG_BULL"].includes(state));

  if (counterBtc) score -= 6;
  else if (state !== "NEUTRAL" && state !== "UNKNOWN") score += 3;

  return clamp(Math.round(score), 0, 100);
}

async function getSafeConfluence({
  c,
  flow,
  sniper,
  ob,
  risk,
  rr,
  funding,
  rsiSignal,
  rsiZone,
  btcState,
  regimeLevel,
  liquidation,
  isBull
}) {
  const fallback = buildFallbackConfluence({
    c,
    flow,
    sniper,
    ob,
    rr,
    rsiZone,
    isBull,
    btcState
  });

  const raw = await callFirstValid(
    "calculateConfluence",
    [
      () => calculateConfluence({
        coin: c,
        c,
        side: c.side,
        isBull,
        flow,
        sniper,
        ob,
        risk,
        rr,
        funding,
        rsiSignal,
        rsiZone,
        btcState,
        regime: regimeLevel,
        liquidation
      }),
      () => calculateConfluence(c, flow, sniper, ob, risk, funding),
      () => calculateConfluence(c, flow, sniper, ob),
      () => calculateConfluence(c)
    ],
    value => value !== null && value !== undefined,
    fallback
  );

  const rawScore = extractNumericScore(raw, [
    "score",
    "confluence",
    "totalScore",
    "finalScore",
    "value"
  ]);

  const externalScore = clamp(Math.round(Number(rawScore || 0)), 0, 100);
  const fallbackScore = clamp(Math.round(Number(fallback || 0)), 0, 100);

  const externalCollapsed = externalScore > 0 && externalScore < MIN_EXTERNAL_SCORE_HEALTH;

  const finalScore = clamp(
    Math.round(
      externalCollapsed
        ? fallbackScore
        : Math.max(externalScore, fallbackScore)
    ),
    0,
    100
  );

  c._debugExternalConfluence = externalScore;
  c._debugFallbackConfluence = fallbackScore;
  c._debugConfluenceBlendUsed = finalScore !== externalScore;
  c._debugConfluenceSource = externalCollapsed
    ? "FALLBACK_EXTERNAL_COLLAPSED"
    : finalScore === fallbackScore && fallbackScore > externalScore
      ? "FALLBACK_OVERRIDE"
      : "EXTERNAL_OR_MAX";

  if (process.env.TS_DEBUG_CONFLUENCE === "true") {
    console.log("TS_CONFLUENCE_BLEND", JSON.stringify({
      symbol: c.symbol,
      side: c.side,
      scannerScore: Number(c.moveScore || 0),
      externalScore,
      fallbackScore,
      finalScore,
      source: c._debugConfluenceSource,
      sniperScore: Number(sniper?.score || 0),
      rawSniperScore: Number(sniper?.rawSniperScore || 0),
      fallbackSniperScore: Number(sniper?.fallbackSniperScore || 0),
      flow: flow?.type,
      obBias: ob?.bias,
      rr,
      rsiZone
    }));
  }

  return finalScore;
}

function getCounterTrend(c, btcState) {
  const state = String(btcState || "").toUpperCase();

  return (
    (c.side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(state)) ||
    (c.side === "bear" && ["BULLISH", "STRONG_BULL"].includes(state))
  );
}

function inferSetupClass({
  c,
  sniper,
  confluence,
  rr,
  rsiEdge,
  bullishMidTrendProbe,
  btcBullishBearException
}) {
  const sniperScore = getSniperScore(sniper);

  const godSniperReq = getRsiAdjustedRequiredSniper({
    requiredSniper: GOD_MIN_SNIPER,
    rsiEdge
  });

  const aSniperReq = getRsiAdjustedRequiredSniper({
    requiredSniper: A_MIN_SNIPER,
    rsiEdge
  });

  const bSniperReq = getRsiAdjustedRequiredSniper({
    requiredSniper: B_MIN_SNIPER,
    rsiEdge
  });

  // Exception before normal A and before GOD
  if (btcBullishBearException) {
    return {
      setupClass: "A_SHORT_EXCEPTION",
      entryReason: "BTC_BULLISH_BEAR_EXCEPTION",
      requiredConfluence: BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF,
      requiredSniper: BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER,
      requiredRR: BTC_BULLISH_BEAR_EXCEPTION_MIN_RR
    };
  }

  if (
    rr >= GOD_PRE_TP_MIN_BASE_RR &&
    sniperScore >= godSniperReq &&
    confluence >= GOD_MIN_CONFLUENCE
  ) {
    return {
      setupClass: "GOD",
      entryReason: "GOD_ENTRY",
      requiredConfluence: GOD_MIN_CONFLUENCE,
      requiredSniper: GOD_MIN_SNIPER,
      requiredRR: GOD_PRE_TP_MIN_BASE_RR
    };
  }

  if (
    rr >= A_PRE_TP_MIN_BASE_RR &&
    sniperScore >= aSniperReq &&
    confluence >= A_MIN_CONFLUENCE
  ) {
    return {
      setupClass: "A",
      entryReason: "A_ENTRY",
      requiredConfluence: A_MIN_CONFLUENCE,
      requiredSniper: A_MIN_SNIPER,
      requiredRR: A_PRE_TP_MIN_BASE_RR
    };
  }

  if (bullishMidTrendProbe) {
    return {
      setupClass: "B_TREND_PROBE",
      entryReason: "BULLISH_MID_TREND_PROBE",
      requiredConfluence: BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE,
      requiredSniper: BULLISH_MID_TREND_PROBE_MIN_SNIPER,
      requiredRR: BULLISH_MID_TREND_PROBE_MIN_RR
    };
  }

  if (
    ENABLE_B_ENTRIES &&
    rr >= B_PRE_TP_MIN_BASE_RR &&
    sniperScore >= bSniperReq &&
    confluence >= B_MIN_CONFLUENCE
  ) {
    return {
      setupClass: "B",
      entryReason: "B_ENTRY",
      requiredConfluence: B_MIN_CONFLUENCE,
      requiredSniper: B_MIN_SNIPER,
      requiredRR: B_PRE_TP_MIN_BASE_RR
    };
  }

  return null;
}

function getMaxSpreadForCandidate({ c, rsiZone, setupClass }) {
  if (setupClass === "B_TREND_PROBE") {
    return BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT;
  }

  if (c.side === "bull" && rsiZone === "MID") {
    return MID_BULL_MAX_SPREAD_PCT;
  }

  return MAX_SPREAD_PCT;
}

function buildEntryPosition({
  c,
  risk,
  finalTp,
  finalRr,
  baseRR,
  tpRewardMultiplier,
  setupClass,
  entryReason,
  setupGrade,
  flow,
  sniper,
  confluence,
  funding,
  ob,
  rsi,
  rsiHTF,
  rsiZone,
  btcState,
  regimeLevel,
  contractSymbol
}) {
  return initializePositionPathMetrics({
    tradeId: c.tradeId || `${STRATEGY_VERSION}_${c.symbol}_${c.side}_${Date.now()}`,
    symbol: c.symbol,
    rawBitgetSymbol: contractSymbol,
    side: c.side,

    entry: Number(risk.entry),
    sl: Number(risk.sl),
    initialSl: Number(risk.sl),
    originalSl: Number(risk.sl),
    tp: Number(finalTp),

    rr: Number(finalRr),
    baseRR: Number(baseRR),
    tpRewardMultiplier: Number(tpRewardMultiplier),

    setupClass,
    entryReason,
    reason: entryReason,

    grade: setupGrade?.grade || "C",
    gradePoints: Number(setupGrade?.points || 0),
    recommendedRisk: setupGrade?.recommendedRisk || "watch",

    score: Number(c.moveScore || 0),
    moveScore: Number(c.moveScore || 0),
    confluence: Number(confluence || 0),

    sniper: sniper?.type || "UNKNOWN",
    sniperScore: Number(sniper?.score || 0),

    rsi: Number(rsi || 0),
    rsiHTF: Number(rsiHTF || 0),
    rsiZone,

    obBias: ob?.bias || "NEUTRAL",
    spreadPct: normalizeSpread(ob?.spreadPct),
    depthMinUsd1p: Number(ob?.depthMinUsd1p || 0),

    flow: flow?.type || "UNKNOWN",
    funding: Number(funding?.rate || 0),
    btcState,
    regime: regimeLevel,

    slSource: risk.slSource || "riskManager",
    tpSource: risk.tpSource || "riskManager",

    bullishMidTrendProbe: Boolean(c._debugBullishMidTrendProbe),
    bullishMidTrendProbeReason: c._debugBullishMidTrendProbeReason || null,

    btcBullishBearException: Boolean(c._debugBtcBullishBearException),
    btcBullishBearExceptionReason: c._debugBtcBullishBearExceptionReason || null,

    createdAt: Date.now(),
    strategyVersion: STRATEGY_VERSION,

    stage: c.stage || "entry",
    scannerStage: c.scannerStage || c.stage || "entry",
    stageSource: c.stageSource || "tradeSystem",

    tfScore: Number(c.tfScore || 0),
    tfStrength: Number(c.tfStrength || 0),
    tfAlignment: c.tfAlignment || "UNKNOWN",

    change1h: Number(c.change1h || 0),
    change24: Number(c.change24 || 0),
  });
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

    bullishMidTrendProbe: Boolean(position.bullishMidTrendProbe),
    bullishMidTrendProbeReason: position.bullishMidTrendProbeReason || null,
    btcBullishBearException: Boolean(position.btcBullishBearException),
    btcBullishBearExceptionReason: position.btcBullishBearExceptionReason || null,

    liveEligible: Boolean(position.liveEligible),
    shadowOnly: Boolean(position.shadowOnly),

    rotation: position.rotation || null,
    rotationGate: position.rotationGate || null,
    rotationSide: position.rotationSide || null,
    tradeSide: position.tradeSide || null,

    familyId: position.familyId || null,
    microFamilyId: position.microFamilyId || null,
    familyIds: Array.isArray(position.familyIds) ? position.familyIds : [],
    microFamilyIds: Array.isArray(position.microFamilyIds) ? position.microFamilyIds : []
  });

  if (auditState.recentEntries.length > MAX_RECENT_ENTRY_AUDIT_ROWS) {
    auditState.recentEntries.shift();
  }
}

function recordExit(exitPayload, pos, exitPrice, isBull) {
  const triggerPrice = Number(exitPrice || 0);
  const intendedExecutionPrice = Number(exitPayload?.intendedExecutionPrice || exitPayload?.executionPrice || 0);
  const executionPrice = triggerPrice; // gebruik trigger price als echte execution prijs

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
  exitPayload.intendedExecutionPrice = intendedExecutionPrice;

  exitPayload.exitR = Number(r.toFixed(3));
  exitPayload.pnlPct = Number(pnlPct.toFixed(3));
  exitPayload.triggerR = Number(triggerR.toFixed(3));
  exitPayload.triggerPnlPct = Number(triggerPnlPct.toFixed(3));

  // Analytics-compatible aliases.
  exitPayload.closed = true;
  exitPayload.isClosed = true;
  exitPayload.closedAt = Date.now();
  exitPayload.exitAt = exitPayload.closedAt;
  exitPayload.exitTs = exitPayload.closedAt;

  exitPayload.exitPrice = executionPrice;
  exitPayload.realizedR = exitPayload.exitR;
  exitPayload.pnlR = exitPayload.exitR;
  exitPayload.resultR = exitPayload.exitR;
  exitPayload.outcomeR = exitPayload.exitR;
  exitPayload.rMultiple = exitPayload.exitR;

  exitPayload.holdMinutes = Number((holdMs / 60000).toFixed(1));
  exitPayload.setupClass = pos.setupClass || "UNKNOWN";
  exitPayload.strategyVersion = pos.strategyVersion || STRATEGY_VERSION;

  exitPayload.tradeId = pos.tradeId || exitPayload.tradeId || `${STRATEGY_VERSION}_${pos.symbol}_${pos.side}_${pos.createdAt || Date.now()}`;
  exitPayload.setupClass = pos.setupClass || "UNKNOWN";
  exitPayload.strategyVersion = pos.strategyVersion || STRATEGY_VERSION;

  Object.assign(exitPayload, pathFields);

  const closedTrade = initializePostExitFields({
    tradeId: pos.tradeId || exitPayload.tradeId,
    symbol: pos.symbol,
    side: pos.side,
    rawBitgetSymbol: pos.rawBitgetSymbol || pos.symbol,

    setupClass: pos.setupClass || "UNKNOWN",
    entryReason: pos.entryReason || pos.reason || "UNKNOWN",
    exitReason: exitPayload.reason,

    entry: Number(pos.entry || 0),
    exit: executionPrice,
    executionPrice,
    intendedExecutionPrice,
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

    liveEligible: Boolean(pos.liveEligible),
    shadowOnly: Boolean(pos.shadowOnly),

    rotation: pos.rotation || null,
    rotationGate: pos.rotationGate || null,
    rotationSide: pos.rotationSide || null,
    tradeSide: pos.tradeSide || null,

    familyId: pos.familyId || null,
    microFamilyId: pos.microFamilyId || null,
    familyIds: Array.isArray(pos.familyIds) ? pos.familyIds : [],
    microFamilyIds: Array.isArray(pos.microFamilyIds) ? pos.microFamilyIds : [],

    createdAt: pos.createdAt || null,
    exitedAt: Date.now(),
    strategyVersion: pos.strategyVersion || STRATEGY_VERSION
  });

  auditState.closedTrades.push(closedTrade);

  recordMicroOutcome(closedTrade, "REAL");

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
    strategyVersion: pos.strategyVersion || STRATEGY_VERSION,

    liveEligible: Boolean(pos.liveEligible),
    shadowOnly: Boolean(pos.shadowOnly),
    rotationSide: pos.rotationSide || null,
    rotationId:
      pos.rotation?.activeRotationId ||
      pos.rotation?.rotationId ||
      pos.rotationGate?.activeRotationId ||
      pos.rotationGate?.rotationId ||
      pos.rotationId ||
      null,
    familyId: pos.familyId || null,
    microFamilyId: pos.microFamilyId || null
  }));
}

function buildReasonTable(actions) {
  const rows = Array.isArray(actions) ? actions : [];
  const total = rows.length || 0;

  const reasonCounts = {};
  const reasonExamples = {};

  for (const row of rows) {
    const action = String(row?.action || "").toUpperCase();
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
      change: `TP cap is now ${A_GOD_MAX_TP_REWARD_MULTIPLIER}; monitor nearTP + BE interaction`,
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
  return {
    tag: "TS_MASTER_BEST_AFSTELLING",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,
    ts: Date.now(),
    enabled: false,
    skipped: true,
    reason: "TS_OPTIMIZER_REMOVED_FROM_RUNTIME"
  };
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

  const masterBestAfstelling = logOptimizerReport({
    reasonTable,
    btcState,
    runId
  });

  return {
    snapshot,
    reasonTable,
    setupClassTable,
    masterBestAfstelling
  };
}

function buildAnalyzePayload({ auditResult, candidates, actions, btcState, runId }) {
  const reasonTable = auditResult?.reasonTable || buildReasonTable(actions);

  return {
    enabled: true,
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,

    candidatesCount: Array.isArray(candidates) ? candidates.length : 0,
    actionsCount: Array.isArray(actions) ? actions.length : 0,

    auditSnapshot: auditResult?.snapshot || null,
    reasonTable,
    setupClassTable: auditResult?.setupClassTable || buildSetupClassTable(actions),

    currentFilterValues: CURRENT_FILTER_VALUES,
    tradeSystemFilters: TRADE_SYSTEM_FILTERS,

    optimizer: {
      enabled: false,
      reason: "REMOVED_FROM_RUNTIME"
    },

    openPositions: buildOpenPositionRows(),

    durableState: {
      enabled: hasRedis(),
      lastLoadedAt: runtimeState.durableLoadedAt,
      lastSavedAt: runtimeState.durableSavedAt,
      openPositions: memory.size,
      closedTrades: auditState.closedTrades?.length || 0,
      featureRows: ENABLE_RAW_FEATURE_ROWS ? auditState.featureStore?.length || 0 : 0,
      shadowRows: ENABLE_SHADOW_OUTCOMES ? auditState.shadowOutcomes?.length || 0 : 0,

      microLearning: {
        activeDayKey: auditState.microLearning?.activeDayKey || null,
        activeWeekKey: auditState.microLearning?.activeWeekKey || null,
        dailyFamilies: Object.keys(auditState.microLearning?.daily?.families || {}).length,
        weekFamilies: Object.keys(auditState.microLearning?.week?.families || {}).length,
        activeRotationFamilies: auditState.microLearning?.activeRotation?.allowedMicroFamilyIds?.length || 0,
        lastCompletedWeek: auditState.microLearning?.lastCompletedWeek?.weekKey || null
      }
    },

    ts: Date.now()
  };
}

// ================= MICRO-LEARNING HELPERS =================
function getUtcDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function getIsoWeekKey(ts = Date.now()) {
  const date = new Date(ts);
  const utc = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);

  return `${utc.getUTCFullYear()}_W${String(weekNo).padStart(2, "0")}`;
}

function createFamilyStats(familyId, side = "unknown") {
  return {
    familyId,
    side,

    seen: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,

    totalR: 0,
    avgR: 0,

    // Raw winrate.
    winrateNum: 0,

    // Fair winrate metrics.
    bayesianWinrateNum: 0,
    winrateLowerBoundNum: 0,
    fairWinrateNum: 0,
    sampleReliability: 0,
    observationConfidence: 0,

    // Rotation score = fair winrate dominant.
    rotationScore: 0,
    rankingMode: "WINRATE_WILSON_BAYES",

    directSL: 0,
    nearTp: 0,

    entryReasons: {},
    setupClasses: {},
    rsiZones: {},
    obBiases: {},

    examples: []
  };
}

function createMicroDaySummary(dayKey = getUtcDayKey(), weekKey = getIsoWeekKey()) {
  return {
    dayKey,
    weekKey,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    families: {}
  };
}

function createMicroWeekSummary(weekKey = getIsoWeekKey()) {
  return {
    weekKey,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    days: {},
    families: {}
  };
}

const MICRO_FAMILY_SCHEMA_VERSION = "MF_V2_CORE";

function createMicroLearningState(now = Date.now()) {
  const dayKey = getUtcDayKey(now);
  const weekKey = getIsoWeekKey(now);

  return {
    version: 1,
    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
    activeDayKey: dayKey,
    activeWeekKey: weekKey,

    daily: createMicroDaySummary(dayKey, weekKey),
    week: createMicroWeekSummary(weekKey),

    lastCompletedWeek: null,

    // Deze gebruikt tradeSystem als learned weekly allowlist.
    activeRotation: null,

    updatedAt: now
  };
}

function normalizeMicroLearningState(value) {
  const fresh = createMicroLearningState();

  if (!value || typeof value !== "object") {
    return fresh;
  }

  if (value?.schemaVersion !== MICRO_FAMILY_SCHEMA_VERSION) {
    return fresh;
  }

  const state = {
    ...fresh,
    ...value
  };

  state.daily = state.daily && typeof state.daily === "object"
    ? state.daily
    : createMicroDaySummary(state.activeDayKey, state.activeWeekKey);

  state.week = state.week && typeof state.week === "object"
    ? state.week
    : createMicroWeekSummary(state.activeWeekKey);

  state.daily.families = state.daily.families || {};
  state.week.families = state.week.families || {};
  state.week.days = state.week.days || {};

  return state;
}

function incObjCount(obj, key) {
  const k = String(key || "UNKNOWN").toUpperCase();
  obj[k] = Number(obj[k] || 0) + 1;
}

// ================= ANALYZER MICRO IDENTITY FUNCTIONS =================
const ANALYZER_PARENT_CODES = {
  LONG: {
    GOD: 101,
    A: 102,
    A_SHORT_EXCEPTION: 103,
    B: 104,
    B_TREND_PROBE: 105,
    C: 106,
    OPEN: 107,
    UNKNOWN: 199
  },
  SHORT: {
    GOD: 201,
    A: 202,
    A_SHORT_EXCEPTION: 203,
    B: 204,
    B_TREND_PROBE: 205,
    C: 206,
    OPEN: 207,
    UNKNOWN: 299
  }
};

function analyzerCleanToken(value, fallback = "UNKNOWN") {
  const raw = String(value ?? "").trim();

  if (!raw) return fallback;

  const upper = raw
    .replace(/\[object object\]/gi, "")
    .replace(/\{.*?\}/g, "")
    .replace(/[^\w.%+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  if (!upper) return fallback;
  if (upper === "OBJECT_OBJECT") return fallback;
  if (upper.includes("OBJECT_OBJECT")) return fallback;

  return upper;
}

function analyzerHashString(value) {
  const text = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return Math.abs(hash >>> 0).toString(36).toUpperCase();
}

function analyzerNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const direct = Number(cleaned);

    if (Number.isFinite(direct)) return direct;

    const nums = cleaned.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
    if (nums.length === 1) return nums[0];
    if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
  }

  return fallback;
}

function analyzerScoreNumber(value) {
  const n = analyzerNumber(value, null);

  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;

  return n;
}

function analyzerBucketScore(value, prefix) {
  const n = analyzerScoreNumber(value);

  if (!Number.isFinite(n)) return `${prefix}_UNKNOWN`;
  if (n < 50) return `${prefix}_0_50`;
  if (n >= 100) return `${prefix}_95_100`;

  const floor = Math.floor(n / 5) * 5;
  const low = Math.max(50, Math.min(95, floor));
  const high = Math.min(100, low + 5);

  return `${prefix}_${low}_${high}`;
}

function analyzerBucketRR(value) {
  const n = analyzerNumber(value, null);

  if (!Number.isFinite(n)) return "RR_UNKNOWN";
  if (n < 1) return "RR_LT_1p00";
  if (n >= 2.5) return "RR_2p50_PLUS";

  const low = Math.floor(n * 10) / 10;
  const high = low + 0.1;
  const clean = v => v.toFixed(2).replace(".", "p");

  return `RR_${clean(low)}_${clean(high)}`;
}

function analyzerBucketSpreadBps(value) {
  const n = analyzerNumber(value, null);

  if (!Number.isFinite(n)) return "SPREAD_UNKNOWN";
  if (n < 5) return "SPREAD_LT_5BPS";
  if (n < 8) return "SPREAD_5_8BPS";
  if (n < 10) return "SPREAD_8_10BPS";
  if (n < 12) return "SPREAD_10_12BPS";
  if (n < 16) return "SPREAD_12_16BPS";
  if (n < 20) return "SPREAD_16_20BPS";
  if (n < 25) return "SPREAD_20_25BPS";

  return "SPREAD_GT_25BPS";
}

function analyzerBucketDepthUsd(value) {
  const n = analyzerNumber(value, null);

  if (!Number.isFinite(n)) return "DEPTH_UNKNOWN";
  if (n < 10_000) return "DEPTH_LT_10K";
  if (n < 25_000) return "DEPTH_10K_25K";
  if (n < 50_000) return "DEPTH_25K_50K";
  if (n < 75_000) return "DEPTH_50K_75K";
  if (n < 100_000) return "DEPTH_75K_100K";
  if (n < 150_000) return "DEPTH_100K_150K";
  if (n < 250_000) return "DEPTH_150K_250K";

  return "DEPTH_GT_250K";
}

function analyzerNormalizeFlow(row) {
  const raw = analyzerCleanToken(row.flow || row.flowState || row.marketFlow, "");

  if (!raw) return "FLOW_UNKNOWN";
  if (raw.includes("EXHAUST")) return "FLOW_EXHAUSTION";
  if (raw.includes("BUILD")) return "FLOW_BUILDING";
  if (raw.includes("TREND")) return "FLOW_TREND";
  if (raw.includes("NEUTRAL")) return "FLOW_NEUTRAL";
  if (raw.includes("ANY")) return "FLOW_ANY";

  return `FLOW_${raw}`;
}

function analyzerNormalizeStage(row) {
  const raw = analyzerCleanToken(row.stage || row.entryStage || row.setupStage, "");

  if (!raw) return "STAGE_UNKNOWN";
  if (raw.includes("ALMOST")) return "STAGE_ALMOST";
  if (raw.includes("ENTRY")) return "STAGE_ENTRY";
  if (raw.includes("CONFIRM")) return "STAGE_CONFIRMATION";
  if (raw.includes("PULLBACK")) return "STAGE_PULLBACK";
  if (raw.includes("ANY")) return "STAGE_ANY";

  return `STAGE_${raw}`;
}

function analyzerNormalizeRsi(row) {
  const zone = analyzerCleanToken(row.rsiZone || row.rsiState, "");

  if (zone) {
    if (zone.includes("LOWER")) return "RSI_LOWER";
    if (zone.includes("UPPER")) return "RSI_UPPER";
    if (zone.includes("MID")) return "RSI_MID";
    if (zone.includes("OVERBOUGHT")) return "RSI_UPPER";
    if (zone.includes("OVERSOLD")) return "RSI_LOWER";
    if (zone.includes("ANY")) return "RSI_ANY";
  }

  const rsi = analyzerNumber(row.rsi ?? row.rsiValue ?? row.rsi14, null);

  if (!Number.isFinite(rsi)) return "RSI_UNKNOWN";
  if (rsi <= 35) return "RSI_LOWER";
  if (rsi >= 65) return "RSI_UPPER";

  return "RSI_MID";
}

function analyzerNormalizeOb(row) {
  const raw = analyzerCleanToken(row.obBias || row.orderbookBias || row.orderBookBias || row.bookBias, "");

  if (!raw) return "OB_UNKNOWN";
  if (raw.includes("BULL")) return "OB_BULLISH";
  if (raw.includes("BEAR")) return "OB_BEARISH";
  if (raw.includes("NEUTRAL")) return "OB_NEUTRAL";
  if (raw.includes("WITH")) return "OB_WITH";
  if (raw.includes("AGAINST")) return "OB_AGAINST";

  return `OB_${raw}`;
}

function analyzerNormalizeBtc(row) {
  const raw = analyzerCleanToken(row.btcState || row.btcRel || row.btcRelative || row.btcRelativeState, "");

  if (!raw) return "BTC_UNKNOWN";
  if (raw.includes("BULL")) return "BTC_BULLISH";
  if (raw.includes("BEAR")) return "BTC_BEARISH";
  if (raw.includes("COUNTER")) return "BTC_COUNTER";
  if (raw.includes("WITH")) return "BTC_WITH";
  if (raw.includes("NEUTRAL")) return "BTC_NEUTRAL";

  return `BTC_${raw}`;
}

function analyzerNormalizeFunding(row) {
  const raw = row.fundingState ?? row.funding ?? row.fundingRate;
  const key = analyzerCleanToken(raw, "");

  if (key) {
    if (key.includes("OPTIMAL")) return "FUNDING_OPTIMAL";
    if (key.includes("CROWDED")) return "FUNDING_CROWDED";
    if (key.includes("EDGE_WEAK")) return "FUNDING_EDGE_WEAK";
    if (key.includes("OK")) return "FUNDING_OK";
    if (key.includes("NEUTRAL")) return "FUNDING_NEUTRAL";
  }

  const n = analyzerNumber(raw, null);

  if (!Number.isFinite(n)) return "FUNDING_UNKNOWN";
  if (n >= 0.0008) return "FUNDING_POS_HIGH";
  if (n <= -0.0008) return "FUNDING_NEG_HIGH";
  if (Math.abs(n) <= 0.0002) return "FUNDING_NEUTRAL";

  return n > 0 ? "FUNDING_POS" : "FUNDING_NEG";
}

function analyzerNormalizeTf(row) {
  const raw = analyzerCleanToken(row.tfStrength || row.tfState || row.timeframeStrength, "");

  if (raw) {
    if (raw.includes("STRONG")) return "TF_STRONG";
    if (raw.includes("ALIGNED")) return "TF_STRONG";
    if (raw.includes("OK")) return "TF_OK";
    if (raw.includes("WEAK")) return "TF_WEAK";
    if (raw.includes("ANY")) return "TF_ANY";

    // Matcht familyMicroAnalyzer gedrag bij numerieke tfStrength.
    return `TF_${raw}`;
  }

  const score = analyzerNumber(row.tfScore || row.timeframeScore, null);

  if (!Number.isFinite(score)) return "TF_UNKNOWN";
  if (score >= 75) return "TF_STRONG";
  if (score >= 55) return "TF_OK";

  return "TF_WEAK";
}

function analyzerNormalizeSession(row) {
  const raw = analyzerCleanToken(row.session || row.marketSession || row.tradeSession, "");

  if (raw) {
    if (raw.includes("ASIA")) return "SESSION_ASIA";
    if (raw.includes("EU")) return "SESSION_EU";
    if (raw.includes("LONDON")) return "SESSION_EU";
    if (raw.includes("US")) return "SESSION_US";
    if (raw.includes("NY")) return "SESSION_US";
  }

  const ts = Number(
    row.analyzeUpdatedAt ||
      row.closedAt ||
      row.exitAt ||
      row.exitTs ||
      row.updatedAt ||
      row.openedAt ||
      row.createdAt ||
      row.entryTs ||
      row.analyzeTs ||
      row.ts ||
      Date.now()
  );

  const hour = new Date(Number.isFinite(ts) ? ts : Date.now()).getUTCHours();

  if (hour >= 0 && hour < 7) return "SESSION_ASIA";
  if (hour >= 7 && hour < 13) return "SESSION_EU";
  if (hour >= 13 && hour < 21) return "SESSION_US";

  return "SESSION_ASIA";
}

function analyzerSetupClass(row) {
  const raw = analyzerCleanToken(row.setupClass || row.entryClass || row.grade, "");

  if (raw.includes("A_SHORT_EXCEPTION")) return "A_SHORT_EXCEPTION";
  if (raw.includes("B_TREND_PROBE")) return "B_TREND_PROBE";
  if (raw.includes("GOD")) return "GOD";
  if (raw === "A" || raw.includes("A_ENTRY")) return "A";
  if (raw === "B" || raw.includes("B_ENTRY")) return "B";
  if (raw === "C" || raw.includes("C_ENTRY")) return "C";
  if (raw.includes("OPEN")) return "OPEN";

  return "UNKNOWN";
}

function analyzerSide(row) {
  const side = String(row.side || row.direction || row.tradeSide || "").toLowerCase();

  if (["bull", "buy", "long"].includes(side)) return "LONG";
  if (["bear", "sell", "short"].includes(side)) return "SHORT";

  return "";
}

function analyzerParentFamilyId(row) {
  const direct = analyzerCleanToken(
    row.parentFamilyId ||
      row.mainFamilyId ||
      row.analyzerParentFamilyId ||
      "",
    ""
  );

  if (/^(LONG|SHORT)_\d{1,3}$/.test(direct)) return direct;

  const side = analyzerSide(row);
  if (!side) return "";

  const setupClass = analyzerSetupClass(row);
  const code = ANALYZER_PARENT_CODES[side]?.[setupClass] || ANALYZER_PARENT_CODES[side]?.UNKNOWN;

  return code ? `${side}_${code}` : "";
}

function analyzerSpreadBps(row) {
  const direct = analyzerNumber(row.spreadBps ?? row.spreadBP ?? row.spread_bps, null);

  if (Number.isFinite(direct)) return direct;

  return normalizeSpread(row.spreadPct ?? row.spreadPercent ?? row.spread) * 10000;
}

function analyzerNormalizeCoreStage(row) {
  const raw = analyzerNormalizeStage(row);

  if (raw === "STAGE_ENTRY") return "STAGE_ENTRY";
  if (raw === "STAGE_ALMOST") return "STAGE_ALMOST";

  return "STAGE_OTHER";
}

function analyzerNormalizeObRelation(row) {
  const side = analyzerSide(row);
  const ob = analyzerNormalizeOb(row);

  if (!side) return "OB_UNKNOWN";
  if (ob === "OB_NEUTRAL" || ob === "OB_UNKNOWN") return "OB_NEUTRAL";

  if (side === "LONG" && ob === "OB_BULLISH") return "OB_WITH";
  if (side === "SHORT" && ob === "OB_BEARISH") return "OB_WITH";

  if (side === "LONG" && ob === "OB_BEARISH") return "OB_AGAINST";
  if (side === "SHORT" && ob === "OB_BULLISH") return "OB_AGAINST";

  return ob;
}

function analyzerNormalizeBtcRelation(row) {
  const side = analyzerSide(row);
  const btc = analyzerNormalizeBtc(row);

  if (!side) return "BTC_UNKNOWN";
  if (btc === "BTC_NEUTRAL" || btc === "BTC_UNKNOWN") return btc;

  if (side === "LONG" && btc === "BTC_BULLISH") return "BTC_WITH";
  if (side === "SHORT" && btc === "BTC_BEARISH") return "BTC_WITH";

  if (side === "LONG" && btc === "BTC_BEARISH") return "BTC_COUNTER";
  if (side === "SHORT" && btc === "BTC_BULLISH") return "BTC_COUNTER";

  return btc;
}

function analyzerNormalizeRsiForTradeSide(row) {
  const side = analyzerSide(row);

  const edge = analyzerCleanToken(
    row.rsiEdge || row.rsiEntryEdge || row.rsiSignal || "",
    ""
  );

  if (edge.includes("CONTINUATION")) return "RSI_CONTINUATION";
  if (edge.includes("STRONG_EDGE")) return "RSI_STRONG_EDGE";
  if (edge === "RSI_EDGE" || edge.includes("_EDGE")) return "RSI_EDGE";
  if (edge.includes("AGAINST")) return "RSI_AGAINST";

  const zone = analyzerCleanToken(row.rsiZone || row.rsiState, "");

  if (!side) return "RSI_UNKNOWN";
  if (!zone) return analyzerNormalizeRsi(row);

  if (zone.includes("MID")) return "RSI_MID";

  if (side === "LONG" && zone.includes("LOWER")) return "RSI_EDGE";
  if (side === "SHORT" && zone.includes("UPPER")) return "RSI_EDGE";

  if (side === "LONG" && zone.includes("UPPER")) return "RSI_AGAINST";
  if (side === "SHORT" && zone.includes("LOWER")) return "RSI_AGAINST";

  return analyzerNormalizeRsi(row);
}

function buildAnalyzerCoreMicroIdentity(row = {}) {
  const side = analyzerSide(row);
  const parentFamilyId = analyzerParentFamilyId(row);

  if (!side || !parentFamilyId || parentFamilyId.includes("UNKNOWN")) {
    return null;
  }

  const definitionParts = [
    MICRO_FAMILY_SCHEMA_VERSION,
    parentFamilyId,
    analyzerSetupClass(row),
    analyzerNormalizeCoreStage(row),
    analyzerNormalizeFlow(row),
    analyzerNormalizeRsiForTradeSide(row),
    analyzerNormalizeObRelation(row),
    analyzerNormalizeBtcRelation(row)
  ];

  const definition = definitionParts.join(" | ");
  const hash = analyzerHashString(definition).slice(0, 8);

  return {
    microFamilyId: `MICRO_${side}_${parentFamilyId}_${MICRO_FAMILY_SCHEMA_VERSION}_${hash}`,
    parentFamilyId,
    definition,
    definitionParts,
    familyLevel: "CORE",
    spreadBps: analyzerSpreadBps(row)
  };
}

function buildAnalyzerExactMicroIdentity(row = {}) {
  const side = analyzerSide(row);
  const parentFamilyId = analyzerParentFamilyId(row);

  if (!side || !parentFamilyId || parentFamilyId.includes("UNKNOWN")) {
    return null;
  }

  const definitionParts = [
    parentFamilyId,
    analyzerBucketScore(row.confluence ?? row.effectiveConfluence ?? row.rawConfluence, "CONF"),
    analyzerBucketScore(row.sniperScore ?? row.rawSniperScore ?? row.fallbackSniperScore, "SNIPER"),
    analyzerBucketScore(row.score ?? row.moveScore ?? row.entryScore, "SCORE"),
    analyzerBucketRR(row.rr ?? row.baseRR ?? row.plannedRR ?? row.finalRr ?? row.setupEvalRR),
    analyzerNormalizeFlow(row),
    analyzerNormalizeStage(row),
    analyzerNormalizeRsi(row),
    analyzerNormalizeOb(row),
    analyzerBucketSpreadBps(analyzerSpreadBps(row)),
    analyzerBucketDepthUsd(row.depthMinUsd1p ?? row.depthUsd ?? row.minDepthUsd ?? row.liquidityUsd),
    analyzerNormalizeBtc(row),
    analyzerNormalizeFunding(row),
    analyzerNormalizeTf(row),
    analyzerNormalizeSession(row)
  ];

  const definition = definitionParts.join(" | ");
  const hash = analyzerHashString(definition).slice(0, 8);
  const microFamilyId = `MICRO_${side}_${parentFamilyId}_${hash}`;

  return {
    microFamilyId,
    parentFamilyId,
    definition,
    definitionParts,
    familyLevel: "EXACT",
    spreadBps: analyzerSpreadBps(row)
  };
}

function buildAnalyzerMicroIdentities(row = {}) {
  const core = buildAnalyzerCoreMicroIdentity(row);
  const exact = buildAnalyzerExactMicroIdentity(row);

  return [core, exact]
    .filter(Boolean)
    .map(item => ({
      ...item,
      familyLevel: item.familyLevel || "EXACT"
    }));
}

function uniqIds(values) {
  return Array.from(
    new Set(
      values
        .flat()
        .map(normalizeMicroFamilyId)
        .filter(Boolean)
    )
  );
}

function enrichRowWithAnalyzerMicroFamily(row = {}) {
  if (!row?.symbol || !row?.side) return row;

  const identities = buildAnalyzerMicroIdentities(row);
  const primary = identities.find(item => item.familyLevel === "CORE") || identities[0];
  const exact = identities.find(item => item.familyLevel === "EXACT") || null;

  if (!primary?.microFamilyId) return row;

  const analyzerMicroFamilyIds = identities
    .map(item => item.microFamilyId)
    .filter(Boolean);

  const microFamilyIds = uniqIds([
    analyzerMicroFamilyIds,
    row.analyzerMicroFamilyId,
    row.analyzerMicroFamilyIds,
    row.microFamilyId,
    row.familyId,
    row.microFamilyIds,
    row.familyIds
  ]);

  return {
    ...row,

    rotationMicroFamilyId: primary.microFamilyId,
    analyzerMicroFamilyId: primary.microFamilyId,
    analyzerExactMicroFamilyId: exact?.microFamilyId || null,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    microFamilyId: primary.microFamilyId,
    familyId: primary.microFamilyId,

    microFamilyIds,
    familyIds: microFamilyIds,
    microFamilies: microFamilyIds,
    families: microFamilyIds,

    parentFamilyId: primary.parentFamilyId,
    analyzerParentFamilyId: primary.parentFamilyId,

    analyzerDefinition: primary.definition,
    analyzerDefinitionParts: primary.definitionParts,
    definition: row.definition || primary.definition,
    definitionParts: row.definitionParts || primary.definitionParts,

    spreadBps: primary.spreadBps
  };
}

function isCoreMicroFamilyId(id) {
  const normalized = normalizeMicroFamilyId(id);
  return Boolean(
    normalized &&
    normalized.includes(`_${MICRO_FAMILY_SCHEMA_VERSION}_`)
  );
}

function getRowMicroFamilyIds(row) {
  const existingCore = uniqIds([
    row?.rotationMicroFamilyId,
    row?.analyzerMicroFamilyId,
    row?.microFamilyId,
    row?.familyId,
    row?.microFamilyIds,
    row?.familyIds
  ]).find(isCoreMicroFamilyId);

  if (existingCore) {
    return [existingCore];
  }

  const enriched = enrichRowWithAnalyzerMicroFamily(row);

  const primary = normalizeMicroFamilyId(
    enriched?.rotationMicroFamilyId ||
    enriched?.analyzerMicroFamilyId ||
    enriched?.microFamilyId ||
    enriched?.familyId
  );

  if (!primary) return [];

  return [primary];
}

// ================= GET OR CREATE FAMILY STATS (TOP-LEVEL) =================
function getOrCreateFamilyStats(summary, familyId, side = "unknown") {
  if (!summary || typeof summary !== "object") {
    return null;
  }

  if (!summary.families || typeof summary.families !== "object") {
    summary.families = {};
  }

  const id = normalizeMicroFamilyId(familyId);

  if (!id) {
    return null;
  }

  if (!summary.families[id]) {
    summary.families[id] = createFamilyStats(id, side);
  }

  return summary.families[id];
}

function refreshFamilyDerivedStats(stats) {
  const completed = Number(stats.completed || 0);
  const totalR = Number(stats.totalR || 0);

  stats.avgR = completed ? Number((totalR / completed).toFixed(4)) : 0;

  const fair = getFairWinrateMeta(stats);

  stats.winrateNum = fair.rawWinrateNum;
  stats.bayesianWinrateNum = fair.bayesianWinrateNum;
  stats.winrateLowerBoundNum = fair.winrateLowerBoundNum;
  stats.fairWinrateNum = fair.fairWinrateNum;
  stats.sampleReliability = fair.sampleReliability;
  stats.observationConfidence = fair.observationConfidence;
  stats.rankingMode = "WINRATE_WILSON_BAYES";

  return stats;
}

function mergeFamilyStats(target, source) {
  if (!target || !source) return target;

  target.seen += Number(source.seen || 0);
  target.completed += Number(source.completed || 0);
  target.wins += Number(source.wins || 0);
  target.losses += Number(source.losses || 0);
  target.flats += Number(source.flats || 0);
  target.totalR += Number(source.totalR || 0);
  target.directSL += Number(source.directSL || 0);
  target.nearTp += Number(source.nearTp || 0);

  for (const [k, v] of Object.entries(source.entryReasons || {})) {
    target.entryReasons[k] = Number(target.entryReasons[k] || 0) + Number(v || 0);
  }

  for (const [k, v] of Object.entries(source.setupClasses || {})) {
    target.setupClasses[k] = Number(target.setupClasses[k] || 0) + Number(v || 0);
  }

  for (const [k, v] of Object.entries(source.rsiZones || {})) {
    target.rsiZones[k] = Number(target.rsiZones[k] || 0) + Number(v || 0);
  }

  for (const [k, v] of Object.entries(source.obBiases || {})) {
    target.obBiases[k] = Number(target.obBiases[k] || 0) + Number(v || 0);
  }

  target.examples = [
    ...(target.examples || []),
    ...(source.examples || [])
  ].slice(-12);

  return refreshFamilyDerivedStats(target);
}

function mergeDayIntoWeek(week, day) {
  if (!week || !day) return week;

  week.days = week.days || {};
  week.families = week.families || {};
  week.days[day.dayKey] = {
    dayKey: day.dayKey,
    weekKey: day.weekKey,
    updatedAt: day.updatedAt,
    familyCount: Object.keys(day.families || {}).length
  };

  for (const family of Object.values(day.families || {})) {
    const target = getOrCreateFamilyStats(week, family.familyId, family.side);
    if (!target) continue;

    mergeFamilyStats(target, family);
  }

  week.updatedAt = Date.now();
  return week;
}

// ================= NIEUWE SCORE MICRO FAMILY (aangepast voor meer gewicht op sample reliability) =================
function scoreMicroFamily(family) {
  const refreshed = refreshFamilyDerivedStats({ ...family });

  const completed = Number(refreshed.completed || 0);
  const avgR = clamp(Number(refreshed.avgR || 0), -1, 1);
  const directSLPct = completed
    ? Number(refreshed.directSL || 0) / completed
    : 0;

  // Sample reliability factor increased from 40 to 80 for more weight on sample size
  const score =
    Number(refreshed.fairWinrateNum || 0) * 1000 +
    Number(refreshed.sampleReliability || 0) * 80 +
    Number(refreshed.observationConfidence || 0) * MICRO_ROTATION_OBSERVATION_WEIGHT +
    avgR * MICRO_ROTATION_AVG_R_TIEBREAK_WEIGHT -
    directSLPct * MICRO_ROTATION_DIRECT_SL_PENALTY;

  return Number(score.toFixed(4));
}

// ================= NIEUWE ACTIVE ROTATION SORTERING (fair winrate dominant) =================
function buildActiveRotationFromWeek(week, options = {}) {
  const minCompleted = Number(
    options.minCompleted ?? MICRO_ROTATION_MIN_COMPLETED
  );

  const families = Object.values(week?.families || {})
    .filter(family => isCoreMicroFamilyId(family?.familyId))
    .map(family => {
      const refreshed = refreshFamilyDerivedStats({ ...family });
      const rotationScore = scoreMicroFamily(refreshed);

      return {
        ...refreshed,
        rotationScore,
        rankingMode: "WINRATE_WILSON_BAYES"
      };
    })
    .filter(family => Number(family.completed || 0) >= minCompleted)
    .filter(family => Number(family.rotationScore || 0) >= MICRO_ROTATION_MIN_SCORE)
    .sort((a, b) => {
      // 1. Fair winrate (Wilson lower bound + Bayesian shrinkage)
      const fairDiff = Number(b.fairWinrateNum || 0) - Number(a.fairWinrateNum || 0);
      if (fairDiff !== 0) return fairDiff;

      // 2. Wilson lower bound
      const lowerBoundDiff = Number(b.winrateLowerBoundNum || 0) - Number(a.winrateLowerBoundNum || 0);
      if (lowerBoundDiff !== 0) return lowerBoundDiff;

      // 3. Sample reliability (prioritize larger samples)
      const reliabilityDiff = Number(b.sampleReliability || 0) - Number(a.sampleReliability || 0);
      if (reliabilityDiff !== 0) return reliabilityDiff;

      // 4. Completed trades
      const completedDiff = Number(b.completed || 0) - Number(a.completed || 0);
      if (completedDiff !== 0) return completedDiff;

      // 5. Raw winrate (only as tie-breaker)
      const rawWinrateDiff = Number(b.winrateNum || 0) - Number(a.winrateNum || 0);
      if (rawWinrateDiff !== 0) return rawWinrateDiff;

      // 6. Avg R
      const avgRDiff = Number(b.avgR || 0) - Number(a.avgR || 0);
      if (avgRDiff !== 0) return avgRDiff;

      return Number(b.rotationScore || 0) - Number(a.rotationScore || 0);
    });

  const longFamilies = families
    .filter(f => String(f.side || "").toLowerCase() === "bull" || String(f.familyId).includes("_LONG_"))
    .slice(0, MICRO_ROTATION_TOP_N_PER_SIDE);

  const shortFamilies = families
    .filter(f => String(f.side || "").toLowerCase() === "bear" || String(f.familyId).includes("_SHORT_"))
    .slice(0, MICRO_ROTATION_TOP_N_PER_SIDE);

  const selected = [...longFamilies, ...shortFamilies];
  const allowedMicroFamilyIds = Array.from(new Set(selected.map(f => f.familyId)));

  return {
    rotationId: `ROT_${week?.weekKey || getIsoWeekKey()}_LEARNED_MICRO`,
    weekKey: week?.weekKey || getIsoWeekKey(),
    source: "TRADE_SYSTEM_MICRO_WEEKLY_SUMMARY",
    generatedAt: Date.now(),

    rankingMode: "WINRATE_WILSON_BAYES",
    rankingMetric: "fairWinrateNum",

    allowedMicroFamilyIds,
    activeMicroFamilyIds: allowedMicroFamilyIds,

    longFamilies,
    shortFamilies,

    selectedFamilyMap: Object.fromEntries(
      selected.map(f => [f.familyId, f])
    ),

    sample: {
      familyCount: families.length,
      selectedCount: selected.length,
      completed: families.reduce((sum, f) => sum + Number(f.completed || 0), 0),
      minCompleted,
      priorTrades: MICRO_ROTATION_PRIOR_TRADES,
      priorWinrate: MICRO_ROTATION_PRIOR_WINRATE,
      wilsonZ: MICRO_ROTATION_WILSON_Z
    }
  };
}

function refreshActiveMicroRotationFromCompletedWeek(now = Date.now()) {
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

  const state = auditState.microLearning;
  const completedWeek = state.lastCompletedWeek;

  if (!completedWeek?.families || !Object.keys(completedWeek.families).length) {
    return false;
  }

  const activeRotation = buildActiveRotationFromWeek(completedWeek);

  state.activeRotation = {
    ...activeRotation,
    refreshedAt: now,
    sourceWeekKey: completedWeek.weekKey,
    rankingMode: "WINRATE_WILSON_BAYES"
  };

  state.updatedAt = now;

  return true;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function buildCurrentWeekRotationFromLearning(now = Date.now()) {
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

  const state = auditState.microLearning;
  const week = clonePlain(state.week || createMicroWeekSummary(state.activeWeekKey));

  if (!week || typeof week !== "object") return null;

  week.families = week.families || {};
  week.days = week.days || {};

  const daily = clonePlain(state.daily || createMicroDaySummary(state.activeDayKey, state.activeWeekKey));

  if (daily?.families && Object.keys(daily.families).length > 0) {
    mergeDayIntoWeek(week, daily);
  }

  if (!Object.keys(week.families || {}).length) {
    return null;
  }

  const bootstrapMinCompleted = Math.max(
    1,
    Number(MICRO_ROTATION_BOOTSTRAP_MIN_COMPLETED || 3)
  );

  const rotation = buildActiveRotationFromWeek(week, {
    minCompleted: bootstrapMinCompleted
  });

  if (!rotation.allowedMicroFamilyIds?.length) {
    return null;
  }

  return {
    ...rotation,
    rotationId: `ROT_${week.weekKey || getIsoWeekKey(now)}_CURRENT_WEEK_MICRO`,
    source: "TRADE_SYSTEM_CURRENT_WEEK_MICRO_SUMMARY",
    sourceWeekKey: week.weekKey || getIsoWeekKey(now),
    bootstrap: true,
    generatedAt: now
  };
}

// ================= VERVANGEN FUNCTIE ensureActiveMicroRotation =================
function ensureActiveMicroRotation(now = Date.now()) {
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

  const state = auditState.microLearning;

  // Eerst altijd opnieuw bouwen vanuit de laatste completed week.
  // Belangrijk: zo pakt hij meteen TOP_N_PER_SIDE=1 na je .env wijziging.
  const completedWeek = state.lastCompletedWeek;
  const hasCompletedWeekFamilies =
    completedWeek?.families &&
    Object.keys(completedWeek.families).length > 0;

  if (hasCompletedWeekFamilies) {
    refreshActiveMicroRotationFromCompletedWeek(now);

    const rotation = state.activeRotation;
    const ids = extractRotationMicroFamilyIds(rotation);

    if (ids.length > 0) {
      return rotation;
    }

    state.activeRotation = null;
    state.updatedAt = now;
    return null;
  }

  // Geen completed week?
  // Dan alleen huidige week gebruiken als jij dat expliciet aanzet.
  if (!MICRO_ROTATION_USE_CURRENT_WEEK_BOOTSTRAP) {
    state.activeRotation = null;
    state.updatedAt = now;
    return null;
  }

  const currentWeekRotation = buildCurrentWeekRotationFromLearning(now);
  const currentWeekIds = extractRotationMicroFamilyIds(currentWeekRotation);

  if (currentWeekIds.length > 0) {
    state.activeRotation = currentWeekRotation;
    state.updatedAt = now;
    return currentWeekRotation;
  }

  state.activeRotation = null;
  state.updatedAt = now;
  return null;
}
// ================= EINDE VERVANGEN FUNCTIE =================

function rollMicroLearningWindow(now = Date.now()) {
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

  const state = auditState.microLearning;
  const dayKey = getUtcDayKey(now);
  const weekKey = getIsoWeekKey(now);

  if (state.activeWeekKey !== weekKey) {
    mergeDayIntoWeek(state.week, state.daily);

    const completedWeek = {
      ...state.week,
      completedAt: now
    };

    const activeRotation = buildActiveRotationFromWeek(completedWeek);

    state.lastCompletedWeek = completedWeek;
    state.activeRotation = activeRotation;

    state.activeWeekKey = weekKey;
    state.activeDayKey = dayKey;
    state.week = createMicroWeekSummary(weekKey);
    state.daily = createMicroDaySummary(dayKey, weekKey);
    state.updatedAt = now;

    // Belangrijk: raw data resetten bij nieuwe week.
    auditState.featureStore = [];
    auditState.shadowOutcomes = [];

    console.log("TS_MICRO_WEEK_ROTATED:", JSON.stringify({
      completedWeek: completedWeek.weekKey,
      newWeek: weekKey,
      selectedFamilies: activeRotation.allowedMicroFamilyIds.length,
      longFamilies: activeRotation.longFamilies.length,
      shortFamilies: activeRotation.shortFamilies.length
    }));

    return;
  }

  if (state.activeDayKey !== dayKey) {
    mergeDayIntoWeek(state.week, state.daily);

    state.activeDayKey = dayKey;
    state.daily = createMicroDaySummary(dayKey, weekKey);
    state.updatedAt = now;

    console.log("TS_MICRO_DAY_ROLLED:", JSON.stringify({
      weekKey,
      newDay: dayKey,
      weekFamilies: Object.keys(state.week.families || {}).length
    }));
  }
}

// ================= MICRO OBSERVATION & OUTCOME (MET TRY-CATCH) =================
function recordMicroObservation(row) {
  auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

  const ids = getRowMicroFamilyIds(row);
  if (!ids.length) return;

  for (const familyId of ids) {
    const stats = getOrCreateFamilyStats(
      auditState.microLearning.daily,
      familyId,
      row.side
    );

    if (!stats) continue;

    stats.seen++;
    incObjCount(stats.entryReasons, row.entryReason || row.reason);
    incObjCount(stats.setupClasses, row.setupClass);
    incObjCount(stats.rsiZones, row.rsiZone);
    incObjCount(stats.obBiases, row.obBias);

    if (stats.examples.length < 12) {
      stats.examples.push(`${row.symbol}_${row.side}_${row.reason || row.entryReason || "NA"}`);
    }

    refreshFamilyDerivedStats(stats);
  }

  auditState.microLearning.daily.updatedAt = Date.now();
}

function recordMicroOutcome(row, source = "UNKNOWN") {
  if (!row || row.microOutcomeRecorded) return;

  try {
    auditState.microLearning = normalizeMicroLearningState(auditState.microLearning);

    const ids = getRowMicroFamilyIds(row);
    if (!ids.length) return;

    const exitRRaw = row.exitR ?? row.resultR ?? row.pnlR ?? row.rMultiple;
    const exitR = Number(exitRRaw);
    const hasExitR = Number.isFinite(exitR);

    const status = String(row.status || row.exitReason || row.reason || "").toUpperCase();

    const win = hasExitR
      ? exitR > MICRO_OUTCOME_WIN_R_THRESHOLD
      : Boolean(row.win) || status === "TP" || status === "HIT_TP";

    const loss = hasExitR
      ? exitR < -MICRO_OUTCOME_LOSS_R_THRESHOLD
      : Boolean(row.loss) || status === "SL" || status === "HIT_SL";

    const flat = !win && !loss;

    for (const familyId of ids) {
      const stats = getOrCreateFamilyStats(
        auditState.microLearning.daily,
        familyId,
        row.side
      );

      if (!stats) continue;

      stats.completed++;
      stats.totalR += hasExitR ? exitR : 0;

      if (win) stats.wins++;
      else if (loss) stats.losses++;
      else if (flat) stats.flats++;

      if (Boolean(row.directToSL)) stats.directSL++;
      if (Boolean(row.nearTpSeen)) stats.nearTp++;

      incObjCount(stats.entryReasons, row.entryReason || row.reason);
      incObjCount(stats.setupClasses, row.setupClass);
      incObjCount(stats.rsiZones, row.rsiZone);
      incObjCount(stats.obBiases, row.obBias);

      if (stats.examples.length < 12) {
        stats.examples.push(`${source}_${row.symbol}_${row.side}_${status}_R=${Number(exitR || 0).toFixed(2)}`);
      }

      refreshFamilyDerivedStats(stats);
    }

    row.microOutcomeRecorded = true;
    auditState.microLearning.daily.updatedAt = Date.now();
  } catch (e) {
    console.warn("TS_MICRO_OUTCOME_RECORD_FAILED:", JSON.stringify({
      symbol: row?.symbol || null,
      side: row?.side || null,
      source,
      error: e.message
    }));
  }
}

// ================= Helper om row te verrijken met micro rotation keys =================
function enrichRowWithMicroRotation(row) {
  if (!row?.symbol || !row?.side) return row;

  const analyzerRow = enrichRowWithAnalyzerMicroFamily(row);

  const attached = attachMicroRotationKeys(analyzerRow, {
    weekKey: auditState?.microLearning?.activeWeekKey || getIsoWeekKey()
  });

  const primaryMicroFamilyId =
    analyzerRow.analyzerMicroFamilyId ||
    normalizeMicroFamilyId(attached.microFamilyId) ||
    normalizeMicroFamilyId(analyzerRow.microFamilyId);

  const microFamilyIds = uniqIds([
    primaryMicroFamilyId,
    analyzerRow.microFamilyIds,
    analyzerRow.familyIds,
    attached.microFamilyIds,
    attached.familyIds
  ]);

  return {
    ...attached,

    analyzerMicroFamilyId: analyzerRow.analyzerMicroFamilyId || null,

    microFamilyId: primaryMicroFamilyId || attached.microFamilyId,
    familyId: primaryMicroFamilyId || attached.familyId,

    microFamilyIds,
    familyIds: microFamilyIds,
    microFamilies: microFamilyIds,
    families: microFamilyIds,

    parentFamilyId: analyzerRow.parentFamilyId || attached.parentFamilyId || null,
    analyzerParentFamilyId: analyzerRow.analyzerParentFamilyId || null,

    analyzerDefinition: analyzerRow.analyzerDefinition || null,
    analyzerDefinitionParts: analyzerRow.analyzerDefinitionParts || null,
    definition: analyzerRow.definition || attached.definition || null,
    definitionParts: analyzerRow.definitionParts || attached.definitionParts || null,

    rotationCandidate: {
      ...(attached.rotationCandidate || {}),
      microFamilyId: primaryMicroFamilyId || attached.rotationCandidate?.microFamilyId,
      microFamilyIds,
      familyId: primaryMicroFamilyId || attached.rotationCandidate?.familyId,
      familyIds: microFamilyIds
    }
  };
}

// ================= WINRATE-BASED HELPERS =================
function wilsonLowerBound(wins, completed, z = MICRO_ROTATION_WILSON_Z) {
  const n = Number(completed || 0);
  const w = Number(wins || 0);

  if (n <= 0) return 0;

  const p = clamp(w / n, 0, 1);
  const z2 = z * z;

  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return clamp((centre - margin) / denominator, 0, 1);
}

function bayesianWinrate(wins, completed) {
  const n = Number(completed || 0);
  const w = Number(wins || 0);

  const priorTrades = Math.max(0, MICRO_ROTATION_PRIOR_TRADES);
  const priorWins = priorTrades * clamp(MICRO_ROTATION_PRIOR_WINRATE, 0, 1);

  const denominator = n + priorTrades;
  if (denominator <= 0) return 0;

  return clamp((w + priorWins) / denominator, 0, 1);
}

function getFairWinrateMeta(family) {
  const completed = Math.max(0, Number(family?.completed || 0));
  const wins = clamp(Number(family?.wins || 0), 0, completed);
  const seen = Math.max(0, Number(family?.seen || 0));

  const rawWinrateNum = completed ? wins / completed : 0;
  const bayesianWinrateNum = bayesianWinrate(wins, completed);
  const winrateLowerBoundNum = wilsonLowerBound(wins, completed);

  // Main metric:
  // - Wilson lower bound is dominant.
  // - Bayesian winrate voorkomt dat kleine samples overdreven hard winnen/verliezen.
  const fairWinrateNum = completed
    ? winrateLowerBoundNum * 0.75 + bayesianWinrateNum * 0.25
    : 0;

  const sampleReliability = completed
    ? completed / (completed + MICRO_ROTATION_PRIOR_TRADES)
    : 0;

  const observationConfidence = clamp(seen / 100, 0, 1);

  return {
    rawWinrateNum: Number(rawWinrateNum.toFixed(4)),
    bayesianWinrateNum: Number(bayesianWinrateNum.toFixed(4)),
    winrateLowerBoundNum: Number(winrateLowerBoundNum.toFixed(4)),
    fairWinrateNum: Number(fairWinrateNum.toFixed(4)),
    sampleReliability: Number(sampleReliability.toFixed(4)),
    observationConfidence: Number(observationConfidence.toFixed(4))
  };
}

// ================= ROTATION HELPER FUNCTIONS =================
function getRotationSources(rotation = {}) {
  if (!rotation || typeof rotation !== "object") return [];

  return [
    rotation,
    rotation.activeRotation,
    rotation.weeklyRotation,
    rotation.rotation,
    rotation.rotationState,
    rotation.current,
    rotation.currentRotation,
    rotation.selectedRotation
  ].filter(source => source && typeof source === "object");
}

function getFirstDefinedRotationValue(rotation, keys = []) {
  const sources = getRotationSources(rotation);

  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
    }
  }

  return null;
}

function isRotationDisabledOrUnusable(rotation = {}) {
  if (!rotation || typeof rotation !== "object") return true;

  const ok = getFirstDefinedRotationValue(rotation, ["ok"]);
  const enabled = getFirstDefinedRotationValue(rotation, ["enabled"]);
  const gateEnabled = getFirstDefinedRotationValue(rotation, ["gateEnabled"]);
  const usable = getFirstDefinedRotationValue(rotation, ["usable"]);

  return (
    ok === false ||
    enabled === false ||
    gateEnabled === false ||
    usable === false
  );
}

function getRotationLogMeta(rotation = {}) {
  const ids = extractRotationMicroFamilyIds(rotation);

  return {
    ok: getFirstDefinedRotationValue(rotation, ["ok"]),
    enabled: getFirstDefinedRotationValue(rotation, ["enabled"]),
    gateEnabled: getFirstDefinedRotationValue(rotation, ["gateEnabled"]),
    usable: getFirstDefinedRotationValue(rotation, ["usable"]),
    ids: ids.length,
    rotationId: getFirstDefinedRotationValue(rotation, [
      "rotationId",
      "activeRotationId",
      "id"
    ])
  };
}

// ================= HELPER OM WEEKLY ROTATION TE LADEN =================
async function loadWeeklyRotationForGate(options = {}) {
  const explicit =
    options.weeklyRotation ??
    options.rotation ??
    options.rotationState ??
    null;

  if (explicit) {
    const ids = extractRotationMicroFamilyIds(explicit);
    const disabled = isRotationDisabledOrUnusable(explicit);

    if (!disabled && ids.length > 0) {
      return explicit;
    }

    console.warn("TS_EXPLICIT_WEEKLY_ROTATION_IGNORED:", JSON.stringify({
      reason: disabled ? "DISABLED_OR_UNUSABLE" : "NO_MICRO_FAMILY_IDS",
      ...getRotationLogMeta(explicit)
    }));

    return null;
  }

  // Externe rotation-store alleen gebruiken als je die expliciet aanzet.
  // Anders gebruikt tradeSystem de interne learned micro-rotation.
  if (!ENABLE_EXTERNAL_WEEKLY_ROTATION) {
    return null;
  }

  try {
    const { loadActiveRotationStatus } = await import("./rotation/rotationStore.js");
    const status = await loadActiveRotationStatus();

    const ids = extractRotationMicroFamilyIds(status);
    const disabled = isRotationDisabledOrUnusable(status);

    if (disabled || ids.length === 0) {
      console.warn("TS_EXTERNAL_WEEKLY_ROTATION_IGNORED:", JSON.stringify({
        reason: disabled ? "DISABLED_OR_UNUSABLE" : "NO_MICRO_FAMILY_IDS",
        ...getRotationLogMeta(status)
      }));

      return null;
    }

    return status;
  } catch (error) {
    console.warn("TS_WEEKLY_ROTATION_STATUS_LOAD_FAILED:", JSON.stringify({
      error: error?.message || String(error)
    }));

    return null;
  }
}

// ================= DURABLE LOCK HELPERS (NEW) =================
const DURABLE_LOCK_TTL_MS = Number(process.env.TS_DURABLE_LOCK_TTL_MS || 45_000);
const DURABLE_LOCK_RETRY_ATTEMPTS = Number(process.env.TS_DURABLE_LOCK_RETRY_ATTEMPTS || 8);
const DURABLE_LOCK_RETRY_BASE_MS = Number(process.env.TS_DURABLE_LOCK_RETRY_BASE_MS || 250);
const DURABLE_LOCK_RETRY_MAX_MS = Number(process.env.TS_DURABLE_LOCK_RETRY_MAX_MS || 1_500);

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function makeDurableLockOwner(runId = "") {
  const cleanRunId = String(runId || "unknown_run")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 80);

  return `${cleanRunId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function redisGetString(key) {
  const value = await redisCommand(["GET", key]);

  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;

  return String(value);
}

async function redisPttlMs(key) {
  const ttl = await redisCommand(["PTTL", key]);
  const n = Number(ttl);

  return Number.isFinite(n) ? n : -2;
}

async function redisAcquireLock({ key, owner, ttlMs }) {
  const res = await redisCommand(["SET", key, owner, "NX", "PX", ttlMs]);
  const ok = res === "OK" || res?.result === "OK";

  if (ok) {
    return {
      ok: true,
      acquired: true,
      reentrant: false,
      owner,
      ttlMs,
    };
  }

  const currentOwner = await redisGetString(key);
  const currentTtlMs = await redisPttlMs(key);

  // Re-entrant: dezelfde invocation mag door.
  if (currentOwner && currentOwner === owner) {
    await redisCommand(["PEXPIRE", key, ttlMs]);

    return {
      ok: true,
      acquired: true,
      reentrant: true,
      owner,
      currentOwner,
      ttlMs,
    };
  }

  return {
    ok: false,
    acquired: false,
    owner,
    currentOwner,
    ttlMs: currentTtlMs,
  };
}

async function redisReleaseLock({ key, owner }) {
  const currentOwner = await redisGetString(key);

  if (!currentOwner) {
    return {
      ok: true,
      released: false,
      reason: "LOCK_ALREADY_GONE",
    };
  }

  if (currentOwner !== owner) {
    return {
      ok: false,
      released: false,
      reason: "LOCK_OWNER_MISMATCH",
      currentOwner,
      owner,
    };
  }

  await redisCommand(["DEL", key]);

  return {
    ok: true,
    released: true,
    reason: "LOCK_RELEASED",
  };
}

async function withDurableRuntimeLock({
  strategyVersion,
  runId,
  task,
  ttlMs = DURABLE_LOCK_TTL_MS,
  attempts = DURABLE_LOCK_RETRY_ATTEMPTS,
}) {
  const lockKey = `${strategyVersion}:runtime:lock`;
  const owner = makeDurableLockOwner(runId);

  let lastLockState = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const lockState = await redisAcquireLock({
      key: lockKey,
      owner,
      ttlMs,
    });

    lastLockState = lockState;

    if (lockState.acquired) {
      const startedAt = Date.now();

      try {
        const result = await task({
          lockKey,
          lockOwner: owner,
          lockReentrant: lockState.reentrant,
        });

        return {
          ok: true,
          skipped: false,
          lockKey,
          lockOwner: owner,
          lockReentrant: lockState.reentrant,
          durationMs: Date.now() - startedAt,
          result,
        };
      } finally {
        const release = await redisReleaseLock({
          key: lockKey,
          owner,
        });

        if (!release.ok) {
          console.warn("TRADE_SYSTEM_DURABLE_LOCK_RELEASE_WARN:", JSON.stringify({
            strategyVersion,
            runId,
            lockKey,
            lockOwner: owner,
            release,
            ts: Date.now(),
          }));
        }
      }
    }

    const waitMs = jitter(Math.min(
      DURABLE_LOCK_RETRY_MAX_MS,
      DURABLE_LOCK_RETRY_BASE_MS * attempt * attempt
    ));

    console.warn("TRADE SYSTEM LOCK BUSY:", JSON.stringify({
      attempt,
      attempts,
      waitMs,
      ttlMs: lockState.ttlMs,
      key: lockKey,
      currentOwner: lockState.currentOwner,
      runId,
      ts: Date.now(),
    }));

    await sleep(waitMs);
  }

  console.warn("TRADE_SYSTEM_DURABLE_LOCK_BUSY_SKIP_SAVE:", JSON.stringify({
    runId,
    lockOwner: owner,
    currentOwner: lastLockState?.currentOwner ?? null,
    lockKey,
    strategyVersion,
    ttlMs: lastLockState?.ttlMs ?? null,
    attempts,
    ts: Date.now(),
  }));

  return {
    ok: false,
    skipped: true,
    reason: "DURABLE_LOCK_BUSY",
    lockKey,
    lockOwner: owner,
    currentOwner: lastLockState?.currentOwner ?? null,
    ttlMs: lastLockState?.ttlMs ?? null,
  };
}

// ================= FINALIZE RESULT =================
const TS_ANALYSIS_WEBHOOK_AWAIT =
  process.env.TS_ANALYSIS_WEBHOOK_AWAIT === "true";

function compactFilterFailures(passMap = {}) {
  return Object.entries(passMap || {})
    .filter(([, value]) => value?.pass === false)
    .slice(0, 12)
    .map(([key, value]) => ({
      key,
      reason: value?.reason || null,
      value: value?.value ?? null,
      threshold: value?.threshold ?? null
    }));
}

function compactActionForAnalysisWebhook(action = {}) {
  const a = durableObject(action);
  const diagnostics = durableObject(a.filterDiagnostics);

  const out = {
    ...durablePick(a, [
      "tradeId",
      "symbol",
      "side",
      "action",
      "reason",
      "entryReason",
      "entryType",

      "setupClass",
      "grade",

      "stage",
      "scannerStage",

      "score",
      "confluence",
      "rawConfluence",
      "effectiveConfluence",
      "sniperScore",

      "rr",
      "plannedRR",
      "baseRR",
      "finalRr",
      "effectiveRR",

      "entry",
      "sl",
      "initialSl",
      "tp",
      "exit",
      "exitR",
      "pnlPct",

      "rsi",
      "rsiHTF",
      "rsiZone",
      "rsiEdge",

      "obBias",
      "spreadPct",
      "depthMinUsd1p",

      "flow",
      "funding",
      "btcState",
      "regime",

      "rotationSide",
      "tradeSide",

      "familyId",
      "microFamilyId",
      "analyzerMicroFamilyId",

      "liveEligible",
      "shadowOnly",

      "strategyVersion",
      "ts"
    ]),

    microFamilyIds: durableArray(a.microFamilyIds).slice(0, 5),
    familyIds: durableArray(a.familyIds).slice(0, 5),

    rotationGate: a.rotationGate || a.rotation
      ? compactGateResult(a.rotationGate || a.rotation)
      : undefined,

    filterDiagnostics: diagnostics
      ? {
          liveMetrics: compactFilterSnapshot(diagnostics.liveMetrics),
          failedChecks: compactFilterFailures(diagnostics.passMap)
        }
      : undefined
  };

  return out;
}

async function sendAnalysisActionsNonBlocking(actions, context) {
  const compactActions = durableArray(actions).map(compactActionForAnalysisWebhook);


  if (!compactActions.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ANALYSIS_ACTIONS",
      sent: 0,
      total: 0
    };
  }

  if (TS_ANALYSIS_WEBHOOK_AWAIT) {
    return sendAnalysisActions(compactActions, context).catch(e => ({
      ok: false,
      error: e.message,
      sent: 0,
      total: compactActions.length
    }));
  }

  sendAnalysisActions(compactActions, context)
    .then(result => {
      console.log("TS_ANALYSIS_WEBHOOK_ASYNC_RESULT:", JSON.stringify({
        ok: Boolean(result?.ok),
        sent: Number(result?.sent || 0),
        failed: Number(result?.failed || 0),
        total: Number(result?.total || compactActions.length),
        skipped: Boolean(result?.skipped),
        reason: result?.reason || null,
        error: result?.error || null
      }));
    })
    .catch(e => {
      console.warn("TS_ANALYSIS_WEBHOOK_ASYNC_ERROR:", e.message);
    });

  return {
    ok: true,
    async: true,
    skipped: false,
    sent: compactActions.length,
    total: compactActions.length
  };
}

async function finalizeResult(actions, candidates, btcState, runId, options = {}) {
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

  const waitSummary = buildReasonTable(finalActions);
  console.log("TS_TOP_WAIT_REASONS", JSON.stringify(waitSummary.slice(0, 15)));

  console.log("TS_WAIT_SAMPLE", JSON.stringify(
    finalActions
      .filter(a => String(a.action || "").toUpperCase() === "WAIT")
      .slice(0, 20)
      .map(a => ({
        symbol: a.symbol,
        side: a.side,
        stage: a.stage,
        score: a.score,
        reason: a.reason,
        confluence: a.confluence,
        rawConfluence: a.rawConfluence,
        sniperScore: a.sniperScore,
        rr: a.rr,
        plannedRR: a.plannedRR,
        requiredRR: a.requiredRR,
        requiredConfluence: a.requiredConfluence,
        rsi: a.rsi,
        rsiHTF: a.rsiHTF,
        rsiZone: a.rsiZone,
        rsiEdge: a.rsiEdge || a.rsiEntryEdge,
        obBias: a.obBias,
        spreadPct: a.spreadPct,
        depthMinUsd1p: a.depthMinUsd1p,
        error: a.error || null,
        externalConfluence: a.externalConfluence,
        fallbackConfluence: a.fallbackConfluence,
        confluenceBlendUsed: a.confluenceBlendUsed,
        confluenceSource: a.confluenceSource,
        rawSniperScore: a.rawSniperScore,
        fallbackSniperScore: a.fallbackSniperScore,
        sniperBlendUsed: a.sniperBlendUsed
      }))
  ));

  if (actions.length === 0 && candidates.length > 0) {
    console.warn("NO_ACTIONS_FROM_TRADE_SYSTEM fallback WAIT generated");
  }

  recordActionFeatureRows(finalActions, btcState, runId);

  const auditResult = logTradeSystemAudit({
    candidates,
    actions: finalActions,
    btcState,
    runId
  });

  // Filter en cap de actions voor de analyse webhook (spam voorkomen en timeout vermijden)
  const WEBHOOK_MAX_ANALYSIS_ROWS = Number(process.env.WEBHOOK_MAX_ANALYSIS_ROWS ?? 10);
  const webhookActions = finalActions
    .filter(action => {
      const actionType = String(action.action || "").toUpperCase();
      const reason = String(action.reason || "").toUpperCase();

      if (actionType === "ENTRY") return true;
      if (actionType === "EXIT") return true;
      if (actionType === "HOLD") return false;

      // Rotation wait-spam niet naar webhook sturen; wordt lokaal samengevat.
      if (reason.startsWith("WEEKLY_ROTATION_")) return false;

      return true;
    })
    .sort((a, b) => {
      const scoreA = Number(a.score ?? 0) + Number(a.confluence ?? 0) + Number(a.sniperScore ?? 0);
      const scoreB = Number(b.score ?? 0) + Number(b.confluence ?? 0) + Number(b.sniperScore ?? 0);
      return scoreB - scoreA;
    })
    .slice(0, WEBHOOK_MAX_ANALYSIS_ROWS);

  console.log("TS_ANALYSIS_WEBHOOK_BATCH_SIZE:", JSON.stringify({
    original: finalActions.length,
    sent: webhookActions.length
  }));

  const webhookResult = await sendAnalysisActionsNonBlocking(webhookActions, {
    runId,
    btcState,
    strategyVersion: STRATEGY_VERSION,
    discoveryMode: DISCOVERY_MODE,
    filterValues: getDiscordFilterValuesSnapshot(),
    currentFilterValues: CURRENT_FILTER_VALUES,
    tradeSystemFilters: TRADE_SYSTEM_FILTERS
  }).catch(e => {
    console.warn("TS_ANALYSIS_WEBHOOK_BATCH_ERROR:", e.message);

    return {
      ok: false,
      error: e.message
    };
  });

  console.log("TS_ANALYSIS_WEBHOOK_RESULT:", JSON.stringify({
    runId,
    ok: Boolean(webhookResult?.ok),
    sent: Number(webhookResult?.sent || 0),
    failed: Number(webhookResult?.failed || 0),
    total: Number(webhookResult?.total || 0),
    skipped: Boolean(webhookResult?.skipped),
    reason: webhookResult?.reason || null,
    error: webhookResult?.error || null
  }));

  const result = {
    actions: finalActions,
    candidatesCount: candidates.length,
    strategyVersion: STRATEGY_VERSION,
    durableEnabled: hasRedis()
  };

  if (options.analyze === true) {
    result.analysis = buildAnalyzePayload({
      auditResult,
      candidates,
      actions: finalActions,
      btcState,
      runId
    });
  }

  return result;
}

// ================= MAX DEEP CANDIDATES =================
const MAX_DEEP_CANDIDATES = 200; // was 80 -> 30 -> 200

function capDeepCandidates(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];

  const open = rows.filter(c => Boolean(c.fromOpenPosition));
  const fresh = rows.filter(c => !c.fromOpenPosition);

  const cappedFresh = fresh
    .sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0))
    .slice(0, MAX_DEEP_CANDIDATES);

  return [...open, ...cappedFresh];
}

// ================= MISSING CONSTANTS =================
const CURRENT_FILTER_VALUES = {
  CANDIDATE_MIN_SCORE,
  BTC_BEARISH_LONG_MIN_SCORE,
  BTC_NEUTRAL_MIN_SCORE,

  GLOBAL_MIN_CONFLUENCE,
  A_MIN_CONFLUENCE,
  A_MIN_SNIPER,
  A_ENTRY_MIN_RR,
  A_FINAL_MIN_RR,

  B_MIN_CONFLUENCE,
  B_MIN_SNIPER,
  B_ENTRY_MIN_RR,

  GOD_MIN_CONFLUENCE,
  GOD_MIN_SNIPER,
  GOD_ENTRY_MIN_RR,

  MID_RSI_MIN_CONFLUENCE,
  TREND_CONTINUATION_MIN_CONFLUENCE,
  TREND_CONTINUATION_MIN_SNIPER,
  TREND_CONTINUATION_MIN_RR,

  MAX_SPREAD_PCT,
  MID_BULL_MAX_SPREAD_PCT,

  MIN_DEPTH_USD_1P,
  MIN_DEPTH_USD_1P_ABSOLUTE,
  A_MIN_DEPTH_USD_1P,
  BULL_TREND_MIN_DEPTH_USD_1P,

  NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE,
  NEUTRAL_OB_A_EXCEPTION_MIN_RR,
  NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER,

  NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE,
  NEUTRAL_OB_B_EXCEPTION_MIN_RR,
  NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER,
  NEUTRAL_OB_B_EXCEPTION_MIN_SCORE
};

const TRADE_SYSTEM_FILTERS = CURRENT_FILTER_VALUES;

// ================= NEW DISCORD DIAGNOSTIC HELPERS =================
function getDiscordFilterValuesSnapshot() {
  return {
    strategyVersion: STRATEGY_VERSION,

    featureFlags: {
      ENABLE_B_ENTRIES,
      ENABLE_BULLISH_MID_TREND_PROBES,
      ENABLE_BTC_BULLISH_BEAR_EXCEPTION,
      ENABLE_ENTRY_QUALITY_GATE_V12,
      ENABLE_EARLY_FAILURE_EXIT
    },

    candidateFilters: {
      CANDIDATE_MIN_SCORE,
      BTC_BEARISH_LONG_MIN_SCORE,
      BTC_NEUTRAL_MIN_SCORE
    },

    entryFilters: {
      GLOBAL_MIN_CONFLUENCE,

      A_MIN_CONFLUENCE,
      A_MIN_SNIPER,
      A_ENTRY_MIN_RR,
      A_FINAL_MIN_RR,

      B_MIN_CONFLUENCE,
      B_MIN_SNIPER,
      B_ENTRY_MIN_RR,

      GOD_MIN_CONFLUENCE,
      GOD_MIN_SNIPER,
      GOD_ENTRY_MIN_RR
    },

    rrFilters: {
      MIN_RR_FLOOR,
      GRADE_A_MIN_RR_FLOOR,
      GRADE_B_MIN_RR_FLOOR,
      GRADE_C_MIN_RR_FLOOR,
      COUNTERTREND_MIN_RR_FLOOR,
      BUILDUP_MIN_RR_FLOOR,
      MID_RSI_CONTINUATION_RR_DISCOUNT,
      A_GOD_MAX_TP_REWARD_MULTIPLIER
    },

    rsiFilters: {
      MID_RSI_MIN_CONFLUENCE,
      TREND_CONTINUATION_MIN_CONFLUENCE,
      TREND_CONTINUATION_MIN_SNIPER,
      TREND_CONTINUATION_MIN_RR,
      EARLY_RSI_MIN_SNIPER,
      SHORT_BLOCKED_RSI_ZONES,
      SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE,
      SHORT_LOWER1_CONTINUATION_MIN_SNIPER,
      SHORT_LOWER1_CONTINUATION_MIN_RR,
      SHORT_LOWER1_ALLOWED_BTC_STATES,
      LONG_LOWER2_MAX_1H_CHANGE,
      SHORT_UPPER2_MIN_1H_CHANGE
    },

    orderbookFilters: {
      MAX_SPREAD_PCT,
      MID_BULL_MAX_SPREAD_PCT,
      MIN_DEPTH_USD_1P,
      MIN_DEPTH_USD_1P_ABSOLUTE,
      A_MIN_DEPTH_USD_1P,
      BULL_TREND_MIN_DEPTH_USD_1P,
      OB_AGAINST_MIN_CONFLUENCE,
      OB_NEUTRAL_MIN_CONFLUENCE,
      NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE,
      NEUTRAL_OB_A_EXCEPTION_MIN_RR,
      NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER,
      NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE,
      NEUTRAL_OB_B_EXCEPTION_MIN_RR,
      NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER,
      NEUTRAL_OB_B_EXCEPTION_MIN_SCORE
    },

    fundingFilters: {
      EXTREME_FUNDING_ABS_MAX,
      BULL_CROWDED_FUNDING_MAX,
      BEAR_CROWDED_FUNDING_MIN,
      CROWDED_FUNDING_MIN_CONFLUENCE
    },

    pullbackFilters: {
      REQUIRE_BULL_TREND_PULLBACK,
      MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT
    },

    btcBullishBearExceptionFilters: {
      BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P,
      BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT,
      BTC_BULLISH_BEAR_EXCEPTION_MIN_RR,
      BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF,
      BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF,
      BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER
    },

    bullishMidTrendProbeFilters: {
      BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE,
      BULLISH_MID_TREND_PROBE_MIN_SNIPER,
      BULLISH_MID_TREND_PROBE_MIN_RR,
      BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT,
      BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P,
      BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH,
      BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT,
      BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT,
      BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT
    },

    confirmationFilters: {
      ENTRY_CONFIRMATION_TTL_MS,
      ENTRY_CONFIRMATION_MIN_SNIPER,
      ENTRY_CONFIRMATION_MIN_CONFLUENCE
    },

    breakEvenFilters: {
      BREAK_EVEN_TRIGGER_R,
      BREAK_EVEN_LOCK_R,
      BREAK_EVEN_MIN_TICKS,
      BREAK_EVEN_MIN_FAVORABLE_TICKS
    },

    earlyExitFilters: {
      EARLY_FAILURE_MIN_AGE_SEC,
      EARLY_FAILURE_MIN_MFE_R,
      EARLY_FAILURE_MAX_MAE_R,
      EARLY_FAILURE_MAX_CURRENT_R,
      EARLY_OB_FLIP_MIN_AGE_SEC,
      EARLY_OB_FLIP_MIN_MFE_R,
      EARLY_OB_FLIP_MAX_CURRENT_R
    }
  };
}

function buildFilterCheck({ value, operator, threshold, pass, extra = {} }) {
  return {
    value,
    operator,
    threshold,
    pass: Boolean(pass),
    ...extra
  };
}

function buildEntryFilterDiagnostics({
  c,
  setup,
  setupGrade,
  flow,
  sniper,
  confluence,
  rawConfluence,
  baseRR,
  finalRr,
  rawRequiredRR,
  requiredRR,
  finalRequiredRR,
  requiredSniper,
  rsi,
  rsiHTF,
  rsiZone,
  rsiEdge,
  obData,
  funding,
  btcState,
  regimeLevel,
  risk,
  bullPullbackMeta,
  bullishMidTrendProbe,
  btcBullishBearException,
  entryQualityGate,
  finalDepthValidation,
  bullAntiChase,
  maxSpread,
  spread,
  tpRewardMultiplier,
  hasLiquidationData,
  confirmationRequired,
  confirmationSeen
}) {
  const side = String(c.side || "").toLowerCase();
  const btc = String(btcState || "UNKNOWN").toUpperCase();

  let scoreRequired = CANDIDATE_MIN_SCORE;

  if (side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(btc)) {
    scoreRequired = BTC_BEARISH_LONG_MIN_SCORE;
  }

  if (btc === "NEUTRAL") {
    scoreRequired = Math.max(scoreRequired, BTC_NEUTRAL_MIN_SCORE);
  }

  const depth = Number(obData?.depthMinUsd1p || 0);
  const sniperScore = Number(sniper?.score || 0);
  const fundingRate = Number(funding?.rate || 0);

  return {
    filterValues: getDiscordFilterValuesSnapshot(),

    liveMetrics: {
      symbol: c.symbol,
      side,
      stage: c.stage,
      scannerStage: c.scannerStage || c.stage,

      score: Number(c.moveScore || 0),
      btcState: btc,
      regime: regimeLevel,

      flow: flow?.type || "UNKNOWN",

      confluence,
      rawConfluence,
      sniperScore,

      baseRR,
      finalRr,
      rawRequiredRR,
      requiredRR,
      finalRequiredRR,
      requiredSniper,
      tpRewardMultiplier,

      rsi,
      rsiHTF,
      rsiZone,
      rsiEdge: rsiEdge?.label || "UNKNOWN",
      rsiEdgeRank: rsiEdge?.rank ?? null,
      rsiContinuationOk: Boolean(rsiEdge?.continuationOk),
      rsiConfluenceBonus: Number(rsiEdge?.confluenceBonus || 0),
      rsiRrDiscount: Number(rsiEdge?.rrDiscount || 0),
      rsiSniperDiscount: Number(rsiEdge?.sniperDiscount || 0),

      obBias: obData?.bias || "UNKNOWN",
      spreadPct: normalizeSpread(obData?.spreadPct),
      maxSpreadAllowed: maxSpread,
      depthMinUsd1p: depth,

      funding: fundingRate,
      hasLiquidationData: Boolean(hasLiquidationData),

      entry: Number(risk?.entry || 0),
      sl: Number(risk?.sl || 0),
      tp: Number(risk?.tp || 0),

      setupClass: setup?.setupClass || "UNKNOWN",
      entryReason: setup?.entryReason || "UNKNOWN",
      grade: setupGrade?.grade || "C",
      gradePoints: Number(setupGrade?.points || 0)
    },

    passMap: {
      scannerScore: buildFilterCheck({
        value: Number(c.moveScore || 0),
        operator: ">=",
        threshold: scoreRequired,
        pass: Number(c.moveScore || 0) >= scoreRequired
      }),

      globalConfluence: buildFilterCheck({
        value: confluence,
        operator: ">=",
        threshold: GLOBAL_MIN_CONFLUENCE,
        pass: confluence >= GLOBAL_MIN_CONFLUENCE
      }),

      setupConfluence: buildFilterCheck({
        value: confluence,
        operator: ">=",
        threshold: setup?.requiredConfluence,
        pass: confluence >= Number(setup?.requiredConfluence || 0)
      }),

      sniper: buildFilterCheck({
        value: sniperScore,
        operator: ">=",
        threshold: requiredSniper,
        pass: sniperScore >= Number(requiredSniper || 0)
      }),

      baseRR: buildFilterCheck({
        value: baseRR,
        operator: ">=",
        threshold: requiredRR,
        pass: baseRR >= Number(requiredRR || 0)
      }),

      finalRR: buildFilterCheck({
        value: finalRr,
        operator: ">=",
        threshold: finalRequiredRR,
        pass: finalRr >= Number(finalRequiredRR || 0)
      }),

      spread: buildFilterCheck({
        value: spread,
        operator: "<=",
        threshold: maxSpread,
        pass: spread <= Number(maxSpread || 0)
      }),

      depth: buildFilterCheck({
        value: depth,
        operator: "custom",
        threshold: {
          MIN_DEPTH_USD_1P_ABSOLUTE,
          A_MIN_DEPTH_USD_1P,
          BULL_TREND_MIN_DEPTH_USD_1P
        },
        pass: Boolean(finalDepthValidation?.ok),
        reason: finalDepthValidation?.reason || "OK"
      }),

      midRsiConfluence: buildFilterCheck({
        value: confluence,
        operator: rsiZone === "MID" ? ">=" : "N/A",
        threshold: rsiZone === "MID" ? MID_RSI_MIN_CONFLUENCE : null,
        pass: rsiZone !== "MID" || confluence >= MID_RSI_MIN_CONFLUENCE
      }),

      bullAntiChase: {
        pass: Boolean(bullAntiChase?.ok),
        reason: bullAntiChase?.reason || "OK",
        pullbackConfirmed: Boolean(bullPullbackMeta?.pullbackConfirmed),
        sweepConfirmed: Boolean(bullPullbackMeta?.sweepConfirmed),
        retestConfirmed: Boolean(bullPullbackMeta?.retestConfirmed),
        distanceFromLocalHighPct: Number(bullPullbackMeta?.distanceFromLocalHighPct || 0)
      },

      funding: {
        value: fundingRate,
        absMax: EXTREME_FUNDING_ABS_MAX,
        pass: Math.abs(fundingRate) <= EXTREME_FUNDING_ABS_MAX
      },

      qualityGate: {
        pass: Boolean(entryQualityGate?.ok),
        reason: entryQualityGate?.reason || "OK"
      },

      confirmation: {
        required: Boolean(confirmationRequired),
        seen: Boolean(confirmationSeen),
        pass: !confirmationRequired || confirmationSeen
      }
    },

    specialChecks: {
      bullishMidTrendProbe: {
        ok: Boolean(bullishMidTrendProbe?.ok),
        reason: bullishMidTrendProbe?.reason || null,
        checks: bullishMidTrendProbe?.checks || null
      },

      btcBullishBearException: {
        ok: Boolean(btcBullishBearException?.ok),
        exception: Boolean(btcBullishBearException?.exception),
        reason: btcBullishBearException?.reason || null,
        checks: btcBullishBearException?.checks || null
      }
    }
  };
}

function getRsiSetupRrCredit(rsiEdge) {
  const rank = Number(rsiEdge?.rank || 0);

  if (rank >= 3) return 0.10;
  if (rank >= 2) return 0.07;
  if (rank >= 1) return 0.04;

  if (rank === 0 && rsiEdge?.continuationOk) {
    return 0.02;
  }

  return 0;
}

function getRsiSniperDiscount(rsiEdge) {
  const rank = Number(rsiEdge?.rank || 0);

  if (rank >= 3) return 8;
  if (rank >= 2) return 5;
  if (rank >= 1) return 3;

  if (rank === 0 && rsiEdge?.continuationOk) {
    return 2;
  }

  return 0;
}

function getRsiAdjustedRequiredSniper({ requiredSniper, rsiEdge }) {
  const base = Number(requiredSniper || B_MIN_SNIPER);
  const rank = Number(rsiEdge?.rank || 0);

  let adjusted = base - getRsiSniperDiscount(rsiEdge);

  if (rank < 0) {
    adjusted += Math.abs(rank) * 4;
  }

  return clamp(Math.round(adjusted), 30, 95);
}

// ================= V12 HELPER FUNCTIONS (DISABLED, maar laten voor compatibiliteit) =================
function isRsiChopZone(rsi) {
  const value = Number(rsi);
  return (
    Number.isFinite(value) &&
    value >= QUALITY_CHOP_RSI_MIN &&
    value <= QUALITY_CHOP_RSI_MAX
  );
}

function hasStrongNeutralObException({
  confluence,
  sniperScore,
  rr,
  spreadPct,
  depthMinUsd1p,
  flow
}) {
  return (
    Number(confluence || 0) >= QUALITY_MID_NEUTRAL_MIN_CONFLUENCE &&
    Number(sniperScore || 0) >= QUALITY_MID_NEUTRAL_MIN_SNIPER &&
    Number(rr || 0) >= QUALITY_MID_NEUTRAL_MIN_RR &&
    normalizeSpread(spreadPct) <= QUALITY_MID_NEUTRAL_MAX_SPREAD_PCT &&
    Number(depthMinUsd1p || 0) >= QUALITY_MID_NEUTRAL_MIN_DEPTH_USD_1P &&
    String(flow || "").toUpperCase() === "TREND"
  );
}

function hasValidBullReclaimStructure(candidate) {
  return (
    Boolean(candidate.pullbackConfirmed) ||
    Boolean(candidate.sweepConfirmed) ||
    Boolean(candidate.retestConfirmed) ||
    Boolean(candidate.fakeBreakoutConfirmed)
  );
}

function validateEntryQualityGateV12(candidate) {
  if (!ENABLE_ENTRY_QUALITY_GATE_V12) {
    return { ok: true, reason: "QUALITY_GATE_DISABLED" };
  }

  const side = String(candidate.side || "").toLowerCase();
  const rsiZone = String(candidate.rsiZone || "UNKNOWN").toUpperCase();
  const obBias = String(candidate.obBias || "NEUTRAL").toUpperCase();
  const flow = String(candidate.flow || "UNKNOWN").toUpperCase();

  const rsi = Number(candidate.rsi || 0);
  const rr = Number(candidate.plannedRR || 0);
  const confluence = Number(candidate.confluence || 0);
  const sniperScore = Number(candidate.sniperScore || 0);
  const spreadPct = normalizeSpread(candidate.spreadPct);
  const depthMinUsd1p = Number(candidate.depthMinUsd1p || 0);

  const neutralOb = obBias === "NEUTRAL" || obBias === "UNKNOWN";
  const alignedOb =
    (side === "bull" && obBias === "BULLISH") ||
    (side === "bear" && obBias === "BEARISH");

  const neutralObExceptionOk = Boolean(candidate.neutralObExceptionOk);

  if (
    rsiZone === "MID" &&
    neutralOb &&
    !neutralObExceptionOk &&
    !hasStrongNeutralObException({
      confluence,
      sniperScore,
      rr,
      spreadPct,
      depthMinUsd1p,
      flow
    })
  ) {
    return {
      ok: false,
      reason: "V12_MID_RSI_NEUTRAL_OB_BLOCK"
    };
  }

  if (
    rr < QUALITY_LOW_RR_THRESHOLD &&
    (sniperScore < QUALITY_LOW_RR_MIN_SNIPER || confluence < QUALITY_LOW_RR_MIN_CONFLUENCE)
  ) {
    return {
      ok: false,
      reason: "V12_LOW_RR_WEAK_QUALITY"
    };
  }

  if (
    isRsiChopZone(rsi) &&
    !alignedOb &&
    (sniperScore < QUALITY_CHOP_MIN_SNIPER || confluence < QUALITY_CHOP_MIN_CONFLUENCE)
  ) {
    return {
      ok: false,
      reason: "V12_RSI_CHOP_NO_OB_ALIGNMENT"
    };
  }

  if (
    side === "bull" &&
    ["LOWER_2", "LOWER_3"].includes(rsiZone) &&
    !hasValidBullReclaimStructure(candidate)
  ) {
    return {
      ok: false,
      reason: "V12_LONG_LOWER_RSI_NO_RECLAIM"
    };
  }

  if (
    side === "bull" &&
    ["LOWER_1", "LOWER_2", "LOWER_3"].includes(rsiZone) &&
    (sniperScore < QUALITY_LOWER_RSI_LONG_MIN_SNIPER || confluence < QUALITY_LOWER_RSI_LONG_MIN_CONFLUENCE)
  ) {
    return {
      ok: false,
      reason: "V12_LONG_LOWER_RSI_WEAK_QUALITY"
    };
  }

  return {
    ok: true,
    reason: "V12_QUALITY_OK"
  };
}

function requiresEntryConfirmation(candidate) {
  if (DISCOVERY_MODE) return false;

  const setupClass = String(candidate.setupClass || "").toUpperCase();
  const rsiZone = String(candidate.rsiZone || "UNKNOWN").toUpperCase();
  const obBias = String(candidate.obBias || "NEUTRAL").toUpperCase();
  const neutralObExceptionOk = Boolean(candidate.neutralObExceptionOk);

  const confluence = Number(candidate.confluence || 0);
  const sniperScore = Number(candidate.sniperScore || 0);

  if (setupClass === "GOD") return false;

  const highQualityA =
    ["A", "A_SHORT_EXCEPTION"].includes(setupClass) &&
    sniperScore >= ENTRY_CONFIRMATION_MIN_SNIPER &&
    confluence >= ENTRY_CONFIRMATION_MIN_CONFLUENCE;

  if (highQualityA && neutralObExceptionOk) {
    return false;
  }

  if (
    highQualityA &&
    obBias !== "NEUTRAL" &&
    obBias !== "UNKNOWN"
  ) {
    return false;
  }

  if (
    sniperScore >= ENTRY_CONFIRMATION_MIN_SNIPER &&
    confluence >= ENTRY_CONFIRMATION_MIN_CONFLUENCE &&
    obBias !== "NEUTRAL"
  ) {
    return false;
  }

  if (setupClass === "B" || setupClass === "B_TREND_PROBE") return true;
  if (rsiZone === "MID") return true;
  if (obBias === "NEUTRAL" || obBias === "UNKNOWN") return true;
  if (sniperScore < 78) return true;
  if (confluence < 82) return true;

  return false;
}

// ================= PATCHED CONFIRMATION HELPERS (Map) =================
function hasRecentEntryConfirmation(key) {
  const confirmKey = `CONFIRM_${key}`;
  const expiresAt = Number(lastSignalMap.get(confirmKey) || 0);

  if (!expiresAt) return false;

  if (Date.now() >= expiresAt) {
    lastSignalMap.delete(confirmKey);
    return false;
  }

  return true;
}

function markEntryConfirmation(key) {
  lastSignalMap.set(`CONFIRM_${key}`, Date.now() + ENTRY_CONFIRMATION_TTL_MS);
}

function evaluateEarlyFailureExit(position, ob) {
  if (!ENABLE_EARLY_FAILURE_EXIT) {
    return { exit: false, reason: "EARLY_FAILURE_DISABLED" };
  }

  const ageSec = (Date.now() - Number(position?.createdAt || Date.now())) / 1000;

  const currentR = Number(position?.currentR || 0);
  const mfeR = Number(position?.mfeR || 0);
  const maeR = Number(position?.maeR || 0);

  const side = String(position?.side || "").toLowerCase();
  const obBias = String(ob?.bias || "NEUTRAL").toUpperCase();

  const obAgainst =
    (side === "bull" && obBias === "BEARISH") ||
    (side === "bear" && obBias === "BULLISH");

  if (
    ageSec >= EARLY_FAILURE_MIN_AGE_SEC &&
    mfeR < EARLY_FAILURE_MIN_MFE_R &&
    maeR <= EARLY_FAILURE_MAX_MAE_R &&
    currentR <= EARLY_FAILURE_MAX_CURRENT_R
  ) {
    return {
      exit: true,
      reason: "EARLY_NO_FOLLOW_THROUGH"
    };
  }

  if (
    ageSec >= EARLY_OB_FLIP_MIN_AGE_SEC &&
    obAgainst &&
    mfeR < EARLY_OB_FLIP_MIN_MFE_R &&
    currentR <= EARLY_OB_FLIP_MAX_CURRENT_R
  ) {
    return {
      exit: true,
      reason: "EARLY_OB_FLIP"
    };
  }

  return {
    exit: false,
    reason: "EARLY_FAILURE_NOT_TRIGGERED"
  };
}

// ================= HELPER OM WEEKLY ROTATION TE LADEN =================
function extractRotationMicroFamilyIds(rotation = {}) {
  if (!rotation || typeof rotation !== "object") return [];

  const sources = [
    rotation,
    rotation.activeRotation,
    rotation.weeklyRotation,
    rotation.rotation,
    rotation.rotationState,
    rotation.current,
    rotation.currentRotation,
    rotation.selectedRotation
  ].filter(Boolean);

  const values = [];

  for (const source of sources) {
    values.push(
      source.microFamilyIds,
      source.activeMicroFamilyIds,
      source.allowedMicroFamilyIds,
      source.familyIds,
      source.activeFamilyIds,
      source.allowedFamilyIds,
      source.allowlist,
      source.allowed,
      source.active
    );

    const familyRows = [
      ...(Array.isArray(source.longFamilies) ? source.longFamilies : []),
      ...(Array.isArray(source.shortFamilies) ? source.shortFamilies : []),
      ...(Array.isArray(source.families) ? source.families : []),
      ...(Array.isArray(source.selectedFamilies) ? source.selectedFamilies : []),
      ...(Array.isArray(source.rows) ? source.rows : [])
    ];

    for (const row of familyRows) {
      values.push(
        row?.familyId,
        row?.microFamilyId,
        row?.analyzerMicroFamilyId,
        row?.id,
        row?.key
      );
    }

    if (source.selectedFamilyMap && typeof source.selectedFamilyMap === "object") {
      values.push(Object.keys(source.selectedFamilyMap));
    }

    if (source.familyMap && typeof source.familyMap === "object") {
      values.push(Object.keys(source.familyMap));
    }
  }

  return uniqIds(values);
}

function extractParentFamilyIdFromMicroId(raw) {
  const id = normalizeMicroFamilyId(raw);
  if (!id) return null;

  const match = id.match(/^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_\d{1,3})_/);

  return match?.[2] || null;
}

function extractParentFamilyIdsFromMicroIds(ids = []) {
  return Array.from(
    new Set(
      uniqIds(ids)
        .map(extractParentFamilyIdFromMicroId)
        .filter(Boolean)
    )
  );
}

function getSignalParentFamilyIds(signal = {}) {
  const directParents = [
    signal.parentFamilyId,
    signal.analyzerParentFamilyId
  ]
    .map(value => analyzerCleanToken(value, ""))
    .filter(value => /^(LONG|SHORT)_\d{1,3}$/.test(value));

  const microParents = extractParentFamilyIdsFromMicroIds([
    signal.analyzerMicroFamilyId,
    signal.analyzerMicroFamilyIds,
    signal.microFamilyId,
    signal.familyId,
    signal.microFamilyIds,
    signal.familyIds,
    signal.microFamilies,
    signal.families
  ]);

  return Array.from(new Set([
    ...directParents,
    ...microParents
  ]));
}

function getParentFamilyRotationMatch({ signal, rotationIds }) {
  const activeParentFamilyIds = extractParentFamilyIdsFromMicroIds(rotationIds);
  const checkedParentFamilyIds = getSignalParentFamilyIds(signal);

  const activeSet = new Set(activeParentFamilyIds);

  const matchedParentFamilyId =
    checkedParentFamilyIds.find(id => activeSet.has(id)) || null;

  return {
    allowed: Boolean(matchedParentFamilyId),
    matchedParentFamilyId,
    checkedParentFamilyIds,
    activeParentFamilyIds
  };
}

function isRotationFamilyMiss(rotationCheck = {}) {
  const text = [
    rotationCheck.reason,
    rotationCheck.waitReason,
    rotationCheck.gateReason,
    rotationCheck.decision?.reason,
    rotationCheck.decision?.waitReason,
    rotationCheck.decision?.gateReason
  ]
    .filter(Boolean)
    .map(value => String(value).toUpperCase())
    .join("|");

  return (
    text.includes("MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION") ||
    text.includes("REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION") ||
    text.includes("WEEKLY_ROTATION")
  );
}

function selectWeeklyRotationForGate({
  externalRotation,
  learnedRotation
}) {
  const externalIds = extractRotationMicroFamilyIds(externalRotation);
  const learnedIds = extractRotationMicroFamilyIds(learnedRotation);

  const externalUsable =
    externalIds.length > 0 &&
    !isRotationDisabledOrUnusable(externalRotation);

  const learnedUsable =
    learnedIds.length > 0 &&
    !isRotationDisabledOrUnusable(learnedRotation);

  if (externalUsable) {
    return {
      rotation: externalRotation,
      source: "EXTERNAL_ROTATION",
      ids: externalIds
    };
  }

  if (learnedUsable) {
    return {
      rotation: learnedRotation,
      source: "TRADE_SYSTEM_LEARNED_ROTATION",
      ids: learnedIds
    };
  }

  return {
    rotation: learnedRotation ?? externalRotation ?? null,
    source: learnedRotation ? "LEARNED_EMPTY_BOOTSTRAP" : "NO_ROTATION_BOOTSTRAP",
    ids: []
  };
}

function buildBestSetupAdvice() {
  // Placeholder for compatibility
  return null;
}

// ================= DURABLE LOCK HELPERS (NEW) =================
// (Already included above)

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notifyBase = options.notify !== false;
  const notifyEntries =
    notifyBase &&
    (!DISCOVERY_MODE || DISCOVERY_SEND_DISCORD);

  const notifyExits = notifyBase;

  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockOwner = `${runId}_${Math.random().toString(36).slice(2, 8)}`;

  const durableRequired = hasRedis();
  let lockAcquired = false;
  let stopLockHeartbeat = () => {};

  let durableLoadedOk = false;

  try {
    if (durableRequired) {
      lockAcquired = await acquireRuntimeLock(lockOwner);

      if (!lockAcquired) {
        console.warn("TRADE_SYSTEM_DURABLE_LOCK_BUSY_SKIP_RUN:", JSON.stringify({
          runId,
          lockOwner,
          lockKey: RUNTIME_LOCK_KEY,
          strategyVersion: STRATEGY_VERSION,
          ts: Date.now()
        }));

        return {
          actions: [],
          candidatesCount: 0,
          strategyVersion: STRATEGY_VERSION,
          durableEnabled: hasRedis(),
          skipped: true,
          reason: "TRADE_SYSTEM_DURABLE_LOCK_BUSY",
          runId,
          ts: Date.now()
        };
      }

      stopLockHeartbeat = startRuntimeLockHeartbeat(lockOwner);
    }

    const durableLoaded = await loadDurableRuntimeState();
    durableLoadedOk = durableLoaded;

    if (durableRequired && !durableLoadedOk) {
      throw new Error("TRADE_SYSTEM_DURABLE_LOAD_FAILED_ABORTING_TO_PREVENT_STATE_WIPE");
    }

    if (!ENABLE_FEATURE_STORE && !ENABLE_SHADOW_OUTCOMES) {
      await deleteDisabledOptimizerChunks();
    }

    await updatePostExitMonitors();
    await updateShadowFeatureOutcomes();

    // Daily/weekly micro-family roll-up.
    rollMicroLearningWindow(Date.now());

    // Herbouw bestaande weekly rotation met fair-winrate ranking.
    // Als er nog geen completed-week rotation is, gebruik huidige week als bootstrap.
    const learnedRotationForGate = ensureActiveMicroRotation(Date.now());

    console.log("TS_LEARNED_MICRO_ROTATION_READY:", JSON.stringify({
      runId,
      ok: Boolean(learnedRotationForGate),
      source: learnedRotationForGate?.source || null,
      rotationId: learnedRotationForGate?.rotationId || null,
      weekKey: learnedRotationForGate?.weekKey || learnedRotationForGate?.sourceWeekKey || null,
      ids: extractRotationMicroFamilyIds(learnedRotationForGate).length,
      longFamilies: learnedRotationForGate?.longFamilies?.length || 0,
      shortFamilies: learnedRotationForGate?.shortFamilies?.length || 0,
      bootstrap: Boolean(learnedRotationForGate?.bootstrap)
    }));

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

    const { candidates: allCandidates } = buildTradeCandidates(candidatesRaw);
    const candidates = capDeepCandidates(allCandidates);
    const actions = [];

    let market = { trend: "NEUTRAL" };

    try {
      market = await getMarketContext("BTCUSDT", 0);
    } catch (e) {
      console.warn("Market context fallback:", e.message);
    }

    let btcState = "NEUTRAL";
    if (options.btcRaw && typeof options.btcRaw === 'object') {
      const btcChange24 = Number(options.btcRaw.price_change_percentage_24h || 0);
      const btcChange1h = Number(options.btcRaw.price_change_percentage_1h_in_currency || 0);
      btcState = classifyBtcState({ change24: btcChange24, change1h: btcChange1h });
    } else {
      btcState = scanBtc?.state || market?.trend || "NEUTRAL";
    }

    // === NIEUW: laad weekly rotation voor gate ===
    const weeklyRotationForGate = await loadWeeklyRotationForGate(options);

    console.log("TS_WEEKLY_ROTATION_FOR_GATE:", JSON.stringify({
      runId,
      ok: Boolean(weeklyRotationForGate),
      rotationId: weeklyRotationForGate?.rotationId || weeklyRotationForGate?.activeRotationId || null,
      enabled: weeklyRotationForGate?.enabled ?? null,
      usable: weeklyRotationForGate?.usable ?? null,
      activeMicroFamilyIds: weeklyRotationForGate?.activeMicroFamilyIds?.length || 0,
      allowedMicroFamilyIds: weeklyRotationForGate?.allowedMicroFamilyIds?.length || 0,
      longCount: weeklyRotationForGate?.longCount ?? null,
      shortCount: weeklyRotationForGate?.shortCount ?? null
    }));

    if (candidates.length === 0) {
      return await finalizeResult([], [], btcState, runId, options);
    }

    const dataMap = new Map();

    const fetchCoinData = async c => {
      const symbol = normalizeBaseSymbol(c.symbol);
      const contractSymbol = normalizeBitgetSymbol(c.rawBitgetSymbol || symbol);

      const fetchOrderBookSafe = async () => {
        try {
          const raw = await cachedFetch(`ob_${contractSymbol}`, async () => {
            for (let i = 0; i < 2; i++) {
              try {
                const data = await fetchOrderBook(contractSymbol);
                if (data) return data;
              } catch {}

              await sleep(150);
            }

            return null;
          }, 12000);

          if (!raw) return { ...DEFAULT_OB };

          const analyzed = analyzeOrderBookAdvanced(raw);

          const ob = {
            ...DEFAULT_OB,
            ...(analyzed || {}),
            fetchFailed: false
          };

          updateOrderbookMemorySafe(symbol, raw, analyzed);

          return ob;
        } catch {
          return { ...DEFAULT_OB };
        }
      };

      const [
        ob,
        fundingResult,
        candles15m,
        candles1h
      ] = await Promise.all([
        fetchOrderBookSafe(),

        cachedFetch(
          `fund_${contractSymbol}`,
          () => fetchFunding(contractSymbol),
          120000
        ).catch(() => ({ rate: 0 })),

        cachedFetch(
          `c15_${contractSymbol}`,
          () => fetchCandles(contractSymbol, "15m", 100),
          20000
        ).catch(() => []),

        cachedFetch(
          `c1h_${contractSymbol}`,
          () => fetchCandles(contractSymbol, "1h", 100),
          20000
        ).catch(() => [])
      ]);

      let candles4h = null;

      if (Number(c.tfStrength || 0) >= 2) {
        candles4h = await cachedFetch(
          `c4h_${contractSymbol}`,
          () => fetchCandles(contractSymbol, "4h", 100),
          30000
        ).catch(() => null);
      }

      const fallbackMtf = buildFallbackMtfRsi({
        candles15m,
        candles1h,
        candles4h
      });

      let externalMtf = {};

      try {
        externalMtf = await getMTFRSI({
          m15: candles15m,
          h1: candles1h,
          h4: candles4h
        }) || {};
      } catch {
        externalMtf = {};
      }

      const mtfRsi = mergeMtfRsi(externalMtf, fallbackMtf);

      const rsiData = {
        mtf: mtfRsi,
        structure: { trend: "NEUTRAL" },
        candles15m,
        candles1h
      };

      let liquidation = null;

      try {
        const liqPrice = Number(c.price || c.lastPrice || ob.mid || 0);

        if (liqPrice > 0) {
          liquidation = await cachedFetch(
            `liquid_${contractSymbol}_${Math.round(liqPrice * 1000000)}`,
            () => getLiquidationZones(contractSymbol, liqPrice),
            20000
          );
        }
      } catch (e) {
        console.warn(`Liquidation fetch failed for ${symbol}:`, e.message);
      }

      dataMap.set(symbol, {
        ob,
        funding: fundingResult || { rate: 0 },
        rsiData,
        liquidation,
        contractSymbol
      });
    };

    const uniqueDataCandidates = Array.from(
      new Map(
        candidates.map(c => [
          normalizeBaseSymbol(c.symbol),
          c
        ])
      ).values()
    );

    await mapConcurrent(
      uniqueDataCandidates,
      DATA_FETCH_CONCURRENCY,
      fetchCoinData
    );

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

      const rawFlow = await analyzeFlow(c);
      const flow = {
        ...(rawFlow && typeof rawFlow === "object" ? rawFlow : {}),
        type: String(rawFlow?.type || c.flow || "NEUTRAL").toUpperCase()
      };
      c.flow = flow.type;

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
          const intendedExecutionPrice = hitTP
            ? Number(pos.tp)
            : Number(pos.sl);
          const executionPrice = triggerPrice;

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
            intendedExecutionPrice,
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
              intendedExecutionPrice,
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

          if (notifyExits && !notifyState.get(exitKey)) {
            const discordOk = await notifyExitSafe({
              symbol: c.symbol,
              side: c.side,
              setupClass: pos.setupClass || "UNKNOWN",
              entryType: "EXIT",
              reason,
              rr: pos.rr,
              exitR: exitPayload.exitR,
              triggerR: exitPayload.triggerR,
              pnlPct: exitPayload.pnlPct,
              triggerPnlPct: exitPayload.triggerPnlPct,
              mfeR: exitPayload.mfeR,
              maeR: exitPayload.maeR,
              currentR: exitPayload.currentR,
              grade: pos.grade || "C",
              entry: pos.entry,
              exit: executionPrice,
              executionPrice,
              intendedExecutionPrice,
              triggerPrice,
              sl: pos.sl,
              initialSl: pos.initialSl,
              tp: pos.tp,
              flow: pos.flow || flow.type,
              stage: c.stage,
              scannerStage: c.scannerStage || c.stage
            });

            if (discordOk) {
              notifyState.set(exitKey, true);
            }
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

        const earlyFailure = evaluateEarlyFailureExit(pos, obData);

        if (earlyFailure.exit) {
          const triggerPrice = Number(c.price);
          const executionPrice = triggerPrice;
          const reason = earlyFailure.reason;

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
            intendedExecutionPrice: executionPrice,
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
              intendedExecutionPrice: executionPrice,
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

          if (notifyExits && !notifyState.get(exitKey)) {
            const discordOk = await notifyExitSafe({
              symbol: c.symbol,
              side: c.side,
              setupClass: pos.setupClass || "UNKNOWN",
              entryType: "EXIT",
              reason,
              rr: pos.rr,
              exitR: exitPayload.exitR,
              triggerR: exitPayload.triggerR,
              pnlPct: exitPayload.pnlPct,
              triggerPnlPct: exitPayload.triggerPnlPct,
              mfeR: exitPayload.mfeR,
              maeR: exitPayload.maeR,
              currentR: exitPayload.currentR,
              grade: pos.grade || "C",
              entry: pos.entry,
              exit: executionPrice,
              executionPrice,
              intendedExecutionPrice: executionPrice,
              triggerPrice,
              sl: pos.sl,
              initialSl: pos.initialSl,
              tp: pos.tp,
              flow: pos.flow || flow.type,
              stage: c.stage,
              scannerStage: c.scannerStage || c.stage
            });

            if (discordOk) {
              notifyState.set(exitKey, true);
            }
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

      if (hasAnyOpenPositionForSymbol(c.symbol)) {
        const openSide = getOpenPositionSideForSymbol(c.symbol);

        actions.push(buildWait(
          c,
          "SYMBOL_ALREADY_OPEN",
          flow,
          null,
          0,
          0,
          funding,
          obData,
          null,
          null,
          null,
          null
        ));

        console.log("TS_ENTRY_BLOCKED_SYMBOL_ALREADY_OPEN:", JSON.stringify({
          symbol: c.symbol,
          side: c.side,
          openSide
        }));

        continue;
      }

      if (cooldownMap.has(key)) {
        actions.push(buildWait(
          c,
          "COOLDOWN_ACTIVE",
          flow,
          null,
          0,
          0,
          funding,
          obData,
          null,
          null,
          null,
          null
        ));

        continue;
      }

      if (symbolCooldownMap.has(c.symbol)) {
        actions.push(buildWait(
          c,
          "SYMBOL_REENTRY_COOLDOWN_ACTIVE",
          flow,
          null,
          0,
          0,
          funding,
          obData,
          null,
          null,
          null,
          null
        ));

        continue;
      }

      const exposureGate = validateExposureCaps(c, btcState);

      if (!exposureGate.ok) {
        actions.push(buildWait(
          c,
          exposureGate.reason,
          flow,
          null,
          0,
          0,
          funding,
          obData,
          null,
          null,
          null,
          null
        ));

        continue;
      }

      if (processingLocks.has(symbolLockKey)) {
        actions.push(buildWait(
          c,
          "PROCESSING_LOCK_ACTIVE",
          flow,
          null,
          0,
          0,
          funding,
          obData,
          null,
          null,
          null,
          null
        ));

        continue;
      }

      processingLocks.add(symbolLockKey);

      try {
        const timeframeMeta = getTimeframeMeta(c);

        c.tfScore = timeframeMeta.tfScore;
        c.tfStrength = timeframeMeta.tfStrength;
        c.tfAlignment = timeframeMeta.tfAlignment;

        const regimeLevel = getRegimeKey(scanRegime, options.regime);
        const isBullMarket = isBtcBullishState(btcState);

        const rsiSignal = await getSafeRsiSignal({
          c,
          rsiData,
          isBull,
          btcState
        });

        const rsi = safeNumber(rsiSignal?.rsi, 50);
        const rsiHTF = safeNumber(rsiSignal?.rsiHTF, rsi);
        const rsiZone = getRsiZone(rsiSignal);

        const rsiEdge = getRsiEdgeMeta({
          isBull,
          rsiSignal,
          rsiZone
        });

        c._debugRsiZone = rsiZone;

        c._debugRsiEdgeMeta = rsiEdge;
        c._debugRsiEdge = rsiEdge.label;
        c._debugRsiEntryEdge = rsiEdge.label;
        c._debugRsiEdgeRank = rsiEdge.rank;

        c._debugRsiConfluenceBonus = rsiEdge.confluenceBonus;
        c._debugRsiRrDiscount = rsiEdge.rrDiscount;
        c._debugRsiSniperDiscount = rsiEdge.sniperDiscount ?? getRsiSniperDiscount(rsiEdge);

        if (!DISCOVERY_MODE && rsiSignal.blocked === true) {
          const payload = buildWait(
            c,
            "RSI_HTF_BLOCKED",
            flow,
            null,
            0,
            0,
            funding,
            obData,
            null,
            null,
            null,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (!DISCOVERY_MODE && rsiSignal.valid === false) {
          const payload = buildWait(
            c,
            "RSI_INVALID",
            flow,
            null,
            0,
            0,
            funding,
            obData,
            null,
            null,
            null,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (!DISCOVERY_MODE && rsiEdge.hardBlock) {
          const payload = buildWait(
            c,
            isBull ? "RSI_LONG_EXTREME_TOO_HIGH" : "RSI_SHORT_EXTREME_TOO_LOW",
            flow,
            null,
            0,
            0,
            funding,
            obData,
            null,
            null,
            null,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          payload.rsiEdge = rsiEdge.label;
          payload.rsiEdgeRank = rsiEdge.rank;
          actions.push(payload);
          continue;
        }

        if (!DISCOVERY_MODE && isBull && ["UPPER_2", "UPPER_3"].includes(rsiZone) && !rsiEdge.continuationOk) {
          const payload = buildWait(
            c,
            "RSI_LONG_TOO_HIGH",
            flow,
            null,
            0,
            0,
            funding,
            obData,
            null,
            null,
            null,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (!DISCOVERY_MODE && !isBull && SHORT_BLOCKED_RSI_ZONES.includes(rsiZone)) {
          const payload = buildWait(
            c,
            "RSI_SHORT_TOO_LOW",
            flow,
            null,
            0,
            0,
            funding,
            obData,
            null,
            null,
            null,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (c.side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(String(btcState).toUpperCase())) {
          const score = Number(c.moveScore || 0);

          if (score < BTC_BEARISH_LONG_MIN_SCORE) {
            actions.push(buildWait(
              c,
              "BTC_BEARISH_LONG_LOW_SCORE",
              flow,
              null,
              0,
              0,
              funding,
              obData,
              null,
              null,
              null,
              null
            ));

            continue;
          }
        }

        if (String(btcState).toUpperCase() === "NEUTRAL") {
          const score = Number(c.moveScore || 0);

          if (score < BTC_NEUTRAL_MIN_SCORE) {
            actions.push(buildWait(
              c,
              "BTC_NEUTRAL_LOW_SCORE",
              flow,
              null,
              0,
              0,
              funding,
              obData,
              null,
              null,
              null,
              null
            ));

            continue;
          }
        }

        const sniper = await getSafeSniperEntry({
          c,
          flow,
          ob: obData,
          rsiSignal,
          rsiZone,
          isBull,
          btcState
        });

        c._debugRawSniperScore = Number(sniper?.rawSniperScore || 0);
        c._debugFallbackSniperScore = Number(sniper?.fallbackSniperScore || 0);
        c._debugSniperBlendUsed = Boolean(sniper?.sniperBlendUsed);

        const liquidity = await cachedFetch(
          `liq_${contractSymbol}_${c.side}`,
          () => getSafeLiquidityZones({ contractSymbol, c }),
          20000
        ).catch(() => null);

        const rawRisk = await getSafeRiskGeometry({
          c,
          isBull,
          liquidity,
          liquidation,
          ob: obData,
          flow,
          sniper,
          rsiSignal
        });

        const risk = enforceMinimumBaseRR(rawRisk, isBull, MIN_PRE_TP_GEOMETRY_RR);

        if (!isValidRiskGeometry(risk, isBull)) {
          const payload = buildWait(
            c,
            "RISK_INVALID",
            flow,
            sniper,
            0,
            0,
            funding,
            obData,
            risk,
            null,
            null,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        const baseRR = safeNumber(
          risk.rr || calculateRRFromPrices(risk.entry, risk.sl, risk.tp, isBull),
          0
        );

        const hasLiquidationData = Boolean(
          liquidation &&
          (
            Array.isArray(liquidation?.zones) ||
            Array.isArray(liquidation?.longs) ||
            Array.isArray(liquidation?.shorts) ||
            Object.keys(liquidation || {}).length > 0
          )
        );

        const rawConfluence = await getSafeConfluence({
          c,
          flow,
          sniper,
          ob: obData,
          risk,
          rr: baseRR,
          funding,
          rsiSignal,
          rsiZone,
          btcState,
          regimeLevel,
          liquidation,
          isBull
        });

        const confluence = applyRsiEdgeToConfluence(rawConfluence, rsiEdge);

        c._debugRawConfluence = rawConfluence;
        c._debugEffectiveConfluence = confluence;
        c._debugRsiConfluenceBonus = rsiEdge.confluenceBonus;

        const bullPullbackMeta = getBullPullbackMeta({
          c,
          candles15m: rsiData?.candles15m || [],
          fakeBreakoutConfirmed: Boolean(c.fakeBreakoutConfirmed || c.fakeBreakout)
        });

        const observationRow = buildScanObservationRow({
          c,
          flow,
          sniper,
          confluence,
          rr: baseRR,
          funding,
          ob: obData,
          risk,
          btcState,
          regimeLevel,
          rsi,
          rsiHTF,
          rsiZone,
          rsiValid: rsiSignal.valid !== false,
          rsiHtfBlocked: rsiSignal.blocked === true,
          hasLiquidationData,
          isValidFakeBreakout: Boolean(c.fakeBreakoutConfirmed || c.fakeBreakout),
          bullPullbackMeta,
          setupGrade: null,
          runId
        });

        recordScanObservation(observationRow);

        if (confluence < GLOBAL_MIN_CONFLUENCE) {
          const payload = buildWait(
            c,
            "LOW_GLOBAL_CONFLUENCE",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            null,
            GLOBAL_MIN_CONFLUENCE,
            null
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        const earlyExceptionCandidate = {
          ...c,
          flow: flow.type,
          btcState,
          obBias: obData?.bias || "NEUTRAL",
          confluence,
          sniperScore: Number(sniper?.score || 0),
          plannedRR: baseRR,
          spreadPct: normalizeSpread(obData?.spreadPct),
          depthMinUsd1p: Number(obData?.depthMinUsd1p || 0),
          rsiZone,
          change1h: Number(c.change1h || 0),
          change24: Number(c.change24 || 0)
        };

        const earlyBtcBullishBearException =
          validateBtcBullishShortException(earlyExceptionCandidate);

        c._debugBtcBullishBearException = earlyBtcBullishBearException.exception;
        c._debugBtcBullishBearExceptionReason = earlyBtcBullishBearException.reason;
        c._debugBtcBullishBearExceptionChecks = earlyBtcBullishBearException.checks;

        const bullMidTrendContinuationException =
          c.side === "bull" &&
          flow.type === "TREND" &&
          isBullMarket &&
          Number(sniper?.score || 0) >= TREND_CONTINUATION_MIN_SNIPER;

        const btcBullishShortMidException =
          c.side === "bear" &&
          isBullMarket &&
          earlyBtcBullishBearException.ok;

        if (
          rsiZone === "MID" &&
          confluence < MID_RSI_MIN_CONFLUENCE &&
          !bullMidTrendContinuationException &&
          !btcBullishShortMidException
        ) {
          const payload = buildWait(
            c,
            "MID_RSI_LOW_CONFLUENCE",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            null,
            MID_RSI_MIN_CONFLUENCE,
            null
          );

          payload.rsi = rsi;
          payload.rsiHTF = rsiHTF;
          payload.rsiZone = rsiZone;
          payload.rsiEdge = rsiEdge.label;

          actions.push(payload);
          continue;
        }

        c._debugPullbackConfirmed = bullPullbackMeta.pullbackConfirmed;
        c._debugSweepConfirmed = bullPullbackMeta.sweepConfirmed;
        c._debugRetestConfirmed = bullPullbackMeta.retestConfirmed;
        c._debugDistanceFromLocalHighPct = bullPullbackMeta.distanceFromLocalHighPct;

        const candidateForValidation = {
          ...c,
          flow: flow.type,
          btcState,
          obBias: obData?.bias || "NEUTRAL",
          confluence,
          sniperScore: Number(sniper?.score || 0),
          plannedRR: baseRR,
          spreadPct: normalizeSpread(obData?.spreadPct),
          depthMinUsd1p: Number(obData?.depthMinUsd1p || 0),
          rsiZone,

          rsiContinuationOK: Boolean(
            rsiSignal?.continuationOK ||
            rsiSignal?.continuationOk ||
            rsiEdge.continuationOk
          ),
          rsiContinuationScore: Number(rsiSignal?.continuationScore || rsiEdge.continuationScore || 0),

          pullbackConfirmed: bullPullbackMeta.pullbackConfirmed,
          sweepConfirmed: bullPullbackMeta.sweepConfirmed,
          retestConfirmed: bullPullbackMeta.retestConfirmed,
          distanceFromLocalHighPct: bullPullbackMeta.distanceFromLocalHighPct,
          fakeBreakoutConfirmed: Boolean(c.fakeBreakoutConfirmed || c.fakeBreakout),

          change1h: Number(c.change1h || 0),
          change24: Number(c.change24 || 0)
        };

        const bullishMidTrendProbe = validateBullishMidTrendProbe(candidateForValidation);

        c._debugBullishMidTrendProbe = bullishMidTrendProbe.ok;
        c._debugBullishMidTrendProbeReason = bullishMidTrendProbe.reason;
        c._debugBullishMidTrendProbeChecks = bullishMidTrendProbe.checks;

        const btcBullishBearException = earlyBtcBullishBearException;

        if (!DISCOVERY_MODE && c.side === "bear" && isBullMarket && !btcBullishBearException.ok) {
          const payload = buildWait(
            c,
            btcBullishBearException.reason || "BTC_BULLISH_WEAK_SHORT",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            null,
            BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF,
            BTC_BULLISH_BEAR_EXCEPTION_MIN_RR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        const setupGrade = getSetupGrade({
          c,
          ob: obData,
          flow,
          sniper,
          confluence,
          rr: baseRR,
          hasLiquidationData,
          isBull
        });

        const counterTrend = getCounterTrend(c, btcState);

        const dynamicMinRr = getDynamicMinRrFloor({
          c,
          setupGrade,
          flow,
          sniper,
          confluence,
          counterTrend
        });

        c.minRrFloor = dynamicMinRr;

        const setupEvalRR = baseRR;
        c._debugSetupEvalRR = setupEvalRR;

        const setup = inferSetupClass({
          c,
          sniper,
          confluence,
          rr: setupEvalRR,
          rsiEdge,
          bullishMidTrendProbe: bullishMidTrendProbe.ok,
          btcBullishBearException: btcBullishBearException.exception
        });

        if (!setup) {
          const payload = buildWait(
            c,
            "LOW_ENTRY_QUALITY",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            Math.min(A_MIN_CONFLUENCE, B_MIN_CONFLUENCE),
            Math.min(A_ENTRY_MIN_RR, B_ENTRY_MIN_RR)
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          payload.plannedRR = baseRR;
          actions.push(payload);
          continue;
        }

        const rawRequiredRR = Number(setup.requiredRR || MIN_RR_FLOOR);

        const requiredRR = applyRsiEdgeToRequiredRR(
          rawRequiredRR,
          rsiEdge,
          MIN_PRE_TP_GEOMETRY_RR
        );
        const requiredSniper = getRsiAdjustedRequiredSniper({
          requiredSniper: setup.requiredSniper,
          rsiEdge
        });

        if (Number(sniper?.score || 0) < requiredSniper) {
          const payload = buildWait(
            c,
            "LOW_SNIPER",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (confluence < Number(setup.requiredConfluence || 0)) {
          const payload = buildWait(
            c,
            "LOW_CONFLUENCE",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (baseRR < requiredRR) {
          const payload = buildWait(
            c,
            "LOW_RR",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        const tpRewardMultiplier = getTpRewardMultiplier({
          setupClass: setup.setupClass,
          certaintyMode,
          sniperScore: Number(sniper?.score || 0),
          rsi,
          isBull
        });

        const finalTp = buildAdjustedTp(
          risk.entry,
          risk.tp,
          tpRewardMultiplier,
          isBull
        );

        const finalRr = calculateRRFromPrices(
          risk.entry,
          risk.sl,
          finalTp,
          isBull
        );

        const neutralObExceptionOk = isNeutralObEntryException({
          c,
          flow,
          sniper,
          confluence,
          rr: finalRr,
          setupClass: setup.setupClass,
          counterTrend
        });

        if (!isBull && rsiZone === "LOWER_1") {
          const btcAllowed = SHORT_LOWER1_ALLOWED_BTC_STATES.includes(
            String(btcState || "").toUpperCase()
          );

          const shortContinuationOk =
            btcAllowed &&
            confluence >= SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE &&
            Number(sniper?.score || 0) >= SHORT_LOWER1_CONTINUATION_MIN_SNIPER &&
            baseRR >= SHORT_LOWER1_CONTINUATION_MIN_RR;

          if (!shortContinuationOk) {
            const payload = buildWait(
              c,
              "RSI_SHORT_LOWER1_WEAK_CONTINUATION",
              flow,
              sniper,
              confluence,
              baseRR,
              funding,
              obData,
              risk,
              null,
              SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE,
              SHORT_LOWER1_CONTINUATION_MIN_RR
            );

            payload.rsi = rsi;
            payload.rsiHTF = rsiHTF;
            payload.rsiZone = rsiZone;
            payload.rsiEdge = rsiEdge.label;

            actions.push(payload);
            continue;
          }
        }

        const maxSpread = getMaxSpreadForCandidate({
          c,
          rsiZone,
          setupClass: setup.setupClass
        });

        const spread = normalizeSpread(obData?.spreadPct);

        if (spread > maxSpread) {
          const midBullSpreadException =
            c.side === "bull" &&
            rsiZone === "MID" &&
            confluence >= MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE &&
            Number(sniper?.score || 0) >= MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER;

          if (!midBullSpreadException) {
            const payload = buildWait(
              c,
              c.side === "bull" && rsiZone === "MID"
                ? "MID_BULL_SPREAD_TOO_WIDE"
                : "SPREAD_TOO_WIDE",
              flow,
              sniper,
              confluence,
              baseRR,
              funding,
              obData,
              risk,
              setupGrade,
              setup.requiredConfluence,
              requiredRR
            );
            payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
            payload.maxSpreadAllowed = maxSpread;
            actions.push(payload);
            continue;
          }
        }

        const finalDepthValidation = validateFinalDepth({
          ...candidateForValidation,
          setupClass: setup.setupClass,
          flow: flow.type
        });

        if (!finalDepthValidation.ok) {
          const payload = buildWait(
            c,
            finalDepthValidation.reason,
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        const bullAntiChase = validateBullAntiChase({
          ...candidateForValidation,
          setupClass: setup.setupClass,
          bullishMidTrendProbeOk: bullishMidTrendProbe.ok
        });

        if (!DISCOVERY_MODE && !bullAntiChase.ok) {
          const payload = buildWait(
            c,
            bullAntiChase.reason,
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (Math.abs(Number(funding?.rate || 0)) > EXTREME_FUNDING_ABS_MAX) {
          const payload = buildWait(
            c,
            "EXTREME_FUNDING",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        if (
          c.side === "bull" &&
          Number(funding?.rate || 0) > BULL_CROWDED_FUNDING_MAX &&
          confluence < CROWDED_FUNDING_MIN_CONFLUENCE
        ) {
          actions.push(buildWait(
            c,
            "BULL_CROWDED_FUNDING",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            CROWDED_FUNDING_MIN_CONFLUENCE,
            requiredRR
          ));
          continue;
        }

        if (
          c.side === "bear" &&
          Number(funding?.rate || 0) < BEAR_CROWDED_FUNDING_MIN &&
          confluence < CROWDED_FUNDING_MIN_CONFLUENCE
        ) {
          actions.push(buildWait(
            c,
            "BEAR_CROWDED_FUNDING",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            CROWDED_FUNDING_MIN_CONFLUENCE,
            requiredRR
          ));
          continue;
        }

        const entryQualityGate = validateEntryQualityGateV12({
          ...candidateForValidation,
          setupClass: setup.setupClass,

          rsi,
          rsiHTF,
          rsiZone,

          flow: flow.type,
          obBias: obData?.bias || "NEUTRAL",

          confluence,
          sniperScore: Number(sniper?.score || 0),

          plannedRR: finalRr,
          finalRr,
          neutralObExceptionOk,

          spreadPct: normalizeSpread(obData?.spreadPct),
          depthMinUsd1p: Number(obData?.depthMinUsd1p || 0),

          pullbackConfirmed: bullPullbackMeta.pullbackConfirmed,
          sweepConfirmed: bullPullbackMeta.sweepConfirmed,
          retestConfirmed: bullPullbackMeta.retestConfirmed,
          fakeBreakoutConfirmed: Boolean(c.fakeBreakoutConfirmed || c.fakeBreakout)
        });

        if (!entryQualityGate.ok) {
          const payload = buildWait(
            c,
            entryQualityGate.reason,
            flow,
            sniper,
            confluence,
            finalRr,
            funding,
            obData,
            {
              ...risk,
              tp: finalTp
            },
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );

          payload.rsi = rsi;
          payload.rsiHTF = rsiHTF;
          payload.rsiZone = rsiZone;
          payload.rsiEdge = rsiEdge.label;
          payload.plannedRR = finalRr;
          payload.baseRR = baseRR;
          payload.finalRr = finalRr;
          payload.tpRewardMultiplier = tpRewardMultiplier;
          payload.qualityGate = "V12";

          actions.push(payload);
          continue;
        }

        if (
          isObAgainstSide(obData, isBull) &&
          confluence < OB_AGAINST_MIN_CONFLUENCE
        ) {
          const payload = buildWait(
            c,
            "OB_AGAINST_SIDE",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            OB_AGAINST_MIN_CONFLUENCE,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        const neutralOb = ["NEUTRAL", "UNKNOWN"].includes(
          String(obData?.bias || "NEUTRAL").toUpperCase()
        );

        const isBtcBullishBearExceptionEntry =
          setup.setupClass === "A_SHORT_EXCEPTION" &&
          btcBullishBearException.exception === true;

        if (
          !DISCOVERY_MODE &&
          neutralOb &&
          !isBtcBullishBearExceptionEntry &&
          !neutralObExceptionOk
        ) {
          const requiredNeutralConf =
            ["A", "GOD", "A_SHORT_EXCEPTION"].includes(setup.setupClass)
              ? NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE
              : NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE;

          const payload = buildWait(
            c,
            "NEUTRAL_OB_NO_EXCEPTION",
            flow,
            sniper,
            confluence,
            finalRr,
            funding,
            obData,
            risk,
            setupGrade,
            requiredNeutralConf,
            requiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          actions.push(payload);
          continue;
        }

        function getFinalRequiredRrFloor({ setupClass, c, counterTrend }) {
          const cls = String(setupClass || "").toUpperCase();

          let floor = MIN_RR_FLOOR;

          if (["A", "GOD", "A_SHORT_EXCEPTION"].includes(cls)) {
            floor = A_FINAL_MIN_RR;
          } else if (cls === "B") {
            floor = B_ENTRY_MIN_RR;
          } else if (cls === "B_TREND_PROBE") {
            floor = BULLISH_MID_TREND_PROBE_MIN_RR;
          }

          if (counterTrend) {
            floor = Math.max(floor, COUNTERTREND_MIN_RR_FLOOR);
          }

          if (String(c?.stage || "").toLowerCase() === "buildup") {
            floor = Math.max(floor, BUILDUP_MIN_RR_FLOOR);
          }

          return floor;
        }

        const rawFinalRequiredRR = getFinalRequiredRrFloor({
          setupClass: setup.setupClass,
          c,
          counterTrend
        });

        const finalRequiredRR = rawFinalRequiredRR;

        if (finalRr < finalRequiredRR) {
          const payload = buildWait(
            c,
            "LOW_FINAL_RR",
            flow,
            sniper,
            confluence,
            finalRr,
            funding,
            obData,
            {
              ...risk,
              tp: finalTp
            },
            setupGrade,
            setup.requiredConfluence,
            finalRequiredRR
          );
          payload.rsi = rsi; payload.rsiHTF = rsiHTF; payload.rsiZone = rsiZone;
          payload.baseRR = baseRR;
          payload.finalRr = finalRr;
          payload.tpRewardMultiplier = tpRewardMultiplier;
          actions.push(payload);
          continue;
        }

        const confirmationCandidate = {
          ...candidateForValidation,
          setupClass: setup.setupClass,

          rsi,
          rsiHTF,
          rsiZone,

          flow: flow.type,
          obBias: obData?.bias || "NEUTRAL",

          confluence,
          sniperScore: Number(sniper?.score || 0),

          plannedRR: finalRr,
          finalRr,

          neutralObExceptionOk
        };

        const confirmationRequired = requiresEntryConfirmation(confirmationCandidate);
        const confirmationSeen = hasRecentEntryConfirmation(key);

        if (confirmationRequired && !confirmationSeen) {
          markEntryConfirmation(key);

          const payload = buildWait(
            c,
            "V12_ENTRY_CONFIRMATION_PENDING",
            flow,
            sniper,
            confluence,
            baseRR,
            funding,
            obData,
            risk,
            setupGrade,
            setup.requiredConfluence,
            requiredRR
          );

          payload.rsi = rsi;
          payload.rsiHTF = rsiHTF;
          payload.rsiZone = rsiZone;
          payload.rsiEdge = rsiEdge.label;
          payload.plannedRR = baseRR;
          payload.setupClass = setup.setupClass;
          payload.confirmationTtlMs = ENTRY_CONFIRMATION_TTL_MS;

          actions.push(payload);
          continue;
        }

        const filterDiagnostics = buildEntryFilterDiagnostics({
          c,
          setup,
          setupGrade,
          flow,
          sniper,
          confluence,
          rawConfluence,
          baseRR,
          finalRr,
          rawRequiredRR,
          requiredRR,
          finalRequiredRR,
          requiredSniper,
          rsi,
          rsiHTF,
          rsiZone,
          rsiEdge,
          obData,
          funding,
          btcState,
          regimeLevel,
          risk: {
            ...risk,
            tp: finalTp
          },
          bullPullbackMeta,
          bullishMidTrendProbe,
          btcBullishBearException,
          entryQualityGate,
          finalDepthValidation,
          bullAntiChase,
          maxSpread,
          spread,
          tpRewardMultiplier,
          hasLiquidationData,
          confirmationRequired,
          confirmationSeen
        });

        const position = buildEntryPosition({
          c,
          risk,
          finalTp,
          finalRr,
          baseRR,
          tpRewardMultiplier,
          setupClass: setup.setupClass,
          entryReason: setup.entryReason,
          setupGrade,
          flow,
          sniper,
          confluence,
          funding,
          ob: obData,
          rsi,
          rsiHTF,
          rsiZone,
          btcState,
          regimeLevel,
          contractSymbol
        });

        const entryPayload = {
          ...buildCommonPayload(c, flow, sniper, funding, obData),

          tradeId: position.tradeId,
          
          closed: false,
          openedAt: position.createdAt,
          entryTs: position.createdAt,
          analyzeSource: "tradeSystem",

          action: "ENTRY",
          reason: setup.entryReason,
          entryType: setup.entryReason,

          setupClass: setup.setupClass,
          grade: setupGrade?.grade || "C",
          gradePoints: Number(setupGrade?.points || 0),
          recommendedRisk: setupGrade?.recommendedRisk || "watch",

          confluence: Number(confluence || 0),

          rawConfluence: Number(rawConfluence || 0),
          rsiEdge: rsiEdge.label,
          rsiEdgeRank: rsiEdge.rank,
          rsiConfluenceBonus: rsiEdge.confluenceBonus,
          rsiRrDiscount: rsiEdge.rrDiscount,
          requiredRRRaw: Number(rawRequiredRR || 0),
          requiredRRFinal: Number(requiredRR || 0),

          rr: formatRR(finalRr),
          plannedRR: Number(finalRr),
          baseRR: Number(baseRR),
          finalRr: Number(finalRr),
          effectiveRR: Number(finalRr),
          tpRewardMultiplier: Number(tpRewardMultiplier),

          entry: Number(position.entry),
          sl: Number(position.sl),
          initialSl: Number(position.initialSl),
          tp: Number(position.tp),

          slSource: position.slSource,
          tpSource: position.tpSource,

          rsi,
          rsiHTF,
          rsiZone,

          pullbackConfirmed: bullPullbackMeta.pullbackConfirmed,
          sweepConfirmed: bullPullbackMeta.sweepConfirmed,
          retestConfirmed: bullPullbackMeta.retestConfirmed,
          distanceFromLocalHighPct: bullPullbackMeta.distanceFromLocalHighPct,

          bullishMidTrendProbe: Boolean(c._debugBullishMidTrendProbe),
          bullishMidTrendProbeReason: c._debugBullishMidTrendProbeReason || null,
          bullishMidTrendProbeChecks: c._debugBullishMidTrendProbeChecks || null,

          btcBullishBearException: Boolean(c._debugBtcBullishBearException),
          btcBullishBearExceptionReason: c._debugBtcBullishBearExceptionReason || null,
          btcBullishBearExceptionChecks: c._debugBtcBullishBearExceptionChecks || null,

          filterDiagnostics,
          filterValues: filterDiagnostics.filterValues,
          filterChecks: filterDiagnostics.passMap,
          liveFilterMetrics: filterDiagnostics.liveMetrics,
          specialFilterChecks: filterDiagnostics.specialChecks
        };

        // ================= NIEUWE ROTATION GATE (met correcte rotation selector) =================
        const selectedRotationForGate = selectWeeklyRotationForGate({
          externalRotation: weeklyRotationForGate,
          learnedRotation: learnedRotationForGate
        });

        const learnedWeeklyRotation = selectedRotationForGate.rotation;

console.log("TS_WEEKLY_ROTATION_SELECTED_FOR_GATE:", JSON.stringify({
  runId,
  source: selectedRotationForGate.source,
  ids: selectedRotationForGate.ids.length,
  rotationId:
    learnedWeeklyRotation?.rotationId ||
    learnedWeeklyRotation?.activeRotationId ||
    null,
  weekKey:
    learnedWeeklyRotation?.weekKey ||
    learnedWeeklyRotation?.sourceWeekKey ||
    null
}));

// Harde veiligheid:
// Als strict microfamilie-gate aan staat,
// en er zijn 0 actieve microfamilies,
// dan mag er geen enkele nieuwe entry open.
if (
  MICRO_ROTATION_STRICT_ENTRY_GATE &&
  !MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP &&
  selectedRotationForGate.ids.length === 0
) {
  const noRotationPayload = buildWait(
    c,
    "WEEKLY_ROTATION_NO_ACTIVE_MICRO_FAMILIES",
    flow,
    sniper,
    confluence,
    finalRr,
    funding,
    obData,
    {
      ...risk,
      tp: finalTp
    },
    setupGrade,
    setup.requiredConfluence,
    finalRequiredRR
  );

  noRotationPayload.tradeId = position.tradeId;
  noRotationPayload.setupClass = setup.setupClass;
  noRotationPayload.entryReason = setup.entryReason;
  noRotationPayload.entryType = setup.entryReason;
  noRotationPayload.liveEligible = false;
  noRotationPayload.shadowOnly = true;

  await logAction(noRotationPayload, regimeLevel, btcState, shouldLog);
  actions.push(noRotationPayload);

  console.warn("TS_ENTRY_BLOCKED_NO_ACTIVE_MICRO_FAMILIES:", JSON.stringify({
    symbol: c.symbol,
    side: c.side,
    setupClass: setup.setupClass,
    reason: setup.entryReason,
    activeIds: selectedRotationForGate.ids.length,
    runId
  }));

  continue;
}

const analyzerEntryPayload = enrichRowWithMicroRotation(entryPayload);

        const rotationReadySignal = attachMicroRotationKeys(analyzerEntryPayload, {
  weeklyRotation: learnedWeeklyRotation,
  rotation: learnedWeeklyRotation,
  rotationState: learnedWeeklyRotation,
  marketState: { btcState, regime: regimeLevel },
  weekKey: options.weekKey || auditState.microLearning?.activeWeekKey,

  // Alleen microfamilies uit de actieve rotation mogen door.
  strictWeeklyRotation: MICRO_ROTATION_STRICT_ENTRY_GATE,

  // Bij lege rotation niets openen, tenzij env expliciet true is.
  allowBootstrapWhenRotationEmpty: MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP,

  // GOD mag de learned winrate allowlist niet omzeilen.
  allowGodSoftPass: false,

          // Gate gebruikt dezelfde relaxed TS-floors.
          // Ranking gebeurt op fair winrate, niet op hoge RR/PnL.
          minEntryScore: CANDIDATE_MIN_SCORE,
          minAlmostScore: CANDIDATE_MIN_SCORE,
          minConfluence: GLOBAL_MIN_CONFLUENCE,
          minSniperScore: B_MIN_SNIPER,
          minPlannedRR: MIN_PRE_TP_GEOMETRY_RR,

          // Alleen dezelfde top microfamilies checken als learning gebruikt.
          // Dit voorkomt dat brede fallback families te snel matchen.
          maxFamilyIdsChecked: MICRO_LEARNING_MAX_FAMILIES_PER_ROW
        });

        console.log("TS_ROTATION_SIGNAL_READY", JSON.stringify({
          symbol: rotationReadySignal.symbol,
          side: rotationReadySignal.side,
          rotationSide: rotationReadySignal.rotationSide,
          setupClass: rotationReadySignal.setupClass,
          reason: rotationReadySignal.reason,
          microFamilyId: rotationReadySignal.microFamilyId,
          microFamilyIds: rotationReadySignal.microFamilyIds,
          familyId: rotationReadySignal.familyId,
          rotationId: rotationReadySignal.rotationId
        }));

        const rotationCheck = await checkTradeSignalAgainstRotation(rotationReadySignal, {
  weeklyRotation: learnedWeeklyRotation,
  rotation: learnedWeeklyRotation,
  rotationState: learnedWeeklyRotation,
  marketState: { btcState, regime: regimeLevel },
  weekKey: options.weekKey || auditState.microLearning?.activeWeekKey,

  // Alleen microfamilies uit de actieve rotation mogen door.
  strictWeeklyRotation: MICRO_ROTATION_STRICT_ENTRY_GATE,

  // Bij lege rotation niets openen, tenzij env expliciet true is.
  allowBootstrapWhenRotationEmpty: MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP,

  // GOD mag de learned winrate allowlist niet omzeilen.
  allowGodSoftPass: false,

          // Gate gebruikt dezelfde relaxed TS-floors.
          // Ranking gebeurt op fair winrate, niet op hoge RR/PnL.
          minEntryScore: CANDIDATE_MIN_SCORE,
          minAlmostScore: CANDIDATE_MIN_SCORE,
          minConfluence: GLOBAL_MIN_CONFLUENCE,
          minSniperScore: B_MIN_SNIPER,
          minPlannedRR: MIN_PRE_TP_GEOMETRY_RR,

          // Alleen dezelfde top microfamilies checken als learning gebruikt.
          // Dit voorkomt dat brede fallback families te snel matchen.
          maxFamilyIdsChecked: MICRO_LEARNING_MAX_FAMILIES_PER_ROW
        });

        const signalForAction = rotationCheck.signal ?? rotationReadySignal;

const analyzerId =
  analyzerEntryPayload.analyzerMicroFamilyId ||
  signalForAction.analyzerMicroFamilyId ||
  null;

signalForAction.analyzerMicroFamilyId = analyzerId;

signalForAction.microFamilyIds = uniqIds([
  signalForAction.microFamilyId,
  signalForAction.familyId,
  analyzerId,
  signalForAction.analyzerMicroFamilyIds,
  signalForAction.microFamilyIds,
  signalForAction.familyIds
]);

signalForAction.familyIds = signalForAction.microFamilyIds;
signalForAction.microFamilies = signalForAction.microFamilyIds;
signalForAction.families = signalForAction.microFamilyIds;

const exactRotationAllowed = Boolean(rotationCheck.allowed);

const parentRotationMatch = getParentFamilyRotationMatch({
  signal: signalForAction,
  rotationIds: selectedRotationForGate.ids
});

const rotationFamilyMiss = isRotationFamilyMiss(rotationCheck);

const allowByParentFamily =
  MICRO_ROTATION_STRICT_ENTRY_GATE &&
  MICRO_ROTATION_PARENT_FALLBACK &&
  !exactRotationAllowed &&
  rotationFamilyMiss &&
  parentRotationMatch.allowed;

if (allowByParentFamily) {
  rotationCheck.allowed = true;
  rotationCheck.reason = "REAL_MICRO_PARENT_FAMILY_MATCH";
  rotationCheck.waitReason = null;

  rotationCheck.decision = {
    ...(rotationCheck.decision || {}),

    allowed: true,
    pass: true,
    ok: true,

    reason: "REAL_MICRO_PARENT_FAMILY_MATCH",
    gateReason: "REAL_MICRO_PARENT_FAMILY_MATCH",

    matchedParentFamilyId: parentRotationMatch.matchedParentFamilyId,
    checkedParentFamilyIds: parentRotationMatch.checkedParentFamilyIds,
    activeParentFamilyIds: parentRotationMatch.activeParentFamilyIds,

    exactMicroFamilyMatch: false,
    parentFamilyFallbackMatch: true
  };

  signalForAction.rotation = rotationCheck.decision;
  signalForAction.rotationGate = rotationCheck.decision;
  signalForAction.parentFamilyFallbackMatch = true;
  signalForAction.matchedParentFamilyId = parentRotationMatch.matchedParentFamilyId;
}

console.log("TS_ROTATION_PARENT_MATCH_DEBUG:", JSON.stringify({
  symbol: c.symbol,
  side: c.side,
  setupClass: setup.setupClass,
  reason: setup.entryReason,

  exactRotationAllowed,
  parentFallbackEnabled: MICRO_ROTATION_PARENT_FALLBACK,
  familyMiss: rotationFamilyMiss,

  parentFallbackMatched: Boolean(allowByParentFamily),
  matchedParentFamilyId: parentRotationMatch.matchedParentFamilyId,

  checkedParentFamilyIds: parentRotationMatch.checkedParentFamilyIds,
  activeParentFamilyIds: parentRotationMatch.activeParentFamilyIds,

  checkedMicroFamilyIds: signalForAction.microFamilyIds?.slice?.(0, 8) || [],
  activeMicroFamilyIds: selectedRotationForGate.ids?.slice?.(0, 8) || []
}));

        if (!rotationCheck.allowed) {
          const blockedPayload = buildWait(
            c,
            rotationCheck.waitReason ?? rotationCheck.reason,
            flow,
            sniper,
            confluence,
            finalRr,
            funding,
            obData,
            {
              ...risk,
              tp: finalTp
            },
            setupGrade,
            setup.requiredConfluence,
            finalRequiredRR
          );

          blockedPayload.tradeId = position.tradeId;
          blockedPayload.setupClass = setup.setupClass;
          blockedPayload.entryReason = setup.entryReason;
          blockedPayload.entryType = setup.entryReason;
          blockedPayload.grade = setupGrade?.grade || "C";
          blockedPayload.gradePoints = Number(setupGrade?.points || 0);
          blockedPayload.recommendedRisk = setupGrade?.recommendedRisk || "watch";
          blockedPayload.confluence = Number(confluence || 0);
          blockedPayload.rawConfluence = Number(rawConfluence || 0);
          blockedPayload.rr = formatRR(finalRr);
          blockedPayload.plannedRR = Number(finalRr);
          blockedPayload.baseRR = Number(baseRR);
          blockedPayload.finalRr = Number(finalRr);
          blockedPayload.effectiveRR = Number(finalRr);
          blockedPayload.tpRewardMultiplier = Number(tpRewardMultiplier);
          blockedPayload.entry = Number(position.entry);
          blockedPayload.sl = Number(position.sl);
          blockedPayload.initialSl = Number(position.initialSl);
          blockedPayload.tp = Number(position.tp);
          blockedPayload.slSource = position.slSource;
          blockedPayload.tpSource = position.tpSource;
          blockedPayload.rsi = rsi;
          blockedPayload.rsiHTF = rsiHTF;
          blockedPayload.rsiZone = rsiZone;
          blockedPayload.rsiEdge = rsiEdge.label;
          blockedPayload.rsiEdgeRank = rsiEdge.rank;
          blockedPayload.pullbackConfirmed = bullPullbackMeta.pullbackConfirmed;
          blockedPayload.sweepConfirmed = bullPullbackMeta.sweepConfirmed;
          blockedPayload.retestConfirmed = bullPullbackMeta.retestConfirmed;
          blockedPayload.distanceFromLocalHighPct = bullPullbackMeta.distanceFromLocalHighPct;
          blockedPayload.bullishMidTrendProbe = Boolean(c._debugBullishMidTrendProbe);
          blockedPayload.bullishMidTrendProbeReason = c._debugBullishMidTrendProbeReason || null;
          blockedPayload.bullishMidTrendProbeChecks = c._debugBullishMidTrendProbeChecks || null;
          blockedPayload.btcBullishBearException = Boolean(c._debugBtcBullishBearException);
          blockedPayload.btcBullishBearExceptionReason = c._debugBtcBullishBearExceptionReason || null;
          blockedPayload.btcBullishBearExceptionChecks = c._debugBtcBullishBearExceptionChecks || null;
          blockedPayload.filterDiagnostics = filterDiagnostics;
          blockedPayload.filterValues = filterDiagnostics.filterValues;
          blockedPayload.filterChecks = filterDiagnostics.passMap;
          blockedPayload.liveFilterMetrics = filterDiagnostics.liveMetrics;
          blockedPayload.specialFilterChecks = filterDiagnostics.specialChecks;
          blockedPayload.rotation = rotationCheck.decision;
          blockedPayload.rotationGate = rotationCheck.decision;
          blockedPayload.rotationSide = signalForAction.rotationSide;
          blockedPayload.tradeSide = signalForAction.tradeSide;
          blockedPayload.familyIds = signalForAction.familyIds;
          blockedPayload.families = signalForAction.families;
          blockedPayload.microFamilyIds = signalForAction.microFamilyIds;
          blockedPayload.microFamilies = signalForAction.microFamilies;
          blockedPayload.familyId = signalForAction.familyId;
          blockedPayload.microFamilyId = signalForAction.microFamilyId;
          blockedPayload.rotationCandidate = signalForAction.rotationCandidate;
          blockedPayload.liveEligible = false;
          blockedPayload.shadowOnly = true;

          await logAction(blockedPayload, regimeLevel, btcState, shouldLog);
          actions.push(blockedPayload);

          console.log("TS_ENTRY_BLOCKED_BY_WEEKLY_ROTATION:", JSON.stringify({
            symbol: c.symbol,
            side: c.side,
            rotationSide: signalForAction.rotationSide,
            setupClass: setup.setupClass,
            reason: setup.entryReason,
            gateReason: rotationCheck.reason,
            rotationId: rotationCheck.decision?.activeRotationId || rotationCheck.decision?.rotationId || null,
            microFamilyId: signalForAction.microFamilyId,
            microFamilyIds: signalForAction.microFamilyIds?.slice?.(0, 5) || []
          }));

          continue;
        }

        // Gebruik het verrijkte signaal voor de verdere bouw
        Object.assign(entryPayload, signalForAction);

        position.rotation = entryPayload.rotation || rotationCheck.decision;
        position.rotationGate = rotationCheck.decision;
        position.rotationSide = entryPayload.rotationSide;
        position.tradeSide = entryPayload.tradeSide;

        position.familyIds = entryPayload.familyIds;
        position.families = entryPayload.families;
        position.microFamilyIds = entryPayload.microFamilyIds;
        position.microFamilies = entryPayload.microFamilies;
        position.familyId = entryPayload.familyId;
        position.microFamilyId = entryPayload.microFamilyId;
        position.rotationCandidate = entryPayload.rotationCandidate;

        position.liveEligible = true;
        position.shadowOnly = false;

        position.analyzerMicroFamilyId = entryPayload.analyzerMicroFamilyId || entryPayload.microFamilyId || null;
        position.parentFamilyId = entryPayload.parentFamilyId || null;
        position.analyzerParentFamilyId = entryPayload.analyzerParentFamilyId || null;
        position.analyzerDefinition = entryPayload.analyzerDefinition || null;
        position.analyzerDefinitionParts = entryPayload.analyzerDefinitionParts || null;
        position.definition = entryPayload.definition || null;
        position.definitionParts = entryPayload.definitionParts || null;
        position.spreadBps = entryPayload.spreadBps ?? null;

        memory.set(key, position);
        recordEntry(entryPayload, position);

        await logAction(entryPayload, regimeLevel, btcState, shouldLog);

        if (notifyEntries && !notifyState.get(key)) {
          const discordOk = await notifyEntrySafe({
            ...entryPayload,
            flow: position.flow,
            stage: c.stage,
            scannerStage: c.scannerStage || c.stage
          });

          if (discordOk) {
            notifyState.set(key, true);
          }
        }

        lastSignalMap.set(key, Date.now());

        actions.push(entryPayload);

        console.log("TS_ENTRY_OPENED:", JSON.stringify({
          symbol: c.symbol,
          side: c.side,
          rotationSide: entryPayload.rotationSide,
          setupClass: setup.setupClass,
          reason: setup.entryReason,
          rotationId:
            rotationCheck.decision?.activeRotationId ||
            rotationCheck.decision?.rotationId ||
            entryPayload.rotation?.activeRotationId ||
            entryPayload.rotation?.rotationId ||
            signalForAction.rotationId ||
            null,
          microFamilyId: entryPayload.microFamilyId,
          score: Number(c.moveScore || 0),
          rawConfluence,
          effectiveConfluence: confluence,
          rsiEntryEdge: rsiEdge.label,
          rsiConfluenceBoost: rsiEdge.confluenceBonus,
          rsiRrDiscount: rsiEdge.rrDiscount,
          rsiSniperDiscount: rsiEdge.sniperDiscount,
          setupEvalRR,
          rawRequiredRR,
          requiredRR,
          requiredSniper,
          finalRequiredRR,
          sniperScore: Number(sniper?.score || 0),
          baseRR: Number(baseRR.toFixed(3)),
          finalRr: Number(finalRr.toFixed(3)),
          rsiZone,
          obBias: obData?.bias || "NEUTRAL",
          spreadPct: normalizeSpread(obData?.spreadPct),
          depthMinUsd1p: Number(obData?.depthMinUsd1p || 0)
        }));
      } finally {
        processingLocks.delete(symbolLockKey);
      }
    }

    console.log("TS_ACTION_COUNTS", JSON.stringify({
      candidates: candidates.length,
      actions: actions.length,
      entries: actions.filter(a => a.action === "ENTRY").length,
      waits: actions.filter(a => a.action === "WAIT").length,
      holds: actions.filter(a => a.action === "HOLD").length,
      exits: actions.filter(a => a.action === "EXIT").length
    }));

    return await finalizeResult(actions, candidates, btcState, runId, options);
  } finally {
    try {
      const shouldSaveRuntime =
        durableRequired &&
        lockAcquired &&
        durableLoadedOk;

      if (shouldSaveRuntime) {
        const saveResult = await saveDurableRuntimeState(runtimeState, {
          strategyVersion: STRATEGY_VERSION,
          runId,
          lockAlreadyHeld: durableRequired && lockAcquired,
          lockOwner
        });

        if (!saveResult?.ok) {
          console.warn("TRADE_SYSTEM_DURABLE_SAVE_SKIPPED:", saveResult);
        }
      } else if (durableRequired && lockAcquired && !durableLoadedOk) {
        console.error("TRADE SYSTEM DURABLE SAVE SKIPPED: load did not complete");
      }
    } finally {
      if (lockAcquired) {
        await releaseRuntimeLock(lockOwner);
      }
      stopLockHeartbeat();
    }
  }
}