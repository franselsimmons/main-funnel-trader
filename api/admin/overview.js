// ================= FILE: api/admin/overview.js =================

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
import {
  normalizeMarketWeatherRegime,
  normalizeMarketWeatherTrendSide,
  buildEntryMarketWeatherKey,
  confirmMarketWeatherKey,
  isFreshConfirmedMarketWeather
} from '../../src/market/marketKey.js';

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
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_AGGREGATION_VERSION =
  'SHORT_MARKET_WEATHER_AGGREGATION_V1_REGIME_REGIMETREND';
const MARKET_WEATHER_SELECTOR_VERSION =
  'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V2_CONFIRMED_WEATHER_SINGLE_SOURCE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V2_CONFIRMED_WEATHER_SINGLE_SOURCE';
const MARKET_WEATHER_FDR_VERSION =
  'SHORT_MARKET_WEATHER_PLAYBOOK_FDR_FINAL_SLOTS_V1_OBSERVE';

const EMPIRICAL_VETO_VERSION = 'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V1';
const ADMIN_OVERVIEW_VERSION =
  'SHORT_ADMIN_OVERVIEW_MARKETWEATHER_MICRO_MICRO_V3_CONFIRMED_PLAYBOOK_WEATHER_FIXED';

const MICRO_MICRO_MARKER = '_MM_';
const MICRO_MICRO_HASH_LEN = 10;

const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const PLAYBOOK_MAX_AGE_MIN = 240;

const MAX_ROWS = 160;
const MAX_DEBUG_ROWS = 60;
const MAX_DISCOVERED_KEYS = 50;
const MAX_ARRAY_COMPACT = 50;
const MAX_OBJECT_KEYS_COMPACT = 90;

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_MICRO_MICRO_MARKET = 'MICRO_MICRO_MARKET_PROOF';
const PROOF_TIER_MICRO_MICRO_LIFETIME = 'MICRO_MICRO_LIFETIME_PROOF';
const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';

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

const SHORT_MARKET_WEATHER_KEYS = [
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:CONFIRMED`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER:CONFIRMED`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET_WEATHER`
];

const SHORT_MARKET_UNIVERSE_KEYS = [
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE`,
  `${SHORT_KEY_PREFIX}MARKET_UNIVERSE:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET_UNIVERSE:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET_UNIVERSE`
];

const SHORT_PLAYBOOK_KEYS = [
  `${SHORT_KEY_PREFIX}PLAYBOOK:CURRENT_MARKET`,
  `${SHORT_KEY_PREFIX}PLAYBOOK:CURRENT`,
  `${SHORT_KEY_PREFIX}CURRENT_MARKET:PLAYBOOK`,
  `${SHORT_KEY_PREFIX}ROTATION:CURRENT_MARKET_PLAYBOOK`,
  `${SHORT_KEY_PREFIX}WEEKLY:CANDIDATES:CURRENT_MARKET`
];

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : 0;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function ageMin(ts, nowMs = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, (nowMs - n) / 60000);
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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value.split(/[\s,;\n\r]+/g).map((part) => part.trim());
        }

        return [value];
      })
      .map((part) => String(part || '').trim())
      .filter(Boolean)
  )];
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
    const output = value
      .slice(0, MAX_ARRAY_COMPACT)
      .map((item) => safeCompact(item, depth - 1, seen));

    seen.delete(value);
    return output;
  }

  const output = {};
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
      if (Array.isArray(val)) output[`${key}Count`] = val.length;
      else if (val && typeof val === 'object') output[`${key}Omitted`] = true;
      else output[key] = val;
      continue;
    }

    output[key] = safeCompact(val, depth - 1, seen);
  }

  seen.delete(value);
  return output;
}

function safeRow(row = {}, options = {}) {
  const {
    includeSmallArrays = true,
    includeSmallObjects = false
  } = options;

  if (!row || typeof row !== 'object') return {};

  const output = {};

  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      output[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      if (includeSmallArrays) {
        output[key] = value
          .slice(0, 20)
          .map((item) => item && typeof item === 'object' ? safeCompact(item, 1) : item);
      } else {
        output[`${key}Count`] = value.length;
      }

      continue;
    }

    if (includeSmallObjects) {
      output[key] = safeCompact(value, 1);
    } else if (
      [
        'currentMarketWeather',
        'entryMarketWeather',
        'discordCurrentFitGate',
        'virtualGate',
        'qualityAudit',
        'selectedWeeklyStats',
        'weeklyStats',
        'riskDecision',
        'marketWeather'
      ].includes(key)
    ) {
      output[key] = safeCompact(value, 1);
    } else {
      output[`${key}Omitted`] = true;
    }
  }

  return output;
}

function featureFlags() {
  return {
    version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
    capture: 'live',
    aggregation: 'live',
    selector: 'observe',
    sizingCap: 'observe',
    fdr: 'observe',
    discordTradeReady: 'validated_only',
    unknownWeatherOverrideBlocked: true,
    currentMarketPlaybookUsesConfirmedOverviewWeather: true,
    playbookUnknownWeatherCannotOverrideConfirmedWeather: true,
    partialEntryWeatherRepairInOverview: true
  };
}

function versions() {
  return {
    overviewVersion: ADMIN_OVERVIEW_VERSION,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    child75TrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
  };
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
    marketWeatherExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactMicroMicroOnly: true,
    exactMicroMicroFamilyRequired: true,

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
    learningGranularity: CHILD75_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
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
    parentMatchDoesNotTriggerDiscord: false,
    macroMatchDoesNotTriggerDiscord: false,
    micro75MatchDoesNotTriggerDiscord: false,

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherFeatureFlags: featureFlags(),
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,

    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    unknownWeatherNeverTradeReady: true,
    requestMarketWeatherOverrideAllowedWhenKnown: true,
    unknownRequestMarketWeatherOverrideBlocked: true,
    currentMarketPlaybookUsesConfirmedOverviewWeather: true,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoRule: `exact micro-micro completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} && standalone lifetime LCB95(avgR) < 0`,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    safeDirectRedisOverview: true,
    getWeekMicrosDisabledInOverview: true,
    getRotationDashboardDisabledInOverview: true,
    stackSafeCompactionEnabled: true
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

  return { ok: false, setup: null, regime: null, confirmationProfile: null, rest: '' };
}

function normalizeMicroMicroHash(value = '') {
  const raw = upper(value).replace(/[^A-Z0-9]/g, '');
  return raw.length >= 3 ? raw.slice(0, MICRO_MICRO_HASH_LEN) : '';
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
        const microMicroFamilyId = `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`;

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

  if (!value) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  if (value.startsWith(`MM_${TARGET_TRADE_SIDE}_`)) {
    return parseLegacyMicroMicroId(value);
  }

  if (value.includes('MICRO_LONG_') || value.startsWith('MM_LONG_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId,
      reason: 'LONG_DISABLED_SHORT_ONLY'
    };
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

  let body = value.slice('MICRO_SHORT_'.length);
  let explicitMicroMicro = false;
  let canonicalMicroMicroSyntax = false;
  let context = '';

  const markerIndex = body.lastIndexOf(MICRO_MICRO_MARKER);

  if (markerIndex > -1) {
    explicitMicroMicro = true;
    canonicalMicroMicroSyntax = true;
    context = body.slice(markerIndex + MICRO_MICRO_MARKER.length);
    body = body.slice(0, markerIndex);
  }

  const parsed = parseBodySetupRegimeConfirmation(body);

  if (!parsed.ok) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId,
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
      ? normalizeMicroMicroHash(context)
      : normalizeMicroMicroHash(context || parsed.rest) || hashText(value, MICRO_MICRO_HASH_LEN)
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
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : isChild ? CHILD_TRUE_MICRO_SCHEMA : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : isChild ? CHILD_TRUE_MICRO_SCHEMA : PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isChild
        ? CHILD75_LEARNING_GRANULARITY
        : PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
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

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  if (parseShortTaxonomyMicroId(value).isMicroMicro) return false;

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

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function isSelectableMicroMicroId(id = '') {
  const value = String(id || '').trim();
  if (!validLearningId(value)) return false;

  const parsed = parseShortTaxonomyMicroId(value);
  return parsed.valid === true && parsed.selectable === true && parsed.isMicroMicro === true;
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

    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) return direct;

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

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
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

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

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

function getMicroMicroFamilyId(row = {}, key = '') {
  const candidates = [
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
    row.base75ChildTrueMicroFamilyId,
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
    const parsed = parseShortTaxonomyMicroId(id);

    if (parsed.isParent && parsed.parentTrueMicroFamilyId) return parsed.parentTrueMicroFamilyId;
  }

  return null;
}

function filterShortRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .filter(isShortRow);
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

  if (value && typeof value === 'object') return Object.entries(value);

  return [];
}

function normalizeWeatherTrendSideStrict(value) {
  const normalized = normalizeMarketWeatherTrendSide(value);

  if (normalized === 'BEARISH') return 'BEARISH';
  if (normalized === 'BULLISH') return 'BULLISH';
  if (normalized === 'NEUTRAL') return 'NEUTRAL';

  const side = normalizeSideToken(value);

  if (side === TARGET_TRADE_SIDE) return 'BEARISH';
  if (side === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  const text = upper(value);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'RED'].includes(text)) return 'BEARISH';
  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'GREEN'].includes(text)) return 'BULLISH';

  return 'UNKNOWN';
}

function buildWeatherKeyFromParts(regimeInput, trendInput) {
  const regime = normalizeMarketWeatherRegime(regimeInput);
  const trendSide = normalizeWeatherTrendSideStrict(trendInput);

  if (regime === 'UNKNOWN' || trendSide === 'UNKNOWN') {
    return {
      key: `${regime || 'UNKNOWN'}|${trendSide || 'UNKNOWN'}`,
      regime: regime || 'UNKNOWN',
      trendSide: trendSide || 'UNKNOWN',
      known: false
    };
  }

  let key = `${regime}|${trendSide}`;

  try {
    const built = buildEntryMarketWeatherKey(regime, trendSide);
    if (typeof built === 'string' && built.includes('|')) key = upper(built);
  } catch {
    key = `${regime}|${trendSide}`;
  }

  return {
    key,
    regime,
    trendSide,
    known: true
  };
}

