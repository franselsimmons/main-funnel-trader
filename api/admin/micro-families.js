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

const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const TRUE_MICRO_SCHEMA = CHILD_TRUE_MICRO_SCHEMA;

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_MARKER = `_${MICRO_MICRO_SUFFIX}_`;
const MICRO_MICRO_HASH_LEN = 10;
const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V1';

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MICRO_MICRO_ONLY_V3';
const CURRENT_FIT_VERSION = 'SHORT_CURRENTFIT_MARKETWEATHER_SOFT_V3_SELF_HEAL';

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

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const DEFAULT_RANK_MODE = 'winrate';

const VALID_MODES = new Set([
  'adaptive',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed',
  'cost',
  'currentFit',
  'microMicro'
]);

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;

const SAMPLE_RELIABILITY_CAP = 50;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 6;
const MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES = 2;

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 300;
const DEFAULT_BEST_LIMIT = 120;
const MAX_BEST_LIMIT = 300;
const DEFAULT_SIDE_LIMIT = 120;
const MAX_SIDE_LIMIT = 300;

const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const WEEK_MICROS_TIMEOUT_MS = 9_500;
const MARKET_WEATHER_REDIS_TIMEOUT_MS = 700;
const MARKET_WEATHER_TTL_MS = 60_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_KEYS = 20;

const cache = globalThis.__ADMIN_MICRO_FAMILIES_SHORT_MICRO_MICRO_ONLY_CACHE__ ||= {
  weekMicros: new Map(),
  marketWeather: null
};

function now() {
  return Date.now();
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
  const n = num(value, 0);
  return Number(n.toFixed(decimals));
}

function clamp(value, min = 0, max = 1) {
  const n = num(value, min);
  return Math.max(min, Math.min(max, n));
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

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const out = [];

  while (stack.length) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    out.push(value);
  }

  return out;
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

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function firstFiniteNumber(values = []) {
  for (const value of flattenValues(values)) {
    if (value === undefined || value === null || value === '') continue;

    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
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

function normalizeMicroMicroHash(value = '') {
  const raw = upper(value).replace(/[^A-Z0-9]/g, '');

  if (raw.length >= 3) return raw.slice(0, MICRO_MICRO_HASH_LEN);

  return '';
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, Math.max(1, timeoutMs));
  });

  return Promise
    .race([promise, timeoutPromise])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function redisClientsVolatileFirst() {
  const clients = [];

  try {
    const volatileRedis = getVolatileRedis();
    if (volatileRedis) clients.push({ name: 'volatile', redis: volatileRedis });
  } catch {
    // ignore
  }

  try {
    const durableRedis = getDurableRedis();
    if (durableRedis) clients.push({ name: 'durable', redis: durableRedis });
  } catch {
    // ignore
  }

  return clients;
}

async function softReadJson(redis, key, fallback = null, timeoutMs = MARKET_WEATHER_REDIS_TIMEOUT_MS) {
  if (!redis || !key) return fallback;

  let timer = null;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), Math.max(1, timeoutMs));
  });

  try {
    const value = await Promise.race([
      getJson(redis, key, fallback),
      timeoutPromise
    ]);

    if (value?.__timeout) return fallback;

    return value ?? fallback;
  } catch {
    return fallback;
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

function rawNeutralKey(key, fallback = MARKET_WEATHER_KEY) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return MARKET_WEATHER_KEY;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw.slice(SHORT_KEY_PREFIX.length);
  if (raw.startsWith('LONG:')) return raw.slice('LONG:'.length);

  return raw;
}

function marketWeatherKeyCandidates() {
  return uniqueStrings([
    SHORT_MARKET_WEATHER_KEY,
    namespacedShortKey(KEYS?.short?.market?.weatherLatest),
    namespacedShortKey(KEYS?.short?.market?.weather),
    namespacedShortKey(KEYS?.market?.shortWeatherLatest),
    namespacedShortKey(KEYS?.market?.shortWeather),
    namespacedShortKey(MARKET_WEATHER_KEY)
  ]);
}

function rawMarketWeatherKeyCandidates() {
  return uniqueStrings([
    MARKET_WEATHER_KEY,
    rawNeutralKey(KEYS?.market?.weatherLatest),
    rawNeutralKey(KEYS?.market?.weather),
    rawNeutralKey(KEYS?.marketWeather?.latest),
    rawNeutralKey(KEYS?.weather?.latest)
  ]).filter((key) => !String(key).startsWith('LONG:'));
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
    noRealOrders: true,
    noExchangeOrders: true,

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    virtualPositionsOnly: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    netOutcomesOnly: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRSource: 'costR',
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    manualSelectionOnly: true,
    manualSelectionRequired: true,
    autoRotationActivationDisabled: true,
    maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxActiveDiscordMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY',

    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    child75MatchDoesNotTriggerDiscord: true,
    scannerMatchDoesNotTriggerDiscord: true,
    executionFingerprintMatchDoesNotTriggerDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'METADATA_TO_MICRO_MICRO_CONTEXT_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY_ID_FOR_SELECTION',
    symbolExcludedFromFamilyId: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75ContextFamilyCount: 75,
    selectableChildMicroFamilyCount: 0,
    selectableMicroMicroOnly: true,
    selectableChild75Allowed: false,
    selectableParentAllowed: false,

    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75FamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    microMicroFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',

    learningRemainsBroad: true,
    parent15StillMetadataOnly: true,
    child75StillContextOnly: true,
    child75HiddenFromAdminRows: true,
    microMicroLayerEnabled: true,
    microMicroActsAsExecutionPreference: true,
    microMicroSelectionOnly: true,

    currentFitVersion: CURRENT_FIT_VERSION,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscordOnly: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    adaptiveLayerBuilt: true,
    marketWeatherEngineBuilt: true,
    currentFitScoreBuilt: true,
    microMicroLayerBuilt: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    rankingPrimary: 'FAIR_WINRATE_THEN_NET_TOTALR',
    rankingDefaultMode: DEFAULT_RANK_MODE,
    rankingPnlSource: 'totalR',
    rankingWinrateSource: 'fairWinrate',

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

    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
  };
}

function normalizeMode(value) {
  const raw = String(value || DEFAULT_RANK_MODE).trim();

  if (VALID_MODES.has(raw)) return raw;

  const rawLower = lower(raw);

  if (rawLower === 'totalr') return 'totalR';
  if (rawLower === 'avgr') return 'avgR';
  if (rawLower === 'directsl') return 'directSL';
  if (rawLower === 'currentfit') return 'currentFit';
  if (rawLower === 'micromicro') return 'microMicro';

  return VALID_MODES.has(rawLower) ? rawLower : DEFAULT_RANK_MODE;
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
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'DIRECTION_LONG'
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
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'DIRECTION_SHORT'
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

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
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
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  if (value.startsWith('MICRO_SHORT_') && value.includes(MICRO_MICRO_MARKER)) return false;

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('REFINED_EXECUTION')
  );
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
      isBaseChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  if (isScannerFingerprintId(value) || isExecutionFingerprintId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isBaseChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  let body = value.slice('MICRO_SHORT_'.length);
  let microMicroHash = null;

  const markerIndex = body.lastIndexOf(MICRO_MICRO_MARKER.slice(1));

  if (markerIndex > -1) {
    const beforeMarker = body.slice(0, markerIndex - 1);
    const afterMarker = body.slice(markerIndex + MICRO_MICRO_MARKER.length - 1);
    const hash = normalizeMicroMicroHash(afterMarker);

    if (!hash) {
      return {
        valid: false,
        selectable: false,
        isParent: false,
        isChild: false,
        isBaseChild: false,
        isMicroMicro: false,
        rawId
      };
    }

    microMicroHash = hash;
    body = beforeMarker;
  }

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

  const validParent =
    Boolean(setup && regime) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);

  const parentTrueMicroFamilyId = validParent
    ? `MICRO_SHORT_${setup}_${regime}`
    : null;

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);

  const childTrueMicroFamilyId = validChild
    ? `${parentTrueMicroFamilyId}_${confirmationProfile}`
    : null;

  const validMicroMicro = validChild && Boolean(microMicroHash);

  const microMicroFamilyId = validMicroMicro
    ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`
    : null;

  return {
    valid: validParent || validChild || validMicroMicro,
    selectable: validMicroMicro,
    selectableForDiscord: validMicroMicro,
    isParent: validParent && !validChild && !validMicroMicro,
    isChild: validChild && !validMicroMicro,
    isBaseChild: validChild,
    isMicroMicro: validMicroMicro,
    rawId,
    id: microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId,
    key: microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId,
    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,
    microMicroHash,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId: validMicroMicro
      ? microMicroFamilyId
      : validChild
        ? childTrueMicroFamilyId
        : validParent
          ? parentTrueMicroFamilyId
          : null,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: validMicroMicro ? MICRO_MICRO_SCHEMA : CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: validMicroMicro ? MICRO_MICRO_SCHEMA : CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: validMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionLayer: validMicroMicro ? 'MICRO_MICRO' : validChild ? 'CHILD_75' : validParent ? 'PARENT_15' : 'UNKNOWN'
  };
}

function isFixedShortParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedShortChildMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isMicroMicroFamilyId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isSelectableMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).selectable === true;
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return parseShortTaxonomyMicroId(value).valid === true;
}

function firstValidTaxonomyId(values = []) {
  for (const value of flattenValues(values)) {
    const raw = String(value || '').trim();
    if (!raw) continue;

    const parsed = parseShortTaxonomyMicroId(raw);

    if (parsed.valid) return parsed.trueMicroFamilyId;
  }

  return null;
}

function firstMicroMicroId(values = []) {
  for (const value of flattenValues(values)) {
    const raw = String(value || '').trim();
    if (!raw) continue;

    const parsed = parseShortTaxonomyMicroId(raw);

    if (parsed.isMicroMicro) return parsed.trueMicroFamilyId;
  }

  return null;
}

function firstChild75Id(values = []) {
  for (const value of flattenValues(values)) {
    const raw = String(value || '').trim();
    if (!raw) continue;

    const parsed = parseShortTaxonomyMicroId(raw);

    if (parsed.isMicroMicro && parsed.base75ChildTrueMicroFamilyId) return parsed.base75ChildTrueMicroFamilyId;
    if (parsed.isChild) return parsed.trueMicroFamilyId;
  }

  return null;
}

function getExplicitMicroMicroId(row = {}) {
  if (typeof row === 'string') return firstMicroMicroId([row]);

  return firstMicroMicroId([
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.executionMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key
  ]);
}

function getBase75ChildTrueMicroFamilyId(row = {}, fallback = null) {
  if (typeof row === 'string') return firstChild75Id([row, fallback]);

  return firstChild75Id([
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ]);
}

function getParentTrueMicroFamilyId(row = {}, fallback = null) {
  const childId = getBase75ChildTrueMicroFamilyId(row, fallback);
  const parsedChild = parseShortTaxonomyMicroId(childId);

  const directParent = firstValidTaxonomyId([
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId
  ]);

  const parsedDirect = parseShortTaxonomyMicroId(directParent);

  if (parsedDirect.isParent) return parsedDirect.trueMicroFamilyId;
  if (parsedDirect.parentTrueMicroFamilyId) return parsedDirect.parentTrueMicroFamilyId;

  return parsedChild.parentTrueMicroFamilyId || null;
}

function microMicroContextParts(row = {}) {
  return uniqueStrings([
    row.microMicroHash,
    row.microMicroContextHash,
    row.executionContextHash,
    row.executionContextId,

    row.entryTimingBucket,
    row.entryTiming,
    row.entryTimingClass,
    row.entryQualityBucket,
    row.entryQualityClass,

    row.spreadBucket,
    row.spreadClass,
    row.depthBucket,
    row.liquidityBucket,

    row.btcFit,
    row.btcFitBucket,
    row.btcContext,
    row.btcState,
    row.btcRelation,

    row.riskShape,
    row.riskShapeBucket,
    row.riskBucket,
    row.rrBucket,
    row.stopDistanceBucket,

    row.volatilityBucket,
    row.orderbookBucket,
    row.obRelation,
    row.flow,
    row.flowCoarse,
    row.regime,
    row.regimeCoarse,
    row.rsiZone,
    row.rsiCoarse,

    row.currentFit,
    row.currentFitLabel,

    row.executionFingerprintHash,
    ...(Array.isArray(row.microMicroContextParts) ? row.microMicroContextParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ])
    .map((part) => upper(part))
    .filter(Boolean)
    .filter((part) => !part.includes('FIRST_MOVE'))
    .filter((part) => !part.includes('AFTER_OPEN'));
}

function buildMicroMicroFamilyId(baseChildId = '', row = {}, { allowChildProxy = true } = {}) {
  const child = parseShortTaxonomyMicroId(baseChildId);

  if (!child.isBaseChild) return null;

  const explicit = getExplicitMicroMicroId(row);

  if (explicit) {
    const parsedExplicit = parseShortTaxonomyMicroId(explicit);

    if (
      parsedExplicit.isMicroMicro &&
      parsedExplicit.base75ChildTrueMicroFamilyId === child.base75ChildTrueMicroFamilyId
    ) {
      return parsedExplicit.trueMicroFamilyId;
    }
  }

  const explicitHash = normalizeMicroMicroHash(
    row.microMicroHash ||
      row.microMicroContextHash ||
      row.executionContextHash ||
      row.executionFingerprintHash ||
      ''
  );

  if (explicitHash) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${explicitHash}`;
  }

  const parts = microMicroContextParts(row);

  if (parts.length > 0) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(parts.join('|'))}`;
  }

  if (allowChildProxy) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(`${child.base75ChildTrueMicroFamilyId}|DEFAULT_ENTRY_CONTEXT_PENDING`)}`;
  }

  return null;
}

