// ================= FILE: api/admin/micro-families.js =================

import {
  sideToTradeSide,
  safeNumber
} from '../../src/utils.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson
} from '../../src/redis.js';
import { KEYS } from '../../src/keys.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const MARKET_WEATHER_KEY = 'MARKET:WEATHER:LATEST';
const SHORT_MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}${MARKET_WEATHER_KEY}`;

const SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK = false;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_V1';
const CURRENT_FIT_VERSION = 'SHORT_CURRENTFIT_MARKETWEATHER_SOFT_V2';

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const SETUP_ORDER = [
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
];

const REGIME_ORDER = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const VALID_MODES = new Set([
  'adaptive',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed',
  'cost',
  'currentFit'
]);

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;

const SAMPLE_RELIABILITY_CAP = 50;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const DEFAULT_LIMIT = 75;
const MAX_LIMIT = 300;

const DEFAULT_SIDE_LIMIT = 75;
const MAX_SIDE_LIMIT = 120;

const DEFAULT_BEST_LIMIT = 75;
const MAX_BEST_LIMIT = 100;

const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const WEEK_MICROS_TIMEOUT_MS = 9_500;
const MARKET_WEATHER_TIMEOUT_MS = 1_200;
const MARKET_WEATHER_REDIS_READ_TIMEOUT_MS = 700;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_KEYS = 20;

const cache = globalThis.__ADMIN_MICRO_FAMILIES_SHORT_75_CACHE__ ||= {
  weekMicros: new Map(),
  marketWeather: null
};

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modePayload()
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES' ||
    value === 'on' ||
    value === 'ON'
  );
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function clamp(value, min = 0, max = 1) {
  const n = num(value, min);

  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;

  return Math.min(Math.floor(n), max);
}

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

function firstFiniteNumber(values = []) {
  for (const value of flattenValues(values)) {
    if (value === undefined || value === null || value === '') continue;

    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return null;
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
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, timeoutMs);
  });

  return Promise
    .race([promise, timeoutPromise])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function softReadJson(redis, key, fallback = null, timeoutMs = MARKET_WEATHER_REDIS_READ_TIMEOUT_MS) {
  if (!redis || !key) return fallback;

  let timer = null;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      __timeout: true
    }), Math.max(1, timeoutMs));
  });

  try {
    const value = await Promise.race([
      getJson(redis, key, fallback),
      timeoutPromise
    ]);

    if (value?.__timeout) return fallback;

    return value ?? fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pruneCacheMap(map) {
  const entries = [...map.entries()];

  if (entries.length <= CACHE_MAX_KEYS) return;

  entries
    .sort((a, b) => num(a[1]?.ts, 0) - num(b[1]?.ts, 0))
    .slice(0, Math.max(0, entries.length - CACHE_MAX_KEYS))
    .forEach(([key]) => map.delete(key));
}

function namespacedShortKey(key, fallback = MARKET_WEATHER_KEY) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return SHORT_MARKET_WEATHER_KEY;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function marketWeatherKeyCandidates() {
  return uniqueStrings([
    SHORT_MARKET_WEATHER_KEY,
    namespacedShortKey(KEYS.short?.market?.weatherLatest),
    namespacedShortKey(KEYS.short?.market?.weather),
    namespacedShortKey(KEYS.market?.shortWeatherLatest),
    namespacedShortKey(KEYS.market?.shortWeather),
    namespacedShortKey(MARKET_WEATHER_KEY)
  ]);
}

function redisClientsVolatileFirst() {
  const clients = [];

  try {
    const volatileRedis = getVolatileRedis();

    if (volatileRedis) {
      clients.push({
        name: 'volatile',
        redis: volatileRedis
      });
    }
  } catch {
    // Volatile Redis unavailable.
  }

  try {
    const durableRedis = getDurableRedis();

    if (durableRedis) {
      clients.push({
        name: 'durable',
        redis: durableRedis
      });
    }
  } catch {
    // Durable Redis unavailable.
  }

  return clients;
}

function modePayload() {
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

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    virtualPositionsOnly: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    observationFirst: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    netOutcomesOnly: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    avgCostRFixEnabled: true,
    directSLFixEnabled: true,
    observationDedupeRequired: true,
    observationAlwaysCounted: false,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    outcomeDedupeRequired: true,

    manualSelectionOnly: true,
    manualSelectionRequired: true,
    autoRotationActivationDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    scannerFingerprintLegacyFallbackEnabled: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK,
    scannerFingerprintsHidden: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK !== true,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    bucketsCoarseOnly: true,
    bucketGranularity: 'SETUP_X_REGIME_X_CONFIRMATION',
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,
    coinNameExcludedFromLearningIdentity: true,
    hashesExcludedFromLearningIdentity: true,

    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    currentFitVersion: CURRENT_FIT_VERSION,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitAffectsSelectionOnly: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    adaptiveLayerBuilt: false,
    marketWeatherEngineBuilt: true,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: true,
    parentDiversificationBuilt: false,
    adaptiveLayerBlockedUntilMeasurementClean: true,

    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    timeStopEnabled: true,
    positionTimeStopMinDefault: 720,

    resetCronDisabled: true,
    activateFreezeCronDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function normalizeMode(value) {
  const raw = String(value || 'balanced').trim();

  if (VALID_MODES.has(raw)) return raw;

  const rawLower = lower(raw);

  if (rawLower === 'totalr') return 'totalR';
  if (rawLower === 'avgr') return 'avgR';
  if (rawLower === 'directsl') return 'directSL';
  if (rawLower === 'currentfit') return 'currentFit';

  return VALID_MODES.has(rawLower) ? rawLower : 'balanced';
}

function normalizeRequestedTradeSide(value) {
  const raw = upper(value);

  if (!raw) return TARGET_TRADE_SIDE;
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG_DISABLED';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return 'LONG_DISABLED';

  return TARGET_TRADE_SIDE;
}

function cleanSideHaystack(text = '') {
  return upper(text)
    .replaceAll('LONG_DISABLED_TRUE', '')
    .replaceAll('LONGDISABLED_TRUE', '')
    .replaceAll('BLOCK_LONG_TRUE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', '')
    .replaceAll('LONGDISABLED_SHORT_ONLY', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSignalText(value = '') {
  return cleanSideHaystack(value)
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

function hasLongSignal(text = '') {
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

function hasShortSignal(text = '') {
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

function normalizeSideToken(value) {
  const raw = cleanSideHaystack(value);

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

  const longHit = hasLongSignal(raw);
  const shortHit = hasShortSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function parseShortTaxonomyMicroId(id = '') {
  const value = upper(id);

  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId: String(id || '').trim()
    };
  }

  let body = value.slice('MICRO_SHORT_'.length);
  let confirmationProfile = null;

  for (const profile of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${profile}`;

    if (body.endsWith(suffix)) {
      confirmationProfile = profile;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setup = null;
  let regime = null;

  for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime
    ? `MICRO_SHORT_${setup}_${regime}`
    : null;

  const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;

  const validParent =
    Boolean(parentId) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);

  return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
    rawId: String(id || '').trim(),
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function isFixedShortParentMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.valid && parsed.isParent;
}

function isFixedShortChildMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.valid && parsed.isChild;
}