function parseMarketWeatherKeyLoose(input = {}) {
  if (typeof input === 'string') {
    const raw = upper(input);

    if (!raw || raw === '[OBJECT OBJECT]' || raw.includes('[OBJECT OBJECT]')) {
      return {
        key: 'UNKNOWN|UNKNOWN',
        regime: 'UNKNOWN',
        trendSide: 'UNKNOWN',
        known: false
      };
    }

    if (raw.includes('|')) {
      const [regimeRaw, trendRaw] = raw.split('|');
      return buildWeatherKeyFromParts(regimeRaw, trendRaw);
    }

    return {
      key: 'UNKNOWN|UNKNOWN',
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      known: false
    };
  }

  if (!input || typeof input !== 'object') {
    return {
      key: 'UNKNOWN|UNKNOWN',
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      known: false
    };
  }

  const direct = firstValue(
    input.entryMarketWeatherKey,
    input.confirmedMarketWeatherKey,
    input.currentMarketWeatherKey,
    input.marketWeatherKey,
    input.weatherKey,
    input.key
  );

  if (typeof direct === 'string' && direct.includes('|')) {
    const parsedDirect = parseMarketWeatherKeyLoose(direct);
    if (parsedDirect.known) return parsedDirect;
  }

  return buildWeatherKeyFromParts(
    firstValue(
      input.entryMarketWeatherRegime,
      input.confirmedMarketWeatherRegime,
      input.currentMarketWeatherRegime,
      input.marketWeatherRegime,
      input.currentRegime,
      input.regime,
      input.marketRegime,
      input.breadthRegime,
      input.volatilityRegime
    ),
    firstValue(
      input.entryMarketWeatherTrendSide,
      input.confirmedMarketWeatherTrendSide,
      input.currentMarketWeatherTrendSide,
      input.marketWeatherTrendSide,
      input.currentTrendSide,
      input.trendSide,
      input.marketTrendSide,
      input.marketSide,
      input.side,
      input.direction,
      input.bias,
      input.marketBias
    )
  );
}

function isKnownMarketWeatherKey(key = '') {
  return parseMarketWeatherKeyLoose(key).known === true;
}

function safeBuildMarketWeatherKey(input = {}) {
  return parseMarketWeatherKeyLoose(input).key || 'UNKNOWN|UNKNOWN';
}

function marketWeatherTimestamp(raw = {}) {
  return firstFinite(
    raw.confirmedMarketWeatherUpdatedAt,
    raw.currentMarketWeatherUpdatedAt,
    raw.marketWeatherUpdatedAt,
    raw.updatedAt,
    raw.generatedAt,
    raw.createdAt,
    raw.completedAt,
    raw.savedAt,
    raw.loadedAt,
    raw.ts
  );
}

function buildCurrentWeatherFromRaw(raw = {}, extra = {}) {
  const parsed = parseMarketWeatherKeyLoose(raw);
  const updatedAt = marketWeatherTimestamp(raw) || (parsed.known ? Date.now() : null);

  let confirmedKey = parsed.key;

  try {
    const confirmed = confirmMarketWeatherKey({
      currentMarketWeatherKey: parsed.key,
      currentMarketWeatherRegime: parsed.regime,
      currentMarketWeatherTrendSide: parsed.trendSide,
      previousConfirmedMarketWeatherKey: raw.previousConfirmedMarketWeatherKey || raw.confirmedMarketWeatherKey,
      updatedAt
    });

    if (confirmed?.confirmedMarketWeatherKey) confirmedKey = confirmed.confirmedMarketWeatherKey;
    else if (typeof confirmed === 'string') confirmedKey = confirmed;
  } catch {
    confirmedKey = parsed.key;
  }

  const confirmedParsed = parseMarketWeatherKeyLoose(confirmedKey);

  let fresh = false;

  try {
    fresh = isFreshConfirmedMarketWeather(
      {
        confirmedMarketWeatherKey: confirmedParsed.key,
        confirmedMarketWeatherRegime: confirmedParsed.regime,
        confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
        confirmedMarketWeatherUpdatedAt: updatedAt,
        updatedAt
      },
      {
        maxAgeMin: PLAYBOOK_MAX_AGE_MIN
      }
    ) === true;
  } catch {
    const age = ageMin(updatedAt);
    fresh = confirmedParsed.known && age !== null && age <= PLAYBOOK_MAX_AGE_MIN;
  }

  return {
    currentMarketWeatherKey: parsed.key,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: parsed.regime,
    currentMarketWeatherTrendSide: parsed.trendSide,
    currentMarketWeatherKnown: parsed.known,

    confirmedMarketWeatherKey: confirmedParsed.key,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherRegime: confirmedParsed.regime,
    confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
    confirmedMarketWeatherKnown: confirmedParsed.known,

    confirmedMarketWeatherUpdatedAt: updatedAt || null,
    currentMarketWeatherUpdatedAt: updatedAt || null,
    confirmedMarketWeatherAgeMin: ageMin(updatedAt),
    confirmedMarketWeatherFresh: fresh,

    reason: confirmedParsed.known ? 'CONFIRMED_MARKET_WEATHER_AVAILABLE' : 'MARKET_WEATHER_UNKNOWN',

    ...extra
  };
}

function buildRequestMarketWeather(req = {}) {
  const query = req?.query || {};

  const parsed = parseMarketWeatherKeyLoose({
    currentMarketWeatherKey: firstValue(
      query.confirmedMarketWeatherKey,
      query.currentMarketWeatherKey,
      query.entryMarketWeatherKey,
      query.marketWeatherKey
    ),
    currentMarketWeatherRegime: firstValue(
      query.confirmedMarketWeatherRegime,
      query.currentMarketWeatherRegime,
      query.entryMarketWeatherRegime,
      query.marketWeatherRegime,
      query.regime
    ),
    currentMarketWeatherTrendSide: firstValue(
      query.confirmedMarketWeatherTrendSide,
      query.currentMarketWeatherTrendSide,
      query.entryMarketWeatherTrendSide,
      query.marketWeatherTrendSide,
      query.trendSide,
      query.marketTrendSide
    )
  });

  if (!parsed.known) {
    return {
      requestOverrideApplied: false,
      unknownRequestOverrideBlocked: true,
      requestMarketWeatherKey: parsed.key,
      reason: 'REQUEST_MARKET_WEATHER_UNKNOWN_OR_MISSING'
    };
  }

  return buildCurrentWeatherFromRaw(
    {
      currentMarketWeatherKey: parsed.key,
      confirmedMarketWeatherKey: parsed.key,
      currentMarketWeatherRegime: parsed.regime,
      confirmedMarketWeatherRegime: parsed.regime,
      currentMarketWeatherTrendSide: parsed.trendSide,
      confirmedMarketWeatherTrendSide: parsed.trendSide,
      updatedAt: firstFinite(
        query.confirmedMarketWeatherUpdatedAt,
        query.currentMarketWeatherUpdatedAt,
        query.marketWeatherUpdatedAt,
        Date.now()
      )
    },
    {
      requestOverrideApplied: true,
      unknownRequestOverrideBlocked: false,
      source: 'REQUEST_QUERY',
      requestMarketWeatherKey: parsed.key
    }
  );
}

function chooseCurrentMarketWeather({ requestWeather, storedWeather }) {
  if (requestWeather?.requestOverrideApplied && requestWeather.confirmedMarketWeatherKnown) {
    return {
      ...storedWeather,
      ...requestWeather,
      available: true,
      selectedWeatherSource: 'REQUEST_QUERY_KNOWN_WEATHER'
    };
  }

  if (storedWeather?.confirmedMarketWeatherKnown) {
    return {
      ...storedWeather,
      requestOverrideApplied: false,
      unknownRequestOverrideBlocked: Boolean(requestWeather?.unknownRequestOverrideBlocked),
      selectedWeatherSource: storedWeather.source || 'STORED_MARKET_WEATHER'
    };
  }

  return {
    ...buildCurrentWeatherFromRaw({}),
    ...(storedWeather || {}),
    requestOverrideApplied: false,
    unknownRequestOverrideBlocked: Boolean(requestWeather?.unknownRequestOverrideBlocked),
    selectedWeatherSource: 'UNKNOWN_FALLBACK'
  };
}