function getMicroMicroFamilyId(row = {}, fallback = null, options = {}) {
  const explicit = getExplicitMicroMicroId(row);

  if (explicit) return explicit;

  const childId = getBase75ChildTrueMicroFamilyId(row, fallback);

  return buildMicroMicroFamilyId(childId, row, options);
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

    input.microFamilyId,
    input.trueMicroFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.base75ChildTrueMicroFamilyId,
    input.microMicroFamilyId,
    input.trueMicroMicroFamilyId,
    input.exactMicroMicroFamilyId,
    input.parentTrueMicroFamilyId,
    input.coarseMicroFamilyId,
    input.id,
    input.key,

    input.definition,
    input.microDefinition,
    input.microMicroDefinition,
    input.macroDefinition,
    input.parentDefinition,

    ...getArray(input.definitionParts),
    ...getArray(input.microDefinitionParts),
    ...getArray(input.microMicroDefinitionParts),
    ...getArray(input.executionFingerprintParts),
    ...getArray(input.microMicroContextParts)
  ]
    .map((value) => cleanSideHaystack(value))
    .filter(Boolean)
    .join(' | ');
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const direct = normalizeSideToken(input);

    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) return direct;

    const parsed = parseShortTaxonomyMicroId(input);
    if (parsed.valid) return TARGET_TRADE_SIDE;
    if (upper(input).includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

    return 'UNKNOWN';
  }

  for (const source of [
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
  ]) {
    const normalized = normalizeSideToken(source);

    if (normalized === TARGET_TRADE_SIDE || normalized === OPPOSITE_TRADE_SIDE) {
      return normalized;
    }
  }

  const idText = cleanSideHaystack(
    input.microMicroFamilyId ||
      input.trueMicroMicroFamilyId ||
      input.exactMicroMicroFamilyId ||
      input.trueMicroFamilyId ||
      input.learningMicroFamilyId ||
      input.analyzeMicroFamilyId ||
      input.childTrueMicroFamilyId ||
      input.base75ChildTrueMicroFamilyId ||
      input.microFamilyId ||
      input.parentTrueMicroFamilyId ||
      input.coarseMicroFamilyId ||
      input.id ||
      input.key
  );

  if (parseShortTaxonomyMicroId(idText).valid) return TARGET_TRADE_SIDE;
  if (idText.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  const text = collectSideText(input);
  const shortSignal = hasShortSignal(text);
  const longSignal = hasLongSignal(text);

  if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
  if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

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

function isMicroMicroAnalyzeRow(row = {}) {
  const id = row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.trueMicroMicroFamilyId || row?.exactMicroMicroFamilyId || '';

  if (!id) return false;
  if (!validLearningId(id)) return false;
  if (!isMicroMicroFamilyId(id)) return false;
  if (row.legacyScannerFamilyFallback === true) return false;
  if (inferTradeSide({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id }) === OPPOSITE_TRADE_SIDE) return false;

  return true;
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) {
    return micros.map((row, index) => [
      row?.trueMicroFamilyId ||
        row?.microMicroFamilyId ||
        row?.trueMicroMicroFamilyId ||
        row?.exactMicroMicroFamilyId ||
        row?.microFamilyId ||
        String(index),
      row
    ]);
  }

  if (!micros || typeof micros !== 'object') return [];

  return Object.entries(micros);
}

function microsCount(micros = {}) {
  return sourceEntriesFromMicros(micros).length;
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
      const costR = Math.max(0, num(outcome.costR ?? outcome.avgCostR, 0));

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

function getOutcomeCounts(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  const sourceWins = num(row.virtualWins, 0) + num(row.shadowWins, 0);
  const sourceLosses = num(row.virtualLosses, 0) + num(row.shadowLosses, 0);
  const sourceFlats = num(row.virtualFlats, 0) + num(row.shadowFlats, 0);

  const wins = sourceWins > 0 ? sourceWins : num(row.wins, 0);
  const losses = sourceLosses > 0 ? sourceLosses : num(row.losses, 0);
  const flats = sourceFlats > 0 ? sourceFlats : num(row.flats, 0);

  const virtualShadowCompleted = num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0);
  const aggregateCompleted = Math.max(num(row.completed, 0), num(row.outcomeSample, 0), 0);
  const countedTotal = wins + losses + flats;

  if (
    virtualShadowCompleted <= 0 &&
    aggregateCompleted <= 0 &&
    countedTotal <= 0 &&
    recent.completed > 0
  ) {
    return {
      wins: recent.wins,
      losses: recent.losses,
      flats: recent.flats,
      total: recent.completed
    };
  }

  const total = Math.max(
    countedTotal,
    virtualShadowCompleted,
    aggregateCompleted,
    recent.completed,
    0
  );

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, total - wins - losses)),
    total
  };
}

function getCompletedSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.observationSample, 0),
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

  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);

  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;
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

  const keys = [
    'virtualTotalCostR',
    'shadowTotalCostR',
    'totalCostR',
    'totalNetCostR',
    'avgCostR',
    'costR',
    'netCostR',
    'estimatedCostR'
  ];

  if (keys.some((key) => hasValue(row[key]) && num(row[key], 0) > 0)) return true;

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

  if (virtualShadowCost > 0) return virtualShadowCost;
  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;

  for (const key of ['totalCostR', 'totalNetCostR']) {
    if (hasValue(row[key]) && num(row[key], 0) > 0) return Math.max(0, num(row[key], 0));
  }

  for (const key of ['avgCostR', 'costR', 'netCostR', 'estimatedCostR']) {
    if (hasValue(row[key]) && num(row[key], 0) > 0) {
      return Math.max(0, num(row[key], 0)) * completed;
    }
  }

  return 0;
}

function getAvgCostR(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  const totalCostR = getTotalCostR(row);

  if (totalCostR > 0) return Math.max(0, totalCostR / completed);

  for (const key of ['avgCostR', 'costR', 'netCostR', 'estimatedCostR']) {
    if (hasValue(row[key]) && num(row[key], 0) > 0) return Math.max(0, num(row[key], 0));
  }

  return 0;
}

function getDirectSLCount(row = {}) {
  const sourceCount = num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0);

  if (sourceCount > 0) return sourceCount;
  if (hasValue(row.directSLCount)) return num(row.directSLCount, 0);

  return aggregateRecentOutcomes(row).directSLCount;
}

function getDirectSLPct(row = {}) {
  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.directSLPct) && !hasVirtualShadowOutcomeFields(row)) {
    return clamp(row.directSLPct, 0, 1);
  }

  return clamp(getDirectSLCount(row) / completed, 0, 1);
}