function isSelectableTrueMicroId(id = '') {
  return isFixedShortChildMicroId(id);
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

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function allowScannerFingerprintRow(id = '') {
  return SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK === true || !isScannerFingerprintId(id);
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (!allowScannerFingerprintRow(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function firstSelectableLearningId(values = [], fallback = null) {
  for (const value of values) {
    const id = String(value || '').trim();

    if (validLearningId(id) && isSelectableTrueMicroId(id)) return upper(id);
  }

  return fallback;
}

function firstValidLearningId(values = [], fallback = null) {
  for (const value of values) {
    const id = String(value || '').trim();

    if (validLearningId(id)) return upper(id);
  }

  return fallback;
}

function getTrueMicroFamilyId(row = {}, fallback = null) {
  return firstSelectableLearningId([
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], null);
}

function getCoarseMicroFamilyId(row = {}, fallback = null) {
  const childId = getTrueMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(childId);

  return firstValidLearningId([
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    parsed.parentTrueMicroFamilyId,
    fallback
  ], parsed.parentTrueMicroFamilyId || fallback);
}

function getMacroFamilyId(row = {}) {
  const childId = getTrueMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(childId);

  return firstValidLearningId([
    row.parentTrueMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.familyId,
    parsed.parentTrueMicroFamilyId
  ], parsed.parentTrueMicroFamilyId || null);
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
  if (Array.isArray(row.definition)) return row.definition;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function collectSideText(input = {}) {
  if (typeof input === 'string') return cleanSideHaystack(input);

  return [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.bias,
    input.marketBias,

    input.familyId,
    input.family,
    input.baseFamilyId,

    input.macroFamilyId,
    input.parentMacroFamilyId,
    input.parentMicroFamilyId,
    input.parentFamilyId,
    input.macroId,

    input.microFamilyId,
    input.trueMicroFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.parentTrueMicroFamilyId,
    input.coarseMicroFamilyId,
    input.baseMicroFamilyId,
    input.legacyMicroFamilyId,
    input.id,
    input.key,

    input.definition,
    input.microDefinition,
    input.macroDefinition,
    input.parentDefinition,

    ...getArray(input.definitionParts),
    ...getArray(input.microDefinitionParts),
    ...getArray(input.macroDefinitionParts),
    ...getArray(input.parentDefinitionParts),
    ...getArray(input.executionFingerprintParts)
  ]
    .map((value) => cleanSideHaystack(value))
    .filter(Boolean)
    .join(' | ');
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const clean = cleanSideHaystack(input);
    const direct = normalizeSideToken(clean);

    if (direct === OPPOSITE_TRADE_SIDE || direct === TARGET_TRADE_SIDE) return direct;

    const shortSignal = hasShortSignal(clean);
    const longSignal = hasLongSignal(clean);

    if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
    if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

    if (parseShortTaxonomyMicroId(clean).valid) return TARGET_TRADE_SIDE;
    if (clean.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (clean.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const directSources = [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const normalized = normalizeSideToken(source);

    if (normalized === OPPOSITE_TRADE_SIDE || normalized === TARGET_TRADE_SIDE) {
      return normalized;
    }
  }

  const microFamilyId = cleanSideHaystack(
    input.trueMicroFamilyId ||
    input.learningMicroFamilyId ||
    input.analyzeMicroFamilyId ||
    input.childTrueMicroFamilyId ||
    input.microFamilyId ||
    input.parentTrueMicroFamilyId ||
    input.coarseMicroFamilyId ||
    input.baseMicroFamilyId ||
    input.legacyMicroFamilyId ||
    input.id ||
    input.key
  );

  if (parseShortTaxonomyMicroId(microFamilyId).valid) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  const text = collectSideText(input);
  const shortSignal = hasShortSignal(text);
  const longSignal = hasLongSignal(text);

  if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
  if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

  if (shortSignal && longSignal) {
    if (microFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isLearningOutcomeSource(source = '') {
  const value = upper(source || 'VIRTUAL');

  return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value === '';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isAnalyzeMicroRow(row = {}) {
  const id = getTrueMicroFamilyId(row);

  if (!id) return false;
  if (!validLearningId(id)) return false;
  if (!isSelectableTrueMicroId(id)) return false;
  if (row.legacyScannerFamilyFallback === true) return false;
  if (inferTradeSide({ ...row, trueMicroFamilyId: id }) === OPPOSITE_TRADE_SIDE) return false;

  return true;
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) {
    return micros.map((row, index) => [
      getTrueMicroFamilyId(row, String(index)) || String(index),
      row
    ]);
  }

  if (!micros || typeof micros !== 'object') return [];

  return Object.entries(micros);
}

function microsCount(micros = {}) {
  return sourceEntriesFromMicros(micros)
    .filter(([key, row]) => {
      const id = getTrueMicroFamilyId(row, key);

      return Boolean(id && validLearningId(id) && isSelectableTrueMicroId(id));
    })
    .length;
}

function generateShortTaxonomyRows() {
  const rows = [];

  for (const setup of SETUP_ORDER) {
    for (const regime of REGIME_ORDER) {
      const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;

      for (const confirmationProfile of CONFIRMATION_PROFILE_ORDER) {
        const trueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;

        rows.push({
          trueMicroFamilyId,
          microFamilyId: trueMicroFamilyId,
          analyzeMicroFamilyId: trueMicroFamilyId,
          learningMicroFamilyId: trueMicroFamilyId,
          childTrueMicroFamilyId: trueMicroFamilyId,

          coarseMicroFamilyId: parentTrueMicroFamilyId,
          parentTrueMicroFamilyId,
          macroFamilyId: parentTrueMicroFamilyId,
          parentMacroFamilyId: parentTrueMicroFamilyId,
          parentMicroFamilyId: parentTrueMicroFamilyId,
          familyId: parentTrueMicroFamilyId,

          taxonomySetup: setup,
          taxonomyRegime: regime,
          confirmationProfile,

          setupType: setup,
          regimeBucket: regime,

          sourceWeekKey: PERSISTENT_LEARNING_KEY,
          sourceWeekPrimary: true,
          sourceWeekFallback: false,

          seen: 0,
          observations: 0,
          observationDuplicateSkippedCount: 0,
          completed: 0,
          outcomeSample: 0,
          observationSample: 0,

          virtualCompleted: 0,
          shadowCompleted: 0,
          realCompleted: 0,

          virtualWins: 0,
          virtualLosses: 0,
          virtualFlats: 0,

          shadowWins: 0,
          shadowLosses: 0,
          shadowFlats: 0,

          virtualTotalR: 0,
          shadowTotalR: 0,
          virtualTotalCostR: 0,
          shadowTotalCostR: 0,

          directSLCount: 0,
          directSLPct: 0,
          virtualDirectSLCount: 0,
          shadowDirectSLCount: 0,

          generatedEmptyTaxonomyRow: true,
          active: false,
          macroActive: false,

          ...modePayload()
        });
      }
    }
  }

  return rows;
}

function hasVirtualShadowOutcomeFields(row = {}) {
  return [
    'virtualCompleted',
    'shadowCompleted',
    'virtualWins',
    'virtualLosses',
    'virtualFlats',
    'shadowWins',
    'shadowLosses',
    'shadowFlats',
    'virtualTotalR',
    'shadowTotalR',
    'virtualTotalCostR',
    'shadowTotalCostR'
  ].some((key) => hasValue(row[key]));
}

function getShortRiskGeometry(row = {}) {
  const entry = firstFiniteNumber([
    row.entryPrice,
    row.entry,
    row.avgEntryPrice,
    row.averageEntryPrice,
    row.averageEntry,
    row.openPrice
  ]);

  const initialSl = firstFiniteNumber([
    row.initialSl,
    row.initialSL,
    row.initialStopLoss,
    row.initialStopLossPrice,
    row.stopLoss,
    row.stopLossPrice,
    row.sl,
    row.slPrice
  ]);

  const tp = firstFiniteNumber([
    row.tp,
    row.takeProfit,
    row.takeProfitPrice,
    row.targetPrice,
    row.finalTp,
    row.finalTakeProfit
  ]);

  const exitPrice = firstFiniteNumber([
    row.exitPrice,
    row.closePrice,
    row.closedPrice,
    row.outcomePrice,
    row.fillExitPrice,
    row.exit
  ]);

  const currentPrice = firstFiniteNumber([
    row.currentPrice,
    row.markPrice,
    row.lastPrice,
    row.price
  ]);

  const denominator =
    Number.isFinite(entry) && Number.isFinite(initialSl)
      ? initialSl - entry
      : 0;

  const validGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(initialSl) &&
    Number.isFinite(tp) &&
    denominator > 0 &&
    tp < entry &&
    entry < initialSl;

  const shortGrossR =
    validGeometry && Number.isFinite(exitPrice)
      ? (entry - exitPrice) / denominator
      : null;

  const shortCurrentR =
    validGeometry && Number.isFinite(currentPrice)
      ? (entry - currentPrice) / denominator
      : null;

  const shortTpHit =
    validGeometry &&
    (
      row.shortTpHit === true ||
      row.tpHit === true ||
      (Number.isFinite(exitPrice) && exitPrice <= tp) ||
      (Number.isFinite(currentPrice) && currentPrice <= tp)
    );

  const shortSlHit =
    validGeometry &&
    (
      row.shortSlHit === true ||
      row.slHit === true ||
      (Number.isFinite(exitPrice) && exitPrice >= initialSl) ||
      (Number.isFinite(currentPrice) && currentPrice >= initialSl)
    );

  return {
    entry,
    initialSl,
    tp,
    exitPrice,
    currentPrice,
    denominator,
    validGeometry,
    shortTpHit: Boolean(shortTpHit),
    shortSlHit: Boolean(shortSlHit),
    shortGrossR,
    shortCurrentR,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}

function outcomeNetR(row = {}) {
  const explicitShortR = firstFiniteNumber([
    row.shortNetR,
    row.netShortR,
    row.shortExitR,
    row.shortRealizedNetR,
    row.shortRealizedR
  ]);

  if (explicitShortR !== null) return explicitShortR;

  const geometry = getShortRiskGeometry(row);
  const costR = num(row.costR ?? row.avgCostR, 0);

  if (geometry.validGeometry && geometry.shortGrossR !== null) {
    return geometry.shortGrossR - costR;
  }

  return num(
    row.netR ??
    row.exitR ??
    row.realizedNetR ??
    row.realizedR ??
    row.r,
    0
  );
}

function aggregateRecentOutcomes(row = {}) {
  const outcomes = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  return outcomes.reduce(
    (acc, outcome) => {
      if (!outcome || typeof outcome !== 'object') return acc;

      const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');

      if (!isLearningOutcomeSource(source)) return acc;
      if (!isShortRow({ ...row, ...outcome })) return acc;

      const netR = outcomeNetR(outcome);
      const costR = num(outcome.costR ?? outcome.avgCostR, 0);

      acc.completed += 1;
      acc.totalR += netR;
      acc.totalCostR += costR;

      if (netR > 0) {
        acc.wins += 1;
        acc.grossWinR += netR;
      } else if (netR < 0) {
        acc.losses += 1;
        acc.grossLossR += Math.abs(netR);
      } else {
        acc.flats += 1;
      }

      if (outcome.directSL || outcome.directToSL || outcome.directStopLoss || outcome.isDirectSL) {
        acc.directSLCount += 1;
      }

      return acc;
    },
    {
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalR: 0,
      totalCostR: 0,
      grossWinR: 0,
      grossLossR: 0,
      directSLCount: 0
    }
  );
}

function sourceMetricSum(row = {}, realKey = null, shadowKey = null) {
  const virtualKey = realKey && String(realKey).startsWith('real')
    ? `virtual${String(realKey).slice(4)}`
    : null;

  const resolvedShadowKey = shadowKey || (
    realKey && String(realKey).startsWith('real')
      ? `shadow${String(realKey).slice(4)}`
      : null
  );

  return (
    num(virtualKey ? row[virtualKey] : 0, 0) +
    num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0)
  );
}

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  const virtualShadow = sourceMetricSum(row, realKey, shadowKey);

  if (virtualShadow > 0) return virtualShadow;

  if (aggregateKey && hasValue(row[aggregateKey])) {
    return num(row[aggregateKey], 0);
  }

  return 0;
}

function getOutcomeCounts(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
  const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
  const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');

  const virtualShadowCompleted =
    num(row.virtualCompleted, 0) +
    num(row.shadowCompleted, 0);

  const aggregateCompleted = Math.max(
    num(row.completed, 0),
    num(row.outcomeSample, 0),
    0
  );

  if (
    virtualShadowCompleted <= 0 &&
    aggregateCompleted <= 0 &&
    wins + losses + flats <= 0 &&
    recent.completed > 0
  ) {
    return {
      wins: recent.wins,
      losses: recent.losses,
      flats: recent.flats,
      total: recent.completed
    };
  }

  const countedTotal = wins + losses + flats;
  const total = Math.max(
    countedTotal,
    virtualShadowCompleted,
    aggregateCompleted,
    recent.completed,
    0
  );

  const inferredFlats = Math.max(0, total - wins - losses);

  return {
    wins,
    losses,
    flats: Math.max(flats, inferredFlats),
    total
  };
}

function getCompletedSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    0
  );
}

function getObservationDuplicateSkippedCount(row = {}) {
  return Math.max(
    num(row.observationDuplicateSkippedCount, 0),
    num(row.duplicateObservationsSkipped, 0),
    num(row.seenDuplicateSkippedCount, 0),
    0
  );
}

function getSeenCompletedRatio(row = {}) {
  const completed = getCompletedSample(row);
  const seen = getObservationSample(row);

  if (completed <= 0) return seen > 0 ? seen : 0;

  return seen / completed;
}

function getTotalR(row = {}) {
  const completed = getCompletedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowTotalR =
    num(row.virtualTotalR, 0) +
    num(row.shadowTotalR, 0);

  if (virtualShadowTotalR !== 0 || hasVirtualShadowOutcomeFields(row)) {
    return virtualShadowTotalR;
  }

  if (recent.completed > 0) return recent.totalR;

  if (hasValue(row.shortNetTotalR)) return num(row.shortNetTotalR, 0);
  if (hasValue(row.netShortTotalR)) return num(row.netShortTotalR, 0);
  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
  if (hasValue(row.totalR)) return num(row.totalR, 0);

  return 0;
}

function getAvgR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR) && !hasVirtualShadowOutcomeFields(row)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR) && !hasVirtualShadowOutcomeFields(row)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR) && !hasVirtualShadowOutcomeFields(row)) return num(row.avgR, 0);

  return getTotalR(row) / completed;
}

function hasCostEvidence(row = {}) {
  if (!row || typeof row !== 'object') return false;

  if (hasValue(row.virtualTotalCostR) && num(row.virtualTotalCostR, 0) > 0) return true;
  if (hasValue(row.shadowTotalCostR) && num(row.shadowTotalCostR, 0) > 0) return true;
  if (hasValue(row.totalCostR) && num(row.totalCostR, 0) > 0) return true;
  if (hasValue(row.totalNetCostR) && num(row.totalNetCostR, 0) > 0) return true;
  if (hasValue(row.avgCostR) && num(row.avgCostR, 0) > 0) return true;
  if (hasValue(row.costR) && num(row.costR, 0) > 0) return true;
  if (hasValue(row.netCostR) && num(row.netCostR, 0) > 0) return true;
  if (hasValue(row.estimatedCostR) && num(row.estimatedCostR, 0) > 0) return true;

  if (Array.isArray(row.recentOutcomes)) {
    return row.recentOutcomes.some((outcome) => (
      outcome &&
      isLearningOutcomeSource(outcome.source || outcome.outcomeSource || 'VIRTUAL') &&
      (
        num(outcome.costR, 0) > 0 ||
        num(outcome.avgCostR, 0) > 0 ||
        num(outcome.totalCostR, 0) > 0 ||
        num(outcome.netCostR, 0) > 0 ||
        num(outcome.estimatedCostR, 0) > 0
      )
    ));
  }

  return false;
}

function getTotalCostR(row = {}) {
  const completed = getCompletedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowCost =
    Math.max(0, num(row.virtualTotalCostR, 0)) +
    Math.max(0, num(row.shadowTotalCostR, 0));

  if (virtualShadowCost > 0) {
    return virtualShadowCost;
  }

  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;

  if (hasValue(row.totalCostR) && num(row.totalCostR, 0) > 0) {
    return Math.max(0, num(row.totalCostR, 0));
  }

  if (hasValue(row.totalNetCostR) && num(row.totalNetCostR, 0) > 0) {
    return Math.max(0, num(row.totalNetCostR, 0));
  }

  if (hasValue(row.avgCostR) && num(row.avgCostR, 0) > 0) {
    return Math.max(0, num(row.avgCostR, 0)) * completed;
  }

  if (hasValue(row.costR) && num(row.costR, 0) > 0) {
    return Math.max(0, num(row.costR, 0)) * completed;
  }

  if (hasValue(row.netCostR) && num(row.netCostR, 0) > 0) {
    return Math.max(0, num(row.netCostR, 0)) * completed;
  }

  if (hasValue(row.estimatedCostR) && num(row.estimatedCostR, 0) > 0) {
    return Math.max(0, num(row.estimatedCostR, 0)) * completed;
  }

  return 0;
}

function getAvgCostR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  const totalCostR = getTotalCostR(row);

  if (totalCostR > 0) {
    return Math.max(0, totalCostR / completed);
  }

  if (hasValue(row.avgCostR) && num(row.avgCostR, 0) > 0) {
    return Math.max(0, num(row.avgCostR, 0));
  }

  if (hasValue(row.costR) && num(row.costR, 0) > 0) {
    return Math.max(0, num(row.costR, 0));
  }

  if (hasValue(row.netCostR) && num(row.netCostR, 0) > 0) {
    return Math.max(0, num(row.netCostR, 0));
  }

  if (hasValue(row.estimatedCostR) && num(row.estimatedCostR, 0) > 0) {
    return Math.max(0, num(row.estimatedCostR, 0));
  }

  return 0;
}

function costFixSource(row = {}) {
  return hasCostEvidence(row)
    ? 'costR_or_avgCostR_fallback/closedCompleted'
    : 'none';
}

function getPositiveR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  const virtualShadow = sourceMetricSum(row, realKey, shadowKey);

  if (virtualShadow !== 0) {
    return Math.max(0, virtualShadow);
  }

  if (aggregateKey && hasValue(row[aggregateKey])) {
    return Math.max(0, num(row[aggregateKey], 0));
  }

  return 0;
}

function getAbsLossR(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  const virtualShadow = sourceMetricSum(row, realKey, shadowKey);

  if (virtualShadow !== 0) {
    return Math.abs(virtualShadow);
  }

  if (aggregateKey && hasValue(row[aggregateKey])) {
    return Math.abs(num(row[aggregateKey], 0));
  }

  return 0;
}