function safeBuildEntryWeatherSnapshot(row = {}, fallbackMarket = {}) {
  const rowParsed = parseMarketWeatherKeyLoose({
    entryMarketWeatherKey:
      row.entryMarketWeatherKey ||
      row.marketWeatherKey,
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

  const fallbackParsed = parseMarketWeatherKeyLoose({
    currentMarketWeatherKey:
      fallbackMarket.confirmedMarketWeatherKey ||
      fallbackMarket.currentMarketWeatherKey,
    currentMarketWeatherRegime:
      fallbackMarket.confirmedMarketWeatherRegime ||
      fallbackMarket.currentMarketWeatherRegime,
    currentMarketWeatherTrendSide:
      fallbackMarket.confirmedMarketWeatherTrendSide ||
      fallbackMarket.currentMarketWeatherTrendSide
  });

  const useFallbackBecauseRowIsUnknownOrPartial =
    !rowParsed.known &&
    fallbackParsed.known;

  const parsed = useFallbackBecauseRowIsUnknownOrPartial
    ? fallbackParsed
    : rowParsed;

  return {
    entryMarketWeatherKey: parsed.key,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: parsed.regime,
    entryMarketWeatherTrendSide: parsed.trendSide,
    entryMarketWeatherCapturedAt: firstFinite(
      row.entryMarketWeatherCapturedAt,
      row.marketWeatherCapturedAt,
      row.openedAt,
      row.createdAt,
      row.ts,
      fallbackMarket.confirmedMarketWeatherUpdatedAt,
      fallbackMarket.currentMarketWeatherUpdatedAt,
      Date.now()
    ),
    entryMarketWeatherKnown: parsed.known,
    entryMarketWeatherRaw: row.entryMarketWeatherRaw || row.marketWeatherRaw || null,
    entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
      ? row.entryMarketWeatherRawAvailableFields
      : Object.keys(row || {}).filter((keyName) => {
          const text = lower(keyName);
          return text.includes('weather') || text.includes('regime') || text.includes('trend');
        }),
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,

    adminOverviewWeatherFallbackApplied: useFallbackBecauseRowIsUnknownOrPartial,
    adminOverviewOriginalEntryMarketWeatherKey: row.entryMarketWeatherKey || null,
    adminOverviewPartialWeatherRepaired: Boolean(
      row.entryMarketWeatherKey &&
        !rowParsed.known &&
        fallbackParsed.known
    )
  };
}

function buildWeatherFields(row = {}, currentMarketWeather = {}) {
  const entrySnapshot = safeBuildEntryWeatherSnapshot(row, currentMarketWeather);

  const rowCurrentParsed = parseMarketWeatherKeyLoose({
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

  const fallbackCurrentParsed = parseMarketWeatherKeyLoose({
    currentMarketWeatherKey:
      currentMarketWeather.confirmedMarketWeatherKey ||
      currentMarketWeather.currentMarketWeatherKey,
    currentMarketWeatherRegime:
      currentMarketWeather.confirmedMarketWeatherRegime ||
      currentMarketWeather.currentMarketWeatherRegime,
    currentMarketWeatherTrendSide:
      currentMarketWeather.confirmedMarketWeatherTrendSide ||
      currentMarketWeather.currentMarketWeatherTrendSide
  });

  const currentParsed = rowCurrentParsed.known
    ? rowCurrentParsed
    : fallbackCurrentParsed;

  const confirmedParsed = parseMarketWeatherKeyLoose(
    currentMarketWeather.confirmedMarketWeatherKey || currentParsed.key
  );

  return {
    ...entrySnapshot,

    currentMarketWeatherKey: currentParsed.key,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: currentParsed.regime,
    currentMarketWeatherTrendSide: currentParsed.trendSide,
    currentMarketWeatherKnown: currentParsed.known,

    confirmedMarketWeatherKey: confirmedParsed.key,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherRegime: confirmedParsed.regime,
    confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
    confirmedMarketWeatherKnown: confirmedParsed.known,

    weatherMatched:
      entrySnapshot.entryMarketWeatherKey !== 'UNKNOWN|UNKNOWN' &&
      confirmedParsed.key !== 'UNKNOWN|UNKNOWN' &&
      entrySnapshot.entryMarketWeatherKey === confirmedParsed.key
  };
}

function getRiskGeometry(row = {}) {
  const entry = firstFinite(
    row.entryPrice,
    row.entry,
    row.avgEntryPrice,
    row.averageEntryPrice,
    row.averageEntry,
    row.openPrice
  );

  const initialSl = firstFinite(
    row.initialSl,
    row.initialSL,
    row.initialStopLoss,
    row.initialStopLossPrice,
    row.stopLoss,
    row.stopLossPrice,
    row.sl,
    row.slPrice
  );

  const tp = firstFinite(
    row.tp,
    row.takeProfit,
    row.takeProfitPrice,
    row.targetPrice,
    row.finalTp,
    row.finalTakeProfit
  );

  const exitPrice = firstFinite(
    row.exitPrice,
    row.closePrice,
    row.closedPrice,
    row.outcomePrice,
    row.fillExitPrice,
    row.exit
  );

  const currentPrice = firstFinite(
    row.currentPrice,
    row.markPrice,
    row.lastPrice,
    row.price
  );

  const denominator =
    Number.isFinite(entry) && Number.isFinite(initialSl)
      ? initialSl - entry
      : 0;

  const hasGeometryFields =
    Number.isFinite(entry) ||
    Number.isFinite(initialSl) ||
    Number.isFinite(tp);

  const validGeometry =
    !hasGeometryFields ||
    (
      Number.isFinite(entry) &&
      Number.isFinite(initialSl) &&
      Number.isFinite(tp) &&
      denominator > 0 &&
      tp < entry &&
      entry < initialSl
    );

  const shortGrossR =
    validGeometry && hasGeometryFields && Number.isFinite(exitPrice)
      ? (entry - exitPrice) / denominator
      : null;

  const shortCurrentR =
    validGeometry && hasGeometryFields && Number.isFinite(currentPrice)
      ? (entry - currentPrice) / denominator
      : null;

  const shortTpHit =
    validGeometry &&
    hasGeometryFields &&
    (
      row.shortTpHit === true ||
      row.tpHit === true ||
      (Number.isFinite(exitPrice) && exitPrice <= tp) ||
      (Number.isFinite(currentPrice) && currentPrice <= tp)
    );

  const shortSlHit =
    validGeometry &&
    hasGeometryFields &&
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
    hasGeometryFields,
    validGeometry,
    shortTpHit: Boolean(shortTpHit),
    shortSlHit: Boolean(shortSlHit),
    shortGrossR,
    shortCurrentR
  };
}

function outcomeNetR(row = {}) {
  const explicitShortR = firstFinite(
    row.shortNetR,
    row.netShortR,
    row.shortExitR,
    row.shortRealizedNetR,
    row.shortRealizedR
  );

  if (explicitShortR !== null) return explicitShortR;

  const geometry = getRiskGeometry(row);
  const costR = num(row.costR ?? row.avgCostR, 0);

  if (geometry.hasGeometryFields && geometry.validGeometry && geometry.shortGrossR !== null) {
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

function isLearningOutcomeSource(source = '') {
  const value = upper(source || 'VIRTUAL');
  return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value === '';
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

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  const virtualKey = realKey && String(realKey).startsWith('real')
    ? `virtual${String(realKey).slice(4)}`
    : null;

  const resolvedShadowKey = shadowKey || (
    realKey && String(realKey).startsWith('real')
      ? `shadow${String(realKey).slice(4)}`
      : null
  );

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
    : Math.max(num(row.completed, 0), num(row.outcomeSample, 0), 0);

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
  const directSL = firstFinite(
    row.directSLPct,
    row.directSlPct,
    row.directSLRate,
    row.directSlRate
  );

  if (directSL !== null) return directSL > 1 ? directSL / 100 : directSL;

  const completed = getOutcomeSample(row);

  const directSLCount = firstFinite(
    row.directSL,
    row.directSl,
    row.directSLLosses,
    row.directSlLosses
  );

  if (completed > 0 && directSLCount !== null) return directSLCount / completed;

  return 0;
}

function getLCB95AvgR(row = {}) {
  return firstFinite(
    row.standaloneMicroMicroLifetimeLCB95AvgR,
    row.standaloneExactMicroMicroLifetimeLCB95AvgR,
    row.microMicroLifetimeLCB95AvgR,
    row.lcb95AvgR,
    row.avgRLCB95,
    row.avgRLcb95,
    row.avgRLowerBound95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR,
    row.shrunkLCB95AvgR,
    row.shrunkAvgRLCB95
  );
}

function getShrunkAvgR(row = {}) {
  return firstFinite(
    row.shrunkAvgR,
    row.finalShrunkAvgR,
    row.marketShrunkAvgR,
    row.currentMarketCandidate?.shrunkAvgR,
    getAvgR(row)
  );
}

function getShrunkLCB95AvgR(row = {}) {
  return firstFinite(
    row.shrunkLCB95AvgR,
    row.shrunkLcb95AvgR,
    row.shrunkAvgRLCB95,
    row.finalShrunkLCB95AvgR,
    row.marketShrunkLCB95AvgR,
    row.currentMarketCandidate?.shrunkLCB95AvgR,
    getLCB95AvgR(row),
    getAvgR(row)
  );
}

function getProfitFactor(row = {}) {
  const direct = firstFinite(row.netProfitFactor, row.profitFactor, row.pf);
  if (direct !== null) return direct;

  const outcomes = getOutcomeCounts(row);
  const totalR = getTotalR(row);

  if (outcomes.losses <= 0 && totalR > 0) return 999;
  if (outcomes.losses <= 0) return 0;

  const grossWinR = Math.max(0, totalR);
  const grossLossR = Math.abs(Math.min(0, totalR));

  if (grossLossR <= 0) return grossWinR > 0 ? 999 : 0;

  return grossWinR / grossLossR;
}

function tierForMicroMicro(row = {}) {
  const completed = getOutcomeSample(row);
  const observed = getObservationSample(row);

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'HARD';
  if (completed > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function inheritedPolicyReasonAllowed(row = {}, reason = '') {
  const text = upper(reason);
  const microMicroId = getMicroMicroFamilyId(row) || '';
  const parsed = parseShortTaxonomyMicroId(microMicroId || getTrueMicroFamilyId(row));
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);

  if (!text) return false;
  if (text.includes('E_WEAK_CONTRA') && confirmationProfile === 'E_WEAK_CONTRA') return true;
  if (text.includes('INVALID_SHORT_GEOMETRY')) return true;
  if (text.includes('INVALID_SIDE') || text.includes('NON_SHORT') || text.includes('LONG_DISABLED')) return true;
  if (text.includes('SCANNER') || text.includes('EXECUTION')) return true;

  if (text.includes('KNOWN_FORBIDDEN_FAMILY')) {
    if (isScannerFingerprintId(microMicroId)) return true;
    if (isExecutionFingerprintId(microMicroId)) return true;
    if (microMicroId.includes('MICRO_LONG_')) return true;

    return false;
  }

  return false;
}

function inferPolicyBlocked(row = {}) {
  const microMicroId = getMicroMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(microMicroId || getTrueMicroFamilyId(row));
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);
  const geometry = getRiskGeometry(row);

  if (!microMicroId) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'EXACT_MICRO_MICRO_ID_REQUIRED',
      inheritedPolicyBlockedIgnored: false
    };
  }

  if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'NON_SHORT_POLICY_BLOCK',
      inheritedPolicyBlockedIgnored: false
    };
  }

  if (isScannerFingerprintId(microMicroId)) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'SCANNER_FINGERPRINT_POLICY_BLOCK',
      inheritedPolicyBlockedIgnored: false
    };
  }

  if (isExecutionFingerprintId(microMicroId)) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'EXECUTION_FINGERPRINT_POLICY_BLOCK',
      inheritedPolicyBlockedIgnored: false
    };
  }

  if (confirmationProfile === 'E_WEAK_CONTRA') {
    return {
      policyBlocked: true,
      policyBlockedReason: 'E_WEAK_CONTRA_POLICY_BLOCK',
      inheritedPolicyBlockedIgnored: false
    };
  }

  if (geometry.hasGeometryFields && !geometry.validGeometry) {
    return {
      policyBlocked: true,
      policyBlockedReason: 'INVALID_SHORT_GEOMETRY_POLICY_BLOCK',
      inheritedPolicyBlockedIgnored: false
    };
  }

  if (row.policyBlocked === true || row.policyBlockedReason) {
    const reason = row.policyBlockedReason || 'POLICY_BLOCKED';

    if (inheritedPolicyReasonAllowed(row, reason)) {
      return {
        policyBlocked: true,
        policyBlockedReason: reason,
        inheritedPolicyBlockedIgnored: false
      };
    }

    return {
      policyBlocked: false,
      policyBlockedReason: null,
      inheritedPolicyBlockedIgnored: true,
      inheritedPolicyBlockedReason: reason
    };
  }

  return {
    policyBlocked: false,
    policyBlockedReason: null,
    inheritedPolicyBlockedIgnored: false
  };
}