function getProfitFactor(row = {}) {
  if (hasValue(row.shortNetProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.shortNetProfitFactor, 0);
  if (hasValue(row.netShortProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.netShortProfitFactor, 0);
  if (hasValue(row.netProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.profitFactor, 0);

  const recent = aggregateRecentOutcomes(row);
  let winR = recent.grossWinR;
  let lossR = recent.grossLossR;

  if (winR <= 0) {
    winR = Math.max(
      num(row.virtualWinR, 0) + num(row.shadowWinR, 0),
      num(row.netWinR, 0),
      num(row.totalWinR, 0),
      num(row.grossWinR, 0),
      0
    );
  }

  if (lossR <= 0) {
    lossR = Math.max(
      Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)),
      Math.abs(num(row.netLossR, 0)),
      Math.abs(num(row.totalLossR, 0)),
      Math.abs(num(row.grossLossR, 0)),
      0
    );
  }

  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 99 : 0;

  return winR / lossR;
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

function getDashboardBalancedScore(row = {}, meta = null) {
  const winrate = meta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample <= 0 && winrate.observationSample > 0) {
    return Math.min(45, Math.log1p(winrate.observationSample) * 8 + winrate.reliability * 18);
  }

  const totalR = Math.max(0, getTotalR(row));
  const avgR = Math.max(0, getAvgR(row));
  const profitFactor = Math.min(Math.max(0, getProfitFactor(row)), 20);
  const directSLPct = getDirectSLPct(row);
  const avgCostR = Math.max(0, getAvgCostR(row));

  return (
    winrate.score * 100 +
    winrate.reliability * 20 +
    Math.log1p(totalR) * 12 +
    Math.log1p(avgR) * 8 +
    Math.log1p(profitFactor) * 3 -
    directSLPct * 60 -
    avgCostR * 3
  );
}

function learningStatusFor(row = {}, meta = null) {
  const winrate = meta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO_ACTIVE';
  if (winrate.outcomeSample > 0) return 'MICRO_MICRO_EARLY';

  return 'MICRO_MICRO_OBSERVING';
}

function tierFor(row = {}, meta = null) {
  const winrate = meta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO';
  if (winrate.outcomeSample > 0) return 'MICRO_MICRO_SOFT';
  if (winrate.observationSample > 0) return 'OBSERVATION';

  return 'RAW';
}

function normalizeMarketRegime(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';
  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS') || raw.includes('NEUTRAL')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE') || raw.includes('MOMENTUM') || raw.includes('BREAKOUT')) return 'TREND';

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
    raw.includes('BULL')
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
    raw.includes('BEAR')
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
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
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
      data.breadth?.bullPct,
    null
  );

  const bearishPct = pct01To100(
    data.bearishPct ??
      data.bearPct ??
      data.shortPct ??
      data.bearishBreadth ??
      data.breadth?.bearishPct ??
      data.breadth?.bearPct,
    null
  );

  const squeezePct = pct01To100(
    data.squeezePct ??
      data.compressionPct ??
      data.squeezeBreadth ??
      data.breadth?.squeezePct ??
      data.breadth?.compressionPct,
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
    generatedAt: data.generatedAt || data.updatedAt || data.createdAt || payload.generatedAt || null,
    stale: Boolean(data.stale || data.cacheStale || payload.stale || payload.cacheStale),
    cacheStale: Boolean(data.cacheStale || payload.cacheStale),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    shortOnly: true,
    longDisabled: true,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    longRootTouched: false
  };
}

async function getCurrentMarketWeatherSafe() {
  if (cache.marketWeather && now() - cache.marketWeather.ts <= MARKET_WEATHER_TTL_MS) {
    return {
      ...cache.marketWeather.value,
      cacheHit: true
    };
  }

  for (const key of uniqueStrings([...marketWeatherKeyCandidates(), ...rawMarketWeatherKeyCandidates()])) {
    for (const client of redisClientsVolatileFirst()) {
      const safeKey = key.startsWith(SHORT_KEY_PREFIX) ? key : key;

      try {
        const payload = await softReadJson(client.redis, safeKey, null, MARKET_WEATHER_REDIS_TIMEOUT_MS);
        if (!payload) continue;

        const normalized = normalizeMarketWeather(payload, safeKey, client.name);

        if (normalized.available) {
          cache.marketWeather = {
            ts: now(),
            value: normalized
          };

          return normalized;
        }
      } catch {
        // next
      }
    }
  }

  const empty = normalizeMarketWeather(null, null, null);

  cache.marketWeather = {
    ts: now(),
    value: empty
  };

  return empty;
}

function currentFitForMicro(row = {}, marketWeather = null) {
  const id = row.trueMicroFamilyId || row.microMicroFamilyId || '';
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

  if (!parsed?.isMicroMicro || !marketWeather?.available) return unavailable;

  const marketRegime = normalizeMarketRegime(marketWeather.currentRegime);
  const marketTrendSide = normalizeMarketTrendSide(marketWeather.currentTrendSide);

  const bullishPct = pct01To100(marketWeather.bullishPct, null);
  const bearishPct = pct01To100(marketWeather.bearishPct, null);
  const squeezePct = pct01To100(marketWeather.squeezePct, null);

  const reasons = [];
  let score = 0;

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

  if (bullishPct !== null && bearishPct !== null) {
    if (bearishPct > bullishPct + 10) {
      score += 10;
      reasons.push('BEARISH_BREADTH_ABOVE_BULLISH');
    } else if (bullishPct > bearishPct + 10) {
      score -= 20;
      reasons.push('BULLISH_BREADTH_ABOVE_BEARISH');
    }
  }

  if (parsed.confirmationProfile === 'A_STRONG_ALIGN') score += marketTrendSide === 'bear' ? 12 : 6;
  if (parsed.confirmationProfile === 'B_FLOW_ALIGN') score += marketTrendSide === 'bear' ? 9 : 4;
  if (parsed.confirmationProfile === 'C_VOLUME_ALIGN') score += 5;
  if (parsed.confirmationProfile === 'D_MIXED_OK') score += marketTrendSide === 'neutral' || marketRegime === 'CHOP' ? 6 : 0;
  if (parsed.confirmationProfile === 'E_WEAK_CONTRA') score -= 8;

  score += 4;
  reasons.push('MICRO_MICRO_EXECUTION_CONTEXT_LAYER');

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

    currentMarketRegime: marketRegime,
    currentMarketTrendSide: marketTrendSide,
    currentBullishPct: bullishPct === null ? null : round(bullishPct, 2),
    currentBearishPct: bearishPct === null ? null : round(bearishPct, 2),
    currentSqueezePct: squeezePct === null ? null : round(squeezePct, 2),
    currentMarketWeatherAvailable: true,
    currentMarketWeatherSourceKey: marketWeather.sourceKey || null,
    currentMarketWeatherRedisSource: marketWeather.redisSource || null,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
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
    executionFingerprintRole: 'METADATA_TO_MICRO_MICRO_CONTEXT_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    microMicroHash: row.microMicroHash || null,
    microMicroContextHash: row.microMicroContextHash || null,
    microMicroContextParts: Array.isArray(row.microMicroContextParts)
      ? row.microMicroContextParts
      : microMicroContextParts(row)
  };
}

function buildRawMicroMicroRow(row = {}, id = null, index = 0) {
  const microMicroFamilyId = id || getMicroMicroFamilyId(row, null, { allowChildProxy: true });

  if (!microMicroFamilyId) return null;

  const parsed = parseShortTaxonomyMicroId(microMicroFamilyId);

  if (!parsed.isMicroMicro) return null;

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const childTrueMicroFamilyId = parsed.childTrueMicroFamilyId;
  const base75ChildTrueMicroFamilyId = parsed.base75ChildTrueMicroFamilyId;
  const inferredTradeSide = inferTradeSide({
    ...row,
    trueMicroFamilyId: microMicroFamilyId,
    microMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId,
    parentTrueMicroFamilyId
  });

  if (inferredTradeSide === OPPOSITE_TRADE_SIDE) return null;

  const completed = getCompletedSample(row);
  const totalR = getTotalR(row);
  const totalCostR = getTotalCostR(row);
  const counts = getOutcomeCounts(row);
  const directSLCount = getDirectSLCount(row);
  const riskGeometry = getShortRiskGeometry(row);
  const contextParts = microMicroContextParts(row);
  const generatedFromChildProxy =
    row.generatedMicroMicroFromChild75 === true ||
    row.microMicroContextFallback === true ||
    contextParts.length === 0;

  return {
    sourceIndex: index,

    id: microMicroFamilyId,
    key: microMicroFamilyId,

    microFamilyId: microMicroFamilyId,
    trueMicroFamilyId: microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    analyzeMicroFamilyId: microMicroFamilyId,
    learningMicroFamilyId: microMicroFamilyId,
    microMicroFamilyId,

    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId,

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
    microMicroHash: parsed.microMicroHash,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,

    selectionLayer: 'MICRO_MICRO',
    selectableLayer: 'MICRO_MICRO',
    isMicroMicro: true,
    isBase75Child: false,
    is75ChildOrMicroMicro: true,

    generatedMicroMicroRow: true,
    generatedMicroMicroFromChild75: Boolean(generatedFromChildProxy),
    microMicroContextFallback: Boolean(generatedFromChildProxy),
    microMicroStatsSource: generatedFromChildProxy
      ? 'CHILD75_CONTEXT_PROXY_UNTIL_BACKEND_WRITES_EXACT_MM'
      : 'EXPLICIT_OR_CONTEXT_DERIVED_MICRO_MICRO',

    ...scannerMetadata({
      ...row,
      microMicroFamilyId,
      microMicroHash: parsed.microMicroHash,
      microMicroContextParts: contextParts
    }),
    ...modePayload(),

    fixedTaxonomyLearningId: true,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectableTrueMicroFamily: true,
    selectableMicroMicro: true,
    selectable75Child: false,
    parentTrueMicroFamily: false,

    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    inferredTradeSide,
    inferredFromShortOnlyMode: inferredTradeSide === 'UNKNOWN',

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen ?? row.observations, 0),
    observations: num(row.observations ?? row.seen, 0),
    observationSample: getObservationSample(row),
    observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),

    completed: round(completed, 4),
    outcomeSample: round(completed, 4),

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

    totalCostR: round(totalCostR, 4),
    avgCostR: round(getAvgCostR(row), 4),
    avgCostRFixSource: hasCostEvidence(row) ? 'costR_or_avgCostR_fallback/closedCompleted' : 'none',
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
    definitionParts: getDefinitionParts(row),

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts: getMacroDefinitionParts(row),

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : getDefinitionParts(row),

    microMicroDefinition: row.microMicroDefinition || null,
    microMicroDefinitionParts: contextParts,

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

    generatedEmptyTaxonomyRow: false,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function decorateMicroMicroRow(row = {}, marketWeather = null) {
  const id = row.trueMicroFamilyId || row.microMicroFamilyId;

  if (!id || !isMicroMicroFamilyId(id)) return null;

  const winrate = getSampleAdjustedWinrate(row);
  const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);
  const learningStatus = learningStatusFor(row, winrate);
  const tier = tierFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_MICRO_MICRO_ACTIVE;
  const fit = currentFitForMicro(row, marketWeather);

  const adaptiveScore =
    dashboardBalancedScore +
    fit.currentFitScore * 0.15 +
    winrate.reliability * 10 -
    getDirectSLPct(row) * 10 -
    getAvgCostR(row) * 2;

  return {
    ...row,

    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,

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
      ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`
      : null,

    tier,
    selectedTier: row.selectedTier || row.rotationEligibilityTier || tier,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tier,

    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    avgCostRFixSource: hasCostEvidence(row)
      ? 'costR_or_avgCostR_fallback/closedCompleted'
      : 'none',
    directSLFixSource: getDirectSLCount(row) > 0
      ? 'directSLCount/closedCompleted'
      : 'none'
  };
}

function normalizeMicroMicroRow(
  row = {},
  index = 0,
  {
    activeSet = new Set(),
    activeParentSet = new Set(),
    compact = true
  } = {}
) {
  if (!isMicroMicroAnalyzeRow(row)) return null;

  const id = row.trueMicroFamilyId || row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId;
  const parsed = parseShortTaxonomyMicroId(id);
  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const riskGeometry = getShortRiskGeometry(row);
  const winrate = getSampleAdjustedWinrate(row);
  const tier = tierFor(row, winrate);
  const learningStatus = learningStatusFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_MICRO_MICRO_ACTIVE;
  const currentFitScore = num(row.currentFitScore ?? row.fitScore, 0);

  const base = {
    rank: index + 1,

    id,
    key: id,

    microFamilyId: id,
    trueMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,

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
    microMicroHash: parsed.microMicroHash || null,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,

    selectionLayer: 'MICRO_MICRO',
    selectableLayer: 'MICRO_MICRO',
    isMicroMicro: true,
    isBase75Child: false,

    ...scannerMetadata(row),
    ...modePayload(),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: true,
    selectableMicroMicro: true,
    selectable75Child: false,
    parentTrueMicroFamily: false,

    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    inferredTradeSide: row.inferredTradeSide || inferTradeSide(row),
    inferredFromShortOnlyMode: Boolean(row.inferredFromShortOnlyMode),

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    active: Boolean(row.active) || activeSet.has(id),
    macroActive: Boolean(row.macroActive) || activeParentSet.has(parentTrueMicroFamilyId),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),
    observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),

    completed: round(winrate.outcomeSample, 4),
    outcomeSample: round(winrate.outcomeSample, 4),
    observationSample: round(winrate.observationSample, 4),

    virtualCompleted: num(row.virtualCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),
    realCompleted: 0,

    awaitingOutcomes: Boolean(winrate.awaitingOutcomes),
    learningStatus,
    status: learningStatus,

    tooEarly,
    tooEarlyReason: tooEarly
      ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`
      : null,

    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

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
    avgCostRFixSource: hasCostEvidence(row) ? 'costR_or_avgCostR_fallback/closedCompleted' : 'none',

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
    currentFitScore: round(currentFitScore, 4),
    fitScore: round(currentFitScore, 4),
    shortCurrentFit: round(row.shortCurrentFit ?? currentFitScore, 4),
    bearCurrentFit: round(row.bearCurrentFit ?? currentFitScore, 4),
    bearishCurrentFit: round(row.bearishCurrentFit ?? currentFitScore, 4),
    longCurrentFit: round(row.longCurrentFit ?? -currentFitScore, 4),
    bullCurrentFit: round(row.bullCurrentFit ?? -currentFitScore, 4),
    bullishCurrentFit: round(row.bullishCurrentFit ?? -currentFitScore, 4),
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

    microMicroDefinition: row.microMicroDefinition || null,
    microMicroDefinitionParts: Array.isArray(row.microMicroDefinitionParts)
      ? row.microMicroDefinitionParts
      : microMicroContextParts(row),

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

    generatedEmptyTaxonomyRow: false,
    generatedMicroMicroRow: Boolean(row.generatedMicroMicroRow),
    generatedMicroMicroFromChild75: Boolean(row.generatedMicroMicroFromChild75),
    microMicroContextFallback: Boolean(row.microMicroContextFallback),
    microMicroStatsSource: row.microMicroStatsSource || 'EXPLICIT_OR_DERIVED_MICRO_MICRO',

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
      ? row.recentOutcomes.filter(isShortRow).slice(-12)
      : []
  };
}

