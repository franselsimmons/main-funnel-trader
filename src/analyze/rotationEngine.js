// ================= FILE: src/analyze/rotationEngine.js =================
//
// SHORT-only Rotation engine.
//
// Doel:
// - Week N meet virtual/shadow outcomes.
// - Week N+1 gebruikt alleen handmatig geselecteerde SHORT setup-families.
// - Parent 15 = context / sample-bescherming.
// - Micro 75 = normale selectie fallback.
// - Micro-micro = voorkeurselectie wanneer genoeg sample aanwezig is.
// - Scanner buckets blijven metadata.
// - XR execution fingerprint blijft hash-bron.
// - MM micro-micro id is selecteerbaar.
//
// Identity:
// - Parent:      MICRO_SHORT_{SETUP}_{REGIME}
// - Micro:       MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - Micro-micro: MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
//
// Belangrijk:
// - Geen auto-activatie.
// - Alleen manual active rotation.
// - LONG blijft volledig uitgesloten.
// - Real orders blijven uit.

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

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

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';
const FALLBACK_TRUE_MICRO_SCHEMA = 'MF_V3';

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const EXECUTION_MICRO_SUFFIX = 'XR';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const SELECTION_PARENT_CONTEXT = 'PARENT_15_CONTEXT_ONLY';
const SELECTION_EXACT_75_CHILD = 'EXACT_75_CHILD';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO';

const ROTATION_SIDES = [TARGET_TRADE_SIDE];

const DEFAULT_TOP_N_PER_SIDE = 2;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_WEIGHTED_COMPLETED = 20;
const DEFAULT_MIN_MICRO_MICRO_COMPLETED = 35;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const DEFAULT_RECENT_MOMENTUM_LOOKBACK = 12;
const DEFAULT_STALE_WINNER_DAYS = 10;

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_STABLE_OUTCOME_DEDUPE_V2';
const POSITION_MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_V4';
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_MICRO_MICRO_LAYERING_V1';

const SETUP_TYPES = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_BUCKETS = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILES = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SETUP_SET = new Set(SETUP_TYPES);
const REGIME_SET = new Set(REGIME_BUCKETS);
const CONFIRMATION_SET = new Set(CONFIRMATION_PROFILES);

const MANUAL_ACTIVE_SOURCES = new Set([
  'ADMIN_MANUAL_SELECTION_SHORT_TRUE_MICRO_ONLY',
  'ADMIN_MANUAL_SELECTION_SHORT_75_CHILD_ONLY',
  'ADMIN_MANUAL_SELECTION_SHORT_MICRO_MICRO_ONLY',
  'ADMIN_MANUAL_SELECTION_SHORT_MICRO_MICRO_OR_75_CHILD',
  'ADMIN_ACTIVATE_SELECTED_SHORT_TRUE_MICROS',
  'ADMIN_ACTIVATE_SELECTED_SHORT_75_CHILD_TRUE_MICROS',
  'ADMIN_ACTIVATE_SELECTED_SHORT_MICRO_MICROS',
  'ADMIN_ACTIVATE_TOP_SHORT_TRUE_MICROS',
  'ADMIN_ACTIVATE_TOP_BALANCED_SHORT_TRUE_MICROS',
  'CLI_MANUAL_SELECTION_SHORT_ONLY',
  'CLI_MANUAL_SHORT_MICRO_FAMILY_DISCORD_SELECTION'
]);

function now() {
  return Date.now();
}

function namespacedShortKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}MISSING_KEY`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function activeRotationKey() {
  return namespacedShortKey(
    KEYS.short?.analyze?.activeRotation ||
      KEYS.analyze?.shortActiveRotation ||
      KEYS.analyze?.activeRotation,
    'ANALYZE:ACTIVE_ROTATION'
  );
}

function nextRotationKey() {
  return namespacedShortKey(
    KEYS.short?.analyze?.nextRotation ||
      KEYS.analyze?.shortNextRotation ||
      KEYS.analyze?.nextRotation,
    'ANALYZE:NEXT_ROTATION'
  );
}

function rotationValidFromKey() {
  return namespacedShortKey(
    KEYS.short?.analyze?.rotationValidFrom ||
      KEYS.analyze?.shortRotationValidFrom ||
      KEYS.analyze?.rotationValidFrom,
    'ANALYZE:ROTATION_VALID_FROM'
  );
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

function normalizeSchema(value) {
  return String(value || '').trim().toUpperCase();
}

function schemaMeta() {
  const macroSchema = normalizeSchema(
    CONFIG.short?.analyze?.macroSchema ||
      CONFIG.analyze?.macroSchema ||
      CONFIG.analyze?.legacySchema ||
      FALLBACK_MACRO_SCHEMA
  );

  return {
    schema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    macroSchema,
    microSchema: TRUE_MICRO_SCHEMA,
    parentMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    fallbackMicroSchema: normalizeSchema(
      CONFIG.short?.analyze?.microSchema ||
        CONFIG.analyze?.microSchema ||
        FALLBACK_MICRO_SCHEMA
    ),
    fallbackTrueMicroSchema: FALLBACK_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    strategyVersion: CONFIG.strategyVersion
  };
}

function learningDataKey(weekKey = PERSISTENT_LEARNING_KEY) {
  return String(
    CONFIG.short?.analyze?.persistentLearningKey ||
      CONFIG.short?.rotation?.persistentLearningKey ||
      CONFIG.analyze?.shortPersistentLearningKey ||
      weekKey ||
      PERSISTENT_LEARNING_KEY
  ).trim() || PERSISTENT_LEARNING_KEY;
}

function minWeightedCompleted() {
  return Math.max(
    0,
    safeNumber(
      CONFIG.short?.rotation?.minWeightedCompleted ??
        CONFIG.rotation?.minWeightedCompleted,
      DEFAULT_MIN_WEIGHTED_COMPLETED
    )
  );
}

function minMicroMicroCompleted() {
  return Math.max(
    minWeightedCompleted(),
    safeNumber(
      CONFIG.short?.rotation?.minMicroMicroCompleted ??
        CONFIG.rotation?.minMicroMicroCompleted,
      DEFAULT_MIN_MICRO_MICRO_COMPLETED
    )
  );
}

function topNPerSide() {
  const preferred =
    CONFIG.short?.rotation?.topNShort ??
    CONFIG.rotation?.topNShort ??
    CONFIG.rotation?.topNPerSide ??
    DEFAULT_TOP_N_PER_SIDE;

  const n = Math.floor(Number(preferred));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N_PER_SIDE;

  return Math.max(DEFAULT_TOP_N_PER_SIDE, Math.min(MAX_TOP_N_PER_SIDE, n));
}

function parentDiversificationEnabled() {
  return CONFIG.short?.rotation?.parentDiversificationEnabled !== false &&
    CONFIG.rotation?.parentDiversificationEnabled !== false;
}

function maxPerParentTrueMicroFamily() {
  const explicit =
    CONFIG.short?.rotation?.maxPerParentTrueMicroFamily ??
    CONFIG.short?.rotation?.maxPerMacroFamily ??
    CONFIG.rotation?.maxPerParentTrueMicroFamily ??
    CONFIG.rotation?.maxPerMacroFamily;

  const explicitNumber = Number(explicit);

  if (Number.isFinite(explicitNumber) && explicitNumber > 0) {
    return Math.floor(explicitNumber);
  }

  const legacyEnforce =
    CONFIG.short?.rotation?.enforceMaxPerParentTrueMicroFamily ??
    CONFIG.short?.rotation?.enforceMaxPerMacroFamily ??
    CONFIG.rotation?.enforceMaxPerMacroFamily;

  if (legacyEnforce === true) return 1;

  return parentDiversificationEnabled() ? DEFAULT_TOP_N_PER_SIDE : 0;
}

function minPrimaryRowsForPreviousMerge() {
  const n = Number(
    CONFIG.short?.rotation?.minPrimaryRowsForPreviousMerge ??
      CONFIG.rotation?.minPrimaryRowsForPreviousMerge ??
      0
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}

function defaultRotationMode() {
  return CONFIG.short?.rotation?.mode || CONFIG.rotation?.mode || 'adaptive';
}

function allowManualUnknownTrueMicroIds() {
  return CONFIG.short?.rotation?.allowManualUnknownTrueMicroIds !== false;
}

function allowSoftRotationFallback() {
  return CONFIG.short?.rotation?.allowSoftRotationFallback !== false;
}

function allowObservationRotationFallback() {
  return CONFIG.short?.rotation?.allowObservationRotationFallback !== false;
}

function allowRawRotationFallback() {
  return CONFIG.short?.rotation?.allowRawRotationFallback !== false;
}

function allowLegacyCompletedFallback() {
  return CONFIG.short?.analyze?.allowLegacyCompletedFallback === true ||
    CONFIG.analyze?.allowLegacyCompletedFallback === true;
}

function microMicroSelectionPreferred() {
  return CONFIG.short?.rotation?.microMicroSelectionPreferred !== false &&
    CONFIG.rotation?.microMicroSelectionPreferred !== false;
}

function exactChildFallbackEnabled() {
  return CONFIG.short?.rotation?.exactChildFallbackEnabled !== false &&
    CONFIG.rotation?.exactChildFallbackEnabled !== false;
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
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
    virtualTracked: true,
    shadowOnly: true,
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    noRealOrders: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    validShortRiskShape: 'entry > 0 && tp < entry && entry < sl',
    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortExitRules: {
      tp: 'price <= tp',
      sl: 'price >= sl',
      timeStop: 'TIME_STOP'
    },

    observationFirst: true,
    observationAlwaysCounted: false,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

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
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${DEFAULT_MIN_WEIGHTED_COMPLETED}`,
      ACTIVE_LEARNING: `completed >= ${DEFAULT_MIN_WEIGHTED_COMPLETED}`,
      MICRO_MICRO_ACTIVE: `completed >= ${DEFAULT_MIN_MICRO_MICRO_COMPLETED}`
    },

    defaultRanking: 'adaptiveScore|dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    rankingUsesAdaptiveScore: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,

    selectionUsesAdaptiveScore: true,
    parentDiversificationEnabled: parentDiversificationEnabled(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),

    recentMomentumScoreEnabled: true,
    currentFitScoreEnabled: true,
    adaptiveScoreEnabled: true,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionIsAdaptive: true,
    discordWillBeStrict: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_PREFERRED_FALLBACK_EXACT_75_CHILD',

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
    microMicroSelectionPreferred: microMicroSelectionPreferred(),
    exact75ChildFallbackEnabled: exactChildFallbackEnabled(),
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,
    parentSelectionAllowed: false,

    scannerSide: TARGET_SCANNER_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    fixedTaxonomyPreferred: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    childLearningEnabled: true,
    parentLearningEnabled: true,
    microMicroLearningEnabled: true,
    layeredLearningEnabled: true,
    sampleProtectionLayeringEnabled: true,
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    autoRotation: false,
    autoRotationDisabled: true,
    activateNextDisabled: true,
    activateCronDisabled: true,
    freezeCronDisabled: true,
    resetCronDisabled: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    learningDataKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,

    rootSide: TARGET_TRADE_SIDE,
    rootIsolated: true,
    longRootTouched: false
  };
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
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
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function normalizedSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizedSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`)
  ));
}

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ]);
}

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ]);
}

function isScannerFingerprintId(id = '') {
  const value = String(id || '').toUpperCase();

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
  const value = String(id || '').toUpperCase();

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes('__XR__') ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = rawId.toUpperCase();

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

  if (isScannerFingerprintId(value) || isExecutionFingerprintId(value)) {
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

  const mmMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);

  if (mmMatch) {
    baseValue = mmMatch[1];
    microMicroHash = mmMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
  }

  let body = baseValue.slice('MICRO_SHORT_'.length);
  let confirmationProfile = null;

  for (const profile of CONFIRMATION_PROFILES) {
    const suffix = `_${profile}`;

    if (body.endsWith(suffix)) {
      confirmationProfile = profile;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setupType = null;
  let regimeBucket = null;

  for (const candidateRegime of REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regimeBucket = candidateRegime;
      setupType = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setupType && regimeBucket
    ? `MICRO_SHORT_${setupType}_${regimeBucket}`
    : null;

  const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;

  const validParent =
    Boolean(parentId) &&
    SETUP_SET.has(setupType) &&
    REGIME_SET.has(regimeBucket);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    CONFIRMATION_SET.has(confirmationProfile);

  if (validChild && microMicroHash) {
    microMicroFamilyId = `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;
  }

  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;

  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isChild || isMicroMicro,

    isParent,
    isChild,
    isMicroMicro,
    isExactChild: validChild,

    rawId,
    id: microMicroFamilyId || childId || parentId || value,

    setupType,
    regimeBucket,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: isMicroMicro
      ? LAYER_MICRO_MICRO
      : isChild
        ? LAYER_MICRO_75
        : isParent
          ? LAYER_PARENT_15
          : 'UNKNOWN',

    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
}