function inferEmpiricalVeto(row = {}) {
  if (row.empiricalVeto === true) {
    return {
      empiricalVeto: true,
      empiricalVetoReason: row.empiricalVetoReason || 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE'
    };
  }

  const completed = getOutcomeSample(row);
  const lcb95 = getLCB95AvgR(row);

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE && lcb95 !== null && lcb95 < 0) {
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
  const risk = num(row.riskFractionForEntry ?? row.riskFraction, 0);
  const shrunkLCB95 = getShrunkLCB95AvgR(row);
  const currentWeather = parseMarketWeatherKeyLoose(row.currentMarketWeatherKey || row.confirmedMarketWeatherKey);
  const playbookFresh = row.playbookFresh === true;
  const weatherMatched = row.weatherMatched === true || row.playbookWeatherMatched === true;
  const fdrPass = row.fdrPass !== false;

  if (row.policyBlocked || row.empiricalVeto) return SIGNAL_TYPE_BLOCKED;
  if (!currentWeather.known) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (shrunkLCB95 <= 0) {
    return getOutcomeSample(row) >= MIN_COMPLETED_MICRO_MICRO_ACTIVE
      ? SIGNAL_TYPE_WATCH_ONLY
      : SIGNAL_TYPE_OBSERVE_ONLY;
  }

  if (
    risk > 0 &&
    playbookFresh &&
    weatherMatched &&
    shrunkLCB95 > 0 &&
    fdrPass
  ) {
    return SIGNAL_TYPE_TRADE_READY;
  }

  if (getOutcomeSample(row) >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) {
    return SIGNAL_TYPE_WATCH_ONLY;
  }

  return SIGNAL_TYPE_OBSERVE_ONLY;
}

function reasonForRow(row = {}) {
  if (row.policyBlocked) return row.policyBlockedReason || 'POLICY_BLOCKED';
  if (row.empiricalVeto) return row.empiricalVetoReason || 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE';
  if (row.currentMarketWeatherKey === 'UNKNOWN|UNKNOWN') return 'MARKET_WEATHER_UNKNOWN';
  if (row.playbookStatus === 'MISSING_FOR_CONFIRMED_WEATHER') return 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER';
  if (row.playbookFresh === false) return 'PLAYBOOK_STALE_OR_MISSING';
  if (row.weatherMatched === false) return 'WEATHER_NOT_MATCHED';
  if (getShrunkLCB95AvgR(row) <= 0) return 'SHRUNK_LCB95_NOT_POSITIVE';
  if (num(row.riskFractionForEntry, 0) <= 0) return 'RISK_FRACTION_ZERO';
  return row.reason || 'BEST_AVAILABLE';
}

function normalizeMicroMicroRow(row = {}, key = '', currentMarketWeather = {}, playbookMap = new Map()) {
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

  const weatherFields = buildWeatherFields(row, currentMarketWeather);
  const policy = inferPolicyBlocked({ ...row, microMicroFamilyId, trueMicroFamilyId });
  const veto = inferEmpiricalVeto(row);

  const playbookSlot = playbookMap.get(microMicroFamilyId) || null;
  const playbookAge = ageMin(
    playbookSlot?.updatedAt ||
      playbookSlot?.createdAt ||
      playbookSlot?.generatedAt ||
      playbookSlot?.selectedAt ||
      playbookSlot?.playbookUpdatedAt
  );

  const playbookWeatherParsed = parseMarketWeatherKeyLoose({
    currentMarketWeatherKey:
      playbookSlot?.confirmedMarketWeatherKey ||
      playbookSlot?.currentMarketWeatherKey ||
      playbookSlot?.entryMarketWeatherKey ||
      playbookSlot?.marketWeatherKey
  });

  const confirmedWeatherParsed = parseMarketWeatherKeyLoose(currentMarketWeather.confirmedMarketWeatherKey);

  const playbookFresh = Boolean(
    playbookSlot &&
      playbookAge !== null &&
      playbookAge <= PLAYBOOK_MAX_AGE_MIN
  );

  const playbookWeatherMatched = Boolean(
    playbookSlot &&
      confirmedWeatherParsed.known &&
      playbookWeatherParsed.known &&
      playbookWeatherParsed.key === confirmedWeatherParsed.key
  );

  const shrunkAvgR = getShrunkAvgR(row);
  const shrunkLCB95AvgR = getShrunkLCB95AvgR(row);

  let riskFractionForEntry = num(
    row.riskFractionForEntry ??
      row.riskFraction ??
      row.riskDecision?.riskFractionForEntry ??
      row.riskDecision?.riskFraction,
    0
  );

  if (
    policy.policyBlocked ||
    veto.empiricalVeto ||
    !currentMarketWeather.confirmedMarketWeatherKnown ||
    shrunkLCB95AvgR <= 0 ||
    !playbookFresh ||
    !playbookWeatherMatched
  ) {
    riskFractionForEntry = 0;
  }

  const base = normalizeShortSide({
    ...row,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,
    base75ChildTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    setupType: parsed.setup || row.setupType || null,
    regimeBucket: parsed.regime || row.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,

    ...weatherFields,

    playbookSelected: Boolean(playbookSlot),
    playbookStatus: playbookSlot
      ? playbookFresh
        ? 'FRESH'
        : 'STALE'
      : 'MISSING_FOR_CONFIRMED_WEATHER',
    playbookFresh,
    playbookAgeMin: playbookAge,
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    playbookWeatherMatched,
    playbookConfirmedMarketWeatherKey: playbookSlot?.confirmedMarketWeatherKey || null,
    playbookCurrentMarketWeatherKey: playbookSlot?.currentMarketWeatherKey || null,

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
    profitFactor: round(getProfitFactor(row), 4),

    lcb95AvgR: getLCB95AvgR(row),
    standaloneMicroMicroLifetimeLCB95AvgR: getLCB95AvgR(row),
    shrunkAvgR: round(shrunkAvgR, 4),
    shrunkLCB95AvgR: round(shrunkLCB95AvgR, 4),

    empiricalVeto: veto.empiricalVeto,
    empiricalVetoReason: veto.empiricalVetoReason,
    policyBlocked: policy.policyBlocked,
    policyBlockedReason: policy.policyBlockedReason,
    inheritedPolicyBlockedIgnored: policy.inheritedPolicyBlockedIgnored,
    inheritedPolicyBlockedReason: policy.inheritedPolicyBlockedReason || null,

    riskFractionForEntry,
    riskFraction: riskFractionForEntry,
    maxAllowedRiskBand: riskFractionForEntry > 0 ? 'HIGH' : 'ZERO',

    proofSource: row.proofSource || (
      weatherFields.weatherMatched
        ? 'MICRO_MICRO_REGIME_TREND'
        : 'MICRO_MICRO_LIFETIME'
    ),
    proofTier: policy.policyBlocked
      ? PROOF_TIER_POLICY_BLOCKED
      : veto.empiricalVeto
        ? PROOF_TIER_EMPIRICAL_VETO
        : weatherFields.weatherMatched
          ? PROOF_TIER_MICRO_MICRO_MARKET
          : completed > 0
            ? PROOF_TIER_MICRO_MICRO_LIFETIME
            : PROOF_TIER_OBSERVATION_ONLY,

    familyResolution: 'MICRO_MICRO',
    marketResolution: weatherFields.weatherMatched ? 'REGIME_TREND' : 'LIFETIME',

    tier: tierForMicroMicro(row),
    status: completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE
      ? 'MICRO_MICRO_ACTIVE'
      : completed > 0
        ? 'MICRO_MICRO_EARLY'
        : 'MICRO_MICRO_OBSERVING',

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

  const signalType = deriveSignalType(base);
  const reason = reasonForRow({ ...base, signalType });

  return {
    ...base,
    signalType,
    reason,
    whySelected: reason,
    whyBlocked: signalType === SIGNAL_TYPE_BLOCKED ? reason : null
  };
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
    else if (parseShortTaxonomyMicroId(key).isParent || parseShortTaxonomyMicroId(row?.microFamilyId).isParent) parent15Rows += 1;
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

async function readFirstExistingJson({ durable, volatile, keys = [] }) {
  for (const key of keys) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (read.value !== null && read.value !== undefined) {
      return {
        key,
        value: read.value,
        source: read.source
      };
    }
  }

  return {
    key: null,
    value: null,
    source: null
  };
}

async function readDirectMarket({ durable, volatile }) {
  const discoveredWeatherKeys = uniqueStrings([
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*WEATHER*`, 20),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*WEATHER*`, 20)
  ]);

  const discoveredUniverseKeys = uniqueStrings([
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*UNIVERSE*`, 10),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*UNIVERSE*`, 10)
  ]);

  const weatherKeys = uniqueStrings([
    SHORT_MARKET_WEATHER_KEYS,
    discoveredWeatherKeys
  ]).slice(0, MAX_DISCOVERED_KEYS);

  const universeKeys = uniqueStrings([
    SHORT_MARKET_UNIVERSE_KEYS,
    discoveredUniverseKeys
  ]).slice(0, MAX_DISCOVERED_KEYS);

  let bestWeatherRead = {
    key: null,
    value: null,
    source: null,
    parsed: buildCurrentWeatherFromRaw({})
  };

  for (const key of weatherKeys) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (!read.value) continue;

    const parsed = buildCurrentWeatherFromRaw(safeObject(read.value));

    if (parsed.confirmedMarketWeatherKnown) {
      bestWeatherRead = {
        key,
        value: read.value,
        source: read.source,
        parsed
      };
      break;
    }

    if (!bestWeatherRead.value) {
      bestWeatherRead = {
        key,
        value: read.value,
        source: read.source,
        parsed
      };
    }
  }

  const universeRead = await readFirstExistingJson({
    durable,
    volatile,
    keys: universeKeys
  });

  const weather = safeObject(bestWeatherRead.value);
  const universe = safeObject(universeRead.value);

  const merged = {
    ...universe,
    ...weather
  };

  const mergedParsed = buildCurrentWeatherFromRaw(merged);

  const currentMarketWeather = bestWeatherRead.parsed.confirmedMarketWeatherKnown
    ? bestWeatherRead.parsed
    : mergedParsed;

  return {
    ...currentMarketWeather,

    available: Boolean(bestWeatherRead.value || universeRead.value),
    source: bestWeatherRead.source || universeRead.source,
    key: bestWeatherRead.key,
    universeKey: universeRead.key,

    weatherTriedKeys: weatherKeys,
    universeTriedKeys: universeKeys,

    regime: currentMarketWeather.currentMarketWeatherRegime,
    trendSide: currentMarketWeather.currentMarketWeatherTrendSide,

    bullishPct: weather.bullishPct ?? universe.bullishPct ?? null,
    bearishPct: weather.bearishPct ?? universe.bearishPct ?? null,
    neutralPct: weather.neutralPct ?? universe.neutralPct ?? null,
    squeezePct: weather.squeezePct ?? universe.squeezePct ?? null,
    confidence: weather.confidence ?? weather.weatherConfidence ?? universe.confidence ?? null,

    ageSec: currentMarketWeather.currentMarketWeatherUpdatedAt
      ? Math.max(0, Math.floor((Date.now() - currentMarketWeather.currentMarketWeatherUpdatedAt) / 1000))
      : null,

    ageText: currentMarketWeather.currentMarketWeatherUpdatedAt
      ? `${Math.max(0, Math.floor((Date.now() - currentMarketWeather.currentMarketWeatherUpdatedAt) / 1000))}s geleden`
      : null,

    raw: safeCompact(merged, 2)
  };
}

