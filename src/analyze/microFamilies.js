// ================= FILE: src/analyze/microFamilies.js =================
//
// SHORT-only micro-family classifier.
//
// Belangrijk:
// - Parent 15: MICRO_SHORT_{SETUP}_{REGIME}
// - Micro 75: MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - Micro-micro: MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
// - XR blijft metadata, geen learning-ID.
// - Scanner families blijven metadata, geen learning-ID.
// - Coin/symbol zit niet in de family-ID.
// - SHORT-only, virtual/shadow only, geen real orders.
// - 75-child is context/rollup.
// - Micro-micro is de exacte Discord/selectie-laag.

import { CONFIG } from '../config.js';
import {
  getObRelation,
  sideToTradeSide,
  stableHash,
  safeNumber
} from '../utils.js';

const FALLBACK_MACRO_SCHEMA = 'MF_V1';
const FALLBACK_MICRO_SCHEMA = 'MF_V2';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const MICRO_MICRO_SUFFIX = 'MM';
const EXECUTION_MICRO_SUFFIX = 'XR';
const MICRO_MICRO_HASH_LEN = 10;
const EXECUTION_MICRO_HASH_LEN = 10;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MICRO_MICRO_MIN_COMPLETED_SOFT = 6;
const MICRO_MICRO_MIN_COMPLETED_HARD = 35;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const SELECTION_ENGINE_VERSION = 'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V1';

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

const MICRO_MICRO_ENTRY_BUCKETS = Object.freeze([
  'ENTRY_EARLY',
  'ENTRY_NORMAL',
  'ENTRY_LATE'
]);

const MICRO_MICRO_SPREAD_BUCKETS = Object.freeze([
  'SPREAD_LOW',
  'SPREAD_MID',
  'SPREAD_HIGH'
]);

const MICRO_MICRO_BTC_BUCKETS = Object.freeze([
  'BTC_BEAR',
  'BTC_NEUTRAL',
  'BTC_BULL'
]);

const MICRO_MICRO_RISK_BUCKETS = Object.freeze([
  'RISK_TIGHT',
  'RISK_CLEAN',
  'RISK_WIDE'
]);

const SETUP_SET = new Set(SETUP_TYPES);
const REGIME_SET = new Set(REGIME_BUCKETS);
const CONFIRMATION_SET = new Set(CONFIRMATION_PROFILES);

const MICRO_MICRO_ENTRY_SET = new Set(MICRO_MICRO_ENTRY_BUCKETS);
const MICRO_MICRO_SPREAD_SET = new Set(MICRO_MICRO_SPREAD_BUCKETS);
const MICRO_MICRO_BTC_SET = new Set(MICRO_MICRO_BTC_BUCKETS);
const MICRO_MICRO_RISK_SET = new Set(MICRO_MICRO_RISK_BUCKETS);

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

const SETUP_ALIASES = {
  BO: 'BREAKOUT',
  BREAK: 'BREAKOUT',
  BREAK_OUT: 'BREAKOUT',
  BREAKOUT_SHORT: 'BREAKOUT',
  MOMENTUM_BREAK: 'BREAKOUT',

  RETEST_SHORT: 'RETEST',
  PULLBACK: 'RETEST',
  PULL_BACK: 'RETEST',
  PB: 'RETEST',
  RIP_SELL: 'RETEST',

  SWEEP: 'SWEEP_REVERSAL',
  LIQ_SWEEP: 'SWEEP_REVERSAL',
  LIQUIDITY_SWEEP: 'SWEEP_REVERSAL',
  STOP_RUN: 'SWEEP_REVERSAL',
  REVERSAL: 'SWEEP_REVERSAL',
  SWEEP_REVERSE: 'SWEEP_REVERSAL',
  SWEEP_REVERSAL_SHORT: 'SWEEP_REVERSAL',

  CONT: 'CONTINUATION',
  CONTINUATION_SHORT: 'CONTINUATION',
  MOMENTUM: 'CONTINUATION',
  TREND_CONTINUATION: 'CONTINUATION',

  COMPRESS: 'COMPRESSION',
  COMPRESSION_SHORT: 'COMPRESSION',
  COIL: 'COMPRESSION',
  SQUEEZE_SETUP: 'COMPRESSION',
  TIGHT_RANGE: 'COMPRESSION'
};

