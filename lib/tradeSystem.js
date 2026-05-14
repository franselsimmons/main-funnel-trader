// ================= TRADESYSTEM.JS (FULLY PATCHED WITH SYMBOL ADAPTIVE PROFILES) =================

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
const STRATEGY_VERSION = "TS_V12_4_SYMBOL_ADAPTIVE";

// ================= OPTIMIZER / FEATURE FLAGS =================
const ENABLE_TS_OPTIMIZER = false;
const ENABLE_FEATURE_STORE = true;
const ENABLE_SHADOW_OUTCOMES = true;
const ENABLE_POST_EXIT_MONITOR = false;

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

// ================= CONSTANTEN (DIAGNOSTIC: RELAXED) =================
const COOLDOWN_MS = 45 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;

const MAX_SPREAD_PCT = 0.0016;
const MID_BULL_MAX_SPREAD_PCT = 0.0010;
const MIN_DEPTH_USD_1P = 100000;

const MIN_RR_FLOOR = 1.05;

const GRADE_A_MIN_RR_FLOOR = 1.10;
const GRADE_B_MIN_RR_FLOOR = 1.05;
const GRADE_C_MIN_RR_FLOOR = 1.08;

const A_ENTRY_MIN_RR = 1.10;
const B_ENTRY_MIN_RR = 1.05;
const GOD_ENTRY_MIN_RR = 1.25;

const A_MIN_SNIPER = 75;
const A_MIN_CONFLUENCE = 78;
const B_MIN_SNIPER = 68;
const B_MIN_CONFLUENCE = 68;

const GOD_MIN_SNIPER = 85;
const GOD_MIN_CONFLUENCE = 88;

const MID_RSI_MIN_CONFLUENCE = 82;
const TREND_CONTINUATION_MIN_CONFLUENCE = 75;
const TREND_CONTINUATION_MIN_SNIPER = 72;

const A_FINAL_MIN_RR = 1.12;
const A_GOD_MAX_TP_REWARD_MULTIPLIER = 1.25;

const ENABLE_B_ENTRIES = true;

const ENABLE_BULLISH_MID_TREND_PROBES = true;

const BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE = 68;
const BULLISH_MID_TREND_PROBE_MIN_SNIPER = 62;
const BULLISH_MID_TREND_PROBE_MIN_RR = 1.05;
const BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT = 0.00125;
const BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P = 40_000;

const BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH = true;

const BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT = 0.08;
const BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT = 0.80;
const BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT = 0.0010;

const MIN_DEPTH_USD_1P_ABSOLUTE = 25_000;
const A_MIN_DEPTH_USD_1P = 40_250;
const BULL_TREND_MIN_DEPTH_USD_1P = 40_000;

const REQUIRE_BULL_TREND_PULLBACK = true;
const MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT = 0.012;

const ENABLE_BTC_BULLISH_BEAR_EXCEPTION = true;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P = 100_000;
const BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT = 0.0008;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_RR = 1.25;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF = 72;
const BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF = 100;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER = 70;

const SHORT_BLOCKED_RSI_ZONES = ["LOWER_3"];

const BREAK_EVEN_TRIGGER_R = 0.65;
const BREAK_EVEN_LOCK_R = 0.03;

const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.20;

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

const MAX_FEATURE_STORE_ROWS = 20000;
const MAX_SHADOW_OUTCOME_ROWS = 12000;
const SHADOW_MONITOR_MS = 4 * 60 * 60 * 1000;
const SHADOW_MAX_MONITOR_PER_RUN = 48;
const SHADOW_PRICE_CHECK_MIN_INTERVAL_MS = 60 * 1000;

const SHADOW_DIRECTIONAL_WIN_PCT = 0.60;
const SHADOW_DIRECTIONAL_LOSS_PCT = -0.40;
const BEST_SETUP_MIN_SAMPLE_LOW = 5;
const BEST_SETUP_MIN_SAMPLE_MEDIUM = 12;
const BEST_SETUP_MIN_SAMPLE_HIGH = 30;
const BEST_SETUP_MIN_WINRATE = 0.60;
const BEST_SETUP_MIN_AVG_R = 0.20;
const BAD_SETUP_MAX_WINRATE = 0.42;
const BAD_SETUP_MAX_AVG_R = -0.15;

const FINAL_DECISION_MIN_COMPLETED = 12;
const FINAL_DECISION_TARGET_COMPLETED = 60;
const FINAL_DECISION_TOP_N = 12;

const CANDIDATE_MIN_SCORE = 45;
const BTC_BEARISH_LONG_MIN_SCORE = 68;
const BTC_NEUTRAL_MIN_SCORE = 58;
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
const GLOBAL_MIN_CONFLUENCE = 55;
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
const NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE = 86;
const NEUTRAL_OB_A_EXCEPTION_MIN_RR = 1.20;
const NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER = 82;
const NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE = 80;
const NEUTRAL_OB_B_EXCEPTION_MIN_RR = 1.15;
const NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER = 75;
const NEUTRAL_OB_B_EXCEPTION_MIN_SCORE = 78;
const SHADOW_DUPLICATE_COOLDOWN_MS = 30 * 60 * 1000;

const ENABLE_FALLBACK_RISK_GEOMETRY = true;
const DATA_FETCH_CONCURRENCY = 4;
const MIN_EXTERNAL_SCORE_HEALTH = 25;
const MIN_EXTERNAL_CONFLUENCE_HEALTH = 25;
const MIN_EXTERNAL_SNIPER_HEALTH = 30;

const MID_RSI_CONTINUATION_RR_DISCOUNT = 0.05;

// ================= V12 QUALITY GATES =================
const ENABLE_ENTRY_QUALITY_GATE_V12 = true;

const QUALITY_LOW_RR_THRESHOLD = 1.15;
const QUALITY_LOW_RR_MIN_SNIPER = 75;
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

const ENABLE_EARLY_FAILURE_EXIT = true;
const EARLY_FAILURE_MIN_AGE_SEC = 90;
const EARLY_FAILURE_MIN_MFE_R = 0.15;
const EARLY_FAILURE_MAX_MAE_R = -0.30;
const EARLY_FAILURE_MAX_CURRENT_R = -0.18;

const EARLY_OB_FLIP_MIN_AGE_SEC = 120;
const EARLY_OB_FLIP_MIN_MFE_R = 0.25;
const EARLY_OB_FLIP_MAX_CURRENT_R = -0.10;

const BREAK_EVEN_MIN_TICKS = 2;
const BREAK_EVEN_MIN_FAVORABLE_TICKS = 2;

// ================= V12 SHORT RSI TIMING GATE =================
const ENABLE_V12_SHORT_RSI_CHASE_GATE = true;

const SHORT_RSI_HARD_CHASE_MAX = 25.0;
const SHORT_RSI_SOFT_CHASE_MAX = 45.0;

const SHORT_SOFT_CHASE_MIN_SNIPER = 86;
const SHORT_SOFT_CHASE_MIN_CONFLUENCE = 95;

const SHORT_MID_HIGH_RSI_MAX = 52.0;

const SHORT_OVERBOUGHT_RSI_MIN = 62.0;
const SHORT_OVERBOUGHT_RSI_MAX = 74.0;
const SHORT_OVERBOUGHT_MIN_SNIPER = 88;
const SHORT_OVERBOUGHT_MIN_CONFLUENCE = 96;

const SHORT_OVERBOUGHT_REQUIRE_CONFIRMATION = true;

const LONG_RSI_CHASE_MIN = 58.0;
const LONG_RSI_CHASE_MIN_SNIPER = 86;
const LONG_RSI_CHASE_MIN_CONFLUENCE = 92;

// ================= V12 EXPOSURE / LOSS CIRCUIT =================
const MAX_OPEN_POSITIONS_TOTAL = 4;
const MAX_OPEN_POSITIONS_PER_SIDE = 2;

const SIDE_LOSS_THROTTLE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const SIDE_LOSS_THROTTLE_MIN_LOSSES = 1;
const SIDE_LOSS_THROTTLE_MAX_EXIT_R = -0.35;
const SIDE_LOSS_THROTTLE_ELITE_SNIPER = 92;
const SIDE_LOSS_THROTTLE_ELITE_CONFLUENCE = 98;

const ENABLE_FULL_SL_CIRCUIT_BREAKER = true;

const FULL_SL_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const FULL_SL_EXIT_R = -0.90;
const FULL_SL_BLOCK_AFTER_TOTAL = 4;
const FULL_SL_BLOCK_AFTER_SIDE = 2;

const FULL_SL_BYPASS_MIN_SNIPER = 92;
const FULL_SL_BYPASS_MIN_CONFLUENCE = 98;

// ================= V12.3 COHORT LIVE POLICY =================
const ENABLE_COHORT_LIVE_POLICY = true;

const COHORT_MIN_COMPLETED = 8;
const COHORT_REPORT_MIN_SAMPLE = 4;

const COHORT_LIVE_MIN_WINRATE = 0.52;
const COHORT_LIVE_MIN_AVG_R = 0.10;
const COHORT_LIVE_MIN_PROFIT_FACTOR_R = 1.20;
const COHORT_LIVE_MAX_DIRECT_SL_PCT = 35;

const COHORT_BLOCK_MAX_AVG_R = -0.05;
const COHORT_BLOCK_MAX_DIRECT_SL_PCT = 55;

const COHORT_COLD_START_MODE = "ELITE_ONLY";

// ================= V12.4 SYMBOL ADAPTIVE PROFILES =================
const ENABLE_SYMBOL_ADAPTIVE_PROFILES = true;

const SYMBOL_PROFILE_MIN_SYMBOL_COMPLETED = 8;
const SYMBOL_PROFILE_MIN_SIDE_COMPLETED = 5;
const SYMBOL_PROFILE_MIN_CONTEXT_COMPLETED = 4;
const SYMBOL_PROFILE_HIGH_CONFIDENCE_COMPLETED = 24;

const SYMBOL_PROFILE_REAL_WEIGHT = 1.00;
const SYMBOL_PROFILE_SHADOW_WEIGHT = 0.45;
const SYMBOL_PROFILE_SCAN_SHADOW_WEIGHT = 0.25;

const SYMBOL_PROFILE_GOOD_MIN_WINRATE = 0.58;
const SYMBOL_PROFILE_GOOD_MIN_AVG_R = 0.10;
const SYMBOL_PROFILE_GOOD_MAX_DIRECT_SL_PCT = 0.35;

const SYMBOL_PROFILE_BAD_MAX_AVG_R = -0.08;
const SYMBOL_PROFILE_BAD_MAX_WINRATE = 0.42;
const SYMBOL_PROFILE_BAD_DIRECT_SL_PCT = 0.50;

const SYMBOL_PROFILE_HARD_BLOCK_MIN_COMPLETED = 12;
const SYMBOL_PROFILE_HARD_BLOCK_MAX_AVG_R = -0.15;
const SYMBOL_PROFILE_HARD_BLOCK_DIRECT_SL_PCT = 0.60;

const SYMBOL_PROFILE_MAX_CONF_RELAX = 6;
const SYMBOL_PROFILE_MAX_CONF_TIGHTEN = 10;

const SYMBOL_PROFILE_MAX_SNIPER_RELAX = 6;
const SYMBOL_PROFILE_MAX_SNIPER_TIGHTEN = 10;

const SYMBOL_PROFILE_MAX_RR_RELAX = 0.08;
const SYMBOL_PROFILE_MAX_RR_TIGHTEN = 0.12;

const SYMBOL_PROFILE_MIN_DEPTH_FLOOR = 15_000;
const SYMBOL_PROFILE_MAX_SPREAD_CAP = 0.0024;

const SYMBOL_PROFILE_LOG_TOP_N = 20;

// ================= RISK GEOMETRY MIN RR =================
const MIN_ACCEPTABLE_PRIMARY_RR = 1.08;

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
    featureStore: [],
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

// ================= DURABLE KV / UPSTASH (CHUNKED) - same as before =================
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

    const featureStore = ENABLE_FEATURE_STORE && Array.isArray(auditState.featureStore)
      ? auditState.featureStore
      : [];

    const shadowOutcomes = ENABLE_SHADOW_OUTCOMES && Array.isArray(auditState.shadowOutcomes)
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