async function readPlaybook({ durable, volatile }) {
  const discovered = uniqueStrings([
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*PLAYBOOK*`, 20),
    await discoverKeys(durable, `${SHORT_KEY_PREFIX}*CURRENT_MARKET*`, 20),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*PLAYBOOK*`, 20),
    await discoverKeys(volatile, `${SHORT_KEY_PREFIX}*CURRENT_MARKET*`, 20)
  ]);

  const keys = uniqueStrings([...SHORT_PLAYBOOK_KEYS, ...discovered]).slice(0, MAX_DISCOVERED_KEYS);

  for (const key of keys) {
    const read = await readJsonFromStores({
      durable,
      volatile,
      key,
      fallback: null
    });

    if (!read.value) continue;

    return {
      payload: read.value,
      source: read.source,
      sourceKey: key,
      triedKeys: keys
    };
  }

  return {
    payload: null,
    source: null,
    sourceKey: null,
    triedKeys: keys
  };
}

function extractPlaybookRows(playbookPayload = {}) {
  const rows = [];

  if (!playbookPayload) return rows;

  const rootTs = firstFinite(
    playbookPayload.updatedAt,
    playbookPayload.createdAt,
    playbookPayload.generatedAt,
    playbookPayload.selectedAt,
    playbookPayload.playbookUpdatedAt
  );

  const rootWeather = {
    confirmedMarketWeatherKey: playbookPayload.confirmedMarketWeatherKey,
    currentMarketWeatherKey: playbookPayload.currentMarketWeatherKey,
    entryMarketWeatherKey: playbookPayload.entryMarketWeatherKey,
    marketWeatherKey: playbookPayload.marketWeatherKey,
    confirmedMarketWeatherRegime: playbookPayload.confirmedMarketWeatherRegime,
    currentMarketWeatherRegime: playbookPayload.currentMarketWeatherRegime,
    confirmedMarketWeatherTrendSide: playbookPayload.confirmedMarketWeatherTrendSide,
    currentMarketWeatherTrendSide: playbookPayload.currentMarketWeatherTrendSide
  };

  const pushRow = (row) => {
    if (!row) return;

    if (row && typeof row === 'object') {
      rows.push({
        ...rootWeather,
        updatedAt: row.updatedAt || row.createdAt || row.generatedAt || row.selectedAt || rootTs || null,
        ...row
      });
      return;
    }

    rows.push(row);
  };

  if (Array.isArray(playbookPayload)) {
    for (const row of playbookPayload) pushRow(row);
  }

  if (playbookPayload && typeof playbookPayload === 'object') {
    pushRow(playbookPayload.selected);
    pushRow(playbookPayload.bestForCurrentMarket);
    pushRow(playbookPayload.bestTradeReady);
    pushRow(playbookPayload.bestWatch);
    pushRow(playbookPayload.bestObserveOnly);

    for (const row of Array.isArray(playbookPayload.candidates) ? playbookPayload.candidates : []) pushRow(row);
    for (const row of Array.isArray(playbookPayload.rows) ? playbookPayload.rows : []) pushRow(row);
    for (const row of Array.isArray(playbookPayload.microFamilies) ? playbookPayload.microFamilies : []) pushRow(row);
    for (const row of Array.isArray(playbookPayload.selectedRows) ? playbookPayload.selectedRows : []) pushRow(row);
  }

  return rows.filter(Boolean);
}

function buildPlaybookMap(playbookPayload = {}, currentMarketWeather = {}) {
  const map = new Map();
  const rows = extractPlaybookRows(playbookPayload);
  const confirmedWeather = parseMarketWeatherKeyLoose(currentMarketWeather.confirmedMarketWeatherKey);

  for (const row of rows) {
    const id = getMicroMicroFamilyId(row);
    if (!id) continue;

    const rowWeather = parseMarketWeatherKeyLoose({
      currentMarketWeatherKey:
        row.confirmedMarketWeatherKey ||
        row.currentMarketWeatherKey ||
        row.entryMarketWeatherKey ||
        row.marketWeatherKey,
      currentMarketWeatherRegime:
        row.confirmedMarketWeatherRegime ||
        row.currentMarketWeatherRegime ||
        row.entryMarketWeatherRegime,
      currentMarketWeatherTrendSide:
        row.confirmedMarketWeatherTrendSide ||
        row.currentMarketWeatherTrendSide ||
        row.entryMarketWeatherTrendSide
    });

    const effectiveWeather = rowWeather.known
      ? rowWeather
      : confirmedWeather.known
        ? confirmedWeather
        : rowWeather;

    const weatherMatched =
      confirmedWeather.known &&
      effectiveWeather.known &&
      effectiveWeather.key === confirmedWeather.key;

    const ts = firstFinite(
      row.updatedAt,
      row.createdAt,
      row.generatedAt,
      row.selectedAt,
      row.playbookUpdatedAt,
      row.playbookCreatedAt
    );

    const age = ageMin(ts);
    const fresh = age !== null && age <= PLAYBOOK_MAX_AGE_MIN;

    map.set(id, {
      ...row,
      selectedFamilyId: id,
      currentMarketWeatherKey: effectiveWeather.key,
      confirmedMarketWeatherKey: effectiveWeather.key,
      currentMarketWeatherRegime: effectiveWeather.regime,
      confirmedMarketWeatherRegime: effectiveWeather.regime,
      currentMarketWeatherTrendSide: effectiveWeather.trendSide,
      confirmedMarketWeatherTrendSide: effectiveWeather.trendSide,
      weatherMatched,
      playbookFresh: fresh,
      playbookAgeMin: age,
      updatedAt: ts || null,
      playbookWeatherFallbackToConfirmedOverviewWeather: Boolean(!rowWeather.known && confirmedWeather.known)
    });
  }

  return map;
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

  return uniqueStrings(raw)
    .map(normalizeMicroMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId);
}

