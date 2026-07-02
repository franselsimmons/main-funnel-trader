// ================= FILE: api/admin/overview.js =================
//
// SHORT-only admin overview.
// Safe compact reader:
// - gebruikt GEEN getWeekMicros()
// - gebruikt GEEN getRotationDashboard()
// - voorkomt deep/circular stack errors
// - UI toont alleen micro-micro als selecteerbare laag
//
// Learning hierarchy:
// Parent 15:   MICRO_SHORT_{SETUP}_{REGIME}
// Micro 75:    MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}
// Micro-micro: MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}
//
// Parent 15 en Micro 75 blijven backend/context/rollup.
// Micro-micro is de enige zichtbare/selecteerbare Discord-laag.

import { createHash } from 'crypto';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs,
  getKeys
} from '../../src/redis.js';
import {
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 6;

const MAX_ROWS = 120;
const MAX_DEBUG_ROWS = 50;
const MAX_DISCOVERED_KEYS = 25;
const MAX_ARRAY_COMPACT = 40;
const MAX_OBJECT_KEYS_COMPACT = 80;

const ADMIN_OVERVIEW_VERSION = 'SHORT_ADMIN_OVERVIEW_SAFE_DIRECT_REDIS_MICRO_MICRO_V4';

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const SHORT_FIXED_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const SHORT_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
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

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

const SHORT_MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const SHORT_MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
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

function bool(value, fallback = false) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = String(value ?? '').trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
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

function keyFromMaybeFunction(fn, arg, fallback = null) {
  try {
    return typeof fn === 'function' ? fn(arg) : fallback;
  } catch {
    return fallback;
  }
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
      'TRADE:RUN_META'
    )
  },

  analyze: {
    micros: namespacedShortKey(
      KEYS.short?.analyze?.micros ||
        KEYS.analyze?.shortMicros ||
        KEYS.analyze?.micros,
      `ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`
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
  },

  discord: {
    logList: namespacedShortKey(
      KEYS.short?.discord?.logList ||
        KEYS.discord?.shortLogList ||
        KEYS.discordShort?.logList ||
        KEYS.discord?.logList,
      'DISCORD:LOGS'
    )
  }
};

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
}

function modeFlags() {
  return {
    overviewVersion: ADMIN_OVERVIEW_VERSION,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

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
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
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
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,

    tradePositionTimeStopMinDefault: 720,
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
    currentFitCanBlockDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_CONTEXT_HASH_SOURCE_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    fixedTaxonomyPreferred: true,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75MicroFamilyCount: 75,
    selectableChildMicroFamilyCount: 75,

    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75FamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    microMicroFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',

    uiShowsOnlyMicroMicro: true,
    uiAllowsOnlyMicroMicroSelection: true,
    onlySelectableLayerInAdmin: true,

    parentIdsAreMetadataOnly: true,
    child75RowsHiddenInAdmin: true,
    parent15RowsHiddenInAdmin: true,
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    scannerMatchTriggersDiscord: false,

    manualSelectionOnly: true,
    manualSelectionRequired: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordMatch: 'candidate.microMicroFamilyId === selectedMicroMicroFamilyId',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    micro75MatchDoesNotTriggerDiscord: true,

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    safeDirectRedisOverview: true,
    getWeekMicrosDisabledInOverview: true,
    getRotationDashboardDisabledInOverview: true,
    stackSafeCompactionEnabled: true
  };
}

function versions() {
  return {
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    child75TrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    adaptiveUiVersion: ADMIN_OVERVIEW_VERSION,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function safeScalar(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  return String(value);
}

function safeCompact(value, depth = 2, seen = new WeakSet()) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'function') return '[Function]';
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) return '[Circular]';
  if (depth <= 0) {
    if (Array.isArray(value)) return `[Array:${value.length}]`;
    return '[Object]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_COMPACT)
      .map((item) => safeCompact(item, depth - 1, seen));
  }

  const out = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS_COMPACT);

  for (const [key, val] of entries) {
    if (
      key === 'source' ||
      key === 'universe' ||
      key === 'rows' ||
      key === 'candidates' ||
      key === 'tickers' ||
      key === 'marketContext' ||
      key === 'currentMarketUniverse'
    ) {
      if (Array.isArray(val)) out[`${key}Count`] = val.length;
      else if (val && typeof val === 'object') out[`${key}Omitted`] = true;
      else out[key] = val;
      continue;
    }

    out[key] = safeCompact(val, depth - 1, seen);
  }

  seen.delete(value);

  return out;
}