function getProfitFactor(row = {}) {
  if (hasValue(row.shortNetProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.shortNetProfitFactor, 0);
  if (hasValue(row.netShortProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.netShortProfitFactor, 0);
  if (hasValue(row.netProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.profitFactor, 0);

  const winR = Math.max(
    getPositiveR(row, 'netWinR', 'realNetWinR', 'shadowNetWinR'),
    getPositiveR(row, 'totalWinR', 'realTotalWinR', 'shadowTotalWinR'),
    getPositiveR(row, 'grossWinR', 'realGrossWinR', 'shadowGrossWinR'),
    0
  );

  const lossR = Math.max(
    getAbsLossR(row, 'netLossR', 'realNetLossR', 'shadowNetLossR'),
    getAbsLossR(row, 'totalLossR', 'realTotalLossR', 'shadowTotalLossR'),
    getAbsLossR(row, 'grossLossR', 'realGrossLossR', 'shadowGrossLossR'),
    0
  );

  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 99 : 0;

  return winR / lossR;
}

function getCountMetric(row = {}, realCountKey, aggregateCountKey) {
  const shadowCountKey = realCountKey && String(realCountKey).startsWith('real')
    ? `shadow${String(realCountKey).slice(4)}`
    : null;

  return getLearningCount(
    row,
    aggregateCountKey,
    realCountKey,
    shadowCountKey
  );
}

function getPctMetric(row = {}, realPctKey, realCountKey, aggregatePctKey, aggregateCountKey = null) {
  if (hasValue(row[aggregatePctKey]) && !hasVirtualShadowOutcomeFields(row)) {
    return clamp(row[aggregatePctKey], 0, 1);
  }

  const completed = getCompletedSample(row);
  const fallbackCountKey = aggregateCountKey || String(aggregatePctKey || '').replace(/Pct$/i, 'Count');
  const count = getCountMetric(row, realCountKey, fallbackCountKey);

  if (completed <= 0 || count <= 0) return 0;

  return clamp(count / completed, 0, 1);
}

function getDirectSLCount(row = {}) {
  const sourceCount =
    num(row.virtualDirectSLCount, 0) +
    num(row.shadowDirectSLCount, 0);

  if (sourceCount > 0) return sourceCount;

  if (hasValue(row.directSLCount)) return num(row.directSLCount, 0);

  const recent = aggregateRecentOutcomes(row);

  return recent.directSLCount;
}

function getDirectSLPct(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.directSLPct) && !hasVirtualShadowOutcomeFields(row)) {
    return clamp(row.directSLPct, 0, 1);
  }

  return clamp(getDirectSLCount(row) / completed, 0, 1);
}

function wilsonLowerBound(successes, trials, z = WINRATE_Z) {
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

function sampleReliability(sample, cap = SAMPLE_RELIABILITY_CAP) {
  const n = num(sample, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1);
}

function getSampleAdjustedWinrate(row = {}) {
  const counts = getOutcomeCounts(row);
  const completedSample = counts.total;
  const observationSample = getObservationSample(row);

  if (completedSample <= 0) {
    return {
      sample: observationSample,
      outcomeSample: 0,
      observationSample,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(observationSample),
      score: 0,
      awaitingOutcomes: observationSample > 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / completedSample, 0, 1);

  const bayesianWinrate = clamp(
    (successes + WINRATE_BAYES_ALPHA) /
      (completedSample + WINRATE_BAYES_ALPHA + WINRATE_BAYES_BETA),
    0,
    1
  );

  const wilson = wilsonLowerBound(successes, completedSample);
  const reliability = sampleReliability(completedSample);

  const score = clamp(
    wilson * 0.8 +
      bayesianWinrate * 0.15 +
      rawWinrate * 0.05,
    0,
    1
  );

  return {
    sample: completedSample,
    outcomeSample: completedSample,
    observationSample,
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

function getObservationActivityScore(row = {}, meta = null) {
  const sample = meta?.observationSample ?? getObservationSample(row);

  if (sample <= 0) return 0;

  const seenComponent = Math.log1p(sample) * 8;
  const reliabilityComponent = sampleReliability(sample) * 18;

  const scannerReasonBonus = row.scannerReason || row.scannerReasonCoarse
    ? 2
    : 0;

  const definitionBonus = getDefinitionParts(row).length > 0
    ? 2
    : 0;

  return Math.max(
    1,
    Math.min(45, seenComponent + reliabilityComponent + scannerReasonBonus + definitionBonus)
  );
}

function getPerformanceBalancedScore(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  const totalR = Math.max(0, getTotalR(row));
  const avgR = Math.max(0, getAvgR(row));
  const profitFactor = Math.min(Math.max(0, getProfitFactor(row)), 20);

  const directSLPct = getDirectSLPct(row);
  const nearTpThenLossPct = getPctMetric(row, 'realNearTpThenLossPct', 'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount');
  const gaveBackAfterOneRPct = getPctMetric(row, 'realGaveBackAfterOneRPct', 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount');
  const avgCostR = Math.max(0, getAvgCostR(row));

  const winrateComponent = winrateMeta.score * 100;
  const reliabilityComponent = winrateMeta.reliability * 20;
  const totalRComponent = Math.log1p(totalR) * 12;
  const avgRComponent = Math.log1p(avgR) * 8;
  const pfComponent = Math.log1p(profitFactor) * 3;

  const riskPenalty =
    directSLPct * 60 +
    nearTpThenLossPct * 45 +
    gaveBackAfterOneRPct * 20 +
    avgCostR * 3;

  return (
    winrateComponent +
    reliabilityComponent +
    totalRComponent +
    avgRComponent +
    pfComponent -
    riskPenalty
  );
}

function getDashboardBalancedScore(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample <= 0 && winrateMeta.observationSample > 0) {
    return getObservationActivityScore(row, winrateMeta);
  }

  return getPerformanceBalancedScore(row, winrateMeta);
}

function learningStatusFor(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (winrateMeta.outcomeSample > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function tierFor(row = {}, meta = null) {
  const winrateMeta = meta || getSampleAdjustedWinrate(row);

  if (winrateMeta.outcomeSample >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
  if (winrateMeta.outcomeSample > 0) return 'SOFT';
  if (winrateMeta.observationSample > 0) return 'OBSERVATION';

  return 'RAW';
}

function scannerMetadata(row = {}) {
  return {
    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : [],
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false
  };
}

function pct01To100(value, fallback = null) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  if (Math.abs(n) <= 1) return n * 100;

  return n;
}

function confidenceTo01(value, fallback = 0.6) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  if (Math.abs(n) > 1) return clamp(n / 100, 0, 1);

  return clamp(n, 0, 1);
}

function normalizeMarketRegime(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  if (
    raw.includes('SQUEEZE') ||
    raw.includes('COMPRESSION') ||
    raw.includes('VOLATILITY_CONTRACTION')
  ) {
    return 'SQUEEZE';
  }

  if (
    raw.includes('CHOP') ||
    raw.includes('RANGE') ||
    raw.includes('SIDEWAYS') ||
    raw.includes('NEUTRAL')
  ) {
    return 'CHOP';
  }

  if (
    raw.includes('TREND') ||
    raw.includes('IMPULSE') ||
    raw.includes('MOMENTUM') ||
    raw.includes('BREAKOUT')
  ) {
    return 'TREND';
  }

  return 'UNKNOWN';
}

function normalizeMarketTrendSide(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  if (
    raw === 'BULL' ||
    raw === 'BULLISH' ||
    raw === 'LONG' ||
    raw === 'BUY' ||
    raw === 'UP' ||
    raw === 'UPSIDE' ||
    raw === 'GREEN' ||
    raw.includes('BULL') ||
    raw.includes('WITH_LONG')
  ) {
    return 'bull';
  }

  if (
    raw === 'BEAR' ||
    raw === 'BEARISH' ||
    raw === 'SHORT' ||
    raw === 'SELL' ||
    raw === 'DOWN' ||
    raw === 'DOWNSIDE' ||
    raw === 'RED' ||
    raw.includes('BEAR') ||
    raw.includes('WITH_SHORT')
  ) {
    return 'bear';
  }

  if (
    raw === 'CHOP' ||
    raw === 'RANGE' ||
    raw === 'SIDEWAYS' ||
    raw === 'NEUTRAL' ||
    raw === 'MIXED' ||
    raw.includes('NEUTRAL') ||
    raw.includes('MIXED')
  ) {
    return 'neutral';
  }

  return 'UNKNOWN';
}

function unwrapMarketWeatherPayload(payload = null) {
  if (!payload || typeof payload !== 'object') return null;

  return (
    payload.marketWeather ||
    payload.weather ||
    payload.data?.marketWeather ||
    payload.data?.weather ||
    payload.data ||
    payload
  );
}

function normalizeMarketWeather(payload = null, sourceKey = null, redisSource = null) {
  const data = unwrapMarketWeatherPayload(payload);

  if (!data || typeof data !== 'object') {
    return {
      available: false,
      ok: false,
      sourceKey,
      redisSource,
      reason: 'MARKET_WEATHER_EMPTY',
      currentRegime: 'UNKNOWN',
      currentTrendSide: 'UNKNOWN',
      bullishPct: null,
      bearishPct: null,
      squeezePct: null,
      confidence: 0,
      stale: false,
      cacheStale: false
    };
  }

  const currentRegime = normalizeMarketRegime(
    data.currentRegime ||
      data.regime ||
      data.marketRegime ||
      data.regimeBucket ||
      data.btcRegime ||
      data.state ||
      data.currentVolatilityState ||
      data.volatilityState
  );

  const currentTrendSide = normalizeMarketTrendSide(
    data.currentTrendSide ||
      data.trendSide ||
      data.marketTrendSide ||
      data.dashboardSide ||
      data.marketSide ||
      data.side ||
      data.bias ||
      data.direction ||
      data.currentFlow ||
      data.flow
  );

  const bullishPct = pct01To100(
    data.bullishPct ??
      data.bullPct ??
      data.longPct ??
      data.bullishBreadth ??
      data.breadth?.bullishPct ??
      data.breadth?.bullPct ??
      data.breadth?.advancePct ??
      data.breadth?.advanceRatio ??
      data.breadth?.advancingRatio,
    null
  );

  const bearishPct = pct01To100(
    data.bearishPct ??
      data.bearPct ??
      data.shortPct ??
      data.bearishBreadth ??
      data.breadth?.bearishPct ??
      data.breadth?.bearPct ??
      data.breadth?.declinePct ??
      data.breadth?.declineRatio ??
      data.breadth?.decliningRatio,
    null
  );

  const squeezePct = pct01To100(
    data.squeezePct ??
      data.compressionPct ??
      data.squeezeBreadth ??
      data.breadth?.squeezePct ??
      data.breadth?.compressionPct ??
      (
        normalizeMarketRegime(data.currentRegime || data.regime) === 'SQUEEZE'
          ? 100
          : null
      ),
    null
  );

  const confidence = confidenceTo01(
    data.currentMarketFitConfidence ??
      data.confidence ??
      data.marketConfidence ??
      data.weatherConfidence ??
      data.score ??
      data.weatherScore,
    0.6
  );

  const generatedAt = num(
    data.generatedAt ||
      data.updatedAt ||
      data.savedAt ||
      data.completedAt ||
      data.createdAt ||
      payload.generatedAt ||
      payload.updatedAt ||
      payload.savedAt ||
      payload.createdAt,
    0
  );

  const ageMs = generatedAt > 0 ? Math.max(0, now() - generatedAt) : null;
  const stale = Boolean(data.stale || data.cacheStale || payload.stale || payload.cacheStale);

  const available =
    payload?.ok !== false &&
    data?.ok !== false &&
    data?.available !== false &&
    (
      currentRegime !== 'UNKNOWN' ||
      currentTrendSide !== 'UNKNOWN' ||
      bullishPct !== null ||
      bearishPct !== null ||
      squeezePct !== null
    );

  return {
    available,
    ok: available,
    sourceKey,
    redisSource,
    reason: available ? null : 'MARKET_WEATHER_INCOMPLETE',

    currentRegime,
    currentTrendSide,

    bullishPct: bullishPct === null ? null : round(bullishPct, 2),
    bearishPct: bearishPct === null ? null : round(bearishPct, 2),
    squeezePct: squeezePct === null ? null : round(squeezePct, 2),
    confidence: round(confidence, 4),

    generatedAt: generatedAt || null,
    createdAt: data.createdAt || payload.createdAt || null,
    updatedAt: data.updatedAt || payload.updatedAt || null,
    ageMs,
    stale,
    cacheStale: Boolean(data.cacheStale || payload.cacheStale || stale),
    rawRegime: data.regime || data.currentRegime || null,
    rawTrendSide: data.trendSide || data.currentTrendSide || data.dashboardSide || null,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    shortOnly: true,
    longDisabled: true,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    longRootTouched: false
  };
}

async function readJsonFromAnyRedis(keys = marketWeatherKeyCandidates()) {
  const clients = redisClientsVolatileFirst();

  let staleCandidate = null;

  for (const key of uniqueStrings(keys)) {
    const safeKey = namespacedShortKey(key);

    for (const client of clients) {
      if (!client.redis || !safeKey) continue;

      try {
        const payload = await softReadJson(
          client.redis,
          safeKey,
          null,
          MARKET_WEATHER_REDIS_READ_TIMEOUT_MS
        );

        if (!payload) continue;

        const normalized = normalizeMarketWeather(payload, safeKey, client.name);

        if (normalized.available && !normalized.stale && !normalized.cacheStale) {
          return {
            key: safeKey,
            redis: client.name,
            payload,
            normalized
          };
        }

        if (normalized.available && !staleCandidate) {
          staleCandidate = {
            key: safeKey,
            redis: client.name,
            payload,
            normalized: {
              ...normalized,
              staleFallbackUsed: true
            }
          };
        }
      } catch {
        // Try next key/client.
      }
    }
  }

  return staleCandidate;
}

async function getCurrentMarketWeatherSafe() {
  if (cache.marketWeather && now() - cache.marketWeather.ts <= CACHE_TTL_MS) {
    return cache.marketWeather.value;
  }

  try {
    const found = await withTimeout(
      readJsonFromAnyRedis(marketWeatherKeyCandidates()),
      MARKET_WEATHER_TIMEOUT_MS,
      'MARKET_WEATHER_READ_TIMEOUT'
    );

    const value = found?.normalized
      ? found.normalized
      : normalizeMarketWeather(null, null, null);

    cache.marketWeather = {
      ts: now(),
      value
    };

    return value;
  } catch (error) {
    const value = {
      available: false,
      ok: false,
      sourceKey: null,
      redisSource: null,
      reason: error?.message || String(error),
      currentRegime: 'UNKNOWN',
      currentTrendSide: 'UNKNOWN',
      bullishPct: null,
      bearishPct: null,
      squeezePct: null,
      confidence: 0,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
    };

    cache.marketWeather = {
      ts: now(),
      value
    };

    return value;
  }
}

function currentFitForMicro(row = {}, marketWeather = null) {
  const id = getTrueMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(id);

  const unavailable = {
    currentFit: 'UNKNOWN',
    currentFitLabel: 'UNKNOWN',
    currentFitScore: 0,
    fitScore: 0,
    shortCurrentFit: 0,
    bearCurrentFit: 0,
    bearishCurrentFit: 0,
    longCurrentFit: 0,
    bullCurrentFit: 0,
    bullishCurrentFit: 0,
    currentFitConfidence: 0,
    currentFitReason: 'MARKET_WEATHER_UNAVAILABLE',
    currentFitReasons: ['MARKET_WEATHER_UNAVAILABLE'],
    currentFitVersion: CURRENT_FIT_VERSION,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitBlocksDiscord: false,
    discordCurrentFitAllowed: true,
    learningRemainsBroad: true,
    currentMarketRegime: 'UNKNOWN',
    currentMarketTrendSide: 'UNKNOWN',
    currentBullishPct: null,
    currentBearishPct: null,
    currentSqueezePct: null,
    currentMarketWeatherAvailable: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };

  if (!parsed?.isChild || !marketWeather?.available) {
    return unavailable;
  }

  const reasons = [];
  let score = 0;

  const marketRegime = normalizeMarketRegime(marketWeather.currentRegime);
  const marketTrendSide = normalizeMarketTrendSide(marketWeather.currentTrendSide);

  const bullishPct = pct01To100(marketWeather.bullishPct, null);
  const bearishPct = pct01To100(marketWeather.bearishPct, null);
  const squeezePct = pct01To100(marketWeather.squeezePct, null);

  if (marketTrendSide === 'bear') {
    score += 35;
    reasons.push('SHORT_MARKET_SIDE_MATCH_BEAR');
  } else if (marketTrendSide === 'neutral') {
    score += 8;
    reasons.push('SHORT_MARKET_SIDE_NEUTRAL');
  } else if (marketTrendSide === 'bull') {
    score -= 45;
    reasons.push('SHORT_MARKET_SIDE_MISFIT_BULL');
  } else {
    reasons.push('SHORT_MARKET_SIDE_UNKNOWN');
  }

  if (marketRegime === parsed.regime) {
    score += 30;
    reasons.push(`REGIME_MATCH_${parsed.regime}`);
  } else if (marketRegime === 'UNKNOWN') {
    reasons.push('REGIME_UNKNOWN');
  } else {
    score -= 15;
    reasons.push(`REGIME_MISMATCH_${parsed.regime}_VS_${marketRegime}`);
  }

  if (parsed.setup === 'COMPRESSION') {
    if (marketRegime === 'SQUEEZE' || (squeezePct !== null && squeezePct >= 35)) {
      score += 18;
      reasons.push('COMPRESSION_SETUP_SUPPORTED');
    } else {
      score -= 8;
      reasons.push('COMPRESSION_SETUP_NOT_SUPPORTED');
    }
  }

  if (parsed.setup === 'BREAKOUT') {
    if (marketTrendSide === 'bear' && ['TREND', 'SQUEEZE'].includes(marketRegime)) {
      score += 12;
      reasons.push('BEAR_BREAKOUT_CONTEXT_SUPPORTED');
    }
    if (marketTrendSide === 'bull') {
      score -= 14;
      reasons.push('BREAKOUT_AGAINST_SHORT');
    }
  }

  if (parsed.setup === 'CONTINUATION') {
    if (marketTrendSide === 'bear' && marketRegime === 'TREND') {
      score += 16;
      reasons.push('BEAR_CONTINUATION_CONTEXT_SUPPORTED');
    }
    if (marketTrendSide === 'bull') {
      score -= 18;
      reasons.push('CONTINUATION_AGAINST_SHORT');
    }
  }

  if (parsed.setup === 'RETEST') {
    if (marketTrendSide === 'bear' && ['TREND', 'CHOP'].includes(marketRegime)) {
      score += 10;
      reasons.push('SHORT_RETEST_CONTEXT_SUPPORTED');
    }
  }

  if (parsed.setup === 'SWEEP_REVERSAL') {
    if (['CHOP', 'SQUEEZE'].includes(marketRegime)) {
      score += 12;
      reasons.push('SWEEP_REVERSAL_CONTEXT_SUPPORTED');
    }
    if (marketTrendSide === 'bull') {
      score -= 8;
      reasons.push('SWEEP_REVERSAL_BULLISH_HEADWIND');
    }
  }

  if (parsed.regime === 'SQUEEZE') {
    if (squeezePct !== null && squeezePct >= 35) {
      score += 15;
      reasons.push('SQUEEZE_BREADTH_SUPPORTS_SQUEEZE_SETUP');
    } else if (squeezePct !== null && squeezePct < 15) {
      score -= 10;
      reasons.push('SQUEEZE_BREADTH_LOW');
    }
  }

  if (parsed.regime === 'TREND') {
    if (bearishPct !== null && bearishPct >= 55) {
      score += 15;
      reasons.push('BEARISH_BREADTH_SUPPORTS_TREND');
    } else if (bearishPct !== null && bearishPct < 40) {
      score -= 15;
      reasons.push('BEARISH_BREADTH_WEAK_FOR_TREND');
    }
  }

  if (parsed.regime === 'CHOP') {
    if (marketRegime === 'CHOP' || marketTrendSide === 'neutral') {
      score += 12;
      reasons.push('CHOP_CONTEXT_SUPPORTS_CHOP_SETUP');
    }
  }

  if (bullishPct !== null && bearishPct !== null) {
    if (bearishPct > bullishPct + 10) {
      score += 10;
      reasons.push('BEARISH_BREADTH_ABOVE_BULLISH');
    } else if (bullishPct > bearishPct + 10) {
      score -= 20;
      reasons.push('BULLISH_BREADTH_ABOVE_BEARISH');
    } else {
      reasons.push('BREADTH_MIXED');
    }
  }

  if (parsed.confirmationProfile === 'A_STRONG_ALIGN') {
    score += marketTrendSide === 'bear' ? 12 : 6;
    reasons.push('CONFIRMATION_STRONG_ALIGN');
  } else if (parsed.confirmationProfile === 'B_FLOW_ALIGN') {
    score += marketTrendSide === 'bear' ? 9 : 4;
    reasons.push('CONFIRMATION_FLOW_ALIGN');
  } else if (parsed.confirmationProfile === 'C_VOLUME_ALIGN') {
    score += 5;
    reasons.push('CONFIRMATION_VOLUME_ALIGN');
  } else if (parsed.confirmationProfile === 'D_MIXED_OK') {
    score += marketTrendSide === 'neutral' || marketRegime === 'CHOP' ? 6 : 0;
    reasons.push('CONFIRMATION_MIXED_OK');
  } else if (parsed.confirmationProfile === 'E_WEAK_CONTRA') {
    score -= 8;
    reasons.push('CONFIRMATION_WEAK_CONTRA');
  }

  const normalizedScore = round(clamp(score, -100, 100), 2);

  let label = 'NEUTRAL';

  if (normalizedScore >= 45) label = 'FIT';
  else if (normalizedScore >= 20) label = 'OK';
  else if (normalizedScore <= -20) label = 'MISFIT';

  const confidence = clamp(
    Math.abs(normalizedScore) / 100 * 0.7 + num(marketWeather.confidence, 0.6) * 0.3,
    0,
    1
  );

  return {
    currentFit: label,
    currentFitLabel: label,
    currentFitScore: normalizedScore,
    fitScore: normalizedScore,

    shortCurrentFit: normalizedScore,
    bearCurrentFit: normalizedScore,
    bearishCurrentFit: normalizedScore,
    longCurrentFit: -normalizedScore,
    bullCurrentFit: -normalizedScore,
    bullishCurrentFit: -normalizedScore,

    currentFitConfidence: round(confidence, 4),
    currentFitReason: reasons.join('|'),
    currentFitReasons: reasons,
    currentFitVersion: CURRENT_FIT_VERSION,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    currentFitBlocksDiscord: label === 'MISFIT',
    discordCurrentFitAllowed: label !== 'MISFIT',

    learningRemainsBroad: true,

    currentMarketRegime: marketRegime,
    currentMarketTrendSide: marketTrendSide,
    currentBullishPct: bullishPct === null ? null : round(bullishPct, 2),
    currentBearishPct: bearishPct === null ? null : round(bearishPct, 2),
    currentSqueezePct: squeezePct === null ? null : round(squeezePct, 2),
    currentMarketWeatherAvailable: true,
    currentMarketWeatherSourceKey: marketWeather.sourceKey || null,
    currentMarketWeatherRedisSource: marketWeather.redisSource || null,
    currentMarketWeatherStaleFallbackUsed: Boolean(marketWeather.staleFallbackUsed),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
}

function buildRawMicroRow(row = {}, key = '', index = 0) {
  const trueMicroFamilyId = getTrueMicroFamilyId(row, key);

  if (!trueMicroFamilyId) return null;
  if (!validLearningId(trueMicroFamilyId)) return null;
  if (!isSelectableTrueMicroId(trueMicroFamilyId)) return null;

  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  if (!parsed.selectable) return null;

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const coarseMicroFamilyId = parentTrueMicroFamilyId;
  const familyId = parentTrueMicroFamilyId;
  const macroFamilyId = parentTrueMicroFamilyId;

  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const inferredTradeSide = inferTradeSide({
    ...row,
    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    coarseMicroFamilyId,
    parentTrueMicroFamilyId,
    familyId,
    macroFamilyId,
    definitionParts,
    macroDefinitionParts
  });

  if (inferredTradeSide === OPPOSITE_TRADE_SIDE) return null;

  const completed = getCompletedSample(row);
  const totalR = getTotalR(row);
  const totalCostR = getTotalCostR(row);
  const counts = getOutcomeCounts(row);
  const directSLCount = getDirectSLCount(row);
  const riskGeometry = getShortRiskGeometry(row);

  return {
    sourceIndex: index,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    familyId,
    macroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,

    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,

    ...scannerMetadata(row),
    ...modePayload(),

    fixedTaxonomyLearningId: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    selectableTrueMicroFamily: true,
    parentTrueMicroFamily: false,

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,

    inferredTradeSide,
    inferredFromShortOnlyMode: inferredTradeSide === 'UNKNOWN',

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen ?? row.observations, 0),
    observations: num(row.observations ?? row.seen, 0),
    observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),

    completed: round(completed, 4),

    virtualCompleted: num(row.virtualCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),
    realCompleted: 0,

    wins: round(counts.wins, 4),
    losses: round(counts.losses, 4),
    flats: round(counts.flats, 4),

    virtualWins: num(row.virtualWins, 0),
    virtualLosses: num(row.virtualLosses, 0),
    virtualFlats: num(row.virtualFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),

    totalR: round(totalR, 4),

    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgR: round(getAvgR(row), 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(getProfitFactor(row), 4),

    directSLCount: round(directSLCount, 4),
    directSLPct: round(getDirectSLPct(row), 4),

    nearTpCount: round(getCountMetric(row, 'realNearTpCount', 'nearTpCount'), 4),
    nearTpPct: round(getPctMetric(row, 'realNearTpPct', 'realNearTpCount', 'nearTpPct', 'nearTpCount'), 4),

    reachedHalfRCount: round(getCountMetric(row, 'realReachedHalfRCount', 'reachedHalfRCount'), 4),
    reachedOneRCount: round(getCountMetric(row, 'realReachedOneRCount', 'reachedOneRCount'), 4),
    reachedHalfRPct: round(getPctMetric(row, 'realReachedHalfRPct', 'realReachedHalfRCount', 'reachedHalfRPct', 'reachedHalfRCount'), 4),
    reachedOneRPct: round(getPctMetric(row, 'realReachedOneRPct', 'realReachedOneRCount', 'reachedOneRPct', 'reachedOneRCount'), 4),

    beWouldExitCount: round(getCountMetric(row, 'realBeWouldExitCount', 'beWouldExitCount'), 4),
    beWouldExitPct: round(getPctMetric(row, 'realBeWouldExitPct', 'realBeWouldExitCount', 'beWouldExitPct', 'beWouldExitCount'), 4),

    gaveBackAfterHalfRCount: round(getCountMetric(row, 'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRCount'), 4),
    gaveBackAfterOneRCount: round(getCountMetric(row, 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRCount'), 4),
    gaveBackAfterHalfRPct: round(getPctMetric(row, 'realGaveBackAfterHalfRPct', 'realGaveBackAfterHalfRCount', 'gaveBackAfterHalfRPct', 'gaveBackAfterHalfRCount'), 4),
    gaveBackAfterOneRPct: round(getPctMetric(row, 'realGaveBackAfterOneRPct', 'realGaveBackAfterOneRCount', 'gaveBackAfterOneRPct', 'gaveBackAfterOneRCount'), 4),

    nearTpThenLossCount: round(getCountMetric(row, 'realNearTpThenLossCount', 'nearTpThenLossCount'), 4),
    nearTpThenLossPct: round(getPctMetric(row, 'realNearTpThenLossPct', 'realNearTpThenLossCount', 'nearTpThenLossPct', 'nearTpThenLossCount'), 4),

    totalCostR: round(totalCostR, 4),
    avgCostR: round(getAvgCostR(row), 4),

    avgCostRFixSource: costFixSource(row),
    directSLFixSource: directSLCount > 0 ? 'directSLCount/closedCompleted' : 'none',

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortGeometry: Boolean(riskGeometry.validGeometry),
    shortValidGeometry: Boolean(riskGeometry.validGeometry),
    riskGeometryRule: riskGeometry.riskGeometryRule,
    tpHitRule: riskGeometry.tpHitRule,
    slHitRule: riskGeometry.slHitRule,
    grossRFormula: riskGeometry.grossRFormula,
    currentRFormula: riskGeometry.currentRFormula,
    shortTpHit: riskGeometry.shortTpHit,
    shortSlHit: riskGeometry.shortSlHit,
    tpHit: riskGeometry.shortTpHit,
    slHit: riskGeometry.shortSlHit,
    shortGrossR: round(riskGeometry.shortGrossR ?? row.shortGrossR ?? row.grossR, 4),
    shortCurrentR: round(riskGeometry.shortCurrentR ?? row.shortCurrentR ?? row.currentR, 4),
    currentR: round(riskGeometry.shortCurrentR ?? row.currentR, 4),

    balancedScore: round(row.balancedScore, 4),

    definition: row.definition || row.microDefinition || null,
    definitionParts,

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts,

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : definitionParts,

    assetClass: row.assetClass || null,

    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    rsiSlope: row.rsiSlope ?? null,
    rsiVelocity: row.rsiVelocity ?? null,
    rsiDelta: row.rsiDelta ?? null,
    rsiMomentum: row.rsiMomentum ?? null,

    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,

    obRelation: row.obRelation || null,
    obBias: row.obBias ?? null,
    obImbalance: row.obImbalance ?? null,
    orderbookImbalance: row.orderbookImbalance ?? null,
    bookImbalance: row.bookImbalance ?? null,
    bidAskImbalance: row.bidAskImbalance ?? null,

    spoofScore: row.spoofScore ?? null,
    orderbookSpoofScore: row.orderbookSpoofScore ?? null,
    obSpoofScore: row.obSpoofScore ?? null,
    fakeLiquidityScore: row.fakeLiquidityScore ?? null,

    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,

    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    generatedEmptyTaxonomyRow: Boolean(row.generatedEmptyTaxonomyRow),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function decorateMicroRow(row = {}, marketWeather = null) {
  if (!row?.trueMicroFamilyId) return null;
  if (!isAnalyzeMicroRow(row)) return null;

  const winrate = getSampleAdjustedWinrate(row);
  const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);
  const learningStatus = learningStatusFor(row, winrate);
  const tier = tierFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_ACTIVE_LEARNING;
  const fit = currentFitForMicro(row, marketWeather);

  const adaptiveScore =
    dashboardBalancedScore +
    fit.currentFitScore * 0.15 +
    winrate.reliability * 10 -
    getDirectSLPct(row) * 10 -
    getAvgCostR(row) * 2;

  return {
    ...row,

    ...modePayload(),
    ...fit,

    completed: round(winrate.outcomeSample, 4),
    wins: round(winrate.wins, 4),
    losses: round(winrate.losses, 4),
    flats: round(winrate.flats, 4),

    outcomeSample: round(winrate.outcomeSample, 4),
    observationSample: round(winrate.observationSample, 4),
    observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),

    winrateSample: round(winrate.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrate.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrate.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4),

    winrate: round(winrate.rawWinrate, 4),
    bayesianWinrate: round(winrate.bayesianWinrate, 4),
    wilsonLowerBound: round(winrate.wilsonLowerBound, 4),

    fairWinrate: round(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      winrate.score ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),

    totalR: round(getTotalR(row), 4),
    avgR: round(getAvgR(row), 4),
    profitFactor: round(getProfitFactor(row), 4),

    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),

    directSLCount: round(getDirectSLCount(row), 4),
    directSLPct: round(getDirectSLPct(row), 4),

    dashboardBalancedScore: round(row.dashboardBalancedScore ?? dashboardBalancedScore, 4),
    balancedScore: round(row.balancedScore ?? dashboardBalancedScore, 4),
    adaptiveScore: round(row.adaptiveScore ?? adaptiveScore, 4),
    recentMomentumScore: round(row.recentMomentumScore ?? 0, 4),

    awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
    learningStatus,
    status: learningStatus,

    tooEarly,
    tooEarlyReason: tooEarly
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    tier,
    selectedTier: row.selectedTier || row.rotationEligibilityTier || tier,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tier,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    avgCostRFixSource: costFixSource(row),
    directSLFixSource: getDirectSLCount(row) > 0 ? 'directSLCount/closedCompleted' : 'none'
  };
}

function buildRowsFromMicros(micros = {}, marketWeather = null) {
  return sourceEntriesFromMicros(micros)
    .map(([key, row], index) => {
      const id = getTrueMicroFamilyId(row, key);

      if (!id) return null;
      if (!validLearningId(id)) return null;
      if (!isSelectableTrueMicroId(id)) return null;

      const parsed = parseShortTaxonomyMicroId(id);

      const baseRow = {
        ...(row || {}),
        key,
        microFamilyId: id,
        trueMicroFamilyId: id,
        analyzeMicroFamilyId: id,
        learningMicroFamilyId: id,
        childTrueMicroFamilyId: id,
        parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        sourceWeekKey: PERSISTENT_LEARNING_KEY,
        sourceWeekPrimary: true,
        sourceWeekFallback: false,
        ...modePayload()
      };

      const raw = buildRawMicroRow(baseRow, key, index);

      return raw ? decorateMicroRow(raw, marketWeather) : null;
    })
    .filter(Boolean)
    .filter(isAnalyzeMicroRow);
}

function rowKey(row = {}) {
  return String(
    row.trueMicroFamilyId ||
    row.learningMicroFamilyId ||
    row.analyzeMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function mergeRows(primaryRows = [], fallbackRows = []) {
  const byKey = new Map();

  for (const row of fallbackRows) {
    const key = rowKey(row);
    if (!key || !isAnalyzeMicroRow(row)) continue;

    byKey.set(key, row);
  }

  for (const row of primaryRows) {
    const key = rowKey(row);
    if (!key || !isAnalyzeMicroRow(row)) continue;

    const existing = byKey.get(key);

    byKey.set(key, existing
      ? {
        ...existing,
        ...row,
        active: Boolean(existing.active || row.active),
        macroActive: Boolean(existing.macroActive || row.macroActive),
        selectedTier: row.selectedTier || existing.selectedTier,
        rotationEligibilityTier: row.rotationEligibilityTier || existing.rotationEligibilityTier,
        tier: row.tier || existing.tier,
        generatedEmptyTaxonomyRow: Boolean(existing.generatedEmptyTaxonomyRow && row.generatedEmptyTaxonomyRow)
      }
      : row
    );
  }

  return [...byKey.values()].filter(isAnalyzeMicroRow);
}

function manualRowFromId(id, index = 0, marketWeather = null) {
  if (!id || inferTradeSide(id) === OPPOSITE_TRADE_SIDE) return null;
  if (!validLearningId(id)) return null;
  if (!isSelectableTrueMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  const raw = buildRawMicroRow({
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    childTrueMicroFamilyId: id,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,

    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    ...modePayload(),

    active: true,
    macroActive: false,

    seen: 0,
    observations: 0,
    observationDuplicateSkippedCount: 0,
    completed: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,
    winrateSample: 0,
    winrate: 0,
    totalR: 0,
    virtualTotalR: 0,
    shadowTotalR: 0,
    avgR: 0,
    profitFactor: 0,
    directSLPct: 0,
    directSLCount: 0,
    totalCostR: 0,
    avgCostR: 0,
    selectedTier: 'RAW',
    rotationEligibilityTier: 'RAW'
  }, id, index);

  return raw ? decorateMicroRow(raw, marketWeather) : null;
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => getTrueMicroFamilyId(row))
      : []
  ];

  return uniqueStrings(ids).filter((id) => (
    inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
    validLearningId(id) &&
    isSelectableTrueMicroId(id)
  ));
}

function extractActiveMacroIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    activeRotation.macroFamilyIds || [],
    activeRotation.activeMacroFamilyIds || [],
    activeRotation.macroIds || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => getMacroFamilyId(row))
      : []
  ];

  return uniqueStrings(ids).filter((id) => (
    inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
    validLearningId(id) &&
    isFixedShortParentMicroId(id)
  ));
}

function buildRowsFromActiveRotation(activeRotation, marketWeather = null) {
  if (!activeRotation) return [];

  const rows = [];

  if (Array.isArray(activeRotation.microFamilies)) {
    rows.push(
      ...activeRotation.microFamilies
        .map((row, index) => {
          if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return null;

          const id = getTrueMicroFamilyId(row, `active_${index}`);
          if (!id || !validLearningId(id) || !isSelectableTrueMicroId(id)) return null;

          const parsed = parseShortTaxonomyMicroId(id);

          const raw = buildRawMicroRow({
            ...row,
            ...modePayload(),
            microFamilyId: id,
            trueMicroFamilyId: id,
            analyzeMicroFamilyId: id,
            learningMicroFamilyId: id,
            childTrueMicroFamilyId: id,
            parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
            coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
            active: true,
            selectedTier: row.selectedTier || row.rotationEligibilityTier || activeRotation.selectedTier || 'RAW'
          }, id, index);

          return raw ? decorateMicroRow(raw, marketWeather) : null;
        })
        .filter(Boolean)
        .filter(isAnalyzeMicroRow)
    );
  }

  const existing = new Set(rows.map(rowKey).filter(Boolean));

  for (const id of extractActiveIds(activeRotation)) {
    if (existing.has(id)) continue;

    const manual = manualRowFromId(id, rows.length, marketWeather);
    if (!manual) continue;

    rows.push(manual);
    existing.add(id);
  }

  return mergeRows([], rows);
}

function normalizeMicroRow(
  row = {},
  index = 0,
  {
    activeSet = new Set(),
    activeMacroSet = new Set(),
    compact = true
  } = {}
) {
  const trueMicroFamilyId = getTrueMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const riskGeometry = getShortRiskGeometry(row);
  const winrate = getSampleAdjustedWinrate(row);
  const tier = tierFor(row, winrate);
  const learningStatus = learningStatusFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_ACTIVE_LEARNING;

  const base = {
    rank: index + 1,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    familyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,

    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,

    ...scannerMetadata(row),
    ...modePayload(),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: true,
    parentTrueMicroFamily: false,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,

    inferredTradeSide: row.inferredTradeSide || inferTradeSide(row),
    inferredFromShortOnlyMode: Boolean(row.inferredFromShortOnlyMode),

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    active: Boolean(row.active) || activeSet.has(trueMicroFamilyId),
    macroActive: Boolean(row.macroActive) || activeMacroSet.has(parentTrueMicroFamilyId),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),
    observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),

    completed: round(winrate.outcomeSample, 4),

    virtualCompleted: num(row.virtualCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),
    realCompleted: 0,

    outcomeSample: round(winrate.outcomeSample, 4),
    observationSample: round(winrate.observationSample, 4),

    awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
    learningStatus,
    status: learningStatus,

    tooEarly,
    tooEarlyReason: tooEarly
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    tier,
    selectedTier: row.selectedTier || row.rotationEligibilityTier || tier,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tier,

    wins: round(winrate.wins, 4),
    losses: round(winrate.losses, 4),
    flats: round(winrate.flats, 4),

    virtualWins: num(row.virtualWins, 0),
    virtualLosses: num(row.virtualLosses, 0),
    virtualFlats: num(row.virtualFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(winrate.rawWinrate, 4),
    bayesianWinrate: round(winrate.bayesianWinrate, 4),
    wilsonLowerBound: round(winrate.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? winrate.score, 4),

    winrateSample: round(winrate.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrate.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrate.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4),

    totalR: round(getTotalR(row), 4),
    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgR: round(getAvgR(row), 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(getProfitFactor(row), 4),

    directSLCount: round(getDirectSLCount(row), 4),
    directSLPct: round(getDirectSLPct(row), 4),

    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),
    avgCostRFixSource: costFixSource(row),

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortGeometry: Boolean(riskGeometry.validGeometry),
    shortValidGeometry: Boolean(riskGeometry.validGeometry),
    riskGeometryRule: riskGeometry.riskGeometryRule,
    tpHitRule: riskGeometry.tpHitRule,
    slHitRule: riskGeometry.slHitRule,
    grossRFormula: riskGeometry.grossRFormula,
    currentRFormula: riskGeometry.currentRFormula,
    shortTpHit: riskGeometry.shortTpHit,
    shortSlHit: riskGeometry.shortSlHit,
    tpHit: riskGeometry.shortTpHit,
    slHit: riskGeometry.shortSlHit,
    shortGrossR: round(riskGeometry.shortGrossR ?? row.shortGrossR ?? row.grossR, 4),
    shortCurrentR: round(riskGeometry.shortCurrentR ?? row.shortCurrentR ?? row.currentR, 4),
    currentR: round(riskGeometry.shortCurrentR ?? row.currentR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? getDashboardBalancedScore(row, winrate), 4),
    adaptiveScore: round(row.adaptiveScore ?? row.dashboardBalancedScore ?? row.balancedScore ?? getDashboardBalancedScore(row, winrate), 4),
    recentMomentumScore: round(row.recentMomentumScore ?? 0, 4),

    currentFit: row.currentFit || 'UNKNOWN',
    currentFitLabel: row.currentFitLabel || row.currentFit || 'UNKNOWN',
    currentFitScore: round(row.currentFitScore ?? row.fitScore ?? 0, 4),
    fitScore: round(row.fitScore ?? row.currentFitScore ?? 0, 4),
    shortCurrentFit: round(row.shortCurrentFit ?? row.currentFitScore ?? row.fitScore ?? 0, 4),
    bearCurrentFit: round(row.bearCurrentFit ?? row.currentFitScore ?? row.fitScore ?? 0, 4),
    bearishCurrentFit: round(row.bearishCurrentFit ?? row.currentFitScore ?? row.fitScore ?? 0, 4),
    longCurrentFit: round(row.longCurrentFit ?? -(row.currentFitScore ?? row.fitScore ?? 0), 4),
    bullCurrentFit: round(row.bullCurrentFit ?? -(row.currentFitScore ?? row.fitScore ?? 0), 4),
    bullishCurrentFit: round(row.bullishCurrentFit ?? -(row.currentFitScore ?? row.fitScore ?? 0), 4),
    currentFitConfidence: round(row.currentFitConfidence ?? 0, 4),
    currentFitReason: row.currentFitReason || null,
    currentFitReasons: Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [],
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    currentMarketRegime: row.currentMarketRegime || 'UNKNOWN',
    currentMarketTrendSide: row.currentMarketTrendSide || 'UNKNOWN',
    currentBullishPct: row.currentBullishPct ?? null,
    currentBearishPct: row.currentBearishPct ?? null,
    currentSqueezePct: row.currentSqueezePct ?? null,
    currentMarketWeatherAvailable: Boolean(row.currentMarketWeatherAvailable),
    currentMarketWeatherSourceKey: row.currentMarketWeatherSourceKey || null,
    currentMarketWeatherRedisSource: row.currentMarketWeatherRedisSource || null,
    currentMarketWeatherStaleFallbackUsed: Boolean(row.currentMarketWeatherStaleFallbackUsed),

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitBlocksDiscord: Boolean(row.currentFitBlocksDiscord),
    discordCurrentFitAllowed: row.discordCurrentFitAllowed !== false,

    definition: row.definition || null,
    definitionParts: getDefinitionParts(row),

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts: getMacroDefinitionParts(row),

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : getDefinitionParts(row),

    assetClass: row.assetClass || null,
    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,
    obRelation: row.obRelation || null,
    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,
    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,
    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    generatedEmptyTaxonomyRow: Boolean(row.generatedEmptyTaxonomyRow),

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  if (compact) return base;

  return {
    ...row,
    ...base,

    counters: row.counters || {},
    examples: Array.isArray(row.examples)
      ? row.examples.filter(isShortRow).slice(-8)
      : [],

    recentOutcomes: Array.isArray(row.recentOutcomes)
      ? row.recentOutcomes.filter(isShortRow).slice(-8)
      : []
  };
}

function compactBestRow(row) {
  if (!row) return null;
  if (!isAnalyzeMicroRow(row)) return null;

  const trueMicroFamilyId = getTrueMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);
  const riskGeometry = getShortRiskGeometry(row);

  return {
    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,

    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    ...modePayload(),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),
    observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),

    completed: round(row.outcomeSample ?? getCompletedSample(row), 4),
    outcomeSample: round(row.outcomeSample ?? getCompletedSample(row), 4),
    observationSample: round(row.observationSample ?? getObservationSample(row), 4),

    awaitingOutcomes: Boolean(row.awaitingOutcomes),
    learningStatus: row.learningStatus || learningStatusFor(row),
    status: row.status || row.learningStatus || learningStatusFor(row),

    tooEarly: num(row.outcomeSample ?? getCompletedSample(row), 0) < MIN_COMPLETED_ACTIVE_LEARNING,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    tier: row.tier || tierFor(row),
    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.tier || tierFor(row),
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.tier || tierFor(row),

    winrateSample: round(row.winrateSample, 4),
    winrate: round(row.winrate, 4),
    fairWinrate: round(row.fairWinrate, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(getAvgR(row), 4),
    totalR: round(getTotalR(row), 4),
    profitFactor: round(getProfitFactor(row), 4),

    directSLCount: round(getDirectSLCount(row), 4),
    directSLPct: round(getDirectSLPct(row), 4),

    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),
    avgCostRFixSource: costFixSource(row),

    validShortGeometry: Boolean(riskGeometry.validGeometry),
    shortTpHit: riskGeometry.shortTpHit,
    shortSlHit: riskGeometry.shortSlHit,
    shortGrossR: round(riskGeometry.shortGrossR ?? row.shortGrossR ?? row.grossR, 4),
    shortCurrentR: round(riskGeometry.shortCurrentR ?? row.shortCurrentR ?? row.currentR, 4),
    currentR: round(riskGeometry.shortCurrentR ?? row.currentR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore, 4),
    adaptiveScore: round(row.adaptiveScore, 4),

    currentFit: row.currentFit || 'UNKNOWN',
    currentFitScore: round(row.currentFitScore ?? row.fitScore ?? 0, 4),
    fitScore: round(row.fitScore ?? row.currentFitScore ?? 0, 4),
    currentFitConfidence: round(row.currentFitConfidence ?? 0, 4),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentMarketRegime: row.currentMarketRegime || 'UNKNOWN',
    currentMarketTrendSide: row.currentMarketTrendSide || 'UNKNOWN',
    currentMarketWeatherAvailable: Boolean(row.currentMarketWeatherAvailable),
    currentMarketWeatherSourceKey: row.currentMarketWeatherSourceKey || null,
    currentMarketWeatherRedisSource: row.currentMarketWeatherRedisSource || null
  };
}

function compactActiveRotation(activeRotation) {
  if (!activeRotation) return null;

  const activeMicroFamilyIds = extractActiveIds(activeRotation);
  const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);

  return {
    rotationId: activeRotation.rotationId || null,
    source: activeRotation.source || null,
    mode: activeRotation.mode || null,
    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    generatedAt: activeRotation.generatedAt || null,
    activatedAt: activeRotation.activatedAt || null,

    ...modePayload(),

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    exactTrueMicroOnly: true,
    selectableChildOnly: true,

    manualOnly: true,
    adminSelected: Boolean(activeRotation.adminSelected || activeRotation.manualOnly),
    liveSelectable: Boolean(activeRotation.liveSelectable),

    usedLegacyFallback: false,
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
    usedRawFallback: Boolean(activeRotation.usedRawFallback),

    selectedTier: activeRotation.selectedTier || null,
    missingSides: Array.isArray(activeRotation.missingSides)
      ? activeRotation.missingSides.filter((side) => upper(side) !== OPPOSITE_TRADE_SIDE)
      : [],

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    bestShort: activeRotation.bestShort
      ? compactBestRow(activeRotation.bestShort)
      : null,
    bestLong: null
  };
}

function parseFilters(req) {
  const side = normalizeRequestedTradeSide(firstQueryValue(req.query?.side, TARGET_TRADE_SIDE));
  const familyId = String(firstQueryValue(req.query?.familyId, '') || '').trim();
  const macroFamilyId = String(firstQueryValue(req.query?.macroFamilyId, '') || '').trim();
  const parentTrueMicroFamilyId = String(firstQueryValue(req.query?.parentTrueMicroFamilyId, '') || '').trim();
  const setup = upper(firstQueryValue(req.query?.setup, ''));
  const regime = upper(firstQueryValue(req.query?.regime, ''));
  const confirmationProfile = upper(firstQueryValue(req.query?.confirmationProfile, ''));
  const q = String(firstQueryValue(req.query?.q, '') || '').trim().toUpperCase();

  return {
    side,
    familyId,
    macroFamilyId,
    parentTrueMicroFamilyId,
    setup,
    regime,
    confirmationProfile,
    q,

    activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false)),
    macroActiveOnly: isTrue(firstQueryValue(req.query?.macroActiveOnly, false)),
    includeEmpty: firstQueryValue(req.query?.includeEmpty, null) === null
      ? true
      : isTrue(firstQueryValue(req.query?.includeEmpty, true)),

    minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
    minSample: num(firstQueryValue(req.query?.minSample, 0), 0),
    minSeen: num(firstQueryValue(req.query?.minSeen, 0), 0),

    tier: String(firstQueryValue(req.query?.tier, '') || '').trim().toUpperCase(),
    status: String(firstQueryValue(req.query?.status, '') || '').trim().toUpperCase(),
    currentFit: String(firstQueryValue(req.query?.currentFit, '') || '').trim().toUpperCase()
  };
}