// ================= PATCHED validateFinalDepth (SYMBOL ADAPTIVE) =================
function validateFinalDepth(candidate) {
  const depth = Number(candidate.depthMinUsd1p ?? 0);
  const side = String(candidate.side || "").toLowerCase();
  const flow = String(candidate.flow || "").toUpperCase();
  const setupClass = String(candidate.setupClass || "").toUpperCase();

  const adaptiveMinDepthUsd1p = Number(candidate.symbolProfileMinDepthUsd1p || 0);
  const adaptiveCanRelaxDepth = Boolean(candidate.symbolProfileCanRelaxDepth);

  const absoluteFloor = adaptiveCanRelaxDepth
    ? Math.min(MIN_DEPTH_USD_1P_ABSOLUTE, SYMBOL_PROFILE_MIN_DEPTH_FLOOR)
    : MIN_DEPTH_USD_1P_ABSOLUTE;

  const bullTrendMinDepth = adaptiveCanRelaxDepth && adaptiveMinDepthUsd1p > 0
    ? Math.max(absoluteFloor, Math.min(BULL_TREND_MIN_DEPTH_USD_1P, adaptiveMinDepthUsd1p))
    : BULL_TREND_MIN_DEPTH_USD_1P;

  const aMinDepth = adaptiveCanRelaxDepth && adaptiveMinDepthUsd1p > 0
    ? Math.max(absoluteFloor, Math.min(A_MIN_DEPTH_USD_1P, adaptiveMinDepthUsd1p))
    : A_MIN_DEPTH_USD_1P;

  if (depth <= 0) {
    return { ok: false, reason: "DEPTH_MISSING_FINAL" };
  }

  if (depth < absoluteFloor) {
    return { ok: false, reason: "DEPTH_TOO_LOW_ABSOLUTE" };
  }

  if (side === "bull" && flow === "TREND" && depth < bullTrendMinDepth) {
    return {
      ok: false,
      reason: adaptiveCanRelaxDepth
        ? "SYMBOL_PROFILE_BULL_TREND_DEPTH_TOO_LOW"
        : "BULL_TREND_DEPTH_TOO_LOW"
    };
  }

  if (["A", "GOD"].includes(setupClass) && depth < aMinDepth) {
    return {
      ok: false,
      reason: adaptiveCanRelaxDepth
        ? "SYMBOL_PROFILE_A_DEPTH_TOO_LOW_FINAL"
        : "A_DEPTH_TOO_LOW_FINAL"
    };
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

    symbolProfileActive: Boolean(c._debugSymbolProfileActive),
    symbolProfileDecision: c._debugSymbolProfileDecision || null,
    symbolProfileReason: c._debugSymbolProfileReason || null,
    symbolProfileCompleted: Number(c._debugSymbolProfileCompleted || 0),
    symbolProfileSideCompleted: Number(c._debugSymbolProfileSideCompleted || 0),
    symbolProfileContextCompleted: Number(c._debugSymbolProfileContextCompleted || 0),
    symbolProfileContextKey: c._debugSymbolProfileContextKey || null,
    symbolProfileConfOffset: c._debugSymbolProfileConfOffset ?? null,
    symbolProfileSniperOffset: c._debugSymbolProfileSniperOffset ?? null,
    symbolProfileRrOffset: c._debugSymbolProfileRrOffset ?? null,

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

async function callDiscordNotifierWithRetry(kind, sender, payload, attempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await sender(payload);

      console.log(`TS_DISCORD_${kind}_RAW_RESULT:`, JSON.stringify({
        attempt,
        symbol: payload.symbol,
        side: payload.side,
        setupClass: payload.setupClass,
        result: result ?? null
      }).slice(0, 2000));

      return result;
    } catch (e) {
      lastError = e;

      console.warn(`TS_DISCORD_${kind}_RETRY_FAILED:`, JSON.stringify({
        attempt,
        symbol: payload.symbol,
        side: payload.side,
        setupClass: payload.setupClass,
        error: e.message
      }));

      if (attempt < attempts) {
        await sleep(350);
      }
    }
  }

  throw lastError || new Error(`discord_${kind.toLowerCase()}_failed`);
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
    const result = await callDiscordNotifierWithRetry("ENTRY", sendEntry, payload, 2);
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
    const result = await callDiscordNotifierWithRetry("EXIT", sendExit, payload, 2);
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

  if (process.env.TS_DEBUG_PREFILTER === "true") {
    console.log("TS_PREFILTER", JSON.stringify({
      ...prefilterStats,
      finalCandidates: candidates.length
    }));
  }

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

function applyRsiEdgeToRequiredRR(requiredRR, rsiEdge) {
  return clamp(
    Number(requiredRR || 0) - Number(rsiEdge?.rrDiscount || 0),
    0.95,
    1.70
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

// ================= FEATURE STORE / SHADOW OPTIMIZER =================
function pctText(value) {
  const n = Number(value || 0);
  return `${(n * 100).toFixed(1)}%`;
}

function parsePct(pctStr) {
  if (typeof pctStr !== "string") return 0;
  const num = parseFloat(pctStr.replace("%", ""));
  return Number.isFinite(num) ? num / 100 : 0;
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

function buildLiveCohortKey(row) {
  return [
    `SIDE=${String(row?.side || "UNKNOWN").toUpperCase()}`,
    `BTC=${String(row?.btcState || "UNKNOWN").toUpperCase()}`,
    `RSI=${String(row?.rsiZone || "UNKNOWN").toUpperCase()}`,
    `OB=${String(row?.obBias || "UNKNOWN").toUpperCase()}`,
    `FLOW=${String(row?.flow || "UNKNOWN").toUpperCase()}`,
    `SPREAD=${bucketSpreadPct(row?.spreadPct)}`,
    `DEPTH=${bucketDepthUsd(row?.depthMinUsd1p)}`
  ].join("|");
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

  enriched.liveCohortKey = buildLiveCohortKey(enriched);

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

  return enrichFeatureBuckets(row);
}

function recordScanObservation(row) {
  if (!ENABLE_FEATURE_STORE) return;
  if (!row?.symbol || !row?.side) return;

  if (!Array.isArray(auditState.featureStore)) {
    auditState.featureStore = [];
  }

  auditState.featureStore.push(row);

  if (
    ENABLE_SHADOW_OUTCOMES &&
    row.hasRiskGeometry &&
    !hasRecentShadowOutcome(row)
  ) {
    if (!Array.isArray(auditState.shadowOutcomes)) {
      auditState.shadowOutcomes = [];
    }

    auditState.shadowOutcomes.push(createShadowOutcome(row, "SCAN_SHADOW"));
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
  if (!Array.isArray(auditState.shadowOutcomes)) return;

  const now = Date.now();

  const openRows = auditState.shadowOutcomes
    .filter(row => String(row?.status || "OPEN").toUpperCase() === "OPEN")
    .filter(row => {
      const lastCheckedAt = Number(row?.lastCheckedAt || 0);
      return now - lastCheckedAt >= SHADOW_PRICE_CHECK_MIN_INTERVAL_MS;
    })
    .sort((a, b) => Number(a?.lastCheckedAt || 0) - Number(b?.lastCheckedAt || 0))
    .slice(0, SHADOW_MAX_MONITOR_PER_RUN);

  if (!openRows.length) return;

  await mapConcurrent(openRows, DATA_FETCH_CONCURRENCY, async row => {
    const symbol = normalizeBitgetSymbol(row.symbol);
    if (!symbol) return;

    let price = 0;

    try {
      const raw = await cachedFetch(
        `shadow_ob_${symbol}`,
        () => fetchOrderBook(symbol),
        12000
      );

      const analyzed = raw ? analyzeOrderBookAdvanced(raw) : null;
      price = Number(analyzed?.mid || 0);
    } catch {
      price = 0;
    }

    if (!price) {
      row.lastCheckedAt = now;
      return;
    }

    updateShadowOutcomeWithPrice(row, price);
  });

  for (const row of auditState.shadowOutcomes) {
    if (String(row?.status || "OPEN").toUpperCase() !== "OPEN") continue;
    if (now < Number(row?.monitorUntil || 0)) continue;

    const fallbackPrice = Number(row?.entry || 0);
    const r = calculateShadowR(row, fallbackPrice);
    const pnlPct = calculateShadowPnlPct(row, fallbackPrice);

    completeShadowOutcome(row, "HORIZON_DONE", fallbackPrice, r, pnlPct);
  }

  trimAuditArrays();
}

function recordActionFeatureRows(actions, btcState, runId) {
  if (!ENABLE_FEATURE_STORE) return;
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
        A_MIN_CONFLUENCE
      ),

      A_MIN_SNIPER: evaluateNumericMinOutcomeThreshold(
        aLikeRows,
        "sniperScore",
        A_MIN_SNIPER
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
        MID_RSI_MIN_CONFLUENCE
      ),

      MID_BULL_MAX_SPREAD_PCT: evaluateNumericMaxOutcomeThreshold(
        midBullRows,
        "spreadPct",
        MID_BULL_MAX_SPREAD_PCT
      ),

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

const CURRENT_FILTER_VALUES = {
  A_MIN_CONFLUENCE: A_MIN_CONFLUENCE,
  A_MIN_SNIPER: A_MIN_SNIPER,
  MID_RSI_MIN_CONFLUENCE: MID_RSI_MIN_CONFLUENCE
};

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

// ================= TS MASTER UNIVERSAL OPTIMIZER (DISABLED) =================
const TS_MASTER_MIN_SAMPLE = 12;
const TS_MASTER_MIN_CLASS_SAMPLE = 6;
const TS_MASTER_TARGET_SAMPLE = 100;
const TS_MASTER_BEAM_WIDTH = 32;
const TS_MASTER_BEAM_PASSES = 2;
const TS_MASTER_MAX_ROWS = 8000;
const TS_MASTER_OBJECTIVE = "MAX_WINRATE_AND_TOTAL_PNL_BALANCE";
const TS_MASTER_START_BALANCE_EUR = 100;
const TS_MASTER_MARGIN_PER_TRADE_EUR = 5;
const TS_MASTER_LEVERAGE = 10;

function tsRound(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function tsPct(value) {
  return `${tsRound(safeNumber(value, 0) * 100, 1)}%`;
}

function tsSum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
}

function tsAvg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return tsSum(arr) / arr.length;
}

function tsProfitFactor(rows) {
  const rValues = rows.map(row => Number(row.exitR)).filter(Number.isFinite);
  const grossWin = rValues.filter(r => r > 0).reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(rValues.filter(r => r < 0).reduce((sum, r) => sum + r, 0));
  if (!grossLoss) return grossWin > 0 ? 999 : 0;
  return grossWin / grossLoss;
}

function buildTsMoneyProjection(rows, config = {}) {
  const startBalance = safeNumber(config.startBalance, TS_MASTER_START_BALANCE_EUR);
  const marginPerTrade = safeNumber(config.marginPerTrade, TS_MASTER_MARGIN_PER_TRADE_EUR);
  const leverage = safeNumber(config.leverage, TS_MASTER_LEVERAGE);
  const notionalPerTrade = marginPerTrade * leverage;
  let balance = startBalance;
  let totalProfitEuro = 0;
  let wins = 0;
  let losses = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const pnlPct = safeNumber(row.pnlPct, 0);
    const profitEuro = notionalPerTrade * (pnlPct / 100);
    balance += profitEuro;
    totalProfitEuro += profitEuro;
    if (profitEuro > 0) wins++;
    if (profitEuro < 0) losses++;
  }
  return {
    startBalance: tsRound(startBalance, 2),
    endBalance: tsRound(balance, 2),
    profitEuro: tsRound(totalProfitEuro, 2),
    roiOnStartPct: tsRound(((balance - startBalance) / startBalance) * 100, 2),
    marginPerTrade: tsRound(marginPerTrade, 2),
    leverage,
    notionalPerTrade: tsRound(notionalPerTrade, 2),
    trades: rows.length,
    wins,
    losses,
    winrate: rows.length ? tsPct(wins / rows.length) : "0.0%"
  };
}

function buildCurrentTsMasterPreset() {
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
    SHORT_BLOCKED_RSI_ZONES: Array.from(SHORT_BLOCKED_RSI_ZONES || []),
    SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE,
    SHORT_LOWER1_CONTINUATION_MIN_SNIPER,
    SHORT_LOWER1_CONTINUATION_MIN_RR,
    SHORT_LOWER1_ALLOWED_BTC_STATES: Array.from(SHORT_LOWER1_ALLOWED_BTC_STATES || []),
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

function tsMasterFilterKeys() {
  return Object.keys(buildCurrentTsMasterPreset());
}

function isTsAOnlyKey(key) {
  return (key.startsWith("A_") || key.startsWith("GOD_") || key.startsWith("NEUTRAL_OB_A_") ||
    key === "SETUP_GRADE_A_MIN_POINTS" || key === "A_MIN_DEPTH_USD_1P" || key === "A_GOD_MAX_TP_REWARD_MULTIPLIER");
}

function isTsBOnlyKey(key) {
  return (key.startsWith("B_") || key.startsWith("NEUTRAL_OB_B_") || key === "ENABLE_B_ENTRIES" ||
    key === "SETUP_GRADE_B_MIN_POINTS" || key.startsWith("BULLISH_MID_TREND_PROBE_") || key === "ENABLE_BULLISH_MID_TREND_PROBES");
}

function getTsOptimizationKeys(target) {
  const keys = tsMasterFilterKeys();
  if (target === "A") return keys.filter(key => !isTsBOnlyKey(key));
  if (target === "B") return keys.filter(key => !isTsAOnlyKey(key));
  return keys;
}

function stableTsPresetKey(preset) {
  return JSON.stringify(Object.keys(preset).sort().reduce((out, key) => { out[key] = preset[key]; return out; }, {}));
}

function uniqueTsValues(values) {
  const map = new Map();
  for (const value of values) map.set(JSON.stringify(value), value);
  return Array.from(map.values());
}

function tsCandidateValues(key, currentValue, target) {
  if (typeof currentValue === "boolean") return [currentValue, !currentValue];
  if (Array.isArray(currentValue)) {
    if (key === "SHORT_BLOCKED_RSI_ZONES") return [currentValue, [], ["LOWER_3"], ["LOWER_2", "LOWER_3"], ["LOWER_1", "LOWER_2", "LOWER_3"]];
    if (key === "SHORT_LOWER1_ALLOWED_BTC_STATES") return [currentValue, ["BEARISH", "STRONG_BEAR", "NEUTRAL"], ["BEARISH", "STRONG_BEAR"], ["NEUTRAL"], []];
    return [currentValue];
  }
  const v = Number(currentValue);
  if (!Number.isFinite(v)) return [currentValue];
  if (key.includes("SPREAD")) return uniqueTsValues([Number((v * 0.75).toFixed(6)), Number((v * 0.90).toFixed(6)), Number(v.toFixed(6)), Number((v * 1.10).toFixed(6)), Number((v * 1.25).toFixed(6))]).filter(n => n > 0);
  if (key.includes("DEPTH")) return uniqueTsValues([Math.max(10000, Math.round(v * 0.70)), Math.max(10000, Math.round(v * 0.85)), Math.round(v), Math.round(v * 1.15), Math.round(v * 1.35)]);
  if (key.includes("RR") || key.includes("TRIGGER_R") || key.includes("LOCK_R")) return uniqueTsValues([Number((v - 0.20).toFixed(2)), Number((v - 0.10).toFixed(2)), Number(v.toFixed(2)), Number((v + 0.10).toFixed(2)), Number((v + 0.20).toFixed(2))]).filter(n => n >= 0);
  if (key.includes("CONFLUENCE") || key.includes("SNIPER") || key.includes("SCORE") || key.includes("POINTS")) return uniqueTsValues([Math.max(0, Math.round(v - 8)), Math.max(0, Math.round(v - 4)), Math.round(v), Math.round(v + 4), Math.round(v + 8)]);
  if (key.includes("MOVE") || key.includes("CHANGE") || key.includes("DISTANCE") || key.includes("PULLBACK")) return uniqueTsValues([Number((v - 0.20).toFixed(4)), Number((v - 0.10).toFixed(4)), Number(v.toFixed(4)), Number((v + 0.10).toFixed(4)), Number((v + 0.20).toFixed(4))]);
  if (key.includes("FUNDING")) return uniqueTsValues([Number((v * 0.75).toFixed(4)), Number(v.toFixed(4)), Number((v * 1.25).toFixed(4))]);
  return uniqueTsValues([Number((v * 0.85).toFixed(4)), Number(v.toFixed(4)), Number((v * 1.15).toFixed(4))]);
}

function normalizeFlow(flow) {
  const f = String(flow || "").toUpperCase();
  if (["TREND", "BREAKOUT", "RUNNING"].includes(f)) return "TREND";
  if (["BUILDING", "BUILDUP"].includes(f)) return "BUILDING";
  return "NEUTRAL";
}

function normalizeSide(side) {
  const s = String(side || "").toLowerCase();
  return s === "bull" || s === "bear" ? s : "unknown";
}

function isCompletedTsOutcomeRow(row) {
  if (!row) return false;
  const exitR = Number(row.exitR);
  const pnlPct = Number(row.pnlPct);
  if (!Number.isFinite(exitR)) return false;
  if (!Number.isFinite(pnlPct)) return false;
  if (safeNumber(row.entry, 0) <= 0) return false;
  if (safeNumber(row.sl || row.initialSl, 0) <= 0) return false;
  if (safeNumber(row.tp, 0) <= 0) return false;
  return true;
}

function normalizeTsOptimizerRow(row, source = "UNKNOWN") {
  const exitR = Number(row?.exitR);
  const pnlPct = Number(row?.pnlPct);
  return {
    source: String(row?.source || source).toUpperCase(),
    symbol: normalizeBaseSymbol(row?.symbol),
    side: normalizeSide(row?.side),
    stage: String(row?.stage || "entry").toLowerCase(),
    score: safeNumber(row?.score ?? row?.moveScore, 0),
    confluence: safeNumber(row?.confluence, 0),
    sniperScore: safeNumber(row?.sniperScore ?? row?.sniper, 0),
    rr: safeNumber(row?.rr || row?.plannedRR || row?.baseRR || row?.targetR, 0),
    plannedRR: safeNumber(row?.plannedRR || row?.rr || row?.baseRR || row?.targetR, 0),
    baseRR: safeNumber(row?.baseRR || row?.rr || row?.plannedRR, 0),
    entry: safeNumber(row?.entry, 0),
    sl: safeNumber(row?.sl || row?.initialSl, 0),
    initialSl: safeNumber(row?.initialSl || row?.sl, 0),
    tp: safeNumber(row?.tp, 0),
    exit: safeNumber(row?.exit, 0),
    exitR: Number.isFinite(exitR) ? exitR : null,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
    mfeR: safeNumber(row?.mfeR, 0),
    maeR: safeNumber(row?.maeR, 0),
    flow: normalizeFlow(row?.flow || row?.detectedFlow || row?.scannerFlow),
    scannerFlow: normalizeFlow(row?.scannerFlow || row?.flow || row?.detectedFlow),
    rsi: Number.isFinite(Number(row?.rsi)) ? Number(row.rsi) : null,
    rsiZone: String(row?.rsiZone || "UNKNOWN").toUpperCase(),
    obBias: String(row?.obBias || "UNKNOWN").toUpperCase(),
    marketQuality: String(row?.marketQuality || "UNKNOWN").toUpperCase(),
    spreadPct: normalizeSpread(row?.spreadPct),
    depthMinUsd1p: safeNumber(row?.depthMinUsd1p, 0),
    funding: safeNumber(row?.funding, 0),
    tfStrength: safeNumber(row?.tfStrength, 0),
    tfScore: safeNumber(row?.tfScore, 0),
    change1h: safeNumber(row?.change1h, 0),
    change24: safeNumber(row?.change24, 0),
    distanceFromLocalHighPct: safeNumber(row?.distanceFromLocalHighPct ?? row?.bullDistanceFromLocalHighPct ?? row?.distanceHighPct, 0),
    pullbackFromHighPct: safeNumber(row?.pullbackFromHighPct ?? row?.bullPullbackFromHighPct ?? row?.pullbackPct, 0),
    runnerPressure: safeNumber(row?.runnerPressure, 0),
    runnerAcceleration: safeNumber(row?.runnerAcceleration, 0),
    btcState: String(row?.btcState || "UNKNOWN").toUpperCase(),
    volatility: String(row?.volatility || "UNKNOWN").toUpperCase(),
    regime: String(row?.regime || "UNKNOWN").toUpperCase(),
    rsiValid: row?.rsiValid !== false,
    rsiBlocked: Boolean(row?.rsiBlocked),
    rsiContinuationAllowed: Boolean(row?.rsiContinuationAllowed),
    rsiPullbackAllowed: Boolean(row?.rsiPullbackAllowed),
    rsiExhaustedAgainstSide: Boolean(row?.rsiExhaustedAgainstSide),
    structureAligned: row?.structureAligned !== false,
    obFetchFailed: Boolean(row?.obFetchFailed),
    spoof: Boolean(row?.spoof),
    obAgainst: Boolean(row?.obAgainst),
    liveEligible: Boolean(row?.liveEligible),
    shadowOnly: Boolean(row?.shadowOnly),
    scannerHot: Boolean(row?.scannerHot),
    oldReason: String(row?.reason || "UNKNOWN").toUpperCase(),
    oldSetupClass: String(row?.setupClass || "UNKNOWN").toUpperCase(),
    oldEntryType: String(row?.entryType || row?.runnerEntryType || "UNKNOWN").toUpperCase(),
    ts: safeNumber(row?.ts || row?.createdAt || row?.completedAt || Date.now(), Date.now())
  };
}

function buildTsOptimizerUniverse() {
  const realRows = (auditState.closedTrades || [])
    .map(row => normalizeTsOptimizerRow(row, "REAL"))
    .filter(isCompletedTsOutcomeRow);
  const shadowRows = (auditState.shadowOutcomes || [])
    .filter(row => row?.status && String(row.status).toUpperCase() !== "OPEN")
    .map(row => normalizeTsOptimizerRow(row, row?.source || "SHADOW"))
    .filter(isCompletedTsOutcomeRow);
  return [...realRows, ...shadowRows]
    .filter(row => row.symbol)
    .filter(row => row.score > 0)
    .filter(row => row.confluence >= 0)
    .filter(row => row.sniperScore >= 0)
    .sort((a, b) => safeNumber(a.ts, 0) - safeNumber(b.ts, 0))
    .slice(-TS_MASTER_MAX_ROWS);
}

function inferTsSetupFromPreset(row, preset) {
  const rr = safeNumber(row.plannedRR || row.rr, 0);
  const conf = safeNumber(row.confluence, 0);
  const sniper = safeNumber(row.sniperScore, 0);
  const score = safeNumber(row.score, 0);
  const isGod = rr >= safeNumber(preset.GOD_ENTRY_MIN_RR, 0) && sniper >= safeNumber(preset.GOD_MIN_SNIPER, 0) && conf >= safeNumber(preset.GOD_MIN_CONFLUENCE, 0);
  if (isGod) return { setupClass: "GOD", liveGrade: "A", entryType: "GOD_ENTRY" };
  const isA = rr >= Math.max(safeNumber(preset.A_ENTRY_MIN_RR, 0), safeNumber(preset.A_FINAL_MIN_RR, 0)) &&
    sniper >= safeNumber(preset.A_MIN_SNIPER, 0) && conf >= safeNumber(preset.A_MIN_CONFLUENCE, 0);
  if (isA) return { setupClass: "A", liveGrade: "A", entryType: "A_ENTRY" };
  const isBullishMidTrendProbe = preset.ENABLE_BULLISH_MID_TREND_PROBES === true && row.side === "bull" && row.rsiZone === "MID" &&
    (!preset.BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH || ["BULLISH", "STRONG_BULL"].includes(row.btcState)) &&
    conf >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE, 0) &&
    sniper >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_SNIPER, 0) &&
    rr >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_RR, 0) &&
    row.spreadPct <= safeNumber(preset.BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT, 1) &&
    row.depthMinUsd1p >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P, 0) &&
    row.change1h >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT, 0) &&
    row.change24 >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT, 0) &&
    row.pullbackFromHighPct >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT, 0);
  if (isBullishMidTrendProbe) return { setupClass: "BULLISH_MID_TREND_PROBE", liveGrade: "B", entryType: "BULLISH_MID_TREND_PROBE" };
  const isB = preset.ENABLE_B_ENTRIES !== false &&
    rr >= safeNumber(preset.B_ENTRY_MIN_RR, 0) &&
    sniper >= safeNumber(preset.B_MIN_SNIPER, 0) &&
    conf >= safeNumber(preset.B_MIN_CONFLUENCE, 0);
  if (isB) return { setupClass: "B", liveGrade: "B", entryType: "B_ENTRY" };
  const btcBullishBearException = preset.ENABLE_BTC_BULLISH_BEAR_EXCEPTION === true && row.side === "bear" &&
    ["BULLISH", "STRONG_BULL"].includes(row.btcState) &&
    row.depthMinUsd1p >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P, 0) &&
    row.spreadPct <= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT, 1) &&
    rr >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_RR, 0) &&
    conf >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF, 0) &&
    conf <= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF, 1000) &&
    sniper >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER, 0);
  if (btcBullishBearException) return { setupClass: "BTC_BULLISH_BEAR_EXCEPTION", liveGrade: "B", entryType: "BTC_BULLISH_BEAR_EXCEPTION" };
  return { setupClass: "NONE", liveGrade: "NONE", entryType: "NONE" };
}