function isFixedTaxonomyChildId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isFixedTaxonomyMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isFixedTaxonomyParentOnlyId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedTaxonomyParentContextId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.isParent || parsed.isChild || parsed.isMicroMicro;
}

function isSelectableLearningId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.isChild || parsed.isMicroMicro;
}

function learningLayerForId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return LAYER_MICRO_MICRO;
  if (parsed.isChild) return LAYER_MICRO_75;
  if (parsed.isParent) return LAYER_PARENT_15;

  return 'UNKNOWN';
}

function schemaForLearningId(id = '') {
  const layer = learningLayerForId(id);

  if (layer === LAYER_MICRO_MICRO) return MICRO_MICRO_SCHEMA;
  if (layer === LAYER_PARENT_15) return PARENT_TRUE_MICRO_SCHEMA;

  return TRUE_MICRO_SCHEMA;
}

function granularityForLearningId(id = '') {
  const layer = learningLayerForId(id);

  if (layer === LAYER_MICRO_MICRO) return MICRO_MICRO_LEARNING_GRANULARITY;
  if (layer === LAYER_PARENT_15) return PARENT_LEARNING_GRANULARITY;

  return LEARNING_GRANULARITY;
}

function selectionGranularityForId(id = '') {
  const layer = learningLayerForId(id);

  if (layer === LAYER_MICRO_MICRO) return SELECTION_EXACT_MICRO_MICRO;
  if (layer === LAYER_MICRO_75) return SELECTION_EXACT_75_CHILD;

  return SELECTION_PARENT_CONTEXT;
}

function minCompletedForId(id = '') {
  return learningLayerForId(id) === LAYER_MICRO_MICRO
    ? minMicroMicroCompleted()
    : minWeightedCompleted();
}

function cleanLearningMicroId(id = '') {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  return raw.toUpperCase();
}

function microMicroIdFromRow(row = {}) {
  const direct = cleanLearningMicroId(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      ''
  );

  if (isFixedTaxonomyMicroMicroId(direct)) return direct;

  const trueId = cleanLearningMicroId(row.trueMicroFamilyId || row.microFamilyId || '');

  if (isFixedTaxonomyMicroMicroId(trueId)) return trueId;

  return '';
}

function childTrueMicroFamilyIdFrom(row = {}) {
  const mm = microMicroIdFromRow(row);

  if (mm) {
    return parseShortTaxonomyMicroId(mm).childTrueMicroFamilyId || '';
  }

  const direct = cleanLearningMicroId(
    row.childTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.analyzeMicroFamilyId ||
      row.learningMicroFamilyId ||
      row.broadTrueMicroFamilyId ||
      ''
  );

  const parsed = parseShortTaxonomyMicroId(direct);

  if (parsed.isMicroMicro || parsed.isChild) {
    return parsed.childTrueMicroFamilyId || '';
  }

  return '';
}

function rowId(row = {}) {
  const directMicroMicro = microMicroIdFromRow(row);

  if (directMicroMicro) return directMicroMicro;

  const raw = cleanLearningMicroId(
    row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.broadTrueMicroFamilyId ||
      row.id ||
      row.key ||
      ''
  );

  if (!raw) return '';

  const parsed = parseShortTaxonomyMicroId(raw);

  if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
  if (parsed.isChild) return parsed.childTrueMicroFamilyId;
  if (parsed.isParent) return parsed.parentTrueMicroFamilyId;

  return raw;
}

function rowIdUpper(row = {}) {
  return rowId(row).toUpperCase();
}

function parentTrueMicroFamilyIdFrom(row = {}) {
  const direct = cleanLearningMicroId(
    row.parentTrueMicroFamilyId ||
      row.coarseMicroFamilyId ||
      row.baseMicroFamilyId ||
      row.legacyMicroFamilyId ||
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
  );

  const directParsed = parseShortTaxonomyMicroId(direct);

  if (directParsed.valid) {
    return directParsed.parentTrueMicroFamilyId;
  }

  const id = rowId(row);
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.valid) {
    return parsed.parentTrueMicroFamilyId;
  }

  return '';
}

function idLooksLikeMicroFamily(id = '') {
  return String(id || '').toUpperCase().startsWith('MICRO_');
}

function idLooksLikeShortFamily(id = '') {
  return hasShortSignal(id);
}

function idLooksLikeLongFamily(id = '') {
  return hasLongSignal(id);
}

function idLooksLikeSimpleMacroFamily(id = '') {
  const value = String(id || '').trim().toUpperCase();

  return (
    /^SHORT_F\d+$/u.test(value) ||
    /^SHORT_\d+$/u.test(value)
  );
}

function hasSchemaInId(id, schema) {
  const s = normalizeSchema(schema);
  const value = String(id || '').toUpperCase();

  if (!s) return false;

  return (
    value.includes(`_${s}_`) ||
    value.endsWith(`_${s}`) ||
    value.includes(`|SCHEMA=${s}`) ||
    value.includes(`SCHEMA=${s}`)
  );
}

function definitionText(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function definitionHasSchema(row = {}, schema) {
  const s = normalizeSchema(schema);

  if (!s) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
    return true;
  }

  return definitionText(row).includes(`SCHEMA=${s}`);
}