function hasNarrowFilters(filters = {}) {
  return Boolean(
    filters.side === 'LONG_DISABLED' ||
    filters.familyId ||
    filters.macroFamilyId ||
    filters.parentTrueMicroFamilyId ||
    filters.setup ||
    filters.regime ||
    filters.confirmationProfile ||
    filters.q ||
    filters.activeOnly ||
    filters.macroActiveOnly ||
    filters.minCompleted > 0 ||
    filters.minSample > 0 ||
    filters.minSeen > 0 ||
    filters.tier ||
    filters.status ||
    filters.currentFit ||
    filters.includeEmpty === false
  );
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.id,
    row.key,
    row.familyId,
    row.family,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    row.taxonomySetup,
    row.taxonomyRegime,
    row.confirmationProfile,
    row.setupType,
    row.regimeBucket,
    row.currentFit,
    row.currentMarketRegime,
    row.currentMarketTrendSide,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => upper(value))
    .join(' | ');

  return haystack.includes(q);
}

function rowPassesFilters(row = {}, filters, activeSet, activeMacroSet) {
  if (!row?.trueMicroFamilyId) return false;
  if (!isAnalyzeMicroRow(row)) return false;

  const exactId = row.trueMicroFamilyId;
  const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || row.macroFamilyId;
  const parsed = parseShortTaxonomyMicroId(exactId);

  if (filters.side === 'LONG_DISABLED') return false;
  if (filters.side && filters.side !== TARGET_TRADE_SIDE) return false;

  if (filters.familyId && String(row.familyId || '') !== filters.familyId) return false;
  if (filters.macroFamilyId && String(parentId || '') !== filters.macroFamilyId) return false;
  if (filters.parentTrueMicroFamilyId && String(parentId || '') !== filters.parentTrueMicroFamilyId) return false;

  if (filters.setup && parsed.setup !== filters.setup) return false;
  if (filters.regime && parsed.regime !== filters.regime) return false;
  if (filters.confirmationProfile && parsed.confirmationProfile !== filters.confirmationProfile) return false;

  if (filters.activeOnly && !activeSet.has(exactId)) return false;
  if (filters.macroActiveOnly && !activeMacroSet.has(parentId)) return false;

  if (filters.includeEmpty === false && num(row.observationSample ?? getObservationSample(row), 0) <= 0) return false;
  if (filters.minCompleted > 0 && num(row.outcomeSample ?? getCompletedSample(row), 0) < filters.minCompleted) return false;
  if (filters.minSample > 0 && num(row.winrateSample, 0) < filters.minSample) return false;
  if (filters.minSeen > 0 && num(row.seen, 0) < filters.minSeen) return false;

  if (filters.tier && upper(row.tier || row.rotationEligibilityTier) !== filters.tier) return false;
  if (filters.status && upper(row.status || row.learningStatus) !== filters.status) return false;
  if (filters.currentFit && upper(row.currentFit) !== filters.currentFit) return false;

  if (!rowMatchesSearch(row, filters.q)) return false;

  return true;
}

