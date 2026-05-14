// ================= TRADESYSTEM.JS (DIAGNOSTIC VERSION WITH RELAXED FILTERS) =================

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
const STRATEGY_VERSION = "TS_V12_1_A_ONLY_CALIBRATION";

// ================= OPTIMIZER / FEATURE FLAGS =================
const ENABLE_TS_OPTIMIZER = false;
const ENABLE_FEATURE_STORE = false;
const ENABLE_SHADOW_OUTCOMES = false;
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

const GRADE_A_MIN_RR_FLOOR = 1.05;
const GRADE_B_MIN_RR_FLOOR = 1.08;
const GRADE_C_MIN_RR_FLOOR = 1.08;

const A_ENTRY_MIN_RR = 1.20;
const B_ENTRY_MIN_RR = 1.08;
const GOD_ENTRY_MIN_RR = 1.25;

const A_MIN_SNIPER = 65;              // was 48
const A_MIN_CONFLUENCE = 78;          // was 60
const B_MIN_SNIPER = 70;              // was 40
const B_MIN_CONFLUENCE = 72;          // was 58

const GOD_MIN_SNIPER = 85;
const GOD_MIN_CONFLUENCE = 88;

const MID_RSI_MIN_CONFLUENCE = 78;
const TREND_CONTINUATION_MIN_CONFLUENCE = 75;
const TREND_CONTINUATION_MIN_SNIPER = 72;

const A_FINAL_MIN_RR = 1.20;         
const A_GOD_MAX_TP_REWARD_MULTIPLIER = 1.25;

const ENABLE_B_ENTRIES = false;
const ENABLE_BULLISH_MID_TREND_PROBES = false;

const BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE = 60;
const BULLISH_MID_TREND_PROBE_MIN_SNIPER = 42;
const BULLISH_MID_TREND_PROBE_MIN_RR = 1.12;
const BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT = 0.00110;
const BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P = 60_000;

const BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH = true;

const BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT = 0.08;
const BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT = 0.80;
const BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT = 0.0010;

const MIN_DEPTH_USD_1P_ABSOLUTE = 75_000;
const A_MIN_DEPTH_USD_1P = 75_000;
const BULL_TREND_MIN_DEPTH_USD_1P = 150_000;

const REQUIRE_BULL_TREND_PULLBACK = true;
const MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT = 0.012;

const ENABLE_BTC_BULLISH_BEAR_EXCEPTION = true;
const BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P = 100_000;   // PATCHED: was 100_000
const BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT = 0.0008;    // PATCHED: was 0.0008
const BTC_BULLISH_BEAR_EXCEPTION_MIN_RR = 1.25;               // PATCHED: was 1.25
const BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF = 72;               // PATCHED: was 50
const BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF = 100;              // PATCHED: unchanged
const BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER = 70;             // PATCHED: was TREND_CONTINUATION_MIN_SNIPER

const SHORT_BLOCKED_RSI_ZONES = ["LOWER_3"];

const BREAK_EVEN_TRIGGER_R = 0.75;
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
const TF_MIN_STRENGTH = 2;
const GLOBAL_MIN_CONFLUENCE = 55;          // was 52
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
const NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE = 82;   // was 74
const NEUTRAL_OB_A_EXCEPTION_MIN_RR = 1.20;
const NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER = 82;
const NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE = 80;
const NEUTRAL_OB_B_EXCEPTION_MIN_RR = 1.15;
const NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER = 75;
const NEUTRAL_OB_B_EXCEPTION_MIN_SCORE = 78;
const SHADOW_DUPLICATE_COOLDOWN_MS = 30 * 60 * 1000;

const ENABLE_FALLBACK_RISK_GEOMETRY = true;
const DATA_FETCH_CONCURRENCY = 4;
const MIN_EXTERNAL_SCORE_HEALTH = 12;

// ================= PATCH 3: nieuwe constante voor MID RSI continuation discount =================
const MID_RSI_CONTINUATION_RR_DISCOUNT = 0.05;

// ================= V12 QUALITY GATES =================
const ENABLE_ENTRY_QUALITY_GATE_V12 = true;

const QUALITY_LOW_RR_THRESHOLD = 1.15;
const QUALITY_LOW_RR_MIN_SNIPER = 84;
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

// ================= PATCH 4: SAVE DURABLE STATE MET CONDITIONELE CHUNKS =================
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

    const featureInfo = ENABLE_FEATURE_STORE
      ? await writeJsonArrayChunks({
          metaKey: RUNTIME_FEATURE_META_KEY,
          chunkPrefix: RUNTIME_FEATURE_CHUNK_PREFIX,
          rows: featureStore,
          previousChunkCount: Number(previousFeatureMeta?.chunks || 0)
        })
      : { chunks: 0, rows: 0, bytesTotal: 0 };

    const shadowInfo = ENABLE_SHADOW_OUTCOMES
      ? await writeJsonArrayChunks({
          metaKey: RUNTIME_SHADOW_META_KEY,
          chunkPrefix: RUNTIME_SHADOW_CHUNK_PREFIX,
          rows: shadowOutcomes,
          previousChunkCount: Number(previousShadowMeta?.chunks || 0)
        })
      : { chunks: 0, rows: 0, bytesTotal: 0 };

    if (!ENABLE_FEATURE_STORE || !ENABLE_SHADOW_OUTCOMES) {
      await deleteDisabledOptimizerChunks();
    }

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
      console.warn(`Candle fetch error voor ${clean}, attempt ${attempt + 1}:`, e.message);
      if (attempt < 1) {
        await sleep(250);
        continue;
      }
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
    // PATCH 3: added rrDiscount for continuation
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