function safeRow(row = {}, options = {}) {
  const {
    includeSmallArrays = true,
    includeSmallObjects = false
  } = options;

  if (!row || typeof row !== 'object') return {};

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      if (includeSmallArrays) {
        out[key] = value
          .slice(0, 20)
          .map((item) => (
            item &&
            typeof item === 'object'
              ? safeCompact(item, 1)
              : safeScalar(item)
          ));
      } else {
        out[`${key}Count`] = value.length;
      }
      continue;
    }

    if (includeSmallObjects) {
      out[key] = safeCompact(value, 1);
    } else if (
      [
        'currentMarketWeather',
        'entryMarketWeather',
        'discordCurrentFitGate',
        'virtualGate',
        'qualityAudit',
        'rrVariantSummary',
        'selectedWeeklyStats',
        'weeklyStats'
      ].includes(key)
    ) {
      out[key] = safeCompact(value, 1);
    } else {
      out[`${key}Omitted`] = true;
    }
  }

  return out;
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      row?.microMicroFamilyId ||
        row?.trueMicroMicroFamilyId ||
        row?.exactMicroMicroFamilyId ||
        row?.trueMicroFamilyId ||
        row?.learningMicroFamilyId ||
        row?.analyzeMicroFamilyId ||
        row?.microFamilyId ||
        row?.id ||
        row?.key ||
        String(index),
      row
    ]);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value);
  }

  return [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
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

function hashText(value, length = MICRO_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, length);
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED_TRUE', 'SHORT')
    .replaceAll('LONGDISABLED_TRUE', 'SHORT')
    .replaceAll('BLOCK_LONG_TRUE', 'SHORT')
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
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

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

function parseLegacyMicroMicroId(id = '') {
  const value = upper(id);

  if (!value.startsWith(`MM_${TARGET_TRADE_SIDE}_`)) {
    return {
      valid: false,
      isMicroMicro: false,
      rawId: String(id || '').trim()
    };
  }

  const body = value.slice(`MM_${TARGET_TRADE_SIDE}_`.length);

  for (const setup of SETUP_ORDER) {
    for (const regime of REGIME_ORDER) {
      for (const confirmationProfile of CONFIRMATION_PROFILE_ORDER) {
        const prefix = `${setup}_${regime}_${confirmationProfile}`;
        if (body !== prefix && !body.startsWith(`${prefix}_`)) continue;

        const context = body === prefix ? 'LEGACY' : body.slice(prefix.length + 1);
        const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
        const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
        const microMicroHash = hashText(`LEGACY_MM|${childTrueMicroFamilyId}|${context}`, MICRO_MICRO_HASH_LEN);
        const microMicroFamilyId = `${childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;

        return {
          valid: true,
          selectable: true,
          isParent: false,
          isChild: false,
          isMicroMicro: true,
          legacy: true,
          rawId: String(id || '').trim(),
          setup,
          regime,
          confirmationProfile,
          parentTrueMicroFamilyId,
          childTrueMicroFamilyId,
          trueMicroFamilyId: childTrueMicroFamilyId,
          microFamilyId: childTrueMicroFamilyId,
          microMicroFamilyId,
          trueMicroMicroFamilyId: microMicroFamilyId,
          exactMicroMicroFamilyId: microMicroFamilyId,
          microMicroHash,
          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          microMicroFamilySchema: MICRO_MICRO_SCHEMA,
          trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
          learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
          microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
        };
      }
    }
  }

  return {
    valid: false,
    isMicroMicro: false,
    rawId: String(id || '').trim()
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (value.startsWith(`MM_${TARGET_TRADE_SIDE}_`)) {
    return parseLegacyMicroMicroId(value);
  }

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
  let microMicroFamilyId = null;

  const microMicroMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);

  if (microMicroMatch) {
    baseValue = microMicroMatch[1];
    microMicroHash = microMicroMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
  }

  let body = baseValue.slice('MICRO_SHORT_'.length);
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

  const parentTrueMicroFamilyId = setup && regime
    ? `MICRO_SHORT_${setup}_${regime}`
    : null;

  const childTrueMicroFamilyId = parentTrueMicroFamilyId && confirmationProfile
    ? `${parentTrueMicroFamilyId}_${confirmationProfile}`
    : null;

  const validParent =
    Boolean(parentTrueMicroFamilyId) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);

  if (validChild && microMicroHash) {
    microMicroFamilyId = `${childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;
  }

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
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentTrueMicroFamilyId : null,
    trueMicroFamilyId: validChild || isMicroMicro
      ? childTrueMicroFamilyId
      : validParent
        ? parentTrueMicroFamilyId
        : null,
    childTrueMicroFamilyId: validChild || isMicroMicro ? childTrueMicroFamilyId : null,
    microFamilyId: validChild || isMicroMicro
      ? childTrueMicroFamilyId
      : validParent
        ? parentTrueMicroFamilyId
        : null,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
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

  if (isMicroMicroFamilyId(value)) return false;

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function isSelectableTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return isFixedShortChildMicroId(value);
}

function isSelectableMicroMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return isMicroMicroFamilyId(value);
}

function normalizeMicroMicroFamilyId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.isMicroMicro ? parsed.microMicroFamilyId : null;
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    return (
      value.snapshotId ||
      value.id ||
      value.latestSnapshotId ||
      value.scanId ||
      null
    );
  }

  return null;
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .join(' | ');
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const value = cleanSideText(input);

    if (!value) return 'UNKNOWN';

    const direct = normalizeSideToken(value);

    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
      return direct;
    }

    const parsed = parseShortTaxonomyMicroId(value);
    if (parsed.valid) return TARGET_TRADE_SIDE;

    const longSignal = hasLongSignal(value);
    const shortSignal = hasShortSignal(value);

    if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
    if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

    if (longSignal && shortSignal) {
      if (value.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
      if (value.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    }

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
    const side = normalizeSideToken(source);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const microFamilyId = cleanSideText(
    input.microMicroFamilyId ||
      input.trueMicroMicroFamilyId ||
      input.exactMicroMicroFamilyId ||
      input.trueMicroFamilyId ||
      input.learningMicroFamilyId ||
      input.analyzeMicroFamilyId ||
      input.microFamilyId ||
      input.childTrueMicroFamilyId ||
      input.parentTrueMicroFamilyId ||
      input.coarseMicroFamilyId ||
      input.baseMicroFamilyId ||
      input.legacyMicroFamilyId ||
      input.id ||
      input.key
  );

  if (parseShortTaxonomyMicroId(microFamilyId).valid) return TARGET_TRADE_SIDE;
  if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  const definition = getDefinitionHaystack(input);
  const longSignal = hasLongSignal(definition);
  const shortSignal = hasShortSignal(definition);

  if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
  if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

  if (longSignal && shortSignal) {
    if (microFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  if (input.shortOnly === true || input.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (input.longOnly === true || input.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  if (!row) return false;

  const id = String(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.microFamilyId ||
      row.coarseMicroFamilyId ||
      row.id ||
      row.key ||
      ''
  ).trim();

  if (id && isScannerFingerprintId(id)) return false;
  if (id && isExecutionFingerprintId(id)) return false;
  if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;

  return true;
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function getMicroMicroFamilyId(row = {}, key = '') {
  const candidates = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    key
  ];

  for (const candidate of candidates) {
    const id = String(candidate || '').trim();
    const normalized = normalizeMicroMicroFamilyId(id);

    if (normalized && isSelectableMicroMicroId(normalized)) return normalized;
  }

  return null;
}

function getTrueMicroFamilyId(row = {}, key = '') {
  const microMicroId = getMicroMicroFamilyId(row, key);
  if (microMicroId) {
    const parsedMicroMicro = parseShortTaxonomyMicroId(microMicroId);
    if (parsedMicroMicro.childTrueMicroFamilyId) return parsedMicroMicro.childTrueMicroFamilyId;
  }

  const candidates = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    key
  ];

  for (const candidate of candidates) {
    const id = String(candidate || '').trim();
    const parsed = parseShortTaxonomyMicroId(id);

    if (parsed.isChild && parsed.childTrueMicroFamilyId) return parsed.childTrueMicroFamilyId;
    if (parsed.isMicroMicro && parsed.childTrueMicroFamilyId) return parsed.childTrueMicroFamilyId;
  }

  return null;
}

function getAnyMicroFamilyId(row = {}, key = '') {
  return (
    row.microMicroFamilyId ||
    row.trueMicroMicroFamilyId ||
    row.exactMicroMicroFamilyId ||
    row.trueMicroFamilyId ||
    row.learningMicroFamilyId ||
    row.analyzeMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    key ||
    null
  );
}

function getParentTrueMicroFamilyId(row = {}, key = '') {
  const microMicroId = getMicroMicroFamilyId(row, key);
  if (microMicroId) {
    const parsed = parseShortTaxonomyMicroId(microMicroId);
    if (parsed.parentTrueMicroFamilyId) return parsed.parentTrueMicroFamilyId;
  }

  const childId = getTrueMicroFamilyId(row, key);
  const parsedChild = parseShortTaxonomyMicroId(childId);

  if (parsedChild.parentTrueMicroFamilyId) return parsedChild.parentTrueMicroFamilyId;

  const candidates = [
    row.parentTrueMicroFamilyId,
    row.microMicroRollupParentFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.familyId,
    row.macroId
  ];

  for (const candidate of candidates) {
    const id = String(candidate || '').trim();

    if (isFixedShortParentMicroId(id)) return id;
  }

  return null;
}

function filterShortRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .filter(isShortRow);
}

function normalizeShortSide(row = {}) {
  return {
    ...safeRow(row, { includeSmallArrays: true, includeSmallObjects: false }),
    ...modeFlags(),

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    inferredTradeSide: TARGET_TRADE_SIDE
  };
}

function virtualKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;
  return `virtual${String(realKey).slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;
  return `shadow${String(realKey).slice(4)}`;
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

function isLearningOutcomeSource(source = '') {
  const value = upper(source || 'VIRTUAL');

  return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value === '';
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
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
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

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  const virtualKey = virtualKeyFromReal(realKey);
  const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

  const virtualShadow =
    num(virtualKey ? row[virtualKey] : 0, 0) +
    num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0);

  if (virtualShadow > 0 || hasVirtualShadowOutcomeFields(row)) {
    return virtualShadow;
  }

  if (aggregateKey && hasValue(row[aggregateKey])) {
    return num(row[aggregateKey], 0);
  }

  return 0;
}

function aggregateRecentOutcomes(row = {}) {
  const outcomes = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  return outcomes.reduce(
    (acc, outcome) => {
      if (!outcome || typeof outcome !== 'object') return acc;
      if (!isLearningOutcomeSource(outcome.source || outcome.outcomeSource || 'VIRTUAL')) return acc;
      if (!isShortRow({ ...row, ...outcome })) return acc;

      const netR = outcomeNetR(outcome);
      const costR = num(outcome.costR ?? outcome.avgCostR, 0);

      acc.completed += 1;
      acc.totalR += netR;
      acc.totalCostR += costR;

      if (netR > 0) acc.wins += 1;
      else if (netR < 0) acc.losses += 1;
      else acc.flats += 1;

      return acc;
    },
    {
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      totalR: 0,
      totalCostR: 0
    }
  );
}

function getOutcomeCounts(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
  const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
  const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');

  const virtualShadowCompleted =
    num(row.virtualCompleted, 0) +
    num(row.shadowCompleted, 0);

  const aggregateCompleted = hasVirtualShadowOutcomeFields(row)
    ? 0
    : Math.max(
      num(row.completed, 0),
      num(row.outcomeSample, 0),
      0
    );

  if (
    wins + losses + flats <= 0 &&
    virtualShadowCompleted <= 0 &&
    aggregateCompleted <= 0 &&
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

function getOutcomeSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    getOutcomeSample(row),
    0
  );
}

function getTotalR(row = {}) {
  const completed = getOutcomeSample(row);
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

function getTotalCostR(row = {}) {
  const completed = getOutcomeSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowCost =
    num(row.virtualTotalCostR, 0) +
    num(row.shadowTotalCostR, 0);

  if (virtualShadowCost > 0 || hasVirtualShadowOutcomeFields(row)) return virtualShadowCost;

  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;

  if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);
  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;

  return 0;
}

function getAvgR(row = {}) {
  const completed = getOutcomeSample(row);
  return completed > 0 ? getTotalR(row) / completed : 0;
}

function getAvgCostR(row = {}) {
  const completed = getOutcomeSample(row);
  return completed > 0 ? getTotalCostR(row) / completed : 0;
}

function getDirectSLPct(row = {}) {
  const directSL = firstFiniteNumber([
    row.directSLPct,
    row.directSlPct,
    row.directSLRate,
    row.directSlRate
  ]);

  if (directSL !== null) {
    return directSL > 1 ? directSL / 100 : directSL;
  }

  const completed = getOutcomeSample(row);
  const directSLCount = firstFiniteNumber([
    row.directSL,
    row.directSl,
    row.directSLLosses,
    row.directSlLosses
  ]);

  if (completed > 0 && directSLCount !== null) return directSLCount / completed;

  return 0;
}

function tierForMicroMicro(row = {}) {
  const completed = getOutcomeSample(row);
  const observed = getObservationSample(row);

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'HARD';
  if (completed > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function statusForMicroMicro(row = {}) {
  const completed = getOutcomeSample(row);

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO_ACTIVE';
  if (completed > 0) return 'MICRO_MICRO_EARLY';

  return 'MICRO_MICRO_OBSERVING';
}

function normalizeMicroMicroRow(row = {}, key = '') {
  const microMicroFamilyId = getMicroMicroFamilyId(row, key);
  const trueMicroFamilyId = getTrueMicroFamilyId(row, key);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row, key);
  const parsed = parseShortTaxonomyMicroId(microMicroFamilyId || trueMicroFamilyId);

  const completed = getOutcomeSample(row);
  const outcomes = getOutcomeCounts(row);
  const totalR = getTotalR(row);
  const avgR = completed > 0 ? totalR / completed : 0;
  const totalCostR = getTotalCostR(row);
  const avgCostR = completed > 0 ? totalCostR / completed : 0;
  const directSLPct = getDirectSLPct(row);

  return normalizeShortSide({
    ...row,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    setupType: parsed.setup || row.setupType || null,
    regimeBucket: parsed.regime || row.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,

    completed,
    wins: outcomes.wins,
    losses: outcomes.losses,
    flats: outcomes.flats,
    seen: getObservationSample(row),

    totalR: round(totalR, 4),
    avgR: round(avgR, 4),
    totalCostR: round(totalCostR, 4),
    avgCostR: round(avgCostR, 4),
    directSLPct: round(directSLPct, 4),
    directSLPctDisplay: round(directSLPct * 100, 2),

    winrate: completed > 0 ? round(outcomes.wins / completed, 4) : 0,
    winratePct: completed > 0 ? round((outcomes.wins / completed) * 100, 2) : 0,

    tier: tierForMicroMicro(row),
    status: statusForMicroMicro(row),

    selectable: Boolean(microMicroFamilyId),
    microMicroSelectable: Boolean(microMicroFamilyId),
    selectionGranularity: 'EXACT_MICRO_MICRO',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    cleanMeasurement: Boolean(
      row.cleanMeasurement === true ||
      row.measurementFixVersion ||
      row.costModelVersion ||
      completed > 0
    )
  });
}

function extractMicrosPayload(payload) {
  if (!payload) return {};

  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.micros) || (payload.micros && typeof payload.micros === 'object')) return payload.micros;
    if (Array.isArray(payload.microFamilies) || (payload.microFamilies && typeof payload.microFamilies === 'object')) return payload.microFamilies;
    if (Array.isArray(payload.rows) || (payload.rows && typeof payload.rows === 'object')) return payload.rows;
    if (Array.isArray(payload.stats) || (payload.stats && typeof payload.stats === 'object')) return payload.stats;
    if (payload.data && typeof payload.data === 'object') return extractMicrosPayload(payload.data);

    const entries = Object.entries(payload);
    const looksLikeMicros = entries.some(([key, row]) => (
      parseShortTaxonomyMicroId(key).valid ||
      parseShortTaxonomyMicroId(row?.microMicroFamilyId).valid ||
      parseShortTaxonomyMicroId(row?.trueMicroMicroFamilyId).valid ||
      parseShortTaxonomyMicroId(row?.exactMicroMicroFamilyId).valid ||
      parseShortTaxonomyMicroId(row?.trueMicroFamilyId).valid ||
      parseShortTaxonomyMicroId(row?.microFamilyId).valid
    ));

    if (looksLikeMicros) return payload;
  }

  return {};
}

function scoreMicrosPayload(micros = {}) {
  const entries = sourceEntries(micros);

  let microMicroRows = 0;
  let child75Rows = 0;
  let parent15Rows = 0;

  for (const [key, row] of entries) {
    if (getMicroMicroFamilyId(row, key)) microMicroRows += 1;
    else if (getTrueMicroFamilyId(row, key)) child75Rows += 1;
    else if (isFixedShortParentMicroId(key) || isFixedShortParentMicroId(row?.microFamilyId)) parent15Rows += 1;
  }

  return {
    totalRows: entries.length,
    microMicroRows,
    child75Rows,
    parent15Rows,
    score: microMicroRows * 1000 + child75Rows * 10 + parent15Rows
  };
}

async function readJsonFromStores({ durable, volatile, key, fallback = null }) {
  if (!key) return { value: fallback, source: null };

  const fromVolatile = await getJson(volatile, key, null).catch(() => null);
  if (fromVolatile !== null && fromVolatile !== undefined) {
    return {
      value: fromVolatile,
      source: `VOLATILE:${key}`
    };
  }

  const fromDurable = await getJson(durable, key, null).catch(() => null);
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

async function discoverKeys(redis, pattern, limit = MAX_DISCOVERED_KEYS) {
  if (!redis || !pattern) return [];

  try {
    if (typeof getKeys === 'function') {
      const keys = await getKeys(redis, pattern, limit);
      return Array.isArray(keys) ? keys : [];
    }
  } catch {
    return [];
  }

  return [];
}

async function readDirectMicros({ durable, volatile }) {
  const explicitKeys = uniqueStrings([
    SHORT_KEYS.analyze.micros,
    `${SHORT_KEY_PREFIX}ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`,
    `${SHORT_KEY_PREFIX}ANALYZE:${PERSISTENT_LEARNING_KEY}:MICROS`,
    `${SHORT_KEY_PREFIX}ANALYZE:MICROS`,
    `${SHORT_KEY_PREFIX}ANALYZE:MICRO_FAMILIES`,
    `${SHORT_KEY_PREFIX}MICRO_FAMILIES`,
    `${SHORT_KEY_PREFIX}MICROFAMILIES`,
    `${SHORT_KEY_PREFIX}LEARNING:MICROS`,
    `${SHORT_KEY_PREFIX}LEARNING:${PERSISTENT_LEARNING_KEY}:MICROS`
  ]);

  const discovered = uniqueStrings([
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}ANALYZE:*MICROS*`),
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*MICRO*FAMIL*`),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}ANALYZE:*MICROS*`),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*MICRO*FAMIL*`)
  ]);

  const keys = uniqueStrings([...explicitKeys, ...discovered]).slice(0, MAX_DISCOVERED_KEYS);

  let best = {
    micros: {},
    sourceKey: null,
    source: null,
    stats: {
      totalRows: 0,
      microMicroRows: 0,
      child75Rows: 0,
      parent15Rows: 0,
      score: 0
    },
    triedKeys: keys
  };

  for (const key of keys) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (!read.value) continue;

    const micros = extractMicrosPayload(read.value);
    const stats = scoreMicrosPayload(micros);

    if (stats.score > best.stats.score || (stats.totalRows > 0 && best.stats.totalRows <= 0)) {
      best = {
        micros,
        sourceKey: key,
        source: read.source,
        stats,
        triedKeys: keys
      };
    }
  }

  return best;
}

async function readDirectMarket({ durable, volatile }) {
  const weatherRead = await readJsonFromStores({
    durable,
    volatile,
    key: SHORT_MARKET_WEATHER_KEY,
    fallback: null
  });

  const universeRead = await readJsonFromStores({
    durable,
    volatile,
    key: SHORT_MARKET_UNIVERSE_KEY,
    fallback: null
  });

  const weather = safeObject(weatherRead.value);
  const universe = safeObject(universeRead.value);

  const createdAt = num(
    weather.createdAt ||
      weather.completedAt ||
      weather.updatedAt ||
      weather.ts ||
      universe.createdAt ||
      universe.completedAt ||
      universe.updatedAt ||
      universe.ts,
    0
  );

  return {
    regime: weather.currentRegime || weather.regime || universe.currentRegime || universe.regime || null,
    trendSide: weather.currentTrendSide || weather.trendSide || universe.currentTrendSide || universe.trendSide || null,
    bullishPct: weather.bullishPct ?? universe.bullishPct ?? null,
    bearishPct: weather.bearishPct ?? universe.bearishPct ?? null,
    neutralPct: weather.neutralPct ?? universe.neutralPct ?? null,
    squeezePct: weather.squeezePct ?? universe.squeezePct ?? null,
    confidence: weather.confidence ?? weather.weatherConfidence ?? universe.confidence ?? null,
    ageSec: createdAt > 0 ? Math.max(0, Math.floor((now() - createdAt) / 1000)) : null,
    ageText: createdAt > 0 ? `${Math.max(0, Math.floor((now() - createdAt) / 1000))}s geleden` : null,
    source: weatherRead.source || universeRead.source,
    key: SHORT_MARKET_WEATHER_KEY,
    universeKey: SHORT_MARKET_UNIVERSE_KEY,
    available: Boolean(weatherRead.value || universeRead.value)
  };
}

function extractRotationPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      active: null,
      next: null,
      activeRows: [],
      nextRows: []
    };
  }

  if (payload.active || payload.activeRotation || payload.next || payload.nextRotation) {
    return {
      active: payload.active || payload.activeRotation || null,
      next: payload.next || payload.nextRotation || null,
      activeRows: Array.isArray(payload.activeRows) ? payload.activeRows : [],
      nextRows: Array.isArray(payload.nextRows) ? payload.nextRows : []
    };
  }

  if (
    payload.rotationId ||
    payload.microFamilies ||
    payload.microMicroFamilyIds ||
    payload.selectedMicroMicroFamilyIds ||
    payload.activeMicroMicroFamilyIds
  ) {
    return {
      active: payload,
      next: null,
      activeRows: Array.isArray(payload.microFamilies) ? payload.microFamilies : [],
      nextRows: []
    };
  }

  return {
    active: null,
    next: null,
    activeRows: [],
    nextRows: []
  };
}

async function readDirectRotation({ durable, volatile }) {
  const explicitKeys = uniqueStrings([
    SHORT_KEYS.rotation.dashboard,
    SHORT_KEYS.rotation.active,
    `${SHORT_KEY_PREFIX}ROTATION:DASHBOARD`,
    `${SHORT_KEY_PREFIX}ROTATION:ACTIVE`,
    `${SHORT_KEY_PREFIX}ROTATION:CURRENT`,
    `${SHORT_KEY_PREFIX}WEEKLY_ROTATION:ACTIVE`,
    `${SHORT_KEY_PREFIX}ANALYZE:ROTATION:ACTIVE`,
    `${SHORT_KEY_PREFIX}DISCORD:SELECTION`,
    `${SHORT_KEY_PREFIX}MANUAL:SELECTION`
  ]);

  const discovered = uniqueStrings([
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*ROTATION*`, 15),
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*SELECTION*`, 15),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*ROTATION*`, 15),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*SELECTION*`, 15)
  ]);

  const keys = uniqueStrings([...explicitKeys, ...discovered]).slice(0, MAX_DISCOVERED_KEYS);

  for (const key of keys) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (!read.value) continue;

    const rotation = extractRotationPayload(read.value);
    const selected = extractSelectedMicroMicroIds(rotation.active, rotation.activeRows);

    if (rotation.active || selected.length > 0) {
      return {
        ...rotation,
        sourceKey: key,
        source: read.source,
        triedKeys: keys
      };
    }
  }

  return {
    active: null,
    next: null,
    activeRows: [],
    nextRows: [],
    sourceKey: null,
    source: null,
    triedKeys: keys
  };
}

function extractSelectedMicroMicroIds(...sources) {
  const raw = [];

  for (const source of sources) {
    if (!source) continue;

    if (Array.isArray(source)) {
      for (const row of source) {
        raw.push(
          row?.microMicroFamilyId,
          row?.trueMicroMicroFamilyId,
          row?.exactMicroMicroFamilyId,
          row?.selectedMicroMicroFamilyId,
          row?.selectedTrueMicroMicroFamilyId,
          row?.selectedExactMicroMicroFamilyId
        );
      }

      continue;
    }

    if (typeof source === 'object') {
      raw.push(
        source.microMicroFamilyId,
        source.trueMicroMicroFamilyId,
        source.exactMicroMicroFamilyId,
        source.selectedMicroMicroFamilyId,
        source.selectedTrueMicroMicroFamilyId,
        source.selectedExactMicroMicroFamilyId,
        source.microMicroFamilyIds,
        source.trueMicroMicroFamilyIds,
        source.exactMicroMicroFamilyIds,
        source.selectedMicroMicroFamilyIds,
        source.selectedTrueMicroMicroFamilyIds,
        source.selectedExactMicroMicroFamilyIds,
        source.activeMicroMicroFamilyIds,
        source.activeTrueMicroMicroFamilyIds,
        source.activeExactMicroMicroFamilyIds,
        source.ids,
        source.activeIds
      );

      if (Array.isArray(source.microFamilies)) {
        for (const row of source.microFamilies) {
          raw.push(
            row?.microMicroFamilyId,
            row?.trueMicroMicroFamilyId,
            row?.exactMicroMicroFamilyId,
            row?.selectedMicroMicroFamilyId
          );
        }
      }
    }
  }

  return uniqueStrings(flattenValues(raw))
    .map(normalizeMicroMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId);
}

function normalizeRotation(rotation, rows = []) {
  if (!rotation && (!Array.isArray(rows) || rows.length <= 0)) {
    return null;
  }

  const rawMicroFamilies = [
    ...(Array.isArray(rotation?.microFamilies) ? rotation.microFamilies : []),
    ...(Array.isArray(rows) ? rows : [])
  ];

  const microMicroRows = rawMicroFamilies
    .filter(isShortRow)
    .map((row) => normalizeMicroMicroRow(row))
    .filter((row) => row.microMicroFamilyId && isSelectableMicroMicroId(row.microMicroFamilyId));

  const selectedMicroMicroFamilyIds = extractSelectedMicroMicroIds(rotation, rows, microMicroRows);

  const selectedParentTrueMicroFamilyIds = uniqueStrings(
    selectedMicroMicroFamilyIds
      .map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
      .filter(Boolean)
  );

  return {
    ...safeRow(rotation || {}, { includeSmallArrays: false, includeSmallObjects: false }),
    ...modeFlags(),

    sideMode: 'short_only',

    manualOnly: true,
    adminSelected: rotation?.adminSelected === true || rotation?.manualOnly === true,
    autoRotation: false,
    autoActivationDisabled: true,

    exactTrueMicroOnly: true,
    exactMicroMicroOnly: true,
    selectableLayer: 'MICRO_MICRO_ONLY',

    bestShort: microMicroRows[0] || null,
    bestLong: null,

    microFamilies: microMicroRows.slice(0, MAX_ROWS),
    microMicroRows: microMicroRows.slice(0, MAX_ROWS),

    microFamilyIds: [],
    activeMicroFamilyIds: [],
    trueMicroFamilyIds: [],
    childTrueMicroFamilyIds: [],

    microMicroFamilyIds: selectedMicroMicroFamilyIds,
    activeMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    trueMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    exactMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    selectedMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: selectedMicroMicroFamilyIds,

    macroFamilyIds: selectedParentTrueMicroFamilyIds,
    activeMacroFamilyIds: selectedParentTrueMicroFamilyIds,
    selectedMacroFamilyIds: selectedParentTrueMicroFamilyIds,

    count: selectedMicroMicroFamilyIds.length || microMicroRows.length,

    rawMicroFamiliesCount: rawMicroFamilies.length,
    longMicroFamiliesIgnored: rawMicroFamilies.filter(isLongRow).length,

    missingSides: selectedMicroMicroFamilyIds.length || microMicroRows.length
      ? []
      : [TARGET_TRADE_SIDE]
  };
}

function compactRotationDashboard(rotationRead = {}, fallbackSelectedIds = []) {
  const active = normalizeRotation(rotationRead.active, rotationRead.activeRows);
  const next = normalizeRotation(rotationRead.next, rotationRead.nextRows);

  const fallbackActive = !active && fallbackSelectedIds.length > 0
    ? normalizeRotation({
        rotationId: `manual_${PERSISTENT_LEARNING_KEY}`,
        selectedMicroMicroFamilyIds: fallbackSelectedIds,
        manualOnly: true,
        adminSelected: true
      }, [])
    : active;

  return {
    ...modeFlags(),

    source: rotationRead.source || null,
    sourceKey: rotationRead.sourceKey || null,
    triedKeys: rotationRead.triedKeys || [],

    active: fallbackActive,
    next,
    activeRotation: fallbackActive,
    nextRotation: next,

    activeRows: fallbackActive?.microMicroRows || [],
    nextRows: next?.microMicroRows || [],

    activeCount: fallbackActive?.count || 0,
    nextCount: next?.count || 0,

    activeMicroFamilyIds: [],
    nextMicroFamilyIds: [],

    activeMicroMicroFamilyIds: fallbackActive?.selectedMicroMicroFamilyIds || [],
    nextMicroMicroFamilyIds: next?.selectedMicroMicroFamilyIds || [],

    activeMacroFamilyIds: fallbackActive?.macroFamilyIds || fallbackActive?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    bestShort: fallbackActive?.bestShort || null,
    bestLong: null,

    nextBestShort: next?.bestShort || null,
    nextBestLong: null,

    missingSides: fallbackActive?.missingSides || [],
    nextMissingSides: next?.missingSides || [],

    autoRotationActivationDisabled: true
  };
}

function summarizeMicroMicroRows(micros = {}) {
  const allEntries = sourceEntries(micros);

  const rows = allEntries
    .map(([key, row]) => normalizeMicroMicroRow(row, key))
    .filter((row) => row.microMicroFamilyId && isSelectableMicroMicroId(row.microMicroFamilyId))
    .filter(isShortRow);

  const summary = rows.reduce((acc, row) => {
    const tier = tierForMicroMicro(row);
    const status = statusForMicroMicro(row);
    const completed = getOutcomeSample(row);
    const observed = getObservationSample(row);
    const totalR = getTotalR(row);
    const totalCostR = getTotalCostR(row);
    const directSLPct = getDirectSLPct(row);

    acc.rows += 1;
    acc.seen += observed;
    acc.observations += num(row.observations, 0);
    acc.completed += completed;
    acc.totalR += totalR;
    acc.totalCostR += totalCostR;
    acc.directSLPctSum += directSLPct;
    acc.directSLPctRows += directSLPct > 0 ? 1 : 0;

    acc.tierCounts[tier] = (acc.tierCounts[tier] || 0) + 1;
    acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

    if (completed > 0) acc.completedFamilies += 1;
    if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) acc.activeLearningFamilies += 1;
    if (completed > 0 && completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE) acc.earlyOutcomeFamilies += 1;
    if (observed > 0 && completed <= 0) acc.observationOnlyFamilies += 1;
    if (row.cleanMeasurement) acc.cleanMeasurementRows += 1;

    return acc;
  }, {
    rows: 0,
    seen: 0,
    observations: 0,
    completed: 0,
    totalR: 0,
    totalCostR: 0,
    directSLPctSum: 0,
    directSLPctRows: 0,
    completedFamilies: 0,
    activeLearningFamilies: 0,
    earlyOutcomeFamilies: 0,
    observationOnlyFamilies: 0,
    cleanMeasurementRows: 0,
    tierCounts: {
      HARD: 0,
      SOFT: 0,
      OBSERVATION: 0,
      RAW: 0
    },
    statusCounts: {
      MICRO_MICRO_ACTIVE: 0,
      MICRO_MICRO_EARLY: 0,
      MICRO_MICRO_OBSERVING: 0
    }
  });

  return {
    ...summary,
    ...modeFlags(),

    visibleMicroMicroRows: summary.rows,
    selectableMicroMicroFamiliesWithRows: summary.rows,

    seen: round(summary.seen, 4),
    observations: round(summary.observations, 4),
    completed: round(summary.completed, 4),
    totalR: round(summary.totalR, 4),
    totalCostR: round(summary.totalCostR, 4),
    avgR: summary.completed > 0 ? round(summary.totalR / summary.completed, 4) : 0,
    avgCostR: summary.completed > 0 ? round(summary.totalCostR / summary.completed, 4) : 0,
    avgDirectSLPct: summary.directSLPctRows > 0
      ? round(summary.directSLPctSum / summary.directSLPctRows, 4)
      : 0,

    rowsList: rows
      .sort((a, b) => {
        const ac = getOutcomeSample(a);
        const bc = getOutcomeSample(b);
        if (bc !== ac) return bc - ac;
        return getTotalR(b) - getTotalR(a);
      })
      .slice(0, MAX_ROWS)
  };
}

function summarizeHiddenRows(micros = {}) {
  const entries = sourceEntries(micros);

  let parentRowsHidden = 0;
  let child75RowsHidden = 0;
  let scannerFingerprintRowsHidden = 0;
  let executionFingerprintRowsHidden = 0;
  let longRowsIgnored = 0;
  let unknownRows = 0;

  for (const [key, row] of entries) {
    const id = String(
      row?.microMicroFamilyId ||
        row?.trueMicroMicroFamilyId ||
        row?.exactMicroMicroFamilyId ||
        row?.trueMicroFamilyId ||
        row?.learningMicroFamilyId ||
        row?.analyzeMicroFamilyId ||
        row?.microFamilyId ||
        key ||
        ''
    );

    if (isLongRow(row)) {
      longRowsIgnored += 1;
      continue;
    }

    if (inferTradeSide(row) === 'UNKNOWN') unknownRows += 1;

    if (
      isScannerFingerprintId(id) ||
      isScannerFingerprintId(row?.scannerMicroFamilyId) ||
      isScannerFingerprintId(row?.coarseMicroFamilyId)
    ) {
      scannerFingerprintRowsHidden += 1;
      continue;
    }

    if (
      isExecutionFingerprintId(id) ||
      isExecutionFingerprintId(row?.executionMicroFamilyId) ||
      isExecutionFingerprintId(row?.coarseMicroFamilyId)
    ) {
      executionFingerprintRowsHidden += 1;
      continue;
    }

    if (isMicroMicroFamilyId(id) || getMicroMicroFamilyId(row, key)) {
      continue;
    }

    if (isFixedShortChildMicroId(id) || getTrueMicroFamilyId(row, key)) {
      child75RowsHidden += 1;
      continue;
    }

    if (isFixedShortParentMicroId(id) || isFixedShortParentMicroId(row?.parentTrueMicroFamilyId)) {
      parentRowsHidden += 1;
    }
  }

  return {
    parentRowsHidden,
    child75RowsHidden,
    scannerFingerprintRowsHidden,
    executionFingerprintRowsHidden,
    longRowsIgnored,
    unknownRows
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterShortRows(rawCandidates)
    .map((row) => normalizeShortSide({
      ...row,
      source: row.source || 'SCANNER',
      scannerOnly: true,
      scannerFingerprintRole: 'METADATA_ONLY',
      scannerFingerprintsUsedAsLearningFamily: false
    }))
    .slice(0, MAX_DEBUG_ROWS);

  const createdAt = safeNumber(
    latestScan.createdAt ||
      latestScan.completedAt ||
      latestScan.ts ||
      latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const fallbackCandidatesCount = safeNumber(
    latestScan.shortCandidatesCount ??
      latestScan.selectedTargetCandidateCount ??
      latestScan.scannerGateCandidatesCount ??
      latestScan.candidatesCount ??
      latestScan.count,
    0
  );

  const topSymbols = candidates.length > 0
    ? candidates
      .slice(0, 20)
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
    : Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols.slice(0, 20)
      : [];

  return {
    ...safeRow(latestScan, { includeSmallArrays: false, includeSmallObjects: false }),
    ...modeFlags(),

    snapshotId: extractSnapshotId(latestScan),

    createdAt: createdAt || null,
    snapshotAgeSec,

    rawCandidatesCount: rawCandidates.length,

    candidatesCount: rawCandidates.length > 0
      ? filterShortRows(rawCandidates).length
      : fallbackCandidatesCount,

    shortCandidatesCount: rawCandidates.length > 0
      ? filterShortRows(rawCandidates).length
      : fallbackCandidatesCount,

    longCandidatesIgnored: rawCandidates.filter(isLongRow).length,

    scannerBucketsDebugMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    topSymbols,
    candidates
  };
}

function actionIsLearningVirtual(action = {}) {
  return Boolean(
    action.virtualOnly !== false ||
      action.virtualTracked !== false ||
      action.shadowOnly !== false ||
      action.learningOnly ||
      action.observationOnly ||
      action.analysisInputOnly ||
      action.source === 'VIRTUAL' ||
      action.source === 'SHADOW' ||
      action.shadowResult ||
      action.reason === 'SHORT_RISK_INVALID' ||
      action.reason === 'RISK_ENGINE_EMPTY_SHORT_RISK_OBSERVATION_ONLY'
  );
}

function normalizeTradeAction(action = {}) {
  const microMicroFamilyId = getMicroMicroFamilyId(action);
  const trueMicroFamilyId = getTrueMicroFamilyId(action);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(action);
  const riskGeometry = getShortRiskGeometry(action);

  return normalizeShortSide({
    ...action,

    source: action.source || 'VIRTUAL',

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,

    selectableMicroMicroFamily: Boolean(microMicroFamilyId),

    virtualOnly: true,
    virtualTracked: true,
    learningOnly: true,
    realOrderPlaced: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    validShortRiskShape: Boolean(riskGeometry.validGeometry),
    validShortGeometry: Boolean(riskGeometry.validGeometry),
    shortTpHit: riskGeometry.shortTpHit,
    shortSlHit: riskGeometry.shortSlHit,
    tpHit: riskGeometry.shortTpHit,
    slHit: riskGeometry.shortSlHit,
    shortGrossR: riskGeometry.shortGrossR,
    shortCurrentR: riskGeometry.shortCurrentR,
    currentR: riskGeometry.shortCurrentR ?? action.currentR ?? null,

    learningAction: actionIsLearningVirtual(action),
    discordAlertEligible: Boolean(action.discordAlertEligible),
    selectedMicroFamilyAlert: false,
    selectedMicroMicroFamilyAlert: Boolean(action.selectedMicroMicroFamilyAlert || action.selectedExactMicroMicroMatch || action.discordAlertEligible),
    selectedExactMicroMicroMatch: Boolean(action.selectedExactMicroMicroMatch || action.selectedMicroMicroFamilyAlert),
    discordAlertSent: Boolean(action.discordAlertSent || action.discordEntryAlertSent)
  });
}

function buildActionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},
      actions: 0,
      learningActions: 0,
      virtualEntries: 0,
      virtualWaits: 0,
      virtualExits: 0,
      shadowExits: 0,
      discordEligibleActions: 0,
      selectedMicroMicroActions: 0,
      exactSelectedMicroMicroActions: 0,
      discordAlertsSent: 0,
      skippedNewEntries: null,
      reason: null,
      skipReason: null,
      ...modeFlags()
    };
  }

  const rawActions = Array.isArray(tradeMeta.actions)
    ? tradeMeta.actions
    : [];

  const rawShortActions = filterShortRows(rawActions);
  const allShortActions = rawShortActions.map(normalizeTradeAction);
  const learningActions = allShortActions.filter((row) => row.learningAction || row.virtualOnly);
  const longActionsIgnored = rawActions.filter(isLongRow).length;

  const entries = allShortActions.filter((row) => (
    row.action === 'ENTRY' ||
    row.action === 'VIRTUAL_ENTRY'
  ));

  const waits = allShortActions.filter((row) => row.action === 'WAIT');

  const exitArrays = [
    ...(Array.isArray(tradeMeta.exits) ? tradeMeta.exits : []),
    ...(Array.isArray(tradeMeta.virtualExits) ? tradeMeta.virtualExits : []),
    ...(Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []),
    ...(Array.isArray(tradeMeta.outcomes) ? tradeMeta.outcomes : [])
  ];

  const virtualExits = filterShortRows(exitArrays).map((row) => {
    const riskGeometry = getShortRiskGeometry(row);
    const microMicroFamilyId = getMicroMicroFamilyId(row);
    const trueMicroFamilyId = getTrueMicroFamilyId(row);
    const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row);

    return normalizeShortSide({
      ...row,
      source: row.source || 'VIRTUAL',
      outcomeSource: row.outcomeSource || 'VIRTUAL',
      virtualOnly: true,
      virtualTracked: true,
      learningOnly: true,
      realOrderPlaced: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,

      microMicroFamilyId,
      trueMicroMicroFamilyId: microMicroFamilyId,
      exactMicroMicroFamilyId: microMicroFamilyId,
      trueMicroFamilyId,
      childTrueMicroFamilyId: trueMicroFamilyId,
      parentTrueMicroFamilyId,

      validShortRiskShape: Boolean(riskGeometry.validGeometry),
      validShortGeometry: Boolean(riskGeometry.validGeometry),
      shortTpHit: riskGeometry.shortTpHit,
      shortSlHit: riskGeometry.shortSlHit,
      tpHit: riskGeometry.shortTpHit,
      slHit: riskGeometry.shortSlHit,
      shortGrossR: riskGeometry.shortGrossR,
      shortCurrentR: riskGeometry.shortCurrentR,
      netR: round(outcomeNetR(row), 4)
    });
  });

  const shadowExits = filterShortRows(
    Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []
  ).map((row) => {
    const riskGeometry = getShortRiskGeometry(row);
    const microMicroFamilyId = getMicroMicroFamilyId(row);
    const trueMicroFamilyId = getTrueMicroFamilyId(row);
    const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row);

    return normalizeShortSide({
      ...row,
      source: row.source || 'VIRTUAL',
      shadowOnly: true,
      virtualOnly: true,
      microMicroFamilyId,
      trueMicroMicroFamilyId: microMicroFamilyId,
      exactMicroMicroFamilyId: microMicroFamilyId,
      trueMicroFamilyId,
      childTrueMicroFamilyId: trueMicroFamilyId,
      parentTrueMicroFamilyId,
      validShortRiskShape: Boolean(riskGeometry.validGeometry),
      validShortGeometry: Boolean(riskGeometry.validGeometry),
      shortTpHit: riskGeometry.shortTpHit,
      shortSlHit: riskGeometry.shortSlHit,
      shortGrossR: riskGeometry.shortGrossR,
      shortCurrentR: riskGeometry.shortCurrentR,
      netR: round(outcomeNetR(row), 4)
    });
  });

  const discordEligibleActions = allShortActions.filter((row) => row.discordAlertEligible);
  const selectedMicroMicroActions = allShortActions.filter((row) => row.selectedMicroMicroFamilyAlert || row.selectedExactMicroMicroMatch);
  const exactSelectedMicroMicroActions = allShortActions.filter((row) => row.selectedExactMicroMicroMatch);
  const discordAlertsSent = allShortActions.filter((row) => row.discordAlertSent);

  const selectedMicroMicroIds = extractSelectedMicroMicroIds(tradeMeta, allShortActions);

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,

    runId: tradeMeta.runId || null,
    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

    ...modeFlags(),

    actionCounts: buildActionCounts(allShortActions),
    rawActionCounts: tradeMeta.actionCounts || buildActionCounts(rawActions),
    learningActionCounts: buildActionCounts(learningActions),

    actions: allShortActions.length,
    rawActions: rawActions.length,
    allShortActions: allShortActions.length,
    learningActions: learningActions.length,
    longActionsIgnored,

    virtualEntries: entries.length,
    virtualWaits: waits.length,
    virtualExits: virtualExits.length,
    shadowExits: shadowExits.length,

    entries: entries.length,
    waits: waits.length,
    exits: virtualExits.length,

    entryRows: entries.slice(0, MAX_DEBUG_ROWS),
    waitRows: waits.slice(0, MAX_DEBUG_ROWS),
    virtualCreatedRows: entries.slice(0, MAX_DEBUG_ROWS),
    virtualExitsRows: virtualExits.slice(0, MAX_DEBUG_ROWS),
    shadowExitsRows: shadowExits.slice(0, MAX_DEBUG_ROWS),

    discordEligibleActions: discordEligibleActions.length,
    selectedMicroMicroActions: selectedMicroMicroActions.length,
    exactSelectedMicroMicroActions: exactSelectedMicroMicroActions.length,
    discordAlertsSent: discordAlertsSent.length,

    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || tradeMeta.skipReason || null,
    skipReason: tradeMeta.skipReason || tradeMeta.reason || null,

    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroMicroFamilies: selectedMicroMicroIds.length,
    selectedMicroMicroFamilyIds: selectedMicroMicroIds,

    entriesSymbols: entries
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
      .slice(0, 20),

    exitSymbols: virtualExits
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
      .slice(0, 20)
  };
}

function normalizePosition(position = {}) {
  const riskGeometry = getShortRiskGeometry(position);

  const entry = riskGeometry.entry ?? num(position.entry ?? position.entryPrice, 0);
  const sl = riskGeometry.initialSl ?? num(position.sl ?? position.stopLoss ?? position.initialSl, 0);
  const tp = riskGeometry.tp ?? num(position.tp ?? position.takeProfit, 0);
  const initialSl = riskGeometry.initialSl ?? sl;
  const currentPrice = riskGeometry.currentPrice ?? num(position.currentPrice ?? position.lastPrice, 0);

  const microMicroFamilyId = getMicroMicroFamilyId(position);
  const trueMicroFamilyId = getTrueMicroFamilyId(position);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(position);

  return normalizeShortSide({
    ...position,

    source: position.source || 'VIRTUAL',

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,

    selectableMicroMicroFamily: Boolean(microMicroFamilyId),

    virtualOnly: true,
    virtualTracked: true,

    realOrderPlaced: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    entry,
    entryPrice: entry,
    sl,
    tp,
    initialSl,

    validShortRiskShape: Boolean(riskGeometry.validGeometry),
    validShortGeometry: Boolean(riskGeometry.validGeometry),

    currentPrice: currentPrice || null,
    lastPrice: currentPrice || null,

    ageSec: position.ageSec ?? null,
    currentR: position.currentR ?? riskGeometry.shortCurrentR,
    shortCurrentR: riskGeometry.shortCurrentR,
    shortGrossR: riskGeometry.shortGrossR,
    mfeR: position.mfeR ?? null,
    maeR: position.maeR ?? null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    reached1R: Boolean(position.reached1R || position.reachedOneR),
    reached125R: Boolean(position.reached125R),
    reached15R: Boolean(position.reached15R),
    reached175R: Boolean(position.reached175R),
    reached2R: Boolean(position.reached2R),

    nearTpSeen: Boolean(position.nearTpSeen),

    tpHit: riskGeometry.shortTpHit,
    slHit: riskGeometry.shortSlHit,
    shortTpHit: riskGeometry.shortTpHit,
    shortSlHit: riskGeometry.shortSlHit,

    tpExitArmed: Boolean(currentPrice > 0 && tp > 0 && currentPrice <= tp),
    slExitArmed: Boolean(currentPrice > 0 && initialSl > 0 && currentPrice >= initialSl),
    timeStopExitArmed: Boolean(position.timeStopExitArmed),

    selectedMicroFamily: false,
    selectedMicroMicroFamily: Boolean(
      position.selectedMicroMicroFamily ||
        position.selectedMicroMicroFamilyAlert ||
        position.selectedExactMicroMicroMatch
    ),
    discordAlertEligible: Boolean(position.discordAlertEligible),
    selectedMicroFamilyAlert: false,
    selectedMicroMicroFamilyAlert: Boolean(position.selectedMicroMicroFamilyAlert || position.selectedExactMicroMicroMatch),
    exactSelectedMicroMicroMatch: Boolean(position.selectedExactMicroMicroMatch || position.selectedMicroMicroFamilyAlert),
    discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
    discordExitAlertSent: Boolean(position.discordExitAlertSent)
  });
}

function buildPositionSummary(rawPositions = []) {
  const positions = filterShortRows(rawPositions).map(normalizePosition);
  const ignoredLongPositions = rawPositions.filter(isLongRow).length;
  const unknownPositions = rawPositions.filter((row) => inferTradeSide(row) === 'UNKNOWN').length;

  return {
    positions: positions.slice(0, MAX_ROWS),
    positionsCount: positions.length,
    rawPositionsCount: rawPositions.length,
    ignoredLongPositions,
    unknownPositions,
    ignoredUnknownPositions: unknownPositions,

    virtualPositions: positions.length,
    selectedPositions: positions.filter((row) => row.selectedMicroMicroFamily || row.selectedMicroMicroFamilyAlert).length,
    exactSelectedMicroMicroPositions: positions.filter((row) => row.exactSelectedMicroMicroMatch).length,
    discordEntryAlertSentPositions: positions.filter((row) => row.discordEntryAlertSent).length,
    discordExitAlertEligiblePositions: positions.filter((row) => row.discordExitAlertEligible).length
  };
}

function normalizeDiscordLog(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  const microMicroFamilyId =
    getMicroMicroFamilyId(row) ||
    getMicroMicroFamilyId(payload) ||
    getMicroMicroFamilyId(result);

  const trueMicroFamilyId =
    getTrueMicroFamilyId(row) ||
    getTrueMicroFamilyId(payload) ||
    getTrueMicroFamilyId(result);

  const parentTrueMicroFamilyId =
    getParentTrueMicroFamilyId(row) ||
    getParentTrueMicroFamilyId(payload) ||
    getParentTrueMicroFamilyId(result);

  const selectedMicroMicroFamilyId = normalizeMicroMicroFamilyId(
    row.selectedMicroMicroFamilyId ||
      payload.selectedMicroMicroFamilyId ||
      result.selectedMicroMicroFamilyId ||
      row.selectedTrueMicroMicroFamilyId ||
      payload.selectedTrueMicroMicroFamilyId ||
      result.selectedTrueMicroMicroFamilyId ||
      row.selectedExactMicroMicroFamilyId ||
      payload.selectedExactMicroMicroFamilyId ||
      result.selectedExactMicroMicroFamilyId ||
      ''
  );

  const rawInferredTradeSide = inferTradeSide({
    ...row,
    ...payload,
    ...result,
    microMicroFamilyId,
    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId
  });

  const selectedMicroMicroFamilyAlert = Boolean(
    row.selectedMicroMicroFamilyAlert ||
      payload.selectedMicroMicroFamilyAlert ||
      result.selectedMicroMicroFamilyAlert ||
      row.selectedExactMicroMicroMatch ||
      payload.selectedExactMicroMicroMatch ||
      result.selectedExactMicroMicroMatch ||
      row.alertAllowed ||
      payload.alertAllowed ||
      result.alertAllowed
  );

  const discordAlertEligible = Boolean(
    row.discordAlertEligible ||
      payload.discordAlertEligible ||
      result.discordAlertEligible
  );

  const exactSelectedMicroMicroMatch = Boolean(
    microMicroFamilyId &&
      isSelectableMicroMicroId(microMicroFamilyId) &&
      selectedMicroMicroFamilyAlert &&
      (
        !selectedMicroMicroFamilyId ||
        selectedMicroMicroFamilyId === microMicroFamilyId
      )
  );

  const alertAllowed = exactSelectedMicroMicroMatch;

  return {
    ...safeRow(row, { includeSmallArrays: false, includeSmallObjects: false }),
    payload: safeCompact(payload, 1),
    result: safeCompact(result, 1),

    ...modeFlags(),

    type: row.type || payload.type || result.type || row.level || payload.level || 'UNKNOWN',

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide,

    symbol:
      row.symbol ||
      payload.symbol ||
      payload.contractSymbol ||
      result.symbol ||
      result.contractSymbol ||
      null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,

    familyId:
      parentTrueMicroFamilyId ||
      row.familyId ||
      payload.familyId ||
      result.familyId ||
      null,

    discordAlertEligible,
    selectedMicroFamilyAlert: false,
    selectedMicroMicroFamilyAlert,

    selectedMicroMicroFamilyId: selectedMicroMicroFamilyId || null,
    selectedTrueMicroMicroFamilyId: selectedMicroMicroFamilyId || null,
    selectedExactMicroMicroFamilyId: selectedMicroMicroFamilyId || null,

    exactSelectedTrueMicroMatch: false,
    exactSelectedMicroMicroMatch,

    selectedOnly: alertAllowed,

    manualSelectionRequired: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    alertAllowed,
    blockedByManualSelection: discordAlertEligible && !alertAllowed,
    policyViolation: Boolean((row.sent || payload.sent || result.sent || result.ok === true) && !alertAllowed),

    sent: Boolean(
      row.sent ||
        payload.sent ||
        result.sent ||
        result.ok === true
    ),

    failed: Boolean(
      row.failed ||
        payload.failed ||
        result.failed ||
        result.ok === false
    ),

    skipped: Boolean(
      row.skipped ||
        payload.skipped ||
        result.skipped
    ),

    source:
      row.source ||
      payload.source ||
      result.source ||
      null,

    ts:
      row.ts ||
      row.createdAt ||
      payload.ts ||
      payload.createdAt ||
      result.ts ||
      result.createdAt ||
      null
  };
}

function summarizeDiscordLogs(logs = []) {
  const normalized = logs
    .map(normalizeDiscordLog)
    .filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
    .filter((log) => !log.microMicroFamilyId || isSelectableMicroMicroId(log.microMicroFamilyId));

  return normalized.reduce((acc, log) => {
    const type = upper(log.type || 'UNKNOWN');

    acc.total += 1;
    acc.byType[type] = (acc.byType[type] || 0) + 1;

    if (log.discordAlertEligible) acc.eligible += 1;
    if (log.selectedOnly || log.alertAllowed) acc.selectedOnly += 1;
    if (log.exactSelectedMicroMicroMatch) acc.exactSelectedMicroMicroMatch += 1;
    if (log.sent) acc.sent += 1;
    if (log.failed) acc.failed += 1;
    if (log.skipped) acc.skipped += 1;
    if (log.policyViolation) acc.policyViolations += 1;
    if (log.blockedByManualSelection) acc.blockedByManualSelection += 1;

    return acc;
  }, {
    total: 0,
    eligible: 0,
    selectedOnly: 0,
    exactSelectedMicroMicroMatch: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    policyViolations: 0,
    blockedByManualSelection: 0,
    byType: {}
  });
}

function buildTaxonomySummary(micros = {}, activeMicroMicroFamilyIds = []) {
  const activeSet = new Set(activeMicroMicroFamilyIds || []);

  const rows = sourceEntries(micros)
    .map(([key, row]) => normalizeMicroMicroRow(row, key))
    .filter((row) => row.microMicroFamilyId && isSelectableMicroMicroId(row.microMicroFamilyId));

  const completedMicroMicro = rows.filter((row) => getOutcomeSample(row) > 0);
  const activeMicroMicro = rows.filter((row) => getOutcomeSample(row) >= MIN_COMPLETED_MICRO_MICRO_ACTIVE);
  const observingMicroMicro = rows.filter((row) => getOutcomeSample(row) === 0 && getObservationSample(row) > 0);

  return {
    ...modeFlags(),

    parentFamiliesTotal: 15,
    child75FamiliesTotal: 75,
    selectableMicroMicroFamiliesTotal: 'dynamic hash context layer',

    visibleMicroMicroRows: rows.length,
    microMicroRowsWithCompleted: completedMicroMicro.length,
    microMicroRowsActiveLearning: activeMicroMicro.length,
    microMicroRowsObserving: observingMicroMicro.length,

    activeSelectedMicroMicroFamilies: activeSet.size,

    setupCount: SETUP_ORDER.length,
    regimeCount: REGIME_ORDER.length,
    confirmationProfileCount: CONFIRMATION_PROFILE_ORDER.length,

    setups: SETUP_ORDER,
    regimes: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER
  };
}

function compactTradeMeta(tradeMeta = null) {
  if (!tradeMeta || typeof tradeMeta !== 'object') return null;

  return {
    ...safeRow(tradeMeta, { includeSmallArrays: false, includeSmallObjects: false }),
    actions: [],
    virtualActions: [],
    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    exits: [],
    realExits: [],
    currentMarketUniverse: null,
    currentMarketWeather: safeCompact(tradeMeta.currentMarketWeather, 1),
    marketContext: safeCompact(tradeMeta.marketContext, 1),
    compactedForAdminOverview: true
  };
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value
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

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Overview-Mode', 'short-only-micro-micro-safe-direct-redis-v4');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Micro-Micro-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-GetWeekMicros-Disabled', 'true');
  res.setHeader('X-GetRotationDashboard-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const weekKey = PERSISTENT_LEARNING_KEY;
    const currentWeekKey = PERSISTENT_LEARNING_KEY;
    const previousWeekKey = PERSISTENT_LEARNING_KEY;

    const [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      directMicrosRead,
      directRotationRead,
      marketRead,
      discordLogsRead
    ] = await Promise.all([
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
        'tradeMeta',
        () => readJsonFromStores({
          durable,
          volatile,
          key: SHORT_KEYS.trade.runMeta,
          fallback: null
        }).then((row) => row.value),
        null
      ),

      safeRead(
        'openPositions',
        () => getOpenPositions({
          tradeSide: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          namespace: SHORT_NAMESPACE,
          keyPrefix: SHORT_KEY_PREFIX,
          virtualOnly: true
        }),
        []
      ),

      safeRead(
        'directPersistentLearningMicros',
        () => readDirectMicros({ durable, volatile }),
        {
          micros: {},
          sourceKey: null,
          source: null,
          stats: {
            totalRows: 0,
            microMicroRows: 0,
            child75Rows: 0,
            parent15Rows: 0,
            score: 0
          },
          triedKeys: []
        }
      ),

      safeRead(
        'directRotationDashboard',
        () => readDirectRotation({ durable, volatile }),
        {
          active: null,
          next: null,
          activeRows: [],
          nextRows: [],
          sourceKey: null,
          source: null,
          triedKeys: []
        }
      ),

      safeRead(
        'marketWeather',
        () => readDirectMarket({ durable, volatile }),
        {
          available: false,
          regime: null,
          trendSide: null,
          bullishPct: null,
          bearishPct: null,
          squeezePct: null,
          confidence: null,
          ageSec: null,
          ageText: null
        }
      ),

      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, SHORT_KEYS.discord.logList, 10),
        []
      )
    ]);

    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);

    const rawPositions = asArray(positionsRead.value);
    const positionSummary = buildPositionSummary(rawPositions);

    const currentMicros = directMicrosRead.value?.micros || {};
    const previousMicros = {};
    const hiddenRows = summarizeHiddenRows(currentMicros);

    const selectedFromTrade = extractSelectedMicroMicroIds(tradeMeta, tradeSummary);
    const rotationDashboard = compactRotationDashboard(directRotationRead.value || {}, selectedFromTrade);

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const activeMicroMicroFamilyIds = activeRotation?.selectedMicroMicroFamilyIds ||
      rotationDashboard.activeMicroMicroFamilyIds ||
      [];

    const activeMacroFamilyIds = activeRotation?.macroFamilyIds || [];

    const currentMicroSummary = summarizeMicroMicroRows(currentMicros);
    const previousMicroSummary = summarizeMicroMicroRows(previousMicros);
    const taxonomySummary = buildTaxonomySummary(currentMicros, activeMicroMicroFamilyIds);

    const rawDiscordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const discordLogs = rawDiscordLogs
      .map(normalizeDiscordLog)
      .filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
      .filter((log) => !log.microMicroFamilyId || isSelectableMicroMicroId(log.microMicroFamilyId))
      .map((log) => normalizeShortSide(log))
      .slice(0, MAX_DEBUG_ROWS);

    const warnings = [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      directMicrosRead,
      directRotationRead,
      marketRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    const longIgnored = {
      positions: positionSummary.ignoredLongPositions,
      currentWeekMicroFamilies: hiddenRows.longRowsIgnored,
      previousWeekMicroFamilies: 0,
      scannerCandidates: latestScan?.longCandidatesIgnored || 0,
      tradeActions: tradeSummary.longActionsIgnored || 0,
      discordLogs: rawDiscordLogs.filter((row) => inferTradeSide(normalizeDiscordLog(row)) === OPPOSITE_TRADE_SIDE).length,
      activeRotationRows: activeRotation?.longMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.longMicroFamiliesIgnored || 0
    };

    const selectedDiscordMicroMicroIds = uniqueStrings([
      activeMicroMicroFamilyIds,
      selectedFromTrade
    ]).filter(isSelectableMicroMicroId);

    const visibleMicroMicroRows = currentMicroSummary.visibleMicroMicroRows || 0;
    const cleanMeasurementRows = currentMicroSummary.cleanMeasurementRows || 0;
    const completedTotal = currentMicroSummary.completed || 0;

    return res.status(200).json({
      ok: true,

      side: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,

      ...modeFlags(),

      versions: versions(),

      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,

      requestedLearningKey: PERSISTENT_LEARNING_KEY,
      activeLearningStoreKey: directMicrosRead.value?.sourceKey ||
        `${SHORT_KEY_PREFIX}ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`,

      weekResetDisabled: true,
      isoWeekLearningDisabled: true,
      previousWeekComparisonDisabled: true,

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLatest: SHORT_KEYS.scan.latest,
        tradeRunMeta: SHORT_KEYS.trade.runMeta,
        analyzeMicros: SHORT_KEYS.analyze.micros,
        rotationDashboard: SHORT_KEYS.rotation.dashboard,
        rotationActive: SHORT_KEYS.rotation.active,
        discordLogList: SHORT_KEYS.discord.logList,
        marketWeather: SHORT_MARKET_WEATHER_KEY,
        marketUniverse: SHORT_MARKET_UNIVERSE_KEY
      },

      dataSources: {
        microsSource: directMicrosRead.value?.source || null,
        microsSourceKey: directMicrosRead.value?.sourceKey || null,
        microsTriedKeys: directMicrosRead.value?.triedKeys || [],

        rotationSource: directRotationRead.value?.source || null,
        rotationSourceKey: directRotationRead.value?.sourceKey || null,
        rotationTriedKeys: directRotationRead.value?.triedKeys || []
      },

      taxonomy: {
        parentCount: 15,
        child75Count: 75,
        microMicroCount: 'dynamic',
        setups: SETUP_ORDER,
        regimes: REGIME_ORDER,
        confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
        parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
        child75Format: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
        microMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
        uiShowsOnlyMicroMicro: true,
        uiAllowsOnlyMicroMicroSelection: true,
        child75RowsHidden: true,
        parent15RowsHidden: true
      },

      taxonomySummary,

      counts: {
        visibleMicroMicroRows,
        cleanMeasurementRows,
        legacyMeasurementRows: Math.max(0, visibleMicroMicroRows - cleanMeasurementRows),

        selectedDiscordMicroMicroIds: selectedDiscordMicroMicroIds.length,

        hiddenChild75Rows: hiddenRows.child75RowsHidden,
        hiddenParent15Rows: hiddenRows.parentRowsHidden,

        scannerFingerprintRowsHidden: hiddenRows.scannerFingerprintRowsHidden,
        executionFingerprintRowsHidden: hiddenRows.executionFingerprintRowsHidden,

        openVirtualPositions: positionSummary.positionsCount,
        scannerShortCandidates: latestScan?.shortCandidatesCount || latestScan?.candidatesCount || 0,

        sourceMicrosTotalRows: directMicrosRead.value?.stats?.totalRows || 0,
        sourceMicroMicroRows: directMicrosRead.value?.stats?.microMicroRows || 0,
        sourceChild75Rows: directMicrosRead.value?.stats?.child75Rows || 0,
        sourceParent15Rows: directMicrosRead.value?.stats?.parent15Rows || 0
      },

      learningStatus: {
        microMicroObserving: currentMicroSummary.statusCounts?.MICRO_MICRO_OBSERVING || 0,
        microMicroEarly: currentMicroSummary.statusCounts?.MICRO_MICRO_EARLY || 0,
        microMicroActive: currentMicroSummary.statusCounts?.MICRO_MICRO_ACTIVE || 0,
        microMicroActiveThreshold: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
        child75PrimaryThresholdBackend: MIN_COMPLETED_ACTIVE_LEARNING
      },

      quality: {
        avgR: currentMicroSummary.avgR || 0,
        totalR: currentMicroSummary.totalR || 0,
        avgCostR: currentMicroSummary.avgCostR || 0,
        avgDirectSLPct: currentMicroSummary.avgDirectSLPct || 0,
        scoring: 'netR after costs',
        completedDefinition: 'closed virtual/shadow outcomes only',
        seenDefinition: 'unique observation dedupe key',
        cleanMeasurementRequiredForPrimaryRanking: true,
        completed: completedTotal
      },

      selectedDiscordMicroMicroIds,

      market: marketRead.value || {
        available: false,
        regime: null,
        trendSide: null,
        bullishPct: null,
        bearishPct: null,
        squeezePct: null,
        confidence: null,
        ageText: null
      },

      rules: {
        uiShowsOnlyMicroMicro: true,
        uiAllowsOnlyMicroMicroSelection: true,

        scannerFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsCanDeriveMicroMicroContextHash: true,

        learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

        discordMatch: 'candidate.microMicroFamilyId === selectedMicroMicroFamilyId',
        child75MatchTriggersDiscord: false,
        parent15MatchTriggersDiscord: false,
        scannerMatchTriggersDiscord: false,

        currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
        currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
        currentFitBlocksLearning: false,
        currentFitCanBlockDiscord: true,

        realOrdersDisabled: true
      },

      microMicroPolicy: {
        enabled: true,
        onlySelectableLayerInAdmin: true,
        base75ChildRemainsPrimaryLearningLayerInBackend: true,
        parent15RemainsRollupContextInBackend: true,
        microMicroSelectable: true,
        minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
        acceptedFormats: [
          'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH_OR_CONTEXT}',
          'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}'
        ]
      },

      shortRisk: {
        side: TARGET_TRADE_SIDE,
        riskGeometryRule: 'tp < entry < sl',
        tpHitRule: 'candle.low <= tp',
        slHitRule: 'candle.high >= sl',
        sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
        monitorRule: '1m candle range since last check; range result wins over current price',
        grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
        currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
        defaultPositionTimeStopMin: 720
      },

      latestScan,
      latestScannerSnapshotId: latestScan?.snapshotId || null,

      scannerCandidates: latestScan?.candidatesCount || 0,
      shortScannerCandidates: latestScan?.shortCandidatesCount || latestScan?.candidatesCount || 0,

      tradeMeta: compactTradeMeta(tradeMeta),
      tradeSummary,

      runMeta: compactTradeMeta(tradeMeta),
      latestRunMeta: tradeMeta
        ? {
            runId: tradeMeta.runId || null,
            shadowExits: [],
            virtualExits: [],
            actionCounts: tradeSummary.actionCounts || {},
            skipReason: tradeSummary.skipReason || null,
            selectedMicroMicroFamilyIds: tradeSummary.selectedMicroMicroFamilyIds || []
          }
        : null,

      openPositions: positionSummary.positionsCount,
      positionsCount: positionSummary.positionsCount,
      rawPositionsCount: positionSummary.rawPositionsCount,

      virtualPositions: positionSummary.virtualPositions,
      selectedPositions: positionSummary.selectedPositions,
      exactSelectedMicroMicroPositions: positionSummary.exactSelectedMicroMicroPositions,

      ignoredLongPositions: positionSummary.ignoredLongPositions,
      ignoredUnknownPositions: positionSummary.ignoredUnknownPositions,
      unknownPositions: positionSummary.unknownPositions,

      positions: positionSummary.positions,

      currentWeekMicroFamilies: currentMicroSummary.rows,
      previousWeekMicroFamilies: previousMicroSummary.rows,

      persistentMicroFamilies: currentMicroSummary.rows,
      persistentMicroSummary: currentMicroSummary,

      currentMicroSummary,
      previousMicroSummary,

      observingMicroFamilies: currentMicroSummary.observationOnlyFamilies,
      completedMicroFamilies: currentMicroSummary.completedFamilies,
      activeLearningMicroFamilies: currentMicroSummary.activeLearningFamilies,
      earlyOutcomeMicroFamilies: currentMicroSummary.earlyOutcomeFamilies,

      visibleMicroMicroRows: currentMicroSummary.rowsList,

      activeRotation,
      nextRotation,

      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,

      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,

      activeMicroFamilyIds: [],
      nextMicroFamilyIds: [],

      activeMicroMicroFamilyIds,
      selectedMicroMicroFamilyIds: selectedDiscordMicroMicroIds,
      nextMicroMicroFamilyIds: nextRotation?.selectedMicroMicroFamilyIds || [],

      activeMacroFamilyIds,
      nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],

      bestShort: activeRotation?.bestShort || null,
      bestLong: null,
      nextBestShort: nextRotation?.bestShort || null,
      nextBestLong: null,

      rotationDashboard,

      discordLogs,
      discordSummary: summarizeDiscordLogs(discordLogs),

      hiddenMetadataRows: {
        parentRowsHidden: hiddenRows.parentRowsHidden,
        child75RowsHidden: hiddenRows.child75RowsHidden,
        scannerFingerprintRowsHidden: hiddenRows.scannerFingerprintRowsHidden,
        executionFingerprintRowsHidden: hiddenRows.executionFingerprintRowsHidden
      },

      longIgnored,
      warnings,

      error: null,

      omitted: {
        fullRawOverview: true,
        child75RowsHidden: true,
        parent15RowsHidden: true,
        fullPositionObjects: true,
        verboseDebugFields: true,
        reason: 'COMPACT_OVERVIEW_OUTPUT_MICRO_MICRO_ONLY'
      },

      perf: {
        durationMs: now() - startedAt,
        source: 'short_only_micro_micro_safe_direct_redis_overview'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}