const REGIME_ALIASES = {
  TRENDING: 'TREND',
  BEAR_TREND: 'TREND',
  DOWNTREND: 'TREND',
  IMPULSE: 'TREND',
  MOMENTUM: 'TREND',

  RANGE: 'CHOP',
  RANGING: 'CHOP',
  SIDEWAYS: 'CHOP',
  CHOPPY: 'CHOP',
  MEAN_REVERT: 'CHOP',

  VOL_SQUEEZE: 'SQUEEZE',
  SQUEEZE_REGIME: 'SQUEEZE',
  COMPRESSION: 'SQUEEZE',
  LOW_VOL: 'SQUEEZE',
  TIGHT: 'SQUEEZE'
};

const CONFIRMATION_ALIASES = {
  A: 'A_STRONG_ALIGN',
  STRONG: 'A_STRONG_ALIGN',
  STRONG_ALIGN: 'A_STRONG_ALIGN',
  FULL_ALIGN: 'A_STRONG_ALIGN',
  ALL_ALIGN: 'A_STRONG_ALIGN',
  HIGH_CONFLUENCE: 'A_STRONG_ALIGN',

  B: 'B_FLOW_ALIGN',
  FLOW: 'B_FLOW_ALIGN',
  FLOW_ALIGN: 'B_FLOW_ALIGN',
  MOMENTUM_ALIGN: 'B_FLOW_ALIGN',
  ASK_FLOW: 'B_FLOW_ALIGN',

  C: 'C_VOLUME_ALIGN',
  VOLUME: 'C_VOLUME_ALIGN',
  VOLUME_ALIGN: 'C_VOLUME_ALIGN',
  VOL_ALIGN: 'C_VOLUME_ALIGN',
  VOLUME_SPIKE: 'C_VOLUME_ALIGN',
  OB_VOLUME_ALIGN: 'C_VOLUME_ALIGN',

  D: 'D_MIXED_OK',
  MIXED: 'D_MIXED_OK',
  MIXED_OK: 'D_MIXED_OK',
  NEUTRAL_OK: 'D_MIXED_OK',

  E: 'E_WEAK_CONTRA',
  WEAK: 'E_WEAK_CONTRA',
  WEAK_CONTRA: 'E_WEAK_CONTRA',
  CONTRA: 'E_WEAK_CONTRA'
};

function getMacroSchema() {
  return String(
    CONFIG?.analyze?.macroSchema ||
      CONFIG?.analyze?.legacySchema ||
      FALLBACK_MACRO_SCHEMA
  ).toUpperCase();
}

function getMicroSchema() {
  return String(
    CONFIG?.analyze?.microSchema ||
      FALLBACK_MICRO_SCHEMA
  ).toUpperCase();
}

function shouldBuildExecutionFingerprintMetadata() {
  return CONFIG?.analyze?.buildExecutionFingerprintMetadata !== false;
}

function shouldBuildMicroMicroFamily() {
  return CONFIG?.analyze?.buildMicroMicroFamily !== false;
}

function toUpper(value, fallback = 'UNKNOWN') {
  const raw = String(value ?? '').trim();
  return raw ? raw.toUpperCase() : fallback;
}

function boolToken(value) {
  return Boolean(value) ? 'YES' : 'NO';
}