// ================= PATCH 6A: BREAK-EVEN VOOR A_SHORT_EXCEPTION =================
function applyBreakEvenRule(position, isBull) {
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
  return;
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
  return values
    .map(Number)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
}

function tsAvg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return tsSum(arr) / arr.length;
}

function tsProfitFactor(rows) {
  const rValues = rows
    .map(row => Number(row.exitR))
    .filter(Number.isFinite);

  const grossWin = rValues
    .filter(r => r > 0)
    .reduce((sum, r) => sum + r, 0);

  const grossLoss = Math.abs(
    rValues
      .filter(r => r < 0)
      .reduce((sum, r) => sum + r, 0)
  );

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
  return (
    key.startsWith("A_") ||
    key.startsWith("GOD_") ||
    key.startsWith("NEUTRAL_OB_A_") ||
    key === "SETUP_GRADE_A_MIN_POINTS" ||
    key === "A_MIN_DEPTH_USD_1P" ||
    key === "A_GOD_MAX_TP_REWARD_MULTIPLIER"
  );
}

function isTsBOnlyKey(key) {
  return (
    key.startsWith("B_") ||
    key.startsWith("NEUTRAL_OB_B_") ||
    key === "ENABLE_B_ENTRIES" ||
    key === "SETUP_GRADE_B_MIN_POINTS" ||
    key.startsWith("BULLISH_MID_TREND_PROBE_") ||
    key === "ENABLE_BULLISH_MID_TREND_PROBES"
  );
}

function getTsOptimizationKeys(target) {
  const keys = tsMasterFilterKeys();

  if (target === "A") {
    return keys.filter(key => !isTsBOnlyKey(key));
  }

  if (target === "B") {
    return keys.filter(key => !isTsAOnlyKey(key));
  }

  return keys;
}

function stableTsPresetKey(preset) {
  return JSON.stringify(
    Object.keys(preset)
      .sort()
      .reduce((out, key) => {
        out[key] = preset[key];
        return out;
      }, {})
  );
}

function uniqueTsValues(values) {
  const map = new Map();

  for (const value of values) {
    map.set(JSON.stringify(value), value);
  }

  return Array.from(map.values());
}

function tsCandidateValues(key, currentValue, target) {
  if (typeof currentValue === "boolean") {
    return [currentValue, !currentValue];
  }

  if (Array.isArray(currentValue)) {
    if (key === "SHORT_BLOCKED_RSI_ZONES") {
      return [
        currentValue,
        [],
        ["LOWER_3"],
        ["LOWER_2", "LOWER_3"],
        ["LOWER_1", "LOWER_2", "LOWER_3"]
      ];
    }

    if (key === "SHORT_LOWER1_ALLOWED_BTC_STATES") {
      return [
        currentValue,
        ["BEARISH", "STRONG_BEAR", "NEUTRAL"],
        ["BEARISH", "STRONG_BEAR"],
        ["NEUTRAL"],
        []
      ];
    }

    return [currentValue];
  }

  const v = Number(currentValue);

  if (!Number.isFinite(v)) return [currentValue];

  if (key.includes("SPREAD")) {
    return uniqueTsValues([
      Number((v * 0.75).toFixed(6)),
      Number((v * 0.90).toFixed(6)),
      Number(v.toFixed(6)),
      Number((v * 1.10).toFixed(6)),
      Number((v * 1.25).toFixed(6))
    ]).filter(n => n > 0);
  }

  if (key.includes("DEPTH")) {
    return uniqueTsValues([
      Math.max(10000, Math.round(v * 0.70)),
      Math.max(10000, Math.round(v * 0.85)),
      Math.round(v),
      Math.round(v * 1.15),
      Math.round(v * 1.35)
    ]);
  }

  if (key.includes("RR") || key.includes("TRIGGER_R") || key.includes("LOCK_R")) {
    return uniqueTsValues([
      Number((v - 0.20).toFixed(2)),
      Number((v - 0.10).toFixed(2)),
      Number(v.toFixed(2)),
      Number((v + 0.10).toFixed(2)),
      Number((v + 0.20).toFixed(2))
    ]).filter(n => n >= 0);
  }

  if (
    key.includes("CONFLUENCE") ||
    key.includes("SNIPER") ||
    key.includes("SCORE") ||
    key.includes("POINTS")
  ) {
    return uniqueTsValues([
      Math.max(0, Math.round(v - 8)),
      Math.max(0, Math.round(v - 4)),
      Math.round(v),
      Math.round(v + 4),
      Math.round(v + 8)
    ]);
  }

  if (
    key.includes("MOVE") ||
    key.includes("CHANGE") ||
    key.includes("DISTANCE") ||
    key.includes("PULLBACK")
  ) {
    return uniqueTsValues([
      Number((v - 0.20).toFixed(4)),
      Number((v - 0.10).toFixed(4)),
      Number(v.toFixed(4)),
      Number((v + 0.10).toFixed(4)),
      Number((v + 0.20).toFixed(4))
    ]);
  }

  if (key.includes("FUNDING")) {
    return uniqueTsValues([
      Number((v * 0.75).toFixed(4)),
      Number(v.toFixed(4)),
      Number((v * 1.25).toFixed(4))
    ]);
  }

  return uniqueTsValues([
    Number((v * 0.85).toFixed(4)),
    Number(v.toFixed(4)),
    Number((v * 1.15).toFixed(4))
  ]);
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

    distanceFromLocalHighPct: safeNumber(
      row?.distanceFromLocalHighPct ??
      row?.bullDistanceFromLocalHighPct ??
      row?.distanceHighPct,
      0
    ),

    pullbackFromHighPct: safeNumber(
      row?.pullbackFromHighPct ??
      row?.bullPullbackFromHighPct ??
      row?.pullbackPct,
      0
    ),

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

  const isGod =
    rr >= safeNumber(preset.GOD_ENTRY_MIN_RR, 0) &&
    sniper >= safeNumber(preset.GOD_MIN_SNIPER, 0) &&
    conf >= safeNumber(preset.GOD_MIN_CONFLUENCE, 0);

  if (isGod) {
    return {
      setupClass: "GOD",
      liveGrade: "A",
      entryType: "GOD_ENTRY"
    };
  }

  const isA =
    rr >= Math.max(
      safeNumber(preset.A_ENTRY_MIN_RR, 0),
      safeNumber(preset.A_FINAL_MIN_RR, 0)
    ) &&
    sniper >= safeNumber(preset.A_MIN_SNIPER, 0) &&
    conf >= safeNumber(preset.A_MIN_CONFLUENCE, 0);

  if (isA) {
    return {
      setupClass: "A",
      liveGrade: "A",
      entryType: "A_ENTRY"
    };
  }

  const isBullishMidTrendProbe =
    preset.ENABLE_BULLISH_MID_TREND_PROBES === true &&
    row.side === "bull" &&
    row.rsiZone === "MID" &&
    (!preset.BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH || ["BULLISH", "STRONG_BULL"].includes(row.btcState)) &&
    conf >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE, 0) &&
    sniper >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_SNIPER, 0) &&
    rr >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_RR, 0) &&
    row.spreadPct <= safeNumber(preset.BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT, 1) &&
    row.depthMinUsd1p >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P, 0) &&
    row.change1h >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT, 0) &&
    row.change24 >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT, 0) &&
    row.pullbackFromHighPct >= safeNumber(preset.BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT, 0);

  if (isBullishMidTrendProbe) {
    return {
      setupClass: "BULLISH_MID_TREND_PROBE",
      liveGrade: "B",
      entryType: "BULLISH_MID_TREND_PROBE"
    };
  }

  const isB =
    preset.ENABLE_B_ENTRIES !== false &&
    rr >= safeNumber(preset.B_ENTRY_MIN_RR, 0) &&
    sniper >= safeNumber(preset.B_MIN_SNIPER, 0) &&
    conf >= safeNumber(preset.B_MIN_CONFLUENCE, 0);

  if (isB) {
    return {
      setupClass: "B",
      liveGrade: "B",
      entryType: "B_ENTRY"
    };
  }

  const btcBullishBearException =
    preset.ENABLE_BTC_BULLISH_BEAR_EXCEPTION === true &&
    row.side === "bear" &&
    ["BULLISH", "STRONG_BULL"].includes(row.btcState) &&
    row.depthMinUsd1p >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P, 0) &&
    row.spreadPct <= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT, 1) &&
    rr >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_RR, 0) &&
    conf >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF, 0) &&
    conf <= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF, 1000) &&
    sniper >= safeNumber(preset.BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER, 0);

  if (btcBullishBearException) {
    return {
      setupClass: "BTC_BULLISH_BEAR_EXCEPTION",
      liveGrade: "B",
      entryType: "BTC_BULLISH_BEAR_EXCEPTION"
    };
  }

  return {
    setupClass: "NONE",
    liveGrade: "NONE",
    entryType: "NONE"
  };
}