function normalizeRotation(rotation, rows = [], currentMarketWeather = {}, playbookMap = new Map()) {
  if (!rotation && (!Array.isArray(rows) || rows.length <= 0)) return null;

  const rawMicroFamilies = [
    ...(Array.isArray(rotation?.microFamilies) ? rotation.microFamilies : []),
    ...(Array.isArray(rows) ? rows : [])
  ];

  const microMicroRows = rawMicroFamilies
    .filter(isShortRow)
    .map((row) => normalizeMicroMicroRow(row, '', currentMarketWeather, playbookMap))
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

function compactRotationDashboard(rotationRead = {}, fallbackSelectedIds = [], currentMarketWeather = {}, playbookMap = new Map()) {
  const active = normalizeRotation(rotationRead.active, rotationRead.activeRows, currentMarketWeather, playbookMap);
  const next = normalizeRotation(rotationRead.next, rotationRead.nextRows, currentMarketWeather, playbookMap);

  const fallbackActive = !active && fallbackSelectedIds.length > 0
    ? normalizeRotation({
        rotationId: `manual_${PERSISTENT_LEARNING_KEY}`,
        selectedMicroMicroFamilyIds: fallbackSelectedIds,
        manualOnly: true,
        adminSelected: true
      }, [], currentMarketWeather, playbookMap)
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

function summarizeMicroMicroRows(micros = {}, currentMarketWeather = {}, playbookMap = new Map()) {
  const rows = sourceEntries(micros)
    .map(([key, row]) => normalizeMicroMicroRow(row, key, currentMarketWeather, playbookMap))
    .filter((row) => row.microMicroFamilyId && isSelectableMicroMicroId(row.microMicroFamilyId))
    .filter(isShortRow);

  const summary = rows.reduce((acc, row) => {
    const tier = row.tier;
    const status = row.status;
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
    acc.signalTypeCounts[row.signalType] = (acc.signalTypeCounts[row.signalType] || 0) + 1;

    if (completed > 0) acc.completedFamilies += 1;
    if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) acc.activeLearningFamilies += 1;
    if (completed > 0 && completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE) acc.earlyOutcomeFamilies += 1;
    if (observed > 0 && completed <= 0) acc.observationOnlyFamilies += 1;
    if (row.cleanMeasurement) acc.cleanMeasurementRows += 1;
    if (row.empiricalVeto) acc.empiricalVetoRows += 1;
    if (row.policyBlocked) acc.policyBlockedRows += 1;
    if (row.inheritedPolicyBlockedIgnored) acc.inheritedPolicyBlockedIgnoredRows += 1;
    if (row.entryMarketWeatherKey === 'UNKNOWN|UNKNOWN') acc.unknownWeatherRows += 1;
    if (row.adminOverviewPartialWeatherRepaired) acc.partialWeatherRepairedRows += 1;
    if (row.weatherMatched) acc.weatherMatchedRows += 1;
    if (row.playbookFresh) acc.playbookFreshRows += 1;

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
    empiricalVetoRows: 0,
    policyBlockedRows: 0,
    inheritedPolicyBlockedIgnoredRows: 0,
    unknownWeatherRows: 0,
    partialWeatherRepairedRows: 0,
    weatherMatchedRows: 0,
    playbookFreshRows: 0,
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
    },
    signalTypeCounts: {
      [SIGNAL_TYPE_TRADE_READY]: 0,
      [SIGNAL_TYPE_WATCH_ONLY]: 0,
      [SIGNAL_TYPE_OBSERVE_ONLY]: 0,
      [SIGNAL_TYPE_BLOCKED]: 0
    }
  });

  const rowsList = rows
    .sort((a, b) => {
      const signalRank = {
        [SIGNAL_TYPE_TRADE_READY]: 0,
        [SIGNAL_TYPE_WATCH_ONLY]: 1,
        [SIGNAL_TYPE_OBSERVE_ONLY]: 2,
        [SIGNAL_TYPE_BLOCKED]: 3
      };

      const ar = signalRank[a.signalType] ?? 9;
      const br = signalRank[b.signalType] ?? 9;

      if (ar !== br) return ar - br;
      if (b.weatherMatched !== a.weatherMatched) return Number(b.weatherMatched) - Number(a.weatherMatched);
      if (b.playbookFresh !== a.playbookFresh) return Number(b.playbookFresh) - Number(a.playbookFresh);
      if (b.shrunkLCB95AvgR !== a.shrunkLCB95AvgR) return b.shrunkLCB95AvgR - a.shrunkLCB95AvgR;
      if (b.completed !== a.completed) return b.completed - a.completed;
      return b.totalR - a.totalR;
    })
    .slice(0, MAX_ROWS);

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

    rowsList
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

    if (getMicroMicroFamilyId(row, key)) continue;

    if (getTrueMicroFamilyId(row, key)) {
      child75RowsHidden += 1;
      continue;
    }

    if (parseShortTaxonomyMicroId(id).isParent || parseShortTaxonomyMicroId(row?.parentTrueMicroFamilyId).isParent) {
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

function normalizeLatestScan(latestScan, currentMarketWeather = {}) {
  if (!latestScan || typeof latestScan !== 'object') return null;

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterShortRows(rawCandidates)
    .map((row) => normalizeShortSide({
      ...row,
      ...buildWeatherFields(row, currentMarketWeather),
      source: row.source || 'SCANNER',
      scannerOnly: true,
      scannerFingerprintRole: 'METADATA_ONLY',
      scannerFingerprintsUsedAsLearningFamily: false
    }))
    .slice(0, MAX_DEBUG_ROWS);

  const createdAt = num(
    latestScan.createdAt ||
      latestScan.completedAt ||
      latestScan.ts ||
      latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const fallbackCandidatesCount = num(
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
    ...buildWeatherFields(latestScan, currentMarketWeather),

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

function normalizeTradeAction(action = {}, currentMarketWeather = {}) {
  const microMicroFamilyId = getMicroMicroFamilyId(action);
  const trueMicroFamilyId = getTrueMicroFamilyId(action);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(action);
  const riskGeometry = getRiskGeometry(action);
  const weatherFields = buildWeatherFields(action, currentMarketWeather);

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

    ...weatherFields,

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

    learningAction: true,
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

function buildTradeSummary(tradeMeta, currentMarketWeather = {}) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},
      actions: 0,
      learningActions: 0,
      virtualEntries: 0,
      virtualWaits: 0,
      virtualExits: 0,
      discordEligibleActions: 0,
      selectedMicroMicroActions: 0,
      exactSelectedMicroMicroActions: 0,
      discordAlertsSent: 0,
      skippedNewEntries: null,
      reason: null,
      skipReason: null,
      selectedMicroMicroFamilyIds: [],
      ...modeFlags()
    };
  }

  const rawActions = Array.isArray(tradeMeta.actions) ? tradeMeta.actions : [];
  const rawShortActions = filterShortRows(rawActions);
  const allShortActions = rawShortActions.map((row) => normalizeTradeAction(row, currentMarketWeather));
  const learningActions = allShortActions.filter((row) => row.learningAction || row.virtualOnly);
  const longActionsIgnored = rawActions.filter(isLongRow).length;

  const entries = allShortActions.filter((row) => row.action === 'ENTRY' || row.action === 'VIRTUAL_ENTRY');
  const waits = allShortActions.filter((row) => row.action === 'WAIT');

  const exitArrays = [
    ...(Array.isArray(tradeMeta.exits) ? tradeMeta.exits : []),
    ...(Array.isArray(tradeMeta.virtualExits) ? tradeMeta.virtualExits : []),
    ...(Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []),
    ...(Array.isArray(tradeMeta.outcomes) ? tradeMeta.outcomes : [])
  ];

  const virtualExits = filterShortRows(exitArrays)
    .map((row) => normalizeTradeAction({
      ...row,
      action: 'VIRTUAL_EXIT',
      netR: round(outcomeNetR(row), 4)
    }, currentMarketWeather));

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
    ...buildWeatherFields(tradeMeta, currentMarketWeather),

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

    entries: entries.length,
    waits: waits.length,
    exits: virtualExits.length,

    entryRows: entries.slice(0, MAX_DEBUG_ROWS),
    waitRows: waits.slice(0, MAX_DEBUG_ROWS),
    virtualCreatedRows: entries.slice(0, MAX_DEBUG_ROWS),
    virtualExitsRows: virtualExits.slice(0, MAX_DEBUG_ROWS),

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

function normalizePosition(position = {}, currentMarketWeather = {}) {
  const riskGeometry = getRiskGeometry(position);
  const weatherFields = buildWeatherFields(position, currentMarketWeather);

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

    ...weatherFields,

    selectableMicroMicroFamily: Boolean(microMicroFamilyId),

    virtualOnly: true,
    virtualTracked: true,

    realOrderPlaced: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    entry: riskGeometry.entry ?? num(position.entry ?? position.entryPrice, 0),
    entryPrice: riskGeometry.entry ?? num(position.entry ?? position.entryPrice, 0),
    sl: riskGeometry.initialSl ?? num(position.sl ?? position.stopLoss ?? position.initialSl, 0),
    tp: riskGeometry.tp ?? num(position.tp ?? position.takeProfit, 0),
    initialSl: riskGeometry.initialSl ?? num(position.initialSl ?? position.sl ?? position.stopLoss, 0),

    validShortRiskShape: Boolean(riskGeometry.validGeometry),
    validShortGeometry: Boolean(riskGeometry.validGeometry),

    currentPrice: riskGeometry.currentPrice || null,
    lastPrice: riskGeometry.currentPrice || null,

    ageSec: position.ageSec ?? null,
    currentR: position.currentR ?? riskGeometry.shortCurrentR,
    shortCurrentR: riskGeometry.shortCurrentR,
    shortGrossR: riskGeometry.shortGrossR,
    mfeR: position.mfeR ?? null,
    maeR: position.maeR ?? null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

    tpHit: riskGeometry.shortTpHit,
    slHit: riskGeometry.shortSlHit,
    shortTpHit: riskGeometry.shortTpHit,
    shortSlHit: riskGeometry.shortSlHit,

    tpExitArmed: Boolean(riskGeometry.currentPrice > 0 && riskGeometry.tp > 0 && riskGeometry.currentPrice <= riskGeometry.tp),
    slExitArmed: Boolean(riskGeometry.currentPrice > 0 && riskGeometry.initialSl > 0 && riskGeometry.currentPrice >= riskGeometry.initialSl),
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

function buildPositionSummary(rawPositions = [], currentMarketWeather = {}) {
  const positions = filterShortRows(rawPositions).map((row) => normalizePosition(row, currentMarketWeather));
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
    discordExitAlertEligiblePositions: positions.filter((row) => row.discordExitAlertEligible).length,

    unknownWeatherPositions: positions.filter((row) => row.entryMarketWeatherKey === 'UNKNOWN|UNKNOWN').length,
    partialWeatherRepairedPositions: positions.filter((row) => row.adminOverviewPartialWeatherRepaired).length,
    weatherMatchedPositions: positions.filter((row) => row.weatherMatched).length
  };
}

function normalizeDiscordLog(row = {}, currentMarketWeather = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  const merged = {
    ...row,
    ...payload,
    ...result
  };

  const microMicroFamilyId =
    getMicroMicroFamilyId(merged) ||
    getMicroMicroFamilyId(payload) ||
    getMicroMicroFamilyId(result);

  const trueMicroFamilyId =
    getTrueMicroFamilyId(merged) ||
    getTrueMicroFamilyId(payload) ||
    getTrueMicroFamilyId(result);

  const parentTrueMicroFamilyId =
    getParentTrueMicroFamilyId(merged) ||
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
    ...merged,
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
    ...buildWeatherFields(merged, currentMarketWeather),

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

    sent: Boolean(row.sent || payload.sent || result.sent || result.ok === true),
    failed: Boolean(row.failed || payload.failed || result.failed || result.ok === false),
    skipped: Boolean(row.skipped || payload.skipped || result.skipped),

    source: row.source || payload.source || result.source || null,

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
  return logs.reduce((acc, log) => {
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

function buildTaxonomySummary(micros = {}, activeMicroMicroFamilyIds = [], currentMarketWeather = {}, playbookMap = new Map()) {
  const activeSet = new Set(activeMicroMicroFamilyIds || []);

  const rows = sourceEntries(micros)
    .map(([key, row]) => normalizeMicroMicroRow(row, key, currentMarketWeather, playbookMap))
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

function selectBestForCurrentMarket(rows = [], currentMarketWeather = {}) {
  const confirmedKey = currentMarketWeather.confirmedMarketWeatherKey || 'UNKNOWN|UNKNOWN';
  const confirmedKnown = currentMarketWeather.confirmedMarketWeatherKnown === true;

  const sorted = [...rows].sort((a, b) => {
    const signalRank = {
      [SIGNAL_TYPE_TRADE_READY]: 0,
      [SIGNAL_TYPE_WATCH_ONLY]: 1,
      [SIGNAL_TYPE_OBSERVE_ONLY]: 2,
      [SIGNAL_TYPE_BLOCKED]: 3
    };

    const ar = signalRank[a.signalType] ?? 9;
    const br = signalRank[b.signalType] ?? 9;

    if (ar !== br) return ar - br;
    if (b.weatherMatched !== a.weatherMatched) return Number(b.weatherMatched) - Number(a.weatherMatched);
    if (b.playbookFresh !== a.playbookFresh) return Number(b.playbookFresh) - Number(a.playbookFresh);
    if (b.shrunkLCB95AvgR !== a.shrunkLCB95AvgR) return b.shrunkLCB95AvgR - a.shrunkLCB95AvgR;
    if (b.shrunkAvgR !== a.shrunkAvgR) return b.shrunkAvgR - a.shrunkAvgR;
    if (b.completed !== a.completed) return b.completed - a.completed;
    return b.totalR - a.totalR;
  });

  const selected = sorted[0] || null;

  if (!selected) {
    return {
      currentMarketWeatherKey: confirmedKey,
      confirmedMarketWeatherKey: confirmedKey,
      currentMarketWeatherRegime: currentMarketWeather.confirmedMarketWeatherRegime || 'UNKNOWN',
      currentMarketWeatherTrendSide: currentMarketWeather.confirmedMarketWeatherTrendSide || 'UNKNOWN',
      answerType: confirmedKnown ? 'NO_ROWS' : SIGNAL_TYPE_OBSERVE_ONLY,
      selectedFamilyId: null,
      signalType: SIGNAL_TYPE_OBSERVE_ONLY,
      riskFractionForEntry: 0,
      reason: confirmedKnown
        ? 'NO_MICRO_MICRO_ROWS'
        : 'MARKET_WEATHER_UNKNOWN'
    };
  }

  return {
    currentMarketWeatherKey: confirmedKey,
    confirmedMarketWeatherKey: confirmedKey,
    currentMarketWeatherRegime: currentMarketWeather.confirmedMarketWeatherRegime || 'UNKNOWN',
    currentMarketWeatherTrendSide: currentMarketWeather.confirmedMarketWeatherTrendSide || 'UNKNOWN',
    selectedFamilyId: selected.microMicroFamilyId,
    familyResolution: selected.familyResolution,
    marketResolution: selected.marketResolution,
    proofSource: selected.proofSource,
    proofTier: selected.proofTier,
    signalType: selected.signalType,
    answerType: selected.signalType,
    shrunkAvgR: selected.shrunkAvgR,
    shrunkLCB95AvgR: selected.shrunkLCB95AvgR,
    empiricalVeto: selected.empiricalVeto,
    policyBlocked: selected.policyBlocked,
    riskFractionForEntry: selected.riskFractionForEntry,
    playbookFresh: selected.playbookFresh,
    playbookAgeMin: selected.playbookAgeMin,
    playbookStatus: selected.playbookStatus,
    weatherMatched: selected.weatherMatched,
    reason: selected.reason,
    row: selected
  };
}

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Overview-Mode', 'short-only-marketweather-micro-micro-v3-confirmed-playbook-weather-fixed');
  res.setHeader('X-Admin-Overview-Version', ADMIN_OVERVIEW_VERSION);
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Market-Weather-Key-Version', MARKET_WEATHER_KEY_VERSION);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', CHILD75_LEARNING_GRANULARITY);
  res.setHeader('X-Micro-Micro-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Week-Reset-Disabled', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const requestMarketWeather = buildRequestMarketWeather(req);

    const [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      directMicrosRead,
      directRotationRead,
      marketRead,
      playbookRead,
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
          currentMarketWeatherKey: 'UNKNOWN|UNKNOWN',
          confirmedMarketWeatherKey: 'UNKNOWN|UNKNOWN',
          currentMarketWeatherRegime: 'UNKNOWN',
          currentMarketWeatherTrendSide: 'UNKNOWN',
          confirmedMarketWeatherRegime: 'UNKNOWN',
          confirmedMarketWeatherTrendSide: 'UNKNOWN',
          confirmedMarketWeatherKnown: false,
          reason: 'MARKET_WEATHER_UNKNOWN'
        }
      ),

      safeRead(
        'currentMarketPlaybook',
        () => readPlaybook({ durable, volatile }),
        {
          payload: null,
          source: null,
          sourceKey: null,
          triedKeys: []
        }
      ),

      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, SHORT_KEYS.discord.logList, 10),
        []
      )
    ]);

    const storedMarketWeather = marketRead.value || buildCurrentWeatherFromRaw({});
    const currentMarketWeather = chooseCurrentMarketWeather({
      requestWeather: requestMarketWeather,
      storedWeather: storedMarketWeather
    });

    const market = {
      ...storedMarketWeather,
      ...currentMarketWeather
    };

    const playbookPayload = playbookRead.value?.payload || null;
    const playbookMap = buildPlaybookMap(playbookPayload, currentMarketWeather);

    const latestScan = normalizeLatestScan(latestScanRead.value, currentMarketWeather);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta, currentMarketWeather);

    const rawPositions = asArray(positionsRead.value);
    const positionSummary = buildPositionSummary(rawPositions, currentMarketWeather);

    const currentMicros = directMicrosRead.value?.micros || {};
    const hiddenRows = summarizeHiddenRows(currentMicros);

    const selectedFromTrade = extractSelectedMicroMicroIds(tradeMeta, tradeSummary);

    const rotationDashboard = compactRotationDashboard(
      directRotationRead.value || {},
      selectedFromTrade,
      currentMarketWeather,
      playbookMap
    );

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const activeMicroMicroFamilyIds = activeRotation?.selectedMicroMicroFamilyIds ||
      rotationDashboard.activeMicroMicroFamilyIds ||
      [];

    const activeMacroFamilyIds = activeRotation?.macroFamilyIds || [];

    const currentMicroSummary = summarizeMicroMicroRows(
      currentMicros,
      currentMarketWeather,
      playbookMap
    );

    const taxonomySummary = buildTaxonomySummary(
      currentMicros,
      activeMicroMicroFamilyIds,
      currentMarketWeather,
      playbookMap
    );

    const rawDiscordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const discordLogs = rawDiscordLogs
      .map((row) => normalizeDiscordLog(row, currentMarketWeather))
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
      playbookRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    if (requestMarketWeather?.unknownRequestOverrideBlocked) {
      warnings.push({
        source: 'requestMarketWeather',
        error: 'UNKNOWN_REQUEST_MARKET_WEATHER_OVERRIDE_BLOCKED'
      });
    }

    if (
      currentMarketWeather.confirmedMarketWeatherKnown &&
      playbookPayload &&
      parseMarketWeatherKeyLoose(playbookPayload.currentMarketWeatherKey || playbookPayload.confirmedMarketWeatherKey).known === false
    ) {
      warnings.push({
        source: 'currentMarketPlaybook',
        error: 'PLAYBOOK_PAYLOAD_WEATHER_UNKNOWN_OVERRIDDEN_BY_CONFIRMED_OVERVIEW_WEATHER'
      });
    }

    const selectedDiscordMicroMicroIds = uniqueStrings([
      activeMicroMicroFamilyIds,
      selectedFromTrade
    ]).filter(isSelectableMicroMicroId);

    const bestForCurrentMarket = selectBestForCurrentMarket(
      currentMicroSummary.rowsList,
      currentMarketWeather
    );

    const playbookHasFreshRowsForConfirmedWeather = currentMicroSummary.rowsList.some((row) => (
      row.playbookFresh === true &&
      row.playbookWeatherMatched === true
    ));

    const currentMarketPlaybook = {
      ok: Boolean(bestForCurrentMarket.selectedFamilyId),
      source: playbookRead.value?.source || null,
      sourceKey: playbookRead.value?.sourceKey || null,
      triedKeys: playbookRead.value?.triedKeys || [],
      selectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
      featureFlags: featureFlags(),

      currentMarketWeatherKey: currentMarketWeather.confirmedMarketWeatherKey,
      confirmedMarketWeatherKey: currentMarketWeather.confirmedMarketWeatherKey,
      currentMarketWeatherRegime: currentMarketWeather.confirmedMarketWeatherRegime,
      currentMarketWeatherTrendSide: currentMarketWeather.confirmedMarketWeatherTrendSide,
      confirmedMarketWeatherRegime: currentMarketWeather.confirmedMarketWeatherRegime,
      confirmedMarketWeatherTrendSide: currentMarketWeather.confirmedMarketWeatherTrendSide,
      currentMarketWeatherKnown: currentMarketWeather.confirmedMarketWeatherKnown,
      confirmedMarketWeatherKnown: currentMarketWeather.confirmedMarketWeatherKnown,

      payloadCurrentMarketWeatherKey: playbookPayload?.currentMarketWeatherKey || null,
      payloadConfirmedMarketWeatherKey: playbookPayload?.confirmedMarketWeatherKey || null,
      payloadWeatherIgnoredWhenUnknown: true,

      playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
      playbookRows: playbookMap.size,
      playbookHasFreshRowsForConfirmedWeather,

      playbookStatus: !currentMarketWeather.confirmedMarketWeatherKnown
        ? 'MARKET_WEATHER_UNKNOWN'
        : playbookHasFreshRowsForConfirmedWeather
          ? 'FRESH_FOR_CONFIRMED_WEATHER'
          : playbookMap.size > 0
            ? 'MISSING_OR_STALE_FOR_CONFIRMED_WEATHER'
            : 'MISSING_FOR_CONFIRMED_WEATHER',

      selected: bestForCurrentMarket,
      bestForCurrentMarket,
      answerType: bestForCurrentMarket.signalType || SIGNAL_TYPE_OBSERVE_ONLY,
      refreshRequired: currentMarketWeather.confirmedMarketWeatherKnown && !playbookHasFreshRowsForConfirmedWeather,
      reason: bestForCurrentMarket.reason
    };

    const longIgnored = {
      positions: positionSummary.ignoredLongPositions,
      currentWeekMicroFamilies: hiddenRows.longRowsIgnored,
      scannerCandidates: latestScan?.longCandidatesIgnored || 0,
      tradeActions: tradeSummary.longActionsIgnored || 0,
      discordLogs: rawDiscordLogs.filter((row) => inferTradeSide(normalizeDiscordLog(row, currentMarketWeather)) === OPPOSITE_TRADE_SIDE).length,
      activeRotationRows: activeRotation?.longMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.longMicroFamiliesIgnored || 0
    };

    return res.status(200).json({
      ok: true,

      side: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,

      ...modeFlags(),

      versions: versions(),
      featureFlags: featureFlags(),

      weekKey: PERSISTENT_LEARNING_KEY,
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      previousWeekKey: PERSISTENT_LEARNING_KEY,

      requestedLearningKey: PERSISTENT_LEARNING_KEY,
      activeLearningStoreKey: directMicrosRead.value?.sourceKey ||
        `${SHORT_KEY_PREFIX}ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`,

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLatest: SHORT_KEYS.scan.latest,
        tradeRunMeta: SHORT_KEYS.trade.runMeta,
        analyzeMicros: SHORT_KEYS.analyze.micros,
        rotationDashboard: SHORT_KEYS.rotation.dashboard,
        rotationActive: SHORT_KEYS.rotation.active,
        discordLogList: SHORT_KEYS.discord.logList,
        marketWeatherKeys: SHORT_MARKET_WEATHER_KEYS,
        marketUniverseKeys: SHORT_MARKET_UNIVERSE_KEYS,
        currentMarketPlaybookKeys: SHORT_PLAYBOOK_KEYS
      },

      dataSources: {
        microsSource: directMicrosRead.value?.source || null,
        microsSourceKey: directMicrosRead.value?.sourceKey || null,
        microsTriedKeys: directMicrosRead.value?.triedKeys || [],

        rotationSource: directRotationRead.value?.source || null,
        rotationSourceKey: directRotationRead.value?.sourceKey || null,
        rotationTriedKeys: directRotationRead.value?.triedKeys || [],

        playbookSource: playbookRead.value?.source || null,
        playbookSourceKey: playbookRead.value?.sourceKey || null,
        playbookTriedKeys: playbookRead.value?.triedKeys || [],

        marketWeatherSource: currentMarketWeather.selectedWeatherSource || marketRead.value?.source || null,
        marketWeatherSourceKey: marketRead.value?.key || null,
        marketWeatherTriedKeys: marketRead.value?.weatherTriedKeys || SHORT_MARKET_WEATHER_KEYS,
        requestOverrideApplied: Boolean(currentMarketWeather.requestOverrideApplied),
        unknownRequestOverrideBlocked: Boolean(currentMarketWeather.unknownRequestOverrideBlocked)
      },

      currentMarketWeather,
      currentMarketWeatherKey: currentMarketWeather.currentMarketWeatherKey,
      currentMarketWeatherRegime: currentMarketWeather.currentMarketWeatherRegime,
      currentMarketWeatherTrendSide: currentMarketWeather.currentMarketWeatherTrendSide,
      currentMarketWeatherKnown: currentMarketWeather.currentMarketWeatherKnown,

      confirmedMarketWeatherKey: currentMarketWeather.confirmedMarketWeatherKey,
      confirmedMarketWeatherRegime: currentMarketWeather.confirmedMarketWeatherRegime,
      confirmedMarketWeatherTrendSide: currentMarketWeather.confirmedMarketWeatherTrendSide,
      confirmedMarketWeatherKnown: currentMarketWeather.confirmedMarketWeatherKnown,
      confirmedMarketWeatherFresh: currentMarketWeather.confirmedMarketWeatherFresh,

      requestMarketWeather,

      market: {
        ...market,
        ...currentMarketWeather
      },

      currentMarketPlaybook,

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
        weatherMatchRequiredForTradeReady: true,
        missingReason: 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER',
        selectorMode: 'observe',
        sizingCapMode: 'observe',
        fdrMode: 'observe',
        currentMarketPlaybookMustUseConfirmedOverviewWeather: true
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
        weatherIsContextOnly: true,
        familyIdDoesNotContainWeather: true,
        uiShowsOnlyMicroMicro: true,
        uiAllowsOnlyMicroMicroSelection: true,
        child75RowsHidden: true,
        parent15RowsHidden: true
      },

      taxonomySummary,

      counts: {
        visibleMicroMicroRows: currentMicroSummary.visibleMicroMicroRows || 0,
        cleanMeasurementRows: currentMicroSummary.cleanMeasurementRows || 0,
        legacyMeasurementRows: Math.max(0, (currentMicroSummary.visibleMicroMicroRows || 0) - (currentMicroSummary.cleanMeasurementRows || 0)),

        selectedDiscordMicroMicroIds: selectedDiscordMicroMicroIds.length,

        hiddenChild75Rows: hiddenRows.child75RowsHidden,
        hiddenParent15Rows: hiddenRows.parentRowsHidden,

        scannerFingerprintRowsHidden: hiddenRows.scannerFingerprintRowsHidden,
        executionFingerprintRowsHidden: hiddenRows.executionFingerprintRowsHidden,

        openVirtualPositions: positionSummary.positionsCount,
        scannerShortCandidates: latestScan?.shortCandidatesCount || latestScan?.candidatesCount || 0,

        tradeReadyRows: currentMicroSummary.signalTypeCounts?.[SIGNAL_TYPE_TRADE_READY] || 0,
        watchRows: currentMicroSummary.signalTypeCounts?.[SIGNAL_TYPE_WATCH_ONLY] || 0,
        observeOnlyRows: currentMicroSummary.signalTypeCounts?.[SIGNAL_TYPE_OBSERVE_ONLY] || 0,
        blockedRows: currentMicroSummary.signalTypeCounts?.[SIGNAL_TYPE_BLOCKED] || 0,

        empiricalVetoRows: currentMicroSummary.empiricalVetoRows || 0,
        policyBlockedRows: currentMicroSummary.policyBlockedRows || 0,
        inheritedPolicyBlockedIgnoredRows: currentMicroSummary.inheritedPolicyBlockedIgnoredRows || 0,
        unknownWeatherRows: currentMicroSummary.unknownWeatherRows || 0,
        partialWeatherRepairedRows: currentMicroSummary.partialWeatherRepairedRows || 0,
        weatherMatchedRows: currentMicroSummary.weatherMatchedRows || 0,
        playbookFreshRows: currentMicroSummary.playbookFreshRows || 0,

        sourceMicrosTotalRows: directMicrosRead.value?.stats?.totalRows || 0,
        sourceMicroMicroRows: directMicrosRead.value?.stats?.microMicroRows || 0,
        sourceChild75Rows: directMicrosRead.value?.stats?.child75Rows || 0,
        sourceParent15Rows: directMicrosRead.value?.stats?.parent15Rows || 0
      },

      learningStatus: {
        microMicroObserving: currentMicroSummary.statusCounts?.MICRO_MICRO_OBSERVING || 0,
        microMicroEarly: currentMicroSummary.statusCounts?.MICRO_MICRO_EARLY || 0,
        microMicroActive: currentMicroSummary.statusCounts?.MICRO_MICRO_ACTIVE || 0,
        microMicroActiveThreshold: MIN_COMPLETED_MICRO_MICRO_ACTIVE
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
        completed: currentMicroSummary.completed || 0
      },

      selectedDiscordMicroMicroIds,

      rules: {
        signalTypeDerivedOnly: true,
        tradeReadyRule: [
          'policyBlocked === false',
          'empiricalVeto === false',
          'confirmedMarketWeatherKey !== UNKNOWN|UNKNOWN',
          'weatherMatched === true',
          'playbookFresh === true',
          'shrunkLCB95AvgR > 0',
          'riskFractionForEntry > 0',
          'fdrPass !== false'
        ],
        unknownWeather: 'OBSERVE_ONLY + riskFractionForEntry 0',
        empiricalVeto: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} && standalone lifetime LCB95(avgR) < 0`,
        policyBlocked: [
          'E_WEAK_CONTRA',
          'invalid side',
          'invalid geometry',
          'non-short',
          'scanner fingerprint',
          'execution fingerprint'
        ],
        broadKnownForbiddenFamilyPolicyIgnoredUnlessScannerExecutionOrLong: true,
        noMarketConditionalVeto: true,
        weatherBadnessHandledByShrinkage: true,
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
        currentFitBlocksLearning: false,
        currentFitCanBlockDiscord: true,
        realOrdersDisabled: true,
        overviewRespectsKnownRequestMarketWeather: true,
        overviewBlocksUnknownRequestMarketWeatherOverride: true,
        currentMarketPlaybookUsesConfirmedOverviewWeather: true
      },

      microMicroPolicy: {
        enabled: true,
        onlySelectableLayerInAdmin: true,
        base75ChildRemainsContextLayer: true,
        parent15RemainsRollupContext: true,
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
        defaultPositionTimeStopMin: 720,
        riskSourceOfTruth: 'riskFractionForEntry'
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
            actionCounts: tradeSummary.actionCounts || {},
            skipReason: tradeSummary.skipReason || null,
            selectedMicroMicroFamilyIds: tradeSummary.selectedMicroMicroFamilyIds || [],
            currentMarketWeatherKey: tradeSummary.currentMarketWeatherKey,
            confirmedMarketWeatherKey: tradeSummary.confirmedMarketWeatherKey
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
      persistentMicroFamilies: currentMicroSummary.rows,
      persistentMicroSummary: currentMicroSummary,

      currentMicroSummary,

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
        reason: 'COMPACT_OVERVIEW_OUTPUT_MICRO_MICRO_MARKETWEATHER_ONLY'
      },

      perf: {
        durationMs: now() - startedAt,
        source: 'short_only_marketweather_micro_micro_safe_direct_redis_overview_v3_confirmed_playbook_weather_fixed'
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