function sourceRowsFromMicros(micros = {}) {
  return sourceEntriesFromMicros(micros)
    .map(([key, row], index) => {
      if (!row || typeof row !== 'object') return null;

      const explicitMicroMicro = getExplicitMicroMicroId({ ...row, key });
      const childId = getBase75ChildTrueMicroFamilyId({ ...row, key }, key);
      const parentId = getParentTrueMicroFamilyId({ ...row, key }, key);

      if (!explicitMicroMicro && !childId) return null;

      if (inferTradeSide({ ...row, key, trueMicroFamilyId: explicitMicroMicro || childId }) === OPPOSITE_TRADE_SIDE) {
        return null;
      }

      return {
        ...row,
        key,
        sourceIndex: index,
        sourceWeekKey: PERSISTENT_LEARNING_KEY,
        sourceWeekPrimary: true,
        childTrueMicroFamilyId: childId || parseShortTaxonomyMicroId(explicitMicroMicro).childTrueMicroFamilyId,
        base75ChildTrueMicroFamilyId: childId || parseShortTaxonomyMicroId(explicitMicroMicro).base75ChildTrueMicroFamilyId,
        parentTrueMicroFamilyId: parentId || parseShortTaxonomyMicroId(explicitMicroMicro || childId).parentTrueMicroFamilyId
      };
    })
    .filter(Boolean);
}

function deriveMicroMicroRowsFromSourceRows(sourceRows = [], marketWeather = null) {
  const groups = new Map();
  let explicitRows = 0;
  let outcomeDerivedRows = 0;
  let childProxyRows = 0;

  function upsertGroup(id, row, extra = {}) {
    const parsed = parseShortTaxonomyMicroId(id);

    if (!parsed.isMicroMicro) return;

    const existing = groups.get(id);

    if (!existing) {
      groups.set(id, {
        ...(row || {}),
        recentOutcomes: Array.isArray(row.recentOutcomes) ? [...row.recentOutcomes] : [],
        id,
        key: id,
        microFamilyId: id,
        trueMicroFamilyId: id,
        trueMicroMicroFamilyId: id,
        exactMicroMicroFamilyId: id,
        analyzeMicroFamilyId: id,
        learningMicroFamilyId: id,
        microMicroFamilyId: id,
        childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,
        parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        familyId: parsed.parentTrueMicroFamilyId,
        macroFamilyId: parsed.parentTrueMicroFamilyId,
        microMicroHash: parsed.microMicroHash,
        selectionLayer: 'MICRO_MICRO',
        isMicroMicro: true,
        isBase75Child: false,
        generatedMicroMicroRow: true,
        ...extra
      });
      return;
    }

    const mergedRecent = [
      ...(Array.isArray(existing.recentOutcomes) ? existing.recentOutcomes : []),
      ...(Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [])
    ];

    groups.set(id, {
      ...existing,
      ...row,
      ...extra,
      recentOutcomes: mergedRecent,
      id,
      key: id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      trueMicroMicroFamilyId: id,
      exactMicroMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningMicroFamilyId: id,
      microMicroFamilyId: id,
      active: Boolean(existing.active || row.active),
      macroActive: Boolean(existing.macroActive || row.macroActive)
    });
  }

  for (const row of sourceRows.filter(Boolean)) {
    const explicitId = getExplicitMicroMicroId(row);

    if (explicitId) {
      explicitRows += 1;
      upsertGroup(explicitId, row, {
        generatedMicroMicroFromChild75: false,
        microMicroContextFallback: false,
        microMicroStatsSource: 'EXPLICIT_MICRO_MICRO_ROW'
      });
      continue;
    }

    const baseChildId = getBase75ChildTrueMicroFamilyId(row);
    const parsedChild = parseShortTaxonomyMicroId(baseChildId);

    if (!parsedChild.isBaseChild) continue;

    const outcomes = Array.isArray(row.recentOutcomes)
      ? row.recentOutcomes.filter((outcome) => (
        outcome &&
        typeof outcome === 'object' &&
        isLearningOutcomeSource(outcome.source || outcome.outcomeSource || 'VIRTUAL') &&
        isShortRow({ ...row, ...outcome })
      ))
      : [];

    if (outcomes.length > 0) {
      for (const outcome of outcomes) {
        const id = getMicroMicroFamilyId(
          {
            ...row,
            ...outcome
          },
          baseChildId,
          { allowChildProxy: true }
        );

        if (!id || !isMicroMicroFamilyId(id)) continue;

        outcomeDerivedRows += 1;

        upsertGroup(id, {
          ...row,
          recentOutcomes: [{
            ...outcome,
            id,
            key: id,
            trueMicroFamilyId: id,
            trueMicroMicroFamilyId: id,
            exactMicroMicroFamilyId: id,
            microFamilyId: id,
            microMicroFamilyId: id,
            childTrueMicroFamilyId: parsedChild.childTrueMicroFamilyId,
            base75ChildTrueMicroFamilyId: parsedChild.base75ChildTrueMicroFamilyId,
            parentTrueMicroFamilyId: parsedChild.parentTrueMicroFamilyId
          }]
        }, {
          generatedMicroMicroFromChild75: false,
          microMicroContextFallback: microMicroContextParts({ ...row, ...outcome }).length === 0,
          microMicroStatsSource: 'RECENT_OUTCOME_CONTEXT_DERIVED'
        });
      }

      continue;
    }

    const proxyId = buildMicroMicroFamilyId(baseChildId, row, { allowChildProxy: true });

    if (!proxyId || !isMicroMicroFamilyId(proxyId)) continue;

    childProxyRows += 1;

    upsertGroup(proxyId, row, {
      generatedMicroMicroFromChild75: true,
      microMicroContextFallback: microMicroContextParts(row).length === 0,
      microMicroStatsSource: microMicroContextParts(row).length === 0
        ? 'CHILD75_DEFAULT_CONTEXT_PROXY'
        : 'CHILD75_CONTEXT_FIELDS_DERIVED'
    });
  }

  const rows = [...groups.values()]
    .map((row, index) => {
      const raw = buildRawMicroMicroRow(row, row.trueMicroFamilyId || row.microMicroFamilyId, index);
      return raw ? decorateMicroMicroRow(raw, marketWeather) : null;
    })
    .filter(Boolean)
    .filter(isMicroMicroAnalyzeRow);

  return {
    rows,
    explicitRows,
    outcomeDerivedRows,
    childProxyRows
  };
}

function rowKey(row = {}) {
  return String(
    row.id ||
      row.key ||
      row.trueMicroFamilyId ||
      row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.microFamilyId ||
      ''
  ).trim();
}

function mergeRows(primaryRows = [], fallbackRows = []) {
  const byKey = new Map();

  for (const row of fallbackRows) {
    const key = rowKey(row);
    if (!key || !isMicroMicroAnalyzeRow(row)) continue;

    byKey.set(key, row);
  }

  for (const row of primaryRows) {
    const key = rowKey(row);
    if (!key || !isMicroMicroAnalyzeRow(row)) continue;

    const existing = byKey.get(key);

    byKey.set(key, existing
      ? {
        ...existing,
        ...row,
        id: key,
        key,
        active: Boolean(existing.active || row.active),
        macroActive: Boolean(existing.macroActive || row.macroActive),
        selectedTier: row.selectedTier || existing.selectedTier,
        rotationEligibilityTier: row.rotationEligibilityTier || existing.rotationEligibilityTier,
        tier: row.tier || existing.tier,
        generatedMicroMicroRow: Boolean(existing.generatedMicroMicroRow || row.generatedMicroMicroRow),
        generatedMicroMicroFromChild75: Boolean(existing.generatedMicroMicroFromChild75 || row.generatedMicroMicroFromChild75),
        microMicroContextFallback: Boolean(existing.microMicroContextFallback || row.microMicroContextFallback),
        recentOutcomes: [
          ...(Array.isArray(existing.recentOutcomes) ? existing.recentOutcomes : []),
          ...(Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [])
        ]
      }
      : {
        ...row,
        id: key,
        key
      }
    );
  }

  return [...byKey.values()].filter(isMicroMicroAnalyzeRow);
}

