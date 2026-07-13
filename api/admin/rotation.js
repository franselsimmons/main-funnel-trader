// ================= FILE: api/admin/rotation.js =================

import { safeNumber, sideToTradeSide } from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import {
  activateSelectedMicroFamilies,
  getActiveRotation,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING = 35;
const MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES = 2;

const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const TRUE_MICRO_SCHEMA = CHILD_TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const MICRO_MICRO_MARKER = '_MM_';
const MICRO_MICRO_HASH_LEN = 10;

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V4_NETR_SOURCE_OF_TRUTH';
const POSITION_COST_MODEL_VERSION =
  'POSITION_ENGINE_SHORT_NET_COST_V17_MARKET_WEATHER_EMPIRICAL_VETO_NETR_SOURCE_OF_TRUTH';
const MEASUREMENT_FIX_VERSION =
  'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V4_ROTATION_NETR_SAFE';
const OBSERVATION_DEDUPE_VERSION =
  'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V5_MARKET_WEATHER';
const OUTCOME_DEDUPE_VERSION =
  'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V10_MARKET_WEATHER_NETR_SOURCE_OF_TRUTH';
const ADAPTIVE_UI_VERSION =
  'SHORT_ADAPTIVE_UI_ROTATION_V6_LIGHTWEIGHT_IMMUTABLE_ENTRY_NETR_GEOMETRY_SAFE';

const MICRO_MICRO_VERSION =
  'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V5_ROTATION_LIGHTWEIGHT_NETR';

const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_GATE_V7_ROTATION_LIGHTWEIGHT_NETR_GEOMETRY_SAFE';

const MICRO_MICRO_BEST_SELECTOR_VERSION =
  'SHORT_MM_BEST_SELECTOR_V4_CURRENT_MARKET_NETR_LIGHTWEIGHT';

const DISCORD_ACTIVATION_GATE_VERSION =
  'SHORT_MM_DISCORD_ACTIVATION_GATE_V8_ROTATION_LIGHTWEIGHT_NETR_GEOMETRY_SAFE';

const ACTIVE_ROTATION_RUNTIME_GATE_VERSION =
  'SHORT_ACTIVE_ROTATION_RUNTIME_GATE_V5_LIGHTWEIGHT_NETR_GEOMETRY_SAFE';

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_SELECTOR_VERSION =
  'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V5_ROTATION_ENTRY_IMMUTABLE';
const MARKET_WEATHER_AGGREGATION_VERSION =
  'SHORT_MARKET_WEATHER_AGGREGATION_V3_NETR_SOURCE_OF_TRUTH';
const MARKET_WEATHER_FDR_VERSION =
  'SHORT_MARKET_WEATHER_PLAYBOOK_FDR_FINAL_SLOTS_V1_OBSERVE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V5_ROTATION_LIGHTWEIGHT_IMMUTABLE_ENTRY';

const EMPIRICAL_VETO_VERSION =
  'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V3_NETR_SOURCE_OF_TRUTH';

const PLAYBOOK_MAX_AGE_MIN = 240;

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_MICRO_MICRO_MARKET = 'MICRO_MICRO_MARKET_PROOF';
const PROOF_TIER_MICRO_MICRO_LIFETIME = 'MICRO_MICRO_LIFETIME_PROOF';
const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MAX_ALLOWED_RISK_BAND_HIGH = 'HIGH';
const MAX_ALLOWED_RISK_BAND_ZERO = 'ZERO';

const STATUS_PASSED = 'PASSED';
const STATUS_OBSERVING = 'OBSERVING';
const STATUS_REJECTED = 'REJECTED';
const STATUS_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const STATUS_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MIN_DISCORD_ACTIVATION_COMPLETED = 35;
const MIN_DISCORD_ACTIVATION_AVG_R = 0;
const MIN_DISCORD_ACTIVATION_TOTAL_R = 0;
const MIN_DISCORD_ACTIVATION_PROFIT_FACTOR = 1;
const MIN_DISCORD_ACTIVATION_LCB95_AVG_R = 0;
const MAX_DISCORD_ACTIVATION_AVG_COST_R = 0.35;
const MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT = 0.25;

const BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION = true;
const BLOCK_INVALID_GEOMETRY_FOR_DISCORD_ACTIVATION = true;

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

const ALLOWED_ACTIONS = Object.freeze([
  'activateSelected',
  'activateSelectedMicroFamilies'
]);

const BLOCKED_AUTO_ACTIONS = new Set([
  'activateSelectedMacroFamilies',
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestShortMicroFamily',
  'activateBestLongMicroFamily',
  'activateBestBearMicroFamily',
  'activateBestBullMicroFamily',
  'activateBestLong',
  'activateLong',
  'activateBestShort',
  'activateShort',
  'activateNextRotation',
  'autoActivate',
  'autoBootstrap',
  'weeklyFreeze',
  'activateFreeze'
]);

const ALLOWED_MODES = new Set([
  'manual',
  'selected',
  'adaptive',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed',
  'cost',
  'currentFit',
  'currentMarket'
]);

// Verlaagde limieten voor snellere response
const DEFAULT_AVAILABLE_LIMIT = 120;
const MAX_AVAILABLE_LIMIT = 200; // verlaagd van 500 naar 200
const DEFAULT_ACTIVE_ROWS_LIMIT = 160;
const MAX_ACTIVE_ROWS_LIMIT = 500;

// Verlaagde timeouts om sneller te falen bij trage Redis
const WEEK_MICROS_TIMEOUT_MS = 5_000; // verlaagd van 7_500
const ACTIVE_ROTATION_TIMEOUT_MS = 1_200; // verlaagd van 1_600
const ROTATION_DASHBOARD_TIMEOUT_MS = 1_200; // verlaagd van 1_600
const ACTIVATION_VALIDATE_TIMEOUT_MS = 6_000;

// Verhoogde cache-TTL om Redis-leeslast te verminderen
const CACHE_TTL_MS = 120_000; // verhoogd van 45_000
const CACHE_MAX_KEYS = 6;

// Limiet voor aantal micro-rows dat verwerkt wordt (voorkomt overbelasting)
const MAX_SOURCE_MICRO_ROWS = 2_000;

const STATUS_RANK = Object.freeze({
  [STATUS_PASSED]: 0,
  [STATUS_OBSERVING]: 1,
  [STATUS_REJECTED]: 2,
  [STATUS_EMPIRICAL_VETO]: 3,
  [STATUS_POLICY_BLOCKED]: 4,
  UNKNOWN: 99
});

const SIGNAL_RANK = Object.freeze({
  [SIGNAL_TYPE_TRADE_READY]: 0,
  [SIGNAL_TYPE_WATCH_ONLY]: 1,
  [SIGNAL_TYPE_OBSERVE_ONLY]: 2,
  [SIGNAL_TYPE_BLOCKED]: 3,
  UNKNOWN: 99
});

const cache =
  globalThis.__ADMIN_ROTATION_V5_LIGHTWEIGHT_IMMUTABLE_ENTRY_NETR_GEOMETRY_SAFE_CACHE__ ||= {
    weekMicros: new Map(),
    activeRotation: null
  };

function now() {
  return Date.now();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const parsed = safeNumber(value, fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value) {
  if (!hasValue(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finiteOrNull(value);
    if (parsed !== null) return parsed;
  }

  return null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function round(value, decimals = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(decimals)) : 0;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp(value, min = 0, max = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return hasValue(value) ? value : fallback;
}

function toLimit(value, fallback, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isTrue(value, fallback = false) {
  if (!hasValue(value)) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = lower(value);

  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length) {
    const value = stack.shift();
    if (Array.isArray(value)) stack.unshift(...value);
    else output.push(value);
  }

  return output;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];

  for (const value of flattenValues(values)) {
    const parts = typeof value === 'string'
      ? value.split(/[\s,;\n\r]+/g)
      : [value];

    for (const part of parts) {
      const clean = String(part || '').trim();
      if (!clean || seen.has(clean)) continue;

      seen.add(clean);
      output.push(clean);
    }
  }

  return output;
}

function uniqueWarnings(values = []) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(text) {
  const clean = String(text || '').trim();
  if (!clean) return {};

  try {
    return JSON.parse(clean);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));
    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, Math.max(1, timeoutMs));
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  const tail = String(text.length).toString(16).toUpperCase().padStart(2, '0');

  return `${hex}${tail}`.slice(0, MICRO_MICRO_HASH_LEN);
}

function normalizeHash(value = '') {
  const raw = upper(value).replace(/[^A-Z0-9]/g, '');
  return raw.length >= 3 ? raw.slice(0, MICRO_MICRO_HASH_LEN) : '';
}

function normalizeDirectSide(value) {
  const raw = upper(value);
  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizeMarketWeatherRegime(value = '') {
  const text = upper(value);

  if (text.includes('SQUEEZE') || text.includes('COMPRESS') || text.includes('COIL') || text.includes('LOW_VOL')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY') || text.includes('MIXED')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('DIRECTION') || text.includes('IMPULSE')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value = '') {
  const side = normalizeDirectSide(value);

  if (side === TARGET_TRADE_SIDE) return 'BEARISH';
  if (side === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  const text = upper(value);

  if (
    text.includes('BEAR') ||
    text.includes('SHORT') ||
    text.includes('SELL') ||
    text.includes('DOWN') ||
    text.includes('RISK_OFF')
  ) {
    return 'BEARISH';
  }

  if (
    text.includes('BULL') ||
    text.includes('LONG') ||
    text.includes('BUY') ||
    text.includes('UP') ||
    text.includes('RISK_ON')
  ) {
    return 'BULLISH';
  }

  if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT')) {
    return 'NEUTRAL';
  }

  return 'UNKNOWN';
}

function buildMarketWeatherKeyV1({ regime, trendSide } = {}) {
  return `${normalizeMarketWeatherRegime(regime)}|${normalizeMarketWeatherTrendSide(trendSide)}`;
}

function parseMarketWeatherKey(key = '') {
  const raw = upper(key);

  if (!raw.includes('|') || raw.includes('[OBJECT OBJECT]')) {
    return {
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      key: 'UNKNOWN|UNKNOWN',
      known: false
    };
  }

  const [regimeRaw, trendRaw] = raw.split('|');

  const regime = normalizeMarketWeatherRegime(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSide(trendRaw);
  const normalizedKey = `${regime}|${trendSide}`;

  return {
    regime,
    trendSide,
    key: normalizedKey,
    known: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
  };
}

function currentMarketWeatherFromRequest(req, body = {}) {
  const explicitKey = firstNonEmpty(
    body.confirmedMarketWeatherKey,
    body.currentMarketWeatherKey,
    body.marketWeatherKey,
    firstValue(req.query?.confirmedMarketWeatherKey, null),
    firstValue(req.query?.currentMarketWeatherKey, null),
    firstValue(req.query?.marketWeatherKey, null)
  );

  if (explicitKey) {
    const parsed = parseMarketWeatherKey(explicitKey);

    return {
      confirmedMarketWeatherKey: parsed.key,
      currentMarketWeatherKey: parsed.key,
      currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      currentMarketWeatherRegime: parsed.regime,
      currentMarketWeatherTrendSide: parsed.trendSide,
      currentMarketWeatherAvailable: parsed.known,
      source: parsed.known ? 'REQUEST_KEY' : 'REQUEST_KEY_UNKNOWN'
    };
  }

  const regime = normalizeMarketWeatherRegime(firstNonEmpty(
    body.confirmedMarketWeatherRegime,
    body.currentMarketWeatherRegime,
    body.marketWeatherRegime,
    firstValue(req.query?.confirmedMarketWeatherRegime, null),
    firstValue(req.query?.currentMarketWeatherRegime, null),
    firstValue(req.query?.marketWeatherRegime, null)
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstNonEmpty(
    body.confirmedMarketWeatherTrendSide,
    body.currentMarketWeatherTrendSide,
    body.marketWeatherTrendSide,
    firstValue(req.query?.confirmedMarketWeatherTrendSide, null),
    firstValue(req.query?.currentMarketWeatherTrendSide, null),
    firstValue(req.query?.marketWeatherTrendSide, null)
  ));

  const key = buildMarketWeatherKeyV1({ regime, trendSide });

  return {
    confirmedMarketWeatherKey: key,
    currentMarketWeatherKey: key,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: regime,
    currentMarketWeatherTrendSide: trendSide,
    currentMarketWeatherAvailable: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN',
    source: 'REQUEST_REGIME_TREND_OR_UNKNOWN'
  };
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

    selectorHardLiveDecisionEnabled: false,
    sizingCapHardLiveDecisionEnabled: false,
    fdrHardLiveDecisionEnabled: false,
    discordTradeReadyHardLiveDecisionEnabled: false,

    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherSourceOfTruth: 'STORED_ENTRY_FIELDS_ONLY',
    currentMarketWeatherDisplayOnly: true,
    confirmedMarketWeatherDisplayOnly: true,
    currentConfirmedNeverOverwriteEntryWeather: true,
    rotationNeverRepairsEntryFromCurrent: true,
    rotationNeverRepairsEntryFromConfirmed: true,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoSeparateFromPolicyBlocked: true,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksDiscordTradeReady: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    netRStatsSourceOfTruth: true,
    completedReadsNetRStatsFirst: true,
    totalRReadsNetRStatsFirst: true,
    avgRReadsNetRStatsFirst: true,
    profitFactorReadsNetRStatsFirst: true,

    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    bFlowAlignIsNeverBlockedByGeometryWithoutTradeShape: true,

    observeOnlyRiskAlwaysZero: true,
    watchOnlyRiskAlwaysZero: true,
    blockedRiskAlwaysZero: true,

    lightweightRotationRoute: true,
    getRotationDashboardOptional: true,
    activeRotationReadTimeoutMs: ACTIVE_ROTATION_TIMEOUT_MS,
    weekMicrosReadTimeoutMs: WEEK_MICROS_TIMEOUT_MS,

    alwaysAnswer: true,
    alwaysAnswerDoesNotMeanAlwaysTrade: true
  };
}

function modeFlags() {
  return {
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

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    realOutcomesExcluded: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    persistentLearningOnly: true,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKeyIgnored: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    rawExecutionFingerprintsNotSelectable: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

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
    selectableChildMicroFamilyCount: 0,
    selectableIdsAreMicroMicroOnly: true,
    child75Selectable: false,
    child75ProxySelectionDisabled: true,
    parentIdsAreMetadataOnly: true,
    child75IdsAreContextOnly: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    child75ActivationDisabled: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    child75MatchDoesNotTriggerDiscord: true,
    scannerMatchDoesNotTriggerDiscord: true,
    executionFingerprintMatchDoesNotTriggerDiscord: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitCanBlockDiscordOnly: true,
    currentFitMisfitIsPolicyBlock: false,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherSourceOfTruth: 'STORED_ENTRY_FIELDS_ONLY',
    currentConfirmedWeatherDoesNotOverwriteEntry: true,

    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoSeparateFromPolicyBlocked: true,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksDiscordTradeReady: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    activeRotationRuntimeGateVersion: ACTIVE_ROTATION_RUNTIME_GATE_VERSION,

    discordActivationRequiresNetEdge: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationGate: activationGateConfig(),

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,

    observeOnlyRisk: 0,
    watchOnlyRisk: 0,
    blockedRisk: 0,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    netRStatsSourceOfTruth: true,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,

    lightweightRotationRoute: true,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
  };
}

function activationGateConfig() {
  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    bestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,

    minCompleted: MIN_DISCORD_ACTIVATION_COMPLETED,
    minAvgR: MIN_DISCORD_ACTIVATION_AVG_R,
    minTotalR: MIN_DISCORD_ACTIVATION_TOTAL_R,
    minProfitFactor: MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
    minLcb95AvgR: MIN_DISCORD_ACTIVATION_LCB95_AVG_R,
    maxAvgCostR: MAX_DISCORD_ACTIVATION_AVG_COST_R,
    maxDirectSLPct: MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,

    blockEWeakContra: BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION,
    blockInvalidGeometry: BLOCK_INVALID_GEOMETRY_FOR_DISCORD_ACTIVATION,
    invalidGeometryOnlyForActionableTradeRows: true,
    aggregateStatsRowsIgnoreGeometryPolicy: true,

    currentFitMisfitIsPolicyBlock: false,
    currentFitMisfitIsSoftNoTradeReady: true,

    statuses: {
      [STATUS_OBSERVING]: 'completed < 35 -> virtual learning allowed, no Discord activation',
      [STATUS_PASSED]: 'completed >= 35 + positive exact-MM edge -> selectable',
      [STATUS_REJECTED]: 'completed >= 35 + weak edge -> no activation',
      [STATUS_EMPIRICAL_VETO]: 'completed >= 35 + standalone lifetime LCB95(avgR)<0 -> no risk, no parent rescue',
      [STATUS_POLICY_BLOCKED]: 'E_WEAK_CONTRA / invalid side / invalid geometry on actionable trade rows only / non-short / explicit forbidden family'
    },

    empiricalVetoRule:
      'exact micro-micro completed >= 35 AND standalone lifetime LCB95(avgR) < 0',
    empiricalVetoUsesLcb95NotRawAvgR: true,

    netRStatsAreSourceOfTruth: true,
    entryMarketWeatherImmutable: true,
    currentConfirmedWeatherCannotOverwriteEntryWeather: true,

    rule:
      'exact-MM && policy ok && no empirical veto && completed>=35 && avgR>0 && totalR>0 && PF>1 && LCB95(avgR)>0 && avgCostR<=0.35 && directSLPct<=0.25'
  };
}

function taxonomyMeta() {
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

    setups: SETUP_ORDER,
    regimes: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER,

    parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75ContextFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableMicroMicroFormat:
      'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
    alternateInputAccepted:
      'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}',

    exampleParentRejected: 'MICRO_SHORT_BREAKOUT_TREND',
    exampleChild75Rejected: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
    exampleSelectableMicroMicro:
      'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_MM_AB12CD34EF',
    exampleAlternateInput:
      'MM_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_OB_STRONG_RR_GOOD',

    selectableIdsAreMicroMicroOnly: true,
    child75IdsAreContextOnly: true,
    parentIdsAreMetadataOnly: true,
    child75ProxySelectionDisabled: true,

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationGate: activationGateConfig()
  };
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

function invalidParsed(rawId = '', reason = 'INVALID_SHORT_TAXONOMY_ID') {
  return {
    valid: false,
    reason,
    selectable: false,
    selectableForDiscord: false,
    isParent: false,
    isChild: false,
    isBaseChild: false,
    isMicroMicro: false,
    rawId,
    id: null,
    key: null,
    setup: null,
    regime: null,
    setupType: null,
    regimeBucket: null,
    confirmationProfile: null,
    microMicroHash: null,
    microMicroContext: '',
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    trueMicroFamilyId: null,
    microMicroFamilyId: null,
    trueMicroMicroFamilyId: null,
    exactMicroMicroFamilyId: null,
    learningLayer: 'UNKNOWN',
    selectionLayer: 'UNKNOWN'
  };
}

function parseBodySetupRegimeConfirmation(body = '') {
  const cleanBody = upper(body).replace(/^_+|_+$/g, '');

  for (const setup of SETUP_ORDER) {
    const setupPrefix = `${setup}_`;
    if (!cleanBody.startsWith(setupPrefix)) continue;

    const afterSetup = cleanBody.slice(setupPrefix.length);

    for (const regime of REGIME_ORDER) {
      if (afterSetup === regime) {
        return {
          ok: true,
          setup,
          regime,
          confirmationProfile: null,
          rest: ''
        };
      }

      const regimePrefix = `${regime}_`;
      if (!afterSetup.startsWith(regimePrefix)) continue;

      const afterRegime = afterSetup.slice(regimePrefix.length);

      for (const profile of CONFIRMATION_PROFILE_ORDER) {
        if (afterRegime === profile) {
          return {
            ok: true,
            setup,
            regime,
            confirmationProfile: profile,
            rest: ''
          };
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

  if (!value) return invalidParsed(rawId, 'EMPTY_ID');
  if (value.includes('MICRO_LONG_') || value.startsWith('MM_LONG_')) {
    return invalidParsed(rawId, 'LONG_DISABLED_SHORT_ONLY');
  }
  if (isScannerFingerprintId(value)) {
    return invalidParsed(rawId, 'SCANNER_FINGERPRINT_METADATA_ONLY');
  }
  if (isExecutionFingerprintId(value)) {
    return invalidParsed(rawId, 'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE');
  }
  if (value.includes('_MF_V1_') || value.includes('_MF_V2_') || value.includes('_MF_V3_')) {
    return invalidParsed(rawId, 'LEGACY_MICRO_SCHEMA_NOT_SELECTABLE');
  }

  let body = '';
  let explicitMicroMicro = false;
  let context = '';
  let canonicalMicroMicroSyntax = false;

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
    return invalidParsed(rawId, 'NOT_SHORT_TAXONOMY_ID');
  }

  const parsed = parseBodySetupRegimeConfirmation(body);
  if (!parsed.ok) return invalidParsed(rawId, 'INVALID_SHORT_TAXONOMY_BODY');

  if (explicitMicroMicro && !context && parsed.rest) context = parsed.rest;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setup}_${parsed.regime}`;
  const childTrueMicroFamilyId = parsed.confirmationProfile
    ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}`
    : null;

  const isParent = Boolean(!parsed.confirmationProfile && !explicitMicroMicro);
  const isChild = Boolean(parsed.confirmationProfile && !explicitMicroMicro && !parsed.rest);
  const isMicroMicro = Boolean(parsed.confirmationProfile && (explicitMicroMicro || parsed.rest));

  let microMicroHash = null;

  if (isMicroMicro) {
    microMicroHash = canonicalMicroMicroSyntax
      ? normalizeHash(context)
      : normalizeHash(context || parsed.rest) || stableHash10(value);
  }

  if (isMicroMicro && !microMicroHash) {
    return invalidParsed(rawId, 'MICRO_MICRO_HASH_REQUIRED');
  }

  const microMicroFamilyId = isMicroMicro
    ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`
    : null;

  const trueMicroFamilyId =
    microMicroFamilyId ||
    childTrueMicroFamilyId ||
    parentTrueMicroFamilyId;

  return {
    valid: true,
    reason: 'OK',
    selectable: isMicroMicro,
    selectableForDiscord: isMicroMicro,
    isParent,
    isChild,
    isBaseChild: Boolean(childTrueMicroFamilyId),
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
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    trueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: isMicroMicro
      ? 'MICRO_MICRO'
      : isChild
        ? 'CHILD_75_CONTEXT'
        : isParent
          ? 'PARENT_15_CONTEXT'
          : 'UNKNOWN',
    selectionLayer: isMicroMicro ? 'MICRO_MICRO' : 'NOT_SELECTABLE',
    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : 'NOT_SELECTABLE'
  };
}

function isFixedShortParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedShortChild75Id(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isSelectableMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.selectable === true && parsed.isMicroMicro === true;
}

function firstParsed(values = [], predicate = () => true) {
  for (const value of flattenValues(values)) {
    const parsed = parseShortTaxonomyMicroId(value);
    if (parsed.valid && predicate(parsed)) return parsed;
  }

  return null;
}

function getExplicitMicroMicroId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
  }

  return firstParsed([
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.activeMicroMicroFamilyId,
    row.activeTrueMicroMicroFamilyId,
    row.activeExactMicroMicroFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
}

function getParentTrueMicroFamilyIdFromId(id = '') {
  return parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId || null;
}

function getChildTrueMicroFamilyIdFromId(id = '') {
  return parseShortTaxonomyMicroId(id).childTrueMicroFamilyId || null;
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const parsed = parseShortTaxonomyMicroId(input);

    if (parsed.valid) return TARGET_TRADE_SIDE;
    if (parsed.reason === 'LONG_DISABLED_SHORT_ONLY') return OPPOSITE_TRADE_SIDE;

    const value = upper(input);

    if (value.includes('MICRO_LONG_') || value.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('MICRO_SHORT_') || value.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (value.includes('LONG') || value.includes('BULL') || value.includes('BUY')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('SHORT') || value.includes('BEAR') || value.includes('SELL')) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  for (const source of [
    input.tradeSide,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.side,
    input.bias,
    input.marketBias
  ]) {
    const side = normalizeDirectSide(source);
    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const idText = upper([
    input.microMicroFamilyId,
    input.trueMicroMicroFamilyId,
    input.exactMicroMicroFamilyId,
    input.trueMicroFamilyId,
    input.learningFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.microFamilyId,
    input.parentTrueMicroFamilyId,
    input.id,
    input.key,
    input.definition,
    input.microDefinition,
    input.microMicroDefinition
  ].filter(Boolean).join(' | '));

  if (idText.includes('MICRO_LONG_') || idText.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
  if (idText.includes('MICRO_SHORT_') || idText.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      row?.trueMicroFamilyId ||
        row?.microMicroFamilyId ||
        row?.microFamilyId ||
        String(index),
      row
    ]);
  }

  if (!value || typeof value !== 'object') return [];
  return Object.entries(value);
}

function netRFromOutcome(outcome = {}) {
  const explicit = firstFinite(
    outcome.netR,
    outcome.shortNetR,
    outcome.exitR,
    outcome.realizedNetR,
    outcome.realizedR,
    outcome.r
  );

  if (explicit !== null) return explicit;

  const gross = firstFinite(
    outcome.grossR,
    outcome.shortGrossR,
    outcome.rawR,
    outcome.realizedGrossR
  );

  if (gross === null) return null;

  const cost = Math.max(0, firstFinite(
    outcome.costR,
    outcome.netCostR,
    outcome.estimatedCostR,
    outcome.avgCostR
  ) ?? 0);

  return gross - cost;
}

function aggregateRecentOutcomes(row = {}) {
  const recent = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];

  return recent.reduce((acc, outcome) => {
    if (!outcome || typeof outcome !== 'object') return acc;

    const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');
    if (!['VIRTUAL', 'SHADOW', 'PAPER', ''].includes(source)) return acc;

    const r = netRFromOutcome(outcome);
    if (r === null) return acc;

    const costR = Math.max(0, firstFinite(
      outcome.costR,
      outcome.netCostR,
      outcome.estimatedCostR,
      outcome.avgCostR
    ) ?? 0);

    acc.completed += 1;
    acc.totalR += r;
    acc.totalCostR += costR;
    acc.sumR += r;
    acc.sumSqR += r * r;

    if (r > 0) {
      acc.wins += 1;
      acc.grossWinR += r;
    } else if (r < 0) {
      acc.losses += 1;
      acc.grossLossR += Math.abs(r);
    } else {
      acc.flats += 1;
    }

    if (
      outcome.directSL ||
      outcome.directToSL ||
      outcome.directStopLoss ||
      outcome.isDirectSL ||
      upper(outcome.exitReason) === 'SL'
    ) {
      acc.directSLCount += 1;
    }

    return acc;
  }, {
    source: 'RECENT_OUTCOMES_FALLBACK',
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
    sumSqR: 0
  });
}

function statsObject(row = {}) {
  const stats =
    row.netRStats ||
    row.shortNetRStats ||
    row.outcomeNetRStats ||
    null;

  return stats && typeof stats === 'object' ? stats : null;
}

function normalizedNetStats(row = {}) {
  const stats = statsObject(row);

  if (stats) {
    const completed = Math.max(0, num(stats.completed, 0));

    if (completed > 0) {
      const wins = Math.max(0, num(stats.wins, 0));
      const losses = Math.max(0, num(stats.losses, 0));
      const flats = Math.max(0, num(stats.flats, Math.max(0, completed - wins - losses)));
      const total = num(stats.totalR ?? stats.netTotalR ?? stats.shortNetTotalR, 0);
      const avg = hasValue(stats.avgR) ? num(stats.avgR, 0) : total / completed;
      const totalCost = Math.max(0, num(stats.totalCostR, 0));
      const avgCost = hasValue(stats.avgCostR)
        ? Math.max(0, num(stats.avgCostR, 0))
        : totalCost / completed;
      const grossWinR = Math.max(0, num(stats.grossWinR, 0));
      const grossLossR = Math.max(0, num(stats.grossLossR, 0));
      const pf = hasValue(stats.profitFactor)
        ? num(stats.profitFactor, 0)
        : grossLossR > 0
          ? grossWinR / grossLossR
          : grossWinR > 0
            ? 99
            : 0;
      const directCount = Math.max(0, num(stats.directSLCount, 0));
      const sumSqR = Math.max(0, num(stats.sumSqR, 0));
      const explicitLcb = firstFinite(
        stats.lcb95AvgR,
        stats.avgRLCB95,
        stats.avgRLowerBound95
      );

      const computedLcb = completed > 1 && sumSqR > 0
        ? avg - 1.96 * Math.sqrt(Math.max(0, (sumSqR - (total * total) / completed) / (completed - 1))) / Math.sqrt(completed)
        : null;

      return {
        source: 'NET_R_STATS_SOURCE_OF_TRUTH',
        completed,
        wins,
        losses,
        flats,
        totalR: total,
        avgR: avg,
        totalCostR: totalCost,
        avgCostR: avgCost,
        grossWinR,
        grossLossR,
        profitFactor: pf,
        directSLCount: directCount,
        directSLPct: completed > 0 ? directCount / completed : 0,
        winrate: completed > 0 ? wins / completed : 0,
        lcb95AvgR: explicitLcb ?? computedLcb,
        avgRLCB95: explicitLcb ?? computedLcb,
        sumSqR
      };
    }
  }

  const recent = aggregateRecentOutcomes(row);

  if (recent.completed > 0) {
    const avg = recent.totalR / recent.completed;
    const avgCost = recent.totalCostR / recent.completed;
    const pf = recent.grossLossR > 0
      ? recent.grossWinR / recent.grossLossR
      : recent.grossWinR > 0
        ? 99
        : 0;

    const lcb = recent.completed > 1
      ? avg - 1.96 * Math.sqrt(Math.max(0, (recent.sumSqR - (recent.totalR * recent.totalR) / recent.completed) / (recent.completed - 1))) / Math.sqrt(recent.completed)
      : 0;

    return {
      ...recent,
      avgR: avg,
      avgCostR: avgCost,
      profitFactor: pf,
      directSLPct: recent.directSLCount / recent.completed,
      winrate: recent.wins / recent.completed,
      lcb95AvgR: lcb,
      avgRLCB95: lcb
    };
  }

  return null;
}

function outcomeCounts(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return {
      wins: netStats.wins,
      losses: netStats.losses,
      flats: netStats.flats,
      total: netStats.completed
    };
  }

  const sourceWins = num(row.virtualWins, 0) + num(row.shadowWins, 0);
  const sourceLosses = num(row.virtualLosses, 0) + num(row.shadowLosses, 0);
  const sourceFlats = num(row.virtualFlats, 0) + num(row.shadowFlats, 0);

  const wins = Math.max(0, sourceWins, num(row.wins, 0));
  const losses = Math.max(0, sourceLosses, num(row.losses, 0));
  const flats = Math.max(0, sourceFlats, num(row.flats, 0));

  const completed = Math.max(
    wins + losses + flats,
    num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
    num(row.completed, 0),
    num(row.closed, 0),
    num(row.outcomeSample, 0)
  );

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, completed - wins - losses)),
    total: completed
  };
}

function completedSample(row = {}) {
  return outcomeCounts(row).total;
}

function observationSample(row = {}) {
  return Math.max(
    num(row.observationSample, 0),
    num(row.seen, 0),
    num(row.observed, 0),
    num(row.observations, 0),
    completedSample(row),
    0
  );
}

function totalR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return netStats.totalR;
  }

  const completed = completedSample(row);
  if (completed <= 0) return 0;

  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;

  return num(
    row.shortNetTotalR ??
      row.netShortTotalR ??
      row.netTotalR ??
      row.totalNetR ??
      row.totalR,
    0
  );
}

function avgR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return netStats.avgR;
  }

  const completed = completedSample(row);
  if (completed <= 0) return 0;

  const t = totalR(row);
  if (t !== 0) return t / completed;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR)) return num(row.avgR, 0);

  return 0;
}

function lcb95AvgR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0 && netStats.lcb95AvgR !== null) {
    return netStats.lcb95AvgR;
  }

  const explicit = firstFinite(
    row.standaloneMicroMicroLifetimeLCB95AvgR,
    row.exactMicroMicroLifetimeLCB95AvgR,
    row.lcb95AvgR,
    row.avgRLCB95,
    row.avgRLcb95,
    row.avgRLowerBound95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR
  );

  if (explicit !== null) return explicit;

  const completed = completedSample(row);
  const average = avgR(row);

  if (completed <= 1) return 0;

  return average - 1.96 * (1 / Math.sqrt(completed));
}

function totalCostR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return Math.max(0, netStats.totalCostR);
  }

  const completed = completedSample(row);
  if (completed <= 0) return 0;

  const virtualShadowCost =
    Math.max(0, num(row.virtualTotalCostR, 0)) +
    Math.max(0, num(row.shadowTotalCostR, 0));

  if (virtualShadowCost > 0) return virtualShadowCost;
  if (hasValue(row.totalCostR)) return Math.max(0, num(row.totalCostR, 0));
  if (hasValue(row.avgCostR)) return Math.max(0, num(row.avgCostR, 0)) * completed;
  if (hasValue(row.costR)) return Math.max(0, num(row.costR, 0)) * completed;

  return 0;
}

function avgCostR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return Math.max(0, netStats.avgCostR);
  }

  const completed = completedSample(row);
  return completed > 0 ? totalCostR(row) / completed : 0;
}

function directSLCount(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return Math.max(0, netStats.directSLCount);
  }

  return Math.max(
    0,
    num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0),
    num(row.directSLCount, 0),
    num(row.directToSLCount, 0)
  );
}

function directSLPct(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return clamp(netStats.directSLPct, 0, 1);
  }

  const explicit = num(row.directSLPct, NaN);

  if (Number.isFinite(explicit)) {
    return explicit > 1 ? clamp(explicit / 100, 0, 1) : clamp(explicit, 0, 1);
  }

  const completed = completedSample(row);
  return completed > 0 ? clamp(directSLCount(row) / completed, 0, 1) : 0;
}

function profitFactor(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return netStats.profitFactor;
  }

  const explicit = num(row.netProfitFactor ?? row.profitFactor ?? row.pf, NaN);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);

  const winR = Math.max(
    num(row.virtualWinR, 0) + num(row.shadowWinR, 0),
    num(row.virtualGrossWinR, 0) + num(row.shadowGrossWinR, 0),
    num(row.netWinR, 0),
    num(row.totalWinR, 0),
    num(row.grossWinR, 0),
    0
  );

  const lossR = Math.max(
    Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)),
    Math.abs(num(row.virtualGrossLossR, 0) + num(row.shadowGrossLossR, 0)),
    Math.abs(num(row.netLossR, 0)),
    Math.abs(num(row.totalLossR, 0)),
    Math.abs(num(row.grossLossR, 0)),
    0
  );

  if (winR > 0 || lossR > 0) {
    if (lossR <= 0) return 99;
    return winR / lossR;
  }

  return 0;
}

function wilsonLowerBound(successes, trials, z = 1.96) {
  const n = num(trials, 0);
  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;
  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function sampleReliability(sample, cap = 50) {
  const n = num(sample, 0);
  return n > 0 ? clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1) : 0;
}

function sampleAdjustedWinrate(row = {}) {
  const counts = outcomeCounts(row);
  const completed = counts.total;
  const observed = observationSample(row);

  if (completed <= 0) {
    return {
      sample: observed,
      outcomeSample: 0,
      observationSample: observed,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(observed),
      score: 0,
      awaitingOutcomes: observed > 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / completed, 0, 1);
  const bayesianWinrate = clamp((successes + 1) / (completed + 2), 0, 1);
  const wilson = wilsonLowerBound(successes, completed);
  const reliability = sampleReliability(completed, 50);
  const score = clamp(wilson * 0.8 + bayesianWinrate * 0.15 + rawWinrate * 0.05, 0, 1);

  return {
    sample: completed,
    outcomeSample: completed,
    observationSample: observed,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score,
    awaitingOutcomes: false
  };
}

function balancedScore(row = {}, winrate = null) {
  const wr = winrate || sampleAdjustedWinrate(row);

  if (wr.outcomeSample <= 0 && wr.observationSample > 0) {
    return Math.min(
      45,
      Math.log1p(wr.observationSample) * 8 + wr.reliability * 18
    );
  }

  return (
    wr.score * 100 +
    wr.reliability * 20 +
    Math.log1p(Math.max(0, totalR(row))) * 12 +
    Math.log1p(Math.max(0, avgR(row))) * 8 +
    Math.log1p(Math.min(Math.max(0, profitFactor(row)), 20)) * 3 -
    directSLPct(row) * 60 -
    avgCostR(row) * 3
  );
}

function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
  const parsed = Number(score);

  if (!Number.isFinite(parsed)) return fallback || 'UNKNOWN';
  if (parsed >= 45) return 'FIT';
  if (parsed >= 20) return 'OK';
  if (parsed <= -20) return 'MISFIT';

  return 'NEUTRAL';
}

function getShortCurrentFit(row = {}) {
  const direct = [
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore,
    row.shortCurrentFitScore,
    row.bearCurrentFitScore
  ].find((value) => Number.isFinite(Number(value)));

  if (hasValue(direct)) {
    return {
      score: Number(direct),
      label: currentFitLabel(Number(direct), row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      source: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const explicitLabel = upper(row.currentFit || row.currentFitLabel || row.entryCurrentFit || '');

  if (
    explicitLabel.includes('MISFIT') ||
    explicitLabel.includes('MISMATCH') ||
    explicitLabel.includes('AGAINST') ||
    explicitLabel.includes('NO_MATCH')
  ) {
    return {
      score: -25,
      label: 'MISFIT',
      source: 'EXPLICIT_CURRENT_FIT_LABEL'
    };
  }

  const raw = [
    row.currentFitScore,
    row.fitScore,
    row.marketFitScore,
    row.marketFit,
    row.currentFitNumeric
  ].find((value) => Number.isFinite(Number(value)));

  if (!hasValue(raw)) {
    return {
      score: 0,
      label: explicitLabel || 'UNKNOWN',
      source: 'NO_NUMERIC_CURRENT_FIT'
    };
  }

  const haystack = [
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
    row.currentFitReason
  ].map(upper).join(' | ');

  const score =
    haystack.includes('BULL') ||
    haystack.includes('LONG') ||
    haystack.includes('BUY')
      ? -Math.abs(Number(raw))
      : Number(raw);

  return {
    score,
    label: currentFitLabel(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
    source: 'SHORT_MIRRORED_GENERIC_CURRENT_FIT'
  };
}

function hasTradeIdentity(row = {}) {
  return Boolean(
    row.tradeId ||
      row.positionId ||
      row.orderId ||
      row.outcomeIdentity ||
      row.stableOutcomeIdentity ||
      row.openedAt ||
      row.closedAt ||
      row.completedAt
  );
}

function hasStatsIdentity(row = {}) {
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

function isAggregateStatsRow(row = {}) {
  const id = getExplicitMicroMicroId(row, row?.key);
  const type = upper(row.type || row.rowType || row.eventType || '');

  if (!id) return false;

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

  return hasStatsIdentity(row) && !hasTradeIdentity(row);
}

function isActionableTradeGeometryRow(row = {}) {
  if (!row || typeof row !== 'object') return false;
  if (isAggregateStatsRow(row)) return false;

  const type = upper(row.type || row.rowType || row.eventType || '');
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
    source.includes('VIRTUAL') ||
    source.includes('SHADOW') ||
    source.includes('POSITION') ||
    source.includes('TRADE')
  ) {
    return Boolean(row.tradeId || row.positionId || row.symbol || row.contractSymbol);
  }

  return hasTradeIdentity(row);
}

function shortRiskGeometry(row = {}) {
  const entry = Number(
    row.entryPrice ??
      row.entry ??
      row.avgEntryPrice ??
      row.averageEntryPrice ??
      row.openPrice
  );

  const sl = Number(
    row.initialSl ??
      row.initialSL ??
      row.initialStopLoss ??
      row.stopLoss ??
      row.stopLossPrice ??
      row.sl ??
      row.slPrice
  );

  const tp = Number(
    row.tp ??
      row.takeProfit ??
      row.takeProfitPrice ??
      row.targetPrice ??
      row.finalTp
  );

  const hasGeometry =
    Number.isFinite(entry) ||
    Number.isFinite(sl) ||
    Number.isFinite(tp);

  const completeGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(sl) &&
    Number.isFinite(tp);

  const actionableTradeGeometryRow = isActionableTradeGeometryRow(row);
  const geometryPolicyCheckApplied = actionableTradeGeometryRow && completeGeometry;

  const validGeometry =
    !geometryPolicyCheckApplied ||
    (
      entry > 0 &&
      sl > 0 &&
      tp > 0 &&
      tp < entry &&
      entry < sl
    );

  return {
    entry: Number.isFinite(entry) ? entry : null,
    initialSl: Number.isFinite(sl) ? sl : null,
    tp: Number.isFinite(tp) ? tp : null,
    hasGeometry,
    completeGeometry,
    actionableTradeGeometryRow,
    aggregateStatsRow: isAggregateStatsRow(row),
    geometryPolicyCheckApplied,
    validGeometry,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    rule: 'SHORT: tp < entry < sl'
  };
}

function entryMarketWeatherFields(row = {}, currentMarket = null) {
  const raw = row.entryMarketWeatherRaw ||
    row.entryMarketWeather ||
    row.lockedEntryMarketWeather ||
    null;

  const rawObject = raw && typeof raw === 'object' ? raw : null;

  const explicitEntryKey = firstNonEmpty(
    row.entryMarketWeatherKey,
    rawObject?.entryMarketWeatherKey
  );

  if (explicitEntryKey) {
    const parsed = parseMarketWeatherKey(explicitEntryKey);

    return {
      entryMarketWeatherKey: parsed.key,
      entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
      entryMarketWeatherRegime: parsed.regime,
      entryMarketWeatherTrendSide: parsed.trendSide,
      entryMarketWeatherCapturedAt:
        row.entryMarketWeatherCapturedAt ||
        row.entryCreatedAt ||
        row.openedAt ||
        row.createdAt ||
        rawObject?.createdAt ||
        rawObject?.completedAt ||
        rawObject?.updatedAt ||
        null,
      entryMarketWeatherRaw: rawObject,
      entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
        ? row.entryMarketWeatherRawAvailableFields
        : rawObject
          ? Object.keys(rawObject).filter((key) => hasValue(rawObject[key])).sort()
          : [],
      entryMarketWeatherImmutable: row.entryMarketWeatherImmutable !== false,
      entryMarketWeatherNeverRecomputedAtExit:
        row.entryMarketWeatherNeverRecomputedAtExit !== false,
      entryMarketWeatherSource: 'STORED_ENTRY_KEY',
      currentConfirmedWeatherDidNotOverwriteEntry: true,

      confirmedMarketWeatherKey: currentMarket?.confirmedMarketWeatherKey || null,
      currentMarketWeatherKey: currentMarket?.currentMarketWeatherKey || null,
      currentMarketWeatherRegime: currentMarket?.currentMarketWeatherRegime || null,
      currentMarketWeatherTrendSide: currentMarket?.currentMarketWeatherTrendSide || null
    };
  }

  const regime = normalizeMarketWeatherRegime(firstNonEmpty(
    row.entryMarketWeatherRegime,
    rawObject?.entryMarketWeatherRegime,
    rawObject?.marketWeatherRegime
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstNonEmpty(
    row.entryMarketWeatherTrendSide,
    rawObject?.entryMarketWeatherTrendSide,
    rawObject?.marketWeatherTrendSide
  ));

  const key = buildMarketWeatherKeyV1({ regime, trendSide });
  const parsed = parseMarketWeatherKey(key);

  return {
    entryMarketWeatherKey: parsed.known ? parsed.key : 'UNKNOWN|UNKNOWN',
    entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: parsed.known ? parsed.regime : 'UNKNOWN',
    entryMarketWeatherTrendSide: parsed.known ? parsed.trendSide : 'UNKNOWN',
    entryMarketWeatherCapturedAt:
      row.entryMarketWeatherCapturedAt ||
      row.entryCreatedAt ||
      row.openedAt ||
      row.createdAt ||
      rawObject?.createdAt ||
      rawObject?.completedAt ||
      rawObject?.updatedAt ||
      null,
    entryMarketWeatherRaw: rawObject,
    entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
      ? row.entryMarketWeatherRawAvailableFields
      : rawObject
        ? Object.keys(rawObject).filter((field) => hasValue(rawObject[field])).sort()
        : [],
    entryMarketWeatherImmutable: row.entryMarketWeatherImmutable !== false,
    entryMarketWeatherNeverRecomputedAtExit:
      row.entryMarketWeatherNeverRecomputedAtExit !== false,
    entryMarketWeatherSource: parsed.known
      ? 'STORED_ENTRY_REGIME_TREND_FIELDS'
      : 'UNKNOWN_NO_ENTRY_WEATHER_ON_STORED_ROW',
    currentConfirmedWeatherDidNotOverwriteEntry: true,

    confirmedMarketWeatherKey: currentMarket?.confirmedMarketWeatherKey || null,
    currentMarketWeatherKey: currentMarket?.currentMarketWeatherKey || null,
    currentMarketWeatherRegime: currentMarket?.currentMarketWeatherRegime || null,
    currentMarketWeatherTrendSide: currentMarket?.currentMarketWeatherTrendSide || null
  };
}

function getWeatherStatsObject(row = {}) {
  return row.marketWeatherStats ||
    row.weatherStats ||
    row.entryMarketWeatherStats ||
    {};
}

function selectWeatherAccumulator(row = {}, currentMarket = {}) {
  const stats = getWeatherStatsObject(row);

  const lifetime =
    stats.lifetime ||
    stats.all ||
    row.lifetimeStats ||
    row;

  const regimeStats =
    stats.regime ||
    stats.byRegime ||
    stats.marketWeatherRegime ||
    {};

  const regimeTrendStats =
    stats.regimeTrend ||
    stats.byRegimeTrend ||
    stats.marketWeatherRegimeTrend ||
    stats.marketWeatherKey ||
    stats.byMarketWeatherKey ||
    {};

  const regimeKey = currentMarket.currentMarketWeatherRegime;
  const regimeTrendKey = currentMarket.currentMarketWeatherKey;

  if (
    currentMarket.currentMarketWeatherAvailable &&
    regimeTrendKey &&
    regimeTrendStats[regimeTrendKey]
  ) {
    return {
      accumulator: regimeTrendStats[regimeTrendKey],
      familyResolution: 'MICRO_MICRO',
      marketResolution: 'REGIME_TREND',
      proofSource: 'MICRO_MICRO_REGIME_TREND',
      weatherMatched: true,
      playbookFresh: true,
      key: regimeTrendKey
    };
  }

  if (
    currentMarket.currentMarketWeatherAvailable &&
    regimeKey &&
    regimeStats[regimeKey]
  ) {
    return {
      accumulator: regimeStats[regimeKey],
      familyResolution: 'MICRO_MICRO',
      marketResolution: 'REGIME',
      proofSource: 'MICRO_MICRO_REGIME',
      weatherMatched: false,
      playbookFresh: false,
      key: regimeKey
    };
  }

  return {
    accumulator: lifetime,
    familyResolution: 'MICRO_MICRO',
    marketResolution: 'LIFETIME',
    proofSource: 'MICRO_MICRO_LIFETIME',
    weatherMatched: false,
    playbookFresh: false,
    key: null
  };
}

function explicitForbiddenFlag(row = {}) {
  return Boolean(
    row.forbiddenFamily === true ||
      row.knownForbiddenFamily === true ||
      row.blacklistedFamily === true ||
      row.familyBlacklisted === true ||
      row.policy?.forbiddenFamily === true ||
      row.policy?.knownForbiddenFamily === true ||
      row.policyFlags?.forbiddenFamily === true ||
      row.policyFlags?.knownForbiddenFamily === true
  );
}

function policyBlockedGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row.key);
  const parsed = parseShortTaxonomyMicroId(id || row.key || row.id || row.trueMicroFamilyId || '');
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);
  const geometry = shortRiskGeometry(row);

  const reasons = [];

  if (!id || !parsed.isMicroMicro || !isSelectableMicroMicroId(id)) {
    reasons.push('EXACT_MICRO_MICRO_ID_REQUIRED');
  }

  if (!isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id })) {
    reasons.push('SHORT_ONLY_REQUIRED');
  }

  if (confirmationProfile === 'E_WEAK_CONTRA') {
    reasons.push('E_WEAK_CONTRA_POLICY_BLOCK');
  }

  if (
    BLOCK_INVALID_GEOMETRY_FOR_DISCORD_ACTIVATION &&
    geometry.geometryPolicyCheckApplied &&
    !geometry.validGeometry
  ) {
    reasons.push('INVALID_SHORT_GEOMETRY_POLICY_BLOCK');
  }

  if (explicitForbiddenFlag(row)) {
    reasons.push('EXPLICIT_FORBIDDEN_FAMILY_POLICY_BLOCK');
  }

  return {
    blocked: reasons.length > 0,
    policyBlocked: reasons.length > 0,
    policyBlockedReason: reasons[0] || null,
    reasons,
    parsed,
    id,
    geometry,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true
  };
}

function empiricalVetoGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row.key);
  const completed = completedSample(row);
  const lcb = lcb95AvgR(row);
  const parsed = parseShortTaxonomyMicroId(id);

  const exactMicroMicro =
    Boolean(id) &&
    parsed.isMicroMicro === true &&
    isSelectableMicroMicroId(id);

  const triggered =
    exactMicroMicro &&
    completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING &&
    lcb !== null &&
    lcb < 0;

  return {
    version: EMPIRICAL_VETO_VERSION,
    triggered,
    empiricalVeto: triggered,
    empiricalVetoReason: triggered
      ? 'EXACT_MICRO_MICRO_LCB95_NEGATIVE'
      : null,
    exactMicroMicro,
    id,
    microMicroFamilyId: id,
    completed: round(completed, 4),
    minCompleted: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    standaloneMicroMicroLifetimeLCB95AvgR: lcb === null ? null : round(lcb, 6),
    usesRawAvgR: false,
    usesLcb95AvgR: true,
    blocksRiskEntry: triggered,
    blocksDiscordTradeReady: triggered,
    blocksParentFallbackRescue: triggered
  };
}

function microMicroRuntimeGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row.key);
  const parsed = parseShortTaxonomyMicroId(id || row.key || row.id || row.trueMicroFamilyId || '');

  const policy = policyBlockedGate(row);
  const veto = empiricalVetoGate(row);
  const fitInfo = getShortCurrentFit(row);

  const completed = completedSample(row);
  const observed = observationSample(row);
  const netAvgR = avgR(row);
  const netTotalR = totalR(row);
  const pf = profitFactor(row);
  const cost = avgCostR(row);
  const dsl = directSLPct(row);
  const lcb = lcb95AvgR(row);
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);
  const netStats = normalizedNetStats(row);

  const checks = {
    exactMicroMicroOk: Boolean(id && parsed.isMicroMicro && isSelectableMicroMicroId(id)),
    shortOnlyOk: isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id }),
    policyOk: !policy.blocked,
    empiricalVetoOk: !veto.triggered,
    completedOk: completed >= MIN_DISCORD_ACTIVATION_COMPLETED,
    avgROk: netAvgR > MIN_DISCORD_ACTIVATION_AVG_R,
    totalROk: netTotalR > MIN_DISCORD_ACTIVATION_TOTAL_R,
    profitFactorOk: pf > MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
    lcb95AvgROk: lcb > MIN_DISCORD_ACTIVATION_LCB95_AVG_R,
    avgCostROk: cost <= MAX_DISCORD_ACTIVATION_AVG_COST_R,
    directSLOk: dsl <= MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,
    currentFitMisfitSoftOnly: upper(fitInfo.label) === 'MISFIT',
    currentFitPolicyBlock: false,
    confirmationProfileOk: confirmationProfile !== 'E_WEAK_CONTRA',
    validShortGeometry: policy.geometry.validGeometry,
    geometryPolicyCheckApplied: policy.geometry.geometryPolicyCheckApplied,
    aggregateStatsRowGeometryIgnored: policy.geometry.aggregateStatsRow,
    netRStatsSourceOfTruth: Boolean(netStats),
    netRStatsSource: netStats?.source || null
  };

  const base = {
    version: MICRO_MICRO_RUNTIME_GATE_VERSION,
    id,
    parsed,
    completed: round(completed, 4),
    observed: round(observed, 4),
    avgR: round(netAvgR, 4),
    totalR: round(netTotalR, 4),
    profitFactor: round(pf, 4),
    lcb95AvgR: round(lcb, 6),
    avgCostR: round(cost, 4),
    directSLPct: round(dsl, 4),
    currentFit: fitInfo.label || 'UNKNOWN',
    currentFitScore: round(fitInfo.score, 4),
    currentFitSource: fitInfo.source,
    currentFitMisfitIsPolicyBlock: false,
    confirmationProfile,
    policyBlockedGate: policy,
    empiricalVetoGate: veto,
    checks,
    thresholds: activationGateConfig(),
    netRStatsSourceOfTruth: Boolean(netStats),
    netRStatsSource: netStats?.source || null,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true
  };

  if (policy.blocked) {
    return {
      ...base,
      status: STATUS_POLICY_BLOCKED,
      eligible: false,
      approved: false,
      blocked: true,
      allowVirtualEntry: false,
      allowDiscord: false,
      blocksRiskEntry: true,
      reason: policy.policyBlockedReason,
      firstReason: policy.policyBlockedReason,
      reasons: policy.reasons
    };
  }

  if (veto.triggered) {
    return {
      ...base,
      status: STATUS_EMPIRICAL_VETO,
      eligible: false,
      approved: false,
      blocked: true,
      allowVirtualEntry: false,
      allowDiscord: false,
      blocksRiskEntry: true,
      reason: veto.empiricalVetoReason,
      firstReason: veto.empiricalVetoReason,
      reasons: [veto.empiricalVetoReason]
    };
  }

  if (completed < MIN_DISCORD_ACTIVATION_COMPLETED) {
    return {
      ...base,
      status: STATUS_OBSERVING,
      eligible: false,
      approved: false,
      blocked: false,
      allowVirtualEntry: true,
      allowDiscord: false,
      blocksRiskEntry: false,
      reason: `COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`,
      firstReason: `COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`,
      reasons: [`COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`]
    };
  }

  const failedReasons = [];

  if (!checks.avgROk) failedReasons.push('AVG_R_NET_NOT_POSITIVE');
  if (!checks.totalROk) failedReasons.push('TOTAL_R_NET_NOT_POSITIVE');
  if (!checks.profitFactorOk) failedReasons.push('PROFIT_FACTOR_NOT_ABOVE_1');
  if (!checks.lcb95AvgROk) failedReasons.push('LCB95_AVG_R_NOT_POSITIVE');
  if (!checks.avgCostROk) failedReasons.push('AVG_COST_R_TOO_HIGH');
  if (!checks.directSLOk) failedReasons.push('DIRECT_SL_PCT_TOO_HIGH');

  if (failedReasons.length > 0) {
    return {
      ...base,
      status: STATUS_REJECTED,
      eligible: false,
      approved: false,
      blocked: true,
      allowVirtualEntry: false,
      allowDiscord: false,
      blocksRiskEntry: true,
      reason: failedReasons[0],
      firstReason: failedReasons[0],
      reasons: failedReasons
    };
  }

  return {
    ...base,
    status: STATUS_PASSED,
    eligible: true,
    approved: true,
    blocked: false,
    allowVirtualEntry: true,
    allowDiscord: true,
    blocksRiskEntry: false,
    reason: 'PASSED_NET_EDGE_GATE',
    firstReason: null,
    reasons: []
  };
}

function proofTierFromGateAndMarket(gate = {}, marketCell = {}) {
  if (gate.status === STATUS_POLICY_BLOCKED) return PROOF_TIER_POLICY_BLOCKED;
  if (gate.status === STATUS_EMPIRICAL_VETO) return PROOF_TIER_EMPIRICAL_VETO;
  if (gate.status !== STATUS_PASSED) return PROOF_TIER_OBSERVATION_ONLY;

  if (marketCell.marketResolution === 'REGIME_TREND') return PROOF_TIER_MICRO_MICRO_MARKET;
  if (marketCell.marketResolution === 'LIFETIME') return PROOF_TIER_MICRO_MICRO_LIFETIME;

  return PROOF_TIER_OBSERVATION_ONLY;
}

function buildCurrentMarketCandidate(row = {}, currentMarket = {}) {
  const gate = microMicroRuntimeGate(row);
  const marketCell = selectWeatherAccumulator(row, currentMarket);
  const accumulator = marketCell.accumulator || row;

  const cellAvgR = hasValue(accumulator.avgR) ? num(accumulator.avgR, 0) : avgR(accumulator);
  const cellTotalR = hasValue(accumulator.totalR) ? num(accumulator.totalR, 0) : totalR(accumulator);
  const cellCompleted = hasValue(accumulator.completed) ? num(accumulator.completed, 0) : completedSample(accumulator);
  const cellProfitFactor = hasValue(accumulator.profitFactor) ? num(accumulator.profitFactor, 0) : profitFactor(accumulator);
  const cellAvgCostR = hasValue(accumulator.avgCostR) ? num(accumulator.avgCostR, 0) : avgCostR(accumulator);
  const cellDirectSLPct = hasValue(accumulator.directSLPct) ? num(accumulator.directSLPct, 0) : directSLPct(accumulator);

  const shrunkLCB95AvgR = firstFinite(
    row.finalShrunkLCB95AvgR,
    row.shrunkLCB95AvgR,
    row.shrunkLcb95AvgR,
    row.shrunkAvgRLCB95,
    accumulator.finalShrunkLCB95AvgR,
    accumulator.shrunkLCB95AvgR,
    accumulator.lcb95AvgR,
    accumulator.avgRLCB95,
    lcb95AvgR(accumulator),
    lcb95AvgR(row),
    cellAvgR
  ) ?? 0;

  const shrunkAvgR = firstFinite(
    row.finalShrunkAvgR,
    row.shrunkAvgR,
    accumulator.finalShrunkAvgR,
    accumulator.shrunkAvgR,
    cellAvgR
  ) ?? 0;

  const proofTier = proofTierFromGateAndMarket(gate, marketCell);

  let signalType = SIGNAL_TYPE_OBSERVE_ONLY;
  let reason = 'OBSERVE_ONLY_BEST_AVAILABLE_CANDIDATE';

  if (!currentMarket.currentMarketWeatherAvailable) {
    signalType = SIGNAL_TYPE_OBSERVE_ONLY;
    reason = 'MARKET_WEATHER_UNKNOWN';
  } else if (gate.status === STATUS_POLICY_BLOCKED) {
    signalType = SIGNAL_TYPE_BLOCKED;
    reason = gate.reason || 'POLICY_BLOCKED';
  } else if (gate.status === STATUS_EMPIRICAL_VETO) {
    signalType = SIGNAL_TYPE_BLOCKED;
    reason = 'EXACT_MICRO_MICRO_LCB95_NEGATIVE';
  } else if (gate.status === STATUS_REJECTED) {
    signalType = SIGNAL_TYPE_BLOCKED;
    reason = gate.reason || 'REJECTED_NET_EDGE';
  } else if (gate.status === STATUS_OBSERVING) {
    signalType = SIGNAL_TYPE_OBSERVE_ONLY;
    reason = gate.reason || 'OBSERVE_ONLY_NOT_ENOUGH_COMPLETED_OUTCOMES';
  } else if (shrunkLCB95AvgR <= 0) {
    signalType = SIGNAL_TYPE_OBSERVE_ONLY;
    reason = 'OBSERVE_ONLY_NO_POSITIVE_SHRUNK_LCB95';
  } else if (marketCell.marketResolution !== 'REGIME_TREND') {
    signalType = SIGNAL_TYPE_WATCH_ONLY;
    reason = 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER';
  } else if (!marketCell.weatherMatched || !marketCell.playbookFresh) {
    signalType = SIGNAL_TYPE_WATCH_ONLY;
    reason = 'PLAYBOOK_MISSING_OR_STALE_FOR_CONFIRMED_WEATHER';
  } else {
    signalType = SIGNAL_TYPE_TRADE_READY;
    reason = 'TRADE_READY_OBSERVE_MODE_VALIDATED_FOR_CURRENT_MARKET';
  }

  const riskFractionForEntry =
    signalType === SIGNAL_TYPE_TRADE_READY &&
    gate.status === STATUS_PASSED &&
    currentMarket.currentMarketWeatherAvailable &&
    marketCell.marketResolution === 'REGIME_TREND' &&
    marketCell.weatherMatched &&
    marketCell.playbookFresh &&
    shrunkLCB95AvgR > 0
      ? round(0.001, 6)
      : 0;

  const finalSignalType =
    signalType === SIGNAL_TYPE_TRADE_READY && riskFractionForEntry > 0
      ? SIGNAL_TYPE_TRADE_READY
      : signalType === SIGNAL_TYPE_TRADE_READY
        ? SIGNAL_TYPE_OBSERVE_ONLY
        : signalType;

  const selectedFamilyId = getExplicitMicroMicroId(row, row.key);

  const currentMarketScore =
    shrunkLCB95AvgR * 180 +
    shrunkAvgR * 100 +
    cellTotalR * 2 +
    Math.log1p(Math.max(0, cellCompleted)) * 5 +
    Math.log1p(Math.max(0, cellProfitFactor)) * 10 -
    cellAvgCostR * 30 -
    cellDirectSLPct * 70;

  return {
    ...currentMarket,

    selectedFamilyId,
    selectedMicroMicroFamilyId: selectedFamilyId,

    familyResolution: marketCell.familyResolution,
    marketResolution: marketCell.marketResolution,
    proofSource: marketCell.proofSource,
    proofTier,

    signalType: finalSignalType,
    maxAllowedRiskBand:
      finalSignalType === SIGNAL_TYPE_TRADE_READY
        ? MAX_ALLOWED_RISK_BAND_HIGH
        : MAX_ALLOWED_RISK_BAND_ZERO,

    shrunkAvgR: round(shrunkAvgR, 6),
    shrunkLCB95AvgR: round(shrunkLCB95AvgR, 6),

    currentMarketCellCompleted: round(cellCompleted, 4),
    currentMarketCellAvgR: round(cellAvgR, 6),
    currentMarketCellTotalR: round(cellTotalR, 4),
    currentMarketCellProfitFactor: round(cellProfitFactor, 4),
    currentMarketCellAvgCostR: round(cellAvgCostR, 4),
    currentMarketCellDirectSLPct: round(cellDirectSLPct, 4),
    currentMarketScore: round(currentMarketScore, 4),

    weatherMatched: marketCell.weatherMatched,
    playbookFresh: marketCell.playbookFresh,
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    fdrPassed: true,

    empiricalVeto: gate.status === STATUS_EMPIRICAL_VETO,
    empiricalVetoReason: gate.status === STATUS_EMPIRICAL_VETO
      ? gate.reason
      : null,

    policyBlocked: gate.status === STATUS_POLICY_BLOCKED,
    policyBlockedReason: gate.status === STATUS_POLICY_BLOCKED
      ? gate.reason
      : null,

    riskFraction: riskFractionForEntry,
    riskFractionForEntry,
    riskSourceOfTruth: 'riskFractionForEntry',

    selectorObserveOnly: true,
    sizingCapObserveOnly: true,
    fdrObserveOnly: true,
    discordTradeReadyHardLiveEnabled: false,

    reason,

    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };
}

function microMicroStatusRank(row = {}) {
  const status = upper(row.microMicroRuntimeStatus || row.microMicroStatus || microMicroRuntimeGate(row).status);
  return STATUS_RANK[status] ?? STATUS_RANK.UNKNOWN;
}

function netEdgeScore(row = {}) {
  const gate = microMicroRuntimeGate(row);
  const reliability = sampleReliability(gate.completed, 100);
  const cappedPf = Math.min(Math.max(0, gate.profitFactor), 10);

  const statusBoost =
    gate.status === STATUS_PASSED
      ? 100000
      : gate.status === STATUS_OBSERVING
        ? 1000
        : gate.status === STATUS_REJECTED
          ? -100000
          : gate.status === STATUS_EMPIRICAL_VETO
            ? -150000
            : gate.status === STATUS_POLICY_BLOCKED
              ? -200000
              : 0;

  return (
    statusBoost +
    gate.avgR * 120 +
    gate.totalR * 1.5 +
    gate.lcb95AvgR * 160 +
    cappedPf * 12 +
    reliability * 25 -
    gate.avgCostR * 45 -
    gate.directSLPct * 90
  );
}

function compareBestMicroMicroRows(a = {}, b = {}) {
  const ga = microMicroRuntimeGate(a);
  const gb = microMicroRuntimeGate(b);

  return (
    microMicroStatusRank(a) - microMicroStatusRank(b) ||
    netEdgeScore(b) - netEdgeScore(a) ||
    gb.lcb95AvgR - ga.lcb95AvgR ||
    gb.avgR - ga.avgR ||
    gb.totalR - ga.totalR ||
    gb.profitFactor - ga.profitFactor ||
    ga.avgCostR - gb.avgCostR ||
    ga.directSLPct - gb.directSLPct ||
    gb.completed - ga.completed ||
    gb.observed - ga.observed ||
    num(b.adaptiveScore, 0) - num(a.adaptiveScore, 0) ||
    num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
    String(a.trueMicroFamilyId || a.id || '').localeCompare(String(b.trueMicroFamilyId || b.id || ''))
  );
}

function compareCurrentMarketRows(a = {}, b = {}) {
  const signalA = SIGNAL_RANK[upper(a.signalType)] ?? SIGNAL_RANK.UNKNOWN;
  const signalB = SIGNAL_RANK[upper(b.signalType)] ?? SIGNAL_RANK.UNKNOWN;

  return (
    signalA - signalB ||
    num(b.shrunkLCB95AvgR, 0) - num(a.shrunkLCB95AvgR, 0) ||
    num(b.shrunkAvgR, 0) - num(a.shrunkAvgR, 0) ||
    num(b.currentMarketScore, 0) - num(a.currentMarketScore, 0) ||
    compareBestMicroMicroRows(a, b)
  );
}

function discordActivationGate(row = {}) {
  const gate = microMicroRuntimeGate(row);

  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    eligible: gate.status === STATUS_PASSED,
    blocked: gate.status !== STATUS_PASSED,
    reason: gate.status === STATUS_PASSED
      ? 'DISCORD_ACTIVATION_ELIGIBLE_NET_EDGE_CONFIRMED'
      : gate.reason,
    reasons: gate.reasons,
    status: gate.status,

    id: gate.id,
    completed: gate.completed,
    observed: gate.observed,
    avgR: gate.avgR,
    totalR: gate.totalR,
    profitFactor: gate.profitFactor,
    lcb95AvgR: gate.lcb95AvgR,
    avgCostR: gate.avgCostR,
    directSLPct: gate.directSLPct,
    currentFit: gate.currentFit,
    currentFitScore: gate.currentFitScore,
    currentFitMisfitIsPolicyBlock: false,
    confirmationProfile: gate.confirmationProfile,

    empiricalVeto: gate.status === STATUS_EMPIRICAL_VETO,
    policyBlocked: gate.status === STATUS_POLICY_BLOCKED,

    thresholds: activationGateConfig()
  };
}

function normalizeRotationRow(row = {}, index = 0, activeSet = new Set(), currentMarket = null) {
  const id = getExplicitMicroMicroId(row, row.key);
  if (!id || !isSelectableMicroMicroId(id)) return null;
  if (!isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id })) return null;

  const parsed = parseShortTaxonomyMicroId(id);
  const wr = sampleAdjustedWinrate(row);
  const fit = getShortCurrentFit(row);
  const completed = completedSample(row);
  const observed = observationSample(row);
  const bScore = balancedScore(row, wr);
  const weatherFields = entryMarketWeatherFields(row, currentMarket);

  const gate = microMicroRuntimeGate({
    ...row,
    id,
    key: id,
    trueMicroFamilyId: id,
    microMicroFamilyId: id
  });

  const discordGate = discordActivationGate({
    ...row,
    id,
    key: id,
    trueMicroFamilyId: id,
    microMicroFamilyId: id
  });

  const currentMarketCandidate = currentMarket
    ? buildCurrentMarketCandidate({
        ...row,
        id,
        key: id,
        trueMicroFamilyId: id,
        microMicroFamilyId: id
      }, currentMarket)
    : null;

  const netStats = normalizedNetStats(row);

  return {
    ...row,

    rank: index + 1,

    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMicroFamilyId: parsed.parentTrueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroHash: parsed.microMicroHash,
    microMicroContext: parsed.microMicroContext,

    ...modeFlags(),
    ...weatherFields,
    ...(currentMarketCandidate || {}),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: gate.status === STATUS_PASSED,
    selectableMicroMicroFamily: gate.status === STATUS_PASSED,
    selectable75Child: false,
    selectableParent: false,

    learningLayer: 'MICRO_MICRO',
    selectionLayer: 'MICRO_MICRO',
    selectableLayer: 'MICRO_MICRO',
    inferredTradeSide: TARGET_TRADE_SIDE,

    schema: row.schema || row.microFamilySchema || MICRO_MICRO_SCHEMA,
    microFamilySchema: row.microFamilySchema || row.schema || MICRO_MICRO_SCHEMA,

    isTrueMicro: true,
    isChildTrueMicro: false,
    isMicroMicro: true,
    isBase75Child: false,

    active: Boolean(row.active || activeSet.has(id)),

    seen: num(row.seen, 0),
    observed: num(row.observed, 0),
    observations: num(row.observations, 0),

    completed: round(completed, 4),
    virtualCompleted: round(row.virtualCompleted, 4),
    shadowCompleted: round(row.shadowCompleted, 4),
    realCompleted: 0,

    outcomeSample: round(completed, 4),
    observationSample: round(observed, 4),
    awaitingOutcomes: completed <= 0 && observed > 0,

    learningStatus:
      gate.status === STATUS_PASSED
        ? 'MICRO_MICRO_PASSED'
        : gate.status === STATUS_OBSERVING
          ? 'MICRO_MICRO_OBSERVING'
          : gate.status === STATUS_REJECTED
            ? 'MICRO_MICRO_REJECTED'
            : gate.status === STATUS_EMPIRICAL_VETO
              ? 'MICRO_MICRO_EMPIRICAL_VETO'
              : 'MICRO_MICRO_POLICY_BLOCKED',

    status:
      gate.status === STATUS_PASSED
        ? 'MICRO_MICRO_PASSED'
        : gate.status === STATUS_OBSERVING
          ? 'MICRO_MICRO_OBSERVING'
          : gate.status === STATUS_REJECTED
            ? 'MICRO_MICRO_REJECTED'
            : gate.status === STATUS_EMPIRICAL_VETO
              ? 'MICRO_MICRO_EMPIRICAL_VETO'
              : 'MICRO_MICRO_POLICY_BLOCKED',

    tooEarly: completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING
      ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING}`
      : null,

    minCompletedForActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    microMicroMinCompletedForActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,

    wins: round(wr.wins, 4),
    losses: round(wr.losses, 4),
    flats: round(wr.flats, 4),

    winrate: round(wr.rawWinrate, 4),
    bayesianWinrate: round(wr.bayesianWinrate, 4),
    wilsonLowerBound: round(wr.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleReliability: round(row.sampleReliability ?? wr.reliability, 4),

    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),
    lcb95AvgR: round(lcb95AvgR(row), 6),
    avgRLCB95: round(lcb95AvgR(row), 6),
    standaloneMicroMicroLifetimeLCB95AvgR: round(lcb95AvgR(row), 6),
    profitFactor: round(profitFactor(row), 4),

    directSLCount: round(directSLCount(row), 4),
    directSLPct: round(directSLPct(row), 4),

    totalCostR: round(totalCostR(row), 4),
    avgCostR: round(avgCostR(row), 4),

    netRStatsSourceOfTruth: true,
    netRStatsPresent: Boolean(statsObject(row)),
    netRStatsSource: netStats?.source || null,
    recentOutcomesFallbackUsed: netStats?.source === 'RECENT_OUTCOMES_FALLBACK',

    balancedScore: round(row.balancedScore ?? bScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? bScore, 4),
    adaptiveScore: round(row.adaptiveScore ?? row.microMicroScore ?? bScore + fit.score * 0.15, 4),
    netEdgeScore: round(netEdgeScore({ ...row, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id }), 4),
    bestMicroMicroScore: round(netEdgeScore({ ...row, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id }), 4),

    currentFit: fit.label,
    currentFitLabel: fit.label,
    currentFitScore: round(fit.score, 4),
    fitScore: round(fit.score, 4),
    currentFitSource: fit.source,
    currentFitBlocksLearning: false,
    currentFitBlocksDiscordOnly: fit.label === 'MISFIT',
    currentFitMisfitIsPolicyBlock: false,
    discordCurrentFitAllowed: fit.label !== 'MISFIT',

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    microMicroRuntimeGate: gate,
    microMicroStatus: gate.status,
    microMicroRuntimeStatus: gate.status,
    microMicroRuntimeEligible: gate.status === STATUS_PASSED,
    microMicroRuntimeBlocked: gate.blocked,
    microMicroRuntimeReason: gate.reason,
    microMicroRuntimeReasons: gate.reasons,

    microMicroPassed: gate.status === STATUS_PASSED,
    microMicroObserving: gate.status === STATUS_OBSERVING,
    microMicroRejected: gate.status === STATUS_REJECTED,
    microMicroEmpiricalVeto: gate.status === STATUS_EMPIRICAL_VETO,
    microMicroPolicyBlocked: gate.status === STATUS_POLICY_BLOCKED,

    empiricalVeto: gate.status === STATUS_EMPIRICAL_VETO,
    empiricalVetoReason: gate.status === STATUS_EMPIRICAL_VETO ? gate.reason : null,
    empiricalVetoGate: gate.empiricalVetoGate,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

    policyBlocked: gate.status === STATUS_POLICY_BLOCKED,
    policyBlockedReason: gate.status === STATUS_POLICY_BLOCKED ? gate.reason : null,

    allowVirtualEntry: gate.allowVirtualEntry,
    virtualEntryAllowedByMicroMicroGate: gate.allowVirtualEntry,
    virtualEntryBlockedByMicroMicroGate: !gate.allowVirtualEntry,
    virtualEntryBlockedReason: gate.allowVirtualEntry ? null : gate.reason,

    eligibleForBestList: gate.status === STATUS_PASSED,
    observingForLearning: gate.status === STATUS_OBSERVING,
    rejectedForLearning: gate.status === STATUS_REJECTED,
    empiricalVetoForLearning: gate.status === STATUS_EMPIRICAL_VETO,
    policyBlockedForLearning: gate.status === STATUS_POLICY_BLOCKED,

    discordActivationEligible: discordGate.eligible,
    discordActivationBlocked: discordGate.blocked,
    discordActivationReason: discordGate.reason,
    discordActivationBlockedReason: discordGate.blocked ? discordGate.reason : null,
    discordActivationBlockedReasons: discordGate.reasons,
    discordActivationGate: discordGate,

    activationEligible: discordGate.eligible,
    activationBlocked: discordGate.blocked,
    activationBlockedReason: discordGate.blocked ? discordGate.reason : null,

    runtimeGateApproved: discordGate.eligible,
    runtimeDiscordGateApproved: discordGate.eligible,
    discordRuntimeGateApproved: discordGate.eligible,
    exitAlertRuntimeGateApproved: discordGate.eligible,

    activeRotationRuntimeGateVersion: ACTIVE_ROTATION_RUNTIME_GATE_VERSION,
    activeRotationRuntimeGateApproved: discordGate.eligible,
    activeRotationRuntimeGateBlocked: discordGate.blocked,
    activeRotationRuntimeGateReason: discordGate.blocked ? discordGate.reason : null,
    activeRotationRuntimeGateReasons: discordGate.reasons,

    selectedTier: gate.status,
    rotationEligibilityTier: gate.status,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || parsed.microMicroHash || null,
    executionFingerprintParts: getArray(row.executionFingerprintParts),

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    persistentLearningOnly: true,
    requestedWeekKeyIgnored: true,

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    costModelVersion: row.costModelVersion || row.positionCostModelVersion || POSITION_COST_MODEL_VERSION,
    measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: row.observationDedupeVersion || OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: row.outcomeDedupeVersion || OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: row.adaptiveUiVersion || ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function buildAvailableRowsFromMicros(micros = {}, activeSet = new Set(), currentMarket = null) {
  const rows = [];
  const ignoredLayerCounts = {
    parent15: 0,
    child75: 0,
    scanner: 0,
    executionFingerprint: 0,
    long: 0,
    unknown: 0
  };

  let processed = 0;

  for (const [key, row] of sourceEntries(micros)) {
    // Stop na max aantal rijen om overbelasting te voorkomen
    if (processed >= MAX_SOURCE_MICRO_ROWS) {
      // voeg warning toe via rows property (later opgevangen)
      rows._truncated = true;
      break;
    }

    if (!row || typeof row !== 'object') continue;
    processed += 1;

    const id = getExplicitMicroMicroId({ ...row, key }, key);

    if (!id) {
      const parsed = firstParsed([
        key,
        row.trueMicroFamilyId,
        row.microFamilyId,
        row.childTrueMicroFamilyId,
        row.parentTrueMicroFamilyId
      ]) || invalidParsed(key);

      if (inferTradeSide({ ...row, key }) === OPPOSITE_TRADE_SIDE || parsed.reason === 'LONG_DISABLED_SHORT_ONLY') {
        ignoredLayerCounts.long += 1;
      } else if (isScannerFingerprintId(key)) {
        ignoredLayerCounts.scanner += 1;
      } else if (isExecutionFingerprintId(key)) {
        ignoredLayerCounts.executionFingerprint += 1;
      } else if (parsed.isParent) {
        ignoredLayerCounts.parent15 += 1;
      } else if (parsed.isChild) {
        ignoredLayerCounts.child75 += 1;
      } else {
        ignoredLayerCounts.unknown += 1;
      }

      continue;
    }

    const normalized = normalizeRotationRow({
      ...row,
      key,
      id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      microMicroFamilyId: id,
      trueMicroMicroFamilyId: id,
      exactMicroMicroFamilyId: id,
      generatedMicroMicroFromChild75: false,
      child75ProxySelectionDisabled: true,
      microMicroStatsSource: 'EXPLICIT_MICRO_MICRO_ROW',
      sourceWeekKey: PERSISTENT_LEARNING_KEY,
      sourceWeekPrimary: true,
      active: activeSet.has(id)
    }, rows.length, activeSet, currentMarket);

    if (normalized) rows.push(normalized);
  }

  const seen = new Set();

  const output = rows
    .filter((row) => {
      const key = row.trueMicroFamilyId;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(currentMarket ? compareCurrentMarketRows : compareBestMicroMicroRows);

  output.ignoredLayerCounts = ignoredLayerCounts;
  output._truncated = Boolean(rows._truncated);

  return output;
}

function getCachedWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const cached = cache.weekMicros.get(weekKey);

  if (cached && now() - cached.ts <= CACHE_TTL_MS) {
    return cached.micros || {};
  }

  return null;
}

async function getWeekMicrosCached(weekKey = PERSISTENT_LEARNING_KEY, timeoutMs = WEEK_MICROS_TIMEOUT_MS) {
  const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
  const cached = getCachedWeekMicros(PERSISTENT_LEARNING_KEY);

  if (cached) {
    return {
      requestedWeekKey,
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
      micros: cached,
      cacheHit: true,
      stale: false,
      warning: null
    };
  }

  try {
    const micros = await withTimeout(
      getWeekMicros(PERSISTENT_LEARNING_KEY),
      timeoutMs,
      'GET_WEEK_MICROS_TIMEOUT'
    );

    const safeMicros = micros && typeof micros === 'object' ? micros : {};

    cache.weekMicros.set(PERSISTENT_LEARNING_KEY, {
      ts: now(),
      micros: safeMicros
    });

    while (cache.weekMicros.size > CACHE_MAX_KEYS) {
      cache.weekMicros.delete(cache.weekMicros.keys().next().value);
    }

    return {
      requestedWeekKey,
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
      micros: safeMicros,
      cacheHit: false,
      stale: false,
      warning: null
    };
  } catch (error) {
    const stale = cache.weekMicros.get(PERSISTENT_LEARNING_KEY);

    if (stale?.micros) {
      return {
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
        micros: stale.micros,
        cacheHit: true,
        stale: true,
        warning: error?.message || String(error)
      };
    }

    return {
      requestedWeekKey,
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
      micros: {},
      cacheHit: false,
      stale: false,
      warning: error?.message || String(error)
    };
  }
}

async function getActiveRotationCached() {
  const cached = cache.activeRotation;

  if (cached && now() - cached.ts <= CACHE_TTL_MS) {
    return {
      value: cached.value,
      cacheHit: true,
      warning: null
    };
  }

  try {
    const value = await withTimeout(
      getActiveRotation(rotationOptions()),
      ACTIVE_ROTATION_TIMEOUT_MS,
      'GET_ACTIVE_ROTATION_TIMEOUT'
    );

    cache.activeRotation = {
      ts: now(),
      value
    };

    return {
      value,
      cacheHit: false,
      warning: null
    };
  } catch (error) {
    if (cached?.value) {
      return {
        value: cached.value,
        cacheHit: true,
        warning: error?.message || String(error)
      };
    }

    return {
      value: null,
      cacheHit: false,
      warning: error?.message || String(error)
    };
  }
}

async function loadAvailableRows({
  weekKey,
  limit = DEFAULT_AVAILABLE_LIMIT,
  activeSet = new Set(),
  currentMarket = null,
  weekMicrosResult = null
} = {}) {
  const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
  const weekResult = weekMicrosResult || await getWeekMicrosCached(PERSISTENT_LEARNING_KEY);
  const allRows = buildAvailableRowsFromMicros(weekResult.micros || {}, activeSet, currentMarket);
  const rows = allRows.slice(0, limit);

  const truncated = Boolean(allRows._truncated);

  return {
    requestedWeekKey,
    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningOnly: true,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
    currentRows: sourceEntries(weekResult.micros || {}).length,
    previousRows: 0,
    mergedRows: rows.length,
    ignoredLayerCounts: allRows.ignoredLayerCounts || {},
    activationEligibleRows: allRows.filter((row) => row.microMicroRuntimeStatus === STATUS_PASSED).length,
    activationBlockedRows: allRows.filter((row) => row.microMicroRuntimeStatus !== STATUS_PASSED).length,
    rows,
    weekMicrosCacheHit: Boolean(weekResult.cacheHit),
    weekMicrosCacheStale: Boolean(weekResult.stale),
    warning: weekResult.warning || (truncated ? `TRUNCATED_AT_${MAX_SOURCE_MICRO_ROWS}_ROWS` : null),
    truncated
  };
}

function normalizeActiveRotationObject(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;
  return rotation.activeRotation || rotation.active || rotation.rotation || rotation;
}

function extractIdsFromRotation(rotation = {}) {
  const activeRotation = normalizeActiveRotationObject(rotation) || {};

  const rows = [
    ...getArray(activeRotation.microFamilies),
    ...getArray(activeRotation.rows),
    ...getArray(activeRotation.activeRows),
    ...getArray(activeRotation.selectedRows)
  ];

  return uniqueStrings([
    activeRotation.microMicroFamilyIds || [],
    activeRotation.trueMicroMicroFamilyIds || [],
    activeRotation.exactMicroMicroFamilyIds || [],
    activeRotation.activeMicroMicroFamilyIds || [],
    activeRotation.activeTrueMicroMicroFamilyIds || [],
    activeRotation.activeExactMicroMicroFamilyIds || [],
    activeRotation.selectedMicroMicroFamilyIds || [],
    activeRotation.selectedTrueMicroMicroFamilyIds || [],
    activeRotation.selectedExactMicroMicroFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    rows.map((row) => getExplicitMicroMicroId(row, row?.key))
  ])
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractLegacyActiveChild75Ids(rotation = {}) {
  const activeRotation = normalizeActiveRotationObject(rotation) || {};

  const rows = [
    ...getArray(activeRotation.microFamilies),
    ...getArray(activeRotation.rows),
    ...getArray(activeRotation.activeRows),
    ...getArray(activeRotation.selectedRows)
  ];

  return uniqueStrings([
    activeRotation.childTrueMicroFamilyIds || [],
    activeRotation.active75ChildFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    rows.map((row) => row?.childTrueMicroFamilyId || row?.base75ChildTrueMicroFamilyId || row?.trueMicroFamilyId)
  ]).filter(isFixedShortChild75Id);
}

function extractParentIdsFromIds(ids = []) {
  return uniqueStrings(ids.map(getParentTrueMicroFamilyIdFromId).filter(Boolean))
    .filter(isFixedShortParentMicroId);
}

function rowMapFromMicros(micros = {}, currentMarket = null) {
  const rows = buildAvailableRowsFromMicros(micros || {}, new Set(), currentMarket);
  return new Map(rows.map((row) => [row.trueMicroFamilyId, row]));
}

function manualActiveRowFromId(id, index = 0, activeSet = new Set(), currentMarket = null) {
  if (!id || !isSelectableMicroMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  return normalizeRotationRow({
    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    active: true,
    selectedTier: STATUS_OBSERVING,
    rotationEligibilityTier: STATUS_OBSERVING,
    microMicroStatsSource: 'MANUAL_ACTIVE_MICRO_MICRO_ID_WITHOUT_STATS_BLOCKED_UNTIL_GATE_PASS'
  }, index, activeSet, currentMarket);
}

function compactActiveRotation(rotation = null, currentMarket = null, storedRowById = new Map()) {
  const activeRotation = normalizeActiveRotationObject(rotation);

  if (!activeRotation || typeof activeRotation !== 'object') {
    return {
      rotationId: null,
      ...modeFlags(),
      taxonomy: taxonomyMeta(),
      manualOnly: true,
      adminSelected: false,
      autoRotation: false,
      liveSelectable: false,
      empty: true,
      emptyReason: 'NO_MANUAL_SHORT_EXACT_MICRO_MICRO_SELECTION_ACTIVE',
      microFamilyIds: [],
      activeMicroFamilyIds: [],
      trueMicroFamilyIds: [],
      microMicroFamilyIds: [],
      trueMicroMicroFamilyIds: [],
      exactMicroMicroFamilyIds: [],
      activeMicroMicroFamilyIds: [],
      activeTrueMicroMicroFamilyIds: [],
      activeExactMicroMicroFamilyIds: [],
      selectedMicroMicroFamilyIds: [],
      selectedTrueMicroMicroFamilyIds: [],
      selectedExactMicroMicroFamilyIds: [],
      childTrueMicroFamilyIds: [],
      legacyChild75ActiveIdsIgnored: [],
      macroFamilyIds: [],
      activeMacroFamilyIds: [],
      parentTrueMicroFamilyIds: [],
      microFamilies: [],
      filteredBlockedMicroMicroIds: [],
      filteredBlockedMicroMicroRows: [],
      activeRotationBlockedFilteredCount: 0,
      activeRotationCleaned: false,
      count: 0,
      activeCount: 0,
      activeMicroMicroCount: 0,
      bestShort: null,
      bestLong: null,
      missingSides: [TARGET_TRADE_SIDE]
    };
  }

  const requestedActiveMicroMicroFamilyIds = extractIdsFromRotation(activeRotation);
  const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotation);
  const requestedSet = new Set(requestedActiveMicroMicroFamilyIds);

  const sourceRows = [
    ...getArray(activeRotation.microFamilies),
    ...getArray(activeRotation.rows),
    ...getArray(activeRotation.activeRows),
    ...getArray(activeRotation.selectedRows)
  ];

  const rows = [];
  const rejectedRows = [];
  const existing = new Set();

  for (const row of sourceRows) {
    const id = getExplicitMicroMicroId(row, row?.key);
    if (!id || !requestedSet.has(id) || existing.has(id)) continue;

    const stored = storedRowById.get(id) || {};
    const normalized = normalizeRotationRow(
      {
        ...stored,
        ...row,
        active: true,
        id,
        key: id,
        trueMicroFamilyId: id,
        microMicroFamilyId: id
      },
      rows.length,
      requestedSet,
      currentMarket
    );

    if (!normalized) {
      rejectedRows.push({
        id,
        reason: 'ACTIVE_ROW_COULD_NOT_NORMALIZE_TO_EXACT_MICRO_MICRO'
      });
      existing.add(id);
      continue;
    }

    if (normalized.microMicroRuntimeStatus !== STATUS_PASSED) {
      rejectedRows.push({
        id,
        reason: normalized.microMicroRuntimeReason || 'MICRO_MICRO_RUNTIME_GATE_REJECTED',
        reasons: normalized.microMicroRuntimeReasons || [],
        status: normalized.microMicroRuntimeStatus,
        microMicroRuntimeGate: normalized.microMicroRuntimeGate || null,
        discordActivationGate: normalized.discordActivationGate || null,
        row: normalized
      });
      existing.add(id);
      continue;
    }

    rows.push(normalized);
    existing.add(id);
  }

  for (const id of requestedActiveMicroMicroFamilyIds) {
    if (existing.has(id)) continue;

    const stored = storedRowById.get(id) || null;
    const manualRow = stored
      ? normalizeRotationRow({ ...stored, active: true }, rows.length, requestedSet, currentMarket)
      : manualActiveRowFromId(id, rows.length, requestedSet, currentMarket);

    if (!manualRow) {
      rejectedRows.push({
        id,
        reason: 'MANUAL_ACTIVE_ID_COULD_NOT_BUILD_ROW'
      });
      existing.add(id);
      continue;
    }

    if (manualRow.microMicroRuntimeStatus !== STATUS_PASSED) {
      rejectedRows.push({
        id,
        reason: manualRow.microMicroRuntimeReason || 'MICRO_MICRO_RUNTIME_GATE_REJECTED',
        reasons: manualRow.microMicroRuntimeReasons || [],
        status: manualRow.microMicroRuntimeStatus,
        microMicroRuntimeGate: manualRow.microMicroRuntimeGate || null,
        discordActivationGate: manualRow.discordActivationGate || null,
        row: manualRow
      });
      existing.add(id);
      continue;
    }

    rows.push(manualRow);
    existing.add(id);
  }

  rows.sort(currentMarket ? compareCurrentMarketRows : compareBestMicroMicroRows);

  const activeMicroMicroFamilyIds = rows
    .map((row) => row.trueMicroFamilyId)
    .filter(Boolean)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  const activeParentIds = extractParentIdsFromIds(activeMicroMicroFamilyIds);
  const childIds = uniqueStrings(activeMicroMicroFamilyIds.map(getChildTrueMicroFamilyIdFromId).filter(Boolean));

  const emptyReason =
    requestedActiveMicroMicroFamilyIds.length > 0 && activeMicroMicroFamilyIds.length === 0
      ? 'ACTIVE_ROTATION_ALL_SELECTED_MICRO_MICROS_BLOCKED_BY_RUNTIME_GATE'
      : 'NO_MANUAL_SHORT_EXACT_MICRO_MICRO_SELECTION_ACTIVE';

  return {
    rotationId: activeRotation.rotationId || activeRotation.id || null,
    source: activeRotation.source || null,
    mode: activeRotation.mode || null,
    sourceWeekKey: activeRotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: activeRotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
    generatedAt: activeRotation.generatedAt || null,
    activatedAt: activeRotation.activatedAt || null,

    ...modeFlags(),
    taxonomy: taxonomyMeta(),

    manualOnly: true,
    adminSelected: Boolean(activeRotation.adminSelected || activeRotation.manualOnly || activeMicroMicroFamilyIds.length),
    autoRotation: false,
    liveSelectable: activeMicroMicroFamilyIds.length > 0,

    empty: activeMicroMicroFamilyIds.length === 0,
    emptyReason: activeMicroMicroFamilyIds.length === 0 ? emptyReason : null,

    requestedActiveMicroMicroFamilyIds,
    filteredBlockedMicroMicroIds: rejectedRows.map((row) => row.id).filter(Boolean),
    filteredBlockedMicroMicroRows: rejectedRows,
    activeRotationBlockedFilteredCount: rejectedRows.length,
    activeRotationCleaned: rejectedRows.length > 0,
    activeRotationFilteredBlockedRedisSelections: rejectedRows.length > 0,

    microFamilyIds: activeMicroMicroFamilyIds,
    activeMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroFamilyIds: activeMicroMicroFamilyIds,

    microMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    exactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    activeMicroMicroFamilyIds,
    activeTrueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    activeExactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    selectedMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: activeMicroMicroFamilyIds,

    childTrueMicroFamilyIds: childIds,
    legacyChild75ActiveIdsIgnored,

    macroFamilyIds: activeParentIds,
    activeMacroFamilyIds: activeParentIds,
    parentTrueMicroFamilyIds: activeParentIds,

    microFamilies: rows,

    count: activeMicroMicroFamilyIds.length,
    activeCount: activeMicroMicroFamilyIds.length,
    activeMicroMicroCount: activeMicroMicroFamilyIds.length,
    activeChildTrueMicroCount: 0,

    bestShort: rows[0] || null,
    bestLong: null,
    missingSides: activeMicroMicroFamilyIds.length ? [] : [TARGET_TRADE_SIDE]
  };
}

function parseSelectedIds(body = {}) {
  const candidateIds = uniqueStrings([
    body.microMicroFamilyIds,
    body.trueMicroMicroFamilyIds,
    body.exactMicroMicroFamilyIds,
    body.activeMicroMicroFamilyIds,
    body.activeTrueMicroMicroFamilyIds,
    body.activeExactMicroMicroFamilyIds,
    body.selectedMicroMicroFamilyIds,
    body.selectedTrueMicroMicroFamilyIds,
    body.selectedExactMicroMicroFamilyIds,
    body.microMicroFamilyId,
    body.trueMicroMicroFamilyId,
    body.exactMicroMicroFamilyId,
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids,
    body.id,
    body.microFamilyId,
    body.trueMicroFamilyId
  ]);

  const macroFamilyIds = uniqueStrings([
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.macroFamilyId,
    body.parentTrueMicroFamilyId,
    body.parentMicroFamilyId
  ]);

  const requestedIds = uniqueStrings([candidateIds, macroFamilyIds]);

  const normalizedCandidates = candidateIds
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId);

  const uniqueNormalized = uniqueStrings(normalizedCandidates);
  const acceptedIds = uniqueNormalized.slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  const ignoredRequestedIds = requestedIds
    .filter((id) => !acceptedIds.includes(parseShortTaxonomyMicroId(id).trueMicroFamilyId))
    .map((id) => {
      const parsed = parseShortTaxonomyMicroId(id);
      const side = inferTradeSide(id);
      const isMacroRequest = macroFamilyIds.includes(id) || parsed.isParent;

      return {
        id,
        normalizedId: parsed.trueMicroFamilyId || upper(id),
        reason: side === OPPOSITE_TRADE_SIDE || parsed.reason === 'LONG_DISABLED_SHORT_ONLY'
          ? 'LONG_DISABLED_SHORT_ONLY'
          : isMacroRequest
            ? 'PARENT_OR_MACRO_ID_REJECTED_EXACT_MICRO_MICRO_REQUIRED'
            : isScannerFingerprintId(id)
              ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
              : isExecutionFingerprintId(id)
                ? 'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE_USE_NORMALIZED_MM_ID'
                : parsed.isChild
                  ? 'CHILD75_ID_REJECTED_EXACT_MICRO_MICRO_REQUIRED'
                  : parsed.valid && !parsed.selectable
                    ? 'NON_SELECTABLE_SHORT_TAXONOMY_ID_REJECTED_EXACT_MICRO_MICRO_REQUIRED'
                    : 'UNKNOWN_OR_NON_SELECTABLE_SHORT_MICRO_ID_REJECTED'
      };
    });

  const childTrueMicroFamilyIds = uniqueStrings(
    acceptedIds.map(getChildTrueMicroFamilyIdFromId).filter(Boolean)
  );

  return {
    requestedIds,
    acceptedIds,
    microFamilyIds: acceptedIds,
    trueMicroFamilyIds: acceptedIds,
    microMicroFamilyIds: acceptedIds,
    trueMicroMicroFamilyIds: acceptedIds,
    exactMicroMicroFamilyIds: acceptedIds,
    activeMicroMicroFamilyIds: acceptedIds,
    activeTrueMicroMicroFamilyIds: acceptedIds,
    activeExactMicroMicroFamilyIds: acceptedIds,
    selectedMicroMicroFamilyIds: acceptedIds,
    selectedTrueMicroMicroFamilyIds: acceptedIds,
    selectedExactMicroMicroFamilyIds: acceptedIds,
    childTrueMicroFamilyIds,
    macroFamilyIds: [],
    requestedMacroFamilyIds: macroFamilyIds,
    ignoredRequestedIds,
    ignoredAboveLimitIds: uniqueNormalized.slice(MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES)
  };
}

function normalizeAction(body = {}) {
  const raw = String(body?.action || '').trim();
  if (raw) return raw;

  const ids = parseSelectedIds(body);
  return ids.acceptedIds.length > 0 ? 'activateSelectedMicroFamilies' : '';
}

function normalizeMode(value, fallback = 'manual') {
  const mode = String(value || fallback).trim();
  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function buildTierSummary(rows = []) {
  return rows.reduce((acc, row) => {
    const status = row.microMicroRuntimeStatus || microMicroRuntimeGate(row).status;

    acc.total += 1;
    acc[status] = (acc[status] || 0) + 1;
    acc.MICRO_MICRO += 1;

    return acc;
  }, {
    total: 0,
    MICRO_MICRO: 0,
    [STATUS_PASSED]: 0,
    [STATUS_OBSERVING]: 0,
    [STATUS_REJECTED]: 0,
    [STATUS_EMPIRICAL_VETO]: 0,
    [STATUS_POLICY_BLOCKED]: 0
  });
}

function layerCounts(rows = []) {
  return {
    parent15: 0,
    child75: 0,
    microMicro: rows.filter((row) => isSelectableMicroMicroId(row.trueMicroFamilyId || row.microMicroFamilyId)).length,
    unknown: 0
  };
}

function activationSummary(rows = []) {
  const passed = rows.filter((row) => row.microMicroRuntimeStatus === STATUS_PASSED);
  const observing = rows.filter((row) => row.microMicroRuntimeStatus === STATUS_OBSERVING);
  const rejected = rows.filter((row) => row.microMicroRuntimeStatus === STATUS_REJECTED);
  const empiricalVeto = rows.filter((row) => row.microMicroRuntimeStatus === STATUS_EMPIRICAL_VETO);
  const policyBlocked = rows.filter((row) => row.microMicroRuntimeStatus === STATUS_POLICY_BLOCKED);

  const blocked = rows.filter((row) => row.microMicroRuntimeStatus !== STATUS_PASSED);

  const reasons = blocked.reduce((acc, row) => {
    for (const reason of row.microMicroRuntimeReasons || [row.microMicroRuntimeReason || 'UNKNOWN']) {
      acc[reason] = (acc[reason] || 0) + 1;
    }

    return acc;
  }, {});

  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    bestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,

    total: rows.length,
    eligible: passed.length,
    passed: passed.length,
    observing: observing.length,
    rejected: rejected.length,
    empiricalVeto: empiricalVeto.length,
    policyBlocked: policyBlocked.length,
    blocked: blocked.length,

    eligibleIds: passed.map((row) => row.trueMicroFamilyId),
    topEligibleIds: passed
      .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES)
      .map((row) => row.trueMicroFamilyId),

    blockedReasonCounts: reasons,
    thresholds: activationGateConfig()
  };
}

function compactCandidate(row = {}) {
  return {
    selectedFamilyId: row.selectedFamilyId || row.trueMicroFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId,
    microMicroFamilyId: row.microMicroFamilyId,

    entryMarketWeatherKey: row.entryMarketWeatherKey,
    entryMarketWeatherRegime: row.entryMarketWeatherRegime,
    entryMarketWeatherTrendSide: row.entryMarketWeatherTrendSide,

    currentMarketWeatherKey: row.currentMarketWeatherKey,
    currentMarketWeatherRegime: row.currentMarketWeatherRegime,
    currentMarketWeatherTrendSide: row.currentMarketWeatherTrendSide,

    familyResolution: row.familyResolution,
    marketResolution: row.marketResolution,
    proofSource: row.proofSource,
    proofTier: row.proofTier,

    signalType: row.signalType,
    maxAllowedRiskBand: row.maxAllowedRiskBand,

    shrunkAvgR: row.shrunkAvgR,
    shrunkLCB95AvgR: row.shrunkLCB95AvgR,

    empiricalVeto: row.empiricalVeto,
    empiricalVetoReason: row.empiricalVetoReason,

    policyBlocked: row.policyBlocked,
    policyBlockedReason: row.policyBlockedReason,

    weatherMatched: row.weatherMatched,
    playbookFresh: row.playbookFresh,
    fdrPassed: row.fdrPassed,

    riskFraction: row.riskFraction,
    riskFractionForEntry: row.riskFractionForEntry,

    reason: row.reason,

    completed: row.completed,
    avgR: row.avgR,
    totalR: row.totalR,
    lcb95AvgR: row.lcb95AvgR,
    profitFactor: row.profitFactor,
    avgCostR: row.avgCostR,
    directSLPct: row.directSLPct,
    netRStatsSource: row.netRStatsSource
  };
}

function buildCurrentMarketPlaybook(rows = [], currentMarket = {}) {
  const candidates = rows
    .map((row) => ({
      ...row,
      ...buildCurrentMarketCandidate(row, currentMarket)
    }))
    .sort(compareCurrentMarketRows);

  const tradeReady = candidates.find((row) => row.signalType === SIGNAL_TYPE_TRADE_READY) || null;
  const watch = candidates.find((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY) || null;
  const observe = candidates.find((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY) || null;
  const blocked = candidates.find((row) => row.signalType === SIGNAL_TYPE_BLOCKED) || null;

  const selected =
    tradeReady ||
    watch ||
    observe ||
    blocked ||
    null;

  let answerType = 'NO_CANDIDATES';

  if (tradeReady) answerType = 'BEST_TRADE_READY';
  else if (watch) answerType = 'BEST_WATCH';
  else if (observe) answerType = 'BEST_OBSERVE_ONLY';
  else if (blocked) answerType = 'ALL_BLOCKED';

  return {
    version: MARKET_WEATHER_SELECTOR_VERSION,
    aggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    fdrVersion: MARKET_WEATHER_FDR_VERSION,
    featureFlags: marketWeatherFeatureFlags(),

    ...currentMarket,

    selectorMode: 'OBSERVE_ONLY',
    sizingCapMode: 'OBSERVE_ONLY',
    fdrMode: 'OBSERVE_ONLY',
    discordTradeReadyHardLiveEnabled: false,

    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,

    alwaysAnswer: true,
    alwaysAnswerDoesNotMeanAlwaysTrade: true,

    answerType,
    selected: selected ? compactCandidate(selected) : null,
    bestForCurrentMarket: selected ? compactCandidate(selected) : null,
    bestTradeReady: tradeReady ? compactCandidate(tradeReady) : null,
    bestWatch: watch ? compactCandidate(watch) : null,
    bestObserveOnly: observe ? compactCandidate(observe) : null,
    bestBlocked: blocked ? compactCandidate(blocked) : null,

    tradeReadyCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_TRADE_READY).length,
    watchCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY).length,
    observeOnlyCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY).length,
    blockedCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_BLOCKED).length,

    candidates: candidates.slice(0, 25).map((row, index) => ({
      rank: index + 1,
      ...compactCandidate(row)
    }))
  };
}

function rotationOptions(extra = {}) {
  return {
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    weekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    shortOnly: true,
    longDisabled: true,
    manualOnly: true,
    autoRotation: false,

    exactTrueMicroFamilyOnly: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,
    microMicroOnly: true,
    selectableMicroMicroOnly: true,
    selectableChildOnly: false,
    selectableIdsAreMicroMicroOnly: true,
    child75ProxySelectionDisabled: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    rawExecutionFingerprintsNotSelectable: true,

    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    child75ActivationDisabled: true,
    autoRotationActivationDisabled: true,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    child75MatchDoesNotTriggerDiscord: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    activeRotationRuntimeGateVersion: ACTIVE_ROTATION_RUNTIME_GATE_VERSION,

    discordActivationRequiresNetEdge: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationGate: activationGateConfig(),

    persistentLearningOnly: true,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    ...extra
  };
}

async function validateSelectedActivationIds(selectedIds = [], currentMarket = null, weekMicrosResult = null) {
  const weekResult = weekMicrosResult || await getWeekMicrosCached(PERSISTENT_LEARNING_KEY, ACTIVATION_VALIDATE_TIMEOUT_MS);
  const rowById = rowMapFromMicros(weekResult.micros || {}, currentMarket);

  const requestedRows = [];
  const eligibleRows = [];
  const rejectedRows = [];

  for (const id of uniqueStrings(selectedIds).filter(isSelectableMicroMicroId)) {
    const row = rowById.get(id) || manualActiveRowFromId(id, requestedRows.length, new Set(), currentMarket) || null;

    if (!row) {
      rejectedRows.push({
        id,
        reason: 'MICRO_MICRO_ROW_NOT_FOUND_IN_PERSISTENT_LEARNING',
        microMicroRuntimeGate: {
          version: MICRO_MICRO_RUNTIME_GATE_VERSION,
          status: STATUS_POLICY_BLOCKED,
          eligible: false,
          blocked: true,
          reason: 'MICRO_MICRO_ROW_NOT_FOUND_IN_PERSISTENT_LEARNING',
          reasons: ['MICRO_MICRO_ROW_NOT_FOUND_IN_PERSISTENT_LEARNING'],
          thresholds: activationGateConfig()
        }
      });
      continue;
    }

    requestedRows.push(row);

    if (row.microMicroRuntimeStatus === STATUS_PASSED) {
      eligibleRows.push(row);
    } else {
      rejectedRows.push({
        id,
        reason: row.microMicroRuntimeReason || row.discordActivationBlockedReason || 'MICRO_MICRO_RUNTIME_GATE_REJECTED',
        reasons: row.microMicroRuntimeReasons || row.discordActivationBlockedReasons || [],
        status: row.microMicroRuntimeStatus,
        completed: row.completed,
        avgR: row.avgR,
        totalR: row.totalR,
        lcb95AvgR: row.lcb95AvgR,
        profitFactor: row.profitFactor,
        avgCostR: row.avgCostR,
        directSLPct: row.directSLPct,
        currentFit: row.currentFit,
        currentFitScore: row.currentFitScore,
        currentFitMisfitIsPolicyBlock: false,
        confirmationProfile: row.confirmationProfile,
        empiricalVeto: row.empiricalVeto,
        policyBlocked: row.policyBlocked,
        microMicroRuntimeGate: row.microMicroRuntimeGate || null,
        discordActivationGate: row.discordActivationGate || null
      });
    }
  }

  const eligibleIds = eligibleRows
    .map((row) => row.trueMicroFamilyId)
    .filter(Boolean)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  const allRows = [...rowById.values()];

  return {
    ok: eligibleIds.length > 0,
    eligibleIds,
    eligibleRows,
    rejectedRows,
    requestedRows,
    allAvailableRows: allRows,
    activationSummary: activationSummary(allRows),
    weekMicrosCacheHit: Boolean(weekResult.cacheHit),
    weekMicrosCacheStale: Boolean(weekResult.stale),
    warning: weekResult.warning || null
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...modeFlags()
  });
}

async function handleGet(req, res) {
  const startedAt = now();

  const requestedWeekKey = String(firstValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY)).trim();

  const availableLimit = toLimit(
    firstValue(req.query?.availableLimit, DEFAULT_AVAILABLE_LIMIT),
    DEFAULT_AVAILABLE_LIMIT,
    MAX_AVAILABLE_LIMIT
  );

  const activeRowsLimit = toLimit(
    firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT),
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ACTIVE_ROWS_LIMIT
  );

  const includeAvailable = isTrue(firstValue(req.query?.includeAvailable, true), true);
  const includeDashboard = isTrue(firstValue(req.query?.includeDashboard, false), false);
  const currentMarket = currentMarketWeatherFromRequest(req);

  const [weekResult, activeRotationResult] = await Promise.all([
    getWeekMicrosCached(PERSISTENT_LEARNING_KEY, WEEK_MICROS_TIMEOUT_MS),
    getActiveRotationCached()
  ]);

  const storedRowById = rowMapFromMicros(weekResult.micros || {}, currentMarket);
  const active = compactActiveRotation(activeRotationResult.value, currentMarket, storedRowById);
  const activeSet = new Set(active.activeMicroMicroFamilyIds || []);

  const availableResult = includeAvailable
    ? await loadAvailableRows({
        weekKey: requestedWeekKey,
        limit: availableLimit,
        activeSet,
        currentMarket,
        weekMicrosResult: weekResult
      }).catch((error) => ({
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        previousWeekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningOnly: true,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        ignoredLayerCounts: {},
        activationEligibleRows: 0,
        activationBlockedRows: 0,
        rows: [],
        warning: error?.message || String(error)
      }))
    : {
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        previousWeekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningOnly: true,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
        currentRows: sourceEntries(weekResult.micros || {}).length,
        previousRows: 0,
        mergedRows: 0,
        ignoredLayerCounts: {},
        activationEligibleRows: 0,
        activationBlockedRows: 0,
        rows: []
      };

  const dashboard = includeDashboard
    ? await withTimeout(
        getRotationDashboard(rotationOptions()),
        ROTATION_DASHBOARD_TIMEOUT_MS,
        'GET_ROTATION_DASHBOARD_TIMEOUT'
      ).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
        skipped: true
      }))
    : null;

  const availableRows = availableResult.rows || [];
  const activation = activationSummary(availableRows);
  const currentMarketPlaybook = buildCurrentMarketPlaybook(availableRows, currentMarket);

  const invalidGeometryPolicyRows = availableRows.filter((row) => (
    row.microMicroRuntimeGate?.policyBlockedGate?.reasons || []
  ).includes('INVALID_SHORT_GEOMETRY_POLICY_BLOCK')).length;

  const aggregateGeometryIgnoredRows = availableRows.filter((row) => (
    row.microMicroRuntimeGate?.policyBlockedGate?.geometry?.aggregateStatsRow === true
  )).length;

  const netRStatsRows = availableRows.filter((row) => row.netRStatsSourceOfTruth || row.netRStatsPresent).length;

  const warnings = uniqueWarnings([
    availableResult.warning,
    weekResult.warning,
    activeRotationResult.warning,
    availableResult.queryWeekKeyIgnored
      ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${availableResult.queryWeekKeyIgnored}`
      : null,
    weekResult.stale ? 'USING_STALE_WEEK_MICROS_CACHE' : null,
    (active.legacyChild75ActiveIdsIgnored || []).length > 0
      ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED:${active.legacyChild75ActiveIdsIgnored.length}`
      : null,
    active.activeRotationCleaned
      ? `OLD_ACTIVE_SELECTION_CLEANED_BLOCKED_IDS:${active.activeRotationBlockedFilteredCount}`
      : null,
    availableRows.length === 0 ? 'NO_AVAILABLE_EXPLICIT_MICRO_MICRO_ROWS' : null,
    availableRows.length > 0 && activation.eligible === 0 ? 'NO_PASSED_MICRO_MICRO_ROWS_NET_EDGE_GATE' : null,
    currentMarket.currentMarketWeatherAvailable === false
      ? 'CURRENT_MARKET_WEATHER_UNKNOWN_PASS_CONFIRMEDMARKETWEATHERKEY_OR_REGIME_TREND'
      : null,
    invalidGeometryPolicyRows > 0
      ? `INVALID_GEOMETRY_POLICY_ROWS_ACTIONABLE_ONLY:${invalidGeometryPolicyRows}`
      : null,
    aggregateGeometryIgnoredRows > 0
      ? `AGGREGATE_STATS_ROWS_GEOMETRY_POLICY_IGNORED:${aggregateGeometryIgnoredRows}`
      : null,
    availableResult.truncated
      ? `TRUNCATED_AT_${MAX_SOURCE_MICRO_ROWS}_ROWS`
      : null
  ]);

  return res.status(200).json({
    ok: true,
    fixed: true,

    ...modeFlags(),
    taxonomy: taxonomyMeta(),

    routeMode: {
      lightweight: true,
      getRotationDashboardDefaultSkipped: !includeDashboard,
      includeDashboard,
      includeAvailable,
      weekMicrosTimeoutMs: WEEK_MICROS_TIMEOUT_MS,
      activeRotationTimeoutMs: ACTIVE_ROTATION_TIMEOUT_MS,
      dashboardTimeoutMs: ROTATION_DASHBOARD_TIMEOUT_MS
    },

    marketWeather: {
      version: MARKET_WEATHER_KEY_VERSION,
      selectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
      aggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
      fdrVersion: MARKET_WEATHER_FDR_VERSION,
      featureFlags: marketWeatherFeatureFlags(),
      current: currentMarket,
      playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
      entryWeatherRule: 'entryMarketWeatherKey is immutable and is never repaired from current/confirmed weather in this endpoint',
      currentWeatherRule: 'currentMarketWeatherKey is dashboard context only',
      confirmedWeatherRule: 'confirmedMarketWeatherKey is backend-current context only',
      unknownWeatherRule: {
        signalType: SIGNAL_TYPE_OBSERVE_ONLY,
        riskFractionForEntry: 0,
        reason: 'MARKET_WEATHER_UNKNOWN'
      }
    },

    statsPolicy: {
      netRStatsSourceOfTruth: true,
      netRStatsRows,
      completedReadsNetRStatsFirst: true,
      totalRReadsNetRStatsFirst: true,
      avgRReadsNetRStatsFirst: true,
      profitFactorReadsNetRStatsFirst: true,
      recentOutcomesFallbackEnabled: true
    },

    geometryPolicy: {
      invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
      aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
      invalidGeometryPolicyRows,
      aggregateGeometryIgnoredRows
    },

    currentMarketPlaybook,
    bestForCurrentMarket: currentMarketPlaybook.bestForCurrentMarket,
    bestTradeReadyForCurrentMarket: currentMarketPlaybook.bestTradeReady,
    bestWatchForCurrentMarket: currentMarketPlaybook.bestWatch,
    bestObserveOnlyForCurrentMarket: currentMarketPlaybook.bestObserveOnly,
    currentMarketAnswerType: currentMarketPlaybook.answerType,

    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKey,
    queryWeekKeyIgnored: availableResult.queryWeekKeyIgnored || null,
    persistentLearningOnly: true,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    activeRowsLimit,
    availableLimit,

    activeRotation: active,
    active,

    activeRotationId: active?.rotationId || null,
    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: [],
    activeMicroMicroFamilyIds: active?.activeMicroMicroFamilyIds || [],
    activeTrueMicroMicroFamilyIds: active?.activeTrueMicroMicroFamilyIds || [],
    activeExactMicroMicroFamilyIds: active?.activeExactMicroMicroFamilyIds || [],
    selectedMicroMicroFamilyIds: active?.selectedMicroMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],
    legacyChild75ActiveIdsIgnored: active?.legacyChild75ActiveIdsIgnored || [],

    requestedActiveMicroMicroFamilyIds: active?.requestedActiveMicroMicroFamilyIds || [],
    filteredBlockedMicroMicroIds: active?.filteredBlockedMicroMicroIds || [],
    filteredBlockedMicroMicroRows: active?.filteredBlockedMicroMicroRows || [],
    activeRotationCleaned: Boolean(active?.activeRotationCleaned),
    activeRotationFilteredBlockedRedisSelections: Boolean(active?.activeRotationFilteredBlockedRedisSelections),
    activeRotationBlockedFilteredCount: active?.activeRotationBlockedFilteredCount || 0,

    activeRows: (active?.microFamilies || []).slice(0, activeRowsLimit),
    activeCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activeMicroMicroCount: active?.activeMicroMicroFamilyIds?.length || 0,

    dashboard,
    nextRotation: dashboard?.next || dashboard?.nextRotation || null,
    nextRotationStoredOnly: true,
    nextRotationAutoActivationDisabled: true,

    availableMicroFamilies: availableRows,
    availableRows,
    availableMicroMicroFamilies: availableRows,
    availableMicroMicroRows: availableRows,
    availableCount: availableRows.length,
    availableMicroMicroCount: availableRows.length,

    availableTierSummary: buildTierSummary(availableRows),
    availableLayerCounts: layerCounts(availableRows),

    microMicroRuntimeGateSummary: activation,
    discordActivationSummary: activation,
    discordActivationEligibleRows: activation.eligible,
    discordActivationBlockedRows: activation.blocked,
    discordActivationEligibleIds: activation.eligibleIds,
    topDiscordActivationEligibleIds: activation.topEligibleIds,

    sourceRows: {
      currentWeekRows: availableResult.currentRows,
      previousWeekRows: availableResult.previousRows,
      mergedRows: availableResult.mergedRows,
      ignoredLayerCounts: availableResult.ignoredLayerCounts || {},
      activationEligibleRows: availableResult.activationEligibleRows || 0,
      activationBlockedRows: availableResult.activationBlockedRows || 0,
      explicitMicroMicroOnly: true,
      child75ProxySelectionDisabled: true,
      persistentLearningOnly: true,
      warning: availableResult.warning || null,
      truncated: availableResult.truncated || false,
      maxSourceRows: MAX_SOURCE_MICRO_ROWS
    },

    allowedActions: ALLOWED_ACTIONS,
    blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],

    buttons: {
      selectExact75Child: false,
      selectExactMicroMicro: true,
      selectParent15Disabled: true,
      copy: true,
      activateVisibleIdsForDiscord: true,
      activateTop2VisibleRequiresNetEdge: true,
      activateTop2AdaptiveRequiresNetEdge: true,
      activateTradeReadyRequiresWeatherAndRisk: true
    },

    warnings,
    error: null,

    perf: {
      durationMs: now() - startedAt,
      source: 'short_manual_selection_exact_micro_micro_rotation_dashboard_v5_lightweight',
      weekMicrosCacheHit: Boolean(weekResult.cacheHit),
      weekMicrosCacheStale: Boolean(weekResult.stale),
      activeRotationCacheHit: Boolean(activeRotationResult.cacheHit),
      weekMicrosCacheSize: cache.weekMicros.size
    },

    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const action = normalizeAction(body);
  const currentMarket = currentMarketWeatherFromRequest(req, body);

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (BLOCKED_AUTO_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'AUTO_ROTATION_DISABLED_MANUAL_EXACT_MICRO_MICRO_SELECTION_ONLY',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (!ALLOWED_ACTIONS.includes(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNKNOWN_OR_DISABLED_ACTION',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  const selected = parseSelectedIds(body);

  if (selected.acceptedIds.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: selected.ignoredRequestedIds.some((row) => row.reason === 'LONG_DISABLED_SHORT_ONLY')
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'SHORT_EXACT_MICRO_MICRO_IDS_REQUIRED',

      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,

      expectedFormats: [
        'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
        'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}'
      ],
      exampleMicroMicro:
        'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_MM_AB12CD34EF',
      exampleAlternateInput:
        'MM_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_OB_STRONG_RR_GOOD',
      child75ExampleRejected:
        'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
      parentExampleRejected:
        'MICRO_SHORT_BREAKOUT_TREND',

      allowedActions: ALLOWED_ACTIONS,
      ...modeFlags()
    });
  }

  const weekResult = await getWeekMicrosCached(PERSISTENT_LEARNING_KEY, ACTIVATION_VALIDATE_TIMEOUT_MS);

  const activationValidation = await validateSelectedActivationIds(
    selected.acceptedIds,
    currentMarket,
    weekResult
  );

  const activationIds = activationValidation.eligibleIds;

  if (!activationValidation.ok) {
    const activeRotationResult = await getActiveRotationCached();
    const storedRowById = rowMapFromMicros(weekResult.micros || {}, currentMarket);
    const active = compactActiveRotation(activeRotationResult.value, currentMarket, storedRowById);

    return res.status(400).json({
      ok: false,
      fixed: true,
      reason: 'NO_ACTIVATION_ELIGIBLE_MICRO_MICRO_IDS_RUNTIME_GATE',
      action,

      ...modeFlags(),
      taxonomy: taxonomyMeta(),

      marketWeather: {
        current: currentMarket,
        selectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
        selectorObserveOnly: true,
        entryWeatherRule: 'entry weather immutable; request current weather does not overwrite historical entry weather'
      },

      requestedIds: selected.requestedIds,
      parsedAcceptedIds: selected.acceptedIds,
      acceptedIds: [],
      rejectedIds: activationValidation.rejectedRows.map((row) => row.id).filter(Boolean),
      activationRejectedRows: activationValidation.rejectedRows,
      ignoredRequestedIds: selected.ignoredRequestedIds,
      ignoredAboveLimitIds: selected.ignoredAboveLimitIds,

      activeRotation: active,
      active,
      activeRotationCleaned: Boolean(active?.activeRotationCleaned),
      filteredBlockedMicroMicroIds: active?.filteredBlockedMicroMicroIds || [],

      microMicroRuntimeGate: activationGateConfig(),
      discordActivationGate: activationGateConfig(),
      discordActivationSummary: activationValidation.activationSummary,

      expectedHardRules: [
        'exact micro-micro id',
        'policy ok',
        'no empirical veto',
        'completed >= 35',
        'avgR net > 0',
        'totalR net > 0',
        'profitFactor > 1',
        'lcb95AvgR > 0',
        'avgCostR <= 0.35',
        'directSLPct <= 0.25'
      ],

      noSelectionMeansNoDiscord: true,

      warnings: uniqueWarnings([
        weekResult.warning,
        weekResult.stale ? 'USING_STALE_WEEK_MICROS_CACHE' : null,
        activationValidation.warning
      ]),

      perf: {
        durationMs: now() - startedAt,
        source: 'activateSelectedShortExactMicroMicro_rejected_by_lightweight_runtime_gate',
        weekMicrosCacheHit: Boolean(weekResult.cacheHit),
        weekMicrosCacheStale: Boolean(weekResult.stale)
      },

      serverTs: Date.now()
    });
  }

  const requestedWeekKey = String(firstValue(body.weekKey, PERSISTENT_LEARNING_KEY)).trim();
  const weekKey = PERSISTENT_LEARNING_KEY;
  const mode = normalizeMode(firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'), 'manual');

  const childIds = uniqueStrings(activationIds.map(getChildTrueMicroFamilyIdFromId).filter(Boolean));
  const parentIds = extractParentIdsFromIds(activationIds);

  const activation = await activateSelectedMicroFamilies({
    microFamilyIds: activationIds,
    trueMicroFamilyIds: activationIds,
    activeMicroFamilyIds: activationIds,
    ids: activationIds,

    microMicroFamilyIds: activationIds,
    trueMicroMicroFamilyIds: activationIds,
    exactMicroMicroFamilyIds: activationIds,
    activeMicroMicroFamilyIds: activationIds,
    activeTrueMicroMicroFamilyIds: activationIds,
    activeExactMicroMicroFamilyIds: activationIds,
    selectedMicroMicroFamilyIds: activationIds,
    selectedTrueMicroMicroFamilyIds: activationIds,
    selectedExactMicroMicroFamilyIds: activationIds,

    childTrueMicroFamilyIds: childIds,
    base75ChildTrueMicroFamilyIds: childIds,

    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    macroIds: [],
    parentTrueMicroFamilyIds: parentIds,

    maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxActiveDiscordMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,

    weekKey,
    mode,

    ...rotationOptions(),
    adminSelected: true,
    requestedWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,

    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    selectorObserveOnly: true,
    currentMarketWeatherKey: currentMarket.currentMarketWeatherKey,
    confirmedMarketWeatherKey: currentMarket.confirmedMarketWeatherKey
  });

  cache.activeRotation = null;

  const activeRotationRaw = await getActiveRotation(rotationOptions()).catch(() => activation);
  const storedRowById = rowMapFromMicros(weekResult.micros || {}, currentMarket);
  const active = compactActiveRotation(activeRotationRaw || activation, currentMarket, storedRowById);

  if (!active?.activeMicroMicroFamilyIds?.length) {
    return res.status(400).json({
      ok: false,
      fixed: true,
      reason: 'ACTIVATION_RESULT_EMPTY_AFTER_RUNTIME_GATE_CLEANUP',
      action,

      ...modeFlags(),
      taxonomy: taxonomyMeta(),

      requestedIds: selected.requestedIds,
      parsedAcceptedIds: selected.acceptedIds,
      activationAcceptedIds: activationIds,
      rawActivation: activation,
      activeRotation: active,
      active,
      filteredBlockedMicroMicroIds: active?.filteredBlockedMicroMicroIds || [],

      noSelectionMeansNoDiscord: true,

      perf: {
        durationMs: now() - startedAt,
        source: 'activateSelectedShortExactMicroMicro_empty_after_lightweight_cleanup'
      },

      serverTs: Date.now()
    });
  }

  return res.status(200).json({
    ok: true,
    fixed: true,
    action,

    ...modeFlags(),
    taxonomy: taxonomyMeta(),

    marketWeather: {
      current: currentMarket,
      selectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
      selectorObserveOnly: true,
      entryWeatherRule: 'Rotation selects exact micro-micro IDs only. Request current/confirmed weather never overwrites historical entryMarketWeatherKey.',
      note: 'TradeSystem still decides TRADE_READY from confirmed weather, playbook freshness, FDR, and riskFractionForEntry.'
    },

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
    persistentLearningOnly: true,
    mode,

    requestedMicroFamilyIds: selected.requestedIds,
    requestedTrueMicroFamilyIds: selected.requestedIds,
    requestedChildTrueMicroFamilyIds: selected.childTrueMicroFamilyIds,
    requestedMicroMicroFamilyIds: selected.microMicroFamilyIds,
    requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
    requestedIds: selected.requestedIds,

    parsedAcceptedIds: selected.acceptedIds,
    resolvedMicroFamilyIds: activationIds,
    resolvedTrueMicroFamilyIds: activationIds,
    resolvedMicroMicroFamilyIds: activationIds,
    resolvedChildTrueMicroFamilyIds: childIds,
    resolvedMacroFamilyIds: [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: selected.requestedMacroFamilyIds,
    macroExpansionDisabled: true,
    parentExpansionDisabled: true,
    child75ActivationDisabled: true,

    acceptedIds: activationIds,
    activationAcceptedIds: activationIds,
    activationRejectedRows: activationValidation.rejectedRows,
    ignoredRequestedIds: [
      ...selected.ignoredRequestedIds,
      ...(Array.isArray(activation?.ignoredRequestedIds) ? activation.ignoredRequestedIds : [])
    ],
    ignoredAboveLimitIds: selected.ignoredAboveLimitIds,

    microMicroRuntimeGate: activationGateConfig(),
    discordActivationGate: activationGateConfig(),
    discordActivationSummary: activationValidation.activationSummary,

    activeRotation: active,
    active,

    activatedCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activatedMicroCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activatedChildTrueMicroCount: 0,
    activatedMicroMicroCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activatedMacroCount: 0,

    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: [],
    activeMicroMicroFamilyIds: active?.activeMicroMicroFamilyIds || [],
    selectedMicroMicroFamilyIds: active?.selectedMicroMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    bestShort: active?.bestShort || null,
    bestLong: null,

    discordEntryAlertsEnabledForSelectedMicroMicroFamiliesOnly:
      (active?.activeMicroMicroFamilyIds || []).length > 0,
    discordEntryAlertsEnabledForSelectedMicroFamiliesOnly: false,
    noSelectionMeansNoDiscord: (active?.activeMicroMicroFamilyIds || []).length === 0,

    rawActivation: activation,

    perf: {
      durationMs: now() - startedAt,
      source: 'activateSelectedShortExactMicroMicro_manual_only_lightweight_runtime_gate',
      weekMicrosCacheHit: Boolean(weekResult.cacheHit),
      weekMicrosCacheStale: Boolean(weekResult.stale)
    },

    serverTs: Date.now()
  });
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'short-only-exact-micro-micro-rotation-v5-lightweight');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Exact-True-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Child-75-Learning-Granularity', CHILD75_LEARNING_GRANULARITY);
  res.setHeader('X-Micro-Micro-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Selectable-Child-Micro-Families', '0');
  res.setHeader('X-Selectable-Micro-Micro-Families', 'dynamic');
  res.setHeader('X-Parent-Micro-Families', '15');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Child75-Proxy-Selection-Disabled', 'true');
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Persistent-Learning-Only', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-Min-Completed-Micro-Micro-Active', String(MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING));
  res.setHeader('X-Micro-Micro-Runtime-Gate-Version', MICRO_MICRO_RUNTIME_GATE_VERSION);
  res.setHeader('X-Micro-Micro-Best-Selector-Version', MICRO_MICRO_BEST_SELECTOR_VERSION);
  res.setHeader('X-Discord-Activation-Gate-Version', DISCORD_ACTIVATION_GATE_VERSION);
  res.setHeader('X-Discord-Activation-Requires-Net-Edge', 'true');
  res.setHeader('X-Market-Weather-Key-Version', MARKET_WEATHER_KEY_VERSION);
  res.setHeader('X-Market-Weather-Selector-Version', MARKET_WEATHER_SELECTOR_VERSION);
  res.setHeader('X-Market-Weather-Selector-Mode', 'observe');
  res.setHeader('X-Empirical-Veto-Version', EMPIRICAL_VETO_VERSION);
  res.setHeader('X-CurrentFit-Misfit-Policy-Block', 'false');
  res.setHeader('X-Entry-Market-Weather-Immutable', 'true');
  res.setHeader('X-Current-Confirmed-Weather-Does-Not-Overwrite-Entry', 'true');
  res.setHeader('X-NetR-Stats-Source-Of-Truth', 'true');
  res.setHeader('X-Invalid-Geometry-Only-For-Actionable-Trade-Rows', 'true');
  res.setHeader('X-Rotation-Lightweight', 'true');
}

export default async function handler(req, res) {
  setHeaders(res);

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    return methodNotAllowed(res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      ...modeFlags(),
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}