function normalizeToken(value, fallback = 'NA', maxLength = 80) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength) || fallback;
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
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`)
  ));
}

function hasShortSignal(value = '') {
  const text = normalizedSignalText(value);
  if (!text) return false;
  if (SHORT_TOKENS.has(text)) return true;

  return hasSignalPattern(text, [
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
  const text = normalizedSignalText(value);
  if (!text) return false;
  if (LONG_TOKENS.has(text)) return true;

  return hasSignalPattern(text, [
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

function tradeSideFromText(value = '') {
  const raw = cleanSideText(value);
  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);
  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    const text = normalizedSignalText(raw);
    if (text.includes('MICRO_SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE_SHORT') || text.includes('TRADESIDE_SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE_LONG') || text.includes('TRADESIDE_LONG')) return OPPOSITE_TRADE_SIDE;
    return 'MIXED';
  }

  return 'UNKNOWN';
}

function normalizeTradeSideValue(value) {
  const side = tradeSideFromText(value);
  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  return TARGET_TRADE_SIDE;
}

function inferSideFromValues(values = []) {
  let hasShort = false;
  let hasLong = false;

  for (const value of values) {
    const side = tradeSideFromText(value);
    if (side === TARGET_TRADE_SIDE) hasShort = true;
    if (side === OPPOSITE_TRADE_SIDE) hasLong = true;
  }

  if (hasShort && !hasLong) return TARGET_TRADE_SIDE;
  if (hasLong && !hasShort) return OPPOSITE_TRADE_SIDE;
  if (hasShort && hasLong) return 'MIXED';
  return 'UNKNOWN';
}

function inferSideFromIds(metrics = {}) {
  return inferSideFromValues([
    metrics.familyId,
    metrics.microFamilyId,
    metrics.macroFamilyId,
    metrics.parentMacroFamilyId,
    metrics.parentMicroFamilyId,
    metrics.parentTrueMicroFamilyId,
    metrics.trueMicroFamilyId,
    metrics.childTrueMicroFamilyId,
    metrics.microMicroFamilyId,
    metrics.trueMicroMicroFamilyId,
    metrics.exactMicroMicroFamilyId,
    metrics.coarseMicroFamilyId,
    metrics.baseMicroFamilyId,
    metrics.legacyMicroFamilyId,
    metrics.id,
    metrics.key
  ]);
}

function inferSideFromScannerReason(metrics = {}) {
  return inferSideFromValues([
    metrics.scannerReason,
    metrics.reason,
    metrics.signalReason,
    metrics.actionReason
  ]);
}

function inferTradeSide(metrics = {}) {
  if (typeof metrics !== 'object' || metrics === null) return normalizeTradeSideValue(metrics);

  const directSide = inferSideFromValues([
    metrics.tradeSide,
    metrics.side,
    metrics.positionSide,
    metrics.direction,
    metrics.signalSide,
    metrics.scannerSide,
    metrics.actualScannerSide,
    metrics.analysisSide,
    metrics.expectedSide,
    metrics.predictedSide,
    metrics.intentSide,
    metrics.biasSide
  ]);

  if (directSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (directSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const idSide = inferSideFromIds(metrics);
  if (idSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (idSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const reasonSide = inferSideFromScannerReason(metrics);
  if (reasonSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  if (reasonSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  if (metrics.shortOnly === true || metrics.longDisabled === true) return TARGET_TRADE_SIDE;
  if (metrics.longOnly === true || metrics.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return TARGET_TRADE_SIDE;
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
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    shadowOnly: true,

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

    observationFirst: true,
    observationAlwaysCounted: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      MICRO_MICRO_ACTIVE: `completed >= ${MICRO_MICRO_MIN_COMPLETED_HARD}`
    },

    defaultRanking: 'eligible|avgRLCB95|totalR|avgR|profitFactor|directSLPct|avgCostR',
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    rankingUsesAvgRLCB95: true,
    bareWinrateRankingDisabled: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,
    selectionAvoidsWinnerCurse: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
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

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ONLY',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordSelectionPriority: 'MICRO_MICRO_ONLY',

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    fixedTaxonomyLearningId: true,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroMinCompletedSoft: MICRO_MICRO_MIN_COMPLETED_SOFT,
    microMicroMinCompletedHard: MICRO_MICRO_MIN_COMPLETED_HARD,
    microMicroHardStatsRule: `microMicro.completed >= ${MICRO_MICRO_MIN_COMPLETED_HARD}`,
    microMicroSoftStatsRule: `microMicro.completed >= ${MICRO_MICRO_MIN_COMPLETED_SOFT}`,
    microMicroFallbackRule: 'USE_MICRO_75_CONTEXT_UNTIL_MICRO_MICRO_HAS_SAMPLE',
    microMicroSelectionCanBeManualBeforeHardSample: false,
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,
    learningHierarchyDepth: 3,
    learningHierarchy: 'PARENT_15 -> MICRO_75 -> MICRO_MICRO',

    parentLearningEnabled: true,
    childLearningEnabled: true,
    micro75LearningEnabled: true,
    selectionGranularity: 'EXACT_MICRO_MICRO',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,

    autoRotationDisabled: true,
    activateNextDisabled: true,
    freezeCronDisabled: true,
    activateCronDisabled: true,
    resetCronDisabled: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function assertShortOnly(metrics = {}) {
  const side = inferTradeSide(metrics);

  if (side === OPPOSITE_TRADE_SIDE) {
    const error = new Error('SHORT_ONLY_MICRO_FAMILY_SYSTEM:LONG_DISABLED');
    error.reason = 'LONG_DISABLED_SHORT_ONLY';
    error.tradeSide = OPPOSITE_TRADE_SIDE;
    throw error;
  }

  return {
    ...metrics,
    ...modeFlags()
  };
}

function normalizeSide() {
  return TARGET_DASHBOARD_SIDE;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return NaN;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function ratioToBps(value) {
  const n = safeNumber(value, NaN);
  if (!Number.isFinite(n)) return NaN;
  return Math.abs(n) * 10000;
}

function numericBps(value) {
  const bps = ratioToBps(value);
  if (!Number.isFinite(bps)) return null;
  return Number(bps.toFixed(3));
}

function threeTier(value, {
  prefix,
  low,
  high,
  scale = 1,
  fallback = 'NA',
  lowLabel = 'LOW',
  midLabel = 'MID',
  highLabel = 'HIGH'
} = {}) {
  const n = safeNumber(value, NaN);
  if (!Number.isFinite(n)) return `${prefix}_${fallback}`;

  const scaled = n * scale;
  if (scaled < low) return `${prefix}_${lowLabel}`;
  if (scaled >= high) return `${prefix}_${highLabel}`;
  return `${prefix}_${midLabel}`;
}

function signedThreeTier(value, {
  prefix,
  low = -0.25,
  high = 0.25,
  fallback = 'NA',
  lowLabel = 'NEG',
  midLabel = 'MID',
  highLabel = 'POS'
} = {}) {
  const n = safeNumber(value, NaN);
  if (!Number.isFinite(n)) return `${prefix}_${fallback}`;
  if (n < low) return `${prefix}_${lowLabel}`;
  if (n >= high) return `${prefix}_${highLabel}`;
  return `${prefix}_${midLabel}`;
}

function pctThreeTier(value, {
  prefix,
  lowBps,
  highBps,
  fallback = 'NA',
  lowLabel = 'NEAR',
  midLabel = 'MID',
  highLabel = 'FAR'
} = {}) {
  const bps = ratioToBps(value);
  if (!Number.isFinite(bps)) return `${prefix}_${fallback}`;
  if (bps < lowBps) return `${prefix}_${lowLabel}`;
  if (bps >= highBps) return `${prefix}_${highLabel}`;
  return `${prefix}_${midLabel}`;
}

function scoreTier(score, prefix) {
  return threeTier(score, {
    prefix,
    low: 35,
    high: 70
  });
}

function signedScoreTier(score, prefix) {
  return signedThreeTier(score, {
    prefix,
    low: -35,
    high: 35,
    lowLabel: 'NEG',
    midLabel: 'FLAT',
    highLabel: 'POS'
  });
}

function spreadTier(value) {
  const bps = ratioToBps(value);
  if (!Number.isFinite(bps)) return 'SPREAD_NA';
  if (bps < 4) return 'SPREAD_TIGHT';
  if (bps >= 15) return 'SPREAD_WIDE';
  return 'SPREAD_NORMAL';
}

function microMicroSpreadBucket(value) {
  const bps = ratioToBps(value);
  if (!Number.isFinite(bps)) return 'SPREAD_MID';
  if (bps < 4) return 'SPREAD_LOW';
  if (bps >= 15) return 'SPREAD_HIGH';
  return 'SPREAD_MID';
}

function volatilityTier(value) {
  const bps = ratioToBps(value);
  if (!Number.isFinite(bps)) return 'VOL_NA';
  if (bps < 100) return 'VOL_LOW';
  if (bps >= 400) return 'VOL_HIGH';
  return 'VOL_MID';
}

function depthTier(value) {
  const usd = safeNumber(value, NaN);
  if (!Number.isFinite(usd)) return 'DEPTH_NA';
  if (usd < 50_000) return 'DEPTH_LOW';
  if (usd >= 300_000) return 'DEPTH_HIGH';
  return 'DEPTH_MID';
}

function rrTier(rr) {
  const r = safeNumber(rr, NaN);
  if (!Number.isFinite(r)) return 'RR_NA';
  if (r < 1.2) return 'RR_LOW';
  if (r >= 2.0) return 'RR_HIGH';
  return 'RR_MID';
}

function fundingTier(value) {
  const n = safeNumber(value, NaN);
  if (!Number.isFinite(n)) return 'FUNDING_NA';
  if (n < -0.0001) return 'FUNDING_NEG';
  if (n > 0.0001) return 'FUNDING_POS';
  return 'FUNDING_FLAT';
}

function costTier(costR) {
  const c = safeNumber(costR, NaN);
  if (!Number.isFinite(c)) return 'COST_R_NA';
  if (c < 0.15) return 'COST_R_LOW';
  if (c >= 0.35) return 'COST_R_HIGH';
  return 'COST_R_MID';
}

function coarseRsi(zone) {
  const z = toUpper(zone, 'MID');
  if (z.startsWith('LOWER') || z.includes('OVERSOLD')) return 'LOWER';
  if (z.startsWith('UPPER') || z.includes('OVERBOUGHT')) return 'UPPER';
  return 'MID';
}

function tier(score) {
  const s = safeNumber(score, NaN);
  if (!Number.isFinite(s)) return 'NA';
  if (s >= 70) return 'HIGH';
  if (s >= 35) return 'MID';
  return 'LOW';
}

function scoreBucket(score, prefix) {
  return scoreTier(score, prefix);
}

function signedScoreBucket(score, prefix) {
  return signedScoreTier(score, prefix);
}

function bucketDistancePct(value, prefix) {
  return pctThreeTier(value, {
    prefix,
    lowBps: 25,
    highBps: 150,
    lowLabel: 'NEAR',
    midLabel: 'MID',
    highLabel: 'FAR'
  });
}

function bucketVolatilityPct(value) {
  return volatilityTier(value);
}

function microDepthBucket(value) {
  return depthTier(value);
}

function rrMicroBucket(rr) {
  return rrTier(rr);
}

function entryQuality(metrics = {}) {
  if (metrics.retestConfirmed) return 'RETEST';
  if (metrics.pullbackConfirmed) return 'PULLBACK';
  if (metrics.sweepConfirmed) return 'SWEEP';
  if (metrics.entryQuality) return normalizeToken(metrics.entryQuality, 'RAW');
  return 'RAW';
}

function btcRelation(sideOrMetrics, btcStateInput = null) {
  const btcState = sideOrMetrics && typeof sideOrMetrics === 'object'
    ? sideOrMetrics.btcState
    : btcStateInput;

  const btc = toUpper(btcState, 'NEUTRAL');
  if (btc === 'NEUTRAL' || btc === 'UNKNOWN' || btc === 'NA') return 'BTC_NEUTRAL';
  if (['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN', 'SHORT'].includes(btc)) return 'BTC_WITH';
  return 'BTC_AGAINST';
}

function microMicroBtcBucket(metrics = {}) {
  const rel = btcRelation(TARGET_TRADE_SIDE, metrics.btcState);
  if (rel === 'BTC_WITH') return 'BTC_BEAR';
  if (rel === 'BTC_AGAINST') return 'BTC_BULL';
  return 'BTC_NEUTRAL';
}

function coarseBtcState(sideOrMetrics, btcStateInput = null) {
  return btcRelation(sideOrMetrics, btcStateInput);
}

function coarseRegime(regime) {
  const r = toUpper(regime, 'NORMAL_VOL');
  if (r.includes('HIGH') || r.includes('EXTREME')) return 'HIGH_VOL';
  if (r.includes('LOW')) return 'LOW_VOL';
  return 'NORMAL_VOL';
}

function coarseFlow(flow) {
  const f = toUpper(flow, 'NEUTRAL');
  if (['TREND', 'IMPULSE', 'DUMP', 'SELL_IMPULSE', 'BEAR_FLOW'].includes(f)) return 'TREND';
  if (f === 'BUILDING') return 'BUILDING';
  return 'NEUTRAL';
}

function coarseScannerReason(reason) {
  const r = toUpper(reason, 'UNKNOWN');
  if (r.includes('SWEEP')) return 'SWEEP';
  if (r.includes('RETEST')) return 'RETEST';
  if (r.includes('PULLBACK')) return 'PULLBACK';
  if (r.includes('BREAKOUT') || r.includes('BREAKDOWN')) return 'BREAKOUT';
  if (r.includes('VOLUME')) return 'VOLUME';
  if (r.includes('MOMENTUM')) return 'MOMENTUM';
  if (r.includes('COMPRESSION')) return 'COMPRESSION';
  if (r.includes('SQUEEZE')) return 'SQUEEZE';
  return 'UNKNOWN';
}

function normalizeObRelation(metrics = {}) {
  const explicit = toUpper(metrics.obRelation || '', '');
  if (explicit) return explicit;
  return toUpper(getObRelation(TARGET_TRADE_SIDE, metrics.obBias) || 'UNKNOWN');
}

function assetClass(metrics = {}) {
  const explicit = toUpper(
    metrics.assetClass ||
      metrics.marketClass ||
      metrics.instrumentClass ||
      '',
    ''
  );

  return explicit || 'CRYPTO';
}

function getCleanSymbol(metrics = {}) {
  const raw = toUpper(
    metrics.symbol ||
      metrics.baseSymbol ||
      metrics.contractSymbol ||
      '',
    ''
  );

  const cleaned = raw
    .replace(/USDTUMCBL|USDCUMCBL|USDTPERP|USDCPERP|USDT|USDC|BUSD|PERP|SWAP|USD/gu, '')
    .replace(/[^A-Z0-9]/gu, '');

  return cleaned || 'UNKNOWN';
}

function symbolClassBucket(metrics = {}) {
  const symbol = getCleanSymbol(metrics);

  const majors = new Set([
    'BTC',
    'ETH',
    'SOL',
    'XRP',
    'BNB',
    'DOGE',
    'ADA',
    'AVAX',
    'LINK',
    'DOT',
    'TON',
    'TRX',
    'LTC',
    'BCH'
  ]);

  const memes = new Set([
    'PEPE',
    'SHIB',
    'WIF',
    'BONK',
    'FLOKI',
    'DOGE'
  ]);

  if (majors.has(symbol)) return 'SYMBOL_MAJOR';
  if (memes.has(symbol)) return 'SYMBOL_MEME';
  return 'SYMBOL_ALT';
}

function getEntryDistancePct(metrics = {}) {
  return firstFinite(
    metrics.entryDistancePct,
    metrics.entryDistanceToMidPct,
    metrics.pullbackDistancePct,
    metrics.distanceToEntryPct,
    metrics.distancePct
  );
}

function getSlDistancePct(metrics = {}) {
  return firstFinite(
    metrics.slDistancePct,
    metrics.stopDistancePct,
    metrics.stopLossDistancePct,
    metrics.riskPct
  );
}

function getTpDistancePct(metrics = {}) {
  return firstFinite(
    metrics.tpDistancePct,
    metrics.takeProfitDistancePct,
    metrics.rewardPct
  );
}

function getLiquidationDistancePct(metrics = {}) {
  return firstFinite(
    metrics.liqDistancePct,
    metrics.liquidationDistancePct,
    metrics.distanceToLiquidationPct,
    metrics.nearestLiqDistancePct
  );
}

function getVolatilityPct(metrics = {}) {
  return firstFinite(
    metrics.atrPct,
    metrics.volatilityPct,
    metrics.rangePct,
    metrics.realizedVolPct
  );
}

function getSpoofScore(metrics = {}) {
  return firstFinite(
    metrics.spoofScore,
    metrics.orderbookSpoofScore,
    metrics.obSpoofScore,
    metrics.fakeLiquidityScore
  );
}

function getOrderbookImbalance(metrics = {}) {
  return firstFinite(
    metrics.orderbookImbalance,
    metrics.bookImbalance,
    metrics.obImbalance,
    metrics.bidAskImbalance
  );
}

function getRsiSlope(metrics = {}) {
  return firstFinite(
    metrics.rsiSlope,
    metrics.rsiVelocity,
    metrics.rsiDelta,
    metrics.rsiMomentum
  );
}

function getCostR(metrics = {}) {
  return firstFinite(
    metrics.costR,
    metrics.avgCostR,
    metrics.estimatedCostR
  );
}

function getConfluenceScore(metrics = {}) {
  return firstFinite(
    metrics.confluence,
    metrics.sniperScore,
    metrics.scannerScore,
    metrics.moveScore
  );
}

function getSpreadPct(metrics = {}) {
  const spreadPct = firstFinite(metrics.spreadPct);
  if (Number.isFinite(spreadPct)) return spreadPct;

  const spreadBps = firstFinite(metrics.spreadBps);
  if (Number.isFinite(spreadBps)) return spreadBps / 10000;

  return NaN;
}