function normalizeRows(rows = [], activeSet, activeParentSet, compact) {
  return rows
    .filter(isMicroMicroAnalyzeRow)
    .map((row, index) => normalizeMicroMicroRow(row, index, {
      activeSet,
      activeParentSet,
      compact
    }))
    .filter(Boolean);
}

function limitActiveMicroMicroIds(ids = []) {
  return uniqueStrings(ids)
    .map((id) => {
      const parsed = parseShortTaxonomyMicroId(id);
      return parsed.isMicroMicro ? parsed.trueMicroFamilyId : null;
    })
    .filter(Boolean)
    .filter((id) => (
      inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
      validLearningId(id) &&
      isSelectableMicroMicroId(id)
    ))
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractActiveMicroMicroIds(activeRotation) {
  if (!activeRotation) return [];

  return limitActiveMicroMicroIds([
    activeRotation.microMicroFamilyIds || [],
    activeRotation.activeMicroMicroFamilyIds || [],
    activeRotation.selectedMicroMicroFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => row?.microMicroFamilyId || row?.trueMicroMicroFamilyId || row?.exactMicroMicroFamilyId || row?.trueMicroFamilyId)
      : []
  ]);
}

function extractLegacyActiveChild75Ids(activeRotation) {
  if (!activeRotation) return [];

  return uniqueStrings([
    activeRotation.childTrueMicroFamilyIds || [],
    activeRotation.active75ChildFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => row?.childTrueMicroFamilyId || row?.trueMicroFamilyId)
      : []
  ]).filter(isFixedShortChildMicroId);
}

function extractActiveParentIds(activeRotation) {
  if (!activeRotation) return [];

  return uniqueStrings([
    activeRotation.macroFamilyIds || [],
    activeRotation.activeMacroFamilyIds || [],
    activeRotation.parentTrueMicroFamilyIds || [],
    activeRotation.macroIds || [],
    Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => row?.parentTrueMicroFamilyId || row?.macroFamilyId)
      : []
  ]).filter((id) => (
    inferTradeSide(id) !== OPPOSITE_TRADE_SIDE &&
    validLearningId(id) &&
    isFixedShortParentMicroId(id)
  ));
}

function manualMicroMicroRowFromId(id, index = 0, marketWeather = null) {
  if (!id || inferTradeSide(id) === OPPOSITE_TRADE_SIDE) return null;
  if (!isSelectableMicroMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  const raw = buildRawMicroMicroRow({
    id: parsed.trueMicroFamilyId,
    key: parsed.trueMicroFamilyId,
    microFamilyId: parsed.trueMicroFamilyId,
    trueMicroFamilyId: parsed.trueMicroFamilyId,
    trueMicroMicroFamilyId: parsed.trueMicroFamilyId,
    exactMicroMicroFamilyId: parsed.trueMicroFamilyId,
    analyzeMicroFamilyId: parsed.trueMicroFamilyId,
    learningMicroFamilyId: parsed.trueMicroFamilyId,
    microMicroFamilyId: parsed.trueMicroFamilyId,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,

    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroHash: parsed.microMicroHash,

    selectionLayer: 'MICRO_MICRO',
    isMicroMicro: true,
    isBase75Child: false,

    ...modePayload(),

    active: true,
    macroActive: false,

    seen: 0,
    observations: 0,
    completed: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,
    winrate: 0,
    totalR: 0,
    avgR: 0,
    profitFactor: 0,
    directSLPct: 0,
    directSLCount: 0,
    totalCostR: 0,
    avgCostR: 0,
    selectedTier: 'RAW',
    rotationEligibilityTier: 'RAW',

    generatedMicroMicroRow: true,
    generatedMicroMicroFromChild75: false,
    microMicroContextFallback: false,
    microMicroStatsSource: 'MANUAL_ACTIVE_MICRO_MICRO_ID'
  }, id, index);

  return raw ? decorateMicroMicroRow(raw, marketWeather) : null;
}

function buildRowsFromActiveRotation(activeRotation, marketWeather = null) {
  if (!activeRotation) return [];

  const rows = [];

  if (Array.isArray(activeRotation.microFamilies)) {
    for (const [index, row] of activeRotation.microFamilies.entries()) {
      const id = getExplicitMicroMicroId(row);

      if (!id || !isSelectableMicroMicroId(id)) continue;

      const raw = buildRawMicroMicroRow({
        ...row,
        id,
        key: id,
        active: true,
        selectedTier: row.selectedTier || row.rotationEligibilityTier || activeRotation.selectedTier || 'RAW'
      }, id, index);

      if (!raw) continue;

      const decorated = decorateMicroMicroRow(raw, marketWeather);
      if (decorated) rows.push(decorated);
    }
  }

  const existing = new Set(rows.map(rowKey).filter(Boolean));

  for (const id of extractActiveMicroMicroIds(activeRotation)) {
    if (existing.has(id)) continue;

    const manual = manualMicroMicroRowFromId(id, rows.length, marketWeather);
    if (!manual) continue;

    rows.push(manual);
    existing.add(id);
  }

  return mergeRows([], rows);
}

function compactBestRow(row) {
  if (!row || !isMicroMicroAnalyzeRow(row)) return null;

  const id = row.trueMicroFamilyId || row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId;
  const parsed = parseShortTaxonomyMicroId(id);
  const riskGeometry = getShortRiskGeometry(row);

  return {
    id,
    key: id,

    microFamilyId: id,
    trueMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,

    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroHash: parsed.microMicroHash || null,

    selectionLayer: 'MICRO_MICRO',
    isMicroMicro: true,
    isBase75Child: false,

    ...modePayload(),

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

    tooEarly: Boolean(row.tooEarly),
    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

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
    currentMarketWeatherRedisSource: row.currentMarketWeatherRedisSource || null,

    generatedMicroMicroFromChild75: Boolean(row.generatedMicroMicroFromChild75),
    microMicroContextFallback: Boolean(row.microMicroContextFallback),
    microMicroStatsSource: row.microMicroStatsSource || null
  };
}

function compactActiveRotation(activeRotation) {
  if (!activeRotation) return null;

  const activeMicroMicroFamilyIds = extractActiveMicroMicroIds(activeRotation);
  const activeParentIds = extractActiveParentIds(activeRotation);
  const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotation);

  return {
    rotationId: activeRotation.rotationId || null,
    source: activeRotation.source || null,
    mode: activeRotation.mode || null,
    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    generatedAt: activeRotation.generatedAt || null,
    activatedAt: activeRotation.activatedAt || null,

    ...modePayload(),

    manualOnly: true,
    adminSelected: Boolean(activeRotation.adminSelected || activeRotation.manualOnly),
    liveSelectable: activeMicroMicroFamilyIds.length > 0,

    selectedTier: activeRotation.selectedTier || null,

    microFamilyIds: activeMicroMicroFamilyIds,
    activeMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroFamilyIds: activeMicroMicroFamilyIds,
    microMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    exactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    activeMicroMicroFamilyIds,

    legacyChild75ActiveIdsIgnored,

    macroFamilyIds: activeParentIds,
    activeMacroFamilyIds: activeParentIds,

    bestShort: activeRotation.bestShort
      ? compactBestRow(activeRotation.bestShort)
      : null,
    bestLong: null
  };
}

function parseFilters(req) {
  const side = normalizeRequestedTradeSide(firstQueryValue(req.query?.side, TARGET_TRADE_SIDE));
  const familyId = String(firstQueryValue(req.query?.familyId, '') || '').trim();
  const microMicroFamilyId = String(firstQueryValue(req.query?.microMicroFamilyId, '') || '').trim();
  const macroFamilyId = String(firstQueryValue(req.query?.macroFamilyId, '') || '').trim();
  const parentTrueMicroFamilyId = String(firstQueryValue(req.query?.parentTrueMicroFamilyId, '') || '').trim();
  const childTrueMicroFamilyId = String(firstQueryValue(req.query?.childTrueMicroFamilyId, '') || '').trim();
  const setup = upper(firstQueryValue(req.query?.setup, ''));
  const regime = upper(firstQueryValue(req.query?.regime, ''));
  const confirmationProfile = upper(firstQueryValue(req.query?.confirmationProfile, ''));
  const q = String(firstQueryValue(req.query?.q, '') || '').trim().toUpperCase();

  return {
    side,
    familyId,
    microMicroFamilyId,
    macroFamilyId,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    setup,
    regime,
    confirmationProfile,
    q,

    activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false)),
    macroActiveOnly: isTrue(firstQueryValue(req.query?.macroActiveOnly, false)),

    minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
    minSample: num(firstQueryValue(req.query?.minSample, 0), 0),
    minSeen: num(firstQueryValue(req.query?.minSeen, 0), 0),

    tier: String(firstQueryValue(req.query?.tier, '') || '').trim().toUpperCase(),
    status: String(firstQueryValue(req.query?.status, '') || '').trim().toUpperCase(),
    currentFit: String(firstQueryValue(req.query?.currentFit, '') || '').trim().toUpperCase()
  };
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.id,
    row.key,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.familyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    row.macroDefinition,
    row.parentDefinition,
    row.taxonomySetup,
    row.taxonomyRegime,
    row.confirmationProfile,
    row.microMicroHash,
    row.selectionLayer,
    row.setupType,
    row.regimeBucket,
    row.currentFit,
    row.currentMarketRegime,
    row.currentMarketTrendSide,
    row.microMicroStatsSource,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.microMicroDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts),
    ...getArray(row.microMicroContextParts)
  ]
    .map((value) => upper(value))
    .join(' | ');

  return haystack.includes(q);
}

function rowPassesFilters(row = {}, filters, activeSet, activeParentSet) {
  if (!isMicroMicroAnalyzeRow(row)) return false;

  const exactId = row.trueMicroFamilyId || row.microMicroFamilyId;
  const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || row.macroFamilyId;
  const childId = row.childTrueMicroFamilyId || row.base75ChildTrueMicroFamilyId;
  const parsed = parseShortTaxonomyMicroId(exactId);

  if (filters.side === 'LONG_DISABLED') return false;
  if (filters.side && filters.side !== TARGET_TRADE_SIDE) return false;

  if (filters.familyId && exactId !== filters.familyId) return false;
  if (filters.microMicroFamilyId && exactId !== filters.microMicroFamilyId) return false;
  if (filters.macroFamilyId && String(parentId || '') !== filters.macroFamilyId) return false;
  if (filters.parentTrueMicroFamilyId && String(parentId || '') !== filters.parentTrueMicroFamilyId) return false;
  if (filters.childTrueMicroFamilyId && String(childId || '') !== filters.childTrueMicroFamilyId) return false;

  if (filters.setup && parsed.setup !== filters.setup) return false;
  if (filters.regime && parsed.regime !== filters.regime) return false;
  if (filters.confirmationProfile && parsed.confirmationProfile !== filters.confirmationProfile) return false;

  if (filters.activeOnly && !activeSet.has(exactId)) return false;
  if (filters.macroActiveOnly && !activeParentSet.has(parentId)) return false;

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

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 4;
  if (completed > 0) return 2.5;
  if (observations > 0) return 1.2;

  return 0;
}