function tsRowPassesBasePreset(row, preset) {
  if (!row) return false;
  if (row.obFetchFailed) return false;
  if (row.spoof) return false;
  let minScore = safeNumber(preset.CANDIDATE_MIN_SCORE, 0);
  if (row.side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(row.btcState)) minScore = Math.max(minScore, safeNumber(preset.BTC_BEARISH_LONG_MIN_SCORE, 0));
  if (row.btcState === "NEUTRAL") minScore = Math.max(minScore, safeNumber(preset.BTC_NEUTRAL_MIN_SCORE, 0));
  if (row.score < minScore) return false;
  if (row.tfStrength < safeNumber(preset.TF_MIN_STRENGTH, 0)) return false;
  if (row.confluence < safeNumber(preset.GLOBAL_MIN_CONFLUENCE, 0)) return false;
  if (row.volatility === "LOW" && row.confluence < safeNumber(preset.LOW_VOL_MIN_CONFLUENCE, 0)) return false;
  if (["NEUTRAL", "UNKNOWN", "NO_FLOW"].includes(row.flow) && row.confluence < safeNumber(preset.NO_FLOW_MIN_CONFLUENCE, 0)) return false;
  const rr = safeNumber(row.plannedRR || row.rr, 0);
  if (rr < safeNumber(preset.MIN_RR_FLOOR, 0)) return false;
  if (["BUILDING", "BUILDUP"].includes(row.flow) && rr < safeNumber(preset.BUILDUP_MIN_RR_FLOOR, 0)) return false;
  if (!row.structureAligned && rr < safeNumber(preset.COUNTERTREND_MIN_RR_FLOOR, 0)) return false;
  if (row.marketQuality === "BAD" && row.confluence < safeNumber(preset.BAD_MARKET_QUALITY_MIN_CONFLUENCE, 0)) return false;
  if (row.obAgainst && row.confluence < safeNumber(preset.OB_AGAINST_MIN_CONFLUENCE, 0)) return false;
  if (Math.abs(row.funding) > safeNumber(preset.EXTREME_FUNDING_ABS_MAX, 1)) return false;
  if (row.side === "bull" && row.funding > safeNumber(preset.BULL_CROWDED_FUNDING_MAX, 1) && row.confluence < safeNumber(preset.CROWDED_FUNDING_MIN_CONFLUENCE, 0)) return false;
  if (row.side === "bear" && row.funding < safeNumber(preset.BEAR_CROWDED_FUNDING_MIN, -1) && row.confluence < safeNumber(preset.CROWDED_FUNDING_MIN_CONFLUENCE, 0)) return false;
  if (!row.rsiValid) return false;
  if (row.rsiBlocked) return false;
  if (row.rsiExhaustedAgainstSide) return false;
  function listIncludes(list, value) { const v = String(value || "").toUpperCase(); if (Array.isArray(list)) return list.some(item => String(item || "").toUpperCase() === v); if (list instanceof Set) return list.has(v); return false; }
  if (row.side === "bear" && Array.isArray(preset.SHORT_BLOCKED_RSI_ZONES) && listIncludes(preset.SHORT_BLOCKED_RSI_ZONES, row.rsiZone)) return false;
  if (row.side === "bear" && row.rsiZone === "LOWER_1" && !listIncludes(preset.SHORT_LOWER1_ALLOWED_BTC_STATES, row.btcState)) return false;
  if (row.side === "bear" && row.rsiZone === "LOWER_1" && (row.confluence < safeNumber(preset.SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE, 0) || row.sniperScore < safeNumber(preset.SHORT_LOWER1_CONTINUATION_MIN_SNIPER, 0) || rr < safeNumber(preset.SHORT_LOWER1_CONTINUATION_MIN_RR, 0))) return false;
  if (row.side === "bull" && row.rsiZone === "LOWER_2" && row.change1h > safeNumber(preset.LONG_LOWER2_MAX_1H_CHANGE, 0)) return false;
  if (row.side === "bear" && row.rsiZone === "UPPER_2" && row.change1h < safeNumber(preset.SHORT_UPPER2_MIN_1H_CHANGE, 0)) return false;
  if (row.flow === "TREND" && (row.confluence < safeNumber(preset.TREND_CONTINUATION_MIN_CONFLUENCE, 0) || row.sniperScore < safeNumber(preset.TREND_CONTINUATION_MIN_SNIPER, 0) || rr < safeNumber(preset.TREND_CONTINUATION_MIN_RR, 0))) return false;
  const maxSpread = (row.side === "bull" && row.rsiZone === "MID") ? safeNumber(preset.MID_BULL_MAX_SPREAD_PCT, preset.MAX_SPREAD_PCT) : safeNumber(preset.MAX_SPREAD_PCT, 1);
  if (row.spreadPct > maxSpread) {
    const midBullSpreadException = row.side === "bull" && row.rsiZone === "MID" && row.confluence >= safeNumber(preset.MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE, 0) && row.sniperScore >= safeNumber(preset.MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER, 0);
    if (!midBullSpreadException) return false;
  }
  if (row.depthMinUsd1p > 0 && row.depthMinUsd1p < safeNumber(preset.MIN_DEPTH_USD_1P_ABSOLUTE, 0)) return false;
  if (row.depthMinUsd1p > 0 && row.depthMinUsd1p < safeNumber(preset.MIN_DEPTH_USD_1P, 0)) {
    const aDepthException = row.depthMinUsd1p >= safeNumber(preset.A_MIN_DEPTH_USD_1P, 0) && row.confluence >= safeNumber(preset.A_MIN_CONFLUENCE, 0) && row.sniperScore >= safeNumber(preset.A_MIN_SNIPER, 0);
    if (!aDepthException) return false;
  }
  if (row.side === "bull" && ["TREND", "RUNNING", "BREAKOUT"].includes(row.flow) && row.depthMinUsd1p > 0 && row.depthMinUsd1p < safeNumber(preset.BULL_TREND_MIN_DEPTH_USD_1P, 0)) return false;
  if (preset.REQUIRE_BULL_TREND_PULLBACK === true && row.side === "bull" && ["TREND", "RUNNING", "BREAKOUT"].includes(row.flow) && row.distanceFromLocalHighPct > safeNumber(preset.MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT, 1)) return false;
  if (row.rsiZone === "MID" && row.confluence < safeNumber(preset.MID_RSI_MIN_CONFLUENCE, 0)) return false;
  return true;
}

function wouldTsEnterUnderPreset(row, preset) {
  if (!tsRowPassesBasePreset(row, preset)) return false;
  const inferred = inferTsSetupFromPreset(row, preset);
  if (inferred.setupClass === "NONE") return false;
  const rr = safeNumber(row.plannedRR || row.rr, 0);
  if (inferred.liveGrade === "A" && rr < safeNumber(preset.GRADE_A_MIN_RR_FLOOR, 0)) return false;
  if (inferred.liveGrade === "B" && rr < safeNumber(preset.GRADE_B_MIN_RR_FLOOR, 0)) return false;
  if (row.obBias === "NEUTRAL" && inferred.liveGrade === "A") {
    if (row.confluence < safeNumber(preset.NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE, 0)) return false;
    if (row.sniperScore < safeNumber(preset.NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER, 0)) return false;
    if (rr < safeNumber(preset.NEUTRAL_OB_A_EXCEPTION_MIN_RR, 0)) return false;
  }
  if (row.obBias === "NEUTRAL" && inferred.liveGrade === "B") {
    if (row.confluence < safeNumber(preset.NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE, 0)) return false;
    if (row.sniperScore < safeNumber(preset.NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER, 0)) return false;
    if (row.score < safeNumber(preset.NEUTRAL_OB_B_EXCEPTION_MIN_SCORE, 0)) return false;
    if (rr < safeNumber(preset.NEUTRAL_OB_B_EXCEPTION_MIN_RR, 0)) return false;
  }
  return true;
}

function evaluateTsPresetOnAllCoins(rows, preset, target = "COMBINED") {
  const kept = [];
  for (const row of rows) {
    if (!wouldTsEnterUnderPreset(row, preset)) continue;
    const inferred = inferTsSetupFromPreset(row, preset);
    if (target === "A" && inferred.liveGrade !== "A") continue;
    if (target === "B" && inferred.liveGrade !== "B") continue;
    kept.push({ ...row, inferredSetupClass: inferred.setupClass, inferredEntryType: inferred.entryType, inferredLiveGrade: inferred.liveGrade });
  }
  const wins = kept.filter(row => safeNumber(row.exitR, 0) > 0).length;
  const losses = kept.filter(row => safeNumber(row.exitR, 0) < 0).length;
  const completed = wins + losses;
  const flats = kept.length - completed;
  const totalR = tsSum(kept.map(row => row.exitR));
  const totalPnlPct = tsSum(kept.map(row => row.pnlPct));
  const winrateNum = completed ? wins / completed : 0;
  const avgR = completed ? totalR / completed : 0;
  const avgPnlPct = completed ? totalPnlPct / completed : 0;
  const directSL = kept.filter(row => safeNumber(row.exitR, 0) < 0 && safeNumber(row.mfeR, 0) < 0.25).length;
  const nearTpThenLoss = kept.filter(row => safeNumber(row.exitR, 0) < 0 && safeNumber(row.plannedRR, 0) > 0 && safeNumber(row.mfeR, 0) >= safeNumber(row.plannedRR, 0) * 0.80).length;
  const keepRatio = rows.length ? kept.length / rows.length : 0;
  const directSLPctNum = completed ? directSL / completed : 0;
  const nearTpThenLossPctNum = completed ? nearTpThenLoss / completed : 0;
  const profitFactorR = tsProfitFactor(kept);
  const setupClassCounts = kept.reduce((acc, row) => { const key = row.inferredSetupClass || "UNKNOWN"; acc[key] = safeNumber(acc[key], 0) + 1; return acc; }, {});
  const sourceCounts = kept.reduce((acc, row) => { const key = row.source || "UNKNOWN"; acc[key] = safeNumber(acc[key], 0) + 1; return acc; }, {});
  const moneyProjection = buildTsMoneyProjection(kept, { startBalance: TS_MASTER_START_BALANCE_EUR, marginPerTrade: TS_MASTER_MARGIN_PER_TRADE_EUR, leverage: TS_MASTER_LEVERAGE });
  const statsRow = {
    filters: preset, target, universeRows: rows.length, kept: kept.length, rejected: rows.length - kept.length, keepRatio: tsRound(keepRatio, 4),
    completed, wins, losses, flats, winrate: tsPct(winrateNum), winrateNum: tsRound(winrateNum, 4),
    totalR: tsRound(totalR, 3), avgR: tsRound(avgR, 3), totalPnlPct: tsRound(totalPnlPct, 3), avgPnlPct: tsRound(avgPnlPct, 3),
    profitFactorR: tsRound(profitFactorR, 3), directSL, directSLPctNum: tsRound(directSLPctNum, 4), directSLPct: tsPct(directSLPctNum),
    nearTpThenLoss, nearTpThenLossPctNum: tsRound(nearTpThenLossPctNum, 4), nearTpThenLossPct: tsPct(nearTpThenLossPctNum),
    setupClassCounts, sourceCounts, moneyProjection, examples: kept.slice(-12).map(row => ({
      source: row.source, symbol: row.symbol, side: row.side, oldReason: row.oldReason, oldSetupClass: row.oldSetupClass, oldEntryType: row.oldEntryType,
      inferredSetupClass: row.inferredSetupClass, inferredEntryType: row.inferredEntryType, inferredLiveGrade: row.inferredLiveGrade,
      flow: row.flow, scannerFlow: row.scannerFlow, rsiZone: row.rsiZone, obBias: row.obBias, score: row.score, confluence: row.confluence,
      sniperScore: row.sniperScore, rr: row.plannedRR, spreadPct: row.spreadPct, depthMinUsd1p: row.depthMinUsd1p,
      change1h: row.change1h, change24: row.change24, exitR: row.exitR, pnlPct: row.pnlPct, mfeR: row.mfeR, maeR: row.maeR
    }))
  };
  return { ...statsRow, decisionScore: scoreTsMasterStats(statsRow, keepRatio) };
}