function tsRowPassesBasePreset(row, preset) {
  if (!row) return false;
  if (row.obFetchFailed) return false;
  if (row.spoof) return false;

  let minScore = safeNumber(preset.CANDIDATE_MIN_SCORE, 0);

  if (row.side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(row.btcState)) {
    minScore = Math.max(minScore, safeNumber(preset.BTC_BEARISH_LONG_MIN_SCORE, 0));
  }

  if (row.btcState === "NEUTRAL") {
    minScore = Math.max(minScore, safeNumber(preset.BTC_NEUTRAL_MIN_SCORE, 0));
  }

  if (row.score < minScore) return false;
  if (row.tfStrength < safeNumber(preset.TF_MIN_STRENGTH, 0)) return false;
  if (row.confluence < safeNumber(preset.GLOBAL_MIN_CONFLUENCE, 0)) return false;

  if (row.volatility === "LOW" && row.confluence < safeNumber(preset.LOW_VOL_MIN_CONFLUENCE, 0)) {
    return false;
  }

  if (["NEUTRAL", "UNKNOWN", "NO_FLOW"].includes(row.flow) && row.confluence < safeNumber(preset.NO_FLOW_MIN_CONFLUENCE, 0)) {
    return false;
  }

  const rr = safeNumber(row.plannedRR || row.rr, 0);

  if (rr < safeNumber(preset.MIN_RR_FLOOR, 0)) return false;

  if (["BUILDING", "BUILDUP"].includes(row.flow) && rr < safeNumber(preset.BUILDUP_MIN_RR_FLOOR, 0)) {
    return false;
  }

  if (!row.structureAligned && rr < safeNumber(preset.COUNTERTREND_MIN_RR_FLOOR, 0)) {
    return false;
  }

  if (row.marketQuality === "BAD" && row.confluence < safeNumber(preset.BAD_MARKET_QUALITY_MIN_CONFLUENCE, 0)) {
    return false;
  }

  if (row.obAgainst && row.confluence < safeNumber(preset.OB_AGAINST_MIN_CONFLUENCE, 0)) {
    return false;
  }

  if (Math.abs(row.funding) > safeNumber(preset.EXTREME_FUNDING_ABS_MAX, 1)) {
    return false;
  }

  if (
    row.side === "bull" &&
    row.funding > safeNumber(preset.BULL_CROWDED_FUNDING_MAX, 1) &&
    row.confluence < safeNumber(preset.CROWDED_FUNDING_MIN_CONFLUENCE, 0)
  ) {
    return false;
  }

  if (
    row.side === "bear" &&
    row.funding < safeNumber(preset.BEAR_CROWDED_FUNDING_MIN, -1) &&
    row.confluence < safeNumber(preset.CROWDED_FUNDING_MIN_CONFLUENCE, 0)
  ) {
    return false;
  }

  if (!row.rsiValid) return false;
  if (row.rsiBlocked) return false;
  if (row.rsiExhaustedAgainstSide) return false;

  function listIncludes(list, value) {
    const v = String(value || "").toUpperCase();

    if (Array.isArray(list)) {
      return list.some(item => String(item || "").toUpperCase() === v);
    }

    if (list instanceof Set) {
      return list.has(v);
    }

    return false;
  }

  if (
    row.side === "bear" &&
    Array.isArray(preset.SHORT_BLOCKED_RSI_ZONES) &&
    listIncludes(preset.SHORT_BLOCKED_RSI_ZONES, row.rsiZone)
  ) {
    return false;
  }

  if (
    row.side === "bear" &&
    row.rsiZone === "LOWER_1" &&
    !listIncludes(preset.SHORT_LOWER1_ALLOWED_BTC_STATES, row.btcState)
  ) {
    return false;
  }

  if (
    row.side === "bear" &&
    row.rsiZone === "LOWER_1" &&
    (
      row.confluence < safeNumber(preset.SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE, 0) ||
      row.sniperScore < safeNumber(preset.SHORT_LOWER1_CONTINUATION_MIN_SNIPER, 0) ||
      rr < safeNumber(preset.SHORT_LOWER1_CONTINUATION_MIN_RR, 0)
    )
  ) {
    return false;
  }

  if (
    row.side === "bull" &&
    row.rsiZone === "LOWER_2" &&
    row.change1h > safeNumber(preset.LONG_LOWER2_MAX_1H_CHANGE, 0)
  ) {
    return false;
  }

  if (
    row.side === "bear" &&
    row.rsiZone === "UPPER_2" &&
    row.change1h < safeNumber(preset.SHORT_UPPER2_MIN_1H_CHANGE, 0)
  ) {
    return false;
  }

  if (
    row.flow === "TREND" &&
    (
      row.confluence < safeNumber(preset.TREND_CONTINUATION_MIN_CONFLUENCE, 0) ||
      row.sniperScore < safeNumber(preset.TREND_CONTINUATION_MIN_SNIPER, 0) ||
      rr < safeNumber(preset.TREND_CONTINUATION_MIN_RR, 0)
    )
  ) {
    return false;
  }

  const maxSpread =
    row.side === "bull" && row.rsiZone === "MID"
      ? safeNumber(preset.MID_BULL_MAX_SPREAD_PCT, preset.MAX_SPREAD_PCT)
      : safeNumber(preset.MAX_SPREAD_PCT, 1);

  if (row.spreadPct > maxSpread) {
    const midBullSpreadException =
      row.side === "bull" &&
      row.rsiZone === "MID" &&
      row.confluence >= safeNumber(preset.MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE, 0) &&
      row.sniperScore >= safeNumber(preset.MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER, 0);

    if (!midBullSpreadException) return false;
  }

  if (row.depthMinUsd1p > 0 && row.depthMinUsd1p < safeNumber(preset.MIN_DEPTH_USD_1P_ABSOLUTE, 0)) {
    return false;
  }

  if (row.depthMinUsd1p > 0 && row.depthMinUsd1p < safeNumber(preset.MIN_DEPTH_USD_1P, 0)) {
    const aDepthException =
      row.depthMinUsd1p >= safeNumber(preset.A_MIN_DEPTH_USD_1P, 0) &&
      row.confluence >= safeNumber(preset.A_MIN_CONFLUENCE, 0) &&
      row.sniperScore >= safeNumber(preset.A_MIN_SNIPER, 0);

    if (!aDepthException) return false;
  }

  if (
    row.side === "bull" &&
    ["TREND", "RUNNING", "BREAKOUT"].includes(row.flow) &&
    row.depthMinUsd1p > 0 &&
    row.depthMinUsd1p < safeNumber(preset.BULL_TREND_MIN_DEPTH_USD_1P, 0)
  ) {
    return false;
  }

  if (
    preset.REQUIRE_BULL_TREND_PULLBACK === true &&
    row.side === "bull" &&
    ["TREND", "RUNNING", "BREAKOUT"].includes(row.flow) &&
    row.distanceFromLocalHighPct > safeNumber(preset.MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT, 1)
  ) {
    return false;
  }

  if (
    row.rsiZone === "MID" &&
    row.confluence < safeNumber(preset.MID_RSI_MIN_CONFLUENCE, 0)
  ) {
    return false;
  }

  return true;
}

