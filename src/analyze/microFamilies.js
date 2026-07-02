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
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';

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

function normalizeBucketText(value, fallback = 'NA') {
  return normalizeToken(value, fallback, 64);
}

function hashText(value, length = MICRO_MICRO_HASH_LEN) {
  const cleanLength = Math.max(6, Math.min(32, Math.floor(Number(length) || MICRO_MICRO_HASH_LEN)));

  const fromStableHash = String(stableHash(String(value || ''), cleanLength) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, cleanLength);

  if (fromStableHash.length >= Math.min(6, cleanLength)) return fromStableHash;

  const fallback = String(value || '')
    .split('')
    .reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) >>> 0, 2166136261)
    .toString(16)
    .toUpperCase();

  return fallback.padEnd(cleanLength, '0').slice(0, cleanLength);
}

function hashParts(parts = [], length = MICRO_MICRO_HASH_LEN) {
  return hashText((Array.isArray(parts) ? parts : [parts]).join('|'), length);
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
    text.includes(`_${pattern}_`)
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

  if (metrics.shortOnly === true || metrics.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (metrics.longOnly === true || metrics.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

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

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionMicroFamilyIsMetadataOnly: true,
    xrIsMetadataOnly: true,

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
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

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

  return 'RAW';
}

function btcRelation(sideOrMetrics, btcStateInput = null) {
  const btcState = sideOrMetrics && typeof sideOrMetrics === 'object'
    ? sideOrMetrics.btcState
    : btcStateInput;

  const btc = toUpper(btcState, 'NEUTRAL');

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN' || btc === 'NA') return 'BTC_NEUTRAL';

  if (['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN'].includes(btc)) {
    return 'BTC_WITH';
  }

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
  if (r.includes('BREAKOUT')) return 'BREAKOUT';
  if (r.includes('VOLUME')) return 'VOLUME';
  if (r.includes('MOMENTUM')) return 'MOMENTUM';
  if (r.includes('COMPRESSION')) return 'COMPRESSION';
  if (r.includes('SQUEEZE')) return 'SQUEEZE';

  return 'UNKNOWN';
}

function normalizeObRelation(metrics = {}) {
  const explicit = toUpper(metrics.obRelation || '', '');

  if (explicit) return explicit;

  return toUpper(
    getObRelation(TARGET_TRADE_SIDE, metrics.obBias) ||
      'UNKNOWN'
  );
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

function normalizeSetupType(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (SETUP_SET.has(raw)) return raw;
  if (SETUP_ALIASES[raw]) return SETUP_ALIASES[raw];

  if (raw.includes('SWEEP') || raw.includes('STOP_RUN') || raw.includes('REVERSAL')) return 'SWEEP_REVERSAL';
  if (raw.includes('RETEST') || raw.includes('PULLBACK') || raw.includes('RIP')) return 'RETEST';
  if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') || raw.includes('COIL') || raw.includes('TIGHT')) return 'COMPRESSION';
  if (raw.includes('CONTINUATION') || raw.includes('TREND_CONT')) return 'CONTINUATION';
  if (raw.includes('BREAKOUT') || raw.includes('BREAK')) return 'BREAKOUT';

  return null;
}

function normalizeRegimeBucket(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (REGIME_SET.has(raw)) return raw;
  if (REGIME_ALIASES[raw]) return REGIME_ALIASES[raw];

  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('LOW_VOL') || raw.includes('TIGHT')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE') || raw.includes('MOMENTUM')) return 'TREND';

  return null;
}

function normalizeConfirmationProfile(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (CONFIRMATION_SET.has(raw)) return raw;
  if (CONFIRMATION_ALIASES[raw]) return CONFIRMATION_ALIASES[raw];

  for (const profile of CONFIRMATION_PROFILES) {
    if (raw.includes(profile)) return profile;
  }

  if (raw.includes('STRONG') || raw.includes('FULL_ALIGN') || raw.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
  if (raw.includes('FLOW') || raw.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
  if (raw.includes('VOLUME') || raw.includes('VOL') || raw.includes('LIQUIDITY')) return 'C_VOLUME_ALIGN';
  if (raw.includes('MIXED') || raw.includes('NEUTRAL') || raw.includes('OK')) return 'D_MIXED_OK';
  if (raw.includes('WEAK') || raw.includes('CONTRA') || raw.includes('AGAINST')) return 'E_WEAK_CONTRA';

  return null;
}

function normalizeMicroMicroEntryBucket(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (MICRO_MICRO_ENTRY_SET.has(raw)) return raw;

  if (['EARLY', 'FAST', 'FRONT', 'NEAR', 'INSTANT', 'IMMEDIATE'].includes(raw)) return 'ENTRY_EARLY';
  if (['NORMAL', 'MID', 'MIDDLE', 'BASE', 'STANDARD'].includes(raw)) return 'ENTRY_NORMAL';
  if (['LATE', 'FAR', 'CHASE', 'EXTENDED', 'DELAYED'].includes(raw)) return 'ENTRY_LATE';

  if (raw.includes('EARLY') || raw.includes('FAST') || raw.includes('IMMEDIATE')) return 'ENTRY_EARLY';
  if (raw.includes('LATE') || raw.includes('CHASE') || raw.includes('EXTENDED')) return 'ENTRY_LATE';

  return null;
}

function normalizeMicroMicroSpreadBucket(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (MICRO_MICRO_SPREAD_SET.has(raw)) return raw;

  if (['LOW', 'TIGHT', 'CHEAP', 'GOOD'].includes(raw)) return 'SPREAD_LOW';
  if (['MID', 'NORMAL', 'OK', 'AVERAGE'].includes(raw)) return 'SPREAD_MID';
  if (['HIGH', 'WIDE', 'EXPENSIVE', 'BAD'].includes(raw)) return 'SPREAD_HIGH';

  if (raw.includes('LOW') || raw.includes('TIGHT')) return 'SPREAD_LOW';
  if (raw.includes('HIGH') || raw.includes('WIDE')) return 'SPREAD_HIGH';

  return null;
}

function normalizeMicroMicroBtcBucket(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (MICRO_MICRO_BTC_SET.has(raw)) return raw;

  if (['BEAR', 'BEARISH', 'DOWN', 'WITH', 'BTC_WITH'].includes(raw)) return 'BTC_BEAR';
  if (['NEUTRAL', 'MIXED', 'FLAT', 'BTC_NEUTRAL'].includes(raw)) return 'BTC_NEUTRAL';
  if (['BULL', 'BULLISH', 'UP', 'AGAINST', 'BTC_AGAINST'].includes(raw)) return 'BTC_BULL';

  if (raw.includes('BEAR') || raw.includes('DOWN') || raw.includes('WITH')) return 'BTC_BEAR';
  if (raw.includes('BULL') || raw.includes('UP') || raw.includes('AGAINST')) return 'BTC_BULL';

  return null;
}

function normalizeMicroMicroRiskBucket(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (MICRO_MICRO_RISK_SET.has(raw)) return raw;

  if (['TIGHT', 'SMALL', 'NARROW'].includes(raw)) return 'RISK_TIGHT';
  if (['CLEAN', 'NORMAL', 'OK', 'GOOD', 'BASE'].includes(raw)) return 'RISK_CLEAN';
  if (['WIDE', 'LARGE', 'FAR'].includes(raw)) return 'RISK_WIDE';

  if (raw.includes('TIGHT') || raw.includes('SMALL')) return 'RISK_TIGHT';
  if (raw.includes('WIDE') || raw.includes('LARGE')) return 'RISK_WIDE';

  return null;
}

function classifyMicroMicroEntryBucket(metrics = {}) {
  const explicit = normalizeMicroMicroEntryBucket(
    metrics.microMicroEntryBucket ||
      metrics.entryTimingBucket ||
      metrics.entryTiming ||
      metrics.entryStage ||
      metrics.stage ||
      ''
  );

  if (explicit) return explicit;

  const entryDistancePct = getEntryDistancePct(metrics);
  const bps = ratioToBps(entryDistancePct);

  if (!Number.isFinite(bps)) return 'ENTRY_NORMAL';
  if (bps < 25) return 'ENTRY_EARLY';
  if (bps >= 150) return 'ENTRY_LATE';

  return 'ENTRY_NORMAL';
}

function classifyMicroMicroSpreadBucket(metrics = {}) {
  const explicit = normalizeMicroMicroSpreadBucket(
    metrics.microMicroSpreadBucket ||
      metrics.spreadBucket ||
      metrics.spreadTier ||
      ''
  );

  if (explicit) return explicit;

  return microMicroSpreadBucket(getSpreadPct(metrics));
}

function classifyMicroMicroBtcBucket(metrics = {}) {
  const explicit = normalizeMicroMicroBtcBucket(
    metrics.microMicroBtcBucket ||
      metrics.btcFitBucket ||
      metrics.btcBucket ||
      metrics.btcRelation ||
      ''
  );

  if (explicit) return explicit;

  return microMicroBtcBucket(metrics);
}

function classifyMicroMicroRiskBucket(metrics = {}) {
  const explicit = normalizeMicroMicroRiskBucket(
    metrics.microMicroRiskBucket ||
      metrics.riskShapeBucket ||
      metrics.riskBucket ||
      metrics.riskShape ||
      ''
  );

  if (explicit) return explicit;

  const riskPct = getSlDistancePct(metrics);
  const bps = ratioToBps(riskPct);

  if (!Number.isFinite(bps)) return 'RISK_CLEAN';
  if (bps < 70) return 'RISK_TIGHT';
  if (bps >= 200) return 'RISK_WIDE';

  return 'RISK_CLEAN';
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

  for (const profile of CONFIRMATION_PROFILES) {
    const suffix = `_${profile}`;

    if (body.endsWith(suffix)) {
      confirmationProfile = profile;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setup = null;
  let regime = null;

  for (const candidateRegime of REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

  const validParent =
    Boolean(parentId) &&
    SETUP_SET.has(setup) &&
    REGIME_SET.has(regime);

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
    rawId,
    setup,
    regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,

    trueMicroFamilyId: validChild || isMicroMicro
      ? childId
      : validParent
        ? parentId
        : null,

    childTrueMicroFamilyId: validChild || isMicroMicro ? childId : null,

    microFamilyId: validChild || isMicroMicro
      ? childId
      : validParent
        ? parentId
        : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO'
      : isChild
        ? 'EXACT_75_CHILD_CONTEXT_ONLY'
        : 'PARENT_15_CONTEXT_ONLY'
  };
}

export function parseMicroMicroFamilyId(id = '') {
  const rawId = String(id || '').trim();
  const value = rawId.toUpperCase();

  const modernMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);

  if (modernMatch) {
    const childParsed = parseShortTaxonomyMicroId(modernMatch[1]);

    if (childParsed.isChild) {
      const hash = modernMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
      const microMicroFamilyId = `${childParsed.childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${hash}`;

      return {
        valid: true,
        selectable: true,
        isMicroMicro: true,
        legacy: false,
        rawId,

        setup: childParsed.setup,
        regime: childParsed.regime,
        confirmationProfile: childParsed.confirmationProfile,

        parentTrueMicroFamilyId: childParsed.parentTrueMicroFamilyId,

        trueMicroFamilyId: childParsed.childTrueMicroFamilyId,
        childTrueMicroFamilyId: childParsed.childTrueMicroFamilyId,
        microFamilyId: childParsed.childTrueMicroFamilyId,

        microMicroFamilyId,
        trueMicroMicroFamilyId: microMicroFamilyId,
        exactMicroMicroFamilyId: microMicroFamilyId,
        microMicroHash: hash,
        executionFingerprintHash: hash,

        microMicroParentTrueMicroFamilyId: childParsed.childTrueMicroFamilyId,
        microMicroParentMicroFamilyId: childParsed.childTrueMicroFamilyId,
        microMicroParentFamilyId: childParsed.childTrueMicroFamilyId,
        microMicroRollupMicroFamilyId: childParsed.childTrueMicroFamilyId,
        microMicroRollupParentFamilyId: childParsed.parentTrueMicroFamilyId,

        microMicroSchema: MICRO_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA,
        trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
        microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        selectionGranularity: 'EXACT_MICRO_MICRO'
      };
    }
  }

  const legacyPrefix = `MM_${TARGET_TRADE_SIDE}_`;

  if (!value.startsWith(legacyPrefix)) {
    return {
      valid: false,
      selectable: false,
      isMicroMicro: false,
      rawId
    };
  }

  const body = value.slice(legacyPrefix.length);

  for (const setup of SETUP_TYPES) {
    for (const regime of REGIME_BUCKETS) {
      for (const confirmationProfile of CONFIRMATION_PROFILES) {
        for (const entryBucket of MICRO_MICRO_ENTRY_BUCKETS) {
          for (const spreadBucket of MICRO_MICRO_SPREAD_BUCKETS) {
            for (const btcBucket of MICRO_MICRO_BTC_BUCKETS) {
              for (const riskBucket of MICRO_MICRO_RISK_BUCKETS) {
                const suffix = `${setup}_${regime}_${confirmationProfile}_${entryBucket}_${spreadBucket}_${btcBucket}_${riskBucket}`;

                if (body !== suffix) continue;

                const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
                const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
                const microMicroHash = hashParts([
                  'LEGACY_MM_BUCKET_MIGRATION',
                  childTrueMicroFamilyId,
                  entryBucket,
                  spreadBucket,
                  btcBucket,
                  riskBucket
                ]);

                const microMicroFamilyId = `${childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;

                return {
                  valid: true,
                  selectable: true,
                  isMicroMicro: true,
                  legacy: true,
                  rawId,
                  legacyMicroMicroFamilyId: value,

                  setup,
                  regime,
                  confirmationProfile,
                  entryBucket,
                  spreadBucket,
                  btcBucket,
                  riskBucket,

                  parentTrueMicroFamilyId,
                  trueMicroFamilyId: childTrueMicroFamilyId,
                  childTrueMicroFamilyId,
                  microFamilyId: childTrueMicroFamilyId,

                  microMicroFamilyId,
                  trueMicroMicroFamilyId: microMicroFamilyId,
                  exactMicroMicroFamilyId: microMicroFamilyId,
                  microMicroHash,
                  executionFingerprintHash: microMicroHash,

                  microMicroParentTrueMicroFamilyId: childTrueMicroFamilyId,
                  microMicroParentMicroFamilyId: childTrueMicroFamilyId,
                  microMicroParentFamilyId: childTrueMicroFamilyId,
                  microMicroRollupMicroFamilyId: childTrueMicroFamilyId,
                  microMicroRollupParentFamilyId: parentTrueMicroFamilyId,

                  microMicroSchema: MICRO_MICRO_SCHEMA,
                  microMicroFamilySchema: MICRO_MICRO_SCHEMA,
                  trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
                  microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
                  selectionGranularity: 'EXACT_MICRO_MICRO'
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: false,
    selectable: false,
    isMicroMicro: false,
    rawId
  };
}

function isScannerFamilyId(id = '') {
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

  if (!value) return false;
  if (parseShortTaxonomyMicroId(value).isMicroMicro) return false;
  if (parseMicroMicroFamilyId(value).valid) return false;

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function isFixedTaxonomyParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedTaxonomyChildMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isFixedTaxonomyMicroId(id = '') {
  return isFixedTaxonomyChildMicroId(id);
}

export function isMicroMicroFamilyId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return parseMicroMicroFamilyId(value).valid === true ||
    parseShortTaxonomyMicroId(value).isMicroMicro === true;
}

export function normalizeMicroMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();

  if (!validLearningId(value)) return '';

  const parsedModern = parseShortTaxonomyMicroId(value);

  if (parsedModern.isMicroMicro) return parsedModern.microMicroFamilyId;

  const parsed = parseMicroMicroFamilyId(value);

  return parsed.valid ? parsed.microMicroFamilyId : '';
}

function normalizeChildTrueMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();

  if (!validLearningId(value)) return '';

  const parsedModern = parseShortTaxonomyMicroId(value);

  if (parsedModern.isMicroMicro) return parsedModern.childTrueMicroFamilyId || '';
  if (parsedModern.isChild) return parsedModern.childTrueMicroFamilyId;

  const parsedMicroMicro = parseMicroMicroFamilyId(value);

  if (parsedMicroMicro.valid) return parsedMicroMicro.childTrueMicroFamilyId;

  return '';
}

function normalizeParentTrueMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();

  if (!value) return '';

  const parsedModern = parseShortTaxonomyMicroId(value);

  if (parsedModern.isMicroMicro || parsedModern.isChild || parsedModern.isParent) {
    return parsedModern.parentTrueMicroFamilyId || '';
  }

  const parsedMicroMicro = parseMicroMicroFamilyId(value);

  if (parsedMicroMicro.valid) return parsedMicroMicro.parentTrueMicroFamilyId || '';

  return '';
}

function isAnalyzeFamilyId(id = '') {
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (!validLearningId(value)) return false;
  if (isMicroMicroFamilyId(value)) return false;
  if (isFixedTaxonomyChildMicroId(value)) return true;
  if (isFixedTaxonomyParentMicroId(value)) return false;

  return (
    /^SHORT_F\d{2}$/u.test(value) ||
    (
      value.startsWith('SHORT_') &&
      !value.startsWith('SHORT_SCANNER_')
    )
  );
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function getScannerMetadata(metrics = {}) {
  const scannerMicroFamilyId = firstValue(
    metrics.scannerMicroFamilyId,
    isScannerFamilyId(metrics.trueMicroFamilyId) ? metrics.trueMicroFamilyId : null,
    isScannerFamilyId(metrics.microFamilyId) ? metrics.microFamilyId : null,
    isScannerFamilyId(metrics.id) ? metrics.id : null,
    isScannerFamilyId(metrics.key) ? metrics.key : null
  );

  const scannerFamilyId = firstValue(
    metrics.scannerFamilyId,
    isScannerFamilyId(metrics.familyId) ? metrics.familyId : null,
    isScannerFamilyId(metrics.baseFamilyId) ? metrics.baseFamilyId : null
  );

  const scannerDefinitionParts = Array.isArray(metrics.scannerDefinitionParts)
    ? metrics.scannerDefinitionParts
    : Array.isArray(metrics.definitionParts) && scannerMicroFamilyId
      ? metrics.definitionParts
      : [];

  const scannerDefinition = firstValue(
    metrics.scannerDefinition,
    scannerMicroFamilyId ? metrics.definition : null,
    scannerMicroFamilyId ? metrics.microDefinition : null
  );

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: scannerDefinition || null,
    scannerDefinitionParts,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false
  };
}

function normalizeSetupType(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (SETUP_SET.has(raw)) return raw;
  if (SETUP_ALIASES[raw]) return SETUP_ALIASES[raw];

  if (raw.includes('SWEEP') || raw.includes('STOP_RUN') || raw.includes('REVERSAL')) return 'SWEEP_REVERSAL';
  if (raw.includes('RETEST') || raw.includes('PULLBACK') || raw.includes('RIP')) return 'RETEST';
  if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') || raw.includes('COIL') || raw.includes('TIGHT')) return 'COMPRESSION';
  if (raw.includes('CONTINUATION') || raw.includes('TREND_CONT')) return 'CONTINUATION';
  if (raw.includes('BREAKOUT') || raw.includes('BREAK')) return 'BREAKOUT';

  return null;
}

function normalizeRegimeBucket(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (REGIME_SET.has(raw)) return raw;
  if (REGIME_ALIASES[raw]) return REGIME_ALIASES[raw];

  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('LOW_VOL') || raw.includes('TIGHT')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE') || raw.includes('MOMENTUM')) return 'TREND';

  return null;
}

function normalizeConfirmationProfile(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return null;
  if (CONFIRMATION_SET.has(raw)) return raw;
  if (CONFIRMATION_ALIASES[raw]) return CONFIRMATION_ALIASES[raw];

  for (const profile of CONFIRMATION_PROFILES) {
    if (raw.includes(profile)) return profile;
  }

  if (raw.includes('STRONG') || raw.includes('FULL_ALIGN') || raw.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
  if (raw.includes('FLOW') || raw.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
  if (raw.includes('VOLUME') || raw.includes('VOL') || raw.includes('LIQUIDITY')) return 'C_VOLUME_ALIGN';
  if (raw.includes('MIXED') || raw.includes('NEUTRAL') || raw.includes('OK')) return 'D_MIXED_OK';
  if (raw.includes('WEAK') || raw.includes('CONTRA') || raw.includes('AGAINST')) return 'E_WEAK_CONTRA';

  return null;
}

function classifySetupType(metrics = {}) {
  const explicit = normalizeSetupType(metrics.setupType || metrics.setup || metrics.shortSetup || '');

  if (explicit) return explicit;

  const existing = firstValue(
    metrics.trueMicroFamilyId,
    metrics.microFamilyId,
    metrics.childTrueMicroFamilyId,
    metrics.microMicroFamilyId,
    metrics.trueMicroMicroFamilyId,
    metrics.exactMicroMicroFamilyId
  );

  const parsedExisting = parseShortTaxonomyMicroId(existing);

  if (parsedExisting.valid && parsedExisting.setup) return parsedExisting.setup;

  const parsedLegacyMicroMicro = parseMicroMicroFamilyId(existing);

  if (parsedLegacyMicroMicro.valid && parsedLegacyMicroMicro.setup) return parsedLegacyMicroMicro.setup;

  const reason = toUpper(
    metrics.scannerReason ||
      metrics.reason ||
      metrics.signalReason ||
      metrics.actionReason ||
      '',
    ''
  );

  const flow = coarseFlow(metrics.flow);
  const volBucket = volatilityTier(getVolatilityPct(metrics));

  if (metrics.retestConfirmed || reason.includes('RETEST')) return 'RETEST';
  if (metrics.sweepConfirmed || reason.includes('SWEEP') || reason.includes('STOP_RUN')) return 'SWEEP_REVERSAL';
  if (metrics.pullbackConfirmed || reason.includes('PULLBACK')) return 'RETEST';

  if (
    reason.includes('COMPRESSION') ||
    reason.includes('SQUEEZE') ||
    (
      volBucket === 'VOL_LOW' &&
      flow !== 'TREND'
    )
  ) {
    return 'COMPRESSION';
  }

  if (
    flow === 'TREND' &&
    !metrics.fakeBreakout &&
    !metrics.fakeBreakoutRisk
  ) {
    return 'CONTINUATION';
  }

  if (reason.includes('BREAKOUT')) return 'BREAKOUT';

  return 'BREAKOUT';
}

function classifyRegimeBucket(metrics = {}) {
  const explicit = normalizeRegimeBucket(metrics.regimeBucket || metrics.regimeClass || '');

  if (explicit) return explicit;

  const existing = firstValue(
    metrics.trueMicroFamilyId,
    metrics.microFamilyId,
    metrics.childTrueMicroFamilyId,
    metrics.microMicroFamilyId,
    metrics.trueMicroMicroFamilyId,
    metrics.exactMicroMicroFamilyId
  );

  const parsedExisting = parseShortTaxonomyMicroId(existing);

  if (parsedExisting.valid && parsedExisting.regime) return parsedExisting.regime;

  const parsedLegacyMicroMicro = parseMicroMicroFamilyId(existing);

  if (parsedLegacyMicroMicro.valid && parsedLegacyMicroMicro.regime) return parsedLegacyMicroMicro.regime;

  const vol = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const volBucket = volatilityTier(getVolatilityPct(metrics));

  if (
    vol === 'LOW_VOL' ||
    volBucket === 'VOL_LOW' ||
    metrics.squeeze === true ||
    metrics.compression === true ||
    metrics.squeezeActive === true
  ) {
    return 'SQUEEZE';
  }

  if (
    flow === 'TREND' ||
    vol === 'HIGH_VOL'
  ) {
    return 'TREND';
  }

  return 'CHOP';
}

function detectStructureAligned(metrics = {}) {
  const reason = toUpper(
    metrics.scannerReason ||
      metrics.reason ||
      metrics.signalReason ||
      metrics.actionReason ||
      '',
    ''
  );

  return Boolean(
    metrics.retestConfirmed ||
    metrics.pullbackConfirmed ||
    metrics.sweepConfirmed ||
    metrics.breakoutConfirmed ||
    metrics.continuationConfirmed ||
    metrics.compressionConfirmed ||
    metrics.setupConfirmed ||
    metrics.structureAlign ||
    metrics.structureAligned
  ) || [
    'RETEST',
    'PULLBACK',
    'SWEEP',
    'STOP_RUN',
    'BREAKOUT',
    'CONTINUATION',
    'COMPRESSION',
    'SQUEEZE'
  ].some((token) => reason.includes(token));
}

function detectFlowAligned(metrics = {}) {
  const flow = coarseFlow(metrics.flow);
  const obRelation = normalizeObRelation(metrics);
  const btcRel = btcRelation(TARGET_TRADE_SIDE, metrics.btcState);
  const orderbookImbalance = getOrderbookImbalance(metrics);

  return Boolean(
    metrics.flowAlign ||
    metrics.flowAligned ||
    metrics.momentumAlign ||
    metrics.askFlowAlign ||
    metrics.bearFlow ||
    metrics.sellFlow
  ) ||
    flow === 'TREND' ||
    flow === 'BUILDING' ||
    obRelation === 'WITH' ||
    btcRel === 'BTC_WITH' ||
    (Number.isFinite(orderbookImbalance) && orderbookImbalance < -0.25);
}

function detectVolumeAligned(metrics = {}) {
  const bucket = toUpper(
    metrics.volBucket ||
      metrics.volumeBucket ||
      metrics.volumeTier ||
      metrics.volumeRegime ||
      '',
    ''
  );

  if ([
    'HIGH',
    'STRONG',
    'EXPANSION',
    'VOLUME_HIGH',
    'VOL_HIGH',
    'HIGH_VOLUME',
    'VOLUME_EXPANSION'
  ].includes(bucket)) {
    return true;
  }

  if (
    metrics.volumeSpike === true ||
    metrics.volumeConfirmed === true ||
    metrics.volumeAlign === true ||
    metrics.volumeAligned === true ||
    metrics.volumeSpikeConfirmed === true ||
    metrics.quoteVolumeSpike === true ||
    metrics.obVolumeAlign === true
  ) {
    return true;
  }

  const relVol = firstFinite(
    metrics.relativeVolume,
    metrics.relVolume,
    metrics.volumeScore,
    metrics.volumeStrength
  );

  return Number.isFinite(relVol) && relVol >= 1.4;
}

function detectHardContra(metrics = {}) {
  const obRelation = normalizeObRelation(metrics);
  const btcRel = btcRelation(TARGET_TRADE_SIDE, metrics.btcState);

  return Boolean(
    metrics.fakeBreakout ||
    metrics.fakeBreakoutRisk ||
    metrics.avoidShort ||
    metrics.doNotShort ||
    metrics.weakContra ||
    metrics.contraSignal ||
    metrics.bullishDivergence
  ) ||
    obRelation === 'AGAINST' ||
    btcRel === 'BTC_AGAINST' ||
    hasLongSignal(metrics.flow) ||
    hasLongSignal(metrics.flowDirection) ||
    hasLongSignal(metrics.orderFlow) ||
    hasLongSignal(metrics.marketFlow) ||
    hasLongSignal(metrics.obBias);
}

function classifyConfirmationProfile(metrics = {}) {
  const explicit = normalizeConfirmationProfile(
    metrics.confirmationProfile ||
      metrics.confirmProfile ||
      metrics.confirmation ||
      ''
  );

  if (explicit) return explicit;

  const existing = firstValue(
    metrics.trueMicroFamilyId,
    metrics.microFamilyId,
    metrics.childTrueMicroFamilyId,
    metrics.microMicroFamilyId,
    metrics.trueMicroMicroFamilyId,
    metrics.exactMicroMicroFamilyId
  );

  const parsedExisting = parseShortTaxonomyMicroId(existing);

  if (parsedExisting.isChild || parsedExisting.isMicroMicro) {
    return parsedExisting.confirmationProfile;
  }

  const parsedLegacyMicroMicro = parseMicroMicroFamilyId(existing);

  if (parsedLegacyMicroMicro.valid && parsedLegacyMicroMicro.confirmationProfile) {
    return parsedLegacyMicroMicro.confirmationProfile;
  }

  const structureAligned = detectStructureAligned(metrics);
  const flowAligned = detectFlowAligned(metrics);
  const volumeAligned = detectVolumeAligned(metrics);
  const hardContraDetected = detectHardContra(metrics);
  const confluence = safeNumber(getConfluenceScore(metrics), 0);

  if (hardContraDetected) return 'E_WEAK_CONTRA';
  if (structureAligned && flowAligned && volumeAligned) return 'A_STRONG_ALIGN';
  if (flowAligned) return 'B_FLOW_ALIGN';
  if (volumeAligned) return 'C_VOLUME_ALIGN';
  if (confluence >= 35 || structureAligned) return 'D_MIXED_OK';

  return 'E_WEAK_CONTRA';
}

function buildTaxonomyFamilyId(metrics = {}) {
  const explicitChild = normalizeChildTrueMicroFamilyId(
    metrics.trueMicroFamilyId ||
      metrics.microFamilyId ||
      metrics.childTrueMicroFamilyId ||
      metrics.microMicroFamilyId ||
      metrics.trueMicroMicroFamilyId ||
      metrics.exactMicroMicroFamilyId
  );

  if (explicitChild) {
    const parsed = parseShortTaxonomyMicroId(explicitChild);

    return {
      setup: parsed.setup,
      regime: parsed.regime,
      confirmationProfile: parsed.confirmationProfile,
      setupType: parsed.setup,
      regimeBucket: parsed.regime,
      parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
      childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
      microFamilyId: parsed.childTrueMicroFamilyId,
      trueMicroFamilyId: parsed.childTrueMicroFamilyId,
      selectable: true
    };
  }

  const setup = classifySetupType(metrics);
  const regime = classifyRegimeBucket(metrics);
  const confirmationProfile = classifyConfirmationProfile(metrics);

  const parentTrueMicroFamilyId = `MICRO_${TARGET_TRADE_SIDE}_${setup}_${regime}`;
  const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;

  return {
    setup,
    regime,
    confirmationProfile,
    setupType: setup,
    regimeBucket: regime,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    microFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId,
    selectable: true
  };
}

function buildMicroMicroFamilyIdFromHash(childTrueMicroFamilyId, hashInput) {
  const child = normalizeChildTrueMicroFamilyId(childTrueMicroFamilyId);
  const hash = normalizeToken(hashInput, '', 32).slice(0, MICRO_MICRO_HASH_LEN);

  if (!child || hash.length < 6) return '';

  return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
}

function buildExecutionFingerprintParts(metrics = {}, parent = {}, taxonomy = {}, microMicroBuckets = {}) {
  const childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || normalizeChildTrueMicroFamilyId(
    metrics.childTrueMicroFamilyId ||
      metrics.trueMicroFamilyId ||
      metrics.microFamilyId ||
      ''
  );

  const parsed = parseShortTaxonomyMicroId(childTrueMicroFamilyId);
  const parentId =
    parsed.parentTrueMicroFamilyId ||
    taxonomy.parentTrueMicroFamilyId ||
    parent.parentTrueMicroFamilyId ||
    normalizeParentTrueMicroFamilyId(childTrueMicroFamilyId) ||
    'NO_PARENT_TRUE_MICRO';

  return [
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${childTrueMicroFamilyId || 'NO_TRUE_MICRO'}`,
    `PARENT_TRUE_MICRO=${parentId || 'NO_PARENT_TRUE_MICRO'}`,
    `SETUP=${parsed.setup || taxonomy.setup || metrics.setupType || 'NA'}`,
    `REGIME_BUCKET=${parsed.regime || taxonomy.regime || metrics.regimeBucket || 'NA'}`,
    `CONFIRMATION_PROFILE=${parsed.confirmationProfile || taxonomy.confirmationProfile || metrics.confirmationProfile || 'NA'}`,

    `ENTRY_BUCKET=${normalizeBucketText(microMicroBuckets.entryBucket || 'ENTRY_NA')}`,
    `SPREAD_BUCKET=${normalizeBucketText(microMicroBuckets.spreadBucket || 'SPREAD_NA')}`,
    `BTC_BUCKET=${normalizeBucketText(microMicroBuckets.btcBucket || 'BTC_NA')}`,
    `RISK_BUCKET=${normalizeBucketText(microMicroBuckets.riskBucket || 'RISK_NA')}`,

    `RSI=${normalizeBucketText(metrics.rsiZone || metrics.rsiCoarse || 'NA')}`,
    `FLOW=${normalizeBucketText(metrics.flowCoarse || metrics.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(metrics.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(metrics.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(metrics.btcRelation || 'NA')}`,
    `REGIME=${normalizeBucketText(metrics.regimeCoarse || metrics.regime || metrics.regimeBucket || 'NA')}`,
    `SCANNER=${normalizeBucketText(metrics.scannerReasonCoarse || metrics.scannerReason || metrics.reason || 'NA')}`,

    `SPREAD_BPS=${normalizeBucketText(metrics.spreadBps ?? metrics.spreadPct ?? 'NA')}`,
    `DEPTH=${normalizeBucketText(metrics.depthMinUsd1p ?? 'NA')}`,
    `RR=${normalizeBucketText(metrics.rr ?? metrics.riskReward ?? 'NA')}`,
    `CONFLUENCE=${normalizeBucketText(metrics.confluence ?? metrics.sniperScore ?? metrics.scannerScore ?? 'NA')}`,
    `ENTRY_QUALITY=${normalizeBucketText(metrics.entryQuality || entryQuality(metrics) || 'NA')}`,

    `ENTRY_DIST=${normalizeBucketText(metrics.entryDistancePct ?? metrics.entryDistanceBps ?? 'NA')}`,
    `RISK_PCT=${normalizeBucketText(metrics.riskPct ?? metrics.slDistancePct ?? 'NA')}`,
    `REWARD_PCT=${normalizeBucketText(metrics.rewardPct ?? metrics.tpDistancePct ?? 'NA')}`,
    `RISK_REWARD_RATIO=${normalizeBucketText(metrics.riskToRewardDistanceRatio ?? 'NA')}`,

    `FAKE_BREAKOUT=${metrics.fakeBreakout === true ? 'YES' : 'NO'}`,
    `FAKE_RISK=${metrics.fakeBreakoutRisk === true ? 'YES' : 'NO'}`,

    `RISK_PLAN=${metrics.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    'SYMBOL_EXCLUDED_FROM_FAMILY_ID=YES',
    'COIN_NAME_EXCLUDED_FROM_FAMILY_ID=YES',
    'XR_METADATA_ONLY=YES',
    'EXECUTION_FINGERPRINT_ROLE=MICRO_MICRO_HASH_SOURCE'
  ];
}

function buildMicroMicroTaxonomy(metrics = {}, taxonomy = {}, parent = {}) {
  const explicit = normalizeMicroMicroFamilyId(
    metrics.microMicroFamilyId ||
      metrics.trueMicroMicroFamilyId ||
      metrics.exactMicroMicroFamilyId ||
      metrics.selectedMicroMicroFamilyId ||
      metrics.microMicroId
  );

  if (explicit) {
    const parsed = parseMicroMicroFamilyId(explicit);

    if (
      parsed.valid &&
      (
        !taxonomy.childTrueMicroFamilyId ||
        parsed.childTrueMicroFamilyId === taxonomy.childTrueMicroFamilyId
      )
    ) {
      return {
        ...parsed,
        source: parsed.legacy ? 'LEGACY_MICRO_MICRO_ID_MIGRATED_TO_HASH_MM' : 'EXPLICIT_MICRO_MICRO_ID'
      };
    }
  }

  const entryBucket = classifyMicroMicroEntryBucket(metrics);
  const spreadBucket = classifyMicroMicroSpreadBucket(metrics);
  const btcBucket = classifyMicroMicroBtcBucket(metrics);
  const riskBucket = classifyMicroMicroRiskBucket(metrics);

  const setup = taxonomy.setup || classifySetupType(metrics);
  const regime = taxonomy.regime || classifyRegimeBucket(metrics);
  const confirmationProfile = taxonomy.confirmationProfile || classifyConfirmationProfile(metrics);

  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId || `MICRO_${TARGET_TRADE_SIDE}_${setup}_${regime}`;
  const childTrueMicroFamilyId = taxonomy.childTrueMicroFamilyId || `${parentTrueMicroFamilyId}_${confirmationProfile}`;

  const hashSeedParts = shouldBuildExecutionFingerprintMetadata()
    ? buildExecutionFingerprintParts(
      metrics,
      parent || { familyId: 'SHORT_FIXED_TAXONOMY', microFamilyId: parentTrueMicroFamilyId },
      {
        ...taxonomy,
        setup,
        regime,
        confirmationProfile,
        parentTrueMicroFamilyId,
        childTrueMicroFamilyId
      },
      {
        entryBucket,
        spreadBucket,
        btcBucket,
        riskBucket
      }
    )
    : [
      TARGET_TRADE_SIDE,
      childTrueMicroFamilyId,
      entryBucket,
      spreadBucket,
      btcBucket,
      riskBucket,
      spreadTier(getSpreadPct(metrics)),
      rrTier(metrics.rr),
      scoreTier(getConfluenceScore(metrics), 'CONF'),
      'SYMBOL_EXCLUDED_FROM_FAMILY_ID=YES'
    ];

  const microMicroHash = hashParts(hashSeedParts, MICRO_MICRO_HASH_LEN);
  const microMicroFamilyId = buildMicroMicroFamilyIdFromHash(childTrueMicroFamilyId, microMicroHash);

  return {
    valid: Boolean(microMicroFamilyId),
    selectable: Boolean(microMicroFamilyId),
    isMicroMicro: Boolean(microMicroFamilyId),
    legacy: false,

    setup,
    regime,
    confirmationProfile,
    entryBucket,
    spreadBucket,
    btcBucket,
    riskBucket,

    parentTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId,
    childTrueMicroFamilyId,
    microFamilyId: childTrueMicroFamilyId,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,
    executionFingerprintHash: microMicroHash,

    microMicroParentTrueMicroFamilyId: childTrueMicroFamilyId,
    microMicroParentMicroFamilyId: childTrueMicroFamilyId,
    microMicroParentFamilyId: childTrueMicroFamilyId,
    microMicroRollupMicroFamilyId: childTrueMicroFamilyId,
    microMicroRollupParentFamilyId: parentTrueMicroFamilyId,

    microMicroSchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_MICRO_MICRO',

    hashSeedParts,
    source: 'DERIVED_EXECUTION_CONTEXT_HASH'
  };
}

function buildMacroDefinitionParts(metrics = {}, familyId, taxonomy = null) {
  const obRelation = normalizeObRelation(metrics);
  const btcRel = btcRelation(metrics);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);

  return [
    `schema=${PARENT_TRUE_MICRO_SCHEMA}`,
    `legacySchema=${getMacroSchema()}`,
    `granularity=${PARENT_LEARNING_GRANULARITY}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${familyId}`,
    `parentTrueMicroFamilyId=${taxonomy?.parentTrueMicroFamilyId || 'UNKNOWN'}`,
    `setupType=${taxonomy?.setup || 'UNKNOWN'}`,
    `regimeBucket=${taxonomy?.regime || 'UNKNOWN'}`,
    `rsi=${coarseRsi(metrics.rsiZone)}`,
    `flow=${flow}`,
    `obRelation=${obRelation}`,
    `btcRelation=${btcRel}`,
    `regime=${regime}`,
    `confluenceTier=${tier(getConfluenceScore(metrics))}`,
    `rrTier=${rrTier(metrics.rr)}`,
    `spreadTier=${spreadTier(getSpreadPct(metrics))}`,
    `depthTier=${depthTier(metrics.depthMinUsd1p)}`,
    `fundingTier=${fundingTier(metrics.fundingRate)}`,
    `entryQuality=${entryQuality(metrics)}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `scannerReason=${scannerReason}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    'parent15ContextOnly=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'microMicroRollup=CHILD_STATS_ROLL_UP_TO_PARENT_15'
  ];
}

function buildMicroDefinitionParts(metrics = {}, parent, taxonomy) {
  const spreadPct = getSpreadPct(metrics);
  const entryDistancePct = getEntryDistancePct(metrics);
  const slDistancePct = getSlDistancePct(metrics);
  const tpDistancePct = getTpDistancePct(metrics);
  const volatilityPct = getVolatilityPct(metrics);
  const spoofScore = getSpoofScore(metrics);
  const orderbookImbalance = getOrderbookImbalance(metrics);
  const rsiSlope = getRsiSlope(metrics);
  const costR = getCostR(metrics);

  return [
    `schema=${TRUE_MICRO_SCHEMA}`,
    `parentSchema=${PARENT_TRUE_MICRO_SCHEMA}`,
    `legacySchema=${getMicroSchema()}`,
    `granularity=${LEARNING_GRANULARITY}`,
    `parentGranularity=${PARENT_LEARNING_GRANULARITY}`,
    `parentTrueMicroFamilyId=${taxonomy.parentTrueMicroFamilyId}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${parent.familyId}`,
    `setupType=${taxonomy.setup}`,
    `regimeBucket=${taxonomy.regime}`,
    `confirmationProfile=${taxonomy.confirmationProfile}`,
    `learningFamily=${taxonomy.childTrueMicroFamilyId}`,
    `trueMicroFamilyId=${taxonomy.childTrueMicroFamilyId}`,
    `assetClass=${assetClass(metrics)}`,
    `rsi=${coarseRsi(metrics.rsiZone)}`,
    `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,
    `flow=${coarseFlow(metrics.flow)}`,
    `obRelation=${normalizeObRelation(metrics)}`,
    `obImbalance=${signedThreeTier(orderbookImbalance, {
      prefix: 'OB_IMB',
      low: -0.25,
      high: 0.25,
      lowLabel: 'ASK_HEAVY',
      midLabel: 'BALANCED',
      highLabel: 'BID_HEAVY'
    })}`,
    `spoof=${scoreBucket(spoofScore, 'SPOOF')}`,
    `btcState=${btcRelation(TARGET_TRADE_SIDE, metrics.btcState)}`,
    `regime=${coarseRegime(metrics.regime)}`,
    `vol=${bucketVolatilityPct(volatilityPct)}`,
    `confluence=${scoreBucket(getConfluenceScore(metrics), 'CONF')}`,
    `rr=${rrMicroBucket(metrics.rr)}`,
    `spread=${spreadTier(spreadPct)}`,
    `depth=${microDepthBucket(metrics.depthMinUsd1p)}`,
    `funding=${fundingTier(metrics.fundingRate)}`,
    `entryQuality=${entryQuality(metrics)}`,
    `entryDistance=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
    `slDistance=${pctThreeTier(slDistancePct, {
      prefix: 'RISK',
      lowBps: 70,
      highBps: 200,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    })}`,
    `tpDistance=${pctThreeTier(tpDistancePct, {
      prefix: 'REWARD',
      lowBps: 100,
      highBps: 350,
      lowLabel: 'SMALL',
      midLabel: 'NORMAL',
      highLabel: 'LARGE'
    })}`,
    `cost=${costTier(costR)}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`,
    `scannerReason=${coarseScannerReason(metrics.scannerReason)}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    'selectionUsesWeeklyWinnerOnly=false',
    'selectionUsesLCBAvgR=true',
    'micro75ContextOnly=true',
    'microMicroLayer=ENABLED_CHILD_OF_75',
    'microMicroDoesNotReplaceMicro75Learning=true',
    'microMicroRollsUpToMicro75=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'grossRFormula=(entry-exitPrice)/(initialSl-entry)',
    'currentRFormula=(entry-currentPrice)/(initialSl-entry)'
  ];
}

function buildMicroMicroDefinitionParts(metrics = {}, parent, taxonomy = {}, microMicro = {}) {
  return [
    `schema=${MICRO_MICRO_SCHEMA}`,
    `trueMicroMicroFamilySchema=${TRUE_MICRO_MICRO_SCHEMA}`,
    `parentSchema=${TRUE_MICRO_SCHEMA}`,
    `grandParentSchema=${PARENT_TRUE_MICRO_SCHEMA}`,
    `granularity=${MICRO_MICRO_LEARNING_GRANULARITY}`,
    `parentGranularity=${LEARNING_GRANULARITY}`,
    `grandParentGranularity=${PARENT_LEARNING_GRANULARITY}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `family=${parent.familyId}`,
    `parentTrueMicroFamilyId=${taxonomy.parentTrueMicroFamilyId}`,
    `trueMicroFamilyId=${taxonomy.childTrueMicroFamilyId}`,
    `childTrueMicroFamilyId=${taxonomy.childTrueMicroFamilyId}`,
    `microMicroFamilyId=${microMicro.microMicroFamilyId}`,
    `trueMicroMicroFamilyId=${microMicro.microMicroFamilyId}`,
    `exactMicroMicroFamilyId=${microMicro.microMicroFamilyId}`,
    `microMicroHash=${microMicro.microMicroHash || microMicro.executionFingerprintHash || 'NO_HASH'}`,
    `microMicroParentTrueMicroFamilyId=${taxonomy.childTrueMicroFamilyId}`,
    `setupType=${taxonomy.setup}`,
    `regimeBucket=${taxonomy.regime}`,
    `confirmationProfile=${taxonomy.confirmationProfile}`,
    `entryBucket=${microMicro.entryBucket}`,
    `spreadBucket=${microMicro.spreadBucket}`,
    `btcBucket=${microMicro.btcBucket}`,
    `riskBucket=${microMicro.riskBucket}`,
    `learningHierarchy=PARENT_15>MICRO_75>MICRO_MICRO`,
    `rollupParent15=${taxonomy.parentTrueMicroFamilyId}`,
    `rollupMicro75=${taxonomy.childTrueMicroFamilyId}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    'selectionUsesWeeklyWinnerOnly=false',
    'selectionUsesLCBAvgR=true',
    'selectionRequiresEligibleGate=true',
    'microMicroSelectionGranularity=EXACT_MICRO_MICRO',
    `microMicroMinCompletedSoft=${MICRO_MICRO_MIN_COMPLETED_SOFT}`,
    `microMicroMinCompletedHard=${MICRO_MICRO_MIN_COMPLETED_HARD}`,
    'microMicroFallbackRule=USE_MICRO_75_CONTEXT_UNTIL_MICRO_MICRO_HAS_SAMPLE',
    'microMicroDoesNotReplaceMicro75Learning=true',
    'microMicroRollsUpToMicro75=true',
    'microMicroRollsUpToParent15=true',
    'discordSelectionPriority=MICRO_MICRO_ONLY',
    'discordSelectionRule=EXACT_MICRO_MICRO_ONLY',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'tpHitRule=SHORT:price<=tp',
    'slHitRule=SHORT:price>=sl'
  ];
}

function classifyFamily(metrics = {}) {
  const sideSafeMetrics = assertShortOnly(metrics);

  const seedParts = [
    TARGET_TRADE_SIDE,
    coarseFlow(sideSafeMetrics.flow),
    coarseRsi(sideSafeMetrics.rsiZone),
    normalizeObRelation(sideSafeMetrics),
    coarseBtcState(TARGET_TRADE_SIDE, sideSafeMetrics.btcState),
    coarseRegime(sideSafeMetrics.regime),
    rrTier(sideSafeMetrics.rr),
    scoreTier(getConfluenceScore(sideSafeMetrics), 'CONF')
  ];

  const bucket = (parseInt(stableHash(seedParts.join('|'), 6), 16) % 24) + 1;

  return `${TARGET_TRADE_SIDE}_F${String(bucket).padStart(2, '0')}`;
}

function resolveAnalyzeFamilyId(metrics = {}) {
  const candidate = firstValue(
    metrics.analyzeFamilyId,
    metrics.learningFamilyId,
    metrics.familyId
  );

  if (isAnalyzeFamilyId(candidate) && !isFixedTaxonomyChildMicroId(candidate)) {
    return String(candidate).toUpperCase();
  }

  return classifyFamily(metrics);
}

export function buildMicroFamilyV1(metrics = {}) {
  const sideSafeMetrics = assertShortOnly(metrics);
  const tradeSide = TARGET_TRADE_SIDE;

  const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);
  const familyId = resolveAnalyzeFamilyId(sideSafeMetrics);

  const obRelation = normalizeObRelation(sideSafeMetrics);
  const btcRel = btcRelation(tradeSide, metrics.btcState);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);
  const definitionParts = buildMacroDefinitionParts(sideSafeMetrics, familyId, taxonomy);
  const schema = PARENT_TRUE_MICRO_SCHEMA;

  const microFamilyId = taxonomy.parentTrueMicroFamilyId;

  return {
    schema,
    version: 'parent-fixed-taxonomy-15-v3-no-crypto',
    macroSchema: schema,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: PARENT_LEARNING_GRANULARITY,

    familyId,
    microFamilyId,
    macroFamilyId: microFamilyId,
    parentMacroFamilyId: microFamilyId,
    parentMicroFamilyId: microFamilyId,
    parentTrueMicroFamilyId: microFamilyId,

    childTrueMicroFamilyId: null,
    trueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: microFamilyId,

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: null,

    definition: definitionParts.join(' | '),
    definitionParts,
    parentDefinition: definitionParts.join(' | '),
    parentDefinitionParts: definitionParts,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    obRelation,
    btcRelation: btcRel,
    regime,
    flow,
    scannerReason,

    ...modeFlags(),

    isLegacyMacro: false,
    isParentTrueMicro: true,
    isTrueMicro: false,
    selectable: false,
    parentOnlyMetadata: true,
    macroOnlyMetadata: true,
    parentSelectionAllowed: false,

    microMicroLayer: 'ROLLUP_TARGET_PARENT_15',
    microMicroLearningEnabled: true,
    microMicroRollsUpToParent15: true,

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3))
  };
}

export function buildMicroFamilyV2(metrics = {}) {
  const sideSafeMetrics = assertShortOnly(metrics);
  const tradeSide = TARGET_TRADE_SIDE;

  const scannerMetadata = getScannerMetadata(sideSafeMetrics);
  const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);
  const parent = buildMicroFamilyV1({
    ...sideSafeMetrics,
    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime
  });

  const microMicro = shouldBuildMicroMicroFamily()
    ? buildMicroMicroTaxonomy(sideSafeMetrics, taxonomy, parent)
    : null;

  const analyzeMicroFamilyId = taxonomy.childTrueMicroFamilyId;
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;
  const microMicroFamilyId = microMicro?.microMicroFamilyId || null;

  const baseDefinitionParts = buildMicroDefinitionParts(sideSafeMetrics, parent, taxonomy);
  const microMicroDefinitionParts = microMicro
    ? buildMicroMicroDefinitionParts(sideSafeMetrics, parent, taxonomy, microMicro)
    : [];

  const executionFingerprintParts = shouldBuildExecutionFingerprintMetadata()
    ? buildExecutionFingerprintParts(sideSafeMetrics, parent, taxonomy, microMicro || {})
    : [];

  const executionFingerprintHash = microMicro?.executionFingerprintHash ||
    microMicro?.microMicroHash ||
    (
      executionFingerprintParts.length
        ? hashParts(executionFingerprintParts, EXECUTION_MICRO_HASH_LEN)
        : null
    );

  const executionMicroFamilyId = executionFingerprintHash
    ? `${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionFingerprintHash}`
    : null;

  const liqDistancePct = getLiquidationDistancePct(sideSafeMetrics);

  const definitionParts = uniqueStrings([
    ...baseDefinitionParts,
    `liqDistanceMetadataOnly=${pctThreeTier(liqDistancePct, {
      prefix: 'LIQ_DIST',
      lowBps: 100,
      highBps: 500,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    })}`,
    `setupType=${taxonomy.setup}`,
    `regimeBucket=${taxonomy.regime}`,
    `confirmationProfile=${taxonomy.confirmationProfile}`,
    `analyzeMicroFamilyId=${analyzeMicroFamilyId}`,
    `trueMicroFamilyId=${analyzeMicroFamilyId}`,
    `childTrueMicroFamilyId=${analyzeMicroFamilyId}`,
    `parentTrueMicroFamilyId=${parentTrueMicroFamilyId}`,
    `coarseMicroFamilyId=${parentTrueMicroFamilyId}`,
    microMicroFamilyId ? `microMicroFamilyId=${microMicroFamilyId}` : null,
    microMicroFamilyId ? `trueMicroMicroFamilyId=${microMicroFamilyId}` : null,
    microMicroFamilyId ? `exactMicroMicroFamilyId=${microMicroFamilyId}` : null,
    executionFingerprintHash ? `microMicroHash=${executionFingerprintHash}` : null,
    microMicro?.entryBucket ? `microMicroEntryBucket=${microMicro.entryBucket}` : null,
    microMicro?.spreadBucket ? `microMicroSpreadBucket=${microMicro.spreadBucket}` : null,
    microMicro?.btcBucket ? `microMicroBtcBucket=${microMicro.btcBucket}` : null,
    microMicro?.riskBucket ? `microMicroRiskBucket=${microMicro.riskBucket}` : null,
    `learningGranularity=${LEARNING_GRANULARITY}`,
    `parentLearningGranularity=${PARENT_LEARNING_GRANULARITY}`,
    `microMicroLearningGranularity=${MICRO_MICRO_LEARNING_GRANULARITY}`,
    `trueMicroFamilySchema=${TRUE_MICRO_SCHEMA}`,
    `childTrueMicroFamilySchema=${CHILD_TRUE_MICRO_SCHEMA}`,
    `parentTrueMicroFamilySchema=${PARENT_TRUE_MICRO_SCHEMA}`,
    `microMicroFamilySchema=${MICRO_MICRO_SCHEMA}`,
    `trueMicroMicroFamilySchema=${TRUE_MICRO_MICRO_SCHEMA}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    'selectionUsesWeeklyWinnerOnly=false',
    'selectionUsesLCBAvgR=true',
    'selectionRequiresEligibleGate=true',
    'learningIdentity=ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    'learningHierarchy=PARENT_15>MICRO_75>MICRO_MICRO',
    'micro75ContextOnly=true',
    'microMicroDoesNotReplaceMicro75Learning=true',
    'microMicroRollsUpToMicro75=true',
    'microMicroRollsUpToParent15=true',
    'scannerFingerprintRole=METADATA_ONLY',
    'executionFingerprintRole=MICRO_MICRO_IDENTITY_HASH_SOURCE',
    'executionFingerprintUsedAsLearningFamily=false',
    'xrMetadataOnly=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'tpHitRule=SHORT:price<=tp',
    'slHitRule=SHORT:price>=sl'
  ].filter(Boolean));

  const rollupLearningFamilyIds = uniqueStrings([
    parentTrueMicroFamilyId,
    analyzeMicroFamilyId,
    microMicroFamilyId
  ]);

  return {
    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    legacyMicroFamilySchema: getMicroSchema(),
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    version: 'child-fixed-taxonomy-75-with-hash-micro-micro-v3-no-crypto',

    familyId: parent.familyId,

    microFamilyId: analyzeMicroFamilyId,
    trueMicroFamilyId: analyzeMicroFamilyId,
    childTrueMicroFamilyId: analyzeMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    analyzeMicroFamilyId,
    learningMicroFamilyId: analyzeMicroFamilyId,
    broadTrueMicroFamilyId: analyzeMicroFamilyId,
    fixedTaxonomyMicroFamilyId: analyzeMicroFamilyId,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    selectedMicroMicroFamilyId: null,

    microMicroHash: executionFingerprintHash,
    microMicroParentTrueMicroFamilyId: analyzeMicroFamilyId,
    microMicroParentMicroFamilyId: analyzeMicroFamilyId,
    microMicroParentFamilyId: analyzeMicroFamilyId,
    microMicroRollupMicroFamilyId: analyzeMicroFamilyId,
    microMicroRollupParentFamilyId: parentTrueMicroFamilyId,

    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroDefinition: microMicroDefinitionParts.join(' | '),
    microMicroDefinitionParts,
    microMicroSelectable: Boolean(microMicroFamilyId),
    microMicroSelectionAllowed: Boolean(microMicroFamilyId),
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO',

    microMicroEntryBucket: microMicro?.entryBucket || null,
    microMicroSpreadBucket: microMicro?.spreadBucket || null,
    microMicroBtcBucket: microMicro?.btcBucket || null,
    microMicroRiskBucket: microMicro?.riskBucket || null,
    microMicroBuckets: microMicro
      ? {
          entry: microMicro.entryBucket,
          spread: microMicro.spreadBucket,
          btc: microMicro.btcBucket,
          risk: microMicro.riskBucket
        }
      : null,

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmationProfile,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningHashInputParts: baseDefinitionParts,

    learningHierarchy: {
      parent15: parentTrueMicroFamilyId,
      micro75: analyzeMicroFamilyId,
      microMicro: microMicroFamilyId
    },
    learningHierarchyDepth: 3,
    learningFamilyIds: rollupLearningFamilyIds,
    rollupLearningFamilyIds,
    statsUpdateFamilyIds: rollupLearningFamilyIds,
    outcomeUpdateFamilyIds: rollupLearningFamilyIds,
    observationUpdateFamilyIds: rollupLearningFamilyIds,
    learningRollupRule: 'EVERY_OBSERVATION_AND_OUTCOME_UPDATES_PARENT_15_MICRO_75_AND_MICRO_MICRO',

    microMicroFallbackRule: 'USE_MICRO_75_CONTEXT_UNTIL_MICRO_MICRO_HAS_SAMPLE',
    microMicroMinCompletedSoft: MICRO_MICRO_MIN_COMPLETED_SOFT,
    microMicroMinCompletedHard: MICRO_MICRO_MIN_COMPLETED_HARD,
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,

    executionFingerprintHash,
    executionFingerprintParts,
    executionFingerprintSchema: executionFingerprintHash ? EXECUTION_MICRO_SUFFIX : null,
    executionMicroFamilyId,
    executionFingerprintRole: executionFingerprintHash ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionMicroFamilyIsMetadataOnly: true,
    xrIsMetadataOnly: true,

    parentDefinition: parent.definition,
    parentDefinitionParts: parent.definitionParts,
    macroFamilyDefinition: parent.definition,
    macroFamilyDefinitionParts: parent.definitionParts,

    definition: definitionParts.join(' | '),
    definitionParts,
    microDefinition: definitionParts.join(' | '),
    microDefinitionParts: definitionParts,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    assetClass: assetClass(sideSafeMetrics),

    obRelation: normalizeObRelation(sideSafeMetrics),
    btcRelation: btcRelation(TARGET_TRADE_SIDE, metrics.btcState),
    btcState: toUpper(metrics.btcState, 'NEUTRAL'),

    regime: coarseRegime(metrics.regime),
    regimeCoarse: coarseRegime(metrics.regime),

    flow: coarseFlow(metrics.flow),
    flowCoarse: coarseFlow(metrics.flow),

    scannerReason: coarseScannerReason(metrics.scannerReason),
    scannerReasonCoarse: coarseScannerReason(metrics.scannerReason),

    rsiZone: coarseRsi(metrics.rsiZone),
    rsiCoarse: coarseRsi(metrics.rsiZone),

    ...modeFlags(),

    isTrueMicro: true,
    trueMicro: true,
    isChildTrueMicro: true,
    isMicro75Context: true,
    micro75ContextOnly: true,

    selectable: Boolean(microMicroFamilyId),
    selectionGranularity: microMicroFamilyId
      ? 'EXACT_MICRO_MICRO'
      : 'EXACT_75_CHILD_CONTEXT_ONLY',

    isLegacyMacro: false,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    fixedTaxonomyLearningId: true,
    parentSelectionAllowed: false,

    isMicroMicro: Boolean(microMicroFamilyId),
    trueMicroMicro: Boolean(microMicroFamilyId),
    exactMicroMicroOnly: Boolean(microMicroFamilyId),

    discordSelectionPriority: 'MICRO_MICRO_ONLY',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordMatchId: microMicroFamilyId,

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3)),
    entryDistanceBps: numericBps(getEntryDistancePct(metrics)),
    slDistanceBps: numericBps(getSlDistancePct(metrics)),
    tpDistanceBps: numericBps(getTpDistancePct(metrics)),
    liqDistanceBps: numericBps(getLiquidationDistancePct(metrics))
  };
}

export function buildMicroFamily(metrics = {}, options = {}) {
  const sideSafeMetrics = assertShortOnly(metrics);
  const schema = toUpper(options.schema || options.version || getMicroSchema());

  if (
    schema === getMacroSchema() ||
    schema === PARENT_TRUE_MICRO_SCHEMA ||
    schema === 'V1' ||
    schema === 'MACRO' ||
    schema === 'PARENT'
  ) {
    return buildMicroFamilyV1(sideSafeMetrics);
  }

  return buildMicroFamilyV2(sideSafeMetrics);
}

export function buildMicroFamilyForSide(metrics = {}, side = TARGET_TRADE_SIDE, options = {}) {
  const requestedSide = normalizeTradeSideValue(side);

  if (requestedSide !== TARGET_TRADE_SIDE) {
    throw new Error(`SHORT_ONLY_MICRO_FAMILY_SYSTEM:${side}`);
  }

  return buildMicroFamily(
    {
      ...metrics,
      ...modeFlags()
    },
    options
  );
}

export function classifyMacroFamily(metrics = {}) {
  return buildMicroFamilyV1(metrics);
}

export function classifyMicroFamily(metrics = {}) {
  return buildMicroFamilyV2(metrics);
}

export function classifyMicroMicroFamily(metrics = {}) {
  return buildMicroFamilyV2(metrics);
}

export function getMicroFamilyId(metrics = {}, options = {}) {
  return buildMicroFamily(metrics, options).microFamilyId;
}

export function getMicroMicroFamilyId(metrics = {}) {
  return buildMicroFamilyV2(metrics).microMicroFamilyId;
}

export function getParentMacroFamilyId(metrics = {}) {
  return buildMicroFamilyV1(metrics).microFamilyId;
}

export function isMicroFamilyV1Id(id) {
  const value = String(id || '').toUpperCase();

  if (isScannerFamilyId(value)) return false;
  if (isMicroMicroFamilyId(value)) return false;
  if (isFixedTaxonomyParentMicroId(value)) return true;
  if (isFixedTaxonomyChildMicroId(value)) return false;

  return (
    value.includes(`_${getMacroSchema()}_`) &&
    value.includes('MICRO_SHORT_') &&
    !isExecutionFingerprintId(value)
  );
}

export function isMicroFamilyV2Id(id) {
  const value = String(id || '').toUpperCase();

  if (!validLearningId(value)) return false;
  if (isMicroMicroFamilyId(value)) return false;
  if (isFixedTaxonomyChildMicroId(value)) return true;
  if (isFixedTaxonomyParentMicroId(value)) return false;

  return (
    value.includes(`_${getMicroSchema()}_`) &&
    value.includes('MICRO_SHORT_') &&
    !isExecutionFingerprintId(value)
  );
}

export function isExecutionRefinedMicroFamilyId(id) {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('MICRO_SHORT_') &&
    !isScannerFamilyId(value) &&
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`)
  );
}

export function isScannerMicroFamilyId(id) {
  return isScannerFamilyId(id);
}

export function attachMicroFamilies(metrics = {}) {
  const sideSafeMetrics = assertShortOnly(metrics);

  const scannerMetadata = getScannerMetadata(sideSafeMetrics);
  const macro = buildMicroFamilyV1(sideSafeMetrics);
  const micro = buildMicroFamilyV2(sideSafeMetrics);

  const rollupLearningFamilyIds = uniqueStrings([
    micro.parentTrueMicroFamilyId,
    micro.trueMicroFamilyId,
    micro.microMicroFamilyId
  ]);

  return {
    ...metrics,

    side: micro.side,
    tradeSide: micro.tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    familyId: micro.familyId,

    macroFamilyId: micro.parentTrueMicroFamilyId,
    parentMacroFamilyId: micro.parentTrueMicroFamilyId,
    parentMicroFamilyId: micro.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: micro.parentTrueMicroFamilyId,

    microFamilyId: micro.microFamilyId,
    trueMicroFamilyId: micro.trueMicroFamilyId,
    childTrueMicroFamilyId: micro.childTrueMicroFamilyId,

    coarseMicroFamilyId: micro.coarseMicroFamilyId,
    baseMicroFamilyId: micro.baseMicroFamilyId,
    legacyMicroFamilyId: micro.legacyMicroFamilyId,

    analyzeMicroFamilyId: micro.analyzeMicroFamilyId,
    learningMicroFamilyId: micro.learningMicroFamilyId,
    broadTrueMicroFamilyId: micro.broadTrueMicroFamilyId,
    fixedTaxonomyMicroFamilyId: micro.fixedTaxonomyMicroFamilyId,

    microMicroFamilyId: micro.microMicroFamilyId,
    trueMicroMicroFamilyId: micro.trueMicroMicroFamilyId,
    exactMicroMicroFamilyId: micro.exactMicroMicroFamilyId,
    microMicroHash: micro.microMicroHash,

    microMicroParentTrueMicroFamilyId: micro.microMicroParentTrueMicroFamilyId,
    microMicroParentMicroFamilyId: micro.microMicroParentMicroFamilyId,
    microMicroParentFamilyId: micro.microMicroParentFamilyId,
    microMicroRollupMicroFamilyId: micro.microMicroRollupMicroFamilyId,
    microMicroRollupParentFamilyId: micro.microMicroRollupParentFamilyId,

    microMicroFamilySchema: micro.microMicroFamilySchema,
    trueMicroMicroFamilySchema: micro.trueMicroMicroFamilySchema,
    microMicroLearningGranularity: micro.microMicroLearningGranularity,
    microMicroDefinition: micro.microMicroDefinition,
    microMicroDefinitionParts: micro.microMicroDefinitionParts,

    microMicroEntryBucket: micro.microMicroEntryBucket,
    microMicroSpreadBucket: micro.microMicroSpreadBucket,
    microMicroBtcBucket: micro.microMicroBtcBucket,
    microMicroRiskBucket: micro.microMicroRiskBucket,
    microMicroBuckets: micro.microMicroBuckets,

    microMicroSelectable: micro.microMicroSelectable,
    microMicroSelectionAllowed: micro.microMicroSelectionAllowed,
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO',
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,
    microMicroFallbackRule: 'USE_MICRO_75_CONTEXT_UNTIL_MICRO_MICRO_HAS_SAMPLE',
    microMicroMinCompletedSoft: MICRO_MICRO_MIN_COMPLETED_SOFT,
    microMicroMinCompletedHard: MICRO_MICRO_MIN_COMPLETED_HARD,

    learningHierarchy: micro.learningHierarchy,
    learningHierarchyDepth: 3,
    learningFamilyIds: rollupLearningFamilyIds,
    rollupLearningFamilyIds,
    statsUpdateFamilyIds: rollupLearningFamilyIds,
    outcomeUpdateFamilyIds: rollupLearningFamilyIds,
    observationUpdateFamilyIds: rollupLearningFamilyIds,
    learningRollupRule: 'EVERY_OBSERVATION_AND_OUTCOME_UPDATES_PARENT_15_MICRO_75_AND_MICRO_MICRO',

    setupType: micro.setupType,
    regimeBucket: micro.regimeBucket,
    confirmationProfile: micro.confirmationProfile,

    learningGranularity: micro.learningGranularity,
    parentLearningGranularity: micro.parentLearningGranularity,
    learningHashInputParts: micro.learningHashInputParts,

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId || micro.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId || micro.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition || micro.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts?.length
      ? scannerMetadata.scannerDefinitionParts
      : micro.scannerDefinitionParts,

    executionFingerprintHash: micro.executionFingerprintHash,
    executionFingerprintParts: micro.executionFingerprintParts,
    executionFingerprintSchema: micro.executionFingerprintSchema,
    executionMicroFamilyId: micro.executionMicroFamilyId,
    executionFingerprintRole: micro.executionFingerprintRole,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionMicroFamilyIsMetadataOnly: true,
    xrIsMetadataOnly: true,

    schema: micro.schema,
    microFamilySchema: micro.microFamilySchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    microFamilyDefinition: micro.definition,
    microFamilyDefinitionParts: micro.definitionParts,

    macroFamilyDefinition: macro.definition,
    macroFamilyDefinitionParts: macro.definitionParts,
    parentDefinition: macro.definition,
    parentDefinitionParts: macro.definitionParts,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    fixedTaxonomyLearningId: true,

    isMicro75Context: true,
    micro75ContextOnly: true,

    selectable: Boolean(micro.microMicroFamilyId),
    selectionGranularity: micro.microMicroFamilyId
      ? 'EXACT_MICRO_MICRO'
      : 'EXACT_75_CHILD_CONTEXT_ONLY',
    parentSelectionAllowed: false,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,
    selectionAvoidsWinnerCurse: true,

    discordSelectionPriority: 'MICRO_MICRO_ONLY',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordMatchId: micro.microMicroFamilyId,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    defaultRanking: 'eligible|avgRLCB95|totalR|avgR|profitFactor|directSLPct|avgCostR',
    bareWinrateRankingDisabled: true,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

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
    noExchangeOrders: true
  };
}

export function attachMicroFamiliesForBothSides(metrics = {}) {
  const short = attachMicroFamilies({
    ...metrics,
    ...modeFlags()
  });

  return {
    short,
    long: null
  };
}