function compareNumberDesc(a, b) {
  return num(b, 0) - num(a, 0);
}

function compareNumberAsc(a, b) {
  return num(a, 0) - num(b, 0);
}

function compareIdAsc(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function learningQualityRank(row = {}) {
  const completed = num(row.outcomeSample ?? getCompletedSample(row), 0);
  const observations = num(row.observationSample ?? getObservationSample(row), 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 3;
  if (completed > 0) return 2;
  if (observations > 0) return 1;

  return 0;
}

function compareRowsWinrate(a, b) {
  return (
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound, b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
    compareNumberDesc(a.sampleBayesianWinrate ?? a.bayesianWinrate, b.sampleBayesianWinrate ?? b.bayesianWinrate) ||
    compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareNumberDesc(a.observationSample, b.observationSample) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsBestData(a, b) {
  return (
    compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.outcomeSample ?? getCompletedSample(a), b.outcomeSample ?? getCompletedSample(b)) ||
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(a.fairWinrate, b.fairWinrate) ||
    compareNumberDesc(a.sampleWilsonLowerBound ?? a.wilsonLowerBound, b.sampleWilsonLowerBound ?? b.wilsonLowerBound) ||
    compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
    compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) ||
    compareNumberDesc(a.observationSample ?? getObservationSample(a), b.observationSample ?? getObservationSample(b)) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsBalanced(a, b) {
  return compareRowsBestData(a, b);
}

function compareRowsAdaptive(a, b) {
  return (
    compareNumberDesc(a.adaptiveScore, b.adaptiveScore) ||
    compareRowsBestData(a, b)
  );
}

function compareRowsCurrentFit(a, b) {
  return (
    compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) ||
    compareRowsBestData(a, b)
  );
}

function compareRowsTotalR(a, b) {
  return (
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsAvgR(a, b) {
  return (
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.sampleAdjustedWinrate ?? a.fairWinrate, b.sampleAdjustedWinrate ?? b.fairWinrate) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsDirectSL(a, b) {
  return (
    compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
    compareNumberDesc(a.observationSample, b.observationSample) ||
    compareRowsWinrate(a, b)
  );
}

function compareRowsObserved(a, b) {
  return (
    compareNumberDesc(a.observationSample, b.observationSample) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareNumberDesc(a.observations, b.observations) ||
    compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) ||
    compareNumberDesc(a.outcomeSample, b.outcomeSample) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsCost(a, b) {
  return (
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareRowsBestData(a, b)
  );
}

function compareRowsByMode(a, b, mode = 'balanced') {
  if (mode === 'adaptive') return compareRowsAdaptive(a, b);
  if (mode === 'winrate') return compareRowsWinrate(a, b);
  if (mode === 'totalR') return compareRowsTotalR(a, b);
  if (mode === 'avgR') return compareRowsAvgR(a, b);
  if (mode === 'directSL') return compareRowsDirectSL(a, b);
  if (mode === 'observed') return compareRowsObserved(a, b);
  if (mode === 'cost') return compareRowsCost(a, b);
  if (mode === 'currentFit') return compareRowsCurrentFit(a, b);

  return compareRowsBalanced(a, b);
}

function sortRowsByMode(rows = [], mode = 'balanced') {
  return [...rows]
    .filter(isAnalyzeMicroRow)
    .sort((a, b) => compareRowsByMode(a, b, mode));
}

function sideCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const side = inferTradeSide(row);

      if (side === OPPOSITE_TRADE_SIDE) acc.long += 1;
      else acc.short += 1;

      if (side === 'UNKNOWN') acc.unknown += 1;

      return acc;
    },
    {
      short: 0,
      long: 0,
      unknown: 0
    }
  );
}

function tierCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const tier = upper(row.tier || row.rotationEligibilityTier || tierFor(row));

      if (tier === 'HARD') acc.HARD += 1;
      else if (tier === 'SOFT') acc.SOFT += 1;
      else if (tier === 'OBSERVATION') acc.OBSERVATION += 1;
      else acc.RAW += 1;

      return acc;
    },
    {
      HARD: 0,
      SOFT: 0,
      OBSERVATION: 0,
      RAW: 0
    }
  );
}

function statusCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const status = String(row.status || row.learningStatus || learningStatusFor(row)).toUpperCase();

    acc[status] = (acc[status] || 0) + 1;

    return acc;
  }, {});
}

function currentFitCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const key = upper(row.currentFit || 'UNKNOWN') || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {
    FIT: 0,
    OK: 0,
    NEUTRAL: 0,
    MISFIT: 0,
    UNKNOWN: 0
  });
}

function bestBy(rows = [], comparator) {
  return [...rows].filter(isAnalyzeMicroRow).sort(comparator)[0] || null;
}

function buildSideSummary(rows = []) {
  const shortRows = rows.filter(isAnalyzeMicroRow);

  return {
    rows: shortRows.length,
    bestBalanced: compactBestRow(bestBy(shortRows, compareRowsBalanced)),
    bestAdaptive: compactBestRow(bestBy(shortRows, compareRowsAdaptive)),
    bestCurrentFit: compactBestRow(bestBy(shortRows, compareRowsCurrentFit)),
    bestWinrate: compactBestRow(bestBy(shortRows, compareRowsWinrate)),
    bestTotalR: compactBestRow(bestBy(shortRows, compareRowsTotalR)),
    bestAvgR: compactBestRow(bestBy(shortRows, compareRowsAvgR)),
    lowestDirectSL: compactBestRow(bestBy(shortRows, compareRowsDirectSL))
  };
}

function buildParentSummaries(rows = []) {
  const groups = new Map();

  for (const row of rows.filter(isAnalyzeMicroRow)) {
    const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || row.macroFamilyId;
    if (!parentId) continue;

    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId).push(row);
  }

  return [...groups.entries()]
    .map(([parentTrueMicroFamilyId, childRows]) => {
      const parsed = parseShortTaxonomyMicroId(parentTrueMicroFamilyId);
      const completed = childRows.reduce((sum, row) => sum + num(row.outcomeSample ?? getCompletedSample(row), 0), 0);
      const observationSample = childRows.reduce((sum, row) => sum + num(row.observationSample ?? getObservationSample(row), 0), 0);
      const totalR = childRows.reduce((sum, row) => sum + getTotalR(row), 0);
      const totalCostR = childRows.reduce((sum, row) => sum + getTotalCostR(row), 0);
      const directSLCount = childRows.reduce((sum, row) => sum + getDirectSLCount(row), 0);
      const fitScoreSum = childRows.reduce((sum, row) => sum + num(row.currentFitScore ?? row.fitScore, 0), 0);

      return {
        parentTrueMicroFamilyId,
        macroFamilyId: parentTrueMicroFamilyId,
        taxonomySetup: parsed.setup,
        taxonomyRegime: parsed.regime,

        childCount: childRows.length,
        selectableChildCount: childRows.filter((row) => isSelectableTrueMicroId(row.trueMicroFamilyId)).length,

        completed: round(completed, 4),
        observationSample: round(observationSample, 4),
        totalR: round(totalR, 4),
        avgR: completed > 0 ? round(totalR / completed, 4) : 0,
        totalCostR: round(totalCostR, 4),
        avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0,
        directSLCount: round(directSLCount, 4),
        directSLPct: completed > 0 ? round(directSLCount / completed, 4) : 0,

        avgCurrentFitScore: childRows.length > 0
          ? round(fitScoreSum / childRows.length, 4)
          : 0,

        currentFitCounts: currentFitCounts(childRows),

        bestBalanced: compactBestRow(bestBy(childRows, compareRowsBalanced)),
        bestAdaptive: compactBestRow(bestBy(childRows, compareRowsAdaptive)),
        bestCurrentFit: compactBestRow(bestBy(childRows, compareRowsCurrentFit)),
        bestWinrate: compactBestRow(bestBy(childRows, compareRowsWinrate)),
        bestTotalR: compactBestRow(bestBy(childRows, compareRowsTotalR)),
        bestAvgR: compactBestRow(bestBy(childRows, compareRowsAvgR))
      };
    })
    .sort((a, b) => (
      compareNumberDesc(a.completed, b.completed) ||
      compareNumberDesc(a.totalR, b.totalR) ||
      compareNumberDesc(a.avgCurrentFitScore, b.avgCurrentFitScore) ||
      compareIdAsc(a.parentTrueMicroFamilyId, b.parentTrueMicroFamilyId)
    ));
}

