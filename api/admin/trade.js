// ================= FILE: api/admin/trade.js =================

import * as ConfigModule from '../../src/config.js';
import * as KeysModule from '../../src/keys.js';
import * as RedisApi from '../../src/redis.js';
import * as PositionEngine from '../../src/trade/positionEngine.js';
import * as Utils from '../../src/utils.js';

const CONFIG = ConfigModule.CONFIG || {};
const KEYS = KeysModule.KEYS || {};

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING = 35;

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_ADMIN_TRADE_VERSION =
  'SHORT_ADMIN_TRADE_MARKETWEATHER_MICRO_MICRO_V2_500_SAFE';
const MARKET_WEATHER_SELECTOR_VERSION =
  'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V2_ADMIN_TRADE_500_SAFE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V2_ADMIN_TRADE_500_SAFE';
const EMPIRICAL_VETO_VERSION = 'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V1';

const PLAYBOOK_MAX_AGE_MIN = 240;

const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const TRUE_MICRO_SCHEMA = CHILD_TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MICRO_MICRO_MARKER = '_MM_';
const MICRO_MICRO_HASH_LEN = 10;

const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const POSITION_COST_MODEL_VERSION =
  'POSITION_ENGINE_SHORT_NET_COST_V14_WEATHER_AWARE_ADMIN_TRADE_500_SAFE';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V6_WEATHER_AWARE';
const DISCORD_ACTIVATION_GATE_VERSION =
  'SHORT_MM_DISCORD_ACTIVATION_GATE_EMPIRICAL_VETO_RISK_ZERO_V6_ADMIN_TRADE';
const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_GATE_OBSERVING_PASSED_REJECTED_EMPIRICAL_VETO_POLICY_BLOCKED_V6_ADMIN_TRADE_500_SAFE';

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';

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

const MARKET_WEATHER_KEYS = Object.freeze([
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:CONFIRMED`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER:CONFIRMED`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER`
]);

function now() {
  return Date.now();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function safeNumberCompat(value, fallback = 0) {
  if (typeof Utils.safeNumber === 'function') {
    try {
      const n = Utils.safeNumber(value, fallback);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function num(value, fallback = 0) {
  return safeNumberCompat(value, fallback);
}

function round(value, decimals = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : 0;
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function callMaybeKey(value, fallback = null) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function namespacedShortKey(key, fallback = null) {
  let raw = String(callMaybeKey(key, fallback) || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) raw = raw.slice('LONG:'.length);

  return `${SHORT_KEY_PREFIX}${raw}`;
}

const SHORT_KEYS = {
  scan: {
    latest: namespacedShortKey(
      KEYS.short?.scan?.latest ||
        KEYS.scan?.shortLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    )
  },

  trade: {
    runMeta: namespacedShortKey(
      KEYS.short?.trade?.runMeta ||
        KEYS.trade?.shortRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN:META'
    ),

    lastProcessedSnapshot: namespacedShortKey(
      KEYS.short?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.shortLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  },

  rotation: {
    active: namespacedShortKey(
      KEYS.short?.rotation?.active ||
        KEYS.rotation?.shortActive ||
        KEYS.rotation?.active,
      'ROTATION:ACTIVE'
    ),
    dashboard: namespacedShortKey(
      KEYS.short?.rotation?.dashboard ||
        KEYS.rotation?.shortDashboard ||
        KEYS.rotation?.dashboard,
      'ROTATION:DASHBOARD'
    )
  }
};

const LEGACY_SHORT_KEYS = Object.freeze({
  tradeRunMeta: `${SHORT_KEY_PREFIX}TRADE:RUN_META`
});

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length > 0) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    output.push(value);
  }

  return output;
}

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value
            .split(/[\s,;\n\r]+/g)
            .map((part) => part.trim());
        }

        return [value];
      })
      .map((part) => String(part || '').trim())
      .filter(Boolean)
  )];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ageMin(ts, nowMs = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, (nowMs - n) / 60000);
}

function calcAgeSec(ts) {
  const value = num(ts, 0);
  if (value <= 0) return null;
  return Math.max(0, Math.floor((now() - value) / 1000));
}

function stableHash10(input = '') {
  const text = String(input || '').trim();
  if (!text) return '';

  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const tail = text.length.toString(16).toUpperCase().padStart(2, '0');

  return `${hex}${tail}`.slice(0, MICRO_MICRO_HASH_LEN);
}

function normalizeHash(value = '') {
  const raw = upper(value).replace(/[^A-Z0-9]/g, '');
  return raw.length >= 3 ? raw.slice(0, MICRO_MICRO_HASH_LEN) : '';
}

function getDurableRedisSafe() {
  try {
    if (typeof RedisApi.getDurableRedis === 'function') {
      return RedisApi.getDurableRedis();
    }
  } catch {
    return null;
  }

  return null;
}

function getVolatileRedisSafe() {
  try {
    if (typeof RedisApi.getVolatileRedis === 'function') {
      return RedisApi.getVolatileRedis();
    }
  } catch {
    return null;
  }

  return null;
}

async function getJsonSafe(redis, key, fallback = null) {
  if (!redis || !key) return fallback;

  if (typeof RedisApi.getJson === 'function') {
    try {
      const value = await RedisApi.getJson(redis, key, fallback);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  try {
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

async function readJsonFromStores({ durable, volatile, key, fallback = null }) {
  const fromVolatile = await getJsonSafe(volatile, key, null);

  if (fromVolatile !== null && fromVolatile !== undefined) {
    return {
      value: fromVolatile,
      source: `VOLATILE:${key}`
    };
  }

  const fromDurable = await getJsonSafe(durable, key, null);

  if (fromDurable !== null && fromDurable !== undefined) {
    return {
      value: fromDurable,
      source: `DURABLE:${key}`
    };
  }

  return {
    value: fallback,
    source: null
  };
}

async function readTradeRunMetaFromStores({
  durable,
  volatile
} = {}) {
  const primaryRead = await readJsonFromStores({
    durable,
    volatile,
    key: SHORT_KEYS.trade.runMeta,
    fallback: null
  });
  if (
    primaryRead.value !== null &&
    primaryRead.value !== undefined
  ) {
    return {
      ...primaryRead,
      key: SHORT_KEYS.trade.runMeta,
      legacyFallbackUsed: false
    };
  }
  if (
    LEGACY_SHORT_KEYS.tradeRunMeta &&
    LEGACY_SHORT_KEYS.tradeRunMeta !== SHORT_KEYS.trade.runMeta
  ) {
    const legacyRead = await readJsonFromStores({
      durable,
      volatile,
      key: LEGACY_SHORT_KEYS.tradeRunMeta,
      fallback: null
    });
    if (
      legacyRead.value !== null &&
      legacyRead.value !== undefined
    ) {
      return {
        ...legacyRead,
        key: LEGACY_SHORT_KEYS.tradeRunMeta,
        legacyFallbackUsed: true
      };
    }
  }
  return {
    value: null,
    source: null,
    key: SHORT_KEYS.trade.runMeta,
    legacyFallbackUsed: false
  };
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      label,
      value: fallback,
      error: error?.message || String(error)
    };
  }
}

function normalizeMarketWeatherRegimeFallback(value = '') {
  const raw = upper(value);

  if (!raw || raw === 'NA' || raw === 'NULL' || raw === 'UNDEFINED') return 'UNKNOWN';

  if (raw.includes('SQUEEZE')) return 'SQUEEZE';
  if (raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('COMPRESS')) return 'SQUEEZE';
  if (raw.includes('COIL')) return 'SQUEEZE';
  if (raw.includes('LOW_VOL')) return 'SQUEEZE';

  if (raw.includes('CHOP')) return 'CHOP';
  if (raw.includes('RANGE')) return 'CHOP';
  if (raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('MIXED')) return 'CHOP';

  if (raw.includes('TREND')) return 'TREND';
  if (raw.includes('FLOW')) return 'TREND';
  if (raw.includes('MOMENTUM')) return 'TREND';
  if (raw.includes('DIRECTION')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSideFallback(value = '') {
  const raw = upper(value);

  if (!raw || raw === 'NA' || raw === 'NULL' || raw === 'UNDEFINED') return 'UNKNOWN';

  if (raw.includes('BEAR')) return 'BEARISH';
  if (raw.includes('SHORT')) return 'BEARISH';
  if (raw.includes('SELL')) return 'BEARISH';
  if (raw.includes('DOWN')) return 'BEARISH';
  if (raw.includes('DOWNSIDE')) return 'BEARISH';
  if (raw.includes('RISK_OFF')) return 'BEARISH';

  if (raw.includes('BULL')) return 'BULLISH';
  if (raw.includes('LONG')) return 'BULLISH';
  if (raw.includes('BUY')) return 'BULLISH';
  if (raw.includes('UP')) return 'BULLISH';
  if (raw.includes('UPSIDE')) return 'BULLISH';
  if (raw.includes('RISK_ON')) return 'BULLISH';

  if (raw.includes('NEUTRAL')) return 'NEUTRAL';
  if (raw.includes('MIXED')) return 'NEUTRAL';
  if (raw.includes('FLAT')) return 'NEUTRAL';
  if (raw.includes('BALANCED')) return 'NEUTRAL';

  return 'UNKNOWN';
}

function buildEntryMarketWeatherKeyFallback(input = {}) {
  if (typeof input === 'string') {
    const raw = upper(input);

    if (!raw || raw === '[OBJECT OBJECT]' || raw.includes('[OBJECT OBJECT]')) {
      return 'UNKNOWN|UNKNOWN';
    }

    if (raw.includes('|')) {
      const [regimeRaw, trendRaw] = raw.split('|');
      const regime = normalizeMarketWeatherRegimeFallback(regimeRaw);
      const trendSide = normalizeMarketWeatherTrendSideFallback(trendRaw);

      return `${regime}|${trendSide}`;
    }

    return 'UNKNOWN|UNKNOWN';
  }

  if (!input || typeof input !== 'object') return 'UNKNOWN|UNKNOWN';

  const directKey = upper(
    input.entryMarketWeatherKey ||
      input.currentMarketWeatherKey ||
      input.confirmedMarketWeatherKey ||
      input.marketWeatherKey ||
      input.weatherKey ||
      input.key ||
      ''
  );

  if (directKey.includes('|')) return buildEntryMarketWeatherKeyFallback(directKey);

  const regime = normalizeMarketWeatherRegimeFallback(
    input.entryMarketWeatherRegime ||
      input.currentMarketWeatherRegime ||
      input.confirmedMarketWeatherRegime ||
      input.marketWeatherRegime ||
      input.currentRegime ||
      input.regime ||
      input.marketRegime
  );

  const trendSide = normalizeMarketWeatherTrendSideFallback(
    input.entryMarketWeatherTrendSide ||
      input.currentMarketWeatherTrendSide ||
      input.confirmedMarketWeatherTrendSide ||
      input.marketWeatherTrendSide ||
      input.currentTrendSide ||
      input.trendSide ||
      input.marketTrendSide ||
      input.marketSide ||
      input.side ||
      input.direction
  );

  return `${regime}|${trendSide}`;
}

function parseMarketWeatherKey(key = '') {
  const normalized = buildEntryMarketWeatherKeyFallback(key);
  const [regimeRaw, trendRaw] = normalized.split('|');

  const regime = normalizeMarketWeatherRegimeFallback(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSideFallback(trendRaw);

  return {
    key: `${regime}|${trendSide}`,
    regime,
    trendSide,
    known: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
  };
}

function buildEntryMarketWeatherSnapshotFallback(input = {}) {
  const parsed = parseMarketWeatherKey(
    input.entryMarketWeatherKey ||
      input.currentMarketWeatherKey ||
      input.confirmedMarketWeatherKey ||
      input.marketWeatherKey ||
      input
  );

  const capturedAt = firstFinite(
    input.entryMarketWeatherCapturedAt,
    input.currentMarketWeatherCapturedAt,
    input.confirmedMarketWeatherCapturedAt,
    input.marketWeatherCapturedAt,
    input.updatedAt,
    input.generatedAt,
    input.createdAt,
    input.ts,
    Date.now()
  );

  return {
    entryMarketWeatherKey: parsed.key,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: parsed.regime,
    entryMarketWeatherTrendSide: parsed.trendSide,
    entryMarketWeatherCapturedAt: capturedAt,
    entryMarketWeatherKnown: parsed.known,
    entryMarketWeatherRaw: input.entryMarketWeatherRaw || input.marketWeatherRaw || null,
    entryMarketWeatherRawAvailableFields: Array.isArray(input.entryMarketWeatherRawAvailableFields)
      ? input.entryMarketWeatherRawAvailableFields
      : Object.keys(input || {}).filter((key) => {
          const text = lower(key);
          return text.includes('weather') || text.includes('regime') || text.includes('trend');
        })
  };
}

async function importMarketKeyHelpers() {
  try {
    const module = await import('../../src/market/marketKey.js');

    return {
      importOk: true,
      importError: null,
      normalizeMarketWeatherRegime:
        module.normalizeMarketWeatherRegime || normalizeMarketWeatherRegimeFallback,
      normalizeMarketWeatherTrendSide:
        module.normalizeMarketWeatherTrendSide || normalizeMarketWeatherTrendSideFallback,
      buildEntryMarketWeatherKey:
        module.buildEntryMarketWeatherKey || buildEntryMarketWeatherKeyFallback,
      buildEntryMarketWeatherSnapshot:
        module.buildEntryMarketWeatherSnapshot || buildEntryMarketWeatherSnapshotFallback,
      isFreshConfirmedMarketWeather:
        module.isFreshConfirmedMarketWeather || null
    };
  } catch (error) {
    return {
      importOk: false,
      importError: error?.message || String(error),
      normalizeMarketWeatherRegime: normalizeMarketWeatherRegimeFallback,
      normalizeMarketWeatherTrendSide: normalizeMarketWeatherTrendSideFallback,
      buildEntryMarketWeatherKey: buildEntryMarketWeatherKeyFallback,
      buildEntryMarketWeatherSnapshot: buildEntryMarketWeatherSnapshotFallback,
      isFreshConfirmedMarketWeather: null
    };
  }
}

function marketWeatherFromPayload(payload = {}) {
  const parsed = parseMarketWeatherKey({
    currentMarketWeatherKey:
      payload.confirmedMarketWeatherKey ||
      payload.currentMarketWeatherKey ||
      payload.entryMarketWeatherKey ||
      payload.marketWeatherKey,
    currentMarketWeatherRegime:
      payload.confirmedMarketWeatherRegime ||
      payload.currentMarketWeatherRegime ||
      payload.entryMarketWeatherRegime ||
      payload.marketWeatherRegime ||
      payload.regime,
    currentMarketWeatherTrendSide:
      payload.confirmedMarketWeatherTrendSide ||
      payload.currentMarketWeatherTrendSide ||
      payload.entryMarketWeatherTrendSide ||
      payload.marketWeatherTrendSide ||
      payload.trendSide ||
      payload.side ||
      payload.direction
  });

  const ts = firstFinite(
    payload.confirmedMarketWeatherUpdatedAt,
    payload.currentMarketWeatherUpdatedAt,
    payload.marketWeatherUpdatedAt,
    payload.updatedAt,
    payload.generatedAt,
    payload.createdAt,
    payload.ts,
    parsed.known ? Date.now() : null
  );

  const age = ageMin(ts);

  return {
    currentMarketWeatherKey: parsed.key,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: parsed.regime,
    currentMarketWeatherTrendSide: parsed.trendSide,
    currentMarketWeatherKnown: parsed.known,

    confirmedMarketWeatherKey: parsed.key,
    confirmedMarketWeatherRegime: parsed.regime,
    confirmedMarketWeatherTrendSide: parsed.trendSide,
    confirmedMarketWeatherKnown: parsed.known,
    confirmedMarketWeatherUpdatedAt: ts,
    confirmedMarketWeatherAgeMin: age,
    confirmedMarketWeatherFresh: parsed.known && age !== null && age <= PLAYBOOK_MAX_AGE_MIN
  };
}

function marketWeatherFromQuery(req = {}) {
  const query = req.query || {};

  return marketWeatherFromPayload({
    currentMarketWeatherKey:
      query.confirmedMarketWeatherKey ||
      query.currentMarketWeatherKey ||
      query.entryMarketWeatherKey ||
      query.marketWeatherKey,
    currentMarketWeatherRegime:
      query.confirmedMarketWeatherRegime ||
      query.currentMarketWeatherRegime ||
      query.entryMarketWeatherRegime ||
      query.marketWeatherRegime ||
      query.regime,
    currentMarketWeatherTrendSide:
      query.confirmedMarketWeatherTrendSide ||
      query.currentMarketWeatherTrendSide ||
      query.entryMarketWeatherTrendSide ||
      query.marketWeatherTrendSide ||
      query.trendSide,
    updatedAt: firstFinite(
      query.confirmedMarketWeatherUpdatedAt,
      query.currentMarketWeatherUpdatedAt,
      query.marketWeatherUpdatedAt,
      Date.now()
    )
  });
}

async function readStoredMarketWeather({ durable, volatile }) {
  for (const key of MARKET_WEATHER_KEYS) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (!read.value) continue;

    const weather = marketWeatherFromPayload(safeObject(read.value));

    if (weather.confirmedMarketWeatherKnown) {
      return {
        ...weather,
        source: read.source,
        sourceKey: key
      };
    }
  }

  return {
    ...marketWeatherFromPayload({}),
    source: null,
    sourceKey: null
  };
}

function chooseCurrentMarketWeather({ queryWeather, storedWeather }) {
  if (queryWeather?.confirmedMarketWeatherKnown) {
    return {
      ...storedWeather,
      ...queryWeather,
      source: 'REQUEST_QUERY_KNOWN_WEATHER',
      requestOverrideApplied: true,
      unknownRequestOverrideBlocked: false
    };
  }

  if (storedWeather?.confirmedMarketWeatherKnown) {
    return {
      ...storedWeather,
      source: storedWeather.source || 'STORED_MARKET_WEATHER',
      requestOverrideApplied: false,
      unknownRequestOverrideBlocked: true
    };
  }

  return {
    ...marketWeatherFromPayload({}),
    source: 'UNKNOWN_FALLBACK',
    requestOverrideApplied: false,
    unknownRequestOverrideBlocked: true
  };
}

function featureFlags() {
  return {
    version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
    capture: 'LIVE',
    aggregation: 'LIVE',
    selector: 'OBSERVE',
    sizingCap: 'OBSERVE',
    fdr: 'OBSERVE',
    discordTradeReady: 'VALIDATION_REQUIRED',
    captureEnabled: true,
    aggregationEnabled: true,
    selectorObserveOnly: true,
    sizingCapObserveOnly: true,
    fdrObserveOnly: true,
    discordTradeReadyHardLiveEnabled: false,
    unknownWeatherOverrideBlocked: true,
    adminTradeNeverReturnsHttp500OnReadableFailure: true
  };
}

function taxonomyFlags() {
  return {
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75ContextFamilyCount: 75,
    selectableIdsAreMicroMicroOnly: true,
    child75IdsAreContextOnly: true,
    parentIdsAreMetadataOnly: true,

    parentFamilyFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75ContextFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableMicroMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    discordSelectionGranularity: 'EXACT_MICRO_MICRO_ID_ONLY'
  };
}

function modeFlags() {
  return {
    adminRouteVersion: MARKET_WEATHER_ADMIN_TRADE_VERSION,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    shadowOnly: false,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    observationFirstAnalyze: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    timeStopEnabled: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitMisfitIsPolicyBlock: false,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    unknownWeatherNeverTradeReady: true,
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    featureFlags: featureFlags(),

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,
    scannerBucketsAreNotSelectable: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    marketWeatherExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactMicroMicroOnly: true,
    exactMicroMicroFamilyRequired: true,

    ...taxonomyFlags(),

    learningMode: 'MICRO_FAMILY_SHORT_ONLY_VIRTUAL_MICRO_MICRO_MARKETWEATHER',
    discordOnlyForManualSelection: true,
    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    manualSelectionMustUseMicroMicroId: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ID_ONLY',
    child75MatchDoesNotTriggerDiscord: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForMicroMicroActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING}`,
      EMPIRICAL_VETO: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING} && standaloneExactLifetimeLCB95AvgR < 0`
    },

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,

    adminReadOnly: true,
    http500Guard: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
}

function sideToTradeSideCompat(value) {
  if (typeof Utils.sideToTradeSide === 'function') {
    try {
      const side = Utils.sideToTradeSide(value);
      if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
    } catch {
      // fallback below
    }
  }

  const raw = upper(value);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
    .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
    .replaceAll('BLOCK_SHORT', 'LONG')
    .replaceAll('SHORT_DISABLED', 'LONG')
    .replaceAll('SHORTDISABLED', 'LONG')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9=:_|]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizeSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`) ||
    text.includes(`|${pattern}|`)
  ));
}

function hasLongToken(text = '') {
  return hasSignalPattern(text, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'UP',
    'UPSIDE',
    'MICRO_LONG',
    'SIDE_LONG',
    'SIDE_BULL',
    'SIDE_BUY',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'DIRECTION_BULL',
    'DIRECTION_BUY'
  ]);
}

function hasShortToken(text = '') {
  return hasSignalPattern(text, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'DOWN',
    'DOWNSIDE',
    'MICRO_SHORT',
    'SIDE_SHORT',
    'SIDE_BEAR',
    'SIDE_SELL',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'DIRECTION_BEAR',
    'DIRECTION_SELL'
  ]);
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSideCompat(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const shortHit = hasShortToken(raw);
  const longHit = hasLongToken(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isScannerFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('SHORT_SCANNER_') ||
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.includes('LONG_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isCanonicalMicroMicroId(id = '') {
  return /^MICRO_SHORT_.+_MM_[A-Z0-9]{3,24}$/u.test(upper(id));
}

function isAlternateMicroMicroId(id = '') {
  return upper(id).startsWith('MM_SHORT_');
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  if (isCanonicalMicroMicroId(value) || isAlternateMicroMicroId(value)) return false;

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function parseBodySetupRegimeConfirmation(body = '') {
  const cleanBody = upper(body).replace(/^_+|_+$/g, '');

  for (const setup of SETUP_ORDER) {
    const setupPrefix = `${setup}_`;
    if (!cleanBody.startsWith(setupPrefix)) continue;

    const afterSetup = cleanBody.slice(setupPrefix.length);

    for (const regime of REGIME_ORDER) {
      if (afterSetup === regime) {
        return { ok: true, setup, regime, confirmationProfile: null, rest: '' };
      }

      const regimePrefix = `${regime}_`;
      if (!afterSetup.startsWith(regimePrefix)) continue;

      const afterRegime = afterSetup.slice(regimePrefix.length);

      for (const profile of CONFIRMATION_PROFILE_ORDER) {
        if (afterRegime === profile) {
          return { ok: true, setup, regime, confirmationProfile: profile, rest: '' };
        }

        const profilePrefix = `${profile}_`;

        if (afterRegime.startsWith(profilePrefix)) {
          return {
            ok: true,
            setup,
            regime,
            confirmationProfile: profile,
            rest: afterRegime.slice(profilePrefix.length)
          };
        }
      }
    }
  }

  return {
    ok: false,
    setup: null,
    regime: null,
    confirmationProfile: null,
    rest: ''
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      reason: 'EMPTY_ID'
    };
  }

  if (value.includes('MICRO_LONG_') || value.startsWith('MM_LONG_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      reason: 'LONG_DISABLED_SHORT_ONLY'
    };
  }

  if (isScannerFingerprintId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      reason: 'SCANNER_FINGERPRINT_METADATA_ONLY'
    };
  }

  if (isExecutionFingerprintId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      reason: 'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE'
    };
  }

  let body = '';
  let explicitMicroMicro = false;
  let canonicalMicroMicroSyntax = false;
  let context = '';

  if (value.startsWith('MM_SHORT_')) {
    body = value.slice('MM_SHORT_'.length);
    explicitMicroMicro = true;
  } else if (value.startsWith('MICRO_SHORT_')) {
    body = value.slice('MICRO_SHORT_'.length);

    const markerIndex = body.lastIndexOf(MICRO_MICRO_MARKER);

    if (markerIndex > -1) {
      explicitMicroMicro = true;
      canonicalMicroMicroSyntax = true;
      context = body.slice(markerIndex + MICRO_MICRO_MARKER.length);
      body = body.slice(0, markerIndex);
    }
  } else {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      reason: 'NOT_SHORT_TAXONOMY_ID'
    };
  }

  const parsed = parseBodySetupRegimeConfirmation(body);

  if (!parsed.ok) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      reason: 'INVALID_SHORT_TAXONOMY_BODY'
    };
  }

  if (explicitMicroMicro && !context && parsed.rest) context = parsed.rest;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setup}_${parsed.regime}`;
  const childTrueMicroFamilyId = parsed.confirmationProfile
    ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}`
    : null;

  const isParent = Boolean(!parsed.confirmationProfile && !explicitMicroMicro);
  const isChild = Boolean(parsed.confirmationProfile && !explicitMicroMicro && !parsed.rest);
  const isMicroMicro = Boolean(parsed.confirmationProfile && (explicitMicroMicro || parsed.rest));

  const microMicroHash = isMicroMicro
    ? canonicalMicroMicroSyntax
      ? normalizeHash(context)
      : normalizeHash(context || parsed.rest) || stableHash10(value)
    : null;

  const microMicroFamilyId = isMicroMicro && microMicroHash
    ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`
    : null;

  const trueMicroFamilyId = microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId;

  return {
    valid: true,
    selectable: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,
    id: trueMicroFamilyId,
    key: trueMicroFamilyId,
    setup: parsed.setup,
    regime: parsed.regime,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroContext: context || parsed.rest || '',
    microMicroHash,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    trueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? CHILD_TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? CHILD_TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isChild
        ? CHILD75_LEARNING_GRANULARITY
        : PARENT_LEARNING_GRANULARITY,
    selectionGranularity: isMicroMicro ? 'EXACT_MICRO_MICRO_ONLY' : 'NOT_SELECTABLE',
    selectionLayer: isMicroMicro ? 'MICRO_MICRO' : 'NOT_SELECTABLE'
  };
}

function isSelectableMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.valid === true && parsed.selectable === true && parsed.isMicroMicro === true;
}

function getExplicitMicroMicroId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    const parsed = parseShortTaxonomyMicroId(row);
    return parsed.isMicroMicro ? parsed.microMicroFamilyId : null;
  }

  for (const value of [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ]) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
  }

  return null;
}

function validLongRiskShape({
  entry,
  initialSl,
  sl,
  tp
} = {}) {
  const e = num(entry, 0);
  const stop = num(sl ?? initialSl, 0);
  const initialStop = num(initialSl ?? sl, 0);
  const target = num(tp, 0);

  return e > 0 && stop > 0 && initialStop > 0 && stop < e && initialStop < e && target > 0 && target > e;
}

function validShortRiskShape({
  entry,
  initialSl,
  sl,
  tp
} = {}) {
  const e = num(entry, 0);
  const stop = num(sl ?? initialSl, 0);
  const initialStop = num(initialSl ?? sl, 0);
  const target = num(tp, 0);

  return e > 0 && stop > 0 && initialStop > 0 && stop > e && initialStop > e && target > 0 && target < e;
}

function hasRiskGeometryFields(row = {}) {
  return [
    row.entry,
    row.entryPrice,
    row.sl,
    row.stopLoss,
    row.initialSl,
    row.initialStopLoss,
    row.tp,
    row.takeProfit
  ].some((value) => firstFinite(value) !== null);
}

function directionalMoveScore(row = {}) {
  const values = [
    row.change1m,
    row.change5m,
    row.change15m,
    row.change30m,
    row.change1h,
    row.change4h,
    row.change24h,
    row.priceChange1mPct,
    row.priceChange5mPct,
    row.priceChange15mPct,
    row.priceChange30mPct,
    row.priceChange1hPct,
    row.priceChange4hPct,
    row.priceChange24hPct,
    row.priceChangePercent,
    row.priceChangePct,
    row.movePct,
    row.move,
    row.percentChange
  ]
    .map((value) => num(value, 0))
    .filter((value) => Number.isFinite(value) && value !== 0);

  if (!values.length) return 0;

  return values.reduce((total, value) => total + Math.sign(value), 0);
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    if (hasShortToken(row)) return TARGET_TRADE_SIDE;
    if (hasLongToken(row)) return OPPOSITE_TRADE_SIDE;
    return 'UNKNOWN';
  }

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  for (const source of [
    row.rawInferredTradeSide,
    row.originalTradeSide,
    row.inferredTradeSide,
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ]) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const familyText = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.macroFamily,
    row.originalMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  const familyShort = hasShortToken(familyText);
  const familyLong = hasLongToken(familyText);

  if (familyShort && !familyLong) return TARGET_TRADE_SIDE;
  if (familyLong && !familyShort) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  if (validShortRiskShape(row)) return TARGET_TRADE_SIDE;
  if (validLongRiskShape(row)) return OPPOSITE_TRADE_SIDE;

  const moveScore = directionalMoveScore(row);

  if (moveScore < 0) return TARGET_TRADE_SIDE;
  if (moveScore > 0) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isUnknownSideRow(row = {}) {
  return inferTradeSide(row) === 'UNKNOWN';
}

function safeBaseSymbol(value) {
  if (typeof Utils.normalizeBaseSymbol === 'function') {
    try {
      return Utils.normalizeBaseSymbol(value);
    } catch {
      // fallback below
    }
  }

  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/USDT$/u, '')
    .replace(/_UMCBL$/u, '')
    .replace(/-PERP$/u, '');
}

function safeContractSymbol(value) {
  if (typeof Utils.normalizeContractSymbol === 'function') {
    try {
      return Utils.normalizeContractSymbol(value);
    } catch {
      // fallback below
    }
  }

  return String(value || '').trim().toUpperCase();
}

function normalizeDefinitionParts(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    return value
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [];
}

function getPositionTimeStopMin() {
  const value = num(
    CONFIG.short?.trade?.positionTimeStopMin ??
      CONFIG.trade?.shortPositionTimeStopMin ??
      CONFIG.trade?.positionTimeStopMin,
    DEFAULT_POSITION_TIME_STOP_MIN
  );

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POSITION_TIME_STOP_MIN;

  return value;
}

function marketBiasHaystack(row = {}) {
  return [
    row.currentMarketTrendSide,
    row.marketTrendSide,
    row.trendSide,
    row.dashboardSide,
    row.marketSide,
    row.marketBias,
    row.bias,
    row.direction,
    row.currentRegime,
    row.marketRegime,
    row.regime,
    row.currentFitReason,
    ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
  ]
    .map((value) => upper(value))
    .join(' | ');
}

function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
  if (!Number.isFinite(score)) return fallback || 'UNKNOWN';
  if (score >= 45) return 'FIT';
  if (score >= 20) return 'OK';
  if (score <= -20) return 'MISFIT';

  return 'NEUTRAL';
}

function getShortCurrentFit(row = {}) {
  const explicitShort = firstFinite(
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore
  );

  if (explicitShort !== null) {
    return {
      score: explicitShort,
      label: currentFitLabel(explicitShort, row.currentFit || 'UNKNOWN'),
      source: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const explicitLong = firstFinite(
    row.longCurrentFit,
    row.bullCurrentFit,
    row.bullishCurrentFit,
    row.currentFitLong,
    row.currentFitBull,
    row.longFitScore,
    row.bullFitScore
  );

  if (explicitLong !== null) {
    const score = -Math.abs(explicitLong);

    return {
      score,
      label: currentFitLabel(score, row.currentFit || 'UNKNOWN'),
      source: 'INVERTED_LONG_OR_BULL_CURRENT_FIT'
    };
  }

  const rawFit = firstFinite(
    row.currentFitScore,
    row.fitScore,
    row.marketFitScore,
    row.marketFit,
    row.currentFitNumeric
  );

  if (rawFit === null) {
    return {
      score: 0,
      label: row.currentFit || row.currentFitLabel || 'UNKNOWN',
      source: 'NO_NUMERIC_CURRENT_FIT'
    };
  }

  const haystack = marketBiasHaystack(row);
  let score;

  if (
    haystack.includes('BEAR') ||
    haystack.includes('BEARISH') ||
    haystack.includes('SHORT') ||
    haystack.includes('SELL') ||
    haystack.includes('DOWNSIDE')
  ) {
    score = Math.abs(rawFit);
  } else if (
    haystack.includes('BULL') ||
    haystack.includes('BULLISH') ||
    haystack.includes('LONG') ||
    haystack.includes('BUY') ||
    haystack.includes('UPSIDE')
  ) {
    score = -Math.abs(rawFit);
  } else {
    score = -rawFit;
  }

  return {
    score,
    label: currentFitLabel(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
    source: 'SHORT_MIRRORED_GENERIC_CURRENT_FIT'
  };
}

function calcRiskDistance(entry, initialSl) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);

  if (e <= 0 || sl <= 0 || sl <= e) return 0;

  return sl - e;
}

function calcRewardDistance(entry, tp) {
  const e = num(entry, 0);
  const target = num(tp, 0);

  if (e <= 0 || target <= 0 || target >= e) return 0;

  return e - target;
}

function calcCurrentR({
  entry,
  initialSl,
  currentPrice,
  fallback = 0
} = {}) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);
  const price = num(currentPrice, 0);
  const riskDistance = calcRiskDistance(e, sl);

  if (e <= 0 || sl <= 0 || price <= 0 || riskDistance <= 0) {
    return num(fallback, 0);
  }

  return (e - price) / riskDistance;
}

function calcGrossR({
  entry,
  initialSl,
  exitPrice,
  fallback = 0
} = {}) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);
  const price = num(exitPrice, 0);
  const riskDistance = calcRiskDistance(e, sl);

  if (e <= 0 || sl <= 0 || price <= 0 || riskDistance <= 0) {
    return num(fallback, 0);
  }

  return (e - price) / riskDistance;
}

function buildExitDebug({
  entry,
  sl,
  initialSl,
  tp,
  currentPrice,
  openedAt
} = {}) {
  const ageSec = calcAgeSec(openedAt);
  const timeStopMin = getPositionTimeStopMin();
  const timeStopSec = timeStopMin * 60;

  const tpHitNow = currentPrice > 0 && tp > 0 && currentPrice <= tp;
  const slHitNow = currentPrice > 0 && sl > 0 && currentPrice >= sl;
  const timeStopHitNow = ageSec !== null && ageSec >= timeStopSec;

  let exitReasonNow = null;

  if (tpHitNow) exitReasonNow = 'TP';
  else if (slHitNow) exitReasonNow = 'SL';
  else if (timeStopHitNow) exitReasonNow = 'TIME_STOP';

  return {
    tpHitNow,
    slHitNow,
    timeStopHitNow,
    exitReadyNow: Boolean(exitReasonNow),
    exitReasonNow,

    shortExitPriority: ['TP', 'SL', 'TIME_STOP'],
    tpSlIndependentFromTimeStop: true,

    timeStopMin,
    timeStopSec,
    ageSec,
    secondsUntilTimeStop: ageSec === null
      ? null
      : Math.max(0, timeStopSec - ageSec),

    grossRIfClosedNow: round(
      calcCurrentR({
        entry,
        initialSl,
        currentPrice,
        fallback: 0
      }),
      4
    )
  };
}

function resolveTaxonomyIds(row = {}) {
  const id = getExplicitMicroMicroId(row);
  const parsed = parseShortTaxonomyMicroId(
    id ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.id ||
      row.key
  );

  return {
    parsed,
    microMicroFamilyId: parsed.microMicroFamilyId || id || null,
    trueMicroMicroFamilyId: parsed.trueMicroMicroFamilyId || id || null,
    exactMicroMicroFamilyId: parsed.exactMicroMicroFamilyId || id || null,
    trueMicroFamilyId: parsed.trueMicroFamilyId || id || null,
    microFamilyId: parsed.trueMicroFamilyId || id || null,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId || row.parentTrueMicroFamilyId || null,
    childTrueMicroFamilyId:
      parsed.childTrueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      null,
    base75ChildTrueMicroFamilyId:
      parsed.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      null,
    isMicroMicro: parsed.isMicroMicro === true,
    selectableMicroMicroFamilyId: parsed.selectable === true
  };
}

function buildMarketWeatherFields(row = {}, currentMarketWeather = {}, helpers = {}) {
  const buildSnapshot =
    helpers.buildEntryMarketWeatherSnapshot || buildEntryMarketWeatherSnapshotFallback;
  const buildKey =
    helpers.buildEntryMarketWeatherKey || buildEntryMarketWeatherKeyFallback;

  const fallbackWeather = marketWeatherFromPayload(currentMarketWeather);

  const directEntryKey = firstValue(
    row.entryMarketWeatherKey,
    row.marketWeatherKey
  );

  const rowEntryKey = directEntryKey
    ? buildKey(directEntryKey)
    : buildKey({
        entryMarketWeatherRegime:
          row.entryMarketWeatherRegime ||
          row.marketWeatherRegime ||
          row.regime,
        entryMarketWeatherTrendSide:
          row.entryMarketWeatherTrendSide ||
          row.marketWeatherTrendSide ||
          row.trendSide ||
          row.side ||
          row.direction
      });

  const rowEntryParsed = parseMarketWeatherKey(rowEntryKey);
  const entryParsed = rowEntryParsed.known
    ? rowEntryParsed
    : parseMarketWeatherKey(fallbackWeather.confirmedMarketWeatherKey);

  const snapshot = buildSnapshot({
    ...row,
    entryMarketWeatherKey: entryParsed.key
  });

  const rowCurrentParsed = parseMarketWeatherKey({
    currentMarketWeatherKey:
      row.currentMarketWeatherKey ||
      row.confirmedMarketWeatherKey,
    currentMarketWeatherRegime:
      row.currentMarketWeatherRegime ||
      row.confirmedMarketWeatherRegime,
    currentMarketWeatherTrendSide:
      row.currentMarketWeatherTrendSide ||
      row.confirmedMarketWeatherTrendSide
  });

  const currentParsed = rowCurrentParsed.known
    ? rowCurrentParsed
    : parseMarketWeatherKey(fallbackWeather.confirmedMarketWeatherKey);

  const confirmedParsed = parseMarketWeatherKey(
    currentMarketWeather.confirmedMarketWeatherKey ||
      currentParsed.key
  );

  return {
    entryMarketWeatherKey: entryParsed.key,
    entryMarketWeatherKeyVersion: snapshot.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: entryParsed.regime,
    entryMarketWeatherTrendSide: entryParsed.trendSide,
    entryMarketWeatherCapturedAt: snapshot.entryMarketWeatherCapturedAt || row.entryMarketWeatherCapturedAt || null,
    entryMarketWeatherKnown: entryParsed.known,
    entryMarketWeatherRaw: snapshot.entryMarketWeatherRaw || row.entryMarketWeatherRaw || null,
    entryMarketWeatherRawAvailableFields:
      snapshot.entryMarketWeatherRawAvailableFields ||
      row.entryMarketWeatherRawAvailableFields ||
      [],

    currentMarketWeatherKey: currentParsed.key,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: currentParsed.regime,
    currentMarketWeatherTrendSide: currentParsed.trendSide,
    currentMarketWeatherKnown: currentParsed.known,

    confirmedMarketWeatherKey: confirmedParsed.key,
    confirmedMarketWeatherRegime: confirmedParsed.regime,
    confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
    confirmedMarketWeatherKnown: confirmedParsed.known,

    weatherMatched:
      entryParsed.known &&
      confirmedParsed.known &&
      entryParsed.key === confirmedParsed.key,

    adminTradeWeatherFallbackApplied: !rowEntryParsed.known && fallbackWeather.confirmedMarketWeatherKnown
  };
}

function inferPolicyBlocked(row = {}) {
  const taxonomy = resolveTaxonomyIds(row);
  const confirmationProfile = upper(row.confirmationProfile || taxonomy.parsed.confirmationProfile);

  if (!taxonomy.isMicroMicro) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'EXACT_MICRO_MICRO_ID_REQUIRED'
    };
  }

  if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'NON_SHORT_POLICY_BLOCK'
    };
  }

  if (confirmationProfile === 'E_WEAK_CONTRA') {
    return {
      policyBlocked: true,
      policyBlockedReason: 'E_WEAK_CONTRA_POLICY_BLOCK'
    };
  }

  if (hasRiskGeometryFields(row) && !validShortRiskShape(row)) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'INVALID_SHORT_GEOMETRY_POLICY_BLOCK'
    };
  }

  if (row.policyBlocked === true || row.policyBlockedReason) {
    const reason = row.policyBlockedReason || 'POLICY_BLOCKED';
    const text = upper(reason);

    if (
      text.includes('KNOWN_FORBIDDEN_FAMILY') &&
      confirmationProfile !== 'E_WEAK_CONTRA' &&
      !isScannerFingerprintId(taxonomy.microMicroFamilyId) &&
      !isExecutionFingerprintId(taxonomy.microMicroFamilyId) &&
      !upper(taxonomy.microMicroFamilyId).includes('MICRO_LONG_')
    ) {
      return {
        policyBlocked: false,
        policyBlockedReason: null,
        inheritedPolicyBlockedIgnored: true,
        inheritedPolicyBlockedReason: reason
      };
    }

    return {
      policyBlocked: true,
      policyBlockedReason: reason
    };
  }

  return {
    policyBlocked: false,
    policyBlockedReason: null
  };
}

function inferEmpiricalVeto(row = {}) {
  if (row.empiricalVeto === true) {
    return {
      empiricalVeto: true,
      empiricalVetoReason: row.empiricalVetoReason || 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE'
    };
  }

  const completed = num(
    row.completed ??
      row.outcomeSample ??
      row.virtualCompleted ??
      row.shadowCompleted,
    0
  );

  const lcb95 = firstFinite(
    row.standaloneMicroMicroLifetimeLCB95AvgR,
    row.standaloneExactMicroMicroLifetimeLCB95AvgR,
    row.lcb95AvgR,
    row.avgRLCB95,
    row.avgRLowerBound95
  );

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING && lcb95 !== null && lcb95 < 0) {
    return {
      empiricalVeto: true,
      empiricalVetoReason: 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE'
    };
  }

  return {
    empiricalVeto: false,
    empiricalVetoReason: null
  };
}

function deriveSignalType(row = {}) {
  const weather = parseMarketWeatherKey(row.currentMarketWeatherKey || row.entryMarketWeatherKey);
  const risk = num(row.riskFractionForEntry ?? row.riskFraction, 0);
  const lcb95 = firstFinite(row.shrunkLCB95AvgR, row.finalShrunkLCB95AvgR, row.lcb95AvgR);
  const fdrPass = row.fdrPass !== false;
  const playbookFresh = row.playbookFresh === true;

  if (row.policyBlocked || row.empiricalVeto) return SIGNAL_TYPE_BLOCKED;
  if (!weather.known) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (lcb95 !== null && lcb95 <= 0) {
    return row.completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING
      ? SIGNAL_TYPE_WATCH_ONLY
      : SIGNAL_TYPE_OBSERVE_ONLY;
  }

  if (risk > 0 && lcb95 !== null && lcb95 > 0 && fdrPass && playbookFresh) {
    return SIGNAL_TYPE_TRADE_READY;
  }

  if (row.completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING) return SIGNAL_TYPE_WATCH_ONLY;

  return SIGNAL_TYPE_OBSERVE_ONLY;
}

function normalizePosition(position = {}, currentMarketWeather = {}, helpers = {}) {
  const rawSymbol =
    position.symbol ||
    position.baseSymbol ||
    position.contractSymbol ||
    position.instId ||
    position.instrumentId ||
    null;

  const symbol = safeBaseSymbol(rawSymbol);

  const contractSymbol = safeContractSymbol(
    position.contractSymbol ||
      position.symbol ||
      position.instId ||
      position.instrumentId ||
      symbol
  );

  const taxonomy = resolveTaxonomyIds(position);
  const weather = buildMarketWeatherFields(position, currentMarketWeather, helpers);

  const rawInferredTradeSide = inferTradeSide({
    ...position,
    ...taxonomy
  });

  const entry = num(position.entry ?? position.entryPrice, 0);
  const sl = num(position.sl ?? position.stopLoss, 0);
  const initialSl = num(
    position.initialSl ??
      position.initialStopLoss ??
      sl,
    sl
  );
  const tp = num(position.tp ?? position.takeProfit, 0);

  const lastPrice = num(
    position.lastPrice ??
      position.currentPrice ??
      position.markPrice ??
      position.price,
    0
  );

  const currentPrice = num(
    position.currentPrice ??
      position.lastPrice ??
      position.markPrice ??
      position.price,
    lastPrice
  );

  const riskDistance = calcRiskDistance(entry, initialSl);
  const rewardDistance = calcRewardDistance(entry, tp);

  const rr = num(
    position.rr,
    riskDistance > 0 ? rewardDistance / riskDistance : 0
  );

  const currentR = calcCurrentR({
    entry,
    initialSl,
    currentPrice,
    fallback: position.currentR
  });

  const openedAt = num(
    position.openedAt ??
      position.createdAt ??
      position.ts,
    0
  );

  const riskShapeValid = validShortRiskShape({
    entry,
    sl,
    initialSl,
    tp
  });

  const exitDebug = buildExitDebug({
    entry,
    sl,
    initialSl,
    tp,
    currentPrice,
    openedAt
  });

  const fit = getShortCurrentFit(position);

  const grossR = calcGrossR({
    entry,
    initialSl,
    exitPrice: currentPrice,
    fallback: currentR
  });

  const completed = num(position.completed ?? position.outcomeSample ?? 0, 0);

  const shrunkLCB95AvgR = firstFinite(
    position.finalShrunkLCB95AvgR,
    position.shrunkLCB95AvgR,
    position.shrunkAvgRLCB95,
    position.lcb95AvgR
  );

  const policy = inferPolicyBlocked({
    ...position,
    ...taxonomy,
    entry,
    sl,
    initialSl,
    tp
  });

  const veto = inferEmpiricalVeto({
    ...position,
    ...taxonomy,
    completed
  });

  const riskFractionForEntry = policy.policyBlocked || veto.empiricalVeto
    ? 0
    : num(position.riskFractionForEntry ?? position.riskFraction, 0);

  const playbookFresh = position.playbookFresh === true;
  const signalType = deriveSignalType({
    ...position,
    ...weather,
    completed,
    shrunkLCB95AvgR,
    riskFractionForEntry,
    policyBlocked: policy.policyBlocked,
    empiricalVeto: veto.empiricalVeto,
    playbookFresh
  });

  return {
    ...position,

    symbol: symbol || position.symbol || null,
    baseSymbol: symbol || position.baseSymbol || null,
    contractSymbol,

    ...modeFlags(),

    ...taxonomy,
    ...weather,

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide,

    source: position.source || 'VIRTUAL',
    outcomeSource: position.outcomeSource || position.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: Boolean(position.shadowOnly),
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    entry,
    entryPrice: entry,
    sl,
    stopLoss: sl,
    initialSl,
    tp,
    takeProfit: tp,
    rr: round(rr, 4),

    shortRiskShapeValid: riskShapeValid,
    validShortRiskShape: riskShapeValid,
    validShortGeometry: riskShapeValid,

    lastPrice,
    currentPrice,
    currentR: round(currentR, 4),
    shortCurrentR: round(currentR, 4),
    grossR: round(grossR, 4),
    shortGrossR: round(grossR, 4),
    mfeR: round(position.mfeR, 4),
    maeR: round(position.maeR, 4),

    currentFit: fit.label,
    currentFitLabel: fit.label,
    currentFitScore: round(fit.score, 4),
    fitScore: round(fit.score, 4),
    shortCurrentFit: round(fit.score, 4),
    bearCurrentFit: round(fit.score, 4),
    bullishCurrentFit: round(-Math.abs(fit.score), 4),
    currentFitSource: fit.source,

    policyBlocked: policy.policyBlocked,
    policyBlockedReason: policy.policyBlockedReason,
    inheritedPolicyBlockedIgnored: Boolean(policy.inheritedPolicyBlockedIgnored),
    inheritedPolicyBlockedReason: policy.inheritedPolicyBlockedReason || null,

    empiricalVeto: veto.empiricalVeto,
    empiricalVetoReason: veto.empiricalVetoReason,

    completed,
    shrunkAvgR: firstFinite(position.shrunkAvgR, position.finalShrunkAvgR, position.avgR) ?? 0,
    shrunkLCB95AvgR: shrunkLCB95AvgR ?? null,
    standaloneMicroMicroLifetimeLCB95AvgR: firstFinite(
      position.standaloneMicroMicroLifetimeLCB95AvgR,
      position.standaloneExactMicroMicroLifetimeLCB95AvgR,
      position.lcb95AvgR
    ),

    signalType,
    proofSource:
      position.proofSource ||
      (weather.entryMarketWeatherKnown ? 'MICRO_MICRO_MARKETWEATHER' : 'UNKNOWN_WEATHER'),
    proofTier: policy.policyBlocked
      ? PROOF_TIER_POLICY_BLOCKED
      : veto.empiricalVeto
        ? PROOF_TIER_EMPIRICAL_VETO
        : position.proofTier || PROOF_TIER_OBSERVATION_ONLY,
    maxAllowedRiskBand: position.maxAllowedRiskBand || (signalType === SIGNAL_TYPE_TRADE_READY ? 'HIGH' : 'ZERO'),
    riskFractionForEntry,
    riskFraction: riskFractionForEntry,
    riskPct: round(position.riskPct, 6),

    playbookFresh,
    playbookAgeMin: firstFinite(position.playbookAgeMin, ageMin(position.playbookUpdatedAt)),
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    playbookStatus: playbookFresh ? 'FRESH' : 'MISSING_OR_STALE',

    familyResolution: position.familyResolution || 'MICRO_MICRO',
    marketResolution: position.marketResolution || (weather.entryMarketWeatherKnown ? 'REGIME_TREND' : 'UNKNOWN'),

    discordAlertEligible: Boolean(position.discordAlertEligible),
    selectedMicroFamilyAlert: false,
    selectedMicroMicroFamilyAlert: Boolean(position.selectedMicroMicroFamilyAlert || position.selectedMicroFamilyAlert),
    exactSelectedMicroMicroMatch: Boolean(position.exactSelectedMicroMicroMatch || position.selectedMicroMicroFamilyAlert),
    discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
    discordExitAlertSent: Boolean(position.discordExitAlertSent),

    scannerMicroFamilyId: position.scannerMicroFamilyId || null,
    scannerFamilyId: position.scannerFamilyId || null,
    scannerDefinition: position.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(position.scannerDefinitionParts)
      ? position.scannerDefinitionParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: position.executionMicroFamilyId || null,
    executionFingerprintHash: position.executionFingerprintHash || taxonomy.parsed?.microMicroHash || null,
    executionFingerprintParts: Array.isArray(position.executionFingerprintParts)
      ? position.executionFingerprintParts
      : [],
    executionFingerprintSchema: position.executionFingerprintSchema || null,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    macroDefinition: position.macroDefinition || position.parentDefinition || null,
    macroDefinitionParts: normalizeDefinitionParts(
      position.macroDefinitionParts ||
        position.parentDefinitionParts ||
        position.macroDefinition ||
        position.parentDefinition
    ),

    definition: position.definition || position.microDefinition || null,
    definitionParts: normalizeDefinitionParts(
      position.definitionParts ||
        position.microDefinitionParts ||
        position.definition ||
        position.microDefinition
    ),
    microDefinitionParts: normalizeDefinitionParts(
      position.microDefinitionParts ||
        position.definitionParts ||
        position.microDefinition ||
        position.definition
    ),

    activeRotationId: position.activeRotationId || null,
    selectedRotationId: position.selectedRotationId || position.activeRotationId || null,

    openedAt,
    ageSec: exitDebug.ageSec,

    riskDistance: round(riskDistance, 10),
    rewardDistance: round(rewardDistance, 10),

    ticksObserved: num(position.ticksObserved, 0),
    favorableTicks: num(position.favorableTicks, 0),
    adverseTicks: num(position.adverseTicks, 0),

    priceFetchFailures: num(position.priceFetchFailures, 0),
    lastPriceFetchFailedAt: position.lastPriceFetchFailedAt || null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: num(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    liveManaged: false,
    beLiveApplied: false,
    trailLiveApplied: false,
    slManagementSource: position.slManagementSource || null,

    breakEvenArmed: Boolean(position.beArmed || position.breakEvenArmed),
    trailingActive: Boolean(
      position.trailLiveApplied ||
        position.trailingActive ||
        upper(position.slManagementSource) === 'TRAIL'
    ),

    shortTpHit: exitDebug.tpHitNow,
    shortSlHit: exitDebug.slHitNow,
    tpHit: exitDebug.tpHitNow,
    slHit: exitDebug.slHitNow,

    ...exitDebug
  };
}

function forceShortRow(row = {}) {
  return {
    ...row,
    ...modeFlags(),

    source: row.source || 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: Boolean(row.shadowOnly),

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,

    inferredTradeSide: TARGET_TRADE_SIDE
  };
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + num(selector(row), 0), 0);
}

function average(rows, selector) {
  if (!rows.length) return 0;
  return sum(rows, selector) / rows.length;
}

function countBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildPositionStats(positions = [], ignored = {}) {
  const shortRows = positions.filter((row) => !isLongRow(row));

  const totalCurrentR = sum(shortRows, (p) => p.currentR);
  const totalMfeR = sum(shortRows, (p) => p.mfeR);
  const totalMaeR = sum(shortRows, (p) => p.maeR);
  const totalRiskFraction = sum(shortRows, (p) => p.riskFractionForEntry ?? p.riskFraction);

  const profitable = shortRows.filter((p) => num(p.currentR, 0) > 0);
  const losing = shortRows.filter((p) => num(p.currentR, 0) < 0);

  const uniqueParentFamilies = uniqueStrings(
    shortRows.map((position) => position.parentTrueMicroFamilyId)
  );

  const uniqueChildFamilies = uniqueStrings(
    shortRows.map((position) => position.childTrueMicroFamilyId)
  );

  const uniqueMicroMicroFamilies = uniqueStrings(
    shortRows.map((position) => position.exactMicroMicroFamilyId || position.microMicroFamilyId)
  );

  const discordEligiblePositions = shortRows.filter((position) => position.discordAlertEligible);
  const selectedMicroMicroPositions = shortRows.filter((position) => (
    position.selectedMicroMicroFamilyAlert ||
    position.exactSelectedMicroMicroMatch
  ));
  const invalidRiskShapePositions = shortRows.filter((position) => !position.shortRiskShapeValid);
  const unknownWeatherPositions = shortRows.filter((position) => position.entryMarketWeatherKey === 'UNKNOWN|UNKNOWN');
  const tradeReadyPositions = shortRows.filter((position) => position.signalType === SIGNAL_TYPE_TRADE_READY);
  const watchPositions = shortRows.filter((position) => position.signalType === SIGNAL_TYPE_WATCH_ONLY);
  const observePositions = shortRows.filter((position) => position.signalType === SIGNAL_TYPE_OBSERVE_ONLY);
  const blockedPositions = shortRows.filter((position) => position.signalType === SIGNAL_TYPE_BLOCKED);

  return {
    ...modeFlags(),

    openPositions: shortRows.length,
    openVirtualPositions: shortRows.length,

    bearPositions: shortRows.length,
    bullPositions: 0,
    unknownSidePositions: num(ignored.ignoredUnknownSidePositions, 0),

    shortPositions: shortRows.length,
    longPositions: 0,

    rawOpenPositions: num(ignored.rawOpenPositions, shortRows.length),
    ignoredLongPositions: num(ignored.ignoredLongPositions, 0),
    ignoredUnknownSidePositions: num(ignored.ignoredUnknownSidePositions, 0),

    invalidShortRiskShapePositions: invalidRiskShapePositions.length,

    unknownWeatherPositions: unknownWeatherPositions.length,
    weatherKnownPositions: shortRows.length - unknownWeatherPositions.length,

    tradeReadyPositions: tradeReadyPositions.length,
    watchPositions: watchPositions.length,
    observeOnlyPositions: observePositions.length,
    blockedPositions: blockedPositions.length,

    empiricalVetoPositions: shortRows.filter((position) => position.empiricalVeto).length,
    policyBlockedPositions: shortRows.filter((position) => position.policyBlocked).length,

    profitablePositions: profitable.length,
    losingPositions: losing.length,
    flatPositions: shortRows.length - profitable.length - losing.length,

    exitReadyNow: shortRows.filter((p) => p.exitReadyNow).length,
    tpHitNow: shortRows.filter((p) => p.tpHitNow).length,
    slHitNow: shortRows.filter((p) => p.slHitNow).length,
    timeStopHitNow: shortRows.filter((p) => p.timeStopHitNow).length,

    totalCurrentR: round(totalCurrentR, 4),
    avgCurrentR: round(average(shortRows, (p) => p.currentR), 4),

    totalMfeR: round(totalMfeR, 4),
    avgMfeR: round(average(shortRows, (p) => p.mfeR), 4),

    totalMaeR: round(totalMaeR, 4),
    avgMaeR: round(average(shortRows, (p) => p.maeR), 4),

    totalRiskFraction: round(totalRiskFraction, 6),
    shortRiskFraction: round(totalRiskFraction, 6),
    longRiskFraction: 0,

    reachedHalfR: shortRows.filter((p) => p.reachedHalfR).length,
    reachedOneR: shortRows.filter((p) => p.reachedOneR).length,
    nearTpSeen: shortRows.filter((p) => p.nearTpSeen).length,

    beArmed: shortRows.filter((p) => p.beArmed).length,
    beWouldExit: shortRows.filter((p) => p.beWouldExit).length,

    breakEvenArmed: shortRows.filter((p) => p.breakEvenArmed).length,
    trailingActive: shortRows.filter((p) => p.trailingActive).length,

    gaveBackAfterHalfR: shortRows.filter((p) => p.gaveBackAfterHalfR).length,
    gaveBackAfterOneR: shortRows.filter((p) => p.gaveBackAfterOneR).length,
    nearTpThenLoss: shortRows.filter((p) => p.nearTpThenLoss).length,

    discordEligiblePositions: discordEligiblePositions.length,
    selectedMicroMicroPositions: selectedMicroMicroPositions.length,
    selectedMicroFamilyPositions: selectedMicroMicroPositions.length,
    silentLearningPositions: shortRows.length - discordEligiblePositions.length,

    uniqueParentMicroFamilies: uniqueParentFamilies.length,
    uniqueChild75ContextFamilies: uniqueChildFamilies.length,
    uniqueMicroMicroFamilies: uniqueMicroMicroFamilies.length,
    uniqueMacroFamilies: uniqueParentFamilies.length,
    uniqueMicroFamilies: uniqueMicroMicroFamilies.length,

    byParentTrueMicroFamily: countBy(shortRows, (p) => p.parentTrueMicroFamilyId),
    byChildTrueMicroFamily: countBy(shortRows, (p) => p.childTrueMicroFamilyId),
    byMicroMicroFamily: countBy(shortRows, (p) => p.exactMicroMicroFamilyId || p.microMicroFamilyId),
    byEntryMarketWeatherKey: countBy(shortRows, (p) => p.entryMarketWeatherKey),
    byCurrentMarketWeatherKey: countBy(shortRows, (p) => p.currentMarketWeatherKey),
    bySignalType: countBy(shortRows, (p) => p.signalType),

    bySide: {
      bear: shortRows.length,
      bull: 0,
      unknown: num(ignored.ignoredUnknownSidePositions, 0)
    }
  };
}

function extractSnapshotId(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return null;
  }
  return (
    value.snapshotId ||
    value.id ||
    value.latestSnapshotId ||
    value.scanId ||
    value.snapshot?.snapshotId ||
    value.snapshot?.id ||
    value.snapshot?.scanId ||
    value.pointer?.snapshotId ||
    value.pointer?.id ||
    value.meta?.snapshotId ||
    null
  );
}

function normalizeLastProcessed(lastProcessed) {
  const snapshotId = extractSnapshotId(lastProcessed);

  if (!lastProcessed) {
    return {
      snapshotId: null,
      raw: null,
      ...modeFlags()
    };
  }

  if (typeof lastProcessed === 'string') {
    return {
      snapshotId: lastProcessed,
      raw: lastProcessed,
      ...modeFlags()
    };
  }

  return {
    ...lastProcessed,
    ...modeFlags(),
    snapshotId,
    raw: lastProcessed
  };
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return value !== 0;
  }
  const raw = lower(value);
  if (['true', '1', 'yes', 'y', 'complete', 'completed', 'done'].includes(raw)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'processing', 'pending'].includes(raw)) {
    return false;
  }
  return fallback;
}

function clampInteger(
  value,
  fallback = 0,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.max(min, Math.min(max, Math.floor(fallback)));
  }
  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(parsed)
    )
  );
}

function extractSnapshotCandidateCount(value) {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return 0;
  }
  const directCandidates = Array.isArray(value.candidates)
    ? value.candidates
    : null;
  const nestedCandidates = Array.isArray(value.snapshot?.candidates)
    ? value.snapshot.candidates
    : null;
  const directCount = firstFinite(
    value.snapshotChunkTotalCandidates,
    value.totalCandidates,
    value.candidatesCount,
    value.shortCandidatesCount,
    value.rawCandidatesCount,
    value.candidateCount,
    value.total
  );
  const nestedCount = firstFinite(
    value.snapshot?.snapshotChunkTotalCandidates,
    value.snapshot?.totalCandidates,
    value.snapshot?.candidatesCount,
    value.snapshot?.shortCandidatesCount,
    value.snapshot?.rawCandidatesCount,
    value.snapshot?.candidateCount,
    value.snapshot?.total
  );
  if (directCount !== null) {
    return clampInteger(directCount, 0, 0);
  }
  if (nestedCount !== null) {
    return clampInteger(nestedCount, 0, 0);
  }
  if (directCandidates) {
    return directCandidates.length;
  }
  if (nestedCandidates) {
    return nestedCandidates.length;
  }
  return 0;
}

function buildSnapshotProcessingState({
  latestScanRaw = null,
  runMeta = null,
  lastProcessed = null
} = {}) {
  const latestScannerSnapshotId =
    extractSnapshotId(latestScanRaw);
  const activeTradeSnapshotId =
    extractSnapshotId(
      runMeta?.snapshotId ||
      runMeta?.activeSnapshotId ||
      runMeta?.processingSnapshotId ||
      runMeta?.snapshotCursor?.snapshotId ||
      runMeta?.cursor?.snapshotId ||
      runMeta?.snapshot
    );
  const lastProcessedSnapshotId =
    extractSnapshotId(lastProcessed);
  const latestCandidateCount =
    extractSnapshotCandidateCount(latestScanRaw);
  const rawChunkStart = firstFinite(
    runMeta?.snapshotChunkStart,
    runMeta?.chunkStart,
    runMeta?.snapshotCursorStart,
    runMeta?.snapshotCursor?.start,
    runMeta?.cursor?.start,
    0
  );
  const rawNextIndex = firstFinite(
    runMeta?.snapshotChunkNextIndex,
    runMeta?.nextCandidateIndex,
    runMeta?.snapshotCursorNextIndex,
    runMeta?.snapshotCursor?.nextIndex,
    runMeta?.cursor?.nextIndex,
    runMeta?.cursor?.index,
    rawChunkStart,
    0
  );
  const rawTotalCandidates = firstFinite(
    runMeta?.snapshotChunkTotalCandidates,
    runMeta?.totalCandidates,
    runMeta?.snapshotCandidateCount,
    runMeta?.snapshotCursor?.totalCandidates,
    runMeta?.cursor?.totalCandidates,
    latestCandidateCount
  );
  const snapshotChunkTotalCandidates =
    clampInteger(
      rawTotalCandidates,
      latestCandidateCount,
      0
    );
  const snapshotChunkStart =
    clampInteger(
      rawChunkStart,
      0,
      0,
      snapshotChunkTotalCandidates > 0
        ? snapshotChunkTotalCandidates
        : Number.MAX_SAFE_INTEGER
    );
  const snapshotChunkNextIndex =
    clampInteger(
      rawNextIndex,
      snapshotChunkStart,
      0,
      snapshotChunkTotalCandidates > 0
        ? snapshotChunkTotalCandidates
        : Number.MAX_SAFE_INTEGER
    );
  const explicitChunkComplete =
    booleanValue(
      firstValue(
        runMeta?.snapshotChunkComplete,
        runMeta?.snapshotComplete,
        runMeta?.cursorComplete,
        runMeta?.snapshotCursor?.complete,
        runMeta?.cursor?.complete
      ),
      false
    );
  const completeByIndex =
    snapshotChunkTotalCandidates > 0 &&
    snapshotChunkNextIndex >= snapshotChunkTotalCandidates;
  const completeByLastProcessed =
    Boolean(latestScannerSnapshotId) &&
    Boolean(lastProcessedSnapshotId) &&
    latestScannerSnapshotId === lastProcessedSnapshotId;
  const sameSnapshotActive =
    Boolean(latestScannerSnapshotId) &&
    Boolean(activeTradeSnapshotId) &&
    latestScannerSnapshotId === activeTradeSnapshotId;
  const snapshotChunkComplete =
    Boolean(
      completeByLastProcessed ||
      (
        sameSnapshotActive &&
        (
          explicitChunkComplete ||
          completeByIndex
        )
      )
    );
  const processingCurrentSnapshot =
    Boolean(
      sameSnapshotActive &&
      !snapshotChunkComplete &&
      snapshotChunkNextIndex > 0 &&
      (
        snapshotChunkTotalCandidates <= 0 ||
        snapshotChunkNextIndex < snapshotChunkTotalCandidates
      )
    );
  let scannerTradeStatus = 'BEHIND';
  if (snapshotChunkComplete) {
    scannerTradeStatus = 'COMPLETE';
  } else if (processingCurrentSnapshot) {
    scannerTradeStatus = 'PROCESSING';
  }
  const snapshotRemainingCandidates =
    snapshotChunkTotalCandidates > 0
      ? Math.max(
          0,
          snapshotChunkTotalCandidates -
          snapshotChunkNextIndex
        )
      : null;
  const snapshotProgressPct =
    snapshotChunkTotalCandidates > 0
      ? round(
          Math.min(
            100,
            Math.max(
              0,
              (
                snapshotChunkNextIndex /
                snapshotChunkTotalCandidates
              ) *
                100
            )
          ),
          2
        )
      : snapshotChunkComplete
        ? 100
        : 0;
  return {
    scannerTradeStatus,
    scannerAndTradeInSync:
      scannerTradeStatus === 'COMPLETE',
    latestScannerSnapshotId,
    activeTradeSnapshotId,
    lastProcessedSnapshotId,
    sameSnapshotActive,
    processingCurrentSnapshot,
    snapshotChunkStart,
    snapshotChunkNextIndex,
    snapshotChunkTotalCandidates,
    snapshotChunkComplete,
    snapshotProgressPct,
    snapshotRemainingCandidates,
    completeByLastProcessed,
    completeByIndex,
    explicitChunkComplete
  };
}

function normalizeAction(action = {}, currentMarketWeather = {}, helpers = {}) {
  const taxonomy = resolveTaxonomyIds(action);
  const weather = buildMarketWeatherFields(action, currentMarketWeather, helpers);

  const rawInferredTradeSide = inferTradeSide({
    ...action,
    ...taxonomy
  });

  const fit = getShortCurrentFit(action);

  const policy = inferPolicyBlocked({
    ...action,
    ...taxonomy,
    entry: action.entry ?? action.entryPrice,
    sl: action.sl ?? action.stopLoss,
    initialSl: action.initialSl ?? action.initialStopLoss ?? action.sl ?? action.stopLoss,
    tp: action.tp ?? action.takeProfit
  });

  const veto = inferEmpiricalVeto(action);

  const riskFractionForEntry = policy.policyBlocked || veto.empiricalVeto
    ? 0
    : num(action.riskFractionForEntry ?? action.riskFraction, 0);

  const signalType = deriveSignalType({
    ...action,
    ...weather,
    riskFractionForEntry,
    policyBlocked: policy.policyBlocked,
    empiricalVeto: veto.empiricalVeto,
    playbookFresh: action.playbookFresh === true
  });

  return {
    ...action,

    ...modeFlags(),
    ...taxonomy,
    ...weather,

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide,

    source: action.source || 'VIRTUAL',
    outcomeSource: action.outcomeSource || action.source || 'VIRTUAL',
    virtualOnly: action.virtualOnly !== false,
    virtualTracked: true,
    shadowOnly: Boolean(action.shadowOnly),
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    currentFit: fit.label,
    currentFitLabel: fit.label,
    currentFitScore: round(fit.score, 4),
    fitScore: round(fit.score, 4),
    shortCurrentFit: round(fit.score, 4),
    bearCurrentFit: round(fit.score, 4),
    bullishCurrentFit: round(-Math.abs(fit.score), 4),
    currentFitSource: fit.source,

    confluence: round(action.confluence, 4),
    sniperScore: round(action.sniperScore, 4),

    rr: round(action.rr, 4),
    spreadPct: round(action.spreadPct, 6),
    depthMinUsd1p: round(action.depthMinUsd1p, 2),

    policyBlocked: policy.policyBlocked,
    policyBlockedReason: policy.policyBlockedReason,
    inheritedPolicyBlockedIgnored: Boolean(policy.inheritedPolicyBlockedIgnored),
    inheritedPolicyBlockedReason: policy.inheritedPolicyBlockedReason || null,

    empiricalVeto: veto.empiricalVeto,
    empiricalVetoReason: veto.empiricalVetoReason,
    signalType,
    riskFractionForEntry,
    riskFraction: riskFractionForEntry,

    proofSource:
      action.proofSource ||
      (weather.entryMarketWeatherKnown ? 'MICRO_MICRO_MARKETWEATHER' : 'UNKNOWN_WEATHER'),
    proofTier: policy.policyBlocked
      ? PROOF_TIER_POLICY_BLOCKED
      : veto.empiricalVeto
        ? PROOF_TIER_EMPIRICAL_VETO
        : action.proofTier || PROOF_TIER_OBSERVATION_ONLY,

    liveEligible: false,
    riskValid: Boolean(action.riskValid || action.liveRiskValid),

    discordAlertEligible: Boolean(action.discordAlertEligible),
    selectedMicroFamilyAlert: false,
    selectedMicroMicroFamilyAlert: Boolean(action.selectedMicroMicroFamilyAlert || action.selectedMicroFamilyAlert),
    exactSelectedMicroMicroMatch: Boolean(action.exactSelectedMicroMicroMatch || action.selectedMicroMicroFamilyAlert),
    discordAlertSent: Boolean(action.discordAlertSent),
    discordEntryAlertSent: Boolean(action.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(action.discordExitAlertEligible),
    discordExitAlertSent: Boolean(action.discordExitAlertSent)
  };
}

function normalizeExit(row = {}, currentMarketWeather = {}, helpers = {}) {
  const action = normalizeAction(row, currentMarketWeather, helpers);

  const entry = num(row.entry ?? row.entryPrice, 0);
  const initialSl = num(row.initialSl ?? row.initialStopLoss ?? row.sl ?? row.stopLoss, 0);
  const exitPrice = num(row.exitPrice ?? row.currentPrice ?? row.lastPrice, 0);

  const grossR = hasValue(row.shortGrossR)
    ? num(row.shortGrossR, 0)
    : hasValue(row.grossR)
      ? num(row.grossR, 0)
      : calcGrossR({
          entry,
          initialSl,
          exitPrice,
          fallback: row.r
        });

  const costR = num(row.costR ?? row.totalCostR, 0);
  const netR = hasValue(row.shortNetR)
    ? num(row.shortNetR, 0)
    : hasValue(row.netR)
      ? num(row.netR, 0)
      : grossR - costR;

  return {
    ...action,

    action: 'VIRTUAL_EXIT',

    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: Boolean(row.shadowOnly),
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    grossR: round(grossR, 4),
    shortGrossR: round(grossR, 4),
    costR: round(costR, 4),
    avgCostR: round(row.avgCostR ?? costR, 4),
    netR: round(netR, 4),
    shortNetR: round(netR, 4),
    r: round(netR, 4),
    realizedR: round(row.realizedR ?? netR, 4),

    pnlPct: round(row.pnlPct ?? row.netPnlPct, 4),
    grossPnlPct: round(row.grossPnlPct, 4),
    totalCostR: round(row.totalCostR ?? costR, 4),

    exitPrice: round(exitPrice, 10),
    entry: round(entry, 10),
    initialSl: round(initialSl, 10),
    sl: round(row.sl ?? row.stopLoss, 10),
    tp: round(row.tp ?? row.takeProfit, 10),

    validShortGeometry: validShortRiskShape({
      entry,
      initialSl,
      sl: row.sl ?? row.stopLoss ?? initialSl,
      tp: row.tp ?? row.takeProfit
    }),

    exitReason: row.exitReason || row.reason || null,
    exitedAt: row.exitedAt || row.closedAt || row.ts || null,

    win: Boolean(row.win ?? netR > 0),
    loss: Boolean(row.loss ?? netR < 0),
    flat: Boolean(row.flat ?? netR === 0)
  };
}

function actionCounts(actions = []) {
  return actions.reduce((acc, action) => {
    const key = action.action || action.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function mergeActionCounts(...counts) {
  return counts.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row || {})) {
      acc[key] = num(acc[key], 0) + num(value, 0);
    }

    return acc;
  }, {});
}

function selectRunExitRows(runMeta = {}) {
  if (Array.isArray(runMeta.virtualExits)) return runMeta.virtualExits;
  if (Array.isArray(runMeta.shadowExits)) return runMeta.shadowExits;
  if (Array.isArray(runMeta.exits)) return runMeta.exits;
  if (Array.isArray(runMeta.closedPositions)) return runMeta.closedPositions;
  if (Array.isArray(runMeta.outcomes)) return runMeta.outcomes;

  return [];
}

function normalizeRunMeta(runMeta, currentMarketWeather = {}, helpers = {}) {
  if (!runMeta || typeof runMeta !== 'object') return null;

  const rawActionRows = asArray(runMeta.actions);
  const normalizedActions = rawActionRows.map((row) => normalizeAction(row, currentMarketWeather, helpers));

  const nonLongActions = normalizedActions
    .filter((row) => !isLongRow(row))
    .map(forceShortRow);

  const ignoredLongActions = normalizedActions.filter(isLongRow).length;
  const ignoredUnknownSideActions = normalizedActions.filter(isUnknownSideRow).length;

  const entryActions = nonLongActions.filter((action) => (
    action.action === 'VIRTUAL_ENTRY' ||
    action.action === 'ENTRY'
  ));

  const waitActions = nonLongActions.filter((action) => action.action === 'WAIT');

  const observationActions = nonLongActions.filter((action) => (
    action.action === 'OBSERVATION' ||
    action.observationWritten ||
    action.analysisInputOnly ||
    action.observationOnly
  ));

  const skippedActions = nonLongActions.filter((action) => (
    action.action === 'SKIP' ||
    action.skipped ||
    (
      action.reason &&
      action.action !== 'VIRTUAL_ENTRY' &&
      action.action !== 'ENTRY'
    )
  ));

  const runVirtualExitsRaw = selectRunExitRows(runMeta);
  const normalizedExitRows = runVirtualExitsRaw.map((row) => normalizeExit(row, currentMarketWeather, helpers));

  const virtualExits = normalizedExitRows
    .filter((row) => !isLongRow(row))
    .map(forceShortRow);

  const ignoredLongExitRows = normalizedExitRows.filter(isLongRow).length;
  const ignoredUnknownSideExitRows = normalizedExitRows.filter(isUnknownSideRow).length;

  const exitActionCounts = virtualExits.length
    ? { VIRTUAL_EXIT: virtualExits.length }
    : {};

  const normalizedActionCounts = mergeActionCounts(
    actionCounts(nonLongActions),
    exitActionCounts
  );

  const discordEntryAlerts = nonLongActions.filter((action) => (
    action.discordAlertEligible &&
    action.selectedMicroMicroFamilyAlert &&
    (
      action.discordEntryAlertSent ||
      action.discordAlertSent ||
      action.discordAlertQueued ||
      action.action === 'VIRTUAL_ENTRY' ||
      action.action === 'ENTRY'
    )
  ));

  const discordExitAlerts = virtualExits.filter((exit) => (
    exit.discordAlertEligible &&
    exit.selectedMicroMicroFamilyAlert &&
    (
      exit.discordExitAlertSent ||
      exit.discordAlertSent
    )
  ));

  return {
    ...runMeta,

    ...modeFlags(),

    ok: runMeta.ok !== false,
    runId: runMeta.runId || null,

    actions: nonLongActions,
    actionsCount: nonLongActions.length,

    virtualActions: nonLongActions,
    virtualActionsCount: nonLongActions.length,

    rawActionsCount: rawActionRows.length,

    ignoredLongActions,
    ignoredUnknownSideActions,

    actionCounts: normalizedActionCounts,
    rawActionCounts: runMeta.actionCounts || actionCounts(normalizedActions),

    entryRows: num(runMeta.entryRows ?? entryActions.length, entryActions.length),
    waitRows: num(runMeta.waitRows ?? waitActions.length, waitActions.length),
    virtualCreatedRows: num(
      runMeta.virtualCreatedRows ??
        runMeta.shadowCreatedRows ??
        entryActions.length,
      entryActions.length
    ),

    virtualSkippedRows: num(runMeta.virtualSkippedRows ?? runMeta.shadowSkippedRows, 0),
    virtualFailedRows: num(runMeta.virtualFailedRows ?? runMeta.shadowFailedRows, 0),

    entries: entryActions,
    entriesCount: entryActions.length,

    waits: waitActions,
    waitsCount: waitActions.length,

    observations: observationActions,
    observationsCount: observationActions.length,

    skippedActions,
    skippedActionsCount: skippedActions.length,

    virtualExits,
    virtualExitsCount: virtualExits.length,
    virtualExitRows: virtualExits.length,

    exits: virtualExits,
    exitsCount: virtualExits.length,

    realExits: [],
    realExitsCount: 0,

    shadowExits: virtualExits,
    shadowExitsCount: virtualExits.length,
    shadowExitRows: virtualExits.length,

    rawExitRowsCount: runVirtualExitsRaw.length,
    ignoredLongExitRows,
    ignoredUnknownSideExitRows,

    discordEntryAlerts: discordEntryAlerts.length,
    discordExitAlerts: discordExitAlerts.length,

    parentMicroFamiliesSeen: uniqueStrings(
      nonLongActions.map((action) => action.parentTrueMicroFamilyId)
    ).length,

    child75ContextFamiliesSeen: uniqueStrings(
      nonLongActions.map((action) => action.childTrueMicroFamilyId)
    ).length,

    microMicroFamiliesSeen: uniqueStrings(
      nonLongActions.map((action) => action.exactMicroMicroFamilyId || action.microMicroFamilyId)
    ).length,

    startedAt: runMeta.startedAt || null,
    completedAt: runMeta.completedAt || null,
    durationMs: runMeta.durationMs ?? null,

    snapshotId:
      runMeta.snapshotId ||
      runMeta.activeSnapshotId ||
      runMeta.processingSnapshotId ||
      runMeta.snapshotCursor?.snapshotId ||
      runMeta.cursor?.snapshotId ||
      null,
    snapshotAgeSec:
      runMeta.snapshotAgeSec ??
      null,
    snapshotChunkStart: clampInteger(
      firstFinite(
        runMeta.snapshotChunkStart,
        runMeta.chunkStart,
        runMeta.snapshotCursorStart,
        runMeta.snapshotCursor?.start,
        runMeta.cursor?.start,
        0
      ),
      0,
      0
    ),
    snapshotChunkNextIndex: clampInteger(
      firstFinite(
        runMeta.snapshotChunkNextIndex,
        runMeta.nextCandidateIndex,
        runMeta.snapshotCursorNextIndex,
        runMeta.snapshotCursor?.nextIndex,
        runMeta.cursor?.nextIndex,
        runMeta.cursor?.index,
        0
      ),
      0,
      0
    ),
    snapshotChunkTotalCandidates: clampInteger(
      firstFinite(
        runMeta.snapshotChunkTotalCandidates,
        runMeta.totalCandidates,
        runMeta.snapshotCandidateCount,
        runMeta.snapshotCursor?.totalCandidates,
        runMeta.cursor?.totalCandidates,
        0
      ),
      0,
      0
    ),
    snapshotChunkComplete: booleanValue(
      firstValue(
        runMeta.snapshotChunkComplete,
        runMeta.snapshotComplete,
        runMeta.cursorComplete,
        runMeta.snapshotCursor?.complete,
        runMeta.cursor?.complete
      ),
      false
    ),
    skippedNewEntries:
      Boolean(runMeta.skippedNewEntries),
    skipReason:
      runMeta.skipReason ||
      runMeta.reason ||
      null,
    reason:
      runMeta.reason ||
      runMeta.skipReason ||
      null
  };
}

function rowsFromRotation(rotation = {}) {
  return Array.isArray(rotation.microFamilies) ? rotation.microFamilies : [];
}

function idsFromRotation(rotation = {}, currentMarketWeather = {}, helpers = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const rowIds = rows
    .map((row) => getExplicitMicroMicroId(row))
    .filter(Boolean);

  const explicitIds = uniqueStrings([
    rotation.microMicroFamilyIds,
    rotation.trueMicroMicroFamilyIds,
    rotation.exactMicroMicroFamilyIds,
    rotation.activeMicroMicroFamilyIds,
    rotation.activeTrueMicroMicroFamilyIds,
    rotation.activeExactMicroMicroFamilyIds,
    rotation.selectedMicroMicroFamilyIds,
    rotation.selectedTrueMicroMicroFamilyIds,
    rotation.selectedExactMicroMicroFamilyIds,
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids
  ])
    .map((id) => getExplicitMicroMicroId(id) || parseShortTaxonomyMicroId(id).microMicroFamilyId)
    .filter(Boolean);

  const microMicroFamilyIds = uniqueStrings([rowIds, explicitIds])
    .filter(isSelectableMicroMicroId);

  const shortRows = rows
    .map((row) => normalizeAction(row, currentMarketWeather, helpers))
    .filter((row) => !isLongRow(row))
    .filter((row) => microMicroFamilyIds.includes(row.exactMicroMicroFamilyId || row.microMicroFamilyId));

  const childTrueMicroFamilyIds = uniqueStrings(
    microMicroFamilyIds.map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
  ).filter(Boolean);

  const parentTrueMicroFamilyIds = uniqueStrings(
    microMicroFamilyIds.map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
  ).filter(Boolean);

  return {
    microMicroFamilyIds,
    childTrueMicroFamilyIds,
    parentTrueMicroFamilyIds,
    shortRows
  };
}

function normalizeActiveRotation(activeRotation, currentMarketWeather = {}, helpers = {}) {
  if (!activeRotation || typeof activeRotation !== 'object') {
    return {
      ...modeFlags(),

      rotationId: null,
      activeMicroFamilyIds: [],
      activeMicroMicroFamilyIds: [],
      activeTrueMicroMicroFamilyIds: [],
      activeExactMicroMicroFamilyIds: [],
      selectedMicroMicroFamilyIds: [],
      childTrueMicroFamilyIds: [],
      parentTrueMicroFamilyIds: [],
      activeMicroMicroCount: 0,
      activeMicroCount: 0,
      activeMacroCount: 0,
      microFamilies: [],

      manualSelectionActive: false,
      discordAlertsEnabled: false,

      bestShort: null,
      bestLong: null,
      raw: null
    };
  }

  const ids = idsFromRotation(activeRotation, currentMarketWeather, helpers);
  const manualSelectionActive = ids.microMicroFamilyIds.length > 0;

  return {
    ...modeFlags(),

    rotationId: activeRotation.rotationId || null,

    activeMicroFamilyIds: ids.microMicroFamilyIds,
    activeMicroMicroFamilyIds: ids.microMicroFamilyIds,
    activeTrueMicroMicroFamilyIds: ids.microMicroFamilyIds,
    activeExactMicroMicroFamilyIds: ids.microMicroFamilyIds,
    selectedMicroMicroFamilyIds: ids.microMicroFamilyIds,

    microFamilyIds: ids.microMicroFamilyIds,
    trueMicroFamilyIds: ids.microMicroFamilyIds,
    microMicroFamilyIds: ids.microMicroFamilyIds,
    trueMicroMicroFamilyIds: ids.microMicroFamilyIds,
    exactMicroMicroFamilyIds: ids.microMicroFamilyIds,

    childTrueMicroFamilyIds: ids.childTrueMicroFamilyIds,
    parentTrueMicroFamilyIds: ids.parentTrueMicroFamilyIds,

    activeMicroMicroCount: ids.microMicroFamilyIds.length,
    activeMicroCount: ids.microMicroFamilyIds.length,
    activeMacroCount: ids.parentTrueMicroFamilyIds.length,

    sourceWeekKey: activeRotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: activeRotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
    mode: activeRotation.mode || null,
    source: activeRotation.source || null,

    manualSelectionActive,
    discordAlertsEnabled: manualSelectionActive,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactMicroMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
    usedRawFallback: Boolean(activeRotation.usedRawFallback),
    usedPreviousWeekMerge: Boolean(activeRotation.usedPreviousWeekMerge),

    microFamilies: ids.shortRows,
    bestShort: ids.shortRows[0] || null,
    bestLong: null,

    rawRowsCount: rowsFromRotation(activeRotation).length,

    raw: {
      ...activeRotation,

      ...modeFlags(),

      microFamilies: ids.shortRows,
      microFamilyIds: ids.microMicroFamilyIds,
      activeMicroFamilyIds: ids.microMicroFamilyIds,
      trueMicroFamilyIds: ids.microMicroFamilyIds,
      microMicroFamilyIds: ids.microMicroFamilyIds,
      activeMicroMicroFamilyIds: ids.microMicroFamilyIds,
      activeTrueMicroMicroFamilyIds: ids.microMicroFamilyIds,
      activeExactMicroMicroFamilyIds: ids.microMicroFamilyIds,
      selectedMicroMicroFamilyIds: ids.microMicroFamilyIds,
      childTrueMicroFamilyIds: ids.childTrueMicroFamilyIds,
      parentTrueMicroFamilyIds: ids.parentTrueMicroFamilyIds,
      bestShort: ids.shortRows[0] || null,
      bestLong: null
    }
  };
}

function buildRotationMatchStats(positions = [], activeRotationMeta = {}) {
  const activeMicroMicroSet = new Set(activeRotationMeta.activeMicroMicroFamilyIds || []);

  const selectedMicroMicroPositions = positions.filter((position) => {
    const id = position.exactMicroMicroFamilyId || position.trueMicroMicroFamilyId || position.microMicroFamilyId;
    return id && activeMicroMicroSet.has(id);
  });

  const silentLearningPositions = positions.filter((position) => {
    const id = position.exactMicroMicroFamilyId || position.trueMicroMicroFamilyId || position.microMicroFamilyId;
    return !id || !activeMicroMicroSet.has(id);
  });

  return {
    ...modeFlags(),

    manualSelectionActive: activeMicroMicroSet.size > 0,
    discordAlertsEnabled: activeMicroMicroSet.size > 0,

    selectedMicroMicroPositions: selectedMicroMicroPositions.length,
    selectedMicroPositions: selectedMicroMicroPositions.length,
    selectedMacroPositions: 0,

    discordEligiblePositions: selectedMicroMicroPositions.length,
    silentLearningPositions: silentLearningPositions.length,

    silentLearningSymbols: silentLearningPositions
      .map((position) => position.symbol)
      .filter(Boolean),

    activeMicroMicroFamilyIds: [...activeMicroMicroSet],
    activeMicroFamilyIds: [...activeMicroMicroSet],
    activeMacroFamilyIds: activeRotationMeta.parentTrueMicroFamilyIds || [],

    selectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    child75MatchDoesNotTriggerDiscord: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true
  };
}

function normalizeLatestScan(latestScan, currentMarketWeather = {}, helpers = {}) {
  if (!latestScan || typeof latestScan !== 'object') return latestScan;

  const candidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const normalized = candidates.map((row) => normalizeAction(row, currentMarketWeather, helpers));
  const shortCandidates = normalized
    .filter((row) => !isLongRow(row))
    .map(forceShortRow);

  const longCandidates = normalized.filter(isLongRow);
  const unknownSideCandidates = normalized.filter(isUnknownSideRow);

  const weather = buildMarketWeatherFields(latestScan, currentMarketWeather, helpers);

  return {
    ...latestScan,

    ...modeFlags(),
    ...weather,

    candidates: shortCandidates,
    candidatesCount: shortCandidates.length,
    shortCandidatesCount: shortCandidates.length,
    longCandidatesCount: longCandidates.length,
    rawCandidatesCount: candidates.length,

    ignoredLongCandidates: longCandidates.length,
    ignoredUnknownSideCandidates: unknownSideCandidates.length
  };
}

function buildSummary({
  positions = [],
  runMeta = null,
  activeRotation = null,
  snapshotProcessingState = null
} = {}) {
  const state =
    snapshotProcessingState ||
    buildSnapshotProcessingState({
      latestScanRaw: null,
      runMeta,
      lastProcessed: null
    });
  return {
    ...modeFlags(),
    openVirtualPositions: positions.length,
    virtualEntriesLastRun: num(
      runMeta?.entryRows ??
      runMeta?.entriesCount,
      0
    ),
    virtualExitsLastRun: num(
      runMeta?.virtualExitsCount,
      0
    ),
    shadowExitsLastRun: num(
      runMeta?.shadowExitsCount,
      0
    ),
    observationsLastRun: num(
      runMeta?.observationsCount,
      0
    ),
    skippedActionsLastRun: num(
      runMeta?.skippedActionsCount,
      0
    ),
    waitRowsLastRun: num(
      runMeta?.waitRows ??
      runMeta?.waitsCount,
      0
    ),
    actionCountsLastRun:
      runMeta?.actionCounts ||
      {},
    exitReadyNow:
      positions.filter(
        (position) =>
          position.exitReadyNow
      ).length,
    tpHitNow:
      positions.filter(
        (position) =>
          position.tpHitNow
      ).length,
    slHitNow:
      positions.filter(
        (position) =>
          position.slHitNow
      ).length,
    timeStopHitNow:
      positions.filter(
        (position) =>
          position.timeStopHitNow
      ).length,
    tradeReadyPositions:
      positions.filter(
        (position) =>
          position.signalType ===
          SIGNAL_TYPE_TRADE_READY
      ).length,
    watchPositions:
      positions.filter(
        (position) =>
          position.signalType ===
          SIGNAL_TYPE_WATCH_ONLY
      ).length,
    observeOnlyPositions:
      positions.filter(
        (position) =>
          position.signalType ===
          SIGNAL_TYPE_OBSERVE_ONLY
      ).length,
    blockedPositions:
      positions.filter(
        (position) =>
          position.signalType ===
          SIGNAL_TYPE_BLOCKED
      ).length,
    unknownWeatherPositions:
      positions.filter(
        (position) =>
          position.entryMarketWeatherKey ===
          'UNKNOWN|UNKNOWN'
      ).length,
    activeMicroMicroFamilies:
      num(
        activeRotation?.activeMicroMicroCount,
        0
      ),
    activeMicroFamilies:
      num(
        activeRotation?.activeMicroCount,
        0
      ),
    activeMacroFamilies:
      num(
        activeRotation?.activeMacroCount,
        0
      ),
    manualSelectionActive:
      Boolean(
        activeRotation?.manualSelectionActive
      ),
    discordAlertsEnabled:
      Boolean(
        activeRotation?.discordAlertsEnabled
      ),
    scannerTradeStatus:
      state.scannerTradeStatus,
    scannerAndTradeInSync:
      state.scannerAndTradeInSync,
    latestScannerSnapshotId:
      state.latestScannerSnapshotId,
    activeTradeSnapshotId:
      state.activeTradeSnapshotId,
    lastProcessedSnapshotId:
      state.lastProcessedSnapshotId,
    snapshotChunkStart:
      state.snapshotChunkStart,
    snapshotChunkNextIndex:
      state.snapshotChunkNextIndex,
    snapshotChunkTotalCandidates:
      state.snapshotChunkTotalCandidates,
    snapshotChunkComplete:
      state.snapshotChunkComplete,
    snapshotProgressPct:
      state.snapshotProgressPct,
    snapshotRemainingCandidates:
      state.snapshotRemainingCandidates
  };
}

async function getShortOpenPositionsSafe() {
  if (typeof PositionEngine.getOpenPositions !== 'function') return [];

  try {
    const positions = await PositionEngine.getOpenPositions({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      virtualOnly: true
    });

    return asArray(positions);
  } catch {
    return [];
  }
}

async function getActiveRotationSafe({ durable, volatile } = {}) {
  try {
    const module = await import('../../src/analyze/rotationEngine.js');

    if (typeof module.getActiveRotation === 'function') {
      const rotation = await module.getActiveRotation({
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        weekKey: PERSISTENT_LEARNING_KEY,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        microMicroOnly: true,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
      });

      if (rotation) return rotation;
    }
  } catch {
    // fallback below
  }

  for (const key of [
    SHORT_KEYS.rotation.active,
    SHORT_KEYS.rotation.dashboard,
    `${SHORT_KEY_PREFIX}ROTATION:ACTIVE`,
    `${SHORT_KEY_PREFIX}ROTATION:DASHBOARD`,
    `${SHORT_KEY_PREFIX}DISCORD:SELECTION`,
    `${SHORT_KEY_PREFIX}MANUAL:SELECTION`
  ]) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (read.value) return read.value;
  }

  return null;
}

function buildErrorPayload(error, extra = {}) {
  return {
    ok: false,
    degraded: true,
    ...modeFlags(),

    currentMarketWeather: extra.currentMarketWeather || marketWeatherFromPayload({}),
    confirmedMarketWeatherKey: extra.currentMarketWeather?.confirmedMarketWeatherKey || 'UNKNOWN|UNKNOWN',
    confirmedMarketWeatherKnown: Boolean(extra.currentMarketWeather?.confirmedMarketWeatherKnown),

    positions: [],
    openPositions: [],
    virtualPositions: [],
    openVirtualPositions: 0,
    positionsCount: 0,
    rawPositionsCount: 0,

    stats: buildPositionStats([], {}),
    rotationMatchStats: buildRotationMatchStats([], normalizeActiveRotation(null)),
    summary: buildSummary({}),

    runMeta: null,
    lastRunMeta: null,

    lastProcessed: normalizeLastProcessed(null),
    lastProcessedSnapshotId: null,

    latestScan: null,
    latestScannerSnapshotId: null,
    activeTradeSnapshotId: null,
    scannerTradeStatus: 'BEHIND',
    scannerAndTradeInSync: false,
    snapshotChunkStart: 0,
    snapshotChunkNextIndex: 0,
    snapshotChunkTotalCandidates: 0,
    snapshotChunkComplete: false,
    snapshotProgressPct: 0,
    snapshotRemainingCandidates: null,

    activeRotation: normalizeActiveRotation(null),
    activeRotationId: null,
    activeMicroFamilyIds: [],
    activeMicroMicroFamilyIds: [],
    selectedMicroMicroFamilyIds: [],

    warnings: ['ADMIN_TRADE_DEGRADED_RESPONSE_INSTEAD_OF_HTTP_500'],

    error: error?.message || String(error),
    stack: process.env.NODE_ENV === 'production'
      ? undefined
      : error?.stack,

    serverTs: Date.now()
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Trade-Mode', 'short-only-marketweather-micro-micro-v2-500-safe');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-No-Real-Orders', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Exact-Micro-Micro-Only', 'true');
  res.setHeader('X-Market-Weather-Key-Version', MARKET_WEATHER_KEY_VERSION);
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Exact-True-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ID_ONLY');
  res.setHeader('X-Admin-Read-Only', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-Http-500-Guard', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  let currentMarketWeather = marketWeatherFromPayload({});

  try {
    const durable = getDurableRedisSafe();
    const volatile = getVolatileRedisSafe();
    const marketKeyHelpers = await importMarketKeyHelpers();

    const queryWeather = marketWeatherFromQuery(req);
    const storedWeather = await readStoredMarketWeather({ durable, volatile });

    currentMarketWeather = chooseCurrentMarketWeather({
      queryWeather,
      storedWeather
    });

    const [
      rawPositionsRead,
      runMetaRead,
      lastProcessedRead,
      latestScanRead,
      activeRotationRead
    ] = await Promise.all([
      safeRead(
        'openPositions',
        () => getShortOpenPositionsSafe(),
        []
      ),
      safeRead(
        'tradeRunMeta',
        () => readTradeRunMetaFromStores({
          durable,
          volatile
        }),
        {
          value: null,
          source: null,
          key: SHORT_KEYS.trade.runMeta,
          legacyFallbackUsed: false
        }
      ),
      safeRead(
        'lastProcessedSnapshot',
        () => readJsonFromStores({
          durable,
          volatile,
          key: SHORT_KEYS.trade.lastProcessedSnapshot,
          fallback: null
        }).then((row) => row.value),
        null
      ),
      safeRead(
        'latestScan',
        () => readJsonFromStores({
          durable,
          volatile,
          key: SHORT_KEYS.scan.latest,
          fallback: null
        }).then((row) => row.value),
        null
      ),
      safeRead(
        'activeRotation',
        () => getActiveRotationSafe({ durable, volatile }),
        null
      )
    ]);

    const rawRunMeta =
      runMetaRead.value?.value ??
      runMetaRead.value ??
      null;
    const runMeta = normalizeRunMeta(
      rawRunMeta,
      currentMarketWeather,
      marketKeyHelpers
    );

    const allPositions = asArray(rawPositionsRead.value)
      .map((position) => normalizePosition({
        ...currentMarketWeather,
        ...position,
        currentMarketWeatherKey:
          position?.currentMarketWeatherKey ||
          currentMarketWeather.currentMarketWeatherKey,
        currentMarketWeatherRegime:
          position?.currentMarketWeatherRegime ||
          currentMarketWeather.currentMarketWeatherRegime,
        currentMarketWeatherTrendSide:
          position?.currentMarketWeatherTrendSide ||
          currentMarketWeather.currentMarketWeatherTrendSide
      }, currentMarketWeather, marketKeyHelpers));

    const positions = allPositions
      .filter((position) => !isLongRow(position))
      .map(forceShortRow);

    const ignoredLongPositions = allPositions.filter(isLongRow).length;
    const ignoredUnknownSidePositions = allPositions.filter(isUnknownSideRow).length;

    const stats = buildPositionStats(positions, {
      rawOpenPositions: allPositions.length,
      ignoredLongPositions,
      ignoredUnknownSidePositions
    });

    const lastProcessed = normalizeLastProcessed(lastProcessedRead.value);

    const latestScan = normalizeLatestScan(
      {
        ...currentMarketWeather,
        ...(latestScanRead.value || {})
      },
      currentMarketWeather,
      marketKeyHelpers
    );

    const snapshotProcessingState =
      buildSnapshotProcessingState({
        latestScanRaw:
          latestScanRead.value,
        runMeta,
        lastProcessed:
          lastProcessedRead.value
      });
    const {
      latestScannerSnapshotId,
      activeTradeSnapshotId,
      lastProcessedSnapshotId,
      scannerTradeStatus,
      scannerAndTradeInSync,
      snapshotChunkStart,
      snapshotChunkNextIndex,
      snapshotChunkTotalCandidates,
      snapshotChunkComplete,
      snapshotProgressPct,
      snapshotRemainingCandidates
    } = snapshotProcessingState;

    const activeRotation = normalizeActiveRotation(
      activeRotationRead.value,
      currentMarketWeather,
      marketKeyHelpers
    );

    const rotationMatchStats = buildRotationMatchStats(
      positions,
      activeRotation
    );

    const summary = buildSummary({
      positions,
      runMeta,
      activeRotation,
      snapshotProcessingState
    });

    const readWarnings = [
      rawPositionsRead,
      runMetaRead,
      lastProcessedRead,
      latestScanRead,
      activeRotationRead
    ]
      .filter((row) => !row.ok)
      .map((row) => `${row.label}:${row.error}`);

    const warnings = uniqueStrings([
      readWarnings,
      scannerTradeStatus === 'PROCESSING'
        ? `SCANNER_SNAPSHOT_PROCESSING:${snapshotChunkNextIndex}/${snapshotChunkTotalCandidates}`
        : null,
      scannerTradeStatus === 'BEHIND'
        ? 'TRADE_SYSTEM_BEHIND_LATEST_SCANNER_SNAPSHOT'
        : null,
      runMetaRead.value?.legacyFallbackUsed === true
        ? 'LEGACY_TRADE_RUN_META_KEY_USED'
        : null,
      activeRotation.activeMicroMicroCount <= 0
        ? 'NO_MANUAL_MICRO_MICRO_SELECTION_ACTIVE_DISCORD_DISABLED'
        : null,
      ignoredLongPositions > 0
        ? `LONG_POSITIONS_IGNORED:${ignoredLongPositions}`
        : null,
      ignoredUnknownSidePositions > 0
        ? `UNKNOWN_SIDE_POSITIONS_TREATED_AS_SHORT_ADMIN_VIEW:${ignoredUnknownSidePositions}`
        : null,
      stats.unknownWeatherPositions > 0
        ? `UNKNOWN_WEATHER_POSITIONS_OBSERVE_ONLY:${stats.unknownWeatherPositions}`
        : null,
      runMeta?.ignoredLongActions > 0
        ? `LONG_ACTIONS_IGNORED:${runMeta.ignoredLongActions}`
        : null,
      runMeta?.ignoredUnknownSideActions > 0
        ? `UNKNOWN_SIDE_ACTIONS_TREATED_AS_SHORT_ADMIN_VIEW:${runMeta.ignoredUnknownSideActions}`
        : null,
      runMeta?.ignoredLongExitRows > 0
        ? `LONG_EXIT_ROWS_IGNORED:${runMeta.ignoredLongExitRows}`
        : null,
      runMeta?.ignoredUnknownSideExitRows > 0
        ? `UNKNOWN_SIDE_EXIT_ROWS_TREATED_AS_SHORT_ADMIN_VIEW:${runMeta.ignoredUnknownSideExitRows}`
        : null,
      stats.invalidShortRiskShapePositions > 0
        ? `INVALID_SHORT_RISK_SHAPE_POSITIONS:${stats.invalidShortRiskShapePositions}`
        : null,
      stats.exitReadyNow > 0
        ? `SHORT_POSITIONS_READY_TO_CLOSE_ON_NEXT_TRADE_RUN:${stats.exitReadyNow}`
        : null,
      !marketKeyHelpers.importOk
        ? 'MARKET_KEY_HELPERS_FALLBACK_USED'
        : null,
      !currentMarketWeather.confirmedMarketWeatherKnown
        ? 'MARKET_WEATHER_UNKNOWN_TRADE_READY_DISABLED'
        : null
    ].filter(Boolean));

    return res.status(200).json({
      ok: true,

      ...modeFlags(),

      marketKeyImportOk: marketKeyHelpers.importOk,
      marketKeyImportError: marketKeyHelpers.importError || null,

      currentMarketWeather,
      confirmedMarketWeatherKey: currentMarketWeather.confirmedMarketWeatherKey,
      confirmedMarketWeatherRegime: currentMarketWeather.confirmedMarketWeatherRegime,
      confirmedMarketWeatherTrendSide: currentMarketWeather.confirmedMarketWeatherTrendSide,
      confirmedMarketWeatherKnown: currentMarketWeather.confirmedMarketWeatherKnown,

      unknownWeatherPolicy: {
        key: 'UNKNOWN|UNKNOWN',
        signalType: SIGNAL_TYPE_OBSERVE_ONLY,
        riskFractionForEntry: 0,
        reason: 'MARKET_WEATHER_UNKNOWN',
        learningAllowed: true,
        discordAllowed: false,
        tradeReadyAllowed: false
      },

      playbookPolicy: {
        maxAgeMin: PLAYBOOK_MAX_AGE_MIN,
        freshRequiredForTradeReady: true,
        missingReason: 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER',
        selectorMode: 'observe'
      },

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        tradeRunMeta:
          SHORT_KEYS.trade.runMeta,
        legacyTradeRunMeta:
          LEGACY_SHORT_KEYS.tradeRunMeta,
        tradeRunMetaReadKey:
          runMetaRead.value?.key ||
          SHORT_KEYS.trade.runMeta,
        tradeRunMetaReadSource:
          runMetaRead.value?.source ||
          null,
        legacyTradeRunMetaFallbackUsed:
          Boolean(
            runMetaRead.value?.legacyFallbackUsed
          ),
        tradeLastProcessedSnapshot:
          SHORT_KEYS.trade.lastProcessedSnapshot,
        scanLatest:
          SHORT_KEYS.scan.latest,
        rotationActive:
          SHORT_KEYS.rotation.active,
        rotationDashboard:
          SHORT_KEYS.rotation.dashboard
      },

      positions,
      openPositions: positions,
      virtualPositions: positions,
      openVirtualPositions: positions.length,

      positionsCount: positions.length,
      rawPositionsCount: allPositions.length,
      ignoredLongPositions,
      ignoredUnknownSidePositions,

      stats,
      rotationMatchStats,
      summary,

      runMeta,
      lastRunMeta: runMeta
        ? {
            runId: runMeta.runId || null,
            shadowExits: runMeta.shadowExits || [],
            virtualExits: runMeta.virtualExits || [],
            actionCounts: runMeta.actionCounts || {},
            skipReason: runMeta.skipReason || runMeta.reason || null,
            entryRows: runMeta.entryRows,
            waitRows: runMeta.waitRows,
            virtualCreatedRows: runMeta.virtualCreatedRows,
            snapshotId:
              runMeta.snapshotId ||
              null,
            snapshotChunkStart,
            snapshotChunkNextIndex,
            snapshotChunkTotalCandidates,
            snapshotChunkComplete,
            snapshotProgressPct,
            snapshotRemainingCandidates,
            scannerTradeStatus,
            marketWeatherRows: {
              unknownWeatherActions: (runMeta.actions || []).filter((row) => row.entryMarketWeatherKey === 'UNKNOWN|UNKNOWN').length,
              tradeReadyActions: (runMeta.actions || []).filter((row) => row.signalType === SIGNAL_TYPE_TRADE_READY).length,
              watchActions: (runMeta.actions || []).filter((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY).length,
              observeActions: (runMeta.actions || []).filter((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY).length,
              blockedActions: (runMeta.actions || []).filter((row) => row.signalType === SIGNAL_TYPE_BLOCKED).length
            }
          }
        : null,

      lastProcessed,
      lastProcessedSnapshotId,

      latestScan,
      latestScannerSnapshotId,
      activeTradeSnapshotId,
      scannerTradeStatus,
      scannerAndTradeInSync,
      snapshotChunkStart,
      snapshotChunkNextIndex,
      snapshotChunkTotalCandidates,
      snapshotChunkComplete,
      snapshotProgressPct,
      snapshotRemainingCandidates,
      snapshotProcessingState,

      activeRotationId: activeRotation.rotationId,
      activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
      activeMicroMicroFamilyIds: activeRotation.activeMicroMicroFamilyIds,
      activeTrueMicroMicroFamilyIds: activeRotation.activeTrueMicroMicroFamilyIds,
      activeExactMicroMicroFamilyIds: activeRotation.activeExactMicroMicroFamilyIds,
      selectedMicroMicroFamilyIds: activeRotation.selectedMicroMicroFamilyIds,
      activeMacroFamilyIds: activeRotation.parentTrueMicroFamilyIds || [],
      activeMicroCount: activeRotation.activeMicroCount,
      activeMicroMicroCount: activeRotation.activeMicroMicroCount,
      activeMacroCount: activeRotation.activeMacroCount,
      activeRotation,

      debugFields: {
        shortPositionExitChecks: [
          'currentPrice',
          'lastPrice',
          'entry',
          'sl',
          'initialSl',
          'tp',
          'ageSec',
          'currentR',
          'shortCurrentR',
          'mfeR',
          'maeR',
          'reachedHalfR',
          'reachedOneR',
          'nearTpSeen',
          'tpHitNow',
          'slHitNow',
          'timeStopHitNow',
          'exitReadyNow',
          'exitReasonNow',
          'entryMarketWeatherKey',
          'currentMarketWeatherKey',
          'signalType',
          'riskFractionForEntry',
          'empiricalVeto',
          'policyBlocked',
          'discordExitAlertEligible',
          'discordExitAlertSent',
          'realOrdersDisabled',
          'bitgetOrdersDisabled'
        ],
        shortExitRules: {
          validRiskShape: 'entry > 0 && tp < entry && sl > entry',
          tp: 'currentPrice <= tp',
          sl: 'currentPrice >= sl',
          timeStop: `ageSec >= ${getPositionTimeStopMin() * 60}`,
          grossR: '(entry - exitPrice) / (initialSl - entry)',
          currentR: '(entry - currentPrice) / (initialSl - entry)',
          outcomeSource: 'VIRTUAL'
        },
        marketWeatherRules: {
          entryWeatherImmutable: true,
          familyIdDoesNotContainWeather: true,
          keyFormat: 'REGIME|TRENDSIDE',
          unknownWeather: 'OBSERVE_ONLY + risk 0',
          playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN
        },
        microFamilyRules: {
          parent15: 'MICRO_SHORT_{SETUP}_{REGIME}',
          child75Context: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
          selectableMicroMicro: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
          discordMatch: 'exact selected micro-micro ID only',
          scannerBuckets: 'metadata only',
          executionFingerprints: 'metadata/hash source only'
        },
        runMetaExitFields: [
          'virtualExits',
          'shadowExits',
          'virtualExitsCount',
          'shadowExitsCount',
          'actionCounts'
        ]
      },

      warnings,

      error: null,
      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(200).json(buildErrorPayload(error, { currentMarketWeather }));
  }
}