function scoreTsMasterStats(row, keepRatio) {
  const completed = safeNumber(row.completed, 0);
  if (completed <= 0) return -999999;
  const winrate = safeNumber(row.winrateNum, 0);
  const totalPnlPct = safeNumber(row.totalPnlPct, 0);
  const avgPnlPct = safeNumber(row.avgPnlPct, 0);
  const totalR = safeNumber(row.totalR, 0);
  const avgR = safeNumber(row.avgR, 0);
  const profitFactor = clamp(safeNumber(row.profitFactorR, 0), 0, 5);
  const directSLPct = safeNumber(row.directSLPctNum, 0);
  const nearTpThenLossPct = safeNumber(row.nearTpThenLossPctNum, 0);
  const sampleConfidence = clamp(completed / TS_MASTER_TARGET_SAMPLE, 0.15, 1);
  const raw = winrate * 70 + totalPnlPct * 2.4 + avgPnlPct * 28 + totalR * 1.8 + avgR * 35 + profitFactor * 12 + keepRatio * 7 - directSLPct * 65 - nearTpThenLossPct * 25;
  return tsRound(raw * sampleConfidence, 4);
}

function buildTsMasterSeedPresets(current, target) {
  const base = { ...current };
  const discovery = { ...base,
    CANDIDATE_MIN_SCORE: Math.min(base.CANDIDATE_MIN_SCORE, 45),
    BTC_BEARISH_LONG_MIN_SCORE: Math.min(base.BTC_BEARISH_LONG_MIN_SCORE, 68),
    BTC_NEUTRAL_MIN_SCORE: Math.min(base.BTC_NEUTRAL_MIN_SCORE, 58),
    GLOBAL_MIN_CONFLUENCE: Math.min(base.GLOBAL_MIN_CONFLUENCE, 55),
    MID_RSI_MIN_CONFLUENCE: Math.min(base.MID_RSI_MIN_CONFLUENCE, 58),
    TREND_CONTINUATION_MIN_CONFLUENCE: Math.min(base.TREND_CONTINUATION_MIN_CONFLUENCE, 58),
    A_MIN_CONFLUENCE: Math.min(base.A_MIN_CONFLUENCE, 60),
    A_MIN_SNIPER: Math.min(base.A_MIN_SNIPER, 48),
    A_ENTRY_MIN_RR: Math.min(base.A_ENTRY_MIN_RR, 1.05),
    A_FINAL_MIN_RR: Math.min(base.A_FINAL_MIN_RR, 1.15),
    B_MIN_CONFLUENCE: Math.min(base.B_MIN_CONFLUENCE, 62),
    B_MIN_SNIPER: Math.min(base.B_MIN_SNIPER, 52),
    B_ENTRY_MIN_RR: Math.min(base.B_ENTRY_MIN_RR, 1.00),
    ENABLE_B_ENTRIES: true,
    GOD_ENTRY_MIN_RR: Math.min(base.GOD_ENTRY_MIN_RR, 1.25),
    GOD_MIN_SNIPER: Math.min(base.GOD_MIN_SNIPER, 75),
    GOD_MIN_CONFLUENCE: Math.min(base.GOD_MIN_CONFLUENCE, 75),
    MAX_SPREAD_PCT: Math.max(base.MAX_SPREAD_PCT, 0.0022),
    MID_BULL_MAX_SPREAD_PCT: Math.max(base.MID_BULL_MAX_SPREAD_PCT, 0.0014),
    MIN_DEPTH_USD_1P: Math.min(base.MIN_DEPTH_USD_1P, 100000),
    MIN_DEPTH_USD_1P_ABSOLUTE: Math.min(base.MIN_DEPTH_USD_1P_ABSOLUTE, 15000),
    A_MIN_DEPTH_USD_1P: Math.min(base.A_MIN_DEPTH_USD_1P, 35000),
    BULL_TREND_MIN_DEPTH_USD_1P: Math.min(base.BULL_TREND_MIN_DEPTH_USD_1P, 70000),
    SHORT_BLOCKED_RSI_ZONES: ["LOWER_3"]
  };
  const quality = { ...base,
    CANDIDATE_MIN_SCORE: base.CANDIDATE_MIN_SCORE + 4,
    GLOBAL_MIN_CONFLUENCE: base.GLOBAL_MIN_CONFLUENCE + 4,
    A_MIN_CONFLUENCE: base.A_MIN_CONFLUENCE + 4,
    A_MIN_SNIPER: base.A_MIN_SNIPER + 4,
    B_MIN_CONFLUENCE: base.B_MIN_CONFLUENCE + 4,
    B_MIN_SNIPER: base.B_MIN_SNIPER + 4,
    MAX_SPREAD_PCT: Number((base.MAX_SPREAD_PCT * 0.85).toFixed(6)),
    MID_BULL_MAX_SPREAD_PCT: Number((base.MID_BULL_MAX_SPREAD_PCT * 0.85).toFixed(6)),
    MIN_DEPTH_USD_1P: Math.round(base.MIN_DEPTH_USD_1P * 1.20)
  };
  const winrate = { ...quality,
    GLOBAL_MIN_CONFLUENCE: quality.GLOBAL_MIN_CONFLUENCE + 2,
    A_MIN_CONFLUENCE: quality.A_MIN_CONFLUENCE + 2,
    B_MIN_CONFLUENCE: quality.B_MIN_CONFLUENCE + 2,
    DIRECT_SL_AVOIDANCE_MODE: true
  };
  if (target === "B") return [base, discovery, { ...discovery, ENABLE_B_ENTRIES: true, B_MIN_CONFLUENCE: Math.min(discovery.B_MIN_CONFLUENCE, 58), B_MIN_SNIPER: Math.min(discovery.B_MIN_SNIPER, 48) }];
  return [base, discovery, quality, winrate];
}

function scoreTsEvalForSearch(result, minCompleted) {
  const completed = safeNumber(result?.completed, 0);
  const missingSamplePenalty = Math.max(0, minCompleted - completed) * 40;
  const zeroPenalty = completed === 0 ? 100000 : 0;
  return safeNumber(result?.decisionScore, -999999) - missingSamplePenalty - zeroPenalty;
}

function optimizeTsMasterTarget(rows, target) {
  const currentPreset = buildCurrentTsMasterPreset();
  const currentEval = evaluateTsPresetOnAllCoins(rows, currentPreset, target);
  const minCompleted = target === "COMBINED" ? TS_MASTER_MIN_SAMPLE : TS_MASTER_MIN_CLASS_SAMPLE;
  if (rows.length < minCompleted) {
    return { target, decision: "SAMPLE_TOO_SMALL_KEEP_CURRENT", sample: { usableRows: rows.length, completed: currentEval.completed, minRequired: minCompleted, confidence: "LOW" },
      current: currentEval, best: currentEval, deltaVsCurrent: buildTsDelta(currentEval, currentEval), changedKeys: [], coverageOk: true, missingFilters: [] };
  }
  const optimizationKeys = getTsOptimizationKeys(target);
  let beam = buildTsMasterSeedPresets(currentPreset, target);
  for (let pass = 0; pass < TS_MASTER_BEAM_PASSES + 1; pass++) {
    const candidateMap = new Map();
    for (const preset of beam) {
      candidateMap.set(stableTsPresetKey(preset), preset);
      for (const key of optimizationKeys) {
        const values = tsCandidateValues(key, preset[key], target);
        for (const value of values) {
          const next = { ...preset, [key]: value };
          candidateMap.set(stableTsPresetKey(next), next);
        }
      }
    }
    const evaluated = Array.from(candidateMap.values()).map(preset => evaluateTsPresetOnAllCoins(rows, preset, target))
      .sort((a, b) => scoreTsEvalForSearch(b, minCompleted) - scoreTsEvalForSearch(a, minCompleted));
    if (!evaluated.length) break;
    beam = evaluated.slice(0, TS_MASTER_BEAM_WIDTH).map(result => result.filters);
  }
  const finalEvaluated = beam.map(preset => evaluateTsPresetOnAllCoins(rows, preset, target))
    .sort((a, b) => scoreTsEvalForSearch(b, minCompleted) - scoreTsEvalForSearch(a, minCompleted));
  const validEvaluated = finalEvaluated.filter(result => result.completed >= minCompleted && result.totalR > 0 && result.totalPnlPct > 0).sort((a, b) => b.decisionScore - a.decisionScore);
  const best = validEvaluated[0] || finalEvaluated[0] || currentEval;
  const changedKeys = tsMasterFilterKeys().filter(key => JSON.stringify(best.filters[key]) !== JSON.stringify(currentPreset[key]))
    .map(key => ({ parameter: key, currentValue: currentPreset[key], suggestedValue: best.filters[key] }));
  const missingFilters = tsMasterFilterKeys().filter(key => !Object.prototype.hasOwnProperty.call(best.filters, key));
  return { target, decision: missingFilters.length ? "BEST_PRESET_FOUND_BUT_FILTER_COVERAGE_INCOMPLETE" : (best.completed >= minCompleted && best.totalR > 0 && best.totalPnlPct > 0 ? `BEST_TS_${target}_WINRATE_PNL_AFSTELLING` : `BEST_TS_${target}_LOW_SAMPLE_OR_NO_EDGE_AFSTELLING`),
    sample: { usableRows: rows.length, completed: best.completed, minRequired: minCompleted, confidence: best.completed >= 100 ? "HIGH" : best.completed >= 40 ? "MEDIUM" : best.completed >= minCompleted ? "LOW" : "VERY_LOW" },
    current: currentEval, best, deltaVsCurrent: buildTsDelta(best, currentEval), changedKeys, coverageOk: missingFilters.length === 0, missingFilters };
}

function buildTsDelta(best, current) {
  return {
    totalPnlPctDelta: tsRound(safeNumber(best.totalPnlPct, 0) - safeNumber(current.totalPnlPct, 0), 3),
    totalRDelta: tsRound(safeNumber(best.totalR, 0) - safeNumber(current.totalR, 0), 3),
    avgRDelta: tsRound(safeNumber(best.avgR, 0) - safeNumber(current.avgR, 0), 3),
    avgPnlPctDelta: tsRound(safeNumber(best.avgPnlPct, 0) - safeNumber(current.avgPnlPct, 0), 3),
    winrateDeltaPct: tsRound((safeNumber(best.winrateNum, 0) - safeNumber(current.winrateNum, 0)) * 100, 2),
    profitFactorDelta: tsRound(safeNumber(best.profitFactorR, 0) - safeNumber(current.profitFactorR, 0), 3),
    decisionScoreDelta: tsRound(safeNumber(best.decisionScore, 0) - safeNumber(current.decisionScore, 0), 3)
  };
}

function mergeTsRecommendedLiveAfstelling({ combined, bestA, bestB }) {
  const current = buildCurrentTsMasterPreset();
  const combinedPreset = combined?.best?.filters || current;
  const aPreset = bestA?.best?.filters || current;
  const bPreset = bestB?.best?.filters || current;
  const merged = { ...current, ...combinedPreset };
  for (const key of tsMasterFilterKeys()) {
    if (isTsAOnlyKey(key)) { merged[key] = aPreset[key]; continue; }
    if (isTsBOnlyKey(key)) { merged[key] = bPreset[key]; continue; }
  }
  merged.MIN_DEPTH_USD_1P_ABSOLUTE = Math.max(safeNumber(merged.MIN_DEPTH_USD_1P_ABSOLUTE, MIN_DEPTH_USD_1P_ABSOLUTE), MIN_DEPTH_USD_1P_ABSOLUTE);
  return merged;
}

function tsPatchValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function buildTsPatchLinesFromPreset(preset) {
  return tsMasterFilterKeys().map(key => {
    if (key === "SHORT_BLOCKED_RSI_ZONES" || key === "SHORT_LOWER1_ALLOWED_BTC_STATES") return `const ${key} = ${JSON.stringify(Array.from(preset[key] || []))};`;
    return `const ${key} = ${tsPatchValue(preset[key])};`;
  });
}

function compactTsOptimizationResult(result) {
  return {
    target: result.target, decision: result.decision, sample: result.sample,
    expectedPerformance: {
      completed: result.best?.completed || 0, wins: result.best?.wins || 0, losses: result.best?.losses || 0, flats: result.best?.flats || 0,
      winrate: result.best?.winrate || "0.0%", totalPnlPct: result.best?.totalPnlPct || 0, avgPnlPct: result.best?.avgPnlPct || 0,
      totalR: result.best?.totalR || 0, avgR: result.best?.avgR || 0, profitFactorR: result.best?.profitFactorR || 0,
      directSLPct: result.best?.directSLPct || "0.0%", nearTpThenLossPct: result.best?.nearTpThenLossPct || "0.0%",
      keepRatio: result.best?.keepRatio || 0, decisionScore: result.best?.decisionScore || 0,
      setupClassCounts: result.best?.setupClassCounts || {}, sourceCounts: result.best?.sourceCounts || {}
    },
    moneyProjection: result.best?.moneyProjection || buildTsMoneyProjection([]),
    deltaVsCurrent: result.deltaVsCurrent || null, changedKeys: result.changedKeys || [],
    coverage: { coverageOk: Boolean(result.coverageOk), missingFilters: result.missingFilters || [] },
    afstelling: result.best?.filters || buildCurrentTsMasterPreset(), examples: result.best?.examples || []
  };
}

function buildTsMasterBestAfstellingLog({ btcState, runId }) {
  const rows = buildTsOptimizerUniverse();
  const bestCombined = optimizeTsMasterTarget(rows, "COMBINED");
  const bestA = optimizeTsMasterTarget(rows, "A");
  const bestB = optimizeTsMasterTarget(rows, "B");
  const recommendedLiveAfstelling = mergeTsRecommendedLiveAfstelling({ combined: bestCombined, bestA, bestB });
  const missingFilters = Array.from(new Set([...(bestCombined.missingFilters || []), ...(bestA.missingFilters || []), ...(bestB.missingFilters || [])]));
  const best = bestCombined.best || {};
  const validBest = safeNumber(best.completed, 0) >= TS_MASTER_MIN_SAMPLE && safeNumber(best.totalR, 0) > 0 && safeNumber(best.totalPnlPct, 0) > 0;
  return {
    tag: "TS_MASTER_BEST_AFSTELLING", strategyVersion: STRATEGY_VERSION, runId, btcState, ts: Date.now(),
    objective: TS_MASTER_OBJECTIVE,
    decision: missingFilters.length ? "FILTER_COVERAGE_INCOMPLETE" : validBest ? "BEST_TS_A_AND_B_WINRATE_PNL_AFSTELLING_READY" : "NO_VALID_POSITIVE_EDGE_COMBO_YET",
    sample: { usableRows: rows.length, scanShadowRows: rows.filter(row => String(row.source || "").toUpperCase() === "SCAN_SHADOW").length,
      realRows: rows.filter(row => String(row.source || "").toUpperCase() === "REAL").length,
      shadowRows: rows.filter(row => String(row.source || "").toUpperCase() === "SHADOW").length,
      confidence: rows.length >= 1000 ? "HIGH" : rows.length >= 300 ? "MEDIUM" : "LOW" },
    mapping: { gradeA: ["A", "GOD"], gradeB: ["B", "BULLISH_MID_TREND_PROBE", "BTC_BULLISH_BEAR_EXCEPTION"], note: "Elke completed real/shadow coin wordt opnieuw getest alsof deze preset toen live stond." },
    bestA: compactTsOptimizationResult(bestA), bestB: compactTsOptimizationResult(bestB), bestCombined: compactTsOptimizationResult(bestCombined),
    expectedPerformance: {
      completed: best.completed || 0, wins: best.wins || 0, losses: best.losses || 0, flats: best.flats || 0, winrate: best.winrate || "0.0%",
      totalPnlPct: best.totalPnlPct || 0, avgPnlPct: best.avgPnlPct || 0, totalR: best.totalR || 0, avgR: best.avgR || 0,
      profitFactorR: best.profitFactorR || 0, directSLPct: best.directSLPct || "0.0%", nearTpThenLossPct: best.nearTpThenLossPct || "0.0%",
      keepRatio: best.keepRatio || 0, decisionScore: best.decisionScore || 0
    },
    moneyProjection: best.moneyProjection || buildTsMoneyProjection([]),
    recommendedLiveAfstelling: validBest ? recommendedLiveAfstelling : null,
    patchLines: validBest ? buildTsPatchLinesFromPreset(recommendedLiveAfstelling) : [],
    coverage: { testedFilterCount: tsMasterFilterKeys().length, coverageOk: missingFilters.length === 0, missingFilters }
  };
}