function buildSummary(rows = [], activeSet = new Set()) {
  const safeRows = rows.filter(isAnalyzeMicroRow);

  const completedRows = safeRows.filter((row) => num(row.outcomeSample, 0) > 0);
  const observationRows = safeRows.filter((row) => num(row.observationSample, 0) > 0);
  const activeLearningRows = safeRows.filter((row) => row.status === 'ACTIVE_LEARNING');
  const earlyOutcomeRows = safeRows.filter((row) => row.status === 'EARLY_OUTCOMES');
  const observingRows = safeRows.filter((row) => row.status === 'OBSERVING');

  const activeRows = safeRows.filter((row) => activeSet.has(row.trueMicroFamilyId));

  let totalR = 0;
  let totalSeen = 0;
  let totalCompleted = 0;
  let totalObservationSample = 0;
  let totalWinrateSample = 0;
  let totalCostR = 0;
  let totalDirectSLCount = 0;
  let totalObservationDuplicateSkippedCount = 0;
  let totalCurrentFitScore = 0;

  for (const row of safeRows) {
    totalR += getTotalR(row);
    totalSeen += num(row.seen, 0);
    totalCompleted += num(row.outcomeSample, 0);
    totalObservationSample += num(row.observationSample, 0);
    totalWinrateSample += num(row.winrateSample, 0);
    totalCostR += getTotalCostR(row);
    totalDirectSLCount += getDirectSLCount(row);
    totalObservationDuplicateSkippedCount += getObservationDuplicateSkippedCount(row);
    totalCurrentFitScore += num(row.currentFitScore ?? row.fitScore, 0);
  }

  return {
    rows: safeRows.length,
    activeRows: activeRows.length,
    activeIds: activeSet.size,

    ...modePayload(),

    seen: round(totalSeen, 4),
    completed: round(totalCompleted, 4),
    observationSample: round(totalObservationSample, 4),
    observationDuplicateSkippedCount: round(totalObservationDuplicateSkippedCount, 4),
    winrateSample: round(totalWinrateSample, 4),
    seenCompletedRatio: totalCompleted > 0 ? round(totalSeen / totalCompleted, 4) : round(totalSeen, 4),

    completedMicroFamilies: completedRows.length,
    observationMicroFamilies: observationRows.length,
    awaitingOutcomeMicroFamilies: safeRows.filter((row) => row.awaitingOutcomes).length,

    activeLearningMicroFamilies: activeLearningRows.length,
    earlyOutcomeMicroFamilies: earlyOutcomeRows.length,
    observingMicroFamilies: observingRows.length,

    hardMicroFamilies: tierCounts(safeRows).HARD,
    softMicroFamilies: tierCounts(safeRows).SOFT,
    observationOnlyMicroFamilies: tierCounts(safeRows).OBSERVATION,
    rawMicroFamilies: tierCounts(safeRows).RAW,

    tierCounts: tierCounts(safeRows),
    statusCounts: statusCounts(safeRows),
    currentFitCounts: currentFitCounts(safeRows),

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: totalCompleted > 0 ? round(totalR / totalCompleted, 4) : 0,
    avgCostR: totalCompleted > 0 ? round(totalCostR / totalCompleted, 4) : 0,

    directSLCount: round(totalDirectSLCount, 4),
    directSLPct: totalCompleted > 0 ? round(totalDirectSLCount / totalCompleted, 4) : 0,

    avgCurrentFitScore: safeRows.length > 0
      ? round(totalCurrentFitScore / safeRows.length, 4)
      : 0,

    bestAdaptive: compactBestRow(bestBy(safeRows, compareRowsAdaptive)),
    bestCurrentFit: compactBestRow(bestBy(safeRows, compareRowsCurrentFit)),
    bestBalanced: compactBestRow(bestBy(safeRows, compareRowsBalanced)),
    bestTotalR: compactBestRow(bestBy(safeRows, compareRowsTotalR)),
    bestAvgR: compactBestRow(bestBy(safeRows, compareRowsAvgR)),
    bestWinrate: compactBestRow(bestBy(safeRows, compareRowsWinrate)),
    bestObserved: compactBestRow(bestBy(safeRows, compareRowsObserved)),
    lowestDirectSL: compactBestRow(bestBy(safeRows, compareRowsDirectSL)),

    short: buildSideSummary(safeRows),

    long: {
      rows: 0,
      bestBalanced: null,
      bestWinrate: null,
      bestTotalR: null,
      bestAvgR: null,
      lowestDirectSL: null
    }
  };
}

async function getActiveRotationSafe() {
  try {
    return await withTimeout(
      getActiveRotation({
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        weekKey: PERSISTENT_LEARNING_KEY,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX
      }),
      ACTIVE_ROTATION_TIMEOUT_MS,
      'GET_ACTIVE_ROTATION_TIMEOUT'
    );
  } catch {
    return null;
  }
}

function getCachedWeekMicros(weekKey) {
  const cached = cache.weekMicros.get(weekKey);

  if (!cached) return null;
  if (now() - cached.ts > CACHE_TTL_MS) return null;

  return cached.micros || {};
}

async function getWeekMicrosCached(weekKey, timeoutMs) {
  const cached = getCachedWeekMicros(weekKey);

  if (cached) {
    return {
      weekKey,
      micros: cached,
      cacheHit: true,
      stale: false,
      warning: null
    };
  }

  try {
    const micros = await withTimeout(
      getWeekMicros(weekKey),
      timeoutMs,
      `GET_WEEK_MICROS_TIMEOUT_${weekKey}`
    );

    cache.weekMicros.set(weekKey, {
      ts: now(),
      micros: micros || {}
    });

    pruneCacheMap(cache.weekMicros);

    return {
      weekKey,
      micros: micros || {},
      cacheHit: false,
      stale: false,
      warning: null
    };
  } catch (error) {
    const stale = cache.weekMicros.get(weekKey);

    if (stale?.micros) {
      return {
        weekKey,
        micros: stale.micros,
        cacheHit: true,
        stale: true,
        warning: error?.message || String(error)
      };
    }

    return {
      weekKey,
      micros: {},
      cacheHit: false,
      stale: false,
      warning: error?.message || String(error)
    };
  }
}

function normalizeRows(rows = [], activeSet, activeMacroSet, compact) {
  return rows
    .filter(isAnalyzeMicroRow)
    .map((row, index) => normalizeMicroRow(row, index, {
      activeSet,
      activeMacroSet,
      compact
    }));
}