function wouldTsEnterUnderPreset(row, preset) {
  if (!tsRowPassesBasePreset(row, preset)) return false;

  const inferred = inferTsSetupFromPreset(row, preset);

  if (inferred.setupClass === "NONE") return false;

  const rr = safeNumber(row.plannedRR || row.rr, 0);

  if (inferred.liveGrade === "A" && rr < safeNumber(preset.GRADE_A_MIN_RR_FLOOR, 0)) {
    return false;
  }

  if (inferred.liveGrade === "B" && rr < safeNumber(preset.GRADE_B_MIN_RR_FLOOR, 0)) {
    return false;
  }

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

    kept.push({
      ...row,
      inferredSetupClass: inferred.setupClass,
      inferredEntryType: inferred.entryType,
      inferredLiveGrade: inferred.liveGrade
    });
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

  const directSL = kept.filter(row => {
    return safeNumber(row.exitR, 0) < 0 && safeNumber(row.mfeR, 0) < 0.25;
  }).length;

  const nearTpThenLoss = kept.filter(row => {
    return (
      safeNumber(row.exitR, 0) < 0 &&
      safeNumber(row.plannedRR, 0) > 0 &&
      safeNumber(row.mfeR, 0) >= safeNumber(row.plannedRR, 0) * 0.80
    );
  }).length;

  const keepRatio = rows.length ? kept.length / rows.length : 0;
  const directSLPctNum = completed ? directSL / completed : 0;
  const nearTpThenLossPctNum = completed ? nearTpThenLoss / completed : 0;

  const profitFactorR = tsProfitFactor(kept);

  const setupClassCounts = kept.reduce((acc, row) => {
    const key = row.inferredSetupClass || "UNKNOWN";
    acc[key] = safeNumber(acc[key], 0) + 1;
    return acc;
  }, {});

  const sourceCounts = kept.reduce((acc, row) => {
    const key = row.source || "UNKNOWN";
    acc[key] = safeNumber(acc[key], 0) + 1;
    return acc;
  }, {});

  const moneyProjection = buildTsMoneyProjection(kept, {
    startBalance: TS_MASTER_START_BALANCE_EUR,
    marginPerTrade: TS_MASTER_MARGIN_PER_TRADE_EUR,
    leverage: TS_MASTER_LEVERAGE
  });

  const statsRow = {
    filters: preset,
    target,

    universeRows: rows.length,
    kept: kept.length,
    rejected: rows.length - kept.length,
    keepRatio: tsRound(keepRatio, 4),

    completed,
    wins,
    losses,
    flats,

    winrate: tsPct(winrateNum),
    winrateNum: tsRound(winrateNum, 4),

    totalR: tsRound(totalR, 3),
    avgR: tsRound(avgR, 3),

    totalPnlPct: tsRound(totalPnlPct, 3),
    avgPnlPct: tsRound(avgPnlPct, 3),

    profitFactorR: tsRound(profitFactorR, 3),

    directSL,
    directSLPctNum: tsRound(directSLPctNum, 4),
    directSLPct: tsPct(directSLPctNum),

    nearTpThenLoss,
    nearTpThenLossPctNum: tsRound(nearTpThenLossPctNum, 4),
    nearTpThenLossPct: tsPct(nearTpThenLossPctNum),

    setupClassCounts,
    sourceCounts,

    moneyProjection,

    examples: kept.slice(-12).map(row => ({
      source: row.source,
      symbol: row.symbol,
      side: row.side,
      oldReason: row.oldReason,
      oldSetupClass: row.oldSetupClass,
      oldEntryType: row.oldEntryType,
      inferredSetupClass: row.inferredSetupClass,
      inferredEntryType: row.inferredEntryType,
      inferredLiveGrade: row.inferredLiveGrade,
      flow: row.flow,
      scannerFlow: row.scannerFlow,
      rsiZone: row.rsiZone,
      obBias: row.obBias,
      score: row.score,
      confluence: row.confluence,
      sniperScore: row.sniperScore,
      rr: row.plannedRR,
      spreadPct: row.spreadPct,
      depthMinUsd1p: row.depthMinUsd1p,
      change1h: row.change1h,
      change24: row.change24,
      exitR: row.exitR,
      pnlPct: row.pnlPct,
      mfeR: row.mfeR,
      maeR: row.maeR
    }))
  };

  return {
    ...statsRow,
    decisionScore: scoreTsMasterStats(statsRow, keepRatio)
  };
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

  const raw =
    winrate * 70 +
    totalPnlPct * 2.4 +
    avgPnlPct * 28 +
    totalR * 1.8 +
    avgR * 35 +
    profitFactor * 12 +
    keepRatio * 7 -
    directSLPct * 65 -
    nearTpThenLossPct * 25;

  return tsRound(raw * sampleConfidence, 4);
}