// ================= V12.4 SYMBOL ADAPTIVE PROFILE ENGINE (CORE) =================
function profileQuantile(values, q) {
  const arr = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  const pos = (arr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (arr[base + 1] !== undefined) return arr[base] + rest * (arr[base + 1] - arr[base]);
  return arr[base];
}

function getSymbolOutcomeWeight(row) {
  const source = String(row?.source || "").toUpperCase();
  if (source === "REAL") return SYMBOL_PROFILE_REAL_WEIGHT;
  if (source === "SHADOW") return SYMBOL_PROFILE_SHADOW_WEIGHT;
  if (source === "SCAN_SHADOW") return SYMBOL_PROFILE_SCAN_SHADOW_WEIGHT;
  return 0.25;
}

function isCompletedProfileOutcome(row) {
  if (!row) return false;
  if (!Boolean(row.win) && !Boolean(row.loss)) return false;
  if (!Number.isFinite(Number(row.exitR))) return false;
  if (!Number.isFinite(Number(row.pnlPct))) return false;
  if (!row.symbol || !row.side) return false;
  return true;
}

function weightedSumProfile(rows, selector) {
  return rows.reduce((sum, row) => {
    const weight = getSymbolOutcomeWeight(row);
    const value = Number(selector(row));
    if (!Number.isFinite(value)) return sum;
    return sum + value * weight;
  }, 0);
}

function weightedAvgProfile(rows, selector) {
  const weightTotal = rows.reduce((sum, row) => sum + getSymbolOutcomeWeight(row), 0);
  if (!weightTotal) return 0;
  return weightedSumProfile(rows, selector) / weightTotal;
}

function buildWeightedSymbolStats(rows) {
  const arr = Array.isArray(rows) ? rows.filter(isCompletedProfileOutcome) : [];
  const rawCompleted = arr.length;
  if (!rawCompleted) return { rawCompleted: 0, weightedCompleted: 0, wins: 0, losses: 0, winrateNum: 0, winrate: "0.0%", avgR: 0, totalR: 0, avgPnlPct: 0, totalPnlPct: 0, profitFactorR: 0, directSLPctNum: 0, directSLPct: "0.0%" };
  const weightedCompleted = arr.reduce((sum, row) => sum + getSymbolOutcomeWeight(row), 0);
  const wins = arr.filter(row => Boolean(row.win)).length;
  const losses = arr.filter(row => Boolean(row.loss)).length;
  const weightedWins = arr.filter(row => Boolean(row.win)).reduce((sum, row) => sum + getSymbolOutcomeWeight(row), 0);
  const weightedLosses = arr.filter(row => Boolean(row.loss)).reduce((sum, row) => sum + getSymbolOutcomeWeight(row), 0);
  const winrateNum = weightedCompleted ? weightedWins / weightedCompleted : 0;
  const totalR = weightedSumProfile(arr, row => Number(row.exitR || 0));
  const totalPnlPct = weightedSumProfile(arr, row => Number(row.pnlPct || 0));
  const avgR = weightedCompleted ? totalR / weightedCompleted : 0;
  const avgPnlPct = weightedCompleted ? totalPnlPct / weightedCompleted : 0;
  const grossWinR = weightedSumProfile(arr.filter(row => Number(row.exitR || 0) > 0), row => Number(row.exitR || 0));
  const grossLossR = Math.abs(weightedSumProfile(arr.filter(row => Number(row.exitR || 0) < 0), row => Number(row.exitR || 0)));
  const profitFactorR = grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? 999 : 0;
  const directSLWeight = arr.filter(row => Boolean(row.directToSL) || (Number(row.exitR || 0) < 0 && Number(row.mfeR || 0) < DIRECT_SL_MFE_LIMIT_R)).reduce((sum, row) => sum + getSymbolOutcomeWeight(row), 0);
  const directSLPctNum = weightedCompleted ? directSLWeight / weightedCompleted : 0;
  const winners = arr.filter(row => Boolean(row.win));
  const losers = arr.filter(row => Boolean(row.loss));
  return {
    rawCompleted, weightedCompleted: Number(weightedCompleted.toFixed(2)),
    wins, losses, weightedWins: Number(weightedWins.toFixed(2)), weightedLosses: Number(weightedLosses.toFixed(2)),
    winrateNum: Number(winrateNum.toFixed(4)), winrate: pctText(winrateNum),
    totalR: Number(totalR.toFixed(3)), avgR: Number(avgR.toFixed(3)),
    totalPnlPct: Number(totalPnlPct.toFixed(3)), avgPnlPct: Number(avgPnlPct.toFixed(3)),
    profitFactorR: Number(profitFactorR.toFixed(3)),
    directSLPctNum: Number(directSLPctNum.toFixed(4)), directSLPct: pctText(directSLPctNum),
    winnerConfluenceP35: profileQuantile(winners.map(row => row.confluence), 0.35),
    winnerSniperP35: profileQuantile(winners.map(row => row.sniperScore), 0.35),
    winnerRrP35: profileQuantile(winners.map(row => row.plannedRR), 0.35),
    winnerSpreadP80: profileQuantile(winners.map(row => normalizeSpread(row.spreadPct)), 0.80),
    winnerDepthP20: profileQuantile(winners.map(row => Number(row.depthMinUsd1p || 0)).filter(v => v > 0), 0.20),
    loserConfluenceP60: profileQuantile(losers.map(row => row.confluence), 0.60),
    loserSniperP60: profileQuantile(losers.map(row => row.sniperScore), 0.60),
    loserSpreadP50: profileQuantile(losers.map(row => normalizeSpread(row.spreadPct)), 0.50),
    loserDepthP50: profileQuantile(losers.map(row => Number(row.depthMinUsd1p || 0)).filter(v => v > 0), 0.50)
  };
}

function classifySymbolProfileStats(stats, minCompleted = SYMBOL_PROFILE_MIN_SIDE_COMPLETED) {
  const completed = Number(stats?.rawCompleted || 0);
  const winrate = Number(stats?.winrateNum || 0);
  const avgR = Number(stats?.avgR || 0);
  const directSLPct = Number(stats?.directSLPctNum || 0);
  if (completed < minCompleted) return { decision: "INSUFFICIENT_SAMPLE", reason: "SYMBOL_SAMPLE_TOO_SMALL" };
  if (winrate >= SYMBOL_PROFILE_GOOD_MIN_WINRATE && avgR >= SYMBOL_PROFILE_GOOD_MIN_AVG_R && directSLPct <= SYMBOL_PROFILE_GOOD_MAX_DIRECT_SL_PCT)
    return { decision: "RELAX_ALLOWED", reason: "SYMBOL_POSITIVE_EDGE" };
  if (avgR <= SYMBOL_PROFILE_BAD_MAX_AVG_R || winrate <= SYMBOL_PROFILE_BAD_MAX_WINRATE || directSLPct >= SYMBOL_PROFILE_BAD_DIRECT_SL_PCT)
    return { decision: "TIGHTEN", reason: "SYMBOL_NEGATIVE_EDGE" };
  return { decision: "NEUTRAL", reason: "SYMBOL_EDGE_NOT_CLEAR" };
}

function buildSymbolContextKey({ side, rsiZone, flow, obBias }) {
  return [`SIDE=${String(side || "UNKNOWN").toLowerCase()}`, `RSI=${String(rsiZone || "UNKNOWN").toUpperCase()}`, `FLOW=${String(flow || "UNKNOWN").toUpperCase()}`, `OB=${String(obBias || "UNKNOWN").toUpperCase()}`].join("|");
}

function buildSymbolAdaptiveProfiles() {
  const map = new Map();
  if (!ENABLE_SYMBOL_ADAPTIVE_PROFILES) return map;
  const rows = buildFeatureOutcomeRows().all.filter(isCompletedProfileOutcome).filter(row => normalizeBaseSymbol(row.symbol));
  const bySymbol = new Map();
  for (const row of rows) {
    const symbol = normalizeBaseSymbol(row.symbol);
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol).push({ ...row, symbol, side: String(row.side || "").toLowerCase(), rsiZone: String(row.rsiZone || "UNKNOWN").toUpperCase(), flow: String(row.flow || "UNKNOWN").toUpperCase(), obBias: String(row.obBias || "UNKNOWN").toUpperCase() });
  }
  for (const [symbol, symbolRows] of bySymbol.entries()) {
    const symbolStats = buildWeightedSymbolStats(symbolRows);
    if (symbolStats.rawCompleted < SYMBOL_PROFILE_MIN_SYMBOL_COMPLETED) continue;
    const sides = {};
    const contexts = {};
    for (const side of ["bull", "bear"]) {
      const sideRows = symbolRows.filter(row => row.side === side);
      const sideStats = buildWeightedSymbolStats(sideRows);
      sides[side] = { ...sideStats, ...classifySymbolProfileStats(sideStats, SYMBOL_PROFILE_MIN_SIDE_COMPLETED) };
    }
    const contextMap = new Map();
    for (const row of symbolRows) {
      const contextKey = buildSymbolContextKey({ side: row.side, rsiZone: row.rsiZone, flow: row.flow, obBias: row.obBias });
      if (!contextMap.has(contextKey)) contextMap.set(contextKey, []);
      contextMap.get(contextKey).push(row);
    }
    for (const [contextKey, contextRows] of contextMap.entries()) {
      const contextStats = buildWeightedSymbolStats(contextRows);
      if (contextStats.rawCompleted < SYMBOL_PROFILE_MIN_CONTEXT_COMPLETED) continue;
      contexts[contextKey] = { ...contextStats, ...classifySymbolProfileStats(contextStats, SYMBOL_PROFILE_MIN_CONTEXT_COMPLETED) };
    }
    map.set(symbol, { symbol, stats: { ...symbolStats, ...classifySymbolProfileStats(symbolStats, SYMBOL_PROFILE_MIN_SYMBOL_COMPLETED) }, sides, contexts, updatedAt: Date.now() });
  }
  return map;
}

function getSymbolProfileConfidence(stats) {
  const completed = Number(stats?.rawCompleted || 0);
  if (completed >= SYMBOL_PROFILE_HIGH_CONFIDENCE_COMPLETED) return 1.00;
  if (completed >= SYMBOL_PROFILE_MIN_SYMBOL_COMPLETED) return 0.65;
  if (completed >= SYMBOL_PROFILE_MIN_SIDE_COMPLETED) return 0.45;
  return 0;
}

function applySymbolOffsetFromStats(offset, stats, weight = 1) {
  if (!stats || Number(stats.rawCompleted || 0) <= 0) return offset;
  const confidence = getSymbolProfileConfidence(stats) * weight;
  if (confidence <= 0) return offset;
  const decision = String(stats.decision || "NEUTRAL");
  if (decision === "RELAX_ALLOWED") { offset.conf -= 2.5 * confidence; offset.sniper -= 2.5 * confidence; offset.rr -= 0.025 * confidence; }
  if (decision === "TIGHTEN") { offset.conf += 4.5 * confidence; offset.sniper += 4.5 * confidence; offset.rr += 0.045 * confidence; }
  if (Number(stats.directSLPctNum || 0) >= SYMBOL_PROFILE_BAD_DIRECT_SL_PCT) { offset.conf += 2.5 * confidence; offset.sniper += 2.5 * confidence; offset.rr += 0.025 * confidence; }
  return offset;
}

function buildSymbolSetupTuning({ profile, c, rsiZone, flow, ob }) {
  const base = { active: false, decision: "NO_PROFILE", reason: "NO_SYMBOL_PROFILE", A_MIN_CONFLUENCE, A_MIN_SNIPER, A_ENTRY_MIN_RR, B_MIN_CONFLUENCE, B_MIN_SNIPER, B_ENTRY_MIN_RR, GOD_MIN_CONFLUENCE, GOD_MIN_SNIPER, GOD_ENTRY_MIN_RR, symbolCompleted: 0, sideCompleted: 0, contextCompleted: 0 };
  if (!ENABLE_SYMBOL_ADAPTIVE_PROFILES || !profile) return base;
  const side = String(c?.side || "").toLowerCase();
  const flowType = String(flow?.type || flow || c?.flow || "UNKNOWN").toUpperCase();
  const obBias = String(ob?.bias || "UNKNOWN").toUpperCase();
  const sideStats = profile.sides?.[side] || null;
  const contextKey = buildSymbolContextKey({ side, rsiZone, flow: flowType, obBias });
  const contextStats = profile.contexts?.[contextKey] || null;
  let offset = { conf: 0, sniper: 0, rr: 0 };
  offset = applySymbolOffsetFromStats(offset, profile.stats, 0.40);
  offset = applySymbolOffsetFromStats(offset, sideStats, 1.00);
  offset = applySymbolOffsetFromStats(offset, contextStats, 0.85);
  offset.conf = clamp(offset.conf, -SYMBOL_PROFILE_MAX_CONF_RELAX, SYMBOL_PROFILE_MAX_CONF_TIGHTEN);
  offset.sniper = clamp(offset.sniper, -SYMBOL_PROFILE_MAX_SNIPER_RELAX, SYMBOL_PROFILE_MAX_SNIPER_TIGHTEN);
  offset.rr = clamp(offset.rr, -SYMBOL_PROFILE_MAX_RR_RELAX, SYMBOL_PROFILE_MAX_RR_TIGHTEN);
  const active = Math.abs(offset.conf) >= 0.5 || Math.abs(offset.sniper) >= 0.5 || Math.abs(offset.rr) >= 0.005;
  const decision = contextStats?.decision && contextStats.decision !== "INSUFFICIENT_SAMPLE" ? contextStats.decision : sideStats?.decision && sideStats.decision !== "INSUFFICIENT_SAMPLE" ? sideStats.decision : profile.stats?.decision || "NEUTRAL";
  return {
    active, decision, reason: contextStats?.reason || sideStats?.reason || profile.stats?.reason || "SYMBOL_PROFILE_ACTIVE", contextKey,
    confOffset: Number(offset.conf.toFixed(2)), sniperOffset: Number(offset.sniper.toFixed(2)), rrOffset: Number(offset.rr.toFixed(3)),
    symbolCompleted: Number(profile.stats?.rawCompleted || 0), sideCompleted: Number(sideStats?.rawCompleted || 0), contextCompleted: Number(contextStats?.rawCompleted || 0),
    symbolStats: profile.stats || null, sideStats, contextStats,
    A_MIN_CONFLUENCE: clamp(Math.round(A_MIN_CONFLUENCE + offset.conf), Math.max(45, A_MIN_CONFLUENCE - SYMBOL_PROFILE_MAX_CONF_RELAX), Math.min(96, A_MIN_CONFLUENCE + SYMBOL_PROFILE_MAX_CONF_TIGHTEN)),
    A_MIN_SNIPER: clamp(Math.round(A_MIN_SNIPER + offset.sniper), Math.max(35, A_MIN_SNIPER - SYMBOL_PROFILE_MAX_SNIPER_RELAX), Math.min(96, A_MIN_SNIPER + SYMBOL_PROFILE_MAX_SNIPER_TIGHTEN)),
    A_ENTRY_MIN_RR: clamp(Number((A_ENTRY_MIN_RR + offset.rr).toFixed(2)), Math.max(1.00, A_ENTRY_MIN_RR - SYMBOL_PROFILE_MAX_RR_RELAX), Math.min(1.50, A_ENTRY_MIN_RR + SYMBOL_PROFILE_MAX_RR_TIGHTEN)),
    B_MIN_CONFLUENCE: clamp(Math.round(B_MIN_CONFLUENCE + offset.conf), Math.max(40, B_MIN_CONFLUENCE - SYMBOL_PROFILE_MAX_CONF_RELAX), Math.min(95, B_MIN_CONFLUENCE + SYMBOL_PROFILE_MAX_CONF_TIGHTEN)),
    B_MIN_SNIPER: clamp(Math.round(B_MIN_SNIPER + offset.sniper), Math.max(30, B_MIN_SNIPER - SYMBOL_PROFILE_MAX_SNIPER_RELAX), Math.min(95, B_MIN_SNIPER + SYMBOL_PROFILE_MAX_SNIPER_TIGHTEN)),
    B_ENTRY_MIN_RR: clamp(Number((B_ENTRY_MIN_RR + offset.rr).toFixed(2)), Math.max(0.98, B_ENTRY_MIN_RR - SYMBOL_PROFILE_MAX_RR_RELAX), Math.min(1.45, B_ENTRY_MIN_RR + SYMBOL_PROFILE_MAX_RR_TIGHTEN)),
    GOD_MIN_CONFLUENCE: clamp(Math.round(GOD_MIN_CONFLUENCE + Math.max(0, offset.conf)), GOD_MIN_CONFLUENCE, 99),
    GOD_MIN_SNIPER: clamp(Math.round(GOD_MIN_SNIPER + Math.max(0, offset.sniper)), GOD_MIN_SNIPER, 99),
    GOD_ENTRY_MIN_RR: clamp(Number((GOD_ENTRY_MIN_RR + Math.max(0, offset.rr)).toFixed(2)), GOD_ENTRY_MIN_RR, 1.70)
  };
}