function getRankWinrate(row = {}) {
  return num(
    row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      row.sampleWilsonLowerBound ??
      row.wilsonLowerBound ??
      row.sampleBayesianWinrate ??
      row.bayesianWinrate ??
      row.winrate,
    0
  );
}

function getRankPnl(row = {}) {
  return getTotalR(row);
}

function getRankAvgR(row = {}) {
  return getAvgR(row);
}

function positivePnlRank(row = {}) {
  return getRankPnl(row) > 0 ? 1 : 0;
}

function compareRowsWinratePnl(a, b) {
  const aCompleted = num(a.outcomeSample ?? getCompletedSample(a), 0);
  const bCompleted = num(b.outcomeSample ?? getCompletedSample(b), 0);

  const aActive = aCompleted >= MIN_COMPLETED_MICRO_MICRO_ACTIVE ? 1 : 0;
  const bActive = bCompleted >= MIN_COMPLETED_MICRO_MICRO_ACTIVE ? 1 : 0;

  return (
    compareNumberDesc(aActive, bActive) ||
    compareNumberDesc(getRankWinrate(a), getRankWinrate(b)) ||
    compareNumberDesc(positivePnlRank(a), positivePnlRank(b)) ||
    compareNumberDesc(getRankPnl(a), getRankPnl(b)) ||
    compareNumberDesc(getRankAvgR(a), getRankAvgR(b)) ||
    compareNumberDesc(getProfitFactor(a), getProfitFactor(b)) ||
    compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareNumberDesc(aCompleted, bCompleted) ||
    compareNumberDesc(a.sampleReliability, b.sampleReliability) ||
    compareNumberDesc(a.observationSample ?? getObservationSample(a), b.observationSample ?? getObservationSample(b)) ||
    compareNumberDesc(a.seen, b.seen) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsBestData(a, b) {
  return compareRowsWinratePnl(a, b);
}

function compareRowsWinrate(a, b) {
  return compareRowsWinratePnl(a, b);
}

function compareRowsByMode(a, b, mode = DEFAULT_RANK_MODE) {
  if (mode === 'totalR') {
    return (
      compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) ||
      compareNumberDesc(getTotalR(a), getTotalR(b)) ||
      compareNumberDesc(getRankWinrate(a), getRankWinrate(b)) ||
      compareRowsWinratePnl(a, b)
    );
  }

  if (mode === 'avgR') {
    return (
      compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) ||
      compareNumberDesc(getAvgR(a), getAvgR(b)) ||
      compareNumberDesc(getRankWinrate(a), getRankWinrate(b)) ||
      compareRowsWinratePnl(a, b)
    );
  }

  if (mode === 'directSL') {
    return (
      compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) ||
      compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
      compareNumberDesc(getRankWinrate(a), getRankWinrate(b)) ||
      compareNumberDesc(getTotalR(a), getTotalR(b)) ||
      compareRowsWinratePnl(a, b)
    );
  }

  if (mode === 'observed') {
    return (
      compareNumberDesc(a.observationSample, b.observationSample) ||
      compareRowsWinratePnl(a, b)
    );
  }

  if (mode === 'cost') {
    return (
      compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
      compareRowsWinratePnl(a, b)
    );
  }

  if (mode === 'currentFit') {
    return (
      compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) ||
      compareRowsWinratePnl(a, b)
    );
  }

  return compareRowsWinratePnl(a, b);
}

function sortRowsByMode(rows = [], mode = DEFAULT_RANK_MODE) {
  return [...rows]
    .filter(isMicroMicroAnalyzeRow)
    .sort((a, b) => compareRowsByMode(a, b, mode));
}

function layerCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const parsed = parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microMicroFamilyId);

      if (parsed.isMicroMicro) acc.microMicro += 1;
      else if (parsed.isChild) acc.child75 += 1;
      else if (parsed.isParent) acc.parent15 += 1;
      else acc.unknown += 1;

      return acc;
    },
    {
      child75: 0,
      microMicro: 0,
      parent15: 0,
      unknown: 0
    }
  );
}

function tierCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const tier = upper(row.tier || row.rotationEligibilityTier || tierFor(row));

      if (tier === 'MICRO_MICRO') acc.MICRO_MICRO += 1;
      else if (tier === 'MICRO_MICRO_SOFT') acc.MICRO_MICRO_SOFT += 1;
      else if (tier === 'OBSERVATION') acc.OBSERVATION += 1;
      else acc.RAW += 1;

      return acc;
    },
    {
      MICRO_MICRO: 0,
      MICRO_MICRO_SOFT: 0,
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

function bestBy(rows = [], comparator) {
  return [...rows].filter(isMicroMicroAnalyzeRow).sort(comparator)[0] || null;
}

function buildParentSummaries(rows = []) {
  const groups = new Map();

  for (const row of rows.filter(isMicroMicroAnalyzeRow)) {
    const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || row.macroFamilyId;
    if (!parentId) continue;

    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId).push(row);
  }

  return [...groups.entries()]
    .map(([parentTrueMicroFamilyId, groupRows]) => {
      const parsed = parseShortTaxonomyMicroId(parentTrueMicroFamilyId);
      const completed = groupRows.reduce((sum, row) => sum + num(row.outcomeSample ?? getCompletedSample(row), 0), 0);
      const observationSample = groupRows.reduce((sum, row) => sum + num(row.observationSample ?? getObservationSample(row), 0), 0);
      const totalR = groupRows.reduce((sum, row) => sum + getTotalR(row), 0);
      const totalCostR = groupRows.reduce((sum, row) => sum + getTotalCostR(row), 0);
      const directSLCount = groupRows.reduce((sum, row) => sum + getDirectSLCount(row), 0);
      const fitScoreSum = groupRows.reduce((sum, row) => sum + num(row.currentFitScore ?? row.fitScore, 0), 0);

      return {
        parentTrueMicroFamilyId,
        macroFamilyId: parentTrueMicroFamilyId,
        taxonomySetup: parsed.setup,
        taxonomyRegime: parsed.regime,

        microMicroCount: groupRows.length,
        selectableMicroMicroCount: groupRows.length,
        child75Hidden: true,

        completed: round(completed, 4),
        observationSample: round(observationSample, 4),
        totalR: round(totalR, 4),
        avgR: completed > 0 ? round(totalR / completed, 4) : 0,
        totalCostR: round(totalCostR, 4),
        avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0,
        directSLCount: round(directSLCount, 4),
        directSLPct: completed > 0 ? round(directSLCount / completed, 4) : 0,

        avgCurrentFitScore: groupRows.length > 0
          ? round(fitScoreSum / groupRows.length, 4)
          : 0,

        currentFitCounts: currentFitCounts(groupRows),

        bestAdaptive: compactBestRow(bestBy(groupRows, compareRowsWinratePnl)),
        bestMicroMicro: compactBestRow(bestBy(groupRows, compareRowsWinratePnl)),
        bestCurrentFit: compactBestRow(bestBy(groupRows, (a, b) => (
          compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) ||
          compareRowsWinratePnl(a, b)
        ))),
        bestWinrate: compactBestRow(bestBy(groupRows, compareRowsWinratePnl)),
        bestPnl: compactBestRow(bestBy(groupRows, (a, b) => (
          compareNumberDesc(getTotalR(a), getTotalR(b)) ||
          compareRowsWinratePnl(a, b)
        )))
      };
    })
    .sort((a, b) => (
      compareNumberDesc(a.completed, b.completed) ||
      compareNumberDesc(a.totalR, b.totalR) ||
      compareNumberDesc(a.microMicroCount, b.microMicroCount) ||
      compareNumberDesc(a.avgCurrentFitScore, b.avgCurrentFitScore) ||
      compareIdAsc(a.parentTrueMicroFamilyId, b.parentTrueMicroFamilyId)
    ));
}

function buildSummary(rows = [], activeSet = new Set()) {
  const safeRows = rows.filter(isMicroMicroAnalyzeRow);

  const completedRows = safeRows.filter((row) => num(row.outcomeSample, 0) > 0);
  const observationRows = safeRows.filter((row) => num(row.observationSample, 0) > 0);
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
    microMicroRows: safeRows.length,
    child75Rows: 0,
    activeRows: activeRows.length,
    activeIds: activeSet.size,

    ...modePayload(),

    seen: round(totalSeen, 4),
    completed: round(totalCompleted, 4),
    observationSample: round(totalObservationSample, 4),
    observationDuplicateSkippedCount: round(totalObservationDuplicateSkippedCount, 4),
    winrateSample: round(totalWinrateSample, 4),
    seenCompletedRatio: totalCompleted > 0 ? round(totalSeen / totalCompleted, 4) : round(totalSeen, 4),

    completedMicroMicroFamilies: completedRows.length,
    observationMicroMicroFamilies: observationRows.length,
    awaitingOutcomeMicroMicroFamilies: safeRows.filter((row) => row.awaitingOutcomes).length,

    microMicroActiveFamilies: tierCounts(safeRows).MICRO_MICRO,
    microMicroSoftFamilies: tierCounts(safeRows).MICRO_MICRO_SOFT,
    observationOnlyMicroMicroFamilies: tierCounts(safeRows).OBSERVATION,
    rawMicroMicroFamilies: tierCounts(safeRows).RAW,

    tierCounts: tierCounts(safeRows),
    statusCounts: statusCounts(safeRows),
    currentFitCounts: currentFitCounts(safeRows),
    layerCounts: layerCounts(safeRows),

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: totalCompleted > 0 ? round(totalR / totalCompleted, 4) : 0,
    avgCostR: totalCompleted > 0 ? round(totalCostR / totalCompleted, 4) : 0,

    directSLCount: round(totalDirectSLCount, 4),
    directSLPct: totalCompleted > 0 ? round(totalDirectSLCount / totalCompleted, 4) : 0,

    avgCurrentFitScore: safeRows.length > 0
      ? round(totalCurrentFitScore / safeRows.length, 4)
      : 0,

    bestAdaptive: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
    bestMicroMicro: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
    bestWinratePnl: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
    bestCurrentFit: compactBestRow(bestBy(safeRows, (a, b) => (
      compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) ||
      compareRowsWinratePnl(a, b)
    ))),
    bestBalanced: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
    bestTotalR: compactBestRow(bestBy(safeRows, (a, b) => (
      compareNumberDesc(getTotalR(a), getTotalR(b)) ||
      compareRowsWinratePnl(a, b)
    ))),
    bestPnl: compactBestRow(bestBy(safeRows, (a, b) => (
      compareNumberDesc(getTotalR(a), getTotalR(b)) ||
      compareRowsWinratePnl(a, b)
    ))),
    bestAvgR: compactBestRow(bestBy(safeRows, (a, b) => (
      compareNumberDesc(getAvgR(a), getAvgR(b)) ||
      compareRowsWinratePnl(a, b)
    ))),
    bestWinrate: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
    bestObserved: compactBestRow(bestBy(safeRows, (a, b) => (
      compareNumberDesc(a.observationSample, b.observationSample) ||
      compareRowsWinratePnl(a, b)
    ))),
    lowestDirectSL: compactBestRow(bestBy(safeRows, (a, b) => (
      compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
      compareRowsWinratePnl(a, b)
    ))),

    short: {
      rows: safeRows.length,
      layerCounts: layerCounts(safeRows),
      bestAdaptive: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
      bestMicroMicro: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
      bestWinratePnl: compactBestRow(bestBy(safeRows, compareRowsWinratePnl)),
      bestPnl: compactBestRow(bestBy(safeRows, (a, b) => (
        compareNumberDesc(getTotalR(a), getTotalR(b)) ||
        compareRowsWinratePnl(a, b)
      ))),
      lowestDirectSL: compactBestRow(bestBy(safeRows, (a, b) => (
        compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
        compareRowsWinratePnl(a, b)
      )))
    },

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
        keyPrefix: SHORT_KEY_PREFIX,
        trueMicroOnly: true,
        exactTrueMicroOnly: true,
        microMicroOnly: true,
        microMicroEnabled: true,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA,
        learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
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

