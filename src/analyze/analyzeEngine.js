// ================= FILE: src/analyze/analyzeEngine.js =================

import { createHash } from 'crypto';

import * as ConfigModule from '../config.js';
import * as KeysModule from '../keys.js';
import * as RedisApi from '../redis.js';
import * as Utils from '../utils.js';
import * as MicroFamilies from './microFamilies.js';
import * as Scoring from './scoring.js';
import * as CostModel from '../trade/costModel.js';

const CONFIG = ConfigModule.CONFIG || {};
const KEYS = KeysModule.KEYS || {};

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const CHILD75_LEARNING_GRANULARITY = LEARNING_GRANULARITY;
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const MIN_COMPLETED_EMPIRICAL_VETO = 35;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const SHORT_MARKET_WEATHER_KEY_V1 = 'SHORT_MARKET_WEATHER_KEY_V1';
const UNKNOWN_MARKET_WEATHER_KEY = 'UNKNOWN|UNKNOWN';

const ENTRY_MARKET_WEATHER_CAPTURE_VERSION =
  'SHORT_ENTRY_MARKET_WEATHER_CAPTURE_V5_IMMUTABLE_ENTRY_ONLY_AGGREGATE_SAFE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V4_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';
const MARKET_WEATHER_AGGREGATION_VERSION =
  'SHORT_MARKET_WEATHER_AGGREGATION_V4_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';

const EMPIRICAL_VETO_VERSION =
  'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V4_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';
const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_STATUS_GATE_V5_AGGREGATE_GEOMETRY_SAFE_NETR_SOURCE_OF_TRUTH';

const NET_R_STATS_VERSION =
  'SHORT_NET_R_STATS_V4_RECORD_OUTCOME_SOURCE_OF_TRUTH';
const STATS_INVARIANT_VERSION =
  'SHORT_STATS_INVARIANT_NETR_TOTALR_AVGR_PF_REPAIR_V4';

const MEASUREMENT_FIX_VERSION =
  'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V4_NETR_SOURCE_OF_TRUTH';
const POSITION_MEASUREMENT_FIX_VERSION = MEASUREMENT_FIX_VERSION;
const MICRO_MICRO_VERSION =
  'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V5_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V5_NETR_SOURCE_OF_TRUTH';
const COST_MODEL_VERSION =
  'POSITION_ENGINE_SHORT_NET_COST_V18_MARKET_WEATHER_EMPIRICAL_VETO_NETR_SOURCE_OF_TRUTH';
const OBSERVATION_DEDUPE_VERSION =
  'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V6_IMMUTABLE_MARKET_WEATHER';
const OUTCOME_DEDUPE_VERSION =
  'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V11_IMMUTABLE_MARKET_WEATHER_NETR_SOURCE_OF_TRUTH';
const SELECTION_ENGINE_VERSION =
  'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V5_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';
const ADAPTIVE_UI_VERSION =
  'SHORT_ADAPTIVE_UI_MARKETWEATHER_EMPIRICAL_VETO_MICRO_MICRO_ONLY_V7_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';
const WEAK_CONTRA_ENTRY_GATE_VERSION =
  'SHORT_E_WEAK_CONTRA_POLICY_BLOCK_V5_NARROWED_AGGREGATE_SAFE';

const POLICY_BLOCK_GATE_VERSION =
  'SHORT_POLICY_BLOCK_GATE_V5_SYSTEM_RULES_ONLY_AGGREGATE_GEOMETRY_SAFE';

const PRIMARY_LEARNING_ID_RULE =
  'MICRO_MICRO_PRIMARY_CHILD75_PARENT15_CONTEXT_ONLY_V6_IMMUTABLE_ENTRY_NETR_SOURCE_OF_TRUTH';

const MICRO_MICRO_STATUS_OBSERVING = 'OBSERVING';
const MICRO_MICRO_STATUS_PASSED = 'PASSED';
const MICRO_MICRO_STATUS_REJECTED = 'REJECTED';
const MICRO_MICRO_STATUS_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const MICRO_MICRO_STATUS_POLICY_BLOCKED = 'POLICY_BLOCKED';
const MICRO_MICRO_STATUS_CONTEXT_ONLY = 'CONTEXT_ONLY';

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const SETUP_ORDER = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SETUPS = new Set(SETUP_ORDER);
const REGIMES = new Set(REGIME_ORDER);
const CONFIRMATIONS = new Set(CONFIRMATION_PROFILE_ORDER);

function now() {
  return Date.now();
}

function upper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function fallbackSafeNumber(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function safeNumber(value, fallback = 0) {
  if (typeof Utils.safeNumber === 'function') {
    const x = Utils.safeNumber(value, fallback);
    return Number.isFinite(Number(x)) ? Number(x) : fallback;
  }

  return fallbackSafeNumber(value, fallback);
}

function n(value, fallback = 0) {
  const x = safeNumber(value, fallback);
  return Number.isFinite(x) ? x : fallback;
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function round4(value) {
  return Number(n(value, 0).toFixed(4));
}

function round6(value) {
  return Number(n(value, 0).toFixed(6));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function hashText(value, len = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, len);
}

function flattenSafe(values = [], maxDepth = 5) {
  const out = [];
  const stack = [{ value: values, depth: 0 }];

  while (stack.length) {
    const item = stack.shift();

    if (Array.isArray(item.value) && item.depth < maxDepth) {
      for (const child of item.value) {
        stack.push({
          value: child,
          depth: item.depth + 1
        });
      }

      continue;
    }

    out.push(item.value);
  }

  return out;
}

function uniq(values = []) {
  return [
    ...new Set(
      flattenSafe(values)
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    )
  ];
}

function norm(value = '', fallback = '') {
  return upper(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function jsonSafe(value) {
  const seen = new WeakSet();

  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (typeof val === 'bigint') return Number(val);

    if (val && typeof val === 'object') {
      if (seen.has(val)) return undefined;
      seen.add(val);
    }

    return val;
  }));
}

function getDurableRedisSafe() {
  try {
    return typeof RedisApi.getDurableRedis === 'function'
      ? RedisApi.getDurableRedis()
      : null;
  } catch {
    return null;
  }
}

function getVolatileRedisSafe() {
  try {
    return typeof RedisApi.getVolatileRedis === 'function'
      ? RedisApi.getVolatileRedis()
      : getDurableRedisSafe();
  } catch {
    return getDurableRedisSafe();
  }
}

async function getJsonSafe(redis, key, fallback = null) {
  if (!redis || !key) return fallback;

  try {
    if (typeof RedisApi.getJson === 'function') {
      return await RedisApi.getJson(redis, key, fallback);
    }

    if (typeof redis.get === 'function') {
      const raw = await redis.get(key);

      if (raw === null || raw === undefined) return fallback;

      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }

      return raw;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function setJsonSafe(redis, key, value) {
  if (!redis || !key) return false;

  try {
    const safe = jsonSafe(value);

    if (typeof RedisApi.setJson === 'function') {
      await RedisApi.setJson(redis, key, safe);
      return true;
    }

    if (typeof redis.set === 'function') {
      await redis.set(key, JSON.stringify(safe));
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function redisSetNx(redis, key, value, ttlSec) {
  if (!redis || !key) {
    return {
      ok: true,
      claimed: true,
      duplicate: false,
      method: 'NO_REDIS_LOCAL_ALLOW'
    };
  }

  const ttl = Math.max(60, Math.floor(n(ttlSec, 60)));

  for (const opts of [{ ex: ttl, nx: true }, { EX: ttl, NX: true }]) {
    try {
      const result = await redis.set(key, value, opts);

      if (result === null || result === false) {
        return {
          ok: true,
          claimed: false,
          duplicate: true,
          method: 'SET_NX',
          key
        };
      }

      if (result === true || result === 1 || String(result).toUpperCase() === 'OK') {
        return {
          ok: true,
          claimed: true,
          duplicate: false,
          method: 'SET_NX',
          key
        };
      }
    } catch {
      // Try next syntax.
    }
  }

  try {
    const existing = typeof redis.get === 'function'
      ? await redis.get(key)
      : null;

    if (existing !== null && existing !== undefined) {
      return {
        ok: true,
        claimed: false,
        duplicate: true,
        method: 'GET_THEN_SET',
        key
      };
    }

    await redis.set(key, value, { ex: ttl }).catch(() => null);

    return {
      ok: true,
      claimed: true,
      duplicate: false,
      method: 'GET_THEN_SET',
      key
    };
  } catch {
    return {
      ok: false,
      claimed: true,
      duplicate: false,
      method: 'REDIS_ERROR_ALLOW',
      key
    };
  }
}

function shortKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function getWeekMicrosBaseKey(weekKey) {
  const fromKeys = typeof KEYS.analyze?.weekMicros === 'function'
    ? KEYS.analyze.weekMicros(weekKey)
    : null;

  return shortKey(fromKeys, `ANALYZE:WEEK:${weekKey}:MICROS`);
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

function getWeekMetaKey(weekKey) {
  return shortKey(
    typeof KEYS.analyze?.weekMeta === 'function'
      ? KEYS.analyze.weekMeta(weekKey)
      : null,
    `ANALYZE:WEEK:${weekKey}:META`
  );
}

function getWeekTradingCandidatesKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TRADING_CANDIDATES`;
}

async function readJsonAny(key, fallback = null) {
  const volatile = getVolatileRedisSafe();
  const durable = getDurableRedisSafe();

  const v = await getJsonSafe(volatile, key, null);
  if (v) return v;

  const d = await getJsonSafe(durable, key, null);
  return d || fallback;
}

async function setJsonEverywhere(key, value) {
  const safeValue = jsonSafe(value);

  await setJsonSafe(getDurableRedisSafe(), key, safeValue);
  await setJsonSafe(getVolatileRedisSafe(), key, safeValue).catch(() => null);
}

function sideToTradeSideSafe(value) {
  if (typeof Utils.sideToTradeSide === 'function') {
    const side = Utils.sideToTradeSide(value);
    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const raw = upper(value);

  if (
    raw === 'SHORT' ||
    raw === 'BEAR' ||
    raw === 'BEARISH' ||
    raw === 'SELL' ||
    raw.includes('SHORT') ||
    raw.includes('BEAR') ||
    raw.includes('SELL')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    raw === 'LONG' ||
    raw === 'BULL' ||
    raw === 'BULLISH' ||
    raw === 'BUY' ||
    raw.includes('LONG') ||
    raw.includes('BULL') ||
    raw.includes('BUY')
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function marketWeatherFeatureFlags() {
  return {
    version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,

    capture: 'LIVE',
    aggregation: 'LIVE',
    selector: 'OBSERVE',
    sizingCap: 'OBSERVE',
    fdr: 'OBSERVE',
    discordTradeReady: 'VALIDATION_REQUIRED',

    entryMarketWeatherCaptureEnabled: true,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherSourceOfTruth: 'ENTRY_ONLY_FOR_AGGREGATE_ROWS_CURRENT_CONFIRMED_ONLY_FOR_NEW_EVENTS',
    aggregateRowsDoNotRecomputeEntryWeatherFromCurrent: true,
    aggregateRowsDoNotRecomputeEntryWeatherFromConfirmed: true,

    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_V1,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,

    selectorHardLiveDecisionEnabled: false,
    sizingCapHardLiveDecisionEnabled: false,
    fdrHardLiveDecisionEnabled: false,
    discordTradeReadyHardLiveDecisionEnabled: false,

    unknownWeatherNeverTradeReady: true,
    unknownWeatherRiskFractionForEntry: 0,
    unknownWeatherSignalType: SIGNAL_TYPE_OBSERVE_ONLY,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoBlocksParentFallbackRescue: true,
    shrinkageCanDiagnoseButCannotOverrideVeto: true,

    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION,
    netRStatsAreSourceOfTruthForAvgRTotalRProfitFactor: true,

    policyBlockGateVersion: POLICY_BLOCK_GATE_VERSION,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: false,
    signalTypeIsDerivedOnly: true
  };
}

function normalizeMarketWeatherRegime(value = '') {
  const text = upper(value);

  if (text.includes('SQUEEZE') || text.includes('COMPRESS') || text.includes('COIL')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('IMPULSE') || text.includes('DIRECTION')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const side = sideToTradeSideSafe(raw);

  if (side === TARGET_TRADE_SIDE) return 'BEARISH';
  if (side === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  if (
    raw.includes('BEAR') ||
    raw.includes('SELL') ||
    raw.includes('SHORT') ||
    raw.includes('DOWN') ||
    raw.includes('DOWNSIDE') ||
    raw.includes('RISK_OFF') ||
    raw.includes('RED')
  ) {
    return 'BEARISH';
  }

  if (
    raw.includes('BULL') ||
    raw.includes('BUY') ||
    raw.includes('LONG') ||
    raw.includes('UP') ||
    raw.includes('UPSIDE') ||
    raw.includes('RISK_ON') ||
    raw.includes('GREEN')
  ) {
    return 'BULLISH';
  }

  if (raw.includes('NEUTRAL') || raw.includes('MIXED') || raw.includes('FLAT')) {
    return 'NEUTRAL';
  }

  return 'UNKNOWN';
}

function buildEntryMarketWeatherKey({ regime, trendSide } = {}) {
  const r = normalizeMarketWeatherRegime(regime);
  const t = normalizeMarketWeatherTrendSide(trendSide);

  return `${r}|${t}`;
}

function parseEntryMarketWeatherKey(value = '') {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw || raw.includes('[OBJECT OBJECT]')) {
    return {
      valid: false,
      key: UNKNOWN_MARKET_WEATHER_KEY,
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN'
    };
  }

  const parts = raw.split('|');

  if (parts.length < 2) {
    return {
      valid: false,
      key: UNKNOWN_MARKET_WEATHER_KEY,
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN'
    };
  }

  const regime = normalizeMarketWeatherRegime(parts[0]);
  const trendSide = normalizeMarketWeatherTrendSide(parts[1]);
  const valid = regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN';
  const key = valid
    ? buildEntryMarketWeatherKey({ regime, trendSide })
    : UNKNOWN_MARKET_WEATHER_KEY;

  return {
    valid,
    key,
    regime: valid ? regime : 'UNKNOWN',
    trendSide: valid ? trendSide : 'UNKNOWN'
  };
}

function firstKnownMarketWeatherKey(...values) {
  for (const value of values) {
    const parsed = parseEntryMarketWeatherKey(value);

    if (parsed.valid) return parsed;
  }

  return null;
}

function looksLikeLearningFamilyText(row = {}) {
  const text = upper([
    row.id,
    row.key,
    row.rowId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ].filter(Boolean).join('|'));

  return text.includes('MICRO_SHORT_');
}

function hasTradeIdentity(row = {}) {
  return Boolean(
    row.tradeId ||
      row.positionId ||
      row.orderId ||
      row.outcomeIdentity ||
      row.stableOutcomeIdentity ||
      row.closedAt ||
      row.completedAt ||
      row.openedAt ||
      row.entry ||
      row.entryPrice ||
      row.exit ||
      row.exitPrice
  );
}

function hasAggregateStatsFields(row = {}) {
  return Boolean(
    row.netRStats ||
      row.shortNetRStats ||
      row.outcomeNetRStats ||
      row.marketWeatherStats ||
      Array.isArray(row.recentOutcomes) ||
      hasValue(row.completed) ||
      hasValue(row.outcomeSample) ||
      hasValue(row.closed) ||
      hasValue(row.seen) ||
      hasValue(row.observed) ||
      hasValue(row.observations)
  );
}

function isAggregateLearningStatsRow(row = {}) {
  if (!row || typeof row !== 'object') return false;

  const type = upper(row.type || row.eventType || row.rowType || '');

  if (
    type.includes('OUTCOME') ||
    type.includes('POSITION') ||
    type.includes('TRADE') ||
    type.includes('ENTRY') ||
    type.includes('CANDIDATE') ||
    type.includes('SIGNAL')
  ) {
    return false;
  }

  return looksLikeLearningFamilyText(row) && hasAggregateStatsFields(row) && !hasTradeIdentity(row);
}

function shouldAllowCurrentConfirmedWeatherFallback(row = {}) {
  if (!row || typeof row !== 'object') return false;

  if (isAggregateLearningStatsRow(row)) return false;

  return Boolean(
    row.allowCurrentWeatherAsEntryFallback === true ||
      row.allowConfirmedWeatherAsEntryFallback === true ||
      row.type === 'OUTCOME' ||
      row.type === 'POSITION' ||
      row.type === 'ENTRY' ||
      row.type === 'CANDIDATE' ||
      row.type === 'SIGNAL' ||
      row.tradeId ||
      row.positionId ||
      row.symbol ||
      row.contractSymbol ||
      row.openedAt ||
      row.createdAt ||
      row.entry ||
      row.entryPrice ||
      row.price
  );
}

function compactEntryMarketWeatherRaw(value = null) {
  if (!value || typeof value !== 'object') return null;

  const allowed = {
    ok: value.ok,
    available: value.available,
    version: value.version,
    snapshotId: value.snapshotId,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    updatedAt: value.updatedAt,
    rememberedAt: value.rememberedAt,

    confirmedMarketWeatherKey: value.confirmedMarketWeatherKey,
    currentMarketWeatherKey: value.currentMarketWeatherKey,
    entryMarketWeatherKey: value.entryMarketWeatherKey,
    marketWeatherKey: value.marketWeatherKey,

    marketWeatherRegime: value.marketWeatherRegime,
    confirmedMarketWeatherRegime: value.confirmedMarketWeatherRegime,
    currentMarketWeatherRegime: value.currentMarketWeatherRegime,
    currentRegime: value.currentRegime,
    regime: value.regime,

    marketWeatherTrendSide: value.marketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: value.confirmedMarketWeatherTrendSide,
    currentMarketWeatherTrendSide: value.currentMarketWeatherTrendSide,
    currentTrendSide: value.currentTrendSide,
    trendSide: value.trendSide,

    confidence: value.confidence,
    bullishPct: value.bullishPct,
    bearishPct: value.bearishPct,
    squeezePct: value.squeezePct,
    chopPct: value.chopPct,
    trendPct: value.trendPct,

    btcState: value.btcState,
    btcChange1h: value.btcChange1h,
    btcChange24h: value.btcChange24h,

    source: value.source,
    compactedForRedis: true
  };

  const out = {};

  for (const [key, item] of Object.entries(allowed)) {
    if (hasValue(item)) out[key] = item;
  }

  return Object.keys(out).length ? out : null;
}

function availableFieldsFromRaw(raw = null) {
  if (!raw || typeof raw !== 'object') return [];

  return Object.keys(raw)
    .filter((key) => hasValue(raw[key]))
    .sort();
}

function resolveEntryMarketWeather(row = {}, timestamp = now()) {
  const aggregateLearningRow = isAggregateLearningStatsRow(row);
  const allowCurrentConfirmedFallback = shouldAllowCurrentConfirmedWeatherFallback(row);

  const existingRaw = row.entryMarketWeatherRaw && typeof row.entryMarketWeatherRaw === 'object'
    ? row.entryMarketWeatherRaw
    : null;

  const rawSnapshot = compactEntryMarketWeatherRaw(
    existingRaw ||
      row.entryMarketWeather ||
      (
        aggregateLearningRow
          ? null
          : row.currentMarketWeather || row.marketWeather || null
      )
  );

  const lockedEntryKey = firstKnownMarketWeatherKey(
    row.entryMarketWeatherKey,
    rawSnapshot?.entryMarketWeatherKey
  );

  let knownKey = lockedEntryKey;

  if (!knownKey && allowCurrentConfirmedFallback) {
    knownKey = firstKnownMarketWeatherKey(
      row.confirmedMarketWeatherKey,
      row.currentMarketWeatherKey,
      row.marketWeatherKey,
      rawSnapshot?.confirmedMarketWeatherKey,
      rawSnapshot?.currentMarketWeatherKey,
      rawSnapshot?.marketWeatherKey
    );
  }

  let regime = knownKey?.regime || normalizeMarketWeatherRegime(firstValue(
    row.entryMarketWeatherRegime,
    rawSnapshot?.marketWeatherRegime
  ));

  let trendSide = knownKey?.trendSide || normalizeMarketWeatherTrendSide(firstValue(
    row.entryMarketWeatherTrendSide,
    rawSnapshot?.marketWeatherTrendSide
  ));

  if (
    (regime === 'UNKNOWN' || trendSide === 'UNKNOWN') &&
    allowCurrentConfirmedFallback &&
    !aggregateLearningRow
  ) {
    regime = normalizeMarketWeatherRegime(firstValue(
      row.confirmedMarketWeatherRegime,
      row.currentMarketWeatherRegime,
      rawSnapshot?.confirmedMarketWeatherRegime,
      rawSnapshot?.currentMarketWeatherRegime,
      rawSnapshot?.currentRegime,
      rawSnapshot?.regime,
      row.marketWeatherRegime,
      row.currentRegime,
      row.regime,
      regime
    ));

    trendSide = normalizeMarketWeatherTrendSide(firstValue(
      row.confirmedMarketWeatherTrendSide,
      row.currentMarketWeatherTrendSide,
      rawSnapshot?.confirmedMarketWeatherTrendSide,
      rawSnapshot?.currentMarketWeatherTrendSide,
      rawSnapshot?.currentTrendSide,
      rawSnapshot?.trendSide,
      row.marketWeatherTrendSide,
      row.currentTrendSide,
      row.trendSide,
      trendSide
    ));
  }

  const builtKey = buildEntryMarketWeatherKey({
    regime,
    trendSide
  });

  const parsedBuilt = parseEntryMarketWeatherKey(builtKey);
  const parsed = knownKey || parsedBuilt;

  const capturedAt = n(
    row.entryMarketWeatherCapturedAt ||
      rawSnapshot?.createdAt ||
      rawSnapshot?.completedAt ||
      rawSnapshot?.updatedAt ||
      rawSnapshot?.rememberedAt ||
      row.openedAt ||
      row.createdAt ||
      timestamp,
    timestamp
  );

  const valid = Boolean(parsed?.valid);

  return {
    entryMarketWeatherKey: valid ? parsed.key : UNKNOWN_MARKET_WEATHER_KEY,
    entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || SHORT_MARKET_WEATHER_KEY_V1,
    entryMarketWeatherRegime: valid ? parsed.regime : 'UNKNOWN',
    entryMarketWeatherTrendSide: valid ? parsed.trendSide : 'UNKNOWN',
    entryMarketWeatherCapturedAt: capturedAt,
    entryMarketWeatherRaw: rawSnapshot,
    entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
      ? row.entryMarketWeatherRawAvailableFields
      : availableFieldsFromRaw(rawSnapshot),
    entryMarketWeatherCaptureVersion: ENTRY_MARKET_WEATHER_CAPTURE_VERSION,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherIsUnknown: !valid,
    entryMarketWeatherResolvedFrom: lockedEntryKey
      ? 'LOCKED_ENTRY_MARKET_WEATHER'
      : allowCurrentConfirmedFallback && knownKey
        ? 'CURRENT_OR_CONFIRMED_FALLBACK_FOR_NEW_EVENT_ONLY'
        : valid
          ? 'ENTRY_REGIME_TREND_FIELDS'
          : 'UNKNOWN',
    aggregateLearningRowEntryWeatherProtected: aggregateLearningRow,
    aggregateRowsDoNotRecomputeEntryWeatherFromCurrent: aggregateLearningRow,
    aggregateRowsDoNotRecomputeEntryWeatherFromConfirmed: aggregateLearningRow
  };
}

function attachEntryMarketWeather(row = {}, timestamp = now()) {
  const weather = resolveEntryMarketWeather(row, timestamp);

  return {
    ...row,
    ...weather,
    entryMarketWeather: weather.entryMarketWeatherRaw,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };
}

function isUnknownEntryMarketWeather(row = {}) {
  const parsed = parseEntryMarketWeatherKey(row.entryMarketWeatherKey);

  return (
    !parsed.valid ||
    parsed.key === UNKNOWN_MARKET_WEATHER_KEY ||
    upper(row.entryMarketWeatherRegime || parsed.regime) === 'UNKNOWN' ||
    upper(row.entryMarketWeatherTrendSide || parsed.trendSide) === 'UNKNOWN'
  );
}

function emptyWeatherCell() {
  return {
    seen: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    totalCostR: 0,
    directSLCount: 0,
    avgR: 0,
    avgCostR: 0,
    winrate: 0,
    directSLPct: 0
  };
}

function normalizeWeatherStats(value = {}) {
  const safe = value && typeof value === 'object' ? value : {};

  return {
    version: MARKET_WEATHER_AGGREGATION_VERSION,
    lifetime: {
      ...emptyWeatherCell(),
      ...(safe.lifetime && typeof safe.lifetime === 'object' ? safe.lifetime : {})
    },
    byRegime: safe.byRegime && typeof safe.byRegime === 'object' ? safe.byRegime : {},
    byRegimeTrend: safe.byRegimeTrend && typeof safe.byRegimeTrend === 'object' ? safe.byRegimeTrend : {}
  };
}

function finalizeWeatherCell(cell = {}) {
  const seen = n(cell.seen, 0);
  const completed = n(cell.completed, 0);
  const wins = n(cell.wins, 0);
  const totalR = n(cell.totalR, 0);
  const totalCostR = Math.max(0, n(cell.totalCostR, 0));
  const directSLCount = n(cell.directSLCount, 0);

  return {
    ...cell,
    seen,
    completed,
    wins,
    losses: n(cell.losses, 0),
    flats: n(cell.flats, 0),
    totalR,
    totalCostR,
    directSLCount,
    avgR: completed > 0 ? totalR / completed : 0,
    avgCostR: completed > 0 ? totalCostR / completed : 0,
    winrate: completed > 0 ? wins / completed : 0,
    directSLPct: completed > 0 ? directSLCount / completed : 0
  };
}

function updateWeatherCell(cell = {}, event = {}, type = 'OBSERVATION') {
  const out = {
    ...emptyWeatherCell(),
    ...cell
  };

  if (type === 'OBSERVATION') {
    out.seen += 1;
    return finalizeWeatherCell(out);
  }

  const netR = outcomeNetR(event);
  const costR = outcomeCostR(event);

  out.completed += 1;
  out.totalR += netR;
  out.totalCostR += costR;

  if (netR > 0) out.wins += 1;
  else if (netR < 0) out.losses += 1;
  else out.flats += 1;

  if (event.directSL || event.directToSL) out.directSLCount += 1;

  return finalizeWeatherCell(out);
}

function updateMarketWeatherAggregation(row = {}, event = {}, type = 'OBSERVATION') {
  const weather = resolveEntryMarketWeather(
    event,
    event.entryMarketWeatherCapturedAt || event.createdAt || event.openedAt || now()
  );

  const regime = weather.entryMarketWeatherRegime || 'UNKNOWN';
  const regimeTrend = weather.entryMarketWeatherKey || buildEntryMarketWeatherKey({
    regime,
    trendSide: weather.entryMarketWeatherTrendSide
  });

  const stats = normalizeWeatherStats(row.marketWeatherStats);

  stats.lifetime = updateWeatherCell(stats.lifetime, event, type);

  stats.byRegime[regime] = updateWeatherCell(
    stats.byRegime[regime] || emptyWeatherCell(),
    event,
    type
  );

  stats.byRegimeTrend[regimeTrend] = updateWeatherCell(
    stats.byRegimeTrend[regimeTrend] || emptyWeatherCell(),
    event,
    type
  );

  return {
    ...row,
    marketWeatherStats: stats,
    entryMarketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION
  };
}

function emptyNetRStats() {
  return {
    version: NET_R_STATS_VERSION,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    totalCostR: 0,
    grossWinR: 0,
    grossLossR: 0,
    directSLCount: 0,
    sumR: 0,
    sumSqR: 0,
    minR: 0,
    maxR: 0,
    recentOutcomes: [],
    updatedAt: null
  };
}

function normalizeNetRStats(value = {}) {
  const safe = value && typeof value === 'object' ? value : {};
  const base = {
    ...emptyNetRStats(),
    ...safe
  };

  base.completed = Math.max(0, n(base.completed, 0));
  base.wins = Math.max(0, n(base.wins, 0));
  base.losses = Math.max(0, n(base.losses, 0));
  base.flats = Math.max(0, n(base.flats, 0));
  base.totalR = n(base.totalR, 0);
  base.totalCostR = Math.max(0, n(base.totalCostR, 0));
  base.grossWinR = Math.max(0, n(base.grossWinR, 0));
  base.grossLossR = Math.max(0, n(base.grossLossR, 0));
  base.directSLCount = Math.max(0, n(base.directSLCount, 0));
  base.sumR = n(base.sumR, base.totalR);
  base.sumSqR = Math.max(0, n(base.sumSqR, 0));
  base.minR = n(base.minR, 0);
  base.maxR = n(base.maxR, 0);
  base.recentOutcomes = Array.isArray(base.recentOutcomes)
    ? base.recentOutcomes.slice(-100)
    : [];
  base.version = NET_R_STATS_VERSION;

  return base;
}

function lcb95FromMoments({ completed, totalR, sumSqR } = {}) {
  const c = n(completed, 0);
  const total = n(totalR, 0);
  const ss = Math.max(0, n(sumSqR, 0));

  if (c <= 1) return 0;

  const avg = total / c;
  const variance = Math.max(0, (ss - (total * total) / c) / (c - 1));
  const sd = Math.sqrt(variance);

  return avg - 1.96 * (sd / Math.sqrt(c));
}

function finalizeNetRStats(value = {}) {
  const stats = normalizeNetRStats(value);
  const completed = stats.completed;
  const avgR = completed > 0 ? stats.totalR / completed : 0;
  const avgCostR = completed > 0 ? stats.totalCostR / completed : 0;
  const winrate = completed > 0 ? stats.wins / completed : 0;
  const directSLPct = completed > 0 ? stats.directSLCount / completed : 0;
  const profitFactor = stats.grossLossR > 0
    ? stats.grossWinR / stats.grossLossR
    : stats.grossWinR > 0
      ? 99
      : 0;

  const lcb95AvgR = lcb95FromMoments({
    completed,
    totalR: stats.totalR,
    sumSqR: stats.sumSqR
  });

  return {
    ...stats,
    avgR,
    avgCostR,
    winrate,
    directSLPct,
    profitFactor,
    lcb95AvgR,
    avgRLCB95: lcb95AvgR,
    finalizedAt: now()
  };
}

function numericField(row = {}, keys = []) {
  for (const key of keys) {
    if (hasValue(row[key]) && Number.isFinite(Number(row[key]))) {
      return Number(row[key]);
    }
  }

  return null;
}

function calcShortGrossRFromEvent(event = {}) {
  const explicit = numericField(event, [
    'grossR',
    'shortGrossR',
    'rawR',
    'realizedGrossR'
  ]);

  if (explicit !== null) return explicit;

  const entry = n(event.entry ?? event.entryPrice, 0);
  const exit = n(event.exitPrice ?? event.exit, 0);
  const initialSl = n(event.initialSl ?? event.sl, 0);

  if (entry <= 0 || exit <= 0 || initialSl <= entry) return 0;

  return (entry - exit) / (initialSl - entry);
}

function outcomeCostR(event = {}) {
  const explicit = numericField(event, [
    'costR',
    'netCostR',
    'estimatedCostR',
    'avgCostR'
  ]);

  if (explicit !== null) return Math.max(0, explicit);

  const totalCost = numericField(event, ['totalCostR']);
  if (totalCost !== null) return Math.max(0, totalCost);

  return 0;
}

function outcomeNetR(event = {}) {
  const explicit = numericField(event, [
    'netR',
    'shortNetR',
    'exitR',
    'realizedNetR',
    'realizedR',
    'r'
  ]);

  const grossR = calcShortGrossRFromEvent(event);
  const costR = outcomeCostR(event);
  const repaired = grossR - costR;

  if (explicit === null) return repaired;

  const explicitLooksBlank =
    Math.abs(explicit) < 1e-12 &&
    Math.abs(grossR) > 1e-12;

  if (explicitLooksBlank) return repaired;

  return explicit;
}

function slimNetOutcome(event = {}) {
  const netR = outcomeNetR(event);
  const costR = outcomeCostR(event);
  const grossR = calcShortGrossRFromEvent(event);

  return {
    symbol: event.symbol || null,
    tradeId: event.tradeId || null,
    outcomeIdentity: event.outcomeIdentity || event.stableOutcomeIdentity || null,
    exitReason: event.exitReason || event.reason || null,

    netR: round6(netR),
    shortNetR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    grossR: round6(grossR),
    shortGrossR: round6(grossR),
    rawR: round6(grossR),

    costR: round6(costR),
    avgCostR: round6(costR),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,

    directSL: Boolean(event.directSL || event.directToSL),
    openedAt: event.openedAt || event.createdAt || null,
    closedAt: event.closedAt || event.completedAt || event.ts || null,
    entryMarketWeatherKey: event.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY
  };
}

function updateNetRStats(statsInput = {}, event = {}) {
  const stats = normalizeNetRStats(statsInput);
  const netR = outcomeNetR(event);
  const costR = outcomeCostR(event);

  stats.completed += 1;
  stats.totalR += netR;
  stats.totalCostR += costR;
  stats.sumR += netR;
  stats.sumSqR += netR * netR;

  if (stats.completed === 1) {
    stats.minR = netR;
    stats.maxR = netR;
  } else {
    stats.minR = Math.min(stats.minR, netR);
    stats.maxR = Math.max(stats.maxR, netR);
  }

  if (netR > 0) {
    stats.wins += 1;
    stats.grossWinR += netR;
  } else if (netR < 0) {
    stats.losses += 1;
    stats.grossLossR += Math.abs(netR);
  } else {
    stats.flats += 1;
  }

  if (event.directSL || event.directToSL) {
    stats.directSLCount += 1;
  }

  stats.recentOutcomes = [
    ...stats.recentOutcomes,
    slimNetOutcome(event)
  ].slice(-100);

  stats.updatedAt = now();

  return finalizeNetRStats(stats);
}

function aggregateRecentOutcomes(outcomes = []) {
  let stats = emptyNetRStats();

  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (!outcome || typeof outcome !== 'object') continue;
    stats = updateNetRStats(stats, outcome);
  }

  stats.recentOutcomes = (Array.isArray(outcomes) ? outcomes : [])
    .slice(-100)
    .map(slimNetOutcome);

  return finalizeNetRStats(stats);
}

function hasUsableNetStats(row = {}) {
  const stats = row.netRStats || row.shortNetRStats || row.outcomeNetRStats;

  return Boolean(
    stats &&
    typeof stats === 'object' &&
    n(stats.completed, 0) > 0
  );
}

function explicitLegacyStats(row = {}) {
  const completed = Math.max(
    n(row.completed, 0),
    n(row.outcomeSample, 0),
    n(row.closed, 0)
  );

  if (completed <= 0) return null;

  const totalR = n(row.netTotalR ?? row.shortNetTotalR ?? row.totalR, 0);
  const avgR = n(row.netAvgR ?? row.shortNetAvgR ?? row.avgR, 0);
  const wins = Math.max(0, n(row.wins, 0));
  const losses = Math.max(0, n(row.losses, 0));
  const flats = Math.max(0, n(row.flats, Math.max(0, completed - wins - losses)));
  const cost = Math.max(0, n(row.totalCostR ?? row.avgCostR * completed, 0));

  const useTotal = totalR !== 0 ? totalR : avgR * completed;

  const stats = {
    ...emptyNetRStats(),
    completed,
    wins,
    losses,
    flats,
    totalR: useTotal,
    totalCostR: cost,
    grossWinR: Math.max(0, n(row.grossWinR ?? row.totalWinR ?? row.netWinR, 0)),
    grossLossR: Math.max(0, Math.abs(n(row.grossLossR ?? row.totalLossR ?? row.netLossR, 0))),
    directSLCount: Math.max(0, n(row.directSLCount, 0)),
    sumR: useTotal,
    sumSqR: Math.max(0, n(row.sumSqR, 0)),
    recentOutcomes: Array.isArray(row.recentOutcomes)
      ? row.recentOutcomes.slice(-100).map(slimNetOutcome)
      : [],
    updatedAt: row.updatedAt || now()
  };

  if (stats.sumSqR <= 0 && stats.recentOutcomes.length > 1) {
    return aggregateRecentOutcomes(stats.recentOutcomes);
  }

  return finalizeNetRStats(stats);
}

function chooseBestStatsSource(row = {}) {
  const netStats = hasUsableNetStats(row)
    ? finalizeNetRStats(row.netRStats || row.shortNetRStats || row.outcomeNetRStats)
    : null;

  const recentStats = Array.isArray(row.recentOutcomes) && row.recentOutcomes.length
    ? aggregateRecentOutcomes(row.recentOutcomes)
    : null;

  const legacyStats = explicitLegacyStats(row);

  const score = (stats) => {
    if (!stats || n(stats.completed, 0) <= 0) return -1;

    let s = n(stats.completed, 0);

    if (Math.abs(n(stats.totalR, 0)) > 1e-12) s += 10000;
    if (Math.abs(n(stats.grossWinR, 0)) > 1e-12 || Math.abs(n(stats.grossLossR, 0)) > 1e-12) s += 5000;
    if (Array.isArray(stats.recentOutcomes) && stats.recentOutcomes.length) s += 1000;
    if (Number.isFinite(Number(stats.lcb95AvgR))) s += 100;

    return s;
  };

  const candidates = [
    { source: 'NET_R_STATS', stats: netStats },
    { source: 'RECENT_OUTCOMES', stats: recentStats },
    { source: 'LEGACY_FIELDS', stats: legacyStats }
  ].filter((x) => x.stats && n(x.stats.completed, 0) > 0);

  candidates.sort((a, b) => score(b.stats) - score(a.stats));

  return candidates[0] || null;
}

function repairStatsInvariants(row = {}) {
  if (!row || typeof row !== 'object') return row;

  const best = chooseBestStatsSource(row);

  const completedExisting = Math.max(
    n(row.completed, 0),
    n(row.outcomeSample, 0),
    n(row.closed, 0)
  );

  const totalRExisting = n(row.totalR ?? row.netTotalR ?? row.shortNetTotalR, 0);
  const avgRExisting = n(row.avgR ?? row.netAvgR ?? row.shortNetAvgR, 0);
  const explicitLcb = n(
    row.standaloneMicroMicroLifetimeLCB95AvgR ??
      row.exactMicroMicroLifetimeLCB95AvgR ??
      row.avgRLCB95 ??
      row.lcb95AvgR ??
      row.avgRLowerBound95,
    NaN
  );

  const suspiciousLegacyStats =
    completedExisting > 0 &&
    totalRExisting === 0 &&
    avgRExisting === 0 &&
    Number.isFinite(explicitLcb) &&
    explicitLcb < 0 &&
    !best;

  if (!best) {
    return {
      ...row,
      statsInvariantVersion: STATS_INVARIANT_VERSION,
      netRStatsVersion: NET_R_STATS_VERSION,
      statsIntegrityWarning: suspiciousLegacyStats
        ? 'COMPLETED_AND_NEGATIVE_LCB_BUT_NO_NETR_SOURCE_TO_REPAIR_LEGACY_ROW'
        : row.statsIntegrityWarning || null,
      legacyStatsNeedRebuildFromRawOutcomes:
        suspiciousLegacyStats ||
        Boolean(row.legacyStatsNeedRebuildFromRawOutcomes)
    };
  }

  const sourceStats = finalizeNetRStats(best.stats);
  const completed = sourceStats.completed;
  const lcb95AvgR = sourceStats.completed > 1
    ? sourceStats.lcb95AvgR
    : Number.isFinite(explicitLcb)
      ? explicitLcb
      : 0;

  return {
    ...row,

    completed,
    outcomeSample: completed,
    closed: completed,

    wins: sourceStats.wins,
    losses: sourceStats.losses,
    flats: sourceStats.flats,

    totalR: sourceStats.totalR,
    netTotalR: sourceStats.totalR,
    shortNetTotalR: sourceStats.totalR,

    avgR: sourceStats.avgR,
    netAvgR: sourceStats.avgR,
    shortNetAvgR: sourceStats.avgR,

    totalCostR: sourceStats.totalCostR,
    avgCostR: sourceStats.avgCostR,

    grossWinR: sourceStats.grossWinR,
    grossLossR: sourceStats.grossLossR,
    profitFactor: sourceStats.profitFactor,
    pf: sourceStats.profitFactor,

    winrate: sourceStats.winrate,
    winRate: sourceStats.winrate,
    fairWinrate: sourceStats.winrate,

    directSLCount: sourceStats.directSLCount,
    directSLPct: sourceStats.directSLPct,

    sumR: sourceStats.sumR,
    sumSqR: sourceStats.sumSqR,
    stdDevR: sourceStats.completed > 1
      ? Math.sqrt(Math.max(0, (sourceStats.sumSqR - (sourceStats.totalR * sourceStats.totalR) / sourceStats.completed) / (sourceStats.completed - 1)))
      : 0,

    avgRLCB95: lcb95AvgR,
    lcb95AvgR,
    avgRLowerBound95: lcb95AvgR,
    standaloneMicroMicroLifetimeLCB95AvgR: lcb95AvgR,
    exactMicroMicroLifetimeLCB95AvgR: lcb95AvgR,

    netRStats: sourceStats,
    shortNetRStats: sourceStats,
    outcomeNetRStats: sourceStats,
    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION,
    statsRepairedFrom: best.source,
    statsRepairedAt: now(),
    statsIntegrityWarning: null,
    legacyStatsNeedRebuildFromRawOutcomes: false
  };
}

function applyOutcomeStatsInvariant(row = {}, event = {}) {
  const updatedStats = updateNetRStats(
    row.netRStats || row.shortNetRStats || row.outcomeNetRStats || {},
    event
  );

  return repairStatsInvariants({
    ...row,
    netRStats: updatedStats,
    shortNetRStats: updatedStats,
    outcomeNetRStats: updatedStats,
    recentOutcomes: Array.isArray(row.recentOutcomes)
      ? [
          ...row.recentOutcomes,
          slimOutcome(event)
        ].slice(-100)
      : [slimOutcome(event)]
  });
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,
    child75ContextOnly: true,
    parent15ContextOnly: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroVersion: MICRO_MICRO_VERSION,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordMatch: 'candidate.microMicroFamilyId === selectedMicroMicroFamilyId',

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,

    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,
    scannerMatchTriggersDiscord: false,

    entryMarketWeatherCaptureEnabled: true,
    entryMarketWeatherCaptureVersion: ENTRY_MARKET_WEATHER_CAPTURE_VERSION,
    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_V1,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherSourceOfTruth: 'LOCKED_ENTRY_MARKET_WEATHER',
    aggregateRowsDoNotRecomputeEntryWeatherFromCurrent: true,
    aggregateRowsDoNotRecomputeEntryWeatherFromConfirmed: true,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION,
    netRStatsAreSourceOfTruthForAvgRTotalRProfitFactor: true,
    netRZeroRepairEnabled: true,
    grossRMinusCostRUsedWhenNetRBlankZero: true,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoBlocksParentFallbackRescue: true,
    shrinkageCanDiagnoseButCannotOverrideVeto: true,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: false,
    signalTypeIsDerivedOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    policyBlockGateVersion: POLICY_BLOCK_GATE_VERSION,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejectedBlocksVirtualEntry: true,
    weakContraRejectedBlocksLearning: false,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function flags(row = {}) {
  return {
    ...modeFlags(),
    ...row
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  let baseValue = value;
  let microMicroHash = null;

  const mm = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,64})$/u.exec(value);

  if (mm) {
    baseValue = mm[1];
    microMicroHash = mm[2].slice(0, MICRO_MICRO_HASH_LEN);
  }

  let body = baseValue.slice('MICRO_SHORT_'.length);
  let confirmationProfile = null;

  for (const p of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${p}`;

    if (body.endsWith(suffix)) {
      confirmationProfile = p;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setup = null;
  let regime = null;

  for (const r of REGIME_ORDER) {
    const suffix = `_${r}`;

    if (body.endsWith(suffix)) {
      regime = r;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

  const validParent = Boolean(parentId) && SETUPS.has(setup) && REGIMES.has(regime);
  const validChild = validParent && Boolean(confirmationProfile) && CONFIRMATIONS.has(confirmationProfile);
  const microMicroFamilyId = validChild && microMicroHash
    ? `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`
    : null;

  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;

  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,
    id: microMicroFamilyId || childId || parentId || value,

    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    base75ChildTrueMicroFamilyId: validChild ? childId : null,

    trueMicroFamilyId: validChild
      ? childId
      : validParent
        ? parentId
        : null,

    microFamilyId: validChild
      ? childId
      : validParent
        ? parentId
        : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    learningLayer: isMicroMicro
      ? LAYER_MICRO_MICRO
      : isChild
        ? LAYER_MICRO_75
        : isParent
          ? LAYER_PARENT_15
          : 'UNKNOWN'
  };
}

function isParentId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent;
}

function isChildId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild;
}

function isMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro;
}

function isLearningId(id = '') {
  const p = parseShortTaxonomyMicroId(id);
  return p.isParent || p.isChild || p.isMicroMicro;
}

function childIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);

  if (p.isMicroMicro || p.isChild) {
    return p.childTrueMicroFamilyId || '';
  }

  const direct = [
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.baseTrueMicroFamilyId,
    row.trueMicro75FamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.learningFamilyId,
    row.analyzeMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ]
    .map((x) => parseShortTaxonomyMicroId(x))
    .find((x) => x.isChild || x.isMicroMicro);

  return direct?.childTrueMicroFamilyId || '';
}

function parentIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);

  if (p.valid) return p.parentTrueMicroFamilyId || '';

  const child = childIdFrom(id, row);
  return parseShortTaxonomyMicroId(child).parentTrueMicroFamilyId || '';
}

function microMicroIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);

  if (p.isMicroMicro) return p.microMicroFamilyId;

  const direct = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId
  ]
    .map((x) => parseShortTaxonomyMicroId(x))
    .find((x) => x.isMicroMicro);

  if (direct) return direct.microMicroFamilyId;

  const child = childIdFrom(id, row);
  if (!child) return '';

  const hash = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);

  if (hash.length >= 6) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
  }

  const xr = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,64})$/u.exec(
    upper(row.executionMicroFamilyId || row.executionFingerprintMicroFamilyId || '')
  );

  if (xr) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${xr[2].slice(0, MICRO_MICRO_HASH_LEN)}`;
  }

  return '';
}

function normalizeLearningFamilyId(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);

  if (p.isMicroMicro) return p.microMicroFamilyId;
  if (p.isChild) return p.childTrueMicroFamilyId;
  if (p.isParent) return p.parentTrueMicroFamilyId;

  const direct = [
    row.id,
    row.key,
    row.rowId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.parentTrueMicroFamilyId
  ];

  for (const candidate of direct) {
    const parsed = parseShortTaxonomyMicroId(candidate);

    if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
    if (parsed.isChild) return parsed.childTrueMicroFamilyId;
    if (parsed.isParent) return parsed.parentTrueMicroFamilyId;
  }

  const mm = microMicroIdFrom(id, row);
  if (mm) return mm;

  const child = childIdFrom(id, row);
  if (child) return child;

  return parentIdFrom(id, row);
}

function rowIdentityId(row = {}) {
  const explicitMicroMicro = microMicroIdFrom(
    row.id ||
      row.key ||
      row.rowId ||
      row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId,
    row
  );

  if (explicitMicroMicro && isMicroMicroId(explicitMicroMicro)) {
    return explicitMicroMicro;
  }

  return normalizeLearningFamilyId(
    row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.id ||
      row.key ||
      row.rowId ||
      row.microFamilyId ||
      row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.parentTrueMicroFamilyId,
    row
  );
}

function inferTradeSide(row = {}) {
  const direct = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.entrySide,
    row.analysisSide,
    row.scannerSide,
    row.actualScannerSide,
    row.side
  ]
    .map((x) => sideToTradeSideSafe(upper(x)))
    .find((x) => x === TARGET_TRADE_SIDE || x === OPPOSITE_TRADE_SIDE);

  if (direct) return direct;

  const text = upper([
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.definition,
    row.scannerReason,
    row.reason
  ].filter(Boolean).join('|'));

  if (text.includes('MICRO_SHORT') || text.includes('SHORT') || text.includes('BEAR')) return TARGET_TRADE_SIDE;
  if (text.includes('MICRO_LONG') || text.includes('LONG') || text.includes('BULL')) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShort(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function hasAnyGeometryField(row = {}) {
  return Boolean(
    hasValue(row.entry) ||
      hasValue(row.entryPrice) ||
      hasValue(row.sl) ||
      hasValue(row.initialSl) ||
      hasValue(row.tp)
  );
}

function hasCompleteGeometryFields(row = {}) {
  return Boolean(
    finite(row.entry ?? row.entryPrice) &&
      finite(row.sl ?? row.initialSl) &&
      finite(row.tp)
  );
}

function isActionableTradeGeometryRow(row = {}) {
  if (!row || typeof row !== 'object') return false;
  if (isAggregateLearningStatsRow(row)) return false;

  const type = upper(row.type || row.eventType || row.rowType || '');
  const source = upper(row.source || row.outcomeSource || row.positionSource || '');

  if (
    type.includes('OUTCOME') ||
    type.includes('POSITION') ||
    type.includes('TRADE') ||
    type.includes('ENTRY') ||
    type.includes('CANDIDATE') ||
    type.includes('SIGNAL')
  ) {
    return true;
  }

  if (
    source.includes('POSITION') ||
    source.includes('TRADE') ||
    source.includes('VIRTUAL') ||
    source.includes('SHADOW')
  ) {
    return Boolean(row.tradeId || row.positionId || row.symbol || hasAnyGeometryField(row));
  }

  return Boolean(
    row.tradeId ||
      row.positionId ||
      row.orderId ||
      (
        (row.symbol || row.contractSymbol) &&
        hasAnyGeometryField(row) &&
        !hasAggregateStatsFields(row)
      )
  );
}

function validShortGeometry(row = {}) {
  if (!hasAnyGeometryField(row)) return true;
  if (!isActionableTradeGeometryRow(row)) return true;
  if (!hasCompleteGeometryFields(row)) return true;

  const entry = n(row.entry ?? row.entryPrice, 0);
  const sl = n(row.sl ?? row.initialSl, 0);
  const tp = n(row.tp, 0);

  return entry > 0 && tp > 0 && sl > 0 && tp < entry && entry < sl;
}

function isKnownForbiddenFamily(row = {}) {
  const text = upper([
    row.id,
    row.key,
    row.rowId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.scannerMicroFamilyId,
    row.executionMicroFamilyId
  ].filter(Boolean).join('|'));

  return (
    text.includes('SCANNER_GATE') ||
    text.includes('__SCANNER__') ||
    text.includes('MICRO_SHORT_SCANNER__') ||
    text.includes('SHORT_SCANNER_') ||
    text.includes('MICRO_LONG_') ||
    text.includes('LONG_SCANNER_')
  );
}

function policyBlockedGate(row = {}) {
  const id = rowIdentityId(row);
  const parsed = parseShortTaxonomyMicroId(id);
  const reasons = [];

  const side = inferTradeSide(row);

  if (side !== TARGET_TRADE_SIDE) {
    reasons.push(side === OPPOSITE_TRADE_SIDE ? 'NON_SHORT_LONG_DISABLED' : 'INVALID_SIDE_UNKNOWN');
  }

  const geometryCheckApplied = isActionableTradeGeometryRow(row) && hasCompleteGeometryFields(row);

  if (geometryCheckApplied && !validShortGeometry(row)) {
    reasons.push('INVALID_GEOMETRY_TP_LT_ENTRY_LT_SL_REQUIRED');
  }

  if (isKnownForbiddenFamily(row)) {
    reasons.push('KNOWN_FORBIDDEN_FAMILY');
  }

  const confirmation = upper(row.confirmationProfile || parsed.confirmationProfile || '');

  if (confirmation === 'E_WEAK_CONTRA') {
    reasons.push('E_WEAK_CONTRA_POLICY_BLOCK');
  }

  if (row.policyBlocked === true && row.policyBlockedReason) {
    const reason = upper(row.policyBlockedReason);

    if (
      reason === 'E_WEAK_CONTRA_POLICY_BLOCK' ||
      reason.includes('SCANNER') ||
      reason.includes('EXECUTION') ||
      reason.includes('LONG') ||
      reason.includes('SIDE') ||
      (
        reason.includes('GEOMETRY') &&
        geometryCheckApplied &&
        !validShortGeometry(row)
      )
    ) {
      reasons.push(row.policyBlockedReason);
    }
  }

  return {
    version: POLICY_BLOCK_GATE_VERSION,
    blocked: reasons.length > 0,
    policyBlocked: reasons.length > 0,
    reasons: uniq(reasons),
    reason: reasons[0] || null,
    systemRules: [
      'E_WEAK_CONTRA',
      'INVALID_SIDE',
      'INVALID_GEOMETRY_ACTIONABLE_TRADE_ROWS_ONLY',
      'NON_SHORT',
      'KNOWN_FORBIDDEN_FAMILY'
    ],
    geometryCheckApplied,
    aggregateLearningStatsRow: isAggregateLearningStatsRow(row),
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    currentFitPolicyBlockDisabled: true,
    marketWeatherPolicyBlockDisabled: true,
    inheritedForbiddenPolicyIgnoredUnlessExplicitSystemRule: true
  };
}

function avgRLCB95(row = {}) {
  const repaired = repairStatsInvariants(row);

  if (hasUsableNetStats(repaired)) {
    return finalizeNetRStats(repaired.netRStats || repaired.shortNetRStats || repaired.outcomeNetRStats).lcb95AvgR;
  }

  const explicit = n(
    repaired.standaloneMicroMicroLifetimeLCB95AvgR ??
      repaired.exactMicroMicroLifetimeLCB95AvgR ??
      repaired.avgRLCB95 ??
      repaired.lcb95AvgR ??
      repaired.avgRLowerBound95,
    NaN
  );

  if (Number.isFinite(explicit)) return explicit;

  const completed = n(repaired.completed ?? repaired.outcomeSample ?? repaired.closed, 0);
  const avgR = n(repaired.avgR ?? repaired.netAvgR, 0);

  if (completed <= 1) return 0;

  return avgR - 1.96 * (1 / Math.sqrt(completed));
}

function empiricalVetoGate(row = {}) {
  const id = rowIdentityId(row);
  const exact = isMicroMicroId(id);
  const repaired = repairStatsInvariants(row);
  const completed = n(repaired.completed ?? repaired.outcomeSample ?? repaired.closed, 0);
  const lcb = avgRLCB95(repaired);

  const explicit =
    row.empiricalVeto === true &&
    (!row.empiricalVetoReason || row.empiricalVetoReason === 'EXACT_MICRO_MICRO_LCB95_NEGATIVE');

  const triggered =
    exact &&
    completed >= MIN_COMPLETED_EMPIRICAL_VETO &&
    lcb < 0;

  return {
    version: EMPIRICAL_VETO_VERSION,
    triggered: triggered || explicit,
    empiricalVeto: triggered || explicit,
    empiricalVetoReason: triggered || explicit ? 'EXACT_MICRO_MICRO_LCB95_NEGATIVE' : null,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoBlocksParentFallbackRescue: true,
    shrinkageCannotOverrideVeto: true,
    id,
    exactMicroMicroFamilyId: exact ? id : null,
    completed: round4(completed),
    minCompleted: MIN_COMPLETED_EMPIRICAL_VETO,
    lcb95AvgR: round6(lcb),
    threshold: 0
  };
}

function signalTypeFromGate({ passed, observing, policyBlocked, empiricalVetoStatus, rejected, riskFractionForEntry }) {
  if (policyBlocked || empiricalVetoStatus || rejected) return SIGNAL_TYPE_BLOCKED;
  if (passed && riskFractionForEntry > 0) return SIGNAL_TYPE_TRADE_READY;
  if (passed) return SIGNAL_TYPE_WATCH_ONLY;
  if (observing) return SIGNAL_TYPE_OBSERVE_ONLY;

  return SIGNAL_TYPE_BLOCKED;
}

function applyRuntimeGates(row = {}) {
  const withWeather = attachEntryMarketWeather(
    row,
    row.entryMarketWeatherCapturedAt || row.createdAt || row.openedAt || now()
  );

  const repaired = repairStatsInvariants(withWeather);
  const id = rowIdentityId(repaired);
  const parsed = parseShortTaxonomyMicroId(id);
  const completed = n(repaired.completed ?? repaired.outcomeSample ?? repaired.closed, 0);
  const avgR = n(repaired.avgR ?? repaired.netAvgR, 0);
  const totalR = n(repaired.totalR ?? repaired.netTotalR, 0);
  const pf = n(repaired.profitFactor ?? repaired.pf, 0);
  const avgCostR = n(repaired.avgCostR, 0);
  const directSLPct = n(repaired.directSLPct, 0);
  const lcb = avgRLCB95(repaired);
  const unknownWeather = isUnknownEntryMarketWeather(repaired);

  if (!parsed.isMicroMicro) {
    return flags({
      ...repaired,
      avgRLCB95: round6(lcb),
      lcb95AvgR: round6(lcb),
      microMicroRuntimeStatus: MICRO_MICRO_STATUS_CONTEXT_ONLY,
      microMicroRuntimeGateStatus: MICRO_MICRO_STATUS_CONTEXT_ONLY,
      microMicroStatus: MICRO_MICRO_STATUS_CONTEXT_ONLY,
      microMicroRuntimeGate: {
        version: MICRO_MICRO_RUNTIME_GATE_VERSION,
        status: MICRO_MICRO_STATUS_CONTEXT_ONLY,
        contextOnly: true,
        passed: false,
        observing: false,
        rejected: false,
        empiricalVeto: false,
        empiricalVetoDetected: false,
        policyBlocked: false,
        reason: 'PARENT_OR_CHILD_CONTEXT_ONLY_NOT_SELECTABLE',
        id
      },
      signalType: SIGNAL_TYPE_OBSERVE_ONLY,
      riskFractionForEntry: 0
    });
  }

  const policyGate = policyBlockedGate(repaired);
  const vetoGate = empiricalVetoGate({
    ...repaired,
    avgRLCB95: lcb,
    lcb95AvgR: lcb
  });

  const edgeReasons = [];

  if (!(lcb > 0)) edgeReasons.push('LCB95_AVG_R_NOT_POSITIVE');
  if (!(avgR > 0)) edgeReasons.push('AVG_R_NET_NOT_POSITIVE');
  if (!(totalR > 0)) edgeReasons.push('TOTAL_R_NET_NOT_POSITIVE');
  if (!(pf > 1)) edgeReasons.push('PROFIT_FACTOR_NOT_ABOVE_1');
  if (avgCostR > 0.35) edgeReasons.push('AVG_COST_R_TOO_HIGH');
  if (directSLPct > 0.25) edgeReasons.push('DIRECT_SL_PCT_TOO_HIGH');

  let status = MICRO_MICRO_STATUS_OBSERVING;
  let reason = `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`;
  let reasons = [reason];

  if (policyGate.blocked) {
    status = MICRO_MICRO_STATUS_POLICY_BLOCKED;
    reason = policyGate.reason;
    reasons = policyGate.reasons;
  } else if (vetoGate.triggered) {
    status = MICRO_MICRO_STATUS_EMPIRICAL_VETO;
    reason = vetoGate.empiricalVetoReason;
    reasons = [reason];
  } else if (unknownWeather) {
    status = MICRO_MICRO_STATUS_OBSERVING;
    reason = 'MARKET_WEATHER_UNKNOWN';
    reasons = [reason];
  } else if (completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE) {
    status = MICRO_MICRO_STATUS_OBSERVING;
  } else if (edgeReasons.length) {
    status = MICRO_MICRO_STATUS_REJECTED;
    reason = edgeReasons[0];
    reasons = edgeReasons;
  } else {
    status = MICRO_MICRO_STATUS_PASSED;
    reason = 'MICRO_MICRO_RUNTIME_GATE_PASSED';
    reasons = [reason];
  }

  const passed = status === MICRO_MICRO_STATUS_PASSED;
  const empiricalVetoStatus = status === MICRO_MICRO_STATUS_EMPIRICAL_VETO;
  const empiricalVetoDetected = vetoGate.triggered;
  const policyBlocked = status === MICRO_MICRO_STATUS_POLICY_BLOCKED;
  const rejected = status === MICRO_MICRO_STATUS_REJECTED;
  const observing = status === MICRO_MICRO_STATUS_OBSERVING;

  const rawRisk = n(
    repaired.riskFractionForEntry ??
      repaired.riskFraction ??
      repaired.positionRiskFraction,
    0
  );

  const riskFractionForEntry = passed && rawRisk > 0 ? rawRisk : 0;

  const signalType = signalTypeFromGate({
    passed,
    observing,
    policyBlocked,
    empiricalVetoStatus,
    rejected,
    riskFractionForEntry
  });

  return flags({
    ...repaired,

    avgRLCB95: round6(lcb),
    lcb95AvgR: round6(lcb),

    empiricalVeto: empiricalVetoDetected,
    empiricalVetoDetected,
    empiricalVetoAlsoDetected: policyBlocked && empiricalVetoDetected,
    empiricalVetoReason: vetoGate.empiricalVetoReason,
    empiricalVetoGate: vetoGate,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

    policyBlocked,
    policyBlockedReason: policyGate.reason,
    policyBlockedGate: policyGate,

    marketWeatherUnknown: unknownWeather,
    marketWeatherUnknownReason: unknownWeather ? 'MARKET_WEATHER_UNKNOWN' : null,

    microMicroRuntimeStatus: status,
    microMicroRuntimeGateStatus: status,
    microMicroStatus: status,
    microMicroPassed: passed,
    microMicroObserving: observing,
    microMicroRejected: rejected,
    microMicroEmpiricalVeto: empiricalVetoStatus,
    microMicroEmpiricalVetoDetected: empiricalVetoDetected,
    microMicroPolicyBlocked: policyBlocked,

    signalType,
    proofTier: passed
      ? riskFractionForEntry > 0
        ? 'EXACT_MICRO_MICRO_LCB95_PROOF'
        : 'PASSED_RISK_ZERO_WAITING_FOR_POSITION_SIZING'
      : observing
        ? 'OBSERVATION_ONLY'
        : policyBlocked
          ? 'POLICY_BLOCKED'
          : empiricalVetoStatus
            ? 'EMPIRICAL_VETO'
            : 'BLOCKED',

    riskFractionForEntry,

    microMicroRuntimeGate: {
      version: MICRO_MICRO_RUNTIME_GATE_VERSION,
      status,
      passed,
      observing,
      rejected,
      empiricalVeto: empiricalVetoStatus,
      empiricalVetoDetected,
      empiricalVetoAlsoDetected: policyBlocked && empiricalVetoDetected,
      policyBlocked,
      marketWeatherUnknown: unknownWeather,
      reason,
      reasons,
      edgeReasons,
      policyReasons: policyGate.reasons,

      eligible: passed,
      tradingEligible: passed && riskFractionForEntry > 0,
      discordEligible: passed && riskFractionForEntry > 0,
      discordActivationEligible: passed && riskFractionForEntry > 0,

      virtualLearningAllowed: passed || observing,
      virtualObservationAllowed: passed || observing,
      virtualEntryAllowed: passed || observing,

      blocksNewVirtualEntry: empiricalVetoStatus || policyBlocked || rejected,
      blocksLiveRiskEntry: empiricalVetoStatus || empiricalVetoDetected || policyBlocked || rejected || unknownWeather || riskFractionForEntry <= 0,
      blocksDiscordTradeReady: signalType !== SIGNAL_TYPE_TRADE_READY,

      id,
      microMicroFamilyId: id,
      completed: round4(completed),
      avgR: round4(avgR),
      avgRLCB95: round6(lcb),
      lcb95AvgR: round6(lcb),
      totalR: round4(totalR),
      profitFactor: round4(pf),
      avgCostR: round4(avgCostR),
      directSLPct: round4(directSLPct),
      empiricalVetoGate: vetoGate,
      policyGate,
      netRStatsVersion: NET_R_STATS_VERSION,
      statsInvariantVersion: STATS_INVARIANT_VERSION
    }
  });
}

function slimOutcome(row = {}) {
  if (!row || typeof row !== 'object') return row;

  const withWeather = attachEntryMarketWeather(
    row,
    row.entryMarketWeatherCapturedAt || row.openedAt || row.createdAt || row.completedAt || now()
  );

  const mm = microMicroIdFrom(
    withWeather.microMicroFamilyId ||
      withWeather.trueMicroMicroFamilyId ||
      withWeather.exactMicroMicroFamilyId ||
      withWeather.learningFamilyId ||
      withWeather.learningMicroFamilyId ||
      withWeather.analyzeMicroFamilyId ||
      withWeather.microFamilyId ||
      withWeather.trueMicroFamilyId,
    withWeather
  );

  const child = childIdFrom(
    mm ||
      withWeather.childTrueMicroFamilyId ||
      withWeather.trueMicroFamilyId ||
      withWeather.microFamilyId,
    withWeather
  );

  const parent = parentIdFrom(child || mm, withWeather);
  const primaryId = mm || child || parent || null;
  const netR = outcomeNetR(withWeather);
  const grossR = calcShortGrossRFromEvent(withWeather);
  const costR = outcomeCostR(withWeather);

  return flags({
    type: withWeather.type || 'OUTCOME',
    source: withWeather.source || withWeather.outcomeSource || 'VIRTUAL',
    outcomeSource: withWeather.outcomeSource || withWeather.source || 'VIRTUAL',

    symbol: withWeather.symbol || null,
    contractSymbol: withWeather.contractSymbol || null,
    tradeId: withWeather.tradeId || null,
    positionId: withWeather.positionId || null,

    entry: n(withWeather.entry, 0),
    exit: n(withWeather.exit ?? withWeather.exitPrice, 0),
    exitPrice: n(withWeather.exitPrice ?? withWeather.exit, 0),
    exitReason: withWeather.exitReason || withWeather.reason || null,

    openedAt: withWeather.openedAt || withWeather.createdAt || null,
    closedAt: withWeather.closedAt || withWeather.completedAt || withWeather.ts || null,
    completedAt: withWeather.completedAt || withWeather.closedAt || withWeather.ts || null,

    netR,
    shortNetR: netR,
    exitR: netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,

    grossR,
    shortGrossR: grossR,
    rawR: grossR,

    costR,
    avgCostR: costR,

    win: withWeather.win === true || netR > 0,
    loss: withWeather.loss === true || netR < 0,
    flat: withWeather.flat === true || netR === 0,

    directSL: Boolean(withWeather.directSL || withWeather.directToSL),
    directToSL: Boolean(withWeather.directSL || withWeather.directToSL),

    entryMarketWeatherKey: withWeather.entryMarketWeatherKey,
    entryMarketWeatherKeyVersion: withWeather.entryMarketWeatherKeyVersion,
    entryMarketWeatherRegime: withWeather.entryMarketWeatherRegime,
    entryMarketWeatherTrendSide: withWeather.entryMarketWeatherTrendSide,
    entryMarketWeatherCapturedAt: withWeather.entryMarketWeatherCapturedAt,
    entryMarketWeatherRaw: withWeather.entryMarketWeatherRaw,
    entryMarketWeatherRawAvailableFields: withWeather.entryMarketWeatherRawAvailableFields,

    primaryLearningFamilyId: primaryId,
    primaryLearningIdentity: mm ? 'MICRO_MICRO' : child ? 'CHILD75_CONTEXT' : 'PARENT15_CONTEXT',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    learningFamilyId: primaryId,
    learningMicroFamilyId: primaryId,
    analyzeMicroFamilyId: primaryId,

    microFamilyId: primaryId,
    trueMicroFamilyId: primaryId,

    childTrueMicroFamilyId: child || null,
    base75ChildTrueMicroFamilyId: child || null,
    parentTrueMicroFamilyId: parent || null,

    microMicroFamilyId: mm || null,
    trueMicroMicroFamilyId: mm || null,
    exactMicroMicroFamilyId: mm || null,

    empiricalVeto: Boolean(withWeather.empiricalVeto),
    empiricalVetoReason: withWeather.empiricalVetoReason || null,
    policyBlocked: Boolean(withWeather.policyBlocked),
    policyBlockedReason: withWeather.policyBlockedReason || null,

    outcomeDedupeKey: withWeather.outcomeDedupeKey || null,
    outcomeDedupeVersion: withWeather.outcomeDedupeVersion || OUTCOME_DEDUPE_VERSION
  });
}

function sanitizeStatsRow(row = {}) {
  if (!row || typeof row !== 'object') return {};

  const withWeather = attachEntryMarketWeather(
    row,
    row.entryMarketWeatherCapturedAt || row.createdAt || row.openedAt || now()
  );

  const clone = {
    ...withWeather
  };

  delete clone.recordOutcomeResult;
  delete clone.openPositionDeleteResult;
  delete clone.discordExitAlertResult;
  delete clone.position;
  delete clone.outcome;
  delete clone.raw;
  delete clone.rawPosition;
  delete clone.rawOutcome;
  delete clone.rawSnapshot;
  delete clone.scannerSnapshot;
  delete clone.currentMarketUniverse;
  delete clone.entryMarketUniverse;
  delete clone.marketUniverseRows;
  delete clone.universeRows;

  clone.definitionParts = Array.isArray(row.definitionParts)
    ? row.definitionParts.slice(0, 64)
    : [];

  clone.parentDefinitionParts = Array.isArray(row.parentDefinitionParts)
    ? row.parentDefinitionParts.slice(0, 48)
    : [];

  clone.microMicroDefinitionParts = Array.isArray(row.microMicroDefinitionParts)
    ? row.microMicroDefinitionParts.slice(0, 64)
    : [];

  clone.executionFingerprintParts = Array.isArray(row.executionFingerprintParts)
    ? row.executionFingerprintParts.slice(0, 64)
    : [];

  clone.examples = Array.isArray(row.examples)
    ? row.examples.slice(-12).map((example) => (
      example && typeof example === 'object'
        ? {
            symbol: example.symbol || null,
            contractSymbol: example.contractSymbol || null,
            createdAt: example.createdAt || example.openedAt || null,
            source: example.source || 'VIRTUAL'
          }
        : example
    ))
    : [];

  clone.recentOutcomes = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes.slice(-100).map(slimOutcome)
    : [];

  if (row.netRStats && typeof row.netRStats === 'object') {
    clone.netRStats = finalizeNetRStats(row.netRStats);
  }

  if (row.shortNetRStats && typeof row.shortNetRStats === 'object') {
    clone.shortNetRStats = finalizeNetRStats(row.shortNetRStats);
  }

  if (row.outcomeNetRStats && typeof row.outcomeNetRStats === 'object') {
    clone.outcomeNetRStats = finalizeNetRStats(row.outcomeNetRStats);
  }

  return repairStatsInvariants(clone);
}

function safeRefreshStats(row = {}) {
  const safeRow = repairStatsInvariants(sanitizeStatsRow(row));

  if (typeof Scoring.refreshStats !== 'function') {
    return applyRuntimeGates(safeRow);
  }

  try {
    const refreshed = Scoring.refreshStats(safeRow);
    const merged = repairStatsInvariants({
      ...safeRow,
      ...refreshed,
      netRStats: safeRow.netRStats || refreshed?.netRStats || null,
      shortNetRStats: safeRow.shortNetRStats || refreshed?.shortNetRStats || null,
      outcomeNetRStats: safeRow.outcomeNetRStats || refreshed?.outcomeNetRStats || null
    });

    return applyRuntimeGates(merged);
  } catch (error) {
    return applyRuntimeGates({
      ...safeRow,
      refreshStatsFallbackUsed: true,
      refreshStatsFallbackReason: error?.message || String(error)
    });
  }
}

function normalizeSetup(value = '') {
  const v = norm(value);

  if (SETUPS.has(v)) return v;
  if (v.includes('SWEEP') || v.includes('REVERSAL') || v.includes('LIQUIDITY')) return 'SWEEP_REVERSAL';
  if (v.includes('RETEST') || v.includes('PULLBACK')) return 'RETEST';
  if (v.includes('SQUEEZE') || v.includes('COMPRESSION') || v.includes('COIL')) return 'COMPRESSION';
  if (v.includes('BREAKOUT') || v.includes('BREAKDOWN')) return 'BREAKOUT';
  if (v.includes('CONTINUATION') || v.includes('MOMENTUM') || v.includes('TREND')) return 'CONTINUATION';

  return null;
}

function normalizeRegime(value = '') {
  const v = norm(value);

  if (REGIMES.has(v)) return v;
  if (v.includes('SQUEEZE') || v.includes('LOW_VOL') || v.includes('TIGHT')) return 'SQUEEZE';
  if (v.includes('CHOP') || v.includes('RANGE') || v.includes('SIDEWAYS')) return 'CHOP';
  if (v.includes('TREND') || v.includes('NORMAL_VOL') || v.includes('HIGH_VOL') || v.includes('IMPULSE')) return 'TREND';

  return null;
}

function normalizeConfirmation(value = '') {
  const v = norm(value);

  if (CONFIRMATIONS.has(v)) return v;
  if (v.includes('STRONG') || v.includes('FULL_ALIGN') || v.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
  if (v.includes('FLOW') || v.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
  if (v.includes('VOLUME') || v.includes('VOL')) return 'C_VOLUME_ALIGN';
  if (v.includes('WEAK') || v.includes('CONTRA') || v.includes('AGAINST')) return 'E_WEAK_CONTRA';
  if (v.includes('MIXED') || v.includes('NEUTRAL') || v.includes('OK')) return 'D_MIXED_OK';

  return null;
}

function classifyTaxonomy(row = {}, classified = {}) {
  const explicit = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.learningFamilyId,
    row.analyzeMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId,
    classified.childTrueMicroFamilyId,
    classified.microMicroFamilyId,
    classified.trueMicroMicroFamilyId,
    classified.exactMicroMicroFamilyId
  ]
    .map((x) => parseShortTaxonomyMicroId(x))
    .find((x) => x.isChild || x.isMicroMicro);

  if (explicit) {
    const child = explicit.childTrueMicroFamilyId;

    return {
      setup: explicit.setup,
      regime: explicit.regime,
      confirmation: explicit.confirmationProfile,
      parentId: explicit.parentTrueMicroFamilyId,
      childId: child
    };
  }

  const text = [
    row.setupType,
    row.setup,
    row.pattern,
    row.scannerReason,
    row.reason,
    row.definition,
    classified.setupType,
    classified.setup,
    classified.scannerReason,
    classified.definition
  ].filter(Boolean).join('|');

  const setup = normalizeSetup(text) || 'CONTINUATION';

  const regime = normalizeRegime(
    row.regimeBucket ||
      row.regime ||
      row.regimeCoarse ||
      classified.regimeBucket ||
      classified.regime ||
      classified.regimeCoarse
  ) || 'TREND';

  const confluence = n(
    row.confluence ??
      row.sniperScore ??
      row.scannerScore ??
      row.moveScore ??
      classified.confluence ??
      classified.sniperScore,
    0
  );

  const confirmation = normalizeConfirmation(row.confirmationProfile || classified.confirmationProfile || text) ||
    (confluence >= 80
      ? 'A_STRONG_ALIGN'
      : confluence >= 65
        ? 'B_FLOW_ALIGN'
        : 'D_MIXED_OK');

  const parentId = `MICRO_SHORT_${setup}_${regime}`;

  return {
    setup,
    regime,
    confirmation,
    parentId,
    childId: `${parentId}_${confirmation}`
  };
}

function buildExecutionParts(row = {}, classified = {}, taxonomy = {}) {
  return [
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.childId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
    `SETUP=${taxonomy.setup}`,
    `REGIME_BUCKET=${taxonomy.regime}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmation}`,
    `RSI=${norm(row.rsiZone || row.rsiCoarse || classified.rsiZone || classified.rsiCoarse || 'NA')}`,
    `FLOW=${norm(row.flowCoarse || row.flow || classified.flowCoarse || classified.flow || 'NA')}`,
    `OB_REL=${norm(row.obRelation || classified.obRelation || 'NA')}`,
    `BTC_STATE=${norm(row.btcState || classified.btcState || 'NA')}`,
    `BTC_REL=${norm(row.btcRelation || classified.btcRelation || 'NA')}`,
    `CURRENT_FIT=${norm(row.currentFit || row.entryCurrentFit || 'NA')}`,
    `SCANNER=${norm(row.scannerReasonCoarse || row.scannerReason || row.reason || classified.scannerReason || 'NA')}`,
    `SPREAD=${norm(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${norm(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${norm(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONF=${norm(row.confluence ?? row.sniperScore ?? row.scannerScore ?? row.moveScore ?? 'NA')}`,
    `ENTRY_DIST=${norm(row.entryDistancePct ?? row.entryDistanceBps ?? 'NA')}`,
    `RISK=${norm(row.riskPct ?? row.slDistancePct ?? 'NA')}`,
    `REWARD=${norm(row.rewardPct ?? row.tpDistancePct ?? 'NA')}`,
    `FAKE=${row.fakeBreakout || row.fakeBreakoutRisk ? 'YES' : 'NO'}`,
    `WEAK_CONTRA_GATE=${WEAK_CONTRA_ENTRY_GATE_VERSION}`,
    `RISK_PLAN=${row.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    'SYMBOL_EXCLUDED=true',
    'COIN_EXCLUDED=true',
    'MARKET_WEATHER_EXCLUDED_FROM_FAMILY_ID=true',
    'EXECUTION_FINGERPRINT_ROLE=MICRO_MICRO_HASH_SOURCE',
    'EXECUTION_FINGERPRINT_USED_AS_LEARNING_FAMILY=false'
  ];
}

function buildMicroMicroFromChildAndRow(child, row = {}) {
  const parsed = parseShortTaxonomyMicroId(child);

  if (!parsed.isChild) return '';

  const direct = microMicroIdFrom(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId,
    {
      ...row,
      childTrueMicroFamilyId: child
    }
  );

  if (direct && isMicroMicroId(direct)) return direct;

  const directHash = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);

  if (directHash.length >= 6) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${directHash}`;
  }

  const taxonomy = {
    setup: parsed.setup,
    regime: parsed.regime,
    confirmation: parsed.confirmationProfile,
    parentId: parsed.parentTrueMicroFamilyId,
    childId: child
  };

  const parts = buildExecutionParts(row, {}, taxonomy);
  const hash = hashText(parts.join('|'), MICRO_MICRO_HASH_LEN);

  return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
}

function spreadBps(row = {}) {
  if (finite(row.spreadBps)) return Math.abs(Number(row.spreadBps));

  if (finite(row.spreadPct)) {
    return Math.abs(Number(row.spreadPct)) * 10000;
  }

  return null;
}

function volumeExpansionScore(row = {}) {
  return Math.max(
    n(row.volumeExpansion, 0),
    n(row.relativeVolume, 0),
    n(row.relVolume, 0),
    n(row.volumeStrength, 0),
    n(row.volumeScore, 0) >= 100 ? n(row.volumeScore, 0) / 100 : n(row.volumeScore, 0)
  );
}

function hasBearishEntryBar(row = {}) {
  const text = upper([
    row.entryBar,
    row.entryBarDirection,
    row.entryCandle,
    row.entryCandleDirection,
    row.triggerCandle,
    row.triggerCandleDirection,
    row.breakCandle,
    row.breakCandleDirection,
    row.reason,
    row.scannerReason,
    row.entryReason
  ].filter(Boolean).join('|'));

  return Boolean(
    row.entryBarConfirmed ||
      row.entryCandleConfirmed ||
      row.triggerCandleConfirmed ||
      row.breakdownCandleConfirmed ||
      row.shortEntryConfirmed ||
      row.candleCloseBelowEntry ||
      row.closeBelowEntry ||
      row.closeBelowTrigger ||
      row.breakdownConfirmed ||
      row.retestConfirmed ||
      row.sweepConfirmed ||
      text.includes('BEAR') ||
      text.includes('SHORT') ||
      text.includes('SELL') ||
      text.includes('BREAKDOWN') ||
      text.includes('CLOSE_BELOW')
  );
}

function hasBearishFlow(row = {}) {
  const text = upper([
    row.flow,
    row.flowCoarse,
    row.orderFlow,
    row.marketFlow,
    row.obRelation,
    row.btcRelation,
    row.currentTrendSide,
    row.entryCurrentTrendSide,
    row.currentFit,
    row.entryCurrentFit,
    row.reason,
    row.scannerReason
  ].filter(Boolean).join('|'));

  const fitScore = n(row.currentFitScore ?? row.entryCurrentFitScore, 0);
  const fitConfidence = n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);

  return Boolean(
    row.flowAlign ||
      row.flowAligned ||
      row.bearFlow ||
      row.sellFlow ||
      row.askFlowAlign ||
      text.includes('WITH') ||
      text.includes('BEAR') ||
      text.includes('SHORT') ||
      text.includes('SELL') ||
      text.includes('MATCH') ||
      fitScore >= 20 ||
      fitConfidence >= 65
  );
}

function evaluateWeakContraEntryGate(row = {}, taxonomy = {}) {
  const confirmation = taxonomy.confirmation || row.confirmationProfile || '';
  const isWeakContra = confirmation === 'E_WEAK_CONTRA';

  const entryBarOk = hasBearishEntryBar(row);
  const flowOk = hasBearishFlow(row);

  const volume = volumeExpansionScore(row);
  const volumeOk = Boolean(
    row.volumeSpike ||
      row.volumeConfirmed ||
      row.volumeAlign ||
      row.volumeAligned ||
      row.volumeSpikeConfirmed ||
      row.quoteVolumeSpike ||
      row.obVolumeAlign ||
      volume >= 1.6
  );

  const bps = spreadBps(row);
  const spreadOk = bps === null || bps <= 15;

  const currentFit = upper(row.currentFit || row.entryCurrentFit || '');
  const currentFitOk =
    currentFit.includes('MATCH') ||
    n(row.currentFitScore ?? row.entryCurrentFitScore, 0) >= 20 ||
    n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0) >= 60;

  const diagnosticStrictEntryOk = entryBarOk && flowOk && (volumeOk || currentFitOk) && spreadOk;

  if (!isWeakContra) {
    return {
      version: WEAK_CONTRA_ENTRY_GATE_VERSION,
      enabled: true,
      isWeakContra: false,
      ok: true,
      rejected: false,
      policyBlocked: false,
      reason: 'NOT_E_WEAK_CONTRA',
      entryBarOk,
      flowOk,
      volumeOk,
      currentFitOk,
      spreadOk,
      blocksVirtualEntry: false,
      blocksLearning: false
    };
  }

  return {
    version: WEAK_CONTRA_ENTRY_GATE_VERSION,
    enabled: true,
    isWeakContra: true,
    ok: false,
    rejected: true,
    policyBlocked: true,
    reason: 'E_WEAK_CONTRA_POLICY_BLOCK',
    diagnosticStrictEntryOk,
    entryBarOk,
    flowOk,
    volumeOk,
    currentFitOk,
    spreadOk,
    spreadBps: bps,
    volumeExpansion: volume,
    blocksVirtualEntry: true,
    blocksLearning: false
  };
}

function classifyMacroFamilySafe(row = {}) {
  if (typeof MicroFamilies.classifyMacroFamily !== 'function') return {};

  try {
    return MicroFamilies.classifyMacroFamily(row) || {};
  } catch {
    return {};
  }
}

function classifyMicroFamilySafe(row = {}) {
  if (typeof MicroFamilies.classifyMicroFamily !== 'function') return {};

  try {
    return MicroFamilies.classifyMicroFamily(row) || {};
  } catch {
    return {};
  }
}

function enrichWithMicroFamily(row = {}) {
  if (!isShort(row)) return null;

  const withWeather = attachEntryMarketWeather(row, row.createdAt || row.openedAt || now());
  const classified = {
    ...classifyMacroFamilySafe(withWeather),
    ...classifyMicroFamilySafe(withWeather)
  };

  const taxonomy = classifyTaxonomy(withWeather, classified);
  const weakContraEntryGate = evaluateWeakContraEntryGate(withWeather, taxonomy);

  const executionParts = buildExecutionParts(withWeather, classified, taxonomy);
  const executionHash = hashText(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);
  const microMicroId =
    microMicroIdFrom(withWeather.microMicroFamilyId, {
      ...withWeather,
      childTrueMicroFamilyId: taxonomy.childId,
      executionFingerprintHash: executionHash
    }) || `${taxonomy.childId}_${MICRO_MICRO_SUFFIX}_${executionHash.slice(0, MICRO_MICRO_HASH_LEN)}`;

  const microMicroParts = [
    ...executionParts,
    `MICRO_MICRO=${microMicroId}`,
    `MICRO_MICRO_HASH=${executionHash}`,
    `LAYER=${LAYER_MICRO_MICRO}`,
    `WEAK_CONTRA_POLICY_BLOCK=${weakContraEntryGate.policyBlocked ? 'YES' : 'NO'}`,
    `ENTRY_MARKET_WEATHER_KEY=${withWeather.entryMarketWeatherKey}`,
    `ENTRY_MARKET_WEATHER_KEY_VERSION=${withWeather.entryMarketWeatherKeyVersion}`,
    `ENTRY_MARKET_WEATHER_REGIME=${withWeather.entryMarketWeatherRegime}`,
    `ENTRY_MARKET_WEATHER_TREND_SIDE=${withWeather.entryMarketWeatherTrendSide}`,
    'ENTRY_MARKET_WEATHER_CONTEXT_ONLY=true'
  ];

  return flags({
    ...withWeather,

    familyId: microMicroId,
    learningFamilyId: microMicroId,
    learningMicroFamilyId: microMicroId,
    analyzeMicroFamilyId: microMicroId,
    primaryLearningFamilyId: microMicroId,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    microFamilyId: microMicroId,
    trueMicroFamilyId: microMicroId,

    childTrueMicroFamilyId: taxonomy.childId,
    base75ChildTrueMicroFamilyId: taxonomy.childId,
    child75ContextFamilyId: taxonomy.childId,

    parentTrueMicroFamilyId: taxonomy.parentId,
    coarseMicroFamilyId: taxonomy.parentId,
    baseMicroFamilyId: taxonomy.parentId,
    legacyMicroFamilyId: taxonomy.parentId,
    parentMicroFamilyId: taxonomy.parentId,
    macroFamilyId: taxonomy.parentId,
    parentMacroFamilyId: taxonomy.parentId,
    parent15ContextFamilyId: taxonomy.parentId,

    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: executionHash.slice(0, MICRO_MICRO_HASH_LEN),

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmation,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PRIMARY_LEARNING=${microMicroId}`,
      `TRUE_MICRO=${taxonomy.childId}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
      `SETUP=${taxonomy.setup}`,
      `REGIME_BUCKET=${taxonomy.regime}`,
      `CONFIRMATION_PROFILE=${taxonomy.confirmation}`,
      `ENTRY_MARKET_WEATHER_KEY=${withWeather.entryMarketWeatherKey}`,
      `ENTRY_MARKET_WEATHER_KEY_VERSION=${withWeather.entryMarketWeatherKeyVersion}`,
      `ENTRY_MARKET_WEATHER_REGIME=${withWeather.entryMarketWeatherRegime}`,
      `ENTRY_MARKET_WEATHER_TREND_SIDE=${withWeather.entryMarketWeatherTrendSide}`,
      `MEASUREMENT_FIX=${MEASUREMENT_FIX_VERSION}`,
      `NET_R_STATS=${NET_R_STATS_VERSION}`
    ],
    parentDefinitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
      `SETUP=${taxonomy.setup}`,
      `REGIME_BUCKET=${taxonomy.regime}`,
      `LAYER=${LAYER_PARENT_15}`
    ],
    microMicroDefinitionParts: microMicroParts,

    executionFingerprintHash: executionHash.slice(0, EXECUTION_MICRO_HASH_LEN),
    executionFingerprintParts: executionParts,
    executionMicroFamilyId: `${taxonomy.childId}_${EXECUTION_MICRO_SUFFIX}_${executionHash.slice(0, EXECUTION_MICRO_HASH_LEN)}`,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    scannerMicroFamilyId: withWeather.scannerMicroFamilyId || null,
    scannerFamilyId: withWeather.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    weakContraEntryGate,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejected: Boolean(weakContraEntryGate.rejected),
    weakContraAllowed: Boolean(weakContraEntryGate.ok),
    weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null,
    blockVirtualEntry: Boolean(weakContraEntryGate.blocksVirtualEntry),
    blockVirtualEntryReason: weakContraEntryGate.blocksVirtualEntry ? weakContraEntryGate.reason : null,
    weakContraRejectedBlocksLearning: false,

    policyBlocked: Boolean(weakContraEntryGate.policyBlocked),
    policyBlockedReason: weakContraEntryGate.policyBlocked ? weakContraEntryGate.reason : null,

    microMicroSelectionAllowed: true,
    exactMicroMicro: true,
    selectableLearningId: microMicroId,
    selectableMicroMicroFamilyId: microMicroId,

    riskPlanVersion: withWeather.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION
  });
}

function layerFor(id = '') {
  return parseShortTaxonomyMicroId(id).learningLayer || 'UNKNOWN';
}

function granularityFor(id = '') {
  const layer = layerFor(id);

  if (layer === LAYER_MICRO_MICRO) return MICRO_MICRO_LEARNING_GRANULARITY;
  if (layer === LAYER_PARENT_15) return PARENT_LEARNING_GRANULARITY;

  return LEARNING_GRANULARITY;
}

function schemaFor(id = '') {
  const layer = layerFor(id);

  if (layer === LAYER_MICRO_MICRO) return MICRO_MICRO_SCHEMA;
  if (layer === LAYER_PARENT_15) return PARENT_TRUE_MICRO_SCHEMA;

  return TRUE_MICRO_SCHEMA;
}

function minCompletedFor(id = '') {
  return layerFor(id) === LAYER_MICRO_MICRO
    ? MIN_COMPLETED_MICRO_MICRO_ACTIVE
    : MIN_COMPLETED_ACTIVE_LEARNING;
}

function statusFor(row = {}) {
  const completed = n(row.completed ?? row.outcomeSample, 0);
  const min = n(row.minCompletedForActiveLearning, MIN_COMPLETED_ACTIVE_LEARNING);

  if (completed >= min) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function signalTypeForRow(row = {}) {
  const status = row.microMicroRuntimeStatus || row.microMicroRuntimeGateStatus || row.microMicroStatus;
  const risk = n(row.riskFractionForEntry, 0);

  if (status === MICRO_MICRO_STATUS_PASSED && risk > 0) return SIGNAL_TYPE_TRADE_READY;
  if (status === MICRO_MICRO_STATUS_PASSED) return SIGNAL_TYPE_WATCH_ONLY;
  if (status === MICRO_MICRO_STATUS_OBSERVING) return SIGNAL_TYPE_OBSERVE_ONLY;
  if (status === MICRO_MICRO_STATUS_CONTEXT_ONLY) return SIGNAL_TYPE_OBSERVE_ONLY;

  return SIGNAL_TYPE_BLOCKED;
}

function createMicroStatsSafe(initial = {}) {
  if (typeof Scoring.createMicroStats === 'function') {
    try {
      return Scoring.createMicroStats(initial) || initial;
    } catch {
      return initial;
    }
  }

  return {
    ...initial,
    seen: 0,
    observed: 0,
    observations: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    avgR: 0,
    profitFactor: 0,
    netRStats: emptyNetRStats(),
    marketWeatherStats: normalizeWeatherStats()
  };
}

function applyLayerIdentity(row = {}, id = '') {
  const withWeather = attachEntryMarketWeather(
    row,
    row.entryMarketWeatherCapturedAt || row.createdAt || row.openedAt || now()
  );

  const learningId = normalizeLearningFamilyId(id, withWeather);
  const parsed = parseShortTaxonomyMicroId(learningId);

  if (!parsed.valid) return null;

  const isMicroMicro = parsed.isMicroMicro;
  const isChild = parsed.isChild;
  const isParent = parsed.isParent;

  const child = parsed.childTrueMicroFamilyId || childIdFrom(learningId, withWeather);
  const parent = parsed.parentTrueMicroFamilyId || parentIdFrom(learningId, withWeather);
  const mm = isMicroMicro ? parsed.microMicroFamilyId : null;

  const layer = parsed.learningLayer;
  const minCompleted = minCompletedFor(learningId);
  const layerSchema = schemaFor(learningId);
  const primaryId = isMicroMicro ? mm : learningId;

  const base = flags({
    ...sanitizeStatsRow(withWeather),

    id: learningId,
    key: learningId,
    rowId: learningId,

    learningFamilyId: learningId,
    learningMicroFamilyId: learningId,
    analyzeMicroFamilyId: learningId,
    primaryLearningFamilyId: primaryId,
    primaryLearningIdentity: isMicroMicro
      ? 'MICRO_MICRO'
      : isChild
        ? 'CHILD75_CONTEXT'
        : 'PARENT15_CONTEXT',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    microFamilyId: primaryId,
    trueMicroFamilyId: primaryId,

    childTrueMicroFamilyId: child || null,
    base75ChildTrueMicroFamilyId: child || null,
    child75ContextFamilyId: child || null,

    parentTrueMicroFamilyId: parent || null,
    parent15ContextFamilyId: parent || null,

    coarseMicroFamilyId: parent || null,
    baseMicroFamilyId: parent || null,
    legacyMicroFamilyId: parent || null,
    parentMicroFamilyId: parent || null,
    macroFamilyId: parent || null,
    parentMacroFamilyId: parent || null,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,
    microMicroHash: isMicroMicro
      ? parsed.microMicroHash || withWeather.microMicroHash || withWeather.executionFingerprintHash || null
      : null,

    relatedMicroMicroFamilyId: isMicroMicro
      ? mm
      : buildMicroMicroFromChildAndRow(child, withWeather) || null,

    setupType: parsed.setup || withWeather.setupType || null,
    regimeBucket: parsed.regime || withWeather.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || withWeather.confirmationProfile || null,

    schema: layerSchema,
    microFamilySchema: layerSchema,
    trueMicroFamilySchema: layerSchema,
    exactTrueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: granularityFor(learningId),
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer: layer,
    layer,

    isParent15Row: isParent,
    isChild75Row: isChild,
    isMicroMicroRow: isMicroMicro,

    selectable: isMicroMicro,
    uiVisible: isMicroMicro,
    adminVisible: isMicroMicro,
    hiddenInAdmin: !isMicroMicro,

    microMicroSelectionAllowed: isMicroMicro,
    micro75SelectionAllowed: false,
    parentSelectionAllowed: false,

    parentContextOnly: isParent,
    child75ContextOnly: isChild,
    parent15RowsHiddenInAdmin: isParent,
    child75RowsHiddenInAdmin: isChild,

    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : 'CONTEXT_ONLY_NOT_SELECTABLE',

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    minCompletedForActiveLearning: minCompleted,
    microMicroActiveThreshold: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    child75PrimaryThresholdBackend: MIN_COMPLETED_ACTIVE_LEARNING,

    status: statusFor({
      ...withWeather,
      minCompletedForActiveLearning: minCompleted
    }),
    learningStatus: statusFor({
      ...withWeather,
      minCompletedForActiveLearning: minCompleted
    }),

    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true
  });

  const gated = applyRuntimeGates(base);

  return flags({
    ...gated,
    signalType: signalTypeForRow(gated),
    riskFractionForEntry: gated.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED
      ? n(gated.riskFractionForEntry, 0)
      : 0
  });
}

function compactMicro(row = {}) {
  const id = rowIdentityId(row);

  if (!id) return null;

  const baseLayered = applyLayerIdentity(
    {
      ...sanitizeStatsRow(row),
      id,
      key: id,
      rowId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      analyzeMicroFamilyId: id
    },
    id
  );

  if (!baseLayered) return null;

  const refreshed = safeRefreshStats(baseLayered);
  const layered = applyLayerIdentity(
    {
      ...refreshed,
      id,
      key: id,
      rowId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      analyzeMicroFamilyId: id
    },
    id
  );

  if (!layered) return null;

  const min = minCompletedFor(id);
  const completed = n(layered.completed, 0);
  const status = completed >= min
    ? 'ACTIVE_LEARNING'
    : completed > 0
      ? 'EARLY_OUTCOMES'
      : 'OBSERVING';

  const gated = applyRuntimeGates({
    ...layered,
    status,
    learningStatus: status
  });

  return flags({
    ...gated,

    definitionParts: Array.isArray(gated.definitionParts)
      ? gated.definitionParts.slice(0, 64)
      : [],
    parentDefinitionParts: Array.isArray(gated.parentDefinitionParts)
      ? gated.parentDefinitionParts.slice(0, 48)
      : [],
    microMicroDefinitionParts: Array.isArray(gated.microMicroDefinitionParts)
      ? gated.microMicroDefinitionParts.slice(0, 64)
      : [],

    examples: Array.isArray(gated.examples)
      ? gated.examples.slice(-12)
      : [],
    recentOutcomes: Array.isArray(gated.recentOutcomes)
      ? gated.recentOutcomes.slice(-100).map(slimOutcome)
      : [],

    minCompletedForActiveLearning: min,
    status,
    learningStatus: status,
    tooEarly: completed < min,
    tooEarlyReason: completed < min ? `completed ${completed}/${min}` : null,

    signalType: signalTypeForRow(gated),
    riskFractionForEntry: gated.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED
      ? n(gated.riskFractionForEntry, 0)
      : 0
  });
}

function extractMicrosPayload(raw = {}) {
  if (!raw) return {};
  if (Array.isArray(raw)) return raw;

  if (raw.rows && typeof raw.rows === 'object') return raw.rows;
  if (raw.micros && typeof raw.micros === 'object') return raw.micros;
  if (raw.microFamilies && typeof raw.microFamilies === 'object' && !Number.isFinite(Number(raw.microFamilies))) {
    return raw.microFamilies;
  }

  return raw;
}

function normalizeMicros(micros = {}) {
  const input = extractMicrosPayload(micros);
  const entries = Array.isArray(input)
    ? input.map((row, index) => [String(row?.id || row?.key || row?.rowId || index), row])
    : Object.entries(input || {});

  const out = {};

  for (const [key, row] of entries) {
    try {
      if (!row || typeof row !== 'object') continue;

      const id = rowIdentityId({
        ...row,
        key: row.key || key
      });

      if (!id) continue;

      const compact = compactMicro({
        ...row,
        id,
        key: id,
        rowId: id,
        learningFamilyId: id,
        learningMicroFamilyId: id,
        analyzeMicroFamilyId: id
      });

      if (compact && isShort(compact)) {
        out[id] = compact;
      }
    } catch {
      // Skip corrupt row instead of killing the endpoint.
    }
  }

  return out;
}

function compareRows(a = {}, b = {}) {
  const ar = safeRefreshStats(a);
  const br = safeRefreshStats(b);

  const layerScore = (x) => {
    const id = rowIdentityId(x);
    const layer = layerFor(id);

    if (layer === LAYER_MICRO_MICRO) return 2;
    if (layer === LAYER_MICRO_75) return 1;

    return 0;
  };

  const eligible = (x) => Number(
    x.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED ||
      x.tradingEligible === true ||
      x.eligible === true ||
      x.eligibleGatePassed === true ||
      x.discordActivationEligible === true
  );

  const blockedRank = (x) => {
    if (x.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED) return 0;
    if (x.microMicroRuntimeStatus === MICRO_MICRO_STATUS_OBSERVING) return 1;
    if (x.microMicroRuntimeStatus === MICRO_MICRO_STATUS_EMPIRICAL_VETO) return 2;
    if (x.microMicroRuntimeStatus === MICRO_MICRO_STATUS_REJECTED) return 3;
    if (x.microMicroRuntimeStatus === MICRO_MICRO_STATUS_POLICY_BLOCKED) return 4;

    return 5;
  };

  return eligible(br) - eligible(ar) ||
    blockedRank(ar) - blockedRank(br) ||
    layerScore(br) - layerScore(ar) ||
    n(br.avgRLCB95 ?? br.lcb95AvgR, 0) - n(ar.avgRLCB95 ?? ar.lcb95AvgR, 0) ||
    n(br.totalR, 0) - n(ar.totalR, 0) ||
    n(br.avgR, 0) - n(ar.avgR, 0) ||
    n(br.completed, 0) - n(ar.completed, 0) ||
    String(ar.learningMicroFamilyId || ar.id || '').localeCompare(String(br.learningMicroFamilyId || br.id || ''));
}

function topObject(micros = {}, limit = 300) {
  return Object.fromEntries(
    Object.values(normalizeMicros(micros))
      .filter((row) => {
        const id = rowIdentityId(row);
        return isChildId(id) || isMicroMicroId(id);
      })
      .sort(compareRows)
      .slice(0, limit)
      .map((row) => [rowIdentityId(row), row])
  );
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const raw = await readJsonAny(getWeekMicrosBaseKey(weekKey), null).catch(() => null);

  if (raw) {
    const normalized = normalizeMicros(extractMicrosPayload(raw));

    if (Object.keys(normalized).length) {
      return normalized;
    }
  }

  const topRaw = await readJsonAny(getWeekMicrosTopKey(weekKey), null).catch(() => null);

  if (topRaw) {
    const topNormalized = normalizeMicros(extractMicrosPayload(topRaw));

    if (Object.keys(topNormalized).length) {
      return topNormalized;
    }
  }

  return {};
}

export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, { limit = 25 } = {}) {
  const raw = await readJsonAny(getWeekMicrosTopKey(weekKey), null).catch(() => null);

  if (raw?.rows && Object.keys(raw.rows).length) {
    return topObject(raw.rows, limit);
  }

  return topObject(await getWeekMicros(weekKey), limit);
}

export async function getWeekMicrosByIds(weekKey, ids = []) {
  const micros = await getWeekMicros(weekKey);

  return Object.fromEntries(
    uniq(ids)
      .map((id) => normalizeLearningFamilyId(id))
      .filter((id) => id && micros[id])
      .map((id) => [id, micros[id]])
  );
}

function localTradingCandidates(micros = {}) {
  return Object.values(normalizeMicros(micros))
    .map((row) => applyRuntimeGates(row))
    .filter((row) => layerFor(rowIdentityId(row)) === LAYER_MICRO_MICRO)
    .filter((row) => row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED)
    .filter((row) => n(row.riskFractionForEntry, 0) > 0)
    .sort(compareRows);
}

export async function saveWeekMicros(weekKey, micros, { onlyIds = null, allowEmptyFullSave = false } = {}) {
  if (!weekKey) throw new Error('WEEK_KEY_MISSING');

  const existing = onlyIds
    ? await getWeekMicros(weekKey).catch(() => ({}))
    : {};

  const clean = normalizeMicros({
    ...(existing || {}),
    ...(micros || {})
  });

  const ids = Object.keys(clean);

  if (!ids.length && !allowEmptyFullSave) {
    return existing || {};
  }

  const layerCounts = Object.values(clean).reduce((acc, row) => {
    const id = rowIdentityId(row);
    const layer = layerFor(id);

    acc.total += 1;
    if (layer === LAYER_PARENT_15) acc.parent15 += 1;
    if (layer === LAYER_MICRO_75) acc.micro75 += 1;
    if (layer === LAYER_MICRO_MICRO) acc.microMicro += 1;

    return acc;
  }, {
    total: 0,
    parent15: 0,
    micro75: 0,
    microMicro: 0
  });

  const runtimeCounts = Object.values(clean).reduce((acc, row) => {
    const status = row.microMicroRuntimeStatus || row.microMicroRuntimeGateStatus || MICRO_MICRO_STATUS_CONTEXT_ONLY;

    acc[status] = n(acc[status], 0) + 1;

    if (row.empiricalVeto === true || row.empiricalVetoDetected === true) {
      acc.empiricalVetoFlaggedRows = n(acc.empiricalVetoFlaggedRows, 0) + 1;
    }

    if (row.policyBlocked === true) {
      acc.policyBlockedFlaggedRows = n(acc.policyBlockedFlaggedRows, 0) + 1;
    }

    return acc;
  }, {});

  const common = flags({
    weekKey,
    updatedAt: now(),
    layerCounts,
    runtimeCounts,
    count: ids.length,
    rowsAreLayered: true,

    sourceMicroMicroRows: layerCounts.microMicro,
    sourceChild75Rows: layerCounts.micro75,
    sourceParent15Rows: layerCounts.parent15,

    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroVersion: MICRO_MICRO_VERSION,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_V1,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,

    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION,
    policyBlockGateVersion: POLICY_BLOCK_GATE_VERSION,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY'
  });

  const payload = {
    ...common,
    rows: clean,
    microFamilies: ids.length,
    storageMode: 'LAYERED_PARENT_CHILD_MICRO_MICRO_ROWS_MICRO_MICRO_PRIMARY_IMMUTABLE_MARKET_WEATHER_NETR_SOURCE_OF_TRUTH',
    uiShowsOnlyMicroMicro: true,
    uiAllowsOnlyMicroMicroSelection: true
  };

  const topRows = topObject(clean, 300);
  const candidates = localTradingCandidates(clean);

  await setJsonEverywhere(getWeekMicrosBaseKey(weekKey), payload);

  await setJsonEverywhere(getWeekMicrosTopKey(weekKey), {
    ...common,
    rows: topRows,
    count: Object.keys(topRows).length,
    storageMode: 'TOP_MICROS_AND_MICRO_MICROS_SNAPSHOT_MICRO_MICRO_PRIMARY_IMMUTABLE_MARKET_WEATHER_NETR_SOURCE_OF_TRUTH'
  });

  await setJsonEverywhere(getWeekTradingCandidatesKey(weekKey), {
    ...common,
    rows: Object.fromEntries(
      candidates.map((row) => [rowIdentityId(row), row])
    ),
    count: candidates.length,
    storageMode: 'ELIGIBLE_LIFETIME_LCB_MICRO_MICRO_CANDIDATES_PREVIEW_PASSED_RISK_POSITIVE_ONLY_NETR_SOURCE_OF_TRUTH'
  });

  await setJsonEverywhere(getWeekMetaKey(weekKey), {
    ...common,
    microFamilies: ids.length,
    tradingCandidatesPreview: candidates.length
  });

  return clean;
}

function getOrCreateMicro(micros, classified, learningId) {
  const withWeather = attachEntryMarketWeather(
    classified,
    classified.entryMarketWeatherCapturedAt || classified.createdAt || classified.openedAt || now()
  );

  const id = normalizeLearningFamilyId(learningId, withWeather);

  if (!id) throw new Error('LEARNING_FAMILY_ID_REQUIRED');

  const parsed = parseShortTaxonomyMicroId(id);
  const child = parsed.childTrueMicroFamilyId || childIdFrom(id, withWeather);
  const parent = parsed.parentTrueMicroFamilyId || parentIdFrom(id, withWeather);
  const mm = parsed.isMicroMicro ? parsed.microMicroFamilyId : null;
  const primaryId = parsed.isMicroMicro ? mm : id;

  if (!micros[id]) {
    micros[id] = createMicroStatsSafe({
      ...resolveEntryMarketWeather(withWeather, withWeather.createdAt || withWeather.openedAt || now()),

      id,
      key: id,
      rowId: id,

      microFamilyId: primaryId,
      trueMicroFamilyId: primaryId,

      learningMicroFamilyId: id,
      learningFamilyId: id,
      analyzeMicroFamilyId: id,
      primaryLearningFamilyId: primaryId,
      primaryLearningIdentity: parsed.isMicroMicro
        ? 'MICRO_MICRO'
        : parsed.isChild
          ? 'CHILD75_CONTEXT'
          : 'PARENT15_CONTEXT',
      primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

      familyId: primaryId,
      childTrueMicroFamilyId: child || null,
      base75ChildTrueMicroFamilyId: child || null,
      child75ContextFamilyId: child || null,
      parentTrueMicroFamilyId: parent || null,
      parent15ContextFamilyId: parent || null,

      microMicroFamilyId: mm,
      trueMicroMicroFamilyId: mm,
      exactMicroMicroFamilyId: mm,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      definitionParts: withWeather.definitionParts || [],

      marketWeatherStats: normalizeWeatherStats(),
      netRStats: emptyNetRStats(),
      shortNetRStats: emptyNetRStats(),
      outcomeNetRStats: emptyNetRStats()
    });
  }

  const layered = applyLayerIdentity({
    ...withWeather,
    ...sanitizeStatsRow(micros[id]),
    id,
    key: id,
    rowId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,
    analyzeMicroFamilyId: id
  }, id);

  Object.assign(micros[id], layered);

  return micros[id];
}

function obsKey(snapshotId, symbol, learningId, entry = 0, entryMarketWeatherKey = UNKNOWN_MARKET_WEATHER_KEY) {
  const base = typeof KEYS.analyze?.obsLast === 'function'
    ? KEYS.analyze.obsLast(snapshotId, symbol, learningId)
    : null;

  return `${shortKey(base, `ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${learningId}`)}:ENTRY:${n(entry, 0).toFixed(8)}:WEATHER:${entryMarketWeatherKey}`;
}

function outcomeKey(weekKey, identity, learningId) {
  const base = typeof KEYS.analyze?.outcomeLast === 'function'
    ? KEYS.analyze.outcomeLast(weekKey, identity, learningId)
    : null;

  return shortKey(base, `ANALYZE:OUTCOME_LAST:${weekKey}:${identity}:${learningId}`);
}

async function claim(redis, key, ttlSec, type) {
  const result = await redisSetNx(redis, key, String(now()), ttlSec);

  return {
    ...result,
    key,
    type
  };
}

function obsTtl() {
  return Math.max(60, Math.floor(n(CONFIG?.analyze?.obsDedupeTtlSec, 86400)));
}

function outcomeTtl() {
  return Math.max(60, Math.floor(n(CONFIG?.analyze?.outcomeDedupeTtlSec, 86400 * 14)));
}

function updateObservationLocal(micro = {}, event = {}) {
  micro.seen = n(micro.seen, 0) + 1;
  micro.observed = n(micro.observed, 0) + 1;
  micro.observations = n(micro.observations, 0) + 1;
  micro.lastSeenAt = event.createdAt || now();
  micro.updatedAt = now();

  micro.examples = [
    ...(Array.isArray(micro.examples) ? micro.examples : []),
    {
      symbol: event.symbol || null,
      contractSymbol: event.contractSymbol || null,
      createdAt: event.createdAt || now(),
      source: event.source || 'VIRTUAL'
    }
  ].slice(-12);

  return micro;
}

export async function analyzeCandidatesBatch(metricsRows = [], { weekKey = PERSISTENT_LEARNING_KEY } = {}) {
  const input = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean).filter(isShort)
    : [];

  if (!input.length) return [];

  const rows = input
    .map((row) => enrichWithMicroFamily(attachEntryMarketWeather(row, row.createdAt || row.openedAt || now())))
    .filter(Boolean);

  if (!rows.length) return [];

  const redis = getDurableRedisSafe();
  const micros = await getWeekMicros(weekKey);

  const touched = new Set();
  const analyzed = [];

  for (const row of rows) {
    const child = childIdFrom(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);
    const parent = parentIdFrom(child, row);
    const mm = buildMicroMicroFromChildAndRow(child, row);
    const ids = uniq([parent, child, mm]).filter(isLearningId);

    const weather = resolveEntryMarketWeather(row, row.createdAt || row.openedAt || now());

    const snapshotId = String(
      row.snapshotId ||
        row.scanSnapshotId ||
        row.scannerSnapshotId ||
        row.runId ||
        'NO_SNAPSHOT'
    );

    const symbol = upper(row.symbol || row.contractSymbol || row.baseSymbol || 'UNKNOWN');
    const entry = n(row.entry || row.entryPrice || row.price, 0);
    const results = [];

    for (const id of ids) {
      const key = obsKey(snapshotId, symbol, id, entry, weather.entryMarketWeatherKey);
      const c = await claim(redis, key, obsTtl(), `OBSERVATION:${layerFor(id)}`);
      const recorded = c.claimed && !c.duplicate;

      results.push({
        id,
        key,
        claim: c,
        recorded
      });

      if (!recorded) continue;

      const layerRow = applyLayerIdentity({
        ...row,
        ...weather,
        childTrueMicroFamilyId: child,
        base75ChildTrueMicroFamilyId: child,
        child75ContextFamilyId: child,
        parentTrueMicroFamilyId: parent,
        parent15ContextFamilyId: parent,
        microMicroFamilyId: mm,
        trueMicroMicroFamilyId: mm,
        exactMicroMicroFamilyId: mm,
        relatedMicroMicroFamilyId: mm,
        source: 'VIRTUAL',
        weekKey
      }, id);

      const micro = getOrCreateMicro(micros, layerRow, id);

      const observationEvent = flags({
        ...layerRow,
        ...weather,
        source: 'VIRTUAL',
        weekKey,
        observationDedupeKey: key,
        observationDedupeMethod: c.method,
        observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
        observationRecorded: true,
        observationCounted: true,
        countObservation: true,
        createdAt: row.createdAt || now()
      });

      updateObservationLocal(micro, observationEvent);

      if (typeof Scoring.updateObservation === 'function') {
        try {
          Scoring.updateObservation(micro, observationEvent);
        } catch {
          // Local observation stats remain source of truth for this file.
        }
      }

      Object.assign(
        micro,
        applyRuntimeGates(
          applyLayerIdentity(
            updateMarketWeatherAggregation(
              safeRefreshStats(micro),
              {
                ...layerRow,
                ...weather
              },
              'OBSERVATION'
            ),
            id
          )
        )
      );

      touched.add(id);
    }

    const chosen = results.find((x) => x.id === mm) ||
      results.find((x) => x.id === child) ||
      results[0];

    const analyzedRow = applyRuntimeGates(flags({
      ...row,
      ...weather,

      learningFamilyId: mm,
      learningMicroFamilyId: mm,
      analyzeMicroFamilyId: mm,
      primaryLearningFamilyId: mm,
      primaryLearningIdentity: 'MICRO_MICRO',
      primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

      trueMicroFamilyId: mm,
      microFamilyId: mm,
      childTrueMicroFamilyId: child,
      base75ChildTrueMicroFamilyId: child,
      child75ContextFamilyId: child,
      parentTrueMicroFamilyId: parent,
      parent15ContextFamilyId: parent,

      microMicroFamilyId: mm,
      trueMicroMicroFamilyId: mm,
      exactMicroMicroFamilyId: mm,
      microMicroHash: parseShortTaxonomyMicroId(mm).microMicroHash || row.microMicroHash || row.executionFingerprintHash || null,

      learningIds: ids,
      parentLearningId: parent,
      childLearningId: child,
      microMicroLearningId: mm,

      exactMicroMicro: Boolean(mm),
      microMicroSelectionAllowed: Boolean(mm),
      selectableLearningId: mm,
      selectableMicroMicroFamilyId: mm,

      weakContraEntryGate: row.weakContraEntryGate || evaluateWeakContraEntryGate(row, {
        confirmation: row.confirmationProfile
      }),
      weakContraRejected: Boolean(row.weakContraRejected),
      weakContraAllowed: Boolean(row.weakContraAllowed),
      weakContraRejectReason: row.weakContraRejectReason || null,
      blockVirtualEntry: Boolean(row.blockVirtualEntry),
      blockVirtualEntryReason: row.blockVirtualEntryReason || null,
      weakContraRejectedBlocksLearning: false,

      observationRecorded: results.some((x) => x.recorded),
      observationDuplicate: !results.some((x) => x.recorded) && results.some((x) => x.claim?.duplicate),
      observationDedupeKey: chosen?.key || null,
      observationDedupeMethod: chosen?.claim?.method || null,
      observationDedupeVersion: OBSERVATION_DEDUPE_VERSION
    }));

    analyzed.push(analyzedRow);
  }

  if (touched.size) {
    await saveWeekMicros(weekKey, micros, {
      onlyIds: [...touched]
    });
  }

  return analyzed;
}

function calcRiskPct({ entry, sl }) {
  return entry > 0 && sl > 0 ? Math.abs(entry - sl) / entry : 0;
}

function calcShortGrossR({ entry, initialSl, exit }) {
  const distance = initialSl - entry;
  return entry > 0 && exit > 0 && distance > 0 ? (entry - exit) / distance : 0;
}

function grossMovePct(entry, exit) {
  return entry > 0 && exit > 0 ? (entry - exit) / entry : 0;
}

function isDirectSL(position = {}, reason = '') {
  const raw = upper(reason);

  return Boolean(
    position.directToSL ||
      position.directSL ||
      (raw.includes('SL') && !position.nearTpSeen && !position.reachedHalfR && !position.reachedOneR)
  );
}

function stableOutcomeIdentity(outcome = {}, child = '') {
  const withWeather = attachEntryMarketWeather(
    outcome,
    outcome.entryMarketWeatherCapturedAt || outcome.openedAt || outcome.createdAt || outcome.completedAt || now()
  );

  const mm = microMicroIdFrom(
    withWeather.microMicroFamilyId ||
      withWeather.trueMicroMicroFamilyId ||
      withWeather.exactMicroMicroFamilyId,
    withWeather
  );

  const raw = [
    TARGET_TRADE_SIDE,
    withWeather.tradeId || withWeather.positionId || '',
    withWeather.symbol || withWeather.contractSymbol || 'UNKNOWN',
    withWeather.openedAt || withWeather.createdAt || 'NO_OPEN',
    withWeather.closedAt || withWeather.completedAt || withWeather.ts || 'NO_CLOSE',
    withWeather.exitReason || withWeather.reason || 'NO_REASON',
    n(withWeather.exit ?? withWeather.exitPrice, 0).toFixed(8),
    child,
    mm,
    withWeather.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY
  ].join('|');

  return hashText(raw, 24);
}

function hasMicroIds(row = {}) {
  return Boolean(childIdFrom(
    row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.microMicroFamilyId,
    row
  ));
}

function ensureOutcomeIds(outcome = {}) {
  const withWeather = attachEntryMarketWeather(
    outcome,
    outcome.entryMarketWeatherCapturedAt || outcome.openedAt || outcome.createdAt || outcome.completedAt || now()
  );

  const enriched = hasMicroIds(withWeather)
    ? flags(withWeather)
    : enrichWithMicroFamily(withWeather);

  if (!enriched) return null;

  const child = childIdFrom(
    enriched.childTrueMicroFamilyId ||
      enriched.base75ChildTrueMicroFamilyId ||
      enriched.trueMicroFamilyId ||
      enriched.microFamilyId ||
      enriched.learningFamilyId ||
      enriched.learningMicroFamilyId ||
      enriched.analyzeMicroFamilyId ||
      enriched.microMicroFamilyId,
    enriched
  );

  const parent = parentIdFrom(child, enriched);
  const mm = buildMicroMicroFromChildAndRow(child, enriched);

  if (!child || !parent || !mm) return null;

  return flags({
    ...enriched,

    learningFamilyId: mm,
    learningMicroFamilyId: mm,
    analyzeMicroFamilyId: mm,
    primaryLearningFamilyId: mm,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    trueMicroFamilyId: mm,
    microFamilyId: mm,

    childTrueMicroFamilyId: child,
    base75ChildTrueMicroFamilyId: child,
    child75ContextFamilyId: child,

    parentTrueMicroFamilyId: parent,
    parent15ContextFamilyId: parent,
    coarseMicroFamilyId: parent,
    baseMicroFamilyId: parent,
    legacyMicroFamilyId: parent,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,
    microMicroHash: parseShortTaxonomyMicroId(mm).microMicroHash || enriched.microMicroHash || enriched.executionFingerprintHash || null
  });
}

export function buildOutcomeFromPosition({ position, exitPrice, exitReason, source = 'VIRTUAL' }) {
  if (!position) throw new Error('POSITION_REQUIRED_FOR_OUTCOME');

  const positionWithWeather = attachEntryMarketWeather(
    position,
    position.entryMarketWeatherCapturedAt || position.openedAt || position.createdAt || now()
  );

  const entry = n(positionWithWeather.entry, 0);
  const initialSl = n(positionWithWeather.initialSl || positionWithWeather.sl, 0);
  const exit = n(exitPrice, 0);
  const tp = n(positionWithWeather.tp, 0);

  const riskPct = n(positionWithWeather.riskPct, 0) || calcRiskPct({
    entry,
    sl: initialSl
  });

  const grossMove = grossMovePct(entry, exit);
  const grossR = calcShortGrossR({
    entry,
    initialSl,
    exit
  });

  let cost = {};

  try {
    cost = typeof CostModel.applyCosts === 'function'
      ? CostModel.applyCosts({
          side: TARGET_TRADE_SIDE,
          tradeSide: TARGET_TRADE_SIDE,
          grossMovePct: grossMove,
          riskPct,
          entrySpreadPct: n(positionWithWeather.spreadPct, 0),
          exitSpreadPct: n(positionWithWeather.exitSpreadPct ?? positionWithWeather.spreadPct, 0)
        }) || {}
      : {};
  } catch {
    cost = {};
  }

  const costR = Math.max(0, n(cost.costR, 0));
  const netR = grossR - costR;

  const closedAt = n(positionWithWeather.closedAt || positionWithWeather.completedAt, now());
  const ids = ensureOutcomeIds(positionWithWeather) || {};
  const child = ids.childTrueMicroFamilyId || childIdFrom(ids.microMicroFamilyId || ids.trueMicroFamilyId, ids);
  const mm = ids.microMicroFamilyId || ids.trueMicroMicroFamilyId || ids.exactMicroMicroFamilyId || '';
  const weather = resolveEntryMarketWeather(
    positionWithWeather,
    positionWithWeather.openedAt || positionWithWeather.createdAt || closedAt
  );

  const identity = [
    TARGET_TRADE_SIDE,
    positionWithWeather.tradeId || '',
    positionWithWeather.symbol || positionWithWeather.contractSymbol || '',
    positionWithWeather.openedAt || positionWithWeather.createdAt || '',
    closedAt,
    exitReason || '',
    exit,
    child || '',
    mm || '',
    weather.entryMarketWeatherKey
  ].join('|');

  return flags({
    ...positionWithWeather,
    ...ids,
    ...weather,

    type: 'OUTCOME',
    source,
    outcomeSource: source,
    positionSource: positionWithWeather.source || 'VIRTUAL',

    tradeId: positionWithWeather.tradeId,
    positionId: positionWithWeather.positionId || positionWithWeather.id || null,

    outcomeIdentity: positionWithWeather.outcomeIdentity || identity,
    stableOutcomeIdentity: identity,

    symbol: positionWithWeather.symbol,
    contractSymbol: positionWithWeather.contractSymbol,

    entry,
    exit,
    exitPrice: exit,
    sl: n(positionWithWeather.sl, 0),
    initialSl,
    tp,
    rr: n(positionWithWeather.rr, 0),

    riskPct,
    rewardPct: entry > 0 && tp > 0 ? Math.max(0, (entry - tp) / entry) : 0,
    validShortRiskShape: entry > 0 && tp < entry && entry < initialSl,

    exitReason,

    grossMovePct: grossMove,
    grossR,
    shortGrossR: grossR,
    rawR: grossR,
    realizedGrossR: grossR,

    netR,
    shortNetR: netR,
    exitR: netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,

    costR,
    avgCostR: costR,
    executionCostR: Math.max(0, costR - n(positionWithWeather.fundingCostR, 0)),
    fundingCostR: n(positionWithWeather.fundingCostR, 0),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,

    directToSL: isDirectSL(positionWithWeather, exitReason),
    directSL: isDirectSL(positionWithWeather, exitReason),

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    netRSource: 'ANALYZE_ENGINE_GROSS_R_MINUS_COST_R_SOURCE_OF_TRUTH',

    openedAt: positionWithWeather.openedAt || positionWithWeather.createdAt || null,
    closedAt,
    completedAt: closedAt,

    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION
  });
}

export async function recordOutcome(outcome = {}, { source = outcome.source || 'VIRTUAL', weekKey = PERSISTENT_LEARNING_KEY } = {}) {
  const outcomeWithWeather = attachEntryMarketWeather(
    outcome,
    outcome.entryMarketWeatherCapturedAt || outcome.openedAt || outcome.createdAt || outcome.completedAt || now()
  );

  if (!isShort(outcomeWithWeather)) {
    return flags({
      ...outcomeWithWeather,
      skipped: true,
      reason: 'NON_SHORT_OUTCOME_SKIPPED_SHORT_ONLY',
      source,
      weekKey,
      recordedAt: now()
    });
  }

  const row = ensureOutcomeIds(outcomeWithWeather);

  if (!row) {
    return flags({
      ...outcomeWithWeather,
      skipped: true,
      reason: 'SHORT_ONLY_CLASSIFICATION_SKIPPED_OR_EXACT_MICRO_MICRO_MISSING',
      source,
      weekKey,
      recordedAt: now()
    });
  }

  const weather = resolveEntryMarketWeather(
    row,
    row.entryMarketWeatherCapturedAt || row.openedAt || row.createdAt || row.completedAt || now()
  );

  const child = childIdFrom(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);
  const parent = parentIdFrom(child, row);
  const mm = buildMicroMicroFromChildAndRow(child, row);
  const ids = uniq([parent, child, mm]).filter(isLearningId);

  if (!ids.length || !mm || !isMicroMicroId(mm)) {
    return flags({
      ...row,
      ...weather,
      skipped: true,
      reason: 'NO_EXACT_MICRO_MICRO_LEARNING_ID_FOR_OUTCOME',
      source,
      weekKey,
      recordedAt: now()
    });
  }

  const redis = getDurableRedisSafe();
  const micros = await getWeekMicros(weekKey);
  const touched = new Set();
  const outcomeIdentity = stableOutcomeIdentity({
    ...row,
    ...weather
  }, child);
  const results = [];

  const netR = outcomeNetR(row);
  const grossR = calcShortGrossRFromEvent(row);
  const costR = outcomeCostR(row);

  const normalizedOutcome = flags({
    ...slimOutcome({
      ...row,
      ...weather,
      source,
      outcomeSource: source,
      weekKey,

      grossR,
      shortGrossR: grossR,
      rawR: grossR,

      netR,
      shortNetR: netR,
      exitR: netR,
      realizedNetR: netR,
      realizedR: netR,
      r: netR,

      costR,
      avgCostR: costR,

      win: netR > 0,
      loss: netR < 0,
      flat: netR === 0,

      directSL: Boolean(row.directSL || row.directToSL),
      directToSL: Boolean(row.directSL || row.directToSL)
    }),

    ...weather,

    outcomeIdentity,
    stableOutcomeIdentity: row.stableOutcomeIdentity || outcomeIdentity,

    learningFamilyId: mm,
    learningMicroFamilyId: mm,
    analyzeMicroFamilyId: mm,
    primaryLearningFamilyId: mm,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    trueMicroFamilyId: mm,
    microFamilyId: mm,

    childTrueMicroFamilyId: child,
    base75ChildTrueMicroFamilyId: child,
    child75ContextFamilyId: child,

    parentTrueMicroFamilyId: parent,
    parent15ContextFamilyId: parent,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,

    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION
  });

  for (const id of ids) {
    const key = outcomeKey(weekKey, outcomeIdentity, id);
    const c = await claim(redis, key, outcomeTtl(), `OUTCOME:${layerFor(id)}`);
    const recorded = c.claimed && !c.duplicate;

    results.push({
      id,
      key,
      claim: c,
      recorded
    });

    if (!recorded) continue;

    const layerRow = applyLayerIdentity({
      ...normalizedOutcome,
      ...weather,
      childTrueMicroFamilyId: child,
      base75ChildTrueMicroFamilyId: child,
      child75ContextFamilyId: child,
      parentTrueMicroFamilyId: parent,
      parent15ContextFamilyId: parent,
      microMicroFamilyId: mm,
      trueMicroMicroFamilyId: mm,
      exactMicroMicroFamilyId: mm,
      relatedMicroMicroFamilyId: mm
    }, id);

    const micro = getOrCreateMicro(micros, layerRow, id);

    const countedOutcome = flags({
      ...layerRow,
      ...normalizedOutcome,
      ...weather,
      outcomeDedupeKey: key,
      outcomeDedupeMethod: c.method,
      outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
      outcomeCounted: true,
      countOutcome: true,
      recordedAt: now()
    });

    if (typeof Scoring.updateOutcome === 'function') {
      try {
        Scoring.updateOutcome(micro, countedOutcome, source);
      } catch {
        // NetR stats below remain the source of truth.
      }
    }

    Object.assign(
      micro,
      applyOutcomeStatsInvariant(micro, countedOutcome)
    );

    Object.assign(
      micro,
      applyRuntimeGates(
        applyLayerIdentity(
          updateMarketWeatherAggregation(
            safeRefreshStats(micro),
            countedOutcome,
            'OUTCOME'
          ),
          id
        )
      )
    );

    Object.assign(
      micro,
      repairStatsInvariants(micro)
    );

    touched.add(id);
  }

  const any = results.some((x) => x.recorded);

  if (touched.size) {
    await saveWeekMicros(weekKey, micros, {
      onlyIds: [...touched]
    });
  }

  const chosen = results.find((x) => x.id === mm) ||
    results.find((x) => x.id === child) ||
    results[0];

  return applyRuntimeGates(flags({
    ...normalizedOutcome,
    ...weather,

    learningFamilyId: mm,
    learningMicroFamilyId: mm,
    analyzeMicroFamilyId: mm,
    primaryLearningFamilyId: mm,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    trueMicroFamilyId: mm,
    microFamilyId: mm,

    childTrueMicroFamilyId: child,
    base75ChildTrueMicroFamilyId: child,
    child75ContextFamilyId: child,

    parentTrueMicroFamilyId: parent,
    parent15ContextFamilyId: parent,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,
    microMicroHash: parseShortTaxonomyMicroId(mm).microMicroHash || row.microMicroHash || row.executionFingerprintHash || null,

    learningIds: ids,
    parentLearningId: parent,
    childLearningId: child,
    microMicroLearningId: mm,

    skipped: !any,
    reason: any ? null : 'DUPLICATE_OUTCOME_SKIPPED_NO_STATS_UPDATE',

    outcomeDuplicate: !any,
    outcomeCounted: any,
    countOutcome: any,

    outcomeDedupeKey: chosen?.key || null,
    outcomeDedupeMethod: chosen?.claim?.method || null,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,

    recordedAt: now()
  }));
}

export async function createShadowPosition() {
  return {
    ok: false,
    created: false,
    skipped: true,
    reason: 'SHADOW_POSITION_CREATION_MOVED_TO_POSITION_ENGINE_VIRTUAL_TRACKING'
  };
}

function currentFitLookupFromStoredRow(row = {}) {
  const direct = upper(row.currentFit || row.entryCurrentFit || row.marketFit || '');

  if (direct.includes('MISFIT') || direct.includes('AGAINST')) return 'MISFIT';
  if (direct.includes('MATCH') || direct === 'FIT' || direct === 'ALIGNED') return 'MATCH';

  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const fit = currentFitLookupFromStoredRow(recent[i]);
    if (fit !== 'UNKNOWN') return fit;
  }

  return 'UNKNOWN';
}

function normalizeTradingCandidate(row = {}, index = 0, weekKey = PERSISTENT_LEARNING_KEY) {
  const gated = applyRuntimeGates(row);
  const id = rowIdentityId(gated);
  const parsed = parseShortTaxonomyMicroId(id);
  const passed = gated.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED;
  const risk = passed ? n(gated.riskFractionForEntry, 0) : 0;
  const tradeReady = passed && risk > 0;

  return flags({
    ...gated,

    id,
    key: id,
    rowId: id,
    rank: index + 1,
    weekKey,

    tradingCandidate: true,
    tradingEligible: tradeReady,
    eligibleGatePassed: tradeReady,
    discordActivationEligible: tradeReady,

    selectionSource: 'LIFETIME_LCB_CURRENTFIT_WITH_EMPIRICAL_VETO_NETR_SOURCE_OF_TRUTH',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    learningFamilyId: id,
    learningMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    primaryLearningFamilyId: id,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    microFamilyId: id,
    trueMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    child75ContextFamilyId: parsed.childTrueMicroFamilyId,

    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    parent15ContextFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,

    discordMatchId: tradeReady ? id : null,
    selectedLearningFamilyId: tradeReady ? id : null,
    selectedMicroFamilyId: tradeReady ? id : null,
    selectedTrueMicroFamilyId: tradeReady ? id : null,
    selectedChildTrueMicroFamilyId: tradeReady ? parsed.childTrueMicroFamilyId : null,
    selectedMicroMicroFamilyId: tradeReady ? id : null,
    selectedTrueMicroMicroFamilyId: tradeReady ? id : null,
    selectedExactMicroMicroFamilyId: tradeReady ? id : null,

    selectable: true,
    uiVisible: true,
    adminVisible: true,
    learningLayer: LAYER_MICRO_MICRO,
    layer: LAYER_MICRO_MICRO,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    signalType: tradeReady ? SIGNAL_TYPE_TRADE_READY : signalTypeForRow(gated),
    riskFractionForEntry: risk
  });
}

export async function getWeeklyTradingCandidates(
  weekKey = PERSISTENT_LEARNING_KEY,
  {
    limit = 10,
    requireCurrentFitMatch = true,
    currentFitLookup = null,
    includeMeta = false
  } = {}
) {
  const micros = await getWeekMicros(weekKey);
  const lookup = currentFitLookup || currentFitLookupFromStoredRow;

  const all = Object.values(normalizeMicros(micros))
    .map((row) => applyRuntimeGates(row))
    .filter((row) => layerFor(rowIdentityId(row)) === LAYER_MICRO_MICRO)
    .filter((row) => {
      if (!requireCurrentFitMatch) return true;

      const fit = lookup(row);
      return fit !== 'MISFIT';
    })
    .sort(compareRows);

  const passed = all.filter((row) => (
    row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED &&
    n(row.riskFractionForEntry, 0) > 0
  ));

  const candidates = passed
    .slice(0, Math.max(1, Math.floor(n(limit, 10))))
    .map((row, index) => normalizeTradingCandidate(row, index, weekKey));

  if (!includeMeta) return candidates;

  const bestFallback = all.find((row) => row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_OBSERVING) ||
    all.find((row) => row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_PASSED) ||
    all.find((row) => row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_REJECTED) ||
    all.find((row) => row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_EMPIRICAL_VETO) ||
    all.find((row) => row.microMicroRuntimeStatus === MICRO_MICRO_STATUS_POLICY_BLOCKED) ||
    null;

  return {
    weekKey,
    generatedAt: now(),
    count: candidates.length,
    candidates,
    bestFallback: bestFallback ? normalizeTradingCandidate(bestFallback, 0, weekKey) : null,
    requireCurrentFitMatch,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,
    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_V1,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    netRStatsVersion: NET_R_STATS_VERSION,
    statsInvariantVersion: STATS_INVARIANT_VERSION,
    policyBlockGateVersion: POLICY_BLOCK_GATE_VERSION,
    rules: {
      selectionUsesWeeklyWinnerOnly: false,
      selectionUsesLifetimeStats: true,
      selectionUsesLCBAvgR: true,
      selectionRequiresEligibleGate: true,
      selectionRequiresRiskFractionPositive: true,
      selectionRequiresCurrentFitMatch: requireCurrentFitMatch,
      empiricalVetoBlocksSelection: true,
      policyBlockedBlocksSelection: true,
      unknownMarketWeatherBlocksTradeReady: true,
      aggregateRowsDoNotRecomputeEntryWeatherFromCurrent: true,
      aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
      invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
      selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
      parent15MatchTriggersDiscord: false,
      child75MatchTriggersDiscord: false,
      micro75MatchDoesNotTriggerDiscord: true,
      selectorMode: 'OBSERVE',
      discordTradeReadyMode: 'VALIDATION_REQUIRED'
    },
    emptyReason: candidates.length
      ? null
      : bestFallback
        ? `NO_TRADE_READY_BEST_AVAILABLE_IS_${bestFallback.microMicroRuntimeStatus || 'UNKNOWN'}`
        : requireCurrentFitMatch
          ? 'NO_ELIGIBLE_MICRO_MICRO_WITH_CURRENT_FIT_MATCH'
          : 'NO_ELIGIBLE_MICRO_MICRO'
  };
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}

export default {
  analyzeCandidatesBatch,
  buildOutcomeFromPosition,
  recordOutcome,
  createShadowPosition,
  getWeekMicros,
  getWeekTopMicros,
  getWeekMicrosByIds,
  saveWeekMicros,
  getWeeklyTradingCandidates,
  getAnalyzeMicroRowsByIds
};