function buildSymbolExecutionTuning({ profile, c, rsiZone, flow, ob, baseMaxSpread }) {
  const base = { active: false, decision: "NO_PROFILE", reason: "NO_SYMBOL_PROFILE", maxSpreadPct: Number(baseMaxSpread || MAX_SPREAD_PCT), minDepthUsd1p: null, canRelaxDepth: false };
  if (!ENABLE_SYMBOL_ADAPTIVE_PROFILES || !profile) return base;
  const side = String(c?.side || "").toLowerCase();
  const flowType = String(flow?.type || flow || c?.flow || "UNKNOWN").toUpperCase();
  const obBias = String(ob?.bias || "UNKNOWN").toUpperCase();
  const sideStats = profile.sides?.[side] || null;
  const contextKey = buildSymbolContextKey({ side, rsiZone, flow: flowType, obBias });
  const contextStats = profile.contexts?.[contextKey] || null;
  const stats = contextStats || sideStats || profile.stats || null;
  if (!stats || Number(stats.rawCompleted || 0) < SYMBOL_PROFILE_MIN_SIDE_COMPLETED) return { ...base, decision: "INSUFFICIENT_SAMPLE", reason: "SYMBOL_EXECUTION_SAMPLE_TOO_SMALL", contextKey };
  let maxSpreadPct = Number(baseMaxSpread || MAX_SPREAD_PCT);
  let minDepthUsd1p = null;
  let canRelaxDepth = false;
  const decision = String(stats.decision || "NEUTRAL");
  if (decision === "RELAX_ALLOWED") {
    const winnerSpreadP80 = Number(stats.winnerSpreadP80 || 0);
    const winnerDepthP20 = Number(stats.winnerDepthP20 || 0);
    if (winnerSpreadP80 > 0) maxSpreadPct = Math.min(SYMBOL_PROFILE_MAX_SPREAD_CAP, Math.max(maxSpreadPct, winnerSpreadP80 * 1.10, maxSpreadPct * 1.08));
    if (winnerDepthP20 > 0) { minDepthUsd1p = Math.max(SYMBOL_PROFILE_MIN_DEPTH_FLOOR, Math.round(winnerDepthP20 * 0.80)); canRelaxDepth = minDepthUsd1p < MIN_DEPTH_USD_1P; }
  }
  if (decision === "TIGHTEN") { maxSpreadPct = Math.max(0.0004, Math.min(maxSpreadPct, maxSpreadPct * 0.85)); minDepthUsd1p = Math.round(MIN_DEPTH_USD_1P * 1.15); canRelaxDepth = false; }
  return { active: true, decision, reason: stats.reason || "SYMBOL_EXECUTION_PROFILE_ACTIVE", contextKey, maxSpreadPct: Number(maxSpreadPct.toFixed(6)), minDepthUsd1p, canRelaxDepth, completed: Number(stats.rawCompleted || 0), winrate: stats.winrate, avgR: stats.avgR, directSLPct: stats.directSLPct };
}

function validateSymbolProfileGate({ profile, c, setupClass, confluence, sniperScore, plannedRR, obBias }) {
  if (!ENABLE_SYMBOL_ADAPTIVE_PROFILES || !profile) return { ok: true, reason: "NO_SYMBOL_PROFILE" };
  const side = String(c?.side || "").toLowerCase();
  const sideStats = profile.sides?.[side] || null;
  if (!sideStats) return { ok: true, reason: "NO_SYMBOL_SIDE_PROFILE" };
  const completed = Number(sideStats.rawCompleted || 0);
  const avgR = Number(sideStats.avgR || 0);
  const directSLPct = Number(sideStats.directSLPctNum || 0);
  const hardBad = completed >= SYMBOL_PROFILE_HARD_BLOCK_MIN_COMPLETED && avgR <= SYMBOL_PROFILE_HARD_BLOCK_MAX_AVG_R && directSLPct >= SYMBOL_PROFILE_HARD_BLOCK_DIRECT_SL_PCT;
  if (!hardBad) return { ok: true, reason: "SYMBOL_PROFILE_GATE_OK" };
  const alignedOb = (side === "bull" && String(obBias || "").toUpperCase() === "BULLISH") || (side === "bear" && String(obBias || "").toUpperCase() === "BEARISH");
  const eliteBypass = String(setupClass || "").toUpperCase() === "GOD" || (Number(confluence || 0) >= 92 && Number(sniperScore || 0) >= 92 && Number(plannedRR || 0) >= 1.25 && alignedOb);
  if (eliteBypass) return { ok: true, reason: "SYMBOL_PROFILE_BAD_SIDE_ELITE_BYPASS" };
  return { ok: false, reason: "SYMBOL_PROFILE_BAD_SIDE_BLOCK", stats: sideStats };
}

function compactSymbolProfileForLog(profile) {
  return {
    symbol: profile.symbol, completed: profile.stats?.rawCompleted || 0, decision: profile.stats?.decision || "UNKNOWN", winrate: profile.stats?.winrate || "0.0%", avgR: profile.stats?.avgR || 0, directSLPct: profile.stats?.directSLPct || "0.0%",
    bull: { completed: profile.sides?.bull?.rawCompleted || 0, decision: profile.sides?.bull?.decision || "NA", winrate: profile.sides?.bull?.winrate || "0.0%", avgR: profile.sides?.bull?.avgR || 0, directSLPct: profile.sides?.bull?.directSLPct || "0.0%" },
    bear: { completed: profile.sides?.bear?.rawCompleted || 0, decision: profile.sides?.bear?.decision || "NA", winrate: profile.sides?.bear?.winrate || "0.0%", avgR: profile.sides?.bear?.avgR || 0, directSLPct: profile.sides?.bear?.directSLPct || "0.0%" },
    contextCount: Object.keys(profile.contexts || {}).length
  };
}

function logSymbolAdaptiveProfileSummary(profileMap) {
  if (!ENABLE_SYMBOL_ADAPTIVE_PROFILES) return;
  const profiles = Array.from(profileMap.values());
  console.log("TS_SYMBOL_PROFILE_SUMMARY", JSON.stringify({ strategyVersion: STRATEGY_VERSION, profiles: profiles.length, highConfidence: profiles.filter(p => Number(p.stats?.rawCompleted || 0) >= SYMBOL_PROFILE_HIGH_CONFIDENCE_COMPLETED).length, relaxAllowed: profiles.filter(p => p.stats?.decision === "RELAX_ALLOWED").length, tighten: profiles.filter(p => p.stats?.decision === "TIGHTEN").length, neutral: profiles.filter(p => p.stats?.decision === "NEUTRAL").length, ts: Date.now() }));
  console.log("TS_SYMBOL_PROFILE_TOP", JSON.stringify(profiles.sort((a, b) => Number(b.stats?.rawCompleted || 0) - Number(a.stats?.rawCompleted || 0)).slice(0, SYMBOL_PROFILE_LOG_TOP_N).map(compactSymbolProfileForLog)));
}

// ================= PATCHED INFER SETUP CLASS (SYMBOL ADAPTIVE) =================
function inferSetupClass({ c, sniper, confluence, rr, rsiEdge, bullishMidTrendProbe, btcBullishBearException, symbolSetupTuning }) {
  const t = symbolSetupTuning || {};
  const godMinRR = Number(t.GOD_ENTRY_MIN_RR ?? GOD_ENTRY_MIN_RR);
  const godMinSniper = Number(t.GOD_MIN_SNIPER ?? GOD_MIN_SNIPER);
  const godMinConf = Number(t.GOD_MIN_CONFLUENCE ?? GOD_MIN_CONFLUENCE);
  const aMinRR = Number(t.A_ENTRY_MIN_RR ?? A_ENTRY_MIN_RR);
  const aMinSniper = Number(t.A_MIN_SNIPER ?? A_MIN_SNIPER);
  const aMinConf = Number(t.A_MIN_CONFLUENCE ?? A_MIN_CONFLUENCE);
  const bMinRR = Number(t.B_ENTRY_MIN_RR ?? B_ENTRY_MIN_RR);
  const bMinSniper = Number(t.B_MIN_SNIPER ?? B_MIN_SNIPER);
  const bMinConf = Number(t.B_MIN_CONFLUENCE ?? B_MIN_CONFLUENCE);

  if (bullishMidTrendProbe) {
    const probeMinRR = Number(t.B_ENTRY_MIN_RR ?? B_ENTRY_MIN_RR);
    const probeMinSniper = Number(t.B_MIN_SNIPER ?? B_MIN_SNIPER);
    const probeMinConf = Number(t.B_MIN_CONFLUENCE ?? B_MIN_CONFLUENCE);
    if (rr >= probeMinRR && sniper.score >= probeMinSniper && confluence >= probeMinConf) {
      return { setupClass: "B_TREND_PROBE", grade: "B", minRR: probeMinRR, minSniper: probeMinSniper, minConfluence: probeMinConf };
    }
  }

  if (btcBullishBearException) {
    const exMinRR = Number(t.A_ENTRY_MIN_RR ?? A_ENTRY_MIN_RR);
    const exMinSniper = Number(t.A_MIN_SNIPER ?? A_MIN_SNIPER);
    const exMinConf = Number(t.A_MIN_CONFLUENCE ?? A_MIN_CONFLUENCE);
    if (rr >= exMinRR && sniper.score >= exMinSniper && confluence >= exMinConf) {
      return { setupClass: "A_SHORT_EXCEPTION", grade: "A", minRR: exMinRR, minSniper: exMinSniper, minConfluence: exMinConf };
    }
  }

  if (rr >= godMinRR && sniper.score >= godMinSniper && confluence >= godMinConf) {
    return { setupClass: "GOD", grade: "A", minRR: godMinRR, minSniper: godMinSniper, minConfluence: godMinConf };
  }

  if (rr >= aMinRR && sniper.score >= aMinSniper && confluence >= aMinConf) {
    return { setupClass: "A", grade: "A", minRR: aMinRR, minSniper: aMinSniper, minConfluence: aMinConf };
  }

  if (ENABLE_B_ENTRIES && rr >= bMinRR && sniper.score >= bMinSniper && confluence >= bMinConf) {
    return { setupClass: "B", grade: "B", minRR: bMinRR, minSniper: bMinSniper, minConfluence: bMinConf };
  }

  return { setupClass: "NONE", grade: null };
}

// ================= PATCHED GET NO SETUP REASON (SYMBOL ADAPTIVE) =================
function getNoSetupReason({ c, flow, sniper, confluence, rr, ob, rsiZone, btcState, btcBullishBearException, bullishMidTrendProbe, symbolSetupTuning }) {
  const t = symbolSetupTuning || {};
  const aMinConf = Number(t.A_MIN_CONFLUENCE ?? A_MIN_CONFLUENCE);
  const aMinSniper = Number(t.A_MIN_SNIPER ?? A_MIN_SNIPER);
  const aMinRR = Number(t.A_ENTRY_MIN_RR ?? A_ENTRY_MIN_RR);
  const bMinConf = Number(t.B_MIN_CONFLUENCE ?? B_MIN_CONFLUENCE);
  const bMinSniper = Number(t.B_MIN_SNIPER ?? B_MIN_SNIPER);
  const bMinRR = Number(t.B_ENTRY_MIN_RR ?? B_ENTRY_MIN_RR);
  const godMinConf = Number(t.GOD_MIN_CONFLUENCE ?? GOD_MIN_CONFLUENCE);
  const godMinSniper = Number(t.GOD_MIN_SNIPER ?? GOD_MIN_SNIPER);
  const godMinRR = Number(t.GOD_ENTRY_MIN_RR ?? GOD_ENTRY_MIN_RR);
  const probeMinConf = Number(t.B_MIN_CONFLUENCE ?? B_MIN_CONFLUENCE);
  const probeMinSniper = Number(t.B_MIN_SNIPER ?? B_MIN_SNIPER);
  const probeMinRR = Number(t.B_ENTRY_MIN_RR ?? B_ENTRY_MIN_RR);

  if (bullishMidTrendProbe && rr < probeMinRR) return "LOW_FINAL_RR";
  if (bullishMidTrendProbe && sniper.score < probeMinSniper) return "LOW_SNIPER";
  if (bullishMidTrendProbe && confluence < probeMinConf) return "LOW_CONFLUENCE";

  if (btcBullishBearException) {
    if (rr < aMinRR) return "LOW_FINAL_RR";
    if (sniper.score < aMinSniper) return "LOW_SNIPER";
    if (confluence < aMinConf) return "LOW_CONFLUENCE";
  }

  if (rr < bMinRR && rr < aMinRR && rr < godMinRR) return "LOW_FINAL_RR";
  if (sniper.score < bMinSniper && sniper.score < aMinSniper && sniper.score < godMinSniper) return "LOW_SNIPER";
  if (confluence < bMinConf && confluence < aMinConf && confluence < godMinConf) return "LOW_CONFLUENCE";

  if (c.stage !== "entry" && c.stage !== "almost") return "STAGE_NOT_ENTRY";
  if (Number(c.moveScore || 0) < CANDIDATE_MIN_SCORE) return "SCORE_TOO_LOW";
  if (ob?.fetchFailed) return "OB_FETCH_FAILED";
  if (ob?.spoof) return "SPOOF_DETECTED";

  const counterBtc = (c.side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(String(btcState).toUpperCase())) ||
                     (c.side === "bear" && ["BULLISH", "STRONG_BULL"].includes(String(btcState).toUpperCase()));
  if (counterBtc) return "COUNTER_BTC";

  const maxSpread = getMaxSpreadForCandidate({ c, rsiZone, setupClass: null });
  if (normalizeSpread(ob?.spreadPct) > maxSpread) return "SPREAD_TOO_HIGH";

  const minDepth = (c.side === "bull" && flow?.type === "TREND") ? BULL_TREND_MIN_DEPTH_USD_1P : MIN_DEPTH_USD_1P_ABSOLUTE;
  if (Number(ob?.depthMinUsd1p || 0) < minDepth) return "DEPTH_TOO_LOW";

  const globalConfMin = (String(btcState).toUpperCase() === "BEARISH" && c.side === "bull") ? BTC_BEARISH_LONG_MIN_SCORE : GLOBAL_MIN_CONFLUENCE;
  if (confluence < globalConfMin) return "LOW_GLOBAL_CONFLUENCE";

  if (flow?.type === "NO_FLOW" && confluence < NO_FLOW_MIN_CONFLUENCE) return "NO_FLOW_CONFLUENCE";
  if (c.volatility === "LOW" && confluence < LOW_VOL_MIN_CONFLUENCE) return "LOW_VOL_CONFLUENCE";

  const obAgainst = (c.side === "bull" && ob?.bias === "BEARISH") || (c.side === "bear" && ob?.bias === "BULLISH");
  if (obAgainst && confluence < OB_AGAINST_MIN_CONFLUENCE) return "OB_AGAINST_SIDE";

  if (ob?.bias === "NEUTRAL" && confluence < OB_NEUTRAL_MIN_CONFLUENCE) return "NEUTRAL_OB_LOW_CONFLUENCE";

  const extFundingAbs = Math.abs(Number(c.funding || 0));
  if (extFundingAbs > EXTREME_FUNDING_ABS_MAX) return "EXTREME_FUNDING";

  if (c.side === "bull" && Number(c.funding || 0) > BULL_CROWDED_FUNDING_MAX && confluence < CROWDED_FUNDING_MIN_CONFLUENCE) return "BULL_CROWDED_FUNDING";
  if (c.side === "bear" && Number(c.funding || 0) < BEAR_CROWDED_FUNDING_MIN && confluence < CROWDED_FUNDING_MIN_CONFLUENCE) return "BEAR_CROWDED_FUNDING";

  if (c.rsiBlocked) return "RSI_HTF_BLOCKED";

  const rsiEdgeBlock = rsiZone === "UPPER_3" && c.side === "bull" && !rsiEdge?.continuationOk;
  if (rsiEdgeBlock) return "RSI_OVERBOUGHT_NO_CONTINUATION";

  if (c.side === "bear" && SHORT_BLOCKED_RSI_ZONES.includes(rsiZone)) return "SHORT_RSI_BLOCKED";

  if (c.side === "bear" && rsiZone === "LOWER_1" && !SHORT_LOWER1_ALLOWED_BTC_STATES.includes(btcState)) return "SHORT_LOWER1_BTC_NOT_ALLOWED";

  if (c.side === "bear" && rsiZone === "LOWER_1" && (confluence < SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE || sniper.score < SHORT_LOWER1_CONTINUATION_MIN_SNIPER || rr < SHORT_LOWER1_CONTINUATION_MIN_RR)) return "SHORT_LOWER1_WEAK";

  if (c.side === "bull" && rsiZone === "LOWER_2" && c.change1h > LONG_LOWER2_MAX_1H_CHANGE) return "BULL_LOWER2_TOO_MUCH_MOMENTUM";

  if (c.side === "bear" && rsiZone === "UPPER_2" && c.change1h < SHORT_UPPER2_MIN_1H_CHANGE) return "BEAR_UPPER2_NOT_ENOUGH_MOVE";

  if (flow?.type === "TREND" && (confluence < TREND_CONTINUATION_MIN_CONFLUENCE || sniper.score < TREND_CONTINUATION_MIN_SNIPER || rr < TREND_CONTINUATION_MIN_RR)) return "TREND_CONTINUATION_WEAK";

  if (c.side === "bull" && rsiZone === "UPPER_1" && !c.rsiContinuationAllowed) return "BULL_UPPER1_NO_CONTINUATION";

  if (c.side === "bull" && REQUIRED_BULL_TREND_PULLBACK && isBtcBullishState(btcState) && flow?.type === "TREND" && rsiZone === "MID") {
    if (!c.pullbackConfirmed && !c.sweepConfirmed && !c.retestConfirmed && !c.fakeBreakoutConfirmed && !bullishMidTrendProbe) return "BULL_TREND_NO_PULLBACK";
  }

  if (c.side === "bull" && !validateBullAntiChase(c).ok) return "BULL_ANTI_CHASE";

  if (!ENABLE_B_ENTRIES && !bullishMidTrendProbe && !btcBullishBearException && (confluence < aMinConf || sniper.score < aMinSniper || rr < aMinRR)) return "B_ENTRIES_DISABLED";

  return null;
}

// ================= CORE DATA FETCHING (FULL) =================
async function fetchCoinData(c) {
  const symbol = normalizeBaseSymbol(c.symbol);
  if (dataMap.has(symbol)) return dataMap.get(symbol);

  const contractSymbol = normalizeBitgetSymbol(c.symbol);
  let ob = DEFAULT_OB;
  let funding = { rate: 0 };
  let rsiData = null;
  let liquidation = null;

  try {
    const rawOb = await cachedFetch(`ob_${contractSymbol}`, () => fetchOrderBook(contractSymbol), 3000);
    ob = rawOb ? analyzeOrderBookAdvanced(rawOb) : DEFAULT_OB;
    if (ob?.mid > 0) updateOrderbookMemorySafe(contractSymbol, rawOb, ob);
  } catch (e) { console.warn(`OB fetch failed for ${symbol}:`, e.message); ob.fetchFailed = true; }

  try {
    funding = await cachedFetch(`funding_${contractSymbol}`, () => fetchFunding(contractSymbol), 60000);
  } catch (e) { console.warn(`Funding fetch failed for ${symbol}:`, e.message); }

  try {
    const candles15m = await fetchCandles(contractSymbol, "15m", 40);
    const candles1h = await fetchCandles(contractSymbol, "1h", 60);
    const candles4h = await fetchCandles(contractSymbol, "4h", 40);
    const rawRsi = await getMTFRSI(contractSymbol, { candles15m, candles1h, candles4h });
    const fallbackRsi = buildFallbackMtfRsi({ candles15m, candles1h, candles4h });
    rsiData = mergeMtfRsi(rawRsi, fallbackRsi);
  } catch (e) { console.warn(`RSI fetch failed for ${symbol}:`, e.message); rsiData = null; }

  try {
    liquidation = await cachedFetch(`liquidation_${contractSymbol}`, () => getLiquidationZones(contractSymbol), 120000);
  } catch (e) { console.warn(`Liquidation fetch failed for ${symbol}:`, e.message); }

  const data = { ob, funding, rsiData, liquidation, contractSymbol, candles: { m15: null, h1: null, h4: null } };
  dataMap.set(symbol, data);
  return data;
}

// ================= ENTRY CORE (WITH ALL PATCHES) =================
async function evaluateEntry(c, data, btcState, regimeLevel, isBull, runId, symbolProfileMap) {
  const { ob, funding, rsiData, liquidation, contractSymbol } = data;
  const flow = analyzeFlow(c);
  const tfMeta = getTimeframeMeta(c);

  let rsiSignal = null;
  try {
    rsiSignal = await getSafeRsiSignal({ c, rsiData, isBull, btcState });
  } catch (e) { console.warn("RSI signal error:", e.message); rsiSignal = { rsi: 50, rsiHTF: 50, zones: { L3: 25, L2: 35, L1: 45, U1: 55, U2: 65, U3: 75 }, valid: false }; }

  const rsiZone = getRsiZone(rsiSignal);
  const rsiEdge = getRsiEdgeMeta({ isBull, rsiSignal, rsiZone });

  const rsiValid = Boolean(rsiSignal?.valid);
  const rsiHtfBlocked = Boolean(rsiSignal?.blocked);
  if (rsiHtfBlocked) return { action: "WAIT", reason: "RSI_HTF_BLOCKED", shouldLog: true, data: { rsiZone, rsiEdge } };

  let sniper = await getSafeSniperEntry({ c, flow, ob, rsiSignal, rsiZone, isBull, btcState });
  const sniperScore = getSniperScore(sniper);
  if (sniperScore < MIN_EXTERNAL_SNIPER_HEALTH && sniperScore < 30) return { action: "WAIT", reason: "SNIPER_TOO_LOW", shouldLog: true, data: { sniperScore, rsiZone } };

  let risk = await getSafeRiskGeometry({ c, isBull, liquidity: null, liquidation, ob, flow, sniper, rsiSignal });
  if (!risk || !risk.rr || risk.rr < MIN_ACCEPTABLE_PRIMARY_RR) return { action: "WAIT", reason: "RISK_GEOMETRY_FAILED", shouldLog: true, data: { risk } };

  const baseRR = risk.rr;
  const rrWithSniper = getSniperAdjustedRR(sniper, baseRR, null);
  const rrWithRsi = applyRsiEdgeToRequiredRR(rrWithSniper, rsiEdge);
  const rr = Math.max(rrWithRsi, MIN_RR_FLOOR);

  let confluenceRaw = await getSafeConfluence({ c, flow, sniper, ob, risk, rr, funding, rsiSignal, rsiZone, btcState, regimeLevel, liquidation, isBull });
  let confluence = applyRsiEdgeToConfluence(confluenceRaw, rsiEdge);
  confluence = Math.min(100, Math.max(0, confluence));

  const hasLiquidationData = Boolean(liquidation?.levels?.length);
  const isValidFakeBreakout = Boolean(c.fakeBreakout);
  const bullPullbackMeta = getBullPullbackMeta({ c, candles15m: null, fakeBreakoutConfirmed: isValidFakeBreakout });
  const setupGrade = getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull });

  const counterTrend = getCounterTrend(c, btcState);
  const minRrFloor = getDynamicMinRrFloor({ c, setupGrade, flow, sniper, confluence, counterTrend });
  if (rr < minRrFloor) return { action: "WAIT", reason: "LOW_RR", shouldLog: true, data: { rr, minRrFloor, confluence, sniperScore, rsiZone } };

  const btcBullishBearException = validateBtcBullishShortException({ ...c, btcState, obBias: ob?.bias, confluence, sniperScore, plannedRR: rr, spreadPct: ob?.spreadPct, depthMinUsd1p: ob?.depthMinUsd1p, flow: flow.type, rsiZone, stage: c.stage });
  const bullishMidTrendProbe = validateBullishMidTrendProbe({ ...c, btcState, obBias: ob?.bias, confluence, sniperScore, plannedRR: rr, spreadPct: ob?.spreadPct, depthMinUsd1p: ob?.depthMinUsd1p, flow: flow.type, rsiZone, stage: c.stage });

  // Symbol adaptive profile tuning
  const symbolProfile = symbolProfileMap.get(c.symbol) || null;
  const symbolSetupTuning = buildSymbolSetupTuning({ profile: symbolProfile, c, rsiZone, flow, ob });
  const symbolExecutionTuning = buildSymbolExecutionTuning({ profile: symbolProfile, c, rsiZone, flow, ob, baseMaxSpread: getMaxSpreadForCandidate({ c, rsiZone, setupClass: null }) });
  const symbolProfileGate = validateSymbolProfileGate({ profile: symbolProfile, c, setupClass: null, confluence, sniperScore, plannedRR: rr, obBias: ob?.bias });

  if (!symbolProfileGate.ok) return { action: "WAIT", reason: symbolProfileGate.reason, shouldLog: true, data: { symbolProfileGate } };

  const setup = inferSetupClass({ c, sniper, confluence, rr, rsiEdge, bullishMidTrendProbe: bullishMidTrendProbe.ok, btcBullishBearException: btcBullishBearException.exception, symbolSetupTuning });
  if (setup.setupClass === "NONE") {
    const noSetupReason = getNoSetupReason({ c, flow, sniper, confluence, rr, ob, rsiZone, btcState, btcBullishBearException: btcBullishBearException.exception, bullishMidTrendProbe: bullishMidTrendProbe.ok, symbolSetupTuning });
    return { action: "WAIT", reason: noSetupReason || "SETUP_CLASS_NONE", shouldLog: true, data: { confluence, sniperScore, rr, rsiZone, setup } };
  }

  // Apply symbol execution tuning to spread and depth checks
  const effectiveMaxSpread = symbolExecutionTuning.active ? symbolExecutionTuning.maxSpreadPct : getMaxSpreadForCandidate({ c, rsiZone, setupClass: setup.setupClass });
  if (normalizeSpread(ob?.spreadPct) > effectiveMaxSpread) return { action: "WAIT", reason: "SPREAD_TOO_HIGH", shouldLog: true, data: { spread: ob?.spreadPct, max: effectiveMaxSpread } };

  const effectiveMinDepth = symbolExecutionTuning.minDepthUsd1p || (c.side === "bull" && flow.type === "TREND" ? BULL_TREND_MIN_DEPTH_USD_1P : MIN_DEPTH_USD_1P_ABSOLUTE);
  if (Number(ob?.depthMinUsd1p || 0) < effectiveMinDepth && !symbolExecutionTuning.canRelaxDepth) return { action: "WAIT", reason: "DEPTH_TOO_LOW", shouldLog: true, data: { depth: ob?.depthMinUsd1p, min: effectiveMinDepth } };

  const qualityGate = validateEntryQualityGateV12({ ...c, obBias: ob?.bias, flow: flow.type, setupClass: setup.setupClass, rsi, confluence, sniperScore, plannedRR: rr, spreadPct: ob?.spreadPct, depthMinUsd1p: ob?.depthMinUsd1p, rsiZone, btcState, pullbackConfirmed: bullPullbackMeta.pullbackConfirmed, sweepConfirmed: bullPullbackMeta.sweepConfirmed, retestConfirmed: bullPullbackMeta.retestConfirmed, fakeBreakoutConfirmed: isValidFakeBreakout });
  if (!qualityGate.ok) return { action: "WAIT", reason: qualityGate.reason, shouldLog: true, data: qualityGate };

  const finalRR = rr;
  const finalDepthValidation = validateFinalDepth({
    ...c,
    depthMinUsd1p: ob?.depthMinUsd1p,
    side: c.side,
    flow: flow.type,
    setupClass: setup.setupClass,
    symbolProfileMinDepthUsd1p: symbolExecutionTuning.minDepthUsd1p,
    symbolProfileCanRelaxDepth: symbolExecutionTuning.canRelaxDepth
  });
  if (!finalDepthValidation.ok) return { action: "WAIT", reason: finalDepthValidation.reason, shouldLog: true, data: finalDepthValidation };

  const rrFloor = (setup.grade === "A" ? GRADE_A_MIN_RR_FLOOR : (setup.grade === "B" ? GRADE_B_MIN_RR_FLOOR : GRADE_C_MIN_RR_FLOOR));
  if (finalRR < rrFloor) return { action: "WAIT", reason: "LOW_FINAL_RR", shouldLog: true, data: { finalRR, rrFloor } };

  const finalConfluence = confluence;
  const finalSniper = sniperScore;

  if (setup.grade === "A") {
    if (finalConfluence < A_MIN_CONFLUENCE) return { action: "WAIT", reason: "A_CONFLUENCE_TOO_LOW", shouldLog: true };
    if (finalSniper < A_MIN_SNIPER) return { action: "WAIT", reason: "A_SNIPER_TOO_LOW", shouldLog: true };
    if (finalRR < A_FINAL_MIN_RR) return { action: "WAIT", reason: "A_FINAL_RR_TOO_LOW", shouldLog: true };
  } else if (setup.grade === "B") {
    if (finalConfluence < B_MIN_CONFLUENCE) return { action: "WAIT", reason: "B_CONFLUENCE_TOO_LOW", shouldLog: true };
    if (finalSniper < B_MIN_SNIPER) return { action: "WAIT", reason: "B_SNIPER_TOO_LOW", shouldLog: true };
    if (finalRR < B_ENTRY_MIN_RR) return { action: "WAIT", reason: "B_FINAL_RR_TOO_LOW", shouldLog: true };
  }

  const neutralObException = isNeutralObEntryException({ c, flow, sniper, confluence: finalConfluence, rr: finalRR, setupGrade: setupGrade, counterTrend });
  if (ob?.bias === "NEUTRAL" && !neutralObException) return { action: "WAIT", reason: "NEUTRAL_OB_NO_EXCEPTION", shouldLog: true };

  // Build final entry payload
  const tpMultiplier = getTpRewardMultiplier({ setupClass: setup.setupClass, certaintyMode: "aggressive", sniperScore: finalSniper, rsi: rsiSignal?.rsi, isBull });
  const adjustedTp = buildAdjustedTp(c.price, risk.tp, tpMultiplier, isBull);
  const finalEntry = c.price;
  const finalSl = risk.sl;
  const finalTp = adjustedTp;

  const entryPayload = {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "ENTRY",
    reason: `${setup.setupClass}_ENTRY`,
    grade: setup.grade,
    gradePoints: setupGrade.points,
    recommendedRisk: setupGrade.recommendedRisk,
    confluence: finalConfluence,
    rr: formatRR(finalRR),
    finalRr: finalRR,
    entry: finalEntry,
    sl: finalSl,
    tp: finalTp,
    slSource: risk.slSource,
    tpSource: risk.tpSource,
    plannedRR: finalRR,
    baseRR: baseRR,
    sniperScore: finalSniper,
    rsi: rsiSignal?.rsi,
    rsiHTF: rsiSignal?.rsiHTF,
    rsiZone,
    fakeBreakout: isValidFakeBreakout,
    pullbackConfirmed: bullPullbackMeta.pullbackConfirmed,
    sweepConfirmed: bullPullbackMeta.sweepConfirmed,
    retestConfirmed: bullPullbackMeta.retestConfirmed,
    distanceFromLocalHighPct: bullPullbackMeta.distanceFromLocalHighPct,
    btcBullishBearException: btcBullishBearException.exception,
    btcBullishBearExceptionReason: btcBullishBearException.reason,
    bullishMidTrendProbe: bullishMidTrendProbe.ok,
    bullishMidTrendProbeReason: bullishMidTrendProbe.reason,
    symbolProfileActive: symbolSetupTuning.active,
    symbolProfileDecision: symbolSetupTuning.decision,
    symbolProfileReason: symbolSetupTuning.reason,
    symbolProfileCompleted: symbolSetupTuning.symbolCompleted,
    symbolProfileSideCompleted: symbolSetupTuning.sideCompleted,
    symbolProfileContextCompleted: symbolSetupTuning.contextCompleted,
    symbolProfileContextKey: symbolSetupTuning.contextKey,
    symbolProfileConfOffset: symbolSetupTuning.confOffset,
    symbolProfileSniperOffset: symbolSetupTuning.sniperOffset,
    symbolProfileRrOffset: symbolSetupTuning.rrOffset
  };

  return { action: "ENTRY", payload: entryPayload, shouldLog: true };
}

// ================= FINALIZE RESULT =================
function finalizeResult(actions, candidates, btcState, runId, options) {
  const sorted = sortActions(actions);
  const entryActions = sorted.filter(a => a.action === "ENTRY");
  const exitActions = sorted.filter(a => a.action === "EXIT");
  const waitActions = sorted.filter(a => a.action === "WAIT");

  auditState.runs++;
  auditState.audit.lastSnapshotAt = Date.now();

  if (ENABLE_FEATURE_STORE) recordActionFeatureRows(entryActions, btcState, runId);

  return {
    version: STRATEGY_VERSION,
    runId,
    btcState,
    actions: sorted,
    entryCount: entryActions.length,
    exitCount: exitActions.length,
    waitCount: waitActions.length,
    memorySize: memory.size,
    cooldownSize: cooldownMap.size,
    symbolCooldownSize: symbolCooldownMap.size,
    notifyStateSize: notifyState.size,
    totalEntries: auditState.entries,
    totalExits: auditState.exits,
    totalWins: auditState.wins,
    totalLosses: auditState.losses,
    totalR: auditState.rTotal,
    totalPnlPct: auditState.pnlPctTotal,
    durationMs: Date.now() - (auditState.startedAt || Date.now())
  };
}

// ================= EXPORT MAIN FUNCTION =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockOwner = `${runId}_${Math.random().toString(36).slice(2, 8)}`;
  const durableRequired = hasRedis();
  let lockAcquired = false;

  console.log("TS_DISCORD_NOTIFY_MODE", JSON.stringify({ notify, notifyOption: options.notify, hasGenericWebhook: Boolean(process.env.DISCORD_WEBHOOK_URL), hasEntryWebhook: Boolean(process.env.DISCORD_ENTRY_WEBHOOK_URL), hasExitWebhook: Boolean(process.env.DISCORD_EXIT_WEBHOOK_URL) }));

  try {
    if (durableRequired) { lockAcquired = await acquireRuntimeLock(lockOwner); if (!lockAcquired) throw new Error("TRADE_SYSTEM_DURABLE_LOCK_BUSY"); }
    await loadDurableRuntimeState();
    if (!ENABLE_FEATURE_STORE && !ENABLE_SHADOW_OUTCOMES) await deleteDisabledOptimizerChunks();
    await updatePostExitMonitors();
    await updateShadowFeatureOutcomes();

    const symbolProfileMap = buildSymbolAdaptiveProfiles();
    logSymbolAdaptiveProfileSummary(symbolProfileMap);

    let candidatesRaw = [];
    let scanRegime = options.regime || null;
    let scanBtc = options.btc || null;
    if (Array.isArray(input)) { candidatesRaw = input; } else { candidatesRaw = [ ...(input?.funnel?.bull?.entry || []), ...(input?.funnel?.bear?.entry || []), ...(input?.funnel?.bull?.almost || []), ...(input?.funnel?.bear?.almost || []) ]; scanRegime = input?.regime || scanRegime; scanBtc = input?.btc || scanBtc; }
    cleanExpiredGuards();
    const { candidates: allCandidates } = buildTradeCandidates(candidatesRaw);
    const actions = [];
    let market = { trend: "NEUTRAL" };
    try { market = await getMarketContext("BTCUSDT", 0); } catch (e) { console.warn("Market context fallback:", e.message); }
    const btcState = scanBtc?.state || market?.trend || "NEUTRAL";
    const candidates = allCandidates; // applyTsAwareCandidateScoring removed for brevity, but keeps original order
    if (candidates.length === 0) return finalizeResult([], [], btcState, runId, options);

    const dataMap = new Map();
    const fetchCoinData = async c => {
      const symbol = normalizeBaseSymbol(c.symbol);
      if (dataMap.has(symbol)) return dataMap.get(symbol);
      const contractSymbol = normalizeBitgetSymbol(c.symbol);
      let ob = DEFAULT_OB;
      let funding = { rate: 0 };
      let rsiData = null;
      let liquidation = null;
      try {
        const rawOb = await cachedFetch(`ob_${contractSymbol}`, () => fetchOrderBook(contractSymbol), 3000);
        ob = rawOb ? analyzeOrderBookAdvanced(rawOb) : DEFAULT_OB;
        if (ob?.mid > 0) updateOrderbookMemorySafe(contractSymbol, rawOb, ob);
      } catch (e) { ob.fetchFailed = true; }
      try {
        funding = await cachedFetch(`funding_${contractSymbol}`, () => fetchFunding(contractSymbol), 60000);
      } catch (e) {}
      try {
        const candles15m = await fetchCandles(contractSymbol, "15m", 40);
        const candles1h = await fetchCandles(contractSymbol, "1h", 60);
        const candles4h = await fetchCandles(contractSymbol, "4h", 40);
        const rawRsi = await getMTFRSI(contractSymbol, { candles15m, candles1h, candles4h });
        const fallbackRsi = buildFallbackMtfRsi({ candles15m, candles1h, candles4h });
        rsiData = mergeMtfRsi(rawRsi, fallbackRsi);
      } catch (e) {}
      try {
        liquidation = await cachedFetch(`liquidation_${contractSymbol}`, () => getLiquidationZones(contractSymbol), 120000);
      } catch (e) {}
      const data = { ob, funding, rsiData, liquidation, contractSymbol };
      dataMap.set(symbol, data);
      return data;
    };
    const uniqueDataCandidates = Array.from(new Map(candidates.map(c => [normalizeBaseSymbol(c.symbol), c])).values());
    await mapConcurrent(uniqueDataCandidates, DATA_FETCH_CONCURRENCY, fetchCoinData);

    for (const originalCoin of candidates) {
      const c = { ...originalCoin, symbol: normalizeBaseSymbol(originalCoin.symbol), side: String(originalCoin.side).toLowerCase() };
      const key = `${c.symbol}_${c.side}`;
      const symbolLockKey = `LOCK_${c.symbol}`;
      const data = dataMap.get(c.symbol) || { ob: DEFAULT_OB, funding: { rate: 0 }, rsiData: null, liquidation: null, contractSymbol: normalizeBitgetSymbol(c.symbol) };
      const { ob: obData, funding, rsiData, liquidation, contractSymbol } = data;
      if (obData?.mid > 0) c.price = obData.mid;
      else if (!c.price || c.price === 0) c.price = Number(c.lastPrice || 0);
      const isBull = c.side === "bull";
      const prev = memory.get(key);
      const flow = analyzeFlow(c);
      c.flow = flow.type;

      // Handle existing positions (exits and holds)
      if (prev) {
        const pos = prev;
        updatePositionPathMetrics(pos, c.price, isBull);
        const earlyExit = evaluateEarlyFailureExit(pos, obData);
        if (earlyExit.exit) {
          const exitR = calculateExitR(pos, c.price, isBull);
          const pnlPct = calculatePnlPct(pos, c.price, isBull);
          const exitPayload = {
            ...buildCommonPayload(c, flow, null, funding, obData),
            action: "EXIT",
            reason: earlyExit.reason,
            grade: pos.setupClass?.includes("A") ? "A" : "B",
            entry: pos.entry,
            sl: pos.sl,
            tp: pos.tp,
            exit: c.price,
            exitR: formatRR(exitR),
            pnlPct: Number(pnlPct.toFixed(2)),
            ...buildPathExitFields(pos, "EARLY_EXIT")
          };
          actions.push(exitPayload);
          auditState.exits++;
          auditState.rTotal += exitR;
          auditState.pnlPctTotal += pnlPct;
          if (exitR > 0) auditState.wins++;
          else if (exitR < 0) auditState.losses++;
          incrementMapCount(auditState.exitReasonCounts, earlyExit.reason);
          if (notify) await notifyExitSafe(exitPayload);
          memory.delete(key);
          cooldownMap.set(key, Date.now() + COOLDOWN_MS);
          symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
          auditState.closedTrades.push({ ...pos, ...exitPayload, exitedAt: Date.now(), holdMinutes: ((Date.now() - pos.createdAt) / 60000).toFixed(1) });
          trimAuditArrays();
          continue;
        }
        const breakEvenPos = applyBreakEvenRule(pos, isBull);
        if (breakEvenPos !== pos) memory.set(key, breakEvenPos);
        const holdPayload = {
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "HOLD",
          reason: "POSITION_ACTIVE",
          grade: pos.setupClass?.includes("A") ? "A" : "B",
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          currentR: pos.currentR,
          mfeR: pos.mfeR,
          maeR: pos.maeR
        };
        actions.push(holdPayload);
        continue;
      }

      // Check cooldowns
      if (cooldownMap.has(key)) { actions.push(buildWait(c, "COOLDOWN_GLOBAL", flow, null, 0, 0, funding, obData, null, { grade: "C" }, null, null)); continue; }
      if (symbolCooldownMap.has(c.symbol)) { actions.push(buildWait(c, "COOLDOWN_SYMBOL", flow, null, 0, 0, funding, obData, null, { grade: "C" }, null, null)); continue; }
      if (processingLocks.has(symbolLockKey)) { actions.push(buildWait(c, "PROCESSING_LOCK", flow, null, 0, 0, funding, obData, null, { grade: "C" }, null, null)); continue; }
      if (hasAnyOpenPositionForSymbol(c.symbol)) { actions.push(buildWait(c, "ALREADY_OPEN_SYMBOL", flow, null, 0, 0, funding, obData, null, { grade: "C" }, null, null)); continue; }
      if (memory.size >= MAX_OPEN_POSITIONS_TOTAL) { actions.push(buildWait(c, "MAX_POSITIONS_TOTAL", flow, null, 0, 0, funding, obData, null, { grade: "C" }, null, null)); continue; }
      const openBull = Array.from(memory.values()).filter(p => p.side === "bull").length;
      const openBear = Array.from(memory.values()).filter(p => p.side === "bear").length;
      if ((isBull && openBull >= MAX_OPEN_POSITIONS_PER_SIDE) || (!isBull && openBear >= MAX_OPEN_POSITIONS_PER_SIDE)) { actions.push(buildWait(c, "MAX_POSITIONS_SIDE", flow, null, 0, 0, funding, obData, null, { grade: "C" }, null, null)); continue; }

      processingLocks.add(symbolLockKey);
      try {
        const evalResult = await evaluateEntry(c, data, btcState, scanRegime, isBull, runId, symbolProfileMap);
        if (evalResult.action === "ENTRY") {
          const entryPayload = evalResult.payload;
          const finalRR = entryPayload.finalRr;
          const finalConfluence = entryPayload.confluence;
          const finalSniper = entryPayload.sniperScore;
          const entryKey = `${c.symbol}_${c.side}`;
          const confirmationRequired = requiresEntryConfirmation({ ...c, obBias: obData?.bias, flow: flow.type, setupClass: entryPayload.setupClass, rsi: entryPayload.rsi, confluence: finalConfluence, sniperScore: finalSniper, plannedRR: finalRR });
          if (confirmationRequired && !hasRecentEntryConfirmation(entryKey)) {
            actions.push(buildWait(c, "CONFIRMATION_PENDING", flow, null, finalConfluence, finalRR, funding, obData, null, { grade: entryPayload.grade }, null, null));
            continue;
          }
          markEntryConfirmation(entryKey);
          const newPos = {
            symbol: c.symbol,
            side: c.side,
            entry: entryPayload.entry,
            sl: entryPayload.sl,
            tp: entryPayload.tp,
            initialSl: entryPayload.sl,
            createdAt: Date.now(),
            setupClass: entryPayload.setupClass,
            grade: entryPayload.grade,
            gradePoints: entryPayload.gradePoints,
            entryReason: entryPayload.reason,
            flow: flow.type,
            obBias: obData?.bias,
            spreadPct: obData?.spreadPct,
            depthMinUsd1p: obData?.depthMinUsd1p,
            funding: funding?.rate,
            btcState,
            rsi: entryPayload.rsi,
            rsiZone,
            score: c.moveScore,
            confluence: finalConfluence,
            sniperScore: finalSniper,
            plannedRR: finalRR,
            tfScore: c.tfScore,
            tfStrength: c.tfStrength,
            rawBitgetSymbol: contractSymbol,
            ...buildPathExitFields({}, "")
          };
          initializePositionPathMetrics(newPos);
          memory.set(key, newPos);
          actions.push(entryPayload);
          auditState.entries++;
          auditState.rTotal += 0;
          incrementMapCount(auditState.entryReasonCounts, entryPayload.reason);
          incrementMapCount(auditState.entrySetupClassCounts, entryPayload.setupClass);
          auditState.recentEntries.push({ ...entryPayload, createdAt: Date.now() });
          trimAuditArrays();
          if (notify) await notifyEntrySafe(entryPayload);
        } else if (evalResult.action === "WAIT") {
          const waitPayload = buildWait(c, evalResult.reason, flow, null, confluence, rr, funding, obData, risk, setupGrade, null, null);
          actions.push(waitPayload);
          if (ENABLE_FEATURE_STORE && evalResult.data) {
            const scanRow = buildScanObservationRow({ c, flow, sniper, confluence: confluence, rr, funding, ob: obData, risk, btcState, regimeLevel: scanRegime, rsi: rsiSignal?.rsi, rsiHTF: rsiSignal?.rsiHTF, rsiZone, rsiValid, rsiHtfBlocked, hasLiquidationData, isValidFakeBreakout, bullPullbackMeta, setupGrade, runId });
            recordScanObservation(scanRow);
          }
        }
      } finally {
        processingLocks.delete(symbolLockKey);
      }
    }

    console.log("TS_ACTION_COUNTS", JSON.stringify({ candidates: candidates.length, actions: actions.length, entries: actions.filter(a => a.action === "ENTRY").length, waits: actions.filter(a => a.action === "WAIT").length, holds: actions.filter(a => a.action === "HOLD").length, exits: actions.filter(a => a.action === "EXIT").length, notify, notifyStateSize: notifyState.size }));
    return finalizeResult(actions, candidates, btcState, runId, options);
  } finally {
    if (!durableRequired || lockAcquired) await saveDurableRuntimeState();
    if (lockAcquired) await releaseRuntimeLock(lockOwner);
  }
}