function selectBestMicroMicroRows({
  rows = [],
  mode = DEFAULT_RANK_MODE,
  limit = DEFAULT_BEST_LIMIT
} = {}) {
  const safeLimit = toSafeLimit(limit, DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);

  return sortRowsByMode(rows, mode)
    .slice(0, safeLimit)
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

function splitSideRows(rows = [], sideLimit = DEFAULT_SIDE_LIMIT) {
  const shortRows = rows
    .filter(isMicroMicroAnalyzeRow)
    .slice(0, sideLimit);

  return {
    shortRows,
    longRows: [],
    unknownRows: []
  };
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

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'short-only-micro-micro-only-selection-v3-winrate-pnl-first');
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
  res.setHeader('X-Max-Active-Micro-Micro-Families', String(MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES));
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Micro-Micro-Only', 'true');
  res.setHeader('X-Micro-Micro-Enabled', 'true');
  res.setHeader('X-Micro-Micro-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Version', MICRO_MICRO_VERSION);
  res.setHeader('X-Child-75-Hidden', 'true');
  res.setHeader('X-Child-75-Selectable', 'false');
  res.setHeader('X-Parent-15-Selectable', 'false');
  res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Execution-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Execution-Fingerprints-Can-Derive-Micro-Micro-Context', 'true');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_MICRO_MICRO_FAMILY_ID_FOR_SELECTION');
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-True-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Default-Sort', 'FAIR_WINRATE_THEN_NET_TOTALR');
  res.setHeader('X-Ranking-Primary', 'FAIR_WINRATE_THEN_NET_TOTALR');
  res.setHeader('X-Ranking-Pnl-Source', 'totalR');
  res.setHeader('X-Ranking-Winrate-Source', 'fairWinrate');
  res.setHeader('X-Measurement-Fix-Version', MEASUREMENT_FIX_VERSION);
  res.setHeader('X-Completed-Definition', 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES');
  res.setHeader('X-Scoring-R-Source', 'netR');
  res.setHeader('X-Wins-Losses-Flats-Source', 'netR');
  res.setHeader('X-Avg-Cost-R-Source', 'costR');
  res.setHeader('X-Seen-Definition', 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY');
  res.setHeader('X-Current-Fit-Version', CURRENT_FIT_VERSION);
  res.setHeader('X-Current-Fit-Blocks-Learning', 'false');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const requestedQueryWeekKey = String(
      firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) || PERSISTENT_LEARNING_KEY
    ).trim();

    const requestedMode = String(firstQueryValue(req.query?.mode, DEFAULT_RANK_MODE) || DEFAULT_RANK_MODE);
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

    const [activeRotation, weekResult, marketWeather] = await Promise.all([
      getActiveRotationSafe(),
      getWeekMicrosCached(PERSISTENT_LEARNING_KEY, WEEK_MICROS_TIMEOUT_MS),
      getCurrentMarketWeatherSafe()
    ]);

    const activeMicroMicroFamilyIds = extractActiveMicroMicroIds(activeRotation);
    const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotation);
    const activeParentIds = extractActiveParentIds(activeRotation);

    const activeSet = new Set(activeMicroMicroFamilyIds);
    const activeParentSet = new Set(activeParentIds);

    const sourceRows = sourceRowsFromMicros(weekResult.micros);
    const derived = deriveMicroMicroRowsFromSourceRows(sourceRows, marketWeather);
    const activeFallbackRows = buildRowsFromActiveRotation(activeRotation, marketWeather);

    let mergedRows = mergeRows(derived.rows, activeFallbackRows);

    mergedRows = mergedRows.map((row) => {
      const id = row.trueMicroFamilyId || row.microMicroFamilyId;
      const parentId = row.parentTrueMicroFamilyId || row.coarseMicroFamilyId;

      return {
        ...row,
        id,
        key: id,
        trueMicroFamilyId: id,
        trueMicroMicroFamilyId: id,
        exactMicroMicroFamilyId: id,
        microFamilyId: id,
        microMicroFamilyId: id,
        active: Boolean(row.active || activeSet.has(id)),
        macroActive: Boolean(row.macroActive || activeParentSet.has(parentId))
      };
    });

    const filteredRows = mergedRows.filter((row) => (
      rowPassesFilters(row, filters, activeSet, activeParentSet)
    ));

    const rankedRows = sortRowsByMode(filteredRows, mode)
      .map((row, index) => ({
        ...row,
        rank: index + 1
      }));

    const responseRows = rankedRows.slice(0, limit);

    const bestRawRows = selectBestMicroMicroRows({
      rows: mergedRows,
      mode,
      limit: bestLimit
    });

    const bestMicroMicroFamilies = normalizeRows(
      bestRawRows,
      activeSet,
      activeParentSet,
      compact
    );

    const normalizedRows = normalizeRows(responseRows, activeSet, activeParentSet, compact);
    const split = splitSideRows(bestRawRows, sideLimit);
    const normalizedShortRows = normalizeRows(split.shortRows, activeSet, activeParentSet, compact);

    const summary = buildSummary(rankedRows, activeSet);
    const parentSummaries = buildParentSummaries(mergedRows);

    const weekEntries = sourceEntriesFromMicros(weekResult.micros);

    const rawScannerFingerprintRowsHidden = weekEntries
      .filter(([key, row]) => {
        const id = String(
          row?.trueMicroFamilyId ||
            row?.learningMicroFamilyId ||
            row?.analyzeMicroFamilyId ||
            row?.microFamilyId ||
            key ||
            ''
        );

        return isScannerFingerprintId(id);
      })
      .length;

    const rawExecutionFingerprintRowsHidden = weekEntries
      .filter(([key, row]) => {
        const id = String(
          row?.trueMicroFamilyId ||
            row?.learningMicroFamilyId ||
            row?.analyzeMicroFamilyId ||
            row?.microFamilyId ||
            key ||
            ''
        );

        return isExecutionFingerprintId(id);
      })
      .length;

    const child75RowsHidden = sourceRows
      .filter((row) => isFixedShortChildMicroId(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId))
      .length;

    const parentRowsHidden = weekEntries
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

    const layers = layerCounts(mergedRows);
    const filteredLayers = layerCounts(rankedRows);
    const responseLayers = layerCounts(normalizedRows);
    const bestLayers = layerCounts(bestMicroMicroFamilies);
    const fitCounts = currentFitCounts(mergedRows);

    const warnings = uniqueStrings([
      requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}`
        : null,
      weekResult.warning,
      marketWeather.available !== true
        ? `MARKET_WEATHER_UNAVAILABLE:${marketWeather.reason || 'UNKNOWN'}`
        : null,
      legacyChild75ActiveIdsIgnored.length > 0
        ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED_MICRO_MICRO_ONLY:${legacyChild75ActiveIdsIgnored.length}`
        : null,
      rawScannerFingerprintRowsHidden > 0
        ? `SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawScannerFingerprintRowsHidden}`
        : null,
      rawExecutionFingerprintRowsHidden > 0
        ? `EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawExecutionFingerprintRowsHidden}`
        : null,
      child75RowsHidden > 0
        ? `CHILD75_ROWS_USED_AS_CONTEXT_ONLY_HIDDEN_FROM_ADMIN:${child75RowsHidden}`
        : null,
      parentRowsHidden > 0
        ? `PARENT15_ROWS_HIDDEN_METADATA_ONLY:${parentRowsHidden}`
        : null,
      derived.rows.length === 0
        ? 'NO_MICRO_MICRO_ROWS_AVAILABLE'
        : null,
      derived.childProxyRows > 0
        ? `MICRO_MICRO_CHILD75_PROXY_ROWS_CREATED:${derived.childProxyRows}`
        : null,
      derived.outcomeDerivedRows > 0
        ? `MICRO_MICRO_ROWS_DERIVED_FROM_RECENT_OUTCOMES:${derived.outcomeDerivedRows}`
        : null,
      derived.explicitRows > 0
        ? `EXPLICIT_MICRO_MICRO_ROWS_FOUND:${derived.explicitRows}`
        : null
    ].filter(Boolean));

    return res.status(200).json({
      ok: true,
      fixed: true,

      ...modePayload(),

      availableTiers: ['MICRO_MICRO', 'MICRO_MICRO_SOFT', 'OBSERVATION', 'RAW'],
      availableStatuses: ['MICRO_MICRO_ACTIVE', 'MICRO_MICRO_EARLY', 'MICRO_MICRO_OBSERVING'],
      availableCurrentFit: ['FIT', 'OK', 'NEUTRAL', 'MISFIT', 'UNKNOWN'],
      availableLayers: ['MICRO_MICRO'],

      manualSelectionPolicy: {
        maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        selectableMicroMicroIdsAllowed: true,
        selectable75ChildIdsAllowed: false,
        selectableChildIdsAllowed: false,
        parentIdsAreMetadataOnly: true,
        child75IdsAreContextOnly: true,
        parentMatchDoesNotTriggerDiscord: true,
        macroMatchDoesNotTriggerDiscord: true,
        child75MatchDoesNotTriggerDiscord: true,
        scannerFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsCanDeriveMicroMicroContextHash: true
      },

      measurementPolicy: {
        version: MEASUREMENT_FIX_VERSION,
        avgCostR: 'avgCostR = totalCostR / closedVirtualShadowCompleted, fallback avgCostR/costR/recentOutcomes.costR',
        totalCostR: 'virtualTotalCostR + shadowTotalCostR when > 0, fallback totalCostR, fallback avgCostR * completed, fallback costR * completed, fallback recentOutcomes.costR',
        directSL: 'directSLCount / closedVirtualShadowCompleted',
        seen: 'seen and observations come only from unique observation dedupe keys',
        completed: 'closed VIRTUAL + SHADOW outcomes only',
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        rawWinrateRankingDisabled: true,
        microMicroStatsSource: 'explicit microMicro rows, recentOutcomes context groups, or child75 context proxy rows'
      },

      currentFitPolicy: {
        version: CURRENT_FIT_VERSION,
        marketWeatherKeys: marketWeatherKeyCandidates(),
        rawFallbackKeys: rawMarketWeatherKeyCandidates(),
        marketWeatherAvailable: Boolean(marketWeather.available),
        sourceKey: marketWeather.sourceKey || null,
        redisSource: marketWeather.redisSource || null,
        currentRegime: marketWeather.currentRegime,
        currentTrendSide: marketWeather.currentTrendSide,
        bullishPct: marketWeather.bullishPct,
        bearishPct: marketWeather.bearishPct,
        squeezePct: marketWeather.squeezePct,
        confidence: marketWeather.confidence,
        reason: marketWeather.reason || null,
        softOnly: true,
        blocksLearning: false,
        blocksVirtualLearning: false,
        blocksShadowLearning: false,
        canBlockDiscordOnly: true,
        polarity: 'bearish market = positive for SHORT; bullish market = negative for SHORT',
        definition: 'SHORT_MIRRORED_CURRENT_FIT'
      },

      microMicroPolicy: {
        version: MICRO_MICRO_VERSION,
        enabled: true,
        only: true,
        schema: MICRO_MICRO_SCHEMA,
        suffix: MICRO_MICRO_SUFFIX,
        marker: MICRO_MICRO_MARKER,
        hashLength: MICRO_MICRO_HASH_LEN,
        learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        minCompletedForActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
        format: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',
        base75ChildIsContextOnly: true,
        parent15StillMetadataOnly: true,
        microMicroSelectable: true,
        microMicroActsAsExecutionPreference: true,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        explicitRowsFound: derived.explicitRows,
        derivedFromRecentOutcomes: derived.outcomeDerivedRows,
        child75ProxyRows: derived.childProxyRows,
        rowsCount: derived.rows.length,
        activeMicroMicroIds: activeMicroMicroFamilyIds
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
        MICRO_MICRO_OBSERVING: 'completed == 0 for micro-micro',
        MICRO_MICRO_EARLY: `completed > 0 && completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} for micro-micro`,
        MICRO_MICRO_ACTIVE: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} for micro-micro`
      },

      taxonomy: {
        parentCount: 15,
        child75ContextCount: 75,
        selectableChildCount: 0,
        selectableMicroMicroCount: layers.microMicro,
        setups: SETUP_ORDER,
        regimes: REGIME_ORDER,
        confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
        parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
        childFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
        microMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',
        selectableIdsAreMicroMicroOnly: true,
        child75IdsAreContextOnly: true,
        parentIdsAreMetadataOnly: true,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA
      },

      rankingPolicy: {
        defaultMode: DEFAULT_RANK_MODE,
        activeMode: mode,
        defaultSort: 'fairWinrate/positivePnl/totalR/avgR/profitFactor/directSL/avgCostR/completed',
        userIntent: 'highest winrate and pnl on top',
        bestDataFirst: true,
        completedBeforeRawScore: true,
        activeSampleFirst: true,
        rawWinrateIsNeverDefault: true,
        rawWinrateIsNeverAlone: true,
        adaptiveScoreIsNotPrimary: true,
        pnlSource: 'totalR',
        winrateSource: 'fairWinrate',
        scoreKeys: ['fairWinrate', 'totalR', 'avgR', 'profitFactor', 'directSLPct', 'avgCostR', 'completed', 'adaptiveScore'],
        scannerFingerprintsExcludedFromRows: true,
        scannerFingerprintsMetadataOnly: true,
        rawScannerFingerprintRowsHidden,
        rawExecutionFingerprintRowsHidden,
        child75RowsHidden,
        parentRowsHidden,
        executionFingerprintsMetadataOnly: true,
        executionFingerprintsCanDeriveMicroMicroContextHash: true,
        analyzeMicroMicroFamiliesOnly: true,
        exactMicroMicroOnly: true,
        selectableChildOnly: false,
        selectableMicroMicroOnly: true,
        maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA,
        parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
        child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
        microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        symbolExcludedFromFamilyId: true,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        winrateDefinition: 'netR > 0',
        avgCostRSource: 'costR'
      },

      adaptiveLayerPolicy: {
        learningRemainsBroad: true,
        child75RemainsContextLayer: true,
        child75HiddenFromAdminRows: true,
        microMicroLayerEnabled: true,
        microMicroActsAsExecutionPreference: true,
        microMicroSelectionOnly: true,
        discordWillBeStrict: true,
        maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false,
        adaptiveLayerBuilt: true,
        marketWeatherEngineBuilt: true,
        currentFitScoreBuilt: true,
        microMicroLayerBuilt: true
      },

      weekKey: PERSISTENT_LEARNING_KEY,
      requestedWeekKey: PERSISTENT_LEARNING_KEY,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? requestedQueryWeekKey
        : null,
      sourceWeekKeyUsed: PERSISTENT_LEARNING_KEY,
      source: 'persistentLearningKey',

      currentWeekKey: PERSISTENT_LEARNING_KEY,
      previousWeekKey: PERSISTENT_LEARNING_KEY,
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

      mode,
      requestedMode,

      requestedLimit: requestedLimitNumber,
      limit,
      limitCapped: requestedLimitNumber > limit,
      sideLimit,
      sideEnsureLimit: sideLimit,

      bestLimit,

      bestCount: bestMicroMicroFamilies.length,
      bestRows: bestMicroMicroFamilies,
      best: bestMicroMicroFamilies,
      bestMicroFamilies: bestMicroMicroFamilies,
      topMicroFamilies: bestMicroMicroFamilies,

      bestMicroMicroCount: bestMicroMicroFamilies.length,
      bestMicroMicroRows: bestMicroMicroFamilies,
      bestMicroMicroFamilies,

      best75Count: 0,
      best75MicroFamilies: [],
      best25Count: bestMicroMicroFamilies.slice(0, 25).length,
      best25MicroFamilies: bestMicroMicroFamilies.slice(0, 25),

      filters,
      compact,

      count: normalizedRows.length,
      rowsRendered: normalizedRows.length,
      cleanRows: normalizedRows.length,
      legacyRows: 0,
      filtered: rankedRows.length,
      totalAvailable: mergedRows.length,

      rawExtractedRows: mergedRows.length,
      rawRows: mergedRows,
      rawMicroMicroRows: mergedRows,

      rows: normalizedRows,
      microRows: normalizedRows,
      microFamilies: normalizedRows,
      availableRows: normalizedRows,
      availableMicroFamilies: normalizedRows,
      microMicroRows: normalizedRows,
      microMicroFamilies: normalizedRows,

      generatedSelectableTaxonomyRows: 0,
      generatedMicroMicroRows: derived.rows.length,
      explicitMicroMicroRows: derived.explicitRows,
      outcomeDerivedMicroMicroRows: derived.outcomeDerivedRows,
      child75ProxyMicroMicroRows: derived.childProxyRows,

      selectableChildFamiliesTotal: 0,
      selectableMicroMicroFamiliesTotal: layers.microMicro,
      parentFamiliesTotal: 15,
      weekRows: sourceRows.length,

      microMicroRowsCount: derived.rows.length,
      microMicroRowsTotal: derived.rows.length,

      activeFallbackRows: activeFallbackRows.length,

      child75RowsHidden,
      parentRowsHidden,
      rawScannerFingerprintRowsHidden,
      rawExecutionFingerprintRowsHidden,

      rawSideCounts: sideCounts(mergedRows),
      filteredSideCounts: sideCounts(rankedRows),
      responseSideCounts: sideCounts(normalizedRows),
      bestSideCounts: sideCounts(bestMicroMicroFamilies),

      rawLayerCounts: layers,
      filteredLayerCounts: filteredLayers,
      responseLayerCounts: responseLayers,
      bestLayerCounts: bestLayers,

      tierCounts: tierCounts(rankedRows),
      statusCounts: statusCounts(rankedRows),
      currentFitCounts: fitCounts,
      currentFitUnknownRows: fitCounts.UNKNOWN || 0,

      activeRotationId: activeRotation?.rotationId || null,
      activeRotation: includeActiveRotation
        ? activeRotation
        : compactActiveRotation(activeRotation),

      activeMicroFamilyIds: activeMicroMicroFamilyIds,
      activeTrueMicroFamilyIds: activeMicroMicroFamilyIds,
      activeMicroMicroFamilyIds,
      selectedMicroMicroFamilyIds: activeMicroMicroFamilyIds,
      active75ChildFamilyIds: [],
      legacyChild75ActiveIdsIgnored,
      activeMacroFamilyIds: activeParentIds,

      bestShort: compactBestRow(bestRawRows[0] || null),
      bestLong: null,

      parentSummaries,

      shortRows: normalizedShortRows,
      longRows: [],
      unknownRows: [],

      summary,

      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      rankingPolicyText: 'microMicroOnly|fairWinrate|positivePnl|totalR|avgR|profitFactor|directSL|avgCostR|completed',
      rankingPolicyShort: 'fairWinrate|totalR|avgR|profitFactor|directSL|avgCostR',
      measurementFixVersion: MEASUREMENT_FIX_VERSION,
      adaptiveUiVersion: ADAPTIVE_UI_VERSION,
      currentFitVersion: CURRENT_FIT_VERSION,
      microMicroVersion: MICRO_MICRO_VERSION,

      warnings,
      error: null,

      perf: {
        durationMs: now() - startedAt,
        weekMicrosCacheHit: Boolean(weekResult.cacheHit),
        weekMicrosCacheStale: Boolean(weekResult.stale),
        weekMicrosCacheSize: cache.weekMicros.size,
        marketWeatherCacheHit: Boolean(marketWeather.cacheHit),
        path: 'shortOnlyMicroMicroOnlyPersistentLearningNetOutcomeObservationFirstCurrentFitV3WinratePnlFirst',
        bestSource: 'microMicroRowsOnly'
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