function buildTsMasterSeedPresets(current, target) {
  const base = { ...current };

  const discovery = {
    ...base,

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

  const quality = {
    ...base,

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

  const winrate = {
    ...quality,

    GLOBAL_MIN_CONFLUENCE: quality.GLOBAL_MIN_CONFLUENCE + 2,
    A_MIN_CONFLUENCE: quality.A_MIN_CONFLUENCE + 2,
    B_MIN_CONFLUENCE: quality.B_MIN_CONFLUENCE + 2,

    DIRECT_SL_AVOIDANCE_MODE: true
  };

  if (target === "B") {
    return [
      base,
      discovery,
      {
        ...discovery,
        ENABLE_B_ENTRIES: true,
        B_MIN_CONFLUENCE: Math.min(discovery.B_MIN_CONFLUENCE, 58),
        B_MIN_SNIPER: Math.min(discovery.B_MIN_SNIPER, 48)
      }
    ];
  }

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

  const minCompleted = target === "COMBINED"
    ? TS_MASTER_MIN_SAMPLE
    : TS_MASTER_MIN_CLASS_SAMPLE;

  if (rows.length < minCompleted) {
    return {
      target,
      decision: "SAMPLE_TOO_SMALL_KEEP_CURRENT",
      sample: {
        usableRows: rows.length,
        completed: currentEval.completed,
        minRequired: minCompleted,
        confidence: "LOW"
      },
      current: currentEval,
      best: currentEval,
      deltaVsCurrent: buildTsDelta(currentEval, currentEval),
      changedKeys: [],
      coverageOk: true,
      missingFilters: []
    };
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
          const next = {
            ...preset,
            [key]: value
          };

          candidateMap.set(stableTsPresetKey(next), next);
        }
      }
    }

    const evaluated = Array.from(candidateMap.values())
      .map(preset => evaluateTsPresetOnAllCoins(rows, preset, target))
      .sort((a, b) => {
        return scoreTsEvalForSearch(b, minCompleted) - scoreTsEvalForSearch(a, minCompleted);
      });

    if (!evaluated.length) break;

    beam = evaluated
      .slice(0, TS_MASTER_BEAM_WIDTH)
      .map(result => result.filters);
  }

  const finalEvaluated = beam
    .map(preset => evaluateTsPresetOnAllCoins(rows, preset, target))
    .sort((a, b) => {
      return scoreTsEvalForSearch(b, minCompleted) - scoreTsEvalForSearch(a, minCompleted);
    });

  const validEvaluated = finalEvaluated
    .filter(result => result.completed >= minCompleted)
    .filter(result => result.totalR > 0)
    .filter(result => result.totalPnlPct > 0)
    .sort((a, b) => b.decisionScore - a.decisionScore);

  const best = validEvaluated[0] || finalEvaluated[0] || currentEval;

  const changedKeys = tsMasterFilterKeys()
    .filter(key => JSON.stringify(best.filters[key]) !== JSON.stringify(currentPreset[key]))
    .map(key => ({
      parameter: key,
      currentValue: currentPreset[key],
      suggestedValue: best.filters[key]
    }));

  const missingFilters = tsMasterFilterKeys()
    .filter(key => !Object.prototype.hasOwnProperty.call(best.filters, key));

  return {
    target,
    decision: missingFilters.length
      ? "BEST_PRESET_FOUND_BUT_FILTER_COVERAGE_INCOMPLETE"
      : best.completed >= minCompleted && best.totalR > 0 && best.totalPnlPct > 0
        ? `BEST_TS_${target}_WINRATE_PNL_AFSTELLING`
        : `BEST_TS_${target}_LOW_SAMPLE_OR_NO_EDGE_AFSTELLING`,

    sample: {
      usableRows: rows.length,
      completed: best.completed,
      minRequired: minCompleted,
      confidence:
        best.completed >= 100
          ? "HIGH"
          : best.completed >= 40
            ? "MEDIUM"
            : best.completed >= minCompleted
              ? "LOW"
              : "VERY_LOW"
    },

    current: currentEval,
    best,

    deltaVsCurrent: buildTsDelta(best, currentEval),

    changedKeys,

    coverageOk: missingFilters.length === 0,
    missingFilters
  };
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

  const merged = {
    ...current,
    ...combinedPreset
  };

  for (const key of tsMasterFilterKeys()) {
    if (isTsAOnlyKey(key)) {
      merged[key] = aPreset[key];
      continue;
    }

    if (isTsBOnlyKey(key)) {
      merged[key] = bPreset[key];
      continue;
    }
  }

  merged.MIN_DEPTH_USD_1P_ABSOLUTE = Math.max(
    safeNumber(merged.MIN_DEPTH_USD_1P_ABSOLUTE, MIN_DEPTH_USD_1P_ABSOLUTE),
    MIN_DEPTH_USD_1P_ABSOLUTE
  );

  return merged;
}

function tsPatchValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function buildTsPatchLinesFromPreset(preset) {
  return tsMasterFilterKeys().map(key => {
    if (
      key === "SHORT_BLOCKED_RSI_ZONES" ||
      key === "SHORT_LOWER1_ALLOWED_BTC_STATES"
    ) {
      return `const ${key} = ${JSON.stringify(Array.from(preset[key] || []))};`;
    }

    return `const ${key} = ${tsPatchValue(preset[key])};`;
  });
}

function compactTsOptimizationResult(result) {
  return {
    target: result.target,
    decision: result.decision,
    sample: result.sample,

    expectedPerformance: {
      completed: result.best?.completed || 0,
      wins: result.best?.wins || 0,
      losses: result.best?.losses || 0,
      flats: result.best?.flats || 0,

      winrate: result.best?.winrate || "0.0%",

      totalPnlPct: result.best?.totalPnlPct || 0,
      avgPnlPct: result.best?.avgPnlPct || 0,

      totalR: result.best?.totalR || 0,
      avgR: result.best?.avgR || 0,

      profitFactorR: result.best?.profitFactorR || 0,
      directSLPct: result.best?.directSLPct || "0.0%",
      nearTpThenLossPct: result.best?.nearTpThenLossPct || "0.0%",

      keepRatio: result.best?.keepRatio || 0,
      decisionScore: result.best?.decisionScore || 0,

      setupClassCounts: result.best?.setupClassCounts || {},
      sourceCounts: result.best?.sourceCounts || {}
    },

    moneyProjection: result.best?.moneyProjection || buildTsMoneyProjection([]),

    deltaVsCurrent: result.deltaVsCurrent || null,
    changedKeys: result.changedKeys || [],

    coverage: {
      coverageOk: Boolean(result.coverageOk),
      missingFilters: result.missingFilters || []
    },

    afstelling: result.best?.filters || buildCurrentTsMasterPreset(),

    examples: result.best?.examples || []
  };
}

function buildTsMasterBestAfstellingLog({ btcState, runId }) {
  const rows = buildTsOptimizerUniverse();

  const bestCombined = optimizeTsMasterTarget(rows, "COMBINED");
  const bestA = optimizeTsMasterTarget(rows, "A");
  const bestB = optimizeTsMasterTarget(rows, "B");

  const recommendedLiveAfstelling = mergeTsRecommendedLiveAfstelling({
    combined: bestCombined,
    bestA,
    bestB
  });

  const missingFilters = Array.from(new Set([
    ...(bestCombined.missingFilters || []),
    ...(bestA.missingFilters || []),
    ...(bestB.missingFilters || [])
  ]));

  const best = bestCombined.best || {};
  const validBest =
    safeNumber(best.completed, 0) >= TS_MASTER_MIN_SAMPLE &&
    safeNumber(best.totalR, 0) > 0 &&
    safeNumber(best.totalPnlPct, 0) > 0;

  return {
    tag: "TS_MASTER_BEST_AFSTELLING",
    strategyVersion: STRATEGY_VERSION,
    runId,
    btcState,
    ts: Date.now(),

    objective: TS_MASTER_OBJECTIVE,

    decision: missingFilters.length
      ? "FILTER_COVERAGE_INCOMPLETE"
      : validBest
        ? "BEST_TS_A_AND_B_WINRATE_PNL_AFSTELLING_READY"
        : "NO_VALID_POSITIVE_EDGE_COMBO_YET",

    sample: {
      usableRows: rows.length,
      scanShadowRows: rows.filter(row => String(row.source || "").toUpperCase() === "SCAN_SHADOW").length,
      realRows: rows.filter(row => String(row.source || "").toUpperCase() === "REAL").length,
      shadowRows: rows.filter(row => String(row.source || "").toUpperCase() === "SHADOW").length,
      confidence:
        rows.length >= 1000
          ? "HIGH"
          : rows.length >= 300
            ? "MEDIUM"
            : "LOW"
    },

    mapping: {
      gradeA: ["A", "GOD"],
      gradeB: ["B", "BULLISH_MID_TREND_PROBE", "BTC_BULLISH_BEAR_EXCEPTION"],
      note: "Elke completed real/shadow coin wordt opnieuw getest alsof deze preset toen live stond."
    },

    bestA: compactTsOptimizationResult(bestA),
    bestB: compactTsOptimizationResult(bestB),
    bestCombined: compactTsOptimizationResult(bestCombined),

    expectedPerformance: {
      completed: best.completed || 0,
      wins: best.wins || 0,
      losses: best.losses || 0,
      flats: best.flats || 0,
      winrate: best.winrate || "0.0%",

      totalPnlPct: best.totalPnlPct || 0,
      avgPnlPct: best.avgPnlPct || 0,

      totalR: best.totalR || 0,
      avgR: best.avgR || 0,

      profitFactorR: best.profitFactorR || 0,
      directSLPct: best.directSLPct || "0.0%",
      nearTpThenLossPct: best.nearTpThenLossPct || "0.0%",
      keepRatio: best.keepRatio || 0,
      decisionScore: best.decisionScore || 0
    },

    moneyProjection: best.moneyProjection || buildTsMoneyProjection([]),

    recommendedLiveAfstelling: validBest ? recommendedLiveAfstelling : null,

    patchLines: validBest
      ? buildTsPatchLinesFromPreset(recommendedLiveAfstelling)
      : [],

    coverage: {
      testedFilterCount: tsMasterFilterKeys().length,
      coverageOk: missingFilters.length === 0,
      missingFilters
    }
  };
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
    L3: 25,
    L2: 35,
    L1: 45,
    U1: 55,
    U2: 65,
    U3: 75
  };
}

// ================= PATCH 1: BEHOUD RAW.VALID === FALSE =================
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

// PATCH: stricter mergeMtfRsi validity
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

// ================= PATCH 4: BEWAAR DE RECURSIEVE extractNumericScore (geen duplicate) =================
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

  const rewardPct = riskPct * 1.35;

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

// ================= PATCH 3: A_SHORT_EXCEPTION EERST CHECKEN =================
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
    rr >= GOD_ENTRY_MIN_RR &&
    sniperScore >= godSniperReq &&
    confluence >= GOD_MIN_CONFLUENCE
  ) {
    return {
      setupClass: "GOD",
      entryReason: "GOD_ENTRY",
      requiredConfluence: GOD_MIN_CONFLUENCE,
      requiredSniper: GOD_MIN_SNIPER,
      requiredRR: GOD_ENTRY_MIN_RR
    };
  }

  if (
    rr >= A_ENTRY_MIN_RR &&
    sniperScore >= aSniperReq &&
    confluence >= A_MIN_CONFLUENCE
  ) {
    return {
      setupClass: "A",
      entryReason: "A_ENTRY",
      requiredConfluence: A_MIN_CONFLUENCE,
      requiredSniper: A_MIN_SNIPER,
      requiredRR: A_ENTRY_MIN_RR
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
    rr >= B_ENTRY_MIN_RR &&
    sniperScore >= bSniperReq &&
    confluence >= B_MIN_CONFLUENCE
  ) {
    return {
      setupClass: "B",
      entryReason: "B_ENTRY",
      requiredConfluence: B_MIN_CONFLUENCE,
      requiredSniper: B_MIN_SNIPER,
      requiredRR: B_ENTRY_MIN_RR
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
    strategyVersion: STRATEGY_VERSION
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
    btcBullishBearExceptionReason: position.btcBullishBearExceptionReason || null
  });

  if (auditState.recentEntries.length > MAX_RECENT_ENTRY_AUDIT_ROWS) {
    auditState.recentEntries.shift();
  }
}

// ================= PATCH 7: REALISTISCHE EXECUTION AUDIT =================
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
      featureRows: ENABLE_FEATURE_STORE ? auditState.featureStore?.length || 0 : 0,
      shadowRows: ENABLE_SHADOW_OUTCOMES ? auditState.shadowOutcomes?.length || 0 : 0
    },

    ts: Date.now()
  };
}

// ================= FINALIZE RESULT =================
function finalizeResult(actions, candidates, btcState, runId, options = {}) {
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
const MAX_DEEP_CANDIDATES = 80;

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

// ================= V12 HELPER FUNCTIONS =================
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

  if (
    rsiZone === "MID" &&
    neutralOb &&
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
  const setupClass = String(candidate.setupClass || "").toUpperCase();
  const rsiZone = String(candidate.rsiZone || "UNKNOWN").toUpperCase();
  const obBias = String(candidate.obBias || "NEUTRAL").toUpperCase();

  const confluence = Number(candidate.confluence || 0);
  const sniperScore = Number(candidate.sniperScore || 0);

  if (setupClass === "GOD") return false;

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

function hasRecentEntryConfirmation(key) {
  return lastSignalMap.has(`CONFIRM_${key}`);
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

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockOwner = `${runId}_${Math.random().toString(36).slice(2, 8)}`;

  const durableRequired = hasRedis();
  let lockAcquired = false;
  let stopLockHeartbeat = () => {};

  // PATCH: track load success
  let durableLoadedOk = false;

  try {
    if (durableRequired) {
      lockAcquired = await acquireRuntimeLock(lockOwner);

      if (!lockAcquired) {
        throw new Error("TRADE_SYSTEM_DURABLE_LOCK_BUSY");
      }

      if (lockAcquired) {
        stopLockHeartbeat = startRuntimeLockHeartbeat(lockOwner);
      }
    }

    // PATCH: load durable state with abort on failure for required Redis
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

    const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

    if (candidates.length === 0) {
      return finalizeResult([], [], btcState, runId, options);
    }

    // ================= DATA FETCH =================
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
        externalMtf = getMTFRSI({
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

      // PATCH: safe analyzeFlow
      const rawFlow = analyzeFlow(c);
      const flow = {
        ...(rawFlow && typeof rawFlow === "object" ? rawFlow : {}),
        type: String(rawFlow?.type || c.flow || "NEUTRAL").toUpperCase()
      };
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

          if (notify && !notifyState.get(exitKey)) {
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

        // Early failure exit before normal SL
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

          if (notify && !notifyState.get(exitKey)) {
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

      // ================= ENTRY CORE =================
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

        if (rsiSignal.blocked === true) {
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

        if (rsiSignal.valid === false) {
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

        if (rsiEdge.hardBlock) {
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

        if (isBull && ["UPPER_2", "UPPER_3"].includes(rsiZone) && !rsiEdge.continuationOk) {
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

        if (!isBull && SHORT_BLOCKED_RSI_ZONES.includes(rsiZone)) {
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

        const risk = await getSafeRiskGeometry({
          c,
          isBull,
          liquidity,
          liquidation,
          ob: obData,
          flow,
          sniper,
          rsiSignal
        });

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
        c._debugRsiRrDiscount = rsiEdge.rrDiscount;

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

        // ================= PATCH 2: EARLY BTC BULLISH SHORT EXCEPTION =================
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

        // ================= PATCH 4: MID RSI CONFLUENCE GATE MET EXCEPTIES =================
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

        const bullPullbackMeta = getBullPullbackMeta({
          c,
          candles15m: rsiData?.candles15m || [],
          fakeBreakoutConfirmed: Boolean(c.fakeBreakoutConfirmed || c.fakeBreakout)
        });

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

        const btcBullishBearException = earlyBtcBullishBearException; // reuse early result

        if (c.side === "bear" && isBullMarket && !btcBullishBearException.ok) {
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

        // PATCH: remove RSI RR-credit from setupEvalRR
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

        const rawRequiredRR = Math.max(
          Number(setup.requiredRR || MIN_RR_FLOOR),
          Number(dynamicMinRr || MIN_RR_FLOOR)
        );
        const requiredRR = applyRsiEdgeToRequiredRR(rawRequiredRR, rsiEdge);
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

        // ================= PATCH 5: SHORT LOWER_1 CONTINUATION GATE =================
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

        if (!bullAntiChase.ok) {
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

        // ================= V12 QUALITY GATE =================
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
          plannedRR: baseRR,
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

        // ================= PATCH: NEUTRAL OB GATE FULL EXCEPTION-BASED =================
        const neutralOb = ["NEUTRAL", "UNKNOWN"].includes(
          String(obData?.bias || "NEUTRAL").toUpperCase()
        );

        const isBtcBullishBearExceptionEntry =
          setup.setupClass === "A_SHORT_EXCEPTION" &&
          btcBullishBearException.exception === true;

        if (
          neutralOb &&
          !isBtcBullishBearExceptionEntry &&
          !isNeutralObEntryException({
            c,
            flow,
            sniper,
            confluence,
            rr: baseRR,
            setupClass: setup.setupClass,
            counterTrend
          })
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
            baseRR,
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

        // ================= PATCH 2: DUBBELE RR-DISCOUNT FIX =================
        const rawFinalRequiredRR =
          ["A", "GOD", "A_SHORT_EXCEPTION"].includes(setup.setupClass)
            ? Math.max(rawRequiredRR, A_FINAL_MIN_RR)
            : rawRequiredRR;

        const finalRequiredRR = applyRsiEdgeToRequiredRR(rawFinalRequiredRR, rsiEdge);

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

        // ================= CONFIRMATION GATE =================
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
          plannedRR: baseRR
        };

        if (requiresEntryConfirmation(confirmationCandidate) && !hasRecentEntryConfirmation(key)) {
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
          btcBullishBearExceptionChecks: c._debugBtcBullishBearExceptionChecks || null
        };

        memory.set(key, position);
        recordEntry(entryPayload, position);

        await logAction(entryPayload, regimeLevel, btcState, shouldLog);

        if (notify && !notifyState.get(key)) {
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

        lastSignalMap.set(key, Date.now() + COOLDOWN_MS);

        actions.push(entryPayload);

        console.log("TS_ENTRY_OPENED:", JSON.stringify({
          symbol: c.symbol,
          side: c.side,
          setupClass: setup.setupClass,
          reason: setup.entryReason,
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

    return finalizeResult(actions, candidates, btcState, runId, options);
  } finally {
    // PATCH: save only if load succeeded (or durable not required)
    try {
      const shouldSaveRuntime =
        !durableRequired ||
        (lockAcquired && durableLoadedOk);

      if (shouldSaveRuntime) {
        await saveDurableRuntimeState();
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