function rowSchema(row = {}) {
  return normalizeSchema(
    row.microFamilySchema ||
      row.trueMicroFamilySchema ||
      row.schema ||
      row.versionSchema ||
      ''
  );
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

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
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) {
      return TARGET_TRADE_SIDE;
    }

    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function definitionSide(row = {}) {
  const text = definitionText(row);
  const shortHit = hasShortSignal(text);
  const longHit = hasLongSignal(text);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) {
      return TARGET_TRADE_SIDE;
    }

    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function microSide(row = {}) {
  const direct = normalizeDirectSide(
    row.tradeSide ||
      row.positionSide ||
      row.direction ||
      row.signalSide ||
      row.scannerSide ||
      row.actualScannerSide ||
      row.analysisSide ||
      row.entrySide ||
      row.side
  );

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const familyId = String(row.familyId || '').toUpperCase();
  const parentId = String(parentTrueMicroFamilyIdFrom(row) || '').toUpperCase();
  const microId = rowIdUpper(row);

  if (familyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(parentId) && !idLooksLikeShortFamily(parentId)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(microId) && !idLooksLikeShortFamily(microId)) return OPPOSITE_TRADE_SIDE;

  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (parentId.startsWith('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
  if (parentId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(parentId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(microId)) return TARGET_TRADE_SIDE;

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (fromDefinition === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  const side = microSide(row);

  if (side === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return 'unknown';
}

function isShortRotationRow(row = {}) {
  return microSide(row) === TARGET_TRADE_SIDE;
}

export function isTrueMicroFamily(row = {}) {
  const id = rowIdUpper(row);

  if (!row || !id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isShortRotationRow(row)) return false;

  return isSelectableLearningId(id);
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowIdUpper(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isShortRotationRow(row)) return false;
  if (isTrueMicroFamily(row)) return false;

  if (isFixedTaxonomyParentOnlyId(id)) return true;
  if (row.parentTrueMicroFamilySchema === PARENT_TRUE_MICRO_SCHEMA) return true;
  if (schema === PARENT_TRUE_MICRO_SCHEMA) return true;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO') || version.includes('PARENT')) return true;
  if (idLooksLikeSimpleMacroFamily(id)) return true;
  if (schema === macroSchema) return true;
  if (hasSchemaInId(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return false;
}

function isKnownTrueMicroId(id = '') {
  const value = cleanLearningMicroId(id);

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;
  if (!idLooksLikeShortFamily(value)) return false;
  if (idLooksLikeLongFamily(value) && !idLooksLikeShortFamily(value)) return false;
  if (!idLooksLikeMicroFamily(value)) return false;

  return isSelectableLearningId(value);
}

function recentClosedVirtualOutcomeCount(row = {}) {
  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  return recent.filter((outcome) => {
    const source = String(outcome?.source || outcome?.outcomeSource || '').toUpperCase();
    const hasR = Number.isFinite(Number(
      outcome?.netR ??
        outcome?.exitR ??
        outcome?.realizedNetR ??
        outcome?.realizedR ??
        outcome?.r
    ));

    return hasR && ['VIRTUAL', 'SHADOW'].includes(source);
  }).length;
}

function completedCount(row = {}) {
  const virtualCompleted = safeNumber(row.virtualCompleted, 0);
  const shadowCompleted = safeNumber(row.shadowCompleted, 0);
  const closed = virtualCompleted + shadowCompleted;

  if (closed > 0) return closed;

  const recentClosed = recentClosedVirtualOutcomeCount(row);

  if (recentClosed > 0) return recentClosed;

  if (allowLegacyCompletedFallback()) {
    return Math.max(0, safeNumber(row.completed, 0));
  }

  return 0;
}

function observationSample(row = {}) {
  return Math.max(
    safeNumber(row.observationSample, 0),
    safeNumber(row.seen, 0),
    safeNumber(row.observations, 0),
    completedCount(row),
    0
  );
}

function learningStatus(row = {}) {
  const completed = completedCount(row);
  const id = rowId(row);
  const minCompleted = minCompletedForId(id);

  if (completed >= minCompleted) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function isEligible(row = {}) {
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return completedCount(row) >= minCompletedForId(rowId(row));
}

function isSoftEligible(row = {}) {
  if (!allowSoftRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const completed = completedCount(row);
  const adaptiveScore = adaptiveSelectionScore(row);
  const balancedScore = safeNumber(
    row.dashboardBalancedScore ?? row.balancedScore,
    0
  );

  if (completed <= 0) return false;
  if (Math.max(adaptiveScore, balancedScore) <= 0) return false;

  return (
    safeNumber(row.avgR, 0) > 0 ||
    safeNumber(row.totalR, 0) > 0 ||
    safeNumber(row.fairWinrate, 0) > 0 ||
    safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
    safeNumber(row.wilsonLowerBound, 0) > 0 ||
    safeNumber(row.sampleWilsonLowerBound, 0) > 0
  );
}

function isObservationEligible(row = {}) {
  if (!allowObservationRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return observationSample(row) > 0;
}

function isRawFallbackEligible(row = {}) {
  if (!allowRawRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return true;
}

function rotationEligibilityTier(row = {}) {
  if (isEligible(row)) return 'HARD';
  if (isSoftEligible(row)) return 'SOFT';
  if (isObservationEligible(row)) return 'OBSERVATION';
  if (isRawFallbackEligible(row)) return 'RAW';

  return 'NONE';
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function bounded(value, min = 0, max = 100) {
  const n = safeNumber(value, min);

  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function recentMomentumLookback() {
  const n = Number(
    CONFIG.short?.rotation?.recentMomentumLookback ??
      CONFIG.rotation?.recentMomentumLookback ??
      DEFAULT_RECENT_MOMENTUM_LOOKBACK
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_RECENT_MOMENTUM_LOOKBACK;
}

function staleWinnerDays() {
  const n = Number(
    CONFIG.short?.rotation?.staleWinnerDays ??
      CONFIG.rotation?.staleWinnerDays ??
      DEFAULT_STALE_WINNER_DAYS
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_STALE_WINNER_DAYS;
}

function marketBiasText(row = {}) {
  return [
    row.currentFit,
    row.entryCurrentFit,
    row.currentMarketFit,
    row.currentRegime,
    row.entryCurrentRegime,
    row.currentTrendSide,
    row.entryCurrentTrendSide,
    row.currentMarketNote,
    row.currentFitReason,
    row.marketBias,
    row.bias,
    row.side,
    row.tradeSide,
    row.positionSide,
    row.direction
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');
}

function hasBearishBias(row = {}) {
  const text = marketBiasText(row);

  return (
    text.includes('BEAR') ||
    text.includes('BEARISH') ||
    text.includes('SHORT') ||
    text.includes('SELL') ||
    text.includes('DOWNSIDE') ||
    text.includes('DOWN')
  );
}

function hasBullishBias(row = {}) {
  const text = marketBiasText(row);

  return (
    text.includes('BULL') ||
    text.includes('BULLISH') ||
    text.includes('LONG') ||
    text.includes('BUY') ||
    text.includes('UPSIDE') ||
    text.includes('UP')
  );
}

function currentFitScore(row = {}) {
  const explicitShort = finiteOrNull(
    row.shortCurrentFitScore ??
      row.bearCurrentFitScore ??
      row.bearishCurrentFitScore ??
      row.entryShortCurrentFitScore ??
      row.entryBearCurrentFitScore
  );

  if (explicitShort !== null) return bounded(explicitShort, -100, 100);

  const explicitLong = finiteOrNull(
    row.longCurrentFitScore ??
      row.bullCurrentFitScore ??
      row.bullishCurrentFitScore ??
      row.entryLongCurrentFitScore ??
      row.entryBullCurrentFitScore
  );

  if (explicitLong !== null) return bounded(-Math.abs(explicitLong), -100, 100);

  const generic = finiteOrNull(
    row.currentFitScore ??
      row.entryCurrentFitScore ??
      row.marketFitScore ??
      row.currentMarketFitScore
  );

  if (generic !== null) {
    if (hasBearishBias(row)) return bounded(Math.abs(generic), -100, 100);
    if (hasBullishBias(row)) return bounded(-Math.abs(generic), -100, 100);

    return bounded(-generic, -100, 100);
  }

  const fit = String(
    row.shortCurrentFit ??
      row.bearCurrentFit ??
      row.bearishCurrentFit ??
      row.currentFit ??
      row.entryCurrentFit ??
      row.currentMarketFit ??
      ''
  ).toUpperCase();

  const confidence = bounded(
    row.currentFitConfidence ??
      row.entryCurrentFitConfidence ??
      row.currentMarketFitConfidence ??
      50,
    0,
    100
  );

  if (!fit) {
    if (hasBearishBias(row)) return confidence / 2;
    if (hasBullishBias(row)) return -confidence / 2;

    return 0;
  }

  if (
    fit === 'MATCH' ||
    fit === 'FIT' ||
    fit === 'GOOD' ||
    fit === 'STRONG' ||
    fit === 'ALIGNED' ||
    fit.includes('MATCH') ||
    fit.includes('ALIGNED') ||
    fit.includes('BEAR') ||
    fit.includes('SHORT') ||
    fit.includes('SELL')
  ) {
    if (fit.includes('BULL') || fit.includes('LONG') || fit.includes('BUY')) {
      return -confidence / 2;
    }

    return confidence / 2;
  }

  if (
    fit === 'MISFIT' ||
    fit === 'BAD' ||
    fit === 'WEAK' ||
    fit === 'CONTRA' ||
    fit === 'AGAINST' ||
    fit.includes('MISFIT') ||
    fit.includes('CONTRA') ||
    fit.includes('AGAINST') ||
    fit.includes('BULL') ||
    fit.includes('LONG') ||
    fit.includes('BUY')
  ) {
    return -confidence / 2;
  }

  return 0;
}

function currentContraPenalty(row = {}) {
  const explicit = finiteOrNull(row.currentContraPenalty);

  if (explicit !== null) return Math.max(0, explicit);

  const text = marketBiasText(row);

  if (
    text.includes('CONTRA') ||
    text.includes('AGAINST') ||
    text.includes('MISFIT') ||
    text.includes('BULL') ||
    text.includes('LONG') ||
    text.includes('BUY')
  ) {
    return 12;
  }

  return 0;
}

function recentMomentumScore(row = {}) {
  const explicit = finiteOrNull(row.recentMomentumScore);

  if (explicit !== null) return bounded(explicit, -100, 100);

  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  if (!recent.length) return 0;

  const rows = recent
    .filter((outcome) => {
      const source = String(outcome?.source || outcome?.outcomeSource || '').toUpperCase();

      return source === 'VIRTUAL' || source === 'SHADOW';
    })
    .slice(-recentMomentumLookback());

  if (!rows.length) return 0;

  const total = rows.reduce((sum, outcome) => {
    return sum + safeNumber(
      outcome.netR ??
        outcome.exitR ??
        outcome.realizedNetR ??
        outcome.realizedR ??
        outcome.r,
      0
    );
  }, 0);

  const avg = total / rows.length;
  const hitRate = rows.filter((outcome) => {
    const netR = safeNumber(
      outcome.netR ??
        outcome.exitR ??
        outcome.realizedNetR ??
        outcome.realizedR ??
        outcome.r,
      0
    );

    return netR > 0;
  }).length / rows.length;

  return bounded(
    avg * 18 +
      (hitRate - 0.5) * 24,
    -35,
    35
  );
}

function staleWinnerPenalty(row = {}) {
  const explicit = finiteOrNull(row.staleWinnerPenalty);

  if (explicit !== null) return Math.max(0, explicit);

  const completed = completedCount(row);
  const observations = observationSample(row);
  const totalR = safeNumber(row.totalR, 0);
  const updatedAt = safeNumber(row.updatedAt || row.lastOutcomeAt || row.lastSeenAt, 0);

  if (completed <= 0 || totalR <= 0) return 0;
  if (observations > completed) return 0;
  if (updatedAt <= 0) return 0;

  const ageMs = now() - updatedAt;
  const maxAgeMs = staleWinnerDays() * 24 * 60 * 60 * 1000;

  if (ageMs <= maxAgeMs) return 0;

  return Math.min(25, ((ageMs - maxAgeMs) / maxAgeMs) * 10);
}

function avgCostPenalty(row = {}) {
  const avgCostR = Math.max(0, safeNumber(row.avgCostR, 0));

  return Math.min(30, avgCostR * 8);
}

function directSLPenalty(row = {}) {
  const pct = Math.max(0, safeNumber(row.directSLPct, 0));

  return Math.min(25, pct * 0.25);
}

function parentDiversificationBonus(row = {}, countsByParent = {}) {
  if (!parentDiversificationEnabled()) return 0;

  const parentId = parentTrueMicroFamilyIdFrom(row);

  if (!parentId) return 0;

  const selected = safeNumber(countsByParent[parentId], 0);

  if (selected <= 0) return 8;

  return Math.max(-20, -selected * 12);
}

function layerSelectionBonus(row = {}) {
  const layer = learningLayerForId(rowId(row));

  if (layer === LAYER_MICRO_MICRO) {
    return microMicroSelectionPreferred() ? 10 : 0;
  }

  if (layer === LAYER_MICRO_75) {
    return exactChildFallbackEnabled() ? 2 : -10;
  }

  return -50;
}

function adaptiveSelectionScore(row = {}, {
  countsByParent = null
} = {}) {
  const explicit = finiteOrNull(row.adaptiveScore);

  if (explicit !== null) return explicit;

  const balanced = safeNumber(row.dashboardBalancedScore ?? row.balancedScore, 0);
  const fair = safeNumber(row.fairWinrate ?? row.sampleAdjustedWinrate, 0);
  const totalR = safeNumber(row.totalR, 0);
  const avgR = safeNumber(row.avgR, 0);
  const completed = completedCount(row);
  const observations = observationSample(row);
  const minCompleted = minCompletedForId(rowId(row));

  const qualityBonus =
    completed >= minCompleted
      ? 20
      : completed > 0
        ? 10
        : observations > 0
          ? 2
          : 0;

  const observationBonus =
    completed <= 0 && observations > 0
      ? Math.min(8, Math.log1p(observations) * 2)
      : 0;

  return (
    balanced +
    fair * 30 +
    Math.log1p(Math.max(0, totalR)) * 10 +
    Math.log1p(Math.max(0, avgR)) * 8 +
    recentMomentumScore(row) +
    currentFitScore(row) +
    layerSelectionBonus(row) +
    qualityBonus +
    observationBonus +
    (countsByParent ? parentDiversificationBonus(row, countsByParent) : 0) -
    staleWinnerPenalty(row) -
    currentContraPenalty(row) -
    avgCostPenalty(row) -
    directSLPenalty(row)
  );
}

function compareAdaptiveRows(a, b) {
  return (
    adaptiveSelectionScore(b) - adaptiveSelectionScore(a) ||
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.fairWinrate ?? b.sampleAdjustedWinrate, 0) -
      safeNumber(a.fairWinrate ?? a.sampleAdjustedWinrate, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
    String(rowId(a)).localeCompare(String(rowId(b)))
  );
}

function sortAdaptiveRows(rows = []) {
  return [...rows].sort(compareAdaptiveRows);
}

function isManualEligible(row = {}) {
  return isShortRotationRow(row) && isTrueMicroFamily(row);
}

function isManualActiveRotation(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') return false;

  const source = String(rotation.source || '').trim().toUpperCase();
  const mode = String(rotation.mode || '').trim().toUpperCase();

  if (rotation.manualOnly === true) return true;
  if (rotation.adminSelected === true) return true;
  if (mode === 'MANUAL' || mode === 'SELECTED') return true;
  if (source.includes('MANUAL')) return true;
  if (source.includes('SELECTED')) return true;
  if (source.startsWith('ADMIN_')) return true;
  if (source.startsWith('CLI_MANUAL')) return true;
  if (MANUAL_ACTIVE_SOURCES.has(source)) return true;

  return false;
}

function taxonomyMetaForId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  if (!parsed.valid) {
    return {
      setupType: null,
      regimeBucket: null,
      confirmationProfile: null,
      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      microMicroFamilyId: null,
      microMicroHash: null,
      fixedTaxonomyLearningId: false,
      selectable: false,
      learningLayer: 'UNKNOWN',
      selectionGranularity: 'UNKNOWN'
    };
  }

  return {
    setupType: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
    confirmationProfile: parsed.confirmationProfile,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    microMicroFamilyId: parsed.microMicroFamilyId,
    trueMicroMicroFamilyId: parsed.trueMicroMicroFamilyId,
    exactMicroMicroFamilyId: parsed.exactMicroMicroFamilyId,
    microMicroHash: parsed.microMicroHash,
    fixedTaxonomyLearningId: parsed.isChild || parsed.isMicroMicro,
    selectable: parsed.isChild || parsed.isMicroMicro,
    learningLayer: parsed.learningLayer,
    selectionGranularity: parsed.isMicroMicro
      ? SELECTION_EXACT_MICRO_MICRO
      : parsed.isChild
        ? SELECTION_EXACT_75_CHILD
        : SELECTION_PARENT_CONTEXT
  };
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const meta = schemaMeta();

  const microFamilyId = rowId(refreshed);
  const taxonomy = taxonomyMetaForId(microFamilyId);
  const parentId = taxonomy.parentTrueMicroFamilyId || parentTrueMicroFamilyIdFrom(refreshed);
  const childId = taxonomy.childTrueMicroFamilyId || childTrueMicroFamilyIdFrom(refreshed);
  const microMicroId = taxonomy.microMicroFamilyId || microMicroIdFromRow(refreshed) || null;

  const completed = completedCount(refreshed);
  const minCompleted = minCompletedForId(microFamilyId);
  const status = learningStatus(refreshed);

  const adaptiveScore = adaptiveSelectionScore(refreshed);
  const recentMomentum = recentMomentumScore(refreshed);
  const fitScore = currentFitScore(refreshed);
  const contraPenalty = currentContraPenalty(refreshed);
  const costPenalty = avgCostPenalty(refreshed);
  const stalePenalty = staleWinnerPenalty(refreshed);
  const dslPenalty = directSLPenalty(refreshed);

  const layer = taxonomy.learningLayer || learningLayerForId(microFamilyId);
  const schema = schemaForLearningId(microFamilyId);
  const granularity = granularityForLearningId(microFamilyId);
  const selectionGranularity = selectionGranularityForId(microFamilyId);

  return {
    rank,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    analyzeMicroFamilyId: microFamilyId,
    learningMicroFamilyId: microFamilyId,

    childTrueMicroFamilyId: childId || null,
    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: taxonomy.microMicroHash || refreshed.microMicroHash || refreshed.executionFingerprintHash || null,

    familyId: refreshed.familyId || null,

    coarseMicroFamilyId: parentId || null,
    baseMicroFamilyId: parentId || null,
    legacyMicroFamilyId: parentId || null,

    macroFamilyId: parentId || null,
    parentMacroFamilyId: parentId || null,
    parentMicroFamilyId: parentId || null,
    parentTrueMicroFamilyId: parentId || null,

    side,
    tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    schema,
    microFamilySchema: schema,
    trueMicroFamilySchema: schema,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: schema,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    parentMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    version: refreshed.version || 'short-layered-parent-micro-micro-rotation-v1',
    microMicroVersion: MICRO_MICRO_VERSION,

    isTrueMicro: isTrueMicroFamily(refreshed),
    isChildTrueMicro: isFixedTaxonomyChildId(microFamilyId),
    isMicroMicro: isFixedTaxonomyMicroMicroId(microFamilyId),
    isLegacyMacro: false,
    isParentTrueMicro: false,
    selectable: isKnownTrueMicroId(microFamilyId),
    selectionGranularity,
    learningLayer: layer,
    layer,
    parentSelectionAllowed: false,

    setupType: refreshed.setupType || taxonomy.setupType,
    regimeBucket: refreshed.regimeBucket || taxonomy.regimeBucket,
    confirmationProfile: refreshed.confirmationProfile || taxonomy.confirmationProfile,
    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId || Boolean(refreshed.fixedTaxonomyLearningId),

    learningGranularity: granularity,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    rotationEligibilityTier: rotationEligibilityTier(refreshed),
    rotationEligible: rotationEligibilityTier(refreshed) !== 'NONE',
    hardEligible: rotationEligibilityTier(refreshed) === 'HARD',
    softEligible: rotationEligibilityTier(refreshed) === 'SOFT',
    observationEligible: rotationEligibilityTier(refreshed) === 'OBSERVATION',
    rawEligible: rotationEligibilityTier(refreshed) === 'RAW',

    learningStatus: status,
    status,
    minCompletedForActiveLearning: minCompleted,
    tooEarly: completed < minCompleted,
    tooEarlyReason: completed < minCompleted
      ? `completed ${completed}/${minCompleted}`
      : null,

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),
    observationSample: observationSample(refreshed),
    observationAlwaysCounted: false,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    completed,
    outcomeSample: completed,

    realCompleted: 0,
    virtualCompleted: safeNumber(refreshed.virtualCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrateSample: safeNumber(refreshed.winrateSample ?? completed, 0),
    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    sampleWilsonLowerBound: safeNumber(
      refreshed.sampleWilsonLowerBound ?? refreshed.wilsonLowerBound,
      0
    ),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),
    sampleAdjustedWinrate: safeNumber(refreshed.sampleAdjustedWinrate, 0),
    sampleReliability: safeNumber(refreshed.sampleReliability, 0),

    avgR: safeNumber(refreshed.avgR ?? refreshed.avgNetR ?? refreshed.netAvgR, 0),
    totalR: safeNumber(refreshed.totalR ?? refreshed.netTotalR ?? refreshed.totalNetR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(
      refreshed.dashboardBalancedScore ?? refreshed.balancedScore,
      0
    ),

    recentMomentumScore: recentMomentum,
    currentFitScore: fitScore,
    shortCurrentFitScore: fitScore,
    bearCurrentFitScore: fitScore,
    longCurrentFitScore: -Math.abs(fitScore),
    bullCurrentFitScore: -Math.abs(fitScore),
    currentContraPenalty: contraPenalty,
    avgCostPenalty: costPenalty,
    staleWinnerPenalty: stalePenalty,
    directSLPenalty: dslPenalty,
    layerSelectionBonus: layerSelectionBonus(refreshed),
    adaptiveScore,

    adaptiveScoreFormula:
      'balancedScore + fairWinrate + totalR + avgR + recentMomentumScore + shortCurrentFitScore + layerSelectionBonus + parentDiversificationBonus - staleWinnerPenalty - currentContraPenalty - avgCostPenalty - directSLPenalty',

    adaptiveSelectionEnabled: true,
    parentDiversificationEnabled: parentDiversificationEnabled(),
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionIsAdaptive: true,
    discordWillBeStrict: true,

    currentFit: fitScore,
    shortCurrentFit: fitScore,
    bearCurrentFit: fitScore,
    bullishCurrentFit: -Math.abs(fitScore),
    longCurrentFit: -Math.abs(fitScore),
    currentFitConfidence: refreshed.currentFitConfidence ?? refreshed.entryCurrentFitConfidence ?? null,
    currentRegime: refreshed.currentRegime ?? refreshed.entryCurrentRegime ?? null,
    currentTrendSide: refreshed.currentTrendSide ?? refreshed.entryCurrentTrendSide ?? null,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    assetClass: refreshed.assetClass || null,

    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,

    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,

    obRelation: refreshed.obRelation || null,

    btcState: refreshed.btcState || null,
    btcRelation: refreshed.btcRelation || null,

    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,

    scannerReason: refreshed.scannerReason || null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,

    scannerMicroFamilyId: refreshed.scannerMicroFamilyId || null,
    scannerFamilyId: refreshed.scannerFamilyId || null,
    scannerDefinition: refreshed.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(refreshed.scannerDefinitionParts)
      ? refreshed.scannerDefinitionParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: refreshed.executionMicroFamilyId || null,
    executionFingerprintHash: refreshed.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(refreshed.executionFingerprintParts)
      ? refreshed.executionFingerprintParts
      : [],
    executionFingerprintRole: refreshed.executionFingerprintRole || 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: layer !== LAYER_MICRO_MICRO,
    executionFingerprintsUsedAsLearningFamily: layer === LAYER_MICRO_MICRO,

    microMicroDefinitionParts: Array.isArray(refreshed.microMicroDefinitionParts)
      ? refreshed.microMicroDefinitionParts
      : [],

    microMicroDefinition: refreshed.microMicroDefinition || '',

    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    definitionParts: Array.isArray(refreshed.definitionParts)
      ? refreshed.definitionParts
      : [],

    definition: refreshed.definition || '',

    parentDefinitionParts: Array.isArray(refreshed.parentDefinitionParts)
      ? refreshed.parentDefinitionParts
      : [],

    parentDefinition: refreshed.parentDefinition || '',

    counters: refreshed.counters || {},

    examples: Array.isArray(refreshed.examples)
      ? refreshed.examples.slice(0, 20)
      : [],

    recentOutcomes: Array.isArray(refreshed.recentOutcomes)
      ? refreshed.recentOutcomes.slice(0, 20)
      : [],

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: refreshed.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      refreshed.positionMeasurementFixVersion ||
      refreshed.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: refreshed.riskPlanVersion || SHORT_RISK_PLAN_VERSION,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    fallbackTrueMicroSchema: meta.fallbackTrueMicroSchema
  };
}

function canUseParentSlot({
  row,
  countsByParent
}) {
  const parentCap = maxPerParentTrueMicroFamily();

  if (parentCap <= 0) return true;

  const parentId = parentTrueMicroFamilyIdFrom(row);

  if (!parentId) return true;

  return safeNumber(countsByParent[parentId], 0) < parentCap;
}

function reserveParentSlot({
  row,
  countsByParent
}) {
  const parentId = parentTrueMicroFamilyIdFrom(row);

  if (!parentId) return;

  countsByParent[parentId] = safeNumber(countsByParent[parentId], 0) + 1;
}

function addSelectedRow({
  row,
  selected,
  selectedIds,
  countsBySide,
  countsByParent
}) {
  const id = rowId(row);
  const side = microSide(row);
  const parsed = parseShortTaxonomyMicroId(id);

  if (!id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isKnownTrueMicroId(id)) return false;
  if (selectedIds.has(id)) return false;
  if (side !== TARGET_TRADE_SIDE) return false;
  if (!isTrueMicroFamily(row)) return false;
  if (!canUseParentSlot({ row, countsByParent })) return false;

  selectedIds.add(id);
  countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0) + 1;
  reserveParentSlot({ row, countsByParent });

  selected.push({
    ...row,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || childTrueMicroFamilyIdFrom(row),
    microMicroFamilyId: parsed.microMicroFamilyId || microMicroIdFromRow(row) || null,
    trueMicroMicroFamilyId: parsed.microMicroFamilyId || microMicroIdFromRow(row) || null,
    exactMicroMicroFamilyId: parsed.microMicroFamilyId || microMicroIdFromRow(row) || null,

    parentTrueMicroFamilyId: parentTrueMicroFamilyIdFrom(row),
    adaptiveScore: adaptiveSelectionScore(row, { countsByParent }),
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  });

  return true;
}

function buildSelectionState(existing = []) {
  const selected = [];
  const selectedIds = new Set();
  const countsBySide = {
    [TARGET_TRADE_SIDE]: 0
  };
  const countsByParent = {};

  for (const row of existing) {
    addSelectedRow({
      row,
      selected,
      selectedIds,
      countsBySide,
      countsByParent
    });
  }

  return {
    selected,
    selectedIds,
    countsBySide,
    countsByParent
  };
}

function appendRowsToSelection({
  state,
  rows = [],
  targetCount = topNPerSide()
}) {
  const sortedRows = sortAdaptiveRows(rows);

  for (const row of sortedRows) {
    if (state.countsBySide[TARGET_TRADE_SIDE] >= targetCount) break;

    addSelectedRow({
      row,
      selected: state.selected,
      selectedIds: state.selectedIds,
      countsBySide: state.countsBySide,
      countsByParent: state.countsByParent
    });
  }

  return state.selected;
}

function hasSelectedSide(rows = [], side) {
  return rows.some((row) => microSide(row) === side);
}

function missingSides(rows = []) {
  return ROTATION_SIDES.filter((side) => !hasSelectedSide(rows, side));
}

function selectRotationCandidates(rankedCandidates = []) {
  const trueShortCandidates = sortAdaptiveRows(
    rankedCandidates
      .filter(isShortRotationRow)
      .filter(isTrueMicroFamily)
  );

  const microMicroRows = trueShortCandidates.filter((row) => isFixedTaxonomyMicroMicroId(rowId(row)));
  const childRows = trueShortCandidates.filter((row) => isFixedTaxonomyChildId(rowId(row)));

  const preferredRows = microMicroSelectionPreferred()
    ? [...microMicroRows, ...childRows]
    : [...childRows, ...microMicroRows];

  const hardEligible = sortAdaptiveRows(preferredRows.filter(isEligible));

  const softEligible = sortAdaptiveRows(
    preferredRows
      .filter((row) => !isEligible(row))
      .filter(isSoftEligible)
  );

  const observationEligible = sortAdaptiveRows(
    preferredRows
      .filter((row) => !isEligible(row))
      .filter((row) => !isSoftEligible(row))
      .filter(isObservationEligible)
  );

  const rawFallback = sortAdaptiveRows(
    preferredRows
      .filter((row) => !isEligible(row))
      .filter((row) => !isSoftEligible(row))
      .filter((row) => !isObservationEligible(row))
      .filter(isRawFallbackEligible)
  );

  const targetCount = topNPerSide();
  const state = buildSelectionState();

  appendRowsToSelection({
    state,
    rows: hardEligible,
    targetCount
  });

  if (allowSoftRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: softEligible,
      targetCount
    });
  }

  if (allowObservationRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: observationEligible,
      targetCount
    });
  }

  if (allowRawRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: rawFallback,
      targetCount
    });
  }

  return {
    selected: state.selected,
    eligible: hardEligible,
    softEligible,
    observationEligible,
    rawFallback,

    usedSoftFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'SOFT'),
    usedObservationFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'OBSERVATION'),
    usedRawFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'RAW'),

    parentDiversificationEnabled: parentDiversificationEnabled(),
    countsByParent: state.countsByParent,
    missingSides: missingSides(state.selected)
  };
}

function filterRankedRows(rows = [], filter = 'selectable') {
  const shortRows = rows.filter(isShortRotationRow);

  if (filter === 'all') return shortRows;
  if (filter === 'parent15') return shortRows.filter(isLegacyMacroFamily);
  if (filter === 'legacyMacro') return shortRows.filter(isLegacyMacroFamily);
  if (filter === 'microMicro') return shortRows.filter((row) => isFixedTaxonomyMicroMicroId(rowId(row)));
  if (filter === 'child75') return shortRows.filter((row) => isFixedTaxonomyChildId(rowId(row)));
  if (filter === 'trueMicro') return shortRows.filter(isTrueMicroFamily);

  return shortRows.filter(isTrueMicroFamily);
}

function buildRankings(micros, { filter = 'selectable' } = {}) {
  const modes = [
    'adaptive',
    'balanced',
    'winrate',
    'totalR',
    'avgR',
    'directSL',
    'observed'
  ];

  return Object.fromEntries(
    modes.map((mode) => {
      const rankedMode = mode === 'adaptive' ? 'balanced' : mode;

      const rows = sortAdaptiveRows(
        filterRankedRows(rankMicros(micros, rankedMode), filter)
      )
        .slice(0, MAX_TOP_N_PER_SIDE)
        .map((row, index) => compactRotationRow(row, index + 1))
        .filter((row) => {
          if (filter === 'parent15') return isFixedTaxonomyParentContextId(row.microFamilyId);
          if (filter === 'all') return true;

          return isKnownTrueMicroId(row.microFamilyId);
        });

      return [mode, rows];
    })
  );
}

function buildSelectionIndexes(microFamilies = []) {
  const shortRows = microFamilies
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily);

  const microFamilyIds = uniqueStrings(
    shortRows.map((row) => row.trueMicroFamilyId || row.microFamilyId)
  )
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .filter(isKnownTrueMicroId);

  const microMicroFamilyIds = uniqueStrings(
    shortRows.map((row) => row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId || rowId(row))
  )
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .filter(isFixedTaxonomyMicroMicroId);

  const childTrueMicroFamilyIds = uniqueStrings(
    shortRows.map((row) => row.childTrueMicroFamilyId || childTrueMicroFamilyIdFrom(row) || rowId(row))
  )
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
    .filter(Boolean)
    .filter(isFixedTaxonomyChildId);

  const parentTrueMicroFamilyIds = uniqueStrings(
    shortRows.map((row) => row.parentTrueMicroFamilyId || parentTrueMicroFamilyIdFrom(row))
  )
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .filter((id) => parseShortTaxonomyMicroId(id).valid)
    .map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
    .filter(Boolean);

  const microToParentTrueMicroFamilyId = {};
  const microToChildTrueMicroFamilyId = {};
  const microToMicroMicroFamilyId = {};
  const childTrueMicroFamilyToMicroMicroFamilyIds = {};
  const parentTrueMicroFamilyToMicroFamilyIds = {};

  for (const row of shortRows) {
    const selectedId = cleanLearningMicroId(row.trueMicroFamilyId || row.microFamilyId || rowId(row));
    const parsed = parseShortTaxonomyMicroId(selectedId);

    if (!selectedId || !parsed.valid || !isKnownTrueMicroId(selectedId)) continue;

    const childId = parsed.childTrueMicroFamilyId || childTrueMicroFamilyIdFrom(row);
    const parentId = parsed.parentTrueMicroFamilyId || parentTrueMicroFamilyIdFrom(row);
    const mmId = parsed.microMicroFamilyId || microMicroIdFromRow(row) || null;

    if (!parentId) continue;

    microToParentTrueMicroFamilyId[selectedId] = parentId;
    microToChildTrueMicroFamilyId[selectedId] = childId || null;

    if (mmId) {
      microToMicroMicroFamilyId[selectedId] = mmId;

      if (childId) {
        if (!childTrueMicroFamilyToMicroMicroFamilyIds[childId]) {
          childTrueMicroFamilyToMicroMicroFamilyIds[childId] = [];
        }

        childTrueMicroFamilyToMicroMicroFamilyIds[childId].push(mmId);
      }
    }

    if (!parentTrueMicroFamilyToMicroFamilyIds[parentId]) {
      parentTrueMicroFamilyToMicroFamilyIds[parentId] = [];
    }

    parentTrueMicroFamilyToMicroFamilyIds[parentId].push(selectedId);
  }

  for (const parentId of Object.keys(parentTrueMicroFamilyToMicroFamilyIds)) {
    parentTrueMicroFamilyToMicroFamilyIds[parentId] = uniqueStrings(
      parentTrueMicroFamilyToMicroFamilyIds[parentId]
    ).filter(isKnownTrueMicroId);
  }

  for (const childId of Object.keys(childTrueMicroFamilyToMicroMicroFamilyIds)) {
    childTrueMicroFamilyToMicroMicroFamilyIds[childId] = uniqueStrings(
      childTrueMicroFamilyToMicroMicroFamilyIds[childId]
    ).filter(isFixedTaxonomyMicroMicroId);
  }

  return {
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    childTrueMicroFamilyIds,
    activeChildTrueMicroFamilyIds: childTrueMicroFamilyIds,

    microMicroFamilyIds,
    activeMicroMicroFamilyIds: microMicroFamilyIds,
    trueMicroMicroFamilyIds: microMicroFamilyIds,
    activeTrueMicroMicroFamilyIds: microMicroFamilyIds,

    parentTrueMicroFamilyIds,
    macroFamilyIds: parentTrueMicroFamilyIds,
    activeMacroFamilyIds: parentTrueMicroFamilyIds,
    activeParentTrueMicroFamilyIds: parentTrueMicroFamilyIds,

    microToMacroFamilyId: microToParentTrueMicroFamilyId,
    microToParentTrueMicroFamilyId,
    microToChildTrueMicroFamilyId,
    microToMicroMicroFamilyId,
    macroToMicroFamilyIds: parentTrueMicroFamilyToMicroFamilyIds,
    parentTrueMicroFamilyToMicroFamilyIds,
    childTrueMicroFamilyToMicroMicroFamilyIds
  };
}

function countByPredicate(micros = {}, predicate) {
  return Object.values(micros || {}).filter(predicate).length;
}

function bestShortRow(rows = []) {
  return sortAdaptiveRows(rows).find((row) => microSide(row) === TARGET_TRADE_SIDE) || null;
}

function mergeMicros(primary = {}, fallback = {}) {
  return {
    ...(fallback || {}),
    ...(primary || {})
  };
}

async function getRotationMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const dataWeekKey = learningDataKey(weekKey);
  const primary = await getWeekMicros(dataWeekKey);
  const primaryRows = Object.keys(primary || {}).length;

  const previousWeekKey = getPreviousIsoWeekKey();
  const shouldMergePrevious =
    dataWeekKey !== PERSISTENT_LEARNING_KEY &&
    dataWeekKey !== previousWeekKey &&
    primaryRows < minPrimaryRowsForPreviousMerge();

  if (!shouldMergePrevious) {
    return {
      micros: primary || {},
      primaryWeekKey: dataWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false,
      usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
  }

  const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
  const previousRows = Object.keys(previous || {}).length;

  if (previousRows <= 0) {
    return {
      micros: primary || {},
      primaryWeekKey: dataWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false,
      usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
  }

  return {
    micros: mergeMicros(primary, previous),
    primaryWeekKey: dataWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    previousWeekKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge: true,
    usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
  };
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  ranked,
  eligible,
  softEligible = [],
  observationEligible = [],
  rawFallback = [],
  usedPreviousWeekMerge = false,
  usedPersistentLearningKey = false,
  primaryRows = 0,
  previousRows = 0,
  emptyReason = 'NO_SHORT_SELECTABLE_MICRO_OR_MICRO_MICRO_AVAILABLE_FOR_ROTATION'
}) {
  const indexes = buildSelectionIndexes([]);
  const meta = schemaMeta();

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_SHORT_MICRO_MICRO_OR_75_CHILD',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,
    dataWeekKey: weekKey,
    learningDataKey: weekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,
    usedRawFallback: false,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    minWeightedCompleted: minWeightedCompleted(),
    minMicroMicroCompleted: minMicroMicroCompleted(),
    topNPerSide: topNPerSide(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),
    parentDiversificationEnabled: parentDiversificationEnabled(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    childTrueMicroCount: countByPredicate(micros, (row) => isFixedTaxonomyChildId(rowId(row)) && isShortRotationRow(row)),
    microMicroCount: countByPredicate(micros, (row) => isFixedTaxonomyMicroMicroId(rowId(row)) && isShortRotationRow(row)),
    parentTrueMicroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: [TARGET_TRADE_SIDE],

    empty: true,
    emptyReason,

    bestShort: null,
    bestLong: null,

    candidateMicroFamilyIds: [],
    candidateTrueMicroFamilyIds: [],
    candidateChildTrueMicroFamilyIds: [],
    candidateMicroMicroFamilyIds: [],
    candidateParentTrueMicroFamilyIds: [],
    candidateMacroFamilyIds: [],

    ...indexes,

    microFamilies: [],

    rankings: buildRankings(micros, { filter: 'selectable' }),
    childRankings: buildRankings(micros, { filter: 'child75' }),
    microMicroRankings: buildRankings(micros, { filter: 'microMicro' }),
    parentRankings: buildRankings(micros, { filter: 'parent15' }),
    macroRankings: buildRankings(micros, { filter: 'parent15' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function buildRotationFromWeek({
  weekKey = PERSISTENT_LEARNING_KEY,
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const {
    micros,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge,
    usedPersistentLearningKey
  } = await getRotationMicros(weekKey);

  const rankMode = mode === 'adaptive' ? 'balanced' : mode;

  const rankedAll = sortAdaptiveRows(
    rankMicros(micros, rankMode)
      .filter(isShortRotationRow)
  );

  const rankedTrueMicros = sortAdaptiveRows(
    rankedAll.filter(isTrueMicroFamily)
  );

  const rankedCandidates = rankedTrueMicros;

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    rawFallback,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    missingSides: selectedMissingSides,
    countsByParent
  } = selectRotationCandidates(rankedCandidates);

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey: dataWeekKey,
      activeWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      softEligible,
      observationEligible,
      rawFallback,
      usedPreviousWeekMerge,
      usedPersistentLearningKey,
      primaryRows,
      previousRows,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_SHORT_SELECTABLE_MICRO_OR_MICRO_MICRO_FOUND'
        : 'NO_SHORT_SELECTABLE_MICRO_OR_MICRO_MICRO_AVAILABLE_FOR_CANDIDATE_SNAPSHOT'
    });
  }

  const microFamilies = sortAdaptiveRows(selected)
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));

  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();

  return {
    rotationId: randomId(`ROT_${dataWeekKey}_${mode}_short_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_SHORT_MICRO_MICRO_OR_75_CHILD',
    mode,

    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    minWeightedCompleted: minWeightedCompleted(),
    minMicroMicroCompleted: minMicroMicroCompleted(),
    topNPerSide: topNPerSide(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),
    parentDiversificationEnabled: parentDiversificationEnabled(),
    parentSelectionCounts: countsByParent,

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    childTrueMicroCount: countByPredicate(micros, (row) => isFixedTaxonomyChildId(rowId(row)) && isShortRotationRow(row)),
    microMicroCount: countByPredicate(micros, (row) => isFixedTaxonomyMicroMicroId(rowId(row)) && isShortRotationRow(row)),
    parentTrueMicroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: selectedMissingSides,

    empty: false,
    emptyReason: null,

    bestShort: bestShortRow(microFamilies),
    bestLong: null,

    candidateMicroFamilyIds: indexes.microFamilyIds,
    candidateTrueMicroFamilyIds: indexes.trueMicroFamilyIds,
    candidateChildTrueMicroFamilyIds: indexes.childTrueMicroFamilyIds,
    candidateMicroMicroFamilyIds: indexes.microMicroFamilyIds,
    candidateParentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
    candidateMacroFamilyIds: indexes.macroFamilyIds,

    ...indexes,

    microFamilies,

    rankings: buildRankings(micros, { filter: 'selectable' }),
    childRankings: buildRankings(micros, { filter: 'child75' }),
    microMicroRankings: buildRankings(micros, { filter: 'microMicro' }),
    parentRankings: buildRankings(micros, { filter: 'parent15' }),
    macroRankings: buildRankings(micros, { filter: 'parent15' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function freezeWeeklyRotation({
  weekKey = PERSISTENT_LEARNING_KEY,
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();
  const dataWeekKey = learningDataKey(weekKey);

  const micros = await getWeekMicros(dataWeekKey);

  await saveWeekMicros(dataWeekKey, micros);

  const rotation = await buildRotationFromWeek({
    weekKey: dataWeekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    nextRotationKey(),
    rotation
  );

  await setJson(
    redis,
    rotationValidFromKey(),
    {
      validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
      ts: now(),
      sourceWeekKey: dataWeekKey,
      activeWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      rotationId: rotation.rotationId,

      ...modeFlags(),

      trueMicroOnly: true,
      exactTrueMicroOnly: true,

      manualOnly: false,
      adminSelected: false,
      autoRotation: false,
      nextRotationOnly: true,
      activeRotationPreserved: true,
      liveSelectable: false,
      activationDisabled: true,
      manualSelectionRequired: true,

      usedLegacyFallback: false,
      usedSoftFallback: rotation.usedSoftFallback,
      usedObservationFallback: rotation.usedObservationFallback,
      usedRawFallback: rotation.usedRawFallback,
      usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,
      usedPersistentLearningKey: rotation.usedPersistentLearningKey,

      selectedMicroFamilies: 0,
      selectedTrueMicroFamilies: 0,
      selectedChildTrueMicroFamilies: 0,
      selectedMicroMicroFamilies: 0,
      selectedParentTrueMicroFamilies: 0,

      candidateMicroFamilies: rotation.microFamilyIds.length,
      candidateTrueMicroFamilies: rotation.trueMicroFamilyIds.length,
      candidateChildTrueMicroFamilies: rotation.childTrueMicroFamilyIds.length,
      candidateMicroMicroFamilies: rotation.microMicroFamilyIds.length,
      candidateParentTrueMicroFamilies: rotation.parentTrueMicroFamilyIds.length,

      parentDiversificationEnabled: rotation.parentDiversificationEnabled,
      parentSelectionCounts: rotation.parentSelectionCounts || {},

      missingSides: rotation.missingSides || [],
      bestShort: rotation.bestShort?.microFamilyId || null,
      bestLong: null
    }
  );

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_CANDIDATES_READY_MANUAL_MICRO_MICRO_OR_75_CHILD_SELECTION_REQUIRED'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_CANDIDATES_READY_MANUAL_MICRO_MICRO_OR_75_CHILD_SELECTION_REQUIRED',
    weekKey: dataWeekKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    selectedMicroFamilies: 0,
    selectedTrueMicroFamilies: 0,
    selectedChildTrueMicroFamilies: 0,
    selectedMicroMicroFamilies: 0,
    selectedParentTrueMicroFamilies: 0,

    candidateMicroFamilies: rotation.microFamilyIds.length,
    candidateTrueMicroFamilies: rotation.trueMicroFamilyIds.length,
    candidateChildTrueMicroFamilies: rotation.childTrueMicroFamilyIds.length,
    candidateMicroMicroFamilies: rotation.microMicroFamilyIds.length,
    candidateParentTrueMicroFamilies: rotation.parentTrueMicroFamilyIds.length,

    parentDiversificationEnabled: rotation.parentDiversificationEnabled,
    parentSelectionCounts: rotation.parentSelectionCounts || {},

    usedLegacyFallback: false,
    usedSoftFallback: rotation.usedSoftFallback,
    usedObservationFallback: rotation.usedObservationFallback,
    usedRawFallback: rotation.usedRawFallback,
    usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,
    usedPersistentLearningKey: rotation.usedPersistentLearningKey,

    missingSides: rotation.missingSides || [],
    bestShort: rotation.bestShort,
    bestLong: null,

    rotation
  };
}

function sanitizeActiveRotation(rotation = {}, {
  requireManual = false
} = {}) {
  if (!rotation || typeof rotation !== 'object') return null;

  if (requireManual && !isManualActiveRotation(rotation)) {
    return null;
  }

  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const shortRows = sortAdaptiveRows(
    rows
      .filter(isShortRotationRow)
      .filter(isTrueMicroFamily)
  )
    .slice(0, topNPerSide())
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));

  const indexes = buildSelectionIndexes(shortRows);
  const manual = isManualActiveRotation(rotation);

  return {
    ...rotation,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    usedLegacyFallback: false,

    manualOnly: manual,
    adminSelected: manual,
    autoRotation: false,
    liveSelectable: manual && shortRows.length > 0,

    microFamilies: shortRows,

    ...indexes,

    bestShort: bestShortRow(shortRows),
    bestLong: null,
    missingSides: missingSides(shortRows),

    parentDiversificationEnabled: parentDiversificationEnabled(),

    empty: shortRows.length === 0,
    emptyReason: shortRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_MANUAL_SHORT_MICRO_MICRO_OR_75_CHILD_SELECTIONS'
      : null
  };
}

export async function activateNextRotation() {
  return {
    ok: false,
    skipped: true,
    changed: false,
    reason: 'AUTO_ROTATION_ACTIVATION_DISABLED_MANUAL_MICRO_MICRO_OR_75_CHILD_ONLY',
    ...modeFlags(),
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    manualOnly: true,
    activationDisabled: true
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  const raw = await getJson(
    redis,
    activeRotationKey(),
    null
  );

  const sanitized = sanitizeActiveRotation(raw, {
    requireManual: true
  });

  if (!sanitized || sanitized.empty || !sanitized.microFamilyIds?.length) {
    return null;
  }

  if (
    raw?.longOnly === true ||
    raw?.shortDisabled === true ||
    raw?.targetTradeSide === OPPOSITE_TRADE_SIDE ||
    raw?.dashboardSide === 'bull' ||
    raw?.manualOnly !== true ||
    raw?.liveSelectable !== true ||
    raw?.autoRotation === true ||
    ![TRUE_MICRO_SCHEMA, MICRO_MICRO_SCHEMA].includes(String(raw?.trueMicroFamilySchema || TRUE_MICRO_SCHEMA))
  ) {
    await setJson(
      redis,
      activeRotationKey(),
      sanitized
    ).catch(() => null);
  }

  return sanitized;
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeMicroFamilyIds || [],
    active?.trueMicroFamilyIds || [],
    active?.microFamilyIds || [],
    active?.activeMicroMicroFamilyIds || [],
    active?.microMicroFamilyIds || [],
    active?.trueMicroMicroFamilyIds || []
  ])
    .map(cleanLearningMicroId)
    .filter(isKnownTrueMicroId)
    .filter(idLooksLikeShortFamily);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeParentTrueMicroFamilyIds || [],
    active?.parentTrueMicroFamilyIds || [],
    active?.activeMacroFamilyIds || [],
    active?.macroFamilyIds || [],
    active?.microFamilyIds || []
  ])
    .map(cleanLearningMicroId)
    .filter(Boolean)
    .map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
    .filter(Boolean)
    .filter((id) => !isScannerFingerprintId(id))
    .filter((id) => !isExecutionFingerprintId(id));

  return new Set(ids);
}

function manualSideFromId(id = '') {
  const value = String(id || '').toUpperCase();

  if (isScannerFingerprintId(value)) return 'UNKNOWN';
  if (isExecutionFingerprintId(value)) return 'UNKNOWN';
  if (idLooksLikeLongFamily(value) && !idLooksLikeShortFamily(value)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(value)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank) {
  const cleanId = cleanLearningMicroId(id);
  const tradeSide = manualSideFromId(cleanId);
  const taxonomy = taxonomyMetaForId(cleanId);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isKnownTrueMicroId(cleanId)) return null;

  const schema = schemaForLearningId(cleanId);
  const granularity = granularityForLearningId(cleanId);
  const minCompleted = minCompletedForId(cleanId);

  return {
    rank,

    microFamilyId: cleanId,
    trueMicroFamilyId: cleanId,
    analyzeMicroFamilyId: cleanId,
    learningMicroFamilyId: cleanId,

    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
    microMicroFamilyId: taxonomy.microMicroFamilyId,
    trueMicroMicroFamilyId: taxonomy.microMicroFamilyId,
    exactMicroMicroFamilyId: taxonomy.microMicroFamilyId,
    microMicroHash: taxonomy.microMicroHash,

    familyId: null,

    macroFamilyId: taxonomy.parentTrueMicroFamilyId,
    parentMacroFamilyId: taxonomy.parentTrueMicroFamilyId,
    parentMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,

    coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    baseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    legacyMicroFamilyId: taxonomy.parentTrueMicroFamilyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    schema,
    microFamilySchema: schema,
    trueMicroFamilySchema: schema,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: schema,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    version: taxonomy.learningLayer === LAYER_MICRO_MICRO
      ? 'manual_short_micro_micro'
      : 'manual_child_fixed_taxonomy_75',
    microMicroVersion: MICRO_MICRO_VERSION,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,
    fixedTaxonomyLearningId: taxonomy.fixedTaxonomyLearningId,
    learningLayer: taxonomy.learningLayer,
    layer: taxonomy.learningLayer,
    selectionGranularity: taxonomy.selectionGranularity,
    learningGranularity: granularity,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    isTrueMicro: true,
    isChildTrueMicro: taxonomy.learningLayer === LAYER_MICRO_75,
    isMicroMicro: taxonomy.learningLayer === LAYER_MICRO_MICRO,
    isLegacyMacro: false,
    selectable: true,
    manualOnly: true,
    unverifiedManualId: true,
    parentSelectionAllowed: false,

    rotationEligibilityTier: 'MANUAL',
    rotationEligible: true,
    hardEligible: false,
    softEligible: false,
    observationEligible: false,
    rawEligible: false,

    learningStatus: 'OBSERVING',
    status: 'OBSERVING',
    minCompletedForActiveLearning: minCompleted,
    tooEarly: true,
    tooEarlyReason: `completed 0/${minCompleted}`,

    seen: 0,
    observations: 0,
    observationSample: 0,
    observationAlwaysCounted: false,
    observationDedupeRequired: true,

    completed: 0,
    outcomeSample: 0,
    realCompleted: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,

    winrateSample: 0,
    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    sampleWilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,
    sampleReliability: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    totalCostR: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    recentMomentumScore: 0,
    currentFitScore: 0,
    shortCurrentFitScore: 0,
    bearCurrentFitScore: 0,
    longCurrentFitScore: 0,
    bullCurrentFitScore: 0,
    adaptiveScore: 0,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `MANUAL_SELECTED_ID=${cleanId}`,
      `CHILD_TRUE_MICRO=${taxonomy.childTrueMicroFamilyId}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
      taxonomy.microMicroFamilyId ? `MICRO_MICRO=${taxonomy.microMicroFamilyId}` : null,
      `SCHEMA=${schema}`,
      `LAYER=${taxonomy.learningLayer}`,
      'SOURCE=MANUAL_SELECTION'
    ].filter(Boolean),

    definition: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `MANUAL_SELECTED_ID=${cleanId}`,
      `CHILD_TRUE_MICRO=${taxonomy.childTrueMicroFamilyId}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
      taxonomy.microMicroFamilyId ? `MICRO_MICRO=${taxonomy.microMicroFamilyId}` : null,
      `SCHEMA=${schema}`,
      `LAYER=${taxonomy.learningLayer}`,
      'SOURCE=MANUAL_SELECTION'
    ].filter(Boolean).join(' | '),

    parentDefinitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
      `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`
    ],

    parentDefinition: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
      `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`
    ].join(' | '),

    ...modeFlags()
  };
}

function resolveManualSelection({
  requestedIds = [],
  micros = {}
}) {
  const selectedRows = [];
  const ignoredIds = [];
  const expandedFromMacro = {};
  const seen = new Set();

  const microsByUpperId = Object.fromEntries(
    Object.values(micros || {})
      .filter(Boolean)
      .map((row) => [
        rowId(row).toUpperCase(),
        row
      ])
      .filter(([id]) => Boolean(id))
  );

  const addRow = (row) => {
    const id = rowId(row);

    if (!id || seen.has(id)) return;
    if (isScannerFingerprintId(id)) return;
    if (isExecutionFingerprintId(id)) return;
    if (!isShortRotationRow(row)) return;
    if (!isTrueMicroFamily(row)) return;
    if (!isKnownTrueMicroId(id)) return;

    seen.add(id);
    selectedRows.push({
      ...row,
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningMicroFamilyId: id,
      childTrueMicroFamilyId: childTrueMicroFamilyIdFrom(row),
      microMicroFamilyId: microMicroIdFromRow(row) || null,
      trueMicroMicroFamilyId: microMicroIdFromRow(row) || null,
      exactMicroMicroFamilyId: microMicroIdFromRow(row) || null,
      parentTrueMicroFamilyId: parentTrueMicroFamilyIdFrom(row),
      adaptiveScore: adaptiveSelectionScore(row),
      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
    });
  };

  for (const requestedId of requestedIds) {
    const id = cleanLearningMicroId(requestedId);
    const side = manualSideFromId(id);
    const parsed = parseShortTaxonomyMicroId(id);

    if (side !== TARGET_TRADE_SIDE) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: id,
        side,
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'LONG_DISABLED_SHORT_ONLY'
          : 'UNKNOWN_OR_NON_SHORT_ID_REJECTED'
      });
      continue;
    }

    if (parsed.isParent) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: id,
        side,
        reason: 'PARENT_15_CONTEXT_ONLY_NOT_SELECTABLE_SELECT_EXACT_MICRO_MICRO_OR_75_CHILD'
      });
      continue;
    }

    if (!isKnownTrueMicroId(id)) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: id,
        side,
        reason: isScannerFingerprintId(id)
          ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
          : isExecutionFingerprintId(id)
            ? 'XR_EXECUTION_FINGERPRINT_METADATA_ONLY_USE_MM_ID_INSTEAD'
            : 'ONLY_EXACT_SHORT_MICRO_MICRO_OR_75_CHILD_IDS_ALLOWED'
      });
      continue;
    }

    const directRow = micros[id];
    const upperRow = microsByUpperId[id.toUpperCase()];
    const row = directRow || upperRow;

    if (
      row &&
      isShortRotationRow(row) &&
      isTrueMicroFamily(row) &&
      isManualEligible(row)
    ) {
      addRow(row);
      continue;
    }

    if (!row && allowManualUnknownTrueMicroIds()) {
      const manualRow = buildManualOnlyRow(id, selectedRows.length + 1);

      if (manualRow) {
        addRow(manualRow);
        continue;
      }
    }

    ignoredIds.push({
      id: requestedId,
      normalizedId: id,
      side,
      reason: row
        ? 'ROW_IS_NOT_EXACT_SHORT_MICRO_MICRO_OR_75_CHILD'
        : 'UNKNOWN_SHORT_MICRO_MICRO_OR_75_CHILD_ID'
    });
  }

  return {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  };
}

function requestedManualIdsFromOptions(options = {}) {
  return uniqueStrings([
    options.microFamilyIds || [],
    options.activeMicroFamilyIds || [],
    options.trueMicroFamilyIds || [],
    options.childTrueMicroFamilyIds || [],
    options.microMicroFamilyIds || [],
    options.trueMicroMicroFamilyIds || [],
    options.exactMicroMicroFamilyIds || [],
    options.ids || [],
    options.id || []
  ]);
}

function buildPreservedActiveResponse({
  existingActive,
  requestedIds,
  ignoredIds,
  expandedFromMacro,
  weekKey,
  mode
}) {
  const preserved = existingActive
    ? {
      ...existingActive,
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: true,
      reason: 'NO_VALID_SHORT_MICRO_MICRO_OR_75_CHILD_IDS_SELECTED_ACTIVE_ROTATION_PRESERVED'
    }
    : {
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: false,
      rotationId: null,
      source: 'ADMIN_MANUAL_SELECTION_SHORT_MICRO_MICRO_OR_75_CHILD',
      mode,
      sourceWeekKey: weekKey,
      activeWeekKey: getIsoWeekKey(),
      dataWeekKey: weekKey,
      learningDataKey: weekKey,
      generatedAt: now(),
      activatedAt: null,
      ...modeFlags(),
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      manualOnly: true,
      adminSelected: true,
      autoRotation: false,
      liveSelectable: false,
      empty: true,
      emptyReason: 'NO_VALID_SHORT_MICRO_MICRO_OR_75_CHILD_IDS_SELECTED',
      reason: 'NO_VALID_SHORT_MICRO_MICRO_OR_75_CHILD_IDS_SELECTED',
      microFamilies: [],
      microFamilyIds: [],
      activeMicroFamilyIds: [],
      trueMicroFamilyIds: [],
      childTrueMicroFamilyIds: [],
      activeChildTrueMicroFamilyIds: [],
      microMicroFamilyIds: [],
      activeMicroMicroFamilyIds: [],
      trueMicroMicroFamilyIds: [],
      activeTrueMicroMicroFamilyIds: [],
      macroFamilyIds: [],
      activeMacroFamilyIds: [],
      parentTrueMicroFamilyIds: [],
      activeParentTrueMicroFamilyIds: [],
      microToMacroFamilyId: {},
      microToParentTrueMicroFamilyId: {},
      microToChildTrueMicroFamilyId: {},
      microToMicroMicroFamilyId: {},
      macroToMicroFamilyIds: {},
      parentTrueMicroFamilyToMicroFamilyIds: {},
      childTrueMicroFamilyToMicroMicroFamilyIds: {},
      bestShort: null,
      bestLong: null,
      missingSides: [TARGET_TRADE_SIDE]
    };

  return {
    ...preserved,
    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro
  };
}

export async function activateSelectedMicroFamilies(options = {}) {
  const {
    weekKey = PERSISTENT_LEARNING_KEY,
    activeWeekKey = getIsoWeekKey(),
    mode = 'manual'
  } = options || {};

  const redis = getDurableRedis();
  const dataWeekKey = learningDataKey(weekKey);

  const [
    rotationMicros,
    existingRawActive
  ] = await Promise.all([
    getRotationMicros(dataWeekKey),
    getJson(redis, activeRotationKey(), null).catch(() => null)
  ]);

  const {
    micros,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,
    primaryRows,
    previousRows
  } = rotationMicros;

  const requestedIds = requestedManualIdsFromOptions(options);

  const {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  } = resolveManualSelection({
    requestedIds,
    micros
  });

  const microFamilies = sortAdaptiveRows(selectedRows)
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .slice(0, topNPerSide())
    .map((row, index) => {
      if (row.manualOnly) {
        return {
          ...row,
          rank: index + 1
        };
      }
      return compactRotationRow(row, index + 1);
    })
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.microFamilyId));

  if (microFamilies.length === 0) {
    const existingActive = sanitizeActiveRotation(existingRawActive, {
      requireManual: true
    });

    return buildPreservedActiveResponse({
      existingActive,
      requestedIds,
      ignoredIds,
      expandedFromMacro,
      weekKey: dataWeekKey,
      mode
    });
  }

  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();

  const active = sanitizeActiveRotation({
    rotationId: randomId(`ROT_${dataWeekKey}_manual_short_micro_micro_or_75_child`),
    source: 'ADMIN_MANUAL_SELECTION_SHORT_MICRO_MICRO_OR_75_CHILD',
    mode,

    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: meta.schema,
    macroSchema: meta.macroSchema,
    microSchema: meta.microSchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: indexes.microFamilyIds.length > 0,

    usedLegacyFallback: false,
    usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'SOFT'),
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),
    usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'RAW'),
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    minWeightedCompleted: minWeightedCompleted(),
    minMicroMicroCompleted: minMicroMicroCompleted(),
    topNPerSide: topNPerSide(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),
    parentDiversificationEnabled: parentDiversificationEnabled(),

    primaryRows,
    previousRows,

    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
      ? 'NO_SHORT_MICRO_MICRO_OR_75_CHILD_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    requestedTrueMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

    bestShort: bestShortRow(microFamilies),
    bestLong: null,
    missingSides: missingSides(microFamilies),

    ...indexes,

    microFamilies
  }, {
    requireManual: true
  });

  const finalActive = {
    ...active,
    ok: true,
    skipped: false,
    changed: true,
    activePreserved: false
  };

  await setJson(
    redis,
    activeRotationKey(),
    finalActive
  );

  return finalActive;
}

function sanitizeDashboardRotation(rotation) {
  const sanitized = sanitizeActiveRotation(rotation, {
    requireManual: false
  });

  if (!sanitized) return null;

  return {
    ...sanitized,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    candidateMicroFamilyIds: sanitized.microFamilyIds || [],
    candidateTrueMicroFamilyIds: sanitized.trueMicroFamilyIds || [],
    candidateChildTrueMicroFamilyIds: sanitized.childTrueMicroFamilyIds || [],
    candidateMicroMicroFamilyIds: sanitized.microMicroFamilyIds || [],
    candidateParentTrueMicroFamilyIds: sanitized.parentTrueMicroFamilyIds || [],
    candidateMacroFamilyIds: sanitized.macroFamilyIds || []
  };
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getActiveRotation(),
    getJson(redis, nextRotationKey(), null),
    getJson(redis, rotationValidFromKey(), null)
  ]);

  const active = sanitizeActiveRotation(activeRaw, {
    requireManual: true
  });

  const next = sanitizeDashboardRotation(nextRaw);

  const activeRows = Array.isArray(active?.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next?.microFamilies)
    ? next.microFamilies
    : [];

  return {
    active,
    next,
    validFrom,

    activeRows,
    nextRows,

    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0,

    activeTrueMicroCount: active?.trueMicroFamilyIds?.length || 0,
    nextTrueMicroCount: next?.trueMicroFamilyIds?.length || 0,

    activeChildTrueMicroCount: active?.childTrueMicroFamilyIds?.length || 0,
    nextChildTrueMicroCount: next?.childTrueMicroFamilyIds?.length || 0,

    activeMicroMicroCount: active?.microMicroFamilyIds?.length || 0,
    nextMicroMicroCount: next?.microMicroFamilyIds?.length || 0,

    activeParentTrueMicroCount: active?.parentTrueMicroFamilyIds?.length || 0,
    nextParentTrueMicroCount: next?.parentTrueMicroFamilyIds?.length || 0,

    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    nextTrueMicroFamilyIds: next?.trueMicroFamilyIds || [],

    activeChildTrueMicroFamilyIds: active?.childTrueMicroFamilyIds || active?.activeChildTrueMicroFamilyIds || [],
    nextChildTrueMicroFamilyIds: next?.childTrueMicroFamilyIds || next?.activeChildTrueMicroFamilyIds || [],

    activeMicroMicroFamilyIds: active?.microMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    nextMicroMicroFamilyIds: next?.microMicroFamilyIds || next?.activeMicroMicroFamilyIds || [],

    activeTrueMicroMicroFamilyIds: active?.trueMicroMicroFamilyIds || active?.activeTrueMicroMicroFamilyIds || [],
    nextTrueMicroMicroFamilyIds: next?.trueMicroMicroFamilyIds || next?.activeTrueMicroMicroFamilyIds || [],

    activeParentTrueMicroFamilyIds: active?.parentTrueMicroFamilyIds || active?.activeParentTrueMicroFamilyIds || [],
    nextParentTrueMicroFamilyIds: next?.parentTrueMicroFamilyIds || next?.activeParentTrueMicroFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},

    activeMicroToParentTrueMicroFamilyId: active?.microToParentTrueMicroFamilyId || {},
    nextMicroToParentTrueMicroFamilyId: next?.microToParentTrueMicroFamilyId || {},

    activeMicroToChildTrueMicroFamilyId: active?.microToChildTrueMicroFamilyId || {},
    nextMicroToChildTrueMicroFamilyId: next?.microToChildTrueMicroFamilyId || {},

    activeMicroToMicroMicroFamilyId: active?.microToMicroMicroFamilyId || {},
    nextMicroToMicroMicroFamilyId: next?.microToMicroMicroFamilyId || {},

    activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},

    activeParentTrueMicroFamilyToMicroFamilyIds: active?.parentTrueMicroFamilyToMicroFamilyIds || {},
    nextParentTrueMicroFamilyToMicroFamilyIds: next?.parentTrueMicroFamilyToMicroFamilyIds || {},

    activeChildTrueMicroFamilyToMicroMicroFamilyIds: active?.childTrueMicroFamilyToMicroMicroFamilyIds || {},
    nextChildTrueMicroFamilyToMicroMicroFamilyIds: next?.childTrueMicroFamilyToMicroMicroFamilyIds || {},

    bestShort: active?.bestShort || null,
    bestLong: null,
    nextBestShort: next?.bestShort || null,
    nextBestLong: null,

    missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
    nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],

    usedSoftFallback: Boolean(active?.usedSoftFallback),
    nextUsedSoftFallback: Boolean(next?.usedSoftFallback),

    usedObservationFallback: Boolean(active?.usedObservationFallback),
    nextUsedObservationFallback: Boolean(next?.usedObservationFallback),

    usedRawFallback: Boolean(active?.usedRawFallback),
    nextUsedRawFallback: Boolean(next?.usedRawFallback),

    usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
    nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),

    usedPersistentLearningKey: Boolean(active?.usedPersistentLearningKey),
    nextUsedPersistentLearningKey: Boolean(next?.usedPersistentLearningKey),

    parentDiversificationEnabled: parentDiversificationEnabled(),
    maxPerParentTrueMicroFamily: maxPerParentTrueMicroFamily(),

    dataWeekKey: active?.dataWeekKey || PERSISTENT_LEARNING_KEY,
    learningDataKey: active?.learningDataKey || PERSISTENT_LEARNING_KEY,

    manualOnly: true,
    autoRotationActivationDisabled: true,
    activeLiveSelectable: Boolean(active?.liveSelectable),

    ...modeFlags(),

    trueMicroOnly: true,
    exactTrueMicroOnly: true
  };
}