function selectBestMicroFamilyRows({
  rows = [],
  mode = 'adaptive',
  limit = DEFAULT_BEST_LIMIT
} = {}) {
  const safeLimit = toSafeLimit(limit, DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);

  return sortRowsByMode(
    rows.filter(isAnalyzeMicroRow),
    mode
  )
    .slice(0, safeLimit)
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

function selectResponseRows({
  rankedRows = [],
  limit = DEFAULT_LIMIT,
  filters = {}
} = {}) {
  if (filters.side === 'LONG_DISABLED') return [];

  return rankedRows
    .filter(isAnalyzeMicroRow)
    .slice(0, limit);
}

function splitSideRows(rows = [], sideLimit = DEFAULT_SIDE_LIMIT) {
  const shortRows = rows
    .filter(isAnalyzeMicroRow)
    .slice(0, sideLimit);

  return {
    shortRows,
    longRows: [],
    unknownRows: []
  };
}

function forcedShortFallbackRows(activeRotation, existingRows = [], marketWeather = null) {
  const existing = new Set(existingRows.map(rowKey).filter(Boolean));
  const rows = [];

  for (const id of extractActiveIds(activeRotation)) {
    if (existing.has(id)) continue;
    if (inferTradeSide(id) === OPPOSITE_TRADE_SIDE) continue;
    if (!validLearningId(id)) continue;
    if (!isSelectableTrueMicroId(id)) continue;

    const manual = manualRowFromId(id, rows.length, marketWeather);
    if (!manual) continue;

    rows.push(manual);
    existing.add(id);
  }

  return rows;
}

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'short-only-75-child-true-micro-net-outcome-currentfit-v2');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Virtual-Outcomes-Included', 'true');
  res.setHeader('X-Shadow-Outcomes-Included', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
  res.setHeader('X-Scanner-Fingerprint-Legacy-Fallback', String(SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK));
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Execution-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Analyze-Micro-Families-Only', 'true');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');
  res.setHeader('X-Default-Sort', 'ADAPTIVE_BALANCED_SCORE_NOT_RAW_WINRATE');
  res.setHeader('X-Measurement-Fix-Version', MEASUREMENT_FIX_VERSION);
  res.setHeader('X-Completed-Definition', 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES');
  res.setHeader('X-Scoring-R-Source', 'netR');
  res.setHeader('X-Wins-Losses-Flats-Source', 'netR');
  res.setHeader('X-Avg-Cost-R-Source', 'costR');
  res.setHeader('X-Seen-Definition', 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY');
  res.setHeader('X-Current-Fit-Version', CURRENT_FIT_VERSION);
  res.setHeader('X-Current-Fit-Blocks-Learning', 'false');
  res.setHeader('X-Current-Fit-Score-Built', 'true');
  res.setHeader('X-MarketWeather-Engine-Built', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const currentWeekKey = PERSISTENT_LEARNING_KEY;
    const previousWeekKey = PERSISTENT_LEARNING_KEY;

    const requestedQueryWeekKey = String(
      firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) || PERSISTENT_LEARNING_KEY
    ).trim();

    const requestedWeekKey = PERSISTENT_LEARNING_KEY;

    const requestedMode = String(firstQueryValue(req.query?.mode, 'adaptive') || 'adaptive');
    const mode = normalizeMode(requestedMode);

    const requestedLimitRaw = firstQueryValue(req.query?.limit, DEFAULT_LIMIT);
    const requestedLimitNumber = Number(requestedLimitRaw) || DEFAULT_LIMIT;
    const limit = toSafeLimit(requestedLimitRaw, DEFAULT_LIMIT, MAX_LIMIT);

    const sideLimit = toSafeLimit(
      firstQueryValue(
        req.query?.sideLimit,
        firstQueryValue(req.query?.sideEnsureLimit, DEFAULT_SIDE_LIMIT)
      ),
      DEFAULT_SIDE_LIMIT,
      MAX_SIDE_LIMIT
    );

    const bestLimit = toSafeLimit(
      firstQueryValue(req.query?.bestLimit, DEFAULT_BEST_LIMIT),
      DEFAULT_BEST_LIMIT,
      MAX_BEST_LIMIT
    );

    const includeActiveRotation = isTrue(firstQueryValue(req.query?.includeActiveRotation, false));
    const details = isTrue(firstQueryValue(req.query?.details, false));
    const compactRaw = firstQueryValue(req.query?.compact, null);

    const compact = details
      ? false
      : compactRaw === null
        ? true
        : isTrue(compactRaw);

    const filters = parseFilters(req);
    const narrowFilters = hasNarrowFilters(filters);

    const [activeRotation, weekResult, marketWeather] = await Promise.all([
      getActiveRotationSafe(),
      getWeekMicrosCached(PERSISTENT_LEARNING_KEY, WEEK_MICROS_TIMEOUT_MS),
      getCurrentMarketWeatherSafe()
    ]);

    const activeMicroFamilyIds = extractActiveIds(activeRotation);
    const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);

    const activeSet = new Set(activeMicroFamilyIds);
    const activeMacroSet = new Set(activeMacroFamilyIds);

    const taxonomyRows = filters.includeEmpty
      ? generateShortTaxonomyRows()
        .map((row, index) => decorateMicroRow(
          buildRawMicroRow(row, row.trueMicroFamilyId, index),
          marketWeather
        ))
        .filter(Boolean)
      : [];

    const weekRows = buildRowsFromMicros(weekResult.micros, marketWeather);
    const activeFallbackRows = buildRowsFromActiveRotation(activeRotation, marketWeather);

    let mergedRows = mergeRows(
      mergeRows(weekRows, activeFallbackRows),
      taxonomyRows
    );

    if (mergedRows.length === 0 && activeFallbackRows.length > 0) {
      mergedRows = activeFallbackRows;
    }

    mergedRows = mergedRows.map((row) => {
      const id = getTrueMicroFamilyId(row);
      const parent = getCoarseMicroFamilyId(row);

      return {
        ...row,
        active: Boolean(row.active || activeSet.has(id)),
        macroActive: Boolean(row.macroActive || activeMacroSet.has(parent))
      };
    });

    let filteredRows = mergedRows.filter((row) => (
      rowPassesFilters(row, filters, activeSet, activeMacroSet)
    ));

    const usedForcedShortFallback =
      filters.side === TARGET_TRADE_SIDE &&
      filteredRows.length === 0 &&
      activeRotation;

    if (usedForcedShortFallback) {
      const fallbackShortRows = forcedShortFallbackRows(activeRotation, mergedRows, marketWeather);

      if (fallbackShortRows.length > 0) {
        mergedRows = mergeRows(mergedRows, fallbackShortRows);
        filteredRows = fallbackShortRows.filter((row) => (
          rowPassesFilters(row, filters, activeSet, activeMacroSet)
        ));
      }
    }

    const best75RawRows = selectBestMicroFamilyRows({
      rows: mergedRows,
      mode,
      limit: bestLimit
    });

    const best75MicroFamilies = normalizeRows(
      best75RawRows,
      activeSet,
      activeMacroSet,
      compact
    );

    const rankedRows = sortRowsByMode(filteredRows, mode)
      .map((row, index) => ({
        ...row,
        rank: index + 1
      }));

    const responseRows = selectResponseRows({
      rankedRows,
      limit,
      filters
    });

    const displayRows = narrowFilters
      ? responseRows
      : best75RawRows;

    const splitBaseRows = narrowFilters
      ? rankedRows
      : best75RawRows;

    const split = splitSideRows(splitBaseRows, sideLimit);

    const normalizedRows = normalizeRows(displayRows, activeSet, activeMacroSet, compact);
    const normalizedShortRows = normalizeRows(split.shortRows, activeSet, activeMacroSet, compact);

    const summary = buildSummary(rankedRows, activeSet);
    const parentSummaries = buildParentSummaries(mergedRows);

    const bestShort =
      best75RawRows[0] ||
      split.shortRows[0] ||
      null;

    const rawScannerFingerprintRowsHidden = sourceEntriesFromMicros(weekResult.micros)
      .filter(([key, row]) => {
        const id = String(
          row?.trueMicroFamilyId ||
          row?.learningMicroFamilyId ||
          row?.analyzeMicroFamilyId ||
          row?.microFamilyId ||
          key ||
          ''
        );

        return (
          isScannerFingerprintId(id) ||
          isScannerFingerprintId(row?.trueMicroFamilyId) ||
          isScannerFingerprintId(row?.coarseMicroFamilyId)
        );
      })
      .length;

    const rawExecutionFingerprintRowsHidden = sourceEntriesFromMicros(weekResult.micros)
      .filter(([key, row]) => {
        const id = String(
          row?.trueMicroFamilyId ||
          row?.learningMicroFamilyId ||
          row?.analyzeMicroFamilyId ||
          row?.microFamilyId ||
          key ||
          ''
        );

        return (
          isExecutionFingerprintId(id) ||
          isExecutionFingerprintId(row?.trueMicroFamilyId) ||
          isExecutionFingerprintId(row?.coarseMicroFamilyId)
        );
      })
      .length;

    const parentRowsHidden = sourceEntriesFromMicros(weekResult.micros)
      .filter(([key, row]) => {
        const id = String(
          row?.trueMicroFamilyId ||
          row?.learningMicroFamilyId ||
          row?.analyzeMicroFamilyId ||
          row?.microFamilyId ||
          key ||
          ''
        );

        return isFixedShortParentMicroId(id);
      })
      .length;

    const nonSelectableRowsHidden = sourceEntriesFromMicros(weekResult.micros)
      .filter(([key, row]) => {
        const id = String(
          row?.trueMicroFamilyId ||
          row?.learningMicroFamilyId ||
          row?.analyzeMicroFamilyId ||
          row?.microFamilyId ||
          key ||
          ''
        );

        return Boolean(id && !isScannerFingerprintId(id) && !isExecutionFingerprintId(id) && !isSelectableTrueMicroId(id));
      })
      .length;

    const fitCounts = currentFitCounts(mergedRows);
    const currentFitUnknownRows = fitCounts.UNKNOWN || 0;

    const warnings = uniqueStrings([
      requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}`
        : null,
      weekResult.warning,
      marketWeather.available !== true
        ? `MARKET_WEATHER_UNAVAILABLE:${marketWeather.reason || 'UNKNOWN'}`
        : null,
      marketWeather.staleFallbackUsed
        ? 'MARKET_WEATHER_STALE_FALLBACK_USED_CURRENTFIT_STILL_ENABLED'
        : null,
      currentFitUnknownRows >= mergedRows.length && mergedRows.length > 0
        ? 'CURRENTFIT_ALL_UNKNOWN_MARKET_WEATHER_NOT_USABLE'
        : null,
      weekRows.length === 0 && activeFallbackRows.length > 0
        ? 'USED_ACTIVE_ROTATION_FALLBACK_ROWS'
        : null,
      usedForcedShortFallback
        ? 'USED_FORCED_SHORT_ACTIVE_ROTATION_FALLBACK'
        : null,
      rawScannerFingerprintRowsHidden > 0
        ? `SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawScannerFingerprintRowsHidden}`
        : null,
      rawExecutionFingerprintRowsHidden > 0
        ? `EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawExecutionFingerprintRowsHidden}`
        : null,
      parentRowsHidden > 0
        ? `PARENT_15_ROWS_HIDDEN_FROM_SELECTABLE_LIST_METADATA_ONLY:${parentRowsHidden}`
        : null,
      nonSelectableRowsHidden > 0
        ? `NON_75_CHILD_ROWS_HIDDEN:${nonSelectableRowsHidden}`
        : null,
      rankedRows.length === 0
        ? 'NO_SELECTABLE_75_CHILD_TRUE_MICRO_ROWS_AFTER_FILTERS'
        : null,
      best75MicroFamilies.length === 0
        ? 'NO_BEST75_SELECTABLE_TRUE_MICRO_FAMILIES_AVAILABLE'
        : null
    ].filter(Boolean));

    return res.status(200).json({
      ok: true,
      fixed: true,

      ...modePayload(),

      availableTiers: ['HARD', 'SOFT', 'OBSERVATION', 'RAW'],
      availableStatuses: ['ACTIVE_LEARNING', 'EARLY_OUTCOMES', 'OBSERVING'],
      availableCurrentFit: ['FIT', 'OK', 'NEUTRAL', 'MISFIT', 'UNKNOWN'],

      measurementPolicy: {
        version: MEASUREMENT_FIX_VERSION,
        avgCostR: 'avgCostR = totalCostR / closedVirtualShadowCompleted, fallback avgCostR/costR/recentOutcomes.costR',
        totalCostR: 'virtualTotalCostR + shadowTotalCostR when > 0, fallback totalCostR, fallback avgCostR * completed, fallback costR * completed, fallback recentOutcomes.costR * completed',
        directSL: 'directSLCount / closedVirtualShadowCompleted',
        seen: 'seen and observations come only from unique observation dedupe keys',
        completed: 'closed VIRTUAL + SHADOW outcomes only',
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        rawWinrateRankingDisabled: true
      },

      currentFitPolicy: {
        version: CURRENT_FIT_VERSION,
        marketWeatherKeys: marketWeatherKeyCandidates(),
        marketWeatherRawLegacyKeyReadDisabled: true,
        marketWeatherAvailable: Boolean(marketWeather.available),
        sourceKey: marketWeather.sourceKey || null,
        redisSource: marketWeather.redisSource || null,
        currentRegime: marketWeather.currentRegime,
        currentTrendSide: marketWeather.currentTrendSide,
        bullishPct: marketWeather.bullishPct,
        bearishPct: marketWeather.bearishPct,
        squeezePct: marketWeather.squeezePct,
        confidence: marketWeather.confidence,
        staleFallbackUsed: Boolean(marketWeather.staleFallbackUsed),
        reason: marketWeather.reason || null,
        softOnly: true,
        blocksLearning: false,
        blocksVirtualLearning: false,
        blocksShadowLearning: false,
        canBlockDiscordOnly: true,
        polarity: 'bearish market = positive for SHORT; bullish market = negative for SHORT',
        definition: 'SHORT_MIRRORED_CURRENT_FIT'
      },

      riskOutcomePolicy: {
        side: TARGET_TRADE_SIDE,
        validGeometry: 'tp < entry < sl',
        tpHit: 'price <= tp',
        slHit: 'price >= sl',
        grossR: '(entry - exitPrice) / (initialSl - entry)',
        currentR: '(entry - currentPrice) / (initialSl - entry)',
        realOrdersDisabled: true,
        virtualOutcomesIncluded: true,
        shadowOutcomesIncluded: true,
        realOutcomesExcluded: true
      },

      statusRules: {
        OBSERVING: 'completed == 0',
        EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
        ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
      },

      taxonomy: {
        parentCount: 15,
        selectableChildCount: 75,
        setups: SETUP_ORDER,
        regimes: REGIME_ORDER,
        confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
        parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
        childFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
        selectableIdsAreChildrenOnly: true,
        parentIdsAreMetadataOnly: true,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
      },

      rankingPolicy: {
        defaultMode: 'adaptive',
        activeMode: mode,
        defaultSort: 'adaptiveScore/dashboardBalancedScore/fairWinrate/totalR/avgR/avgCostR/directSL/completed',
        bestDataFirst: true,
        completedBeforeRawScore: true,
        rawWinrateIsNeverDefault: true,
        rawWinrateIsNeverAlone: true,
        scoreKeys: ['adaptiveScore', 'dashboardBalancedScore', 'balancedScore', 'fairWinrate', 'totalR', 'avgR', 'avgCostR', 'currentFitScore'],
        scannerFingerprintsExcludedFromRows: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK !== true,
        scannerFingerprintLegacyFallback: SHOW_SCANNER_FINGERPRINT_LEGACY_FALLBACK,
        scannerFingerprintsMetadataOnly: true,
        scannerFingerprintLegacyFallbackRows: 0,
        rawScannerFingerprintRowsHidden,
        rawExecutionFingerprintRowsHidden,
        parentRowsHidden,
        nonSelectableRowsHidden,
        executionFingerprintsMetadataOnly: true,
        analyzeMicroFamiliesOnly: true,
        trueMicroFamilyOnly: true,
        exactTrueMicroOnly: true,
        selectableChildOnly: true,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,
        parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
        symbolExcludedFromFamilyId: true,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        weekResetDisabled: true,
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        winrateDefinition: 'netR > 0',
        avgCostRSource: 'costR'
      },

      adaptiveLayerPolicy: {
        learningRemainsBroad: true,
        selectionWillBeAdaptive: true,
        discordWillBeStrict: true,
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false,
        adaptiveLayerBuilt: false,
        marketWeatherEngineBuilt: true,
        recentMomentumScoreBuilt: false,
        currentFitScoreBuilt: true,
        parentDiversificationBuilt: false,
        buildAdaptiveLayerAfterMeasurementClean: true
      },

      weekKey: PERSISTENT_LEARNING_KEY,
      requestedWeekKey,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? requestedQueryWeekKey
        : null,
      sourceWeekKeyUsed: PERSISTENT_LEARNING_KEY,
      source: 'persistentLearningKey',

      currentWeekKey,
      previousWeekKey,

      primaryWeekKey: PERSISTENT_LEARNING_KEY,
      primaryWeekRows: microsCount(weekResult.micros),
      previousWeekRows: 0,
      mergedPreviousWeek: false,

      recentWeekLookback: 1,
      recentWeekKeysScanned: [PERSISTENT_LEARNING_KEY],
      recentWeekRows: [{
        weekKey: PERSISTENT_LEARNING_KEY,
        rows: microsCount(weekResult.micros),
        cacheHit: Boolean(weekResult.cacheHit),
        stale: Boolean(weekResult.stale)
      }],
      allRecentWeekKeysChecked: [PERSISTENT_LEARNING_KEY],
      allRecentWeekRowsChecked: [{
        weekKey: PERSISTENT_LEARNING_KEY,
        rows: microsCount(weekResult.micros),
        cacheHit: Boolean(weekResult.cacheHit),
        stale: Boolean(weekResult.stale)
      }],

      mode,
      requestedMode,

      requestedLimit: requestedLimitNumber,
      limit,
      limitCapped: requestedLimitNumber > limit,
      sideLimit,
      sideEnsureLimit: sideLimit,

      bestLimit,
      best75Count: best75MicroFamilies.length,
      best75MicroFamilies,
      best25Count: best75MicroFamilies.slice(0, 25).length,
      best25MicroFamilies: best75MicroFamilies.slice(0, 25),
      topMicroFamilies: best75MicroFamilies,
      bestMicroFamilies: best75MicroFamilies,

      filters,
      narrowFilters,
      compact,

      count: normalizedRows.length,
      rowsRendered: normalizedRows.length,
      filtered: rankedRows.length,
      totalAvailable: mergedRows.length,
      rawExtractedRows: mergedRows.length,
      generatedSelectableTaxonomyRows: taxonomyRows.length,
      selectableChildFamiliesTotal: 75,
      parentFamiliesTotal: 15,
      weekRows: weekRows.length,
      activeFallbackRows: activeFallbackRows.length,
      scannerFingerprintLegacyRows: 0,
      rawScannerFingerprintRowsHidden,
      rawExecutionFingerprintRowsHidden,
      parentRowsHidden,
      nonSelectableRowsHidden,

      rawSideCounts: sideCounts(mergedRows),
      filteredSideCounts: sideCounts(rankedRows),
      responseSideCounts: sideCounts(normalizedRows),
      best75SideCounts: sideCounts(best75MicroFamilies),

      tierCounts: tierCounts(rankedRows),
      statusCounts: statusCounts(rankedRows),
      currentFitCounts: fitCounts,
      currentFitUnknownRows,

      activeRotationId: activeRotation?.rotationId || null,
      activeRotation: includeActiveRotation
        ? activeRotation
        : compactActiveRotation(activeRotation),

      activeMicroFamilyIds,
      activeMacroFamilyIds,

      bestShort: compactBestRow(bestShort),
      bestLong: null,

      parentSummaries,

      shortRows: normalizedShortRows,
      longRows: [],
      unknownRows: [],

      summary,
      rows: normalizedRows,

      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      rankingPolicyText: 'adaptiveScore|balancedScore|fairWinrate|totalR|avgR|avgCostR|currentFitScore',
      rankingPolicyShort: 'adaptiveScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
      measurementFixVersion: MEASUREMENT_FIX_VERSION,
      adaptiveUiVersion: ADAPTIVE_UI_VERSION,
      currentFitVersion: CURRENT_FIT_VERSION,

      warnings,
      error: null,

      perf: {
        durationMs: now() - startedAt,
        weekMicrosCacheHit: Boolean(weekResult.cacheHit),
        weekMicrosCacheStale: Boolean(weekResult.stale),
        weekMicrosCacheSize: cache.weekMicros.size,
        marketWeatherCacheHit: Boolean(cache.marketWeather),
        path: 'shortOnly75ChildPersistentLearningNetOutcomeObservationFirstAnalyzeTrueMicroOnlyScannerFingerprintMetadataOnlyCurrentFitMarketWeatherAvgCostRFallbackFixV2',
        best75Source: 'persistentLearningMergedRowsBeforeFilters'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...modePayload(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}