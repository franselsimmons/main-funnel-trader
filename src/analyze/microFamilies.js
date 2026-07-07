// ================= FILE: src/analyze/microFamilies.js =================

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

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

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

const SHORT_MARKET_WEATHER_KEY_V1 = 'SHORT_MARKET_WEATHER_KEY_V1';
const ENTRY_MARKET_WEATHER_CAPTURE_VERSION =
  'SHORT_ENTRY_MARKET_WEATHER_CAPTURE_V2_KNOWN_KEY_REPAIR_IMMUTABLE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V2_POLICY_FIX';
const MARKET_WEATHER_AGGREGATION_VERSION =
  'SHORT_MARKET_WEATHER_AGGREGATION_V1_LIFETIME_REGIME_REGIMETREND';
const MARKET_WEATHER_SELECTOR_VERSION =
  'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V2_CONFIRMED_WEATHER';

const EMPIRICAL_VETO_VERSION = 'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V1';
const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_STATUS_GATE_V4_WEATHER_AWARE_EMPIRICAL_VETO_POLICY_FIX';

const SELECTION_ENGINE_VERSION =
  'SHORT_WEATHER_AWARE_PLAYBOOK_SELECTOR_MICRO_MICRO_V2_OBSERVE_POLICY_FIX';
const E_WEAK_CONTRA_GATE_VERSION = 'SHORT_E_WEAK_CONTRA_POLICY_BLOCK_V3';

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

function now() {
  return Date.now();
}

function getMacroSchema() {
  return String(
    CONFIG?.short?.analyze?.macroSchema ||
      CONFIG?.analyze?.macroSchema ||
      CONFIG?.analyze?.legacySchema ||
      FALLBACK_MACRO_SCHEMA
  ).toUpperCase();
}

function getMicroSchema() {
  return String(
    CONFIG?.short?.analyze?.microSchema ||
      CONFIG?.analyze?.microSchema ||
      FALLBACK_MICRO_SCHEMA
  ).toUpperCase();
}

function shouldBuildExecutionFingerprintMetadata() {
  return CONFIG?.short?.analyze?.buildExecutionFingerprintMetadata ??
    CONFIG?.analyze?.buildExecutionFingerprintMetadata ??
    true;
}

function shouldBuildMicroMicroFamily() {
  return CONFIG?.short?.analyze?.buildMicroMicroFamily ??
    CONFIG?.analyze?.buildMicroMicroFamily ??
    true;
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

function firstFinite(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return NaN;
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

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
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
  if (typeof metrics !== 'object' || metrics === null) {
    return normalizeTradeSideValue(metrics);
  }

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

function marketWeatherFeatureFlags() {
  return {
    version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
    capture: 'live',
    aggregation: 'live',
    selector: 'observe',
    sizingCap: 'observe',
    fdr: 'observe',
    discordTradeReady: 'validated_only',

    entryMarketWeatherCaptureEnabled: true,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_V1,
    entryMarketWeatherCaptureVersion: ENTRY_MARKET_WEATHER_CAPTURE_VERSION,

    entryMarketWeatherPartialKeyRepairEnabled: true,
    entryMarketWeatherUsesConfirmedOrCurrentWeatherFallback: true,
    scannerCandidateWeatherCaptureRequired: true,
    tradeEntryWeatherCaptureRequired: true,
    unknownWeatherNeverTradeReady: true,

    marketWeatherAggregationEnabled: true,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,

    selectorHardLiveDecisionEnabled: false,
    sizingCapHardLiveDecisionEnabled: false,
    fdrHardLiveDecisionEnabled: false,
    discordTradeReadyHardLiveDecisionEnabled: false,

    broadKnownForbiddenFamilyPolicyDisabled: true,
    knownForbiddenFamilyMustBeExplicitFlag: true,
    bFlowAlignIsNeverForbiddenByDefault: true,
    currentFitMisfitIsSoftOnly: true,

    signalTypeDerivedLaterFromRisk: true,
    riskSourceOfTruth: 'riskFractionForEntry'
  };
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

    featureLine: 'MARKET_WEATHER_CAPTURE_SHRINKAGE_VETO_FDR_POSITION_SIZING',
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    entryMarketWeatherCaptureEnabled: true,
    entryMarketWeatherCaptureVersion: ENTRY_MARKET_WEATHER_CAPTURE_VERSION,
    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_V1,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherPartialKeyRepairEnabled: true,

    marketWeatherAggregationEnabled: true,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherStatsLevels: [
      'lifetime',
      'entryMarketWeatherRegime',
      'entryMarketWeatherRegime+entryMarketWeatherTrendSide'
    ],

    selectorMode: 'OBSERVE',
    sizingCapMode: 'OBSERVE',
    fdrMode: 'OBSERVE',
    discordTradeReadyMode: 'VALIDATION_REQUIRED',

    observationFirst: true,
    observationAlwaysCounted: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    empiricalVetoEnabled: true,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoStatus: MICRO_MICRO_STATUS_EMPIRICAL_VETO,
    empiricalVetoReason: 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE',
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoMinCompleted: MICRO_MICRO_MIN_COMPLETED_HARD,
    empiricalVetoBlocksDiscordTradeReady: true,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksParentFallbackRescue: true,
    shrinkageCanDiagnoseButCannotOverrideVeto: true,

    policyBlockedRules: [
      'E_WEAK_CONTRA',
      'INVALID_SIDE',
      'INVALID_GEOMETRY',
      'NON_SHORT',
      'EXPLICIT_KNOWN_FORBIDDEN_FAMILY_FLAG_ONLY'
    ],
    broadKnownForbiddenFamilyPolicyDisabled: true,
    bFlowAlignAutoForbiddenDisabled: true,
    policyBlockedIsSeparateFromEmpiricalVeto: true,

    defaultRanking: 'signalType|shrunkLCB95AvgR|avgRLCB95|totalR|avgR|profitFactor|directSLPct|avgCostR',
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    rankingUsesAvgRLCB95: true,
    rankingUsesShrunkLCB95AvgR: true,
    bareWinrateRankingDisabled: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,
    selectionAvoidsWinnerCurse: true,
    selectionNeverRescuesEmpiricalVetoWithFallback: true,

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

    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    riskSourceOfTruth: 'riskFractionForEntry',
    maxAllowedRiskBandIsOptionalCap: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
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
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
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
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: E_WEAK_CONTRA_GATE_VERSION,
    weakContraRejectedBlocksVirtualEntry: true,
    weakContraRejectedBlocksLearning: false,
    weakContraIsPolicyBlocked: true,

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

function normalizeMarketWeatherRegime(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return 'UNKNOWN';
  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('COIL') || raw.includes('LOW_VOL') || raw.includes('TIGHT')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS') || raw.includes('MIXED')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('MOMENTUM') || raw.includes('IMPULSE') || raw.includes('DIRECTIONAL')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value = '') {
  const raw = normalizeToken(value, '', 80);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return 'BEARISH';
  if (direct === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  if (
    raw.includes('BEAR') ||
    raw.includes('SELL') ||
    raw.includes('SHORT') ||
    raw.includes('DOWN') ||
    raw.includes('RED') ||
    raw.includes('RISK_OFF')
  ) {
    return 'BEARISH';
  }

  if (
    raw.includes('BULL') ||
    raw.includes('BUY') ||
    raw.includes('LONG') ||
    raw.includes('UP') ||
    raw.includes('GREEN') ||
    raw.includes('RISK_ON')
  ) {
    return 'BULLISH';
  }

  if (raw.includes('NEUTRAL') || raw.includes('MIXED') || raw.includes('FLAT')) {
    return 'NEUTRAL';
  }

  return 'UNKNOWN';
}

function buildEntryMarketWeatherKey({ regime, trendSide } = {}) {
  const cleanRegime = normalizeMarketWeatherRegime(regime);
  const cleanTrendSide = normalizeMarketWeatherTrendSide(trendSide);

  return `${cleanRegime}|${cleanTrendSide}`;
}

function parseEntryMarketWeatherKey(value = '') {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw || !raw.includes('|') || raw.includes('[OBJECT OBJECT]')) {
    return {
      key: 'UNKNOWN|UNKNOWN',
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      known: false
    };
  }

  const [regimeRaw, trendRaw] = raw.split('|');

  const regime = normalizeMarketWeatherRegime(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSide(trendRaw);
  const key = `${regime}|${trendSide}`;

  return {
    key,
    regime,
    trendSide,
    known: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
  };
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

    currentMarketWeatherKey: value.currentMarketWeatherKey,
    confirmedMarketWeatherKey: value.confirmedMarketWeatherKey,
    entryMarketWeatherKey: value.entryMarketWeatherKey,
    marketWeatherKey: value.marketWeatherKey,

    marketWeatherRegime: value.marketWeatherRegime,
    currentMarketWeatherRegime: value.currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: value.confirmedMarketWeatherRegime,
    currentRegime: value.currentRegime,
    regime: value.regime,

    marketWeatherTrendSide: value.marketWeatherTrendSide,
    currentMarketWeatherTrendSide: value.currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: value.confirmedMarketWeatherTrendSide,
    currentTrendSide: value.currentTrendSide,
    trendSide: value.trendSide,

    confidence: value.confidence,
    bullishPct: value.bullishPct,
    bearishPct: value.bearishPct,
    neutralPct: value.neutralPct,
    squeezePct: value.squeezePct,
    chopPct: value.chopPct,
    trendPct: value.trendPct,

    btcState: value.btcState,
    btcChange1h: value.btcChange1h,
    btcChange24h: value.btcChange24h
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

function firstKnownMarketWeatherKey(...values) {
  for (const value of values) {
    const parsed = parseEntryMarketWeatherKey(value);

    if (parsed.known) return parsed;
  }

  return null;
}

function resolveEntryMarketWeather(metrics = {}, timestamp = now()) {
  const existingRaw =
    metrics.entryMarketWeatherRaw &&
    typeof metrics.entryMarketWeatherRaw === 'object'
      ? metrics.entryMarketWeatherRaw
      : null;

  const raw = compactEntryMarketWeatherRaw(
    existingRaw ||
      metrics.entryMarketWeather ||
      metrics.currentMarketWeather ||
      metrics.marketWeather ||
      null
  );

  const knownDirect = firstKnownMarketWeatherKey(
    metrics.entryMarketWeatherKey,
    metrics.confirmedMarketWeatherKey,
    metrics.currentMarketWeatherKey,
    metrics.marketWeatherKey,
    raw?.entryMarketWeatherKey,
    raw?.confirmedMarketWeatherKey,
    raw?.currentMarketWeatherKey,
    raw?.marketWeatherKey
  );

  const partialDirect = parseEntryMarketWeatherKey(firstValue(
    metrics.entryMarketWeatherKey,
    metrics.confirmedMarketWeatherKey,
    metrics.currentMarketWeatherKey,
    metrics.marketWeatherKey,
    raw?.entryMarketWeatherKey,
    raw?.confirmedMarketWeatherKey,
    raw?.currentMarketWeatherKey,
    raw?.marketWeatherKey
  ));

  const regime = knownDirect?.regime || normalizeMarketWeatherRegime(firstValue(
    metrics.entryMarketWeatherRegime,
    partialDirect.regime !== 'UNKNOWN' ? partialDirect.regime : null,
    raw?.confirmedMarketWeatherRegime,
    raw?.currentMarketWeatherRegime,
    raw?.marketWeatherRegime,
    raw?.currentRegime,
    raw?.regime,
    metrics.confirmedMarketWeatherRegime,
    metrics.currentMarketWeatherRegime,
    metrics.marketWeatherRegime,
    metrics.currentRegime,
    metrics.regime
  ));

  const trendSide = knownDirect?.trendSide || normalizeMarketWeatherTrendSide(firstValue(
    metrics.entryMarketWeatherTrendSide,
    partialDirect.trendSide !== 'UNKNOWN' ? partialDirect.trendSide : null,
    raw?.confirmedMarketWeatherTrendSide,
    raw?.currentMarketWeatherTrendSide,
    raw?.marketWeatherTrendSide,
    raw?.currentTrendSide,
    raw?.trendSide,
    metrics.confirmedMarketWeatherTrendSide,
    metrics.currentMarketWeatherTrendSide,
    metrics.marketWeatherTrendSide,
    metrics.currentTrendSide,
    metrics.trendSide,
    metrics.marketTrendSide,
    metrics.marketSide,
    metrics.side,
    metrics.direction,
    metrics.btcState
  ));

  const derivedKey = buildEntryMarketWeatherKey({ regime, trendSide });
  const derivedParsed = parseEntryMarketWeatherKey(derivedKey);

  const finalParsed = knownDirect || derivedParsed;

  const capturedAt = safeNumber(
    metrics.entryMarketWeatherCapturedAt ||
      raw?.createdAt ||
      raw?.completedAt ||
      raw?.updatedAt ||
      metrics.openedAt ||
      metrics.createdAt ||
      timestamp,
    timestamp
  );

  const originalDirectKey = firstValue(
    metrics.entryMarketWeatherKey,
    metrics.confirmedMarketWeatherKey,
    metrics.currentMarketWeatherKey,
    metrics.marketWeatherKey,
    raw?.entryMarketWeatherKey,
    raw?.confirmedMarketWeatherKey,
    raw?.currentMarketWeatherKey,
    raw?.marketWeatherKey
  );

  return {
    entryMarketWeatherKey: finalParsed.key,
    entryMarketWeatherKeyVersion: metrics.entryMarketWeatherKeyVersion || SHORT_MARKET_WEATHER_KEY_V1,
    entryMarketWeatherRegime: finalParsed.regime,
    entryMarketWeatherTrendSide: finalParsed.trendSide,
    entryMarketWeatherCapturedAt: capturedAt,
    entryMarketWeatherRaw: raw,
    entryMarketWeatherRawAvailableFields: Array.isArray(metrics.entryMarketWeatherRawAvailableFields)
      ? metrics.entryMarketWeatherRawAvailableFields
      : availableFieldsFromRaw(raw),
    entryMarketWeatherCaptureVersion: ENTRY_MARKET_WEATHER_CAPTURE_VERSION,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    marketWeatherKnown: finalParsed.known,

    originalEntryMarketWeatherKey: originalDirectKey || null,
    entryMarketWeatherPartialKeyRepaired: Boolean(
      originalDirectKey &&
        !parseEntryMarketWeatherKey(originalDirectKey).known &&
        finalParsed.known
    ),
    entryMarketWeatherFallbackSource: knownDirect
      ? 'DIRECT_KNOWN_KEY'
      : finalParsed.known
        ? 'REGIME_TRENDSIDE_REPAIR'
        : 'UNKNOWN'
  };
}

function attachEntryMarketWeather(metrics = {}, timestamp = now()) {
  const weather = resolveEntryMarketWeather(metrics, timestamp);

  return {
    ...metrics,
    ...weather,
    entryMarketWeather: weather.entryMarketWeatherRaw
  };
}

function hasKnownEntryMarketWeather(metrics = {}) {
  const weather = resolveEntryMarketWeather(metrics);

  return (
    weather.entryMarketWeatherRegime !== 'UNKNOWN' &&
    weather.entryMarketWeatherTrendSide !== 'UNKNOWN' &&
    weather.entryMarketWeatherKey !== 'UNKNOWN|UNKNOWN'
  );
}

function weakContraGateConfig() {
  return {
    enabled:
      CONFIG.short?.weakContra?.enabled ??
      CONFIG.analyze?.weakContra?.enabled ??
      CONFIG.trade?.weakContra?.enabled ??
      true,

    hardPolicyBlock: true,

    minConfluence: safeNumber(
      CONFIG.short?.weakContra?.minConfluence ??
        CONFIG.analyze?.weakContra?.minConfluence ??
        CONFIG.trade?.weakContra?.minConfluence,
      72
    ),

    minRR: safeNumber(
      CONFIG.short?.weakContra?.minRR ??
        CONFIG.analyze?.weakContra?.minRR ??
        CONFIG.trade?.weakContra?.minRR,
      1.15
    ),

    maxSpreadPct: safeNumber(
      CONFIG.short?.weakContra?.maxSpreadPct ??
        CONFIG.analyze?.weakContra?.maxSpreadPct ??
        CONFIG.trade?.weakContra?.maxSpreadPct,
      0.0015
    ),

    minDepthUsd1p: safeNumber(
      CONFIG.short?.weakContra?.minDepthUsd1p ??
        CONFIG.analyze?.weakContra?.minDepthUsd1p ??
        CONFIG.trade?.weakContra?.minDepthUsd1p,
      100000
    ),

    maxCostR: safeNumber(
      CONFIG.short?.weakContra?.maxCostR ??
        CONFIG.analyze?.weakContra?.maxCostR ??
        CONFIG.trade?.weakContra?.maxCostR,
      0.35
    ),

    requireStructure:
      CONFIG.short?.weakContra?.requireStructure ??
      CONFIG.analyze?.weakContra?.requireStructure ??
      CONFIG.trade?.weakContra?.requireStructure ??
      true,

    requireFlowOrVolume:
      CONFIG.short?.weakContra?.requireFlowOrVolume ??
      CONFIG.analyze?.weakContra?.requireFlowOrVolume ??
      CONFIG.trade?.weakContra?.requireFlowOrVolume ??
      true,

    requireDepthData:
      CONFIG.short?.weakContra?.requireDepthData ??
      CONFIG.analyze?.weakContra?.requireDepthData ??
      CONFIG.trade?.weakContra?.requireDepthData ??
      false,

    rejectFakeBreakout:
      CONFIG.short?.weakContra?.rejectFakeBreakout ??
      CONFIG.analyze?.weakContra?.rejectFakeBreakout ??
      CONFIG.trade?.weakContra?.rejectFakeBreakout ??
      true
  };
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

  if (['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN', 'SHORT'].includes(btc)) {
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

function getDepthUsd1p(metrics = {}) {
  return firstFinite(
    metrics.depthMinUsd1p,
    metrics.minDepthUsd1p,
    metrics.depthUsd1p,
    metrics.depthUsd,
    metrics.orderbookDepthUsd,
    metrics.liquidityDepthUsd
  );
}

function getRR(metrics = {}) {
  return firstFinite(
    metrics.rr,
    metrics.riskReward,
    metrics.rewardRisk,
    metrics.primaryRR,
    metrics.rrPrimary
  );
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
  if (raw.includes('BREAKOUT') || raw.includes('BREAK') || raw.includes('BREAKDOWN')) return 'BREAKOUT';

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
  if (MICRO_MICRO_ENTRY_BUCKETS.includes(raw)) return raw;

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
  if (MICRO_MICRO_SPREAD_BUCKETS.includes(raw)) return raw;

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
  if (MICRO_MICRO_BTC_BUCKETS.includes(raw)) return raw;

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
  if (MICRO_MICRO_RISK_BUCKETS.includes(raw)) return raw;

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
    selectable: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,

    setup,
    regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: isMicroMicro ? childId : validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild || isMicroMicro ? childId : null,
    microFamilyId: isMicroMicro ? childId : validChild ? childId : validParent ? parentId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: isParent ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : isChild
        ? 'EXACT_75_CHILD_CONTEXT_ONLY'
        : 'PARENT_15_CONTEXT_ONLY'
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

  if (value.includes(`_${MICRO_MICRO_SUFFIX}_`)) return false;

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

function hashParts(parts = [], length = MICRO_MICRO_HASH_LEN) {
  return String(stableHash(parts.join('|'), length))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, length);
}

export function parseMicroMicroFamilyId(id = '') {
  const rawId = String(id || '').trim();
  const value = rawId.toUpperCase();

  const modern = parseShortTaxonomyMicroId(value);

  if (modern.isMicroMicro) {
    return {
      valid: true,
      selectable: true,
      isMicroMicro: true,
      legacy: false,
      rawId,

      setup: modern.setup,
      regime: modern.regime,
      confirmationProfile: modern.confirmationProfile,

      parentTrueMicroFamilyId: modern.parentTrueMicroFamilyId,
      trueMicroFamilyId: modern.childTrueMicroFamilyId,
      childTrueMicroFamilyId: modern.childTrueMicroFamilyId,
      microFamilyId: modern.childTrueMicroFamilyId,

      microMicroFamilyId: modern.microMicroFamilyId,
      trueMicroMicroFamilyId: modern.microMicroFamilyId,
      exactMicroMicroFamilyId: modern.microMicroFamilyId,
      microMicroHash: modern.microMicroHash,
      executionFingerprintHash: modern.microMicroHash,

      microMicroParentTrueMicroFamilyId: modern.childTrueMicroFamilyId,
      microMicroParentMicroFamilyId: modern.childTrueMicroFamilyId,
      microMicroRollupMicroFamilyId: modern.childTrueMicroFamilyId,
      microMicroRollupParentFamilyId: modern.parentTrueMicroFamilyId,

      microMicroSchema: MICRO_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
      selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
    };
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
                  microMicroRollupMicroFamilyId: childTrueMicroFamilyId,
                  microMicroRollupParentFamilyId: parentTrueMicroFamilyId,

                  microMicroSchema: MICRO_MICRO_SCHEMA,
                  microMicroFamilySchema: MICRO_MICRO_SCHEMA,
                  trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
                  microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
                  selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
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

function isFixedTaxonomyParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedTaxonomyChildMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isFixedTaxonomyMicroId(id = '') {
  return isFixedTaxonomyChildMicroId(id);
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

function buildMicroMicroFamilyIdFromHash(childTrueMicroFamilyId, hashInput) {
  const child = normalizeChildTrueMicroFamilyId(childTrueMicroFamilyId) || String(childTrueMicroFamilyId || '').trim().toUpperCase();
  const hash = normalizeToken(hashInput, '', 32).slice(0, MICRO_MICRO_HASH_LEN);

  if (!child || !parseShortTaxonomyMicroId(child).isChild || hash.length < 6) return '';

  return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
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

  if (reason.includes('BREAKOUT') || reason.includes('BREAKDOWN')) return 'BREAKOUT';

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
    'BREAKDOWN',
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

function buildWeakContraEntryGate(metrics = {}, taxonomy = {}) {
  const cfg = weakContraGateConfig();
  const confirmationProfile = taxonomy.confirmationProfile || normalizeConfirmationProfile(metrics.confirmationProfile || '');

  const applies =
    confirmationProfile === 'E_WEAK_CONTRA' ||
    detectHardContra(metrics) ||
    Boolean(metrics.weakContra || metrics.contraSignal);

  const structureAligned = detectStructureAligned(metrics);
  const flowAligned = detectFlowAligned(metrics);
  const volumeAligned = detectVolumeAligned(metrics);

  const confluence = safeNumber(getConfluenceScore(metrics), 0);
  const rr = safeNumber(getRR(metrics), 0);
  const spreadPct = getSpreadPct(metrics);
  const depthUsd1p = getDepthUsd1p(metrics);
  const costR = getCostR(metrics);

  const diagnosticFailures = [];

  if (confluence < cfg.minConfluence) diagnosticFailures.push('E_WEAK_CONTRA_CONFLUENCE_BELOW_MIN');
  if (rr < cfg.minRR) diagnosticFailures.push('E_WEAK_CONTRA_RR_BELOW_MIN');
  if (Number.isFinite(spreadPct) && spreadPct > cfg.maxSpreadPct) diagnosticFailures.push('E_WEAK_CONTRA_SPREAD_TOO_WIDE');
  if (!Number.isFinite(spreadPct)) diagnosticFailures.push('E_WEAK_CONTRA_SPREAD_UNKNOWN');
  if (cfg.requireDepthData && !Number.isFinite(depthUsd1p)) diagnosticFailures.push('E_WEAK_CONTRA_DEPTH_UNKNOWN');
  if (Number.isFinite(depthUsd1p) && depthUsd1p < cfg.minDepthUsd1p) diagnosticFailures.push('E_WEAK_CONTRA_DEPTH_TOO_LOW');
  if (Number.isFinite(costR) && costR > cfg.maxCostR) diagnosticFailures.push('E_WEAK_CONTRA_COST_R_TOO_HIGH');
  if (cfg.requireStructure && !structureAligned) diagnosticFailures.push('E_WEAK_CONTRA_STRUCTURE_NOT_CONFIRMED');
  if (cfg.requireFlowOrVolume && !flowAligned && !volumeAligned) diagnosticFailures.push('E_WEAK_CONTRA_NO_FLOW_OR_VOLUME_CONFIRMATION');
  if (cfg.rejectFakeBreakout && (metrics.fakeBreakout === true || metrics.fakeBreakoutRisk === true)) {
    diagnosticFailures.push('E_WEAK_CONTRA_FAKE_BREAKOUT_RISK');
  }

  const diagnosticStrictEntryOk = applies && diagnosticFailures.length === 0;

  if (!cfg.enabled || !applies) {
    return {
      version: E_WEAK_CONTRA_GATE_VERSION,
      enabled: Boolean(cfg.enabled),
      applies: Boolean(applies),
      passed: true,
      allowed: true,
      rejected: false,
      policyBlocked: false,
      reason: !cfg.enabled ? 'E_WEAK_CONTRA_GATE_DISABLED' : 'NOT_E_WEAK_CONTRA',
      failures: [],

      diagnosticStrictEntryOk,
      diagnosticFailures,

      confirmationProfile,
      structureAligned,
      flowAligned,
      volumeAligned,

      confluence,
      minConfluence: cfg.minConfluence,
      rr,
      minRR: cfg.minRR,
      spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
      maxSpreadPct: cfg.maxSpreadPct,
      depthUsd1p: Number.isFinite(depthUsd1p) ? depthUsd1p : null,
      minDepthUsd1p: cfg.minDepthUsd1p,
      costR: Number.isFinite(costR) ? costR : null,
      maxCostR: cfg.maxCostR
    };
  }

  return {
    version: E_WEAK_CONTRA_GATE_VERSION,
    enabled: Boolean(cfg.enabled),
    applies: true,
    passed: false,
    allowed: false,
    rejected: true,
    policyBlocked: true,
    reason: 'E_WEAK_CONTRA_POLICY_BLOCK',
    failures: ['E_WEAK_CONTRA_POLICY_BLOCK'],

    diagnosticStrictEntryOk,
    diagnosticFailures,

    confirmationProfile,
    structureAligned,
    flowAligned,
    volumeAligned,

    confluence,
    minConfluence: cfg.minConfluence,
    rr,
    minRR: cfg.minRR,
    spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
    maxSpreadPct: cfg.maxSpreadPct,
    depthUsd1p: Number.isFinite(depthUsd1p) ? depthUsd1p : null,
    minDepthUsd1p: cfg.minDepthUsd1p,
    costR: Number.isFinite(costR) ? costR : null,
    maxCostR: cfg.maxCostR,

    requireStructure: Boolean(cfg.requireStructure),
    requireFlowOrVolume: Boolean(cfg.requireFlowOrVolume),
    requireDepthData: Boolean(cfg.requireDepthData),
    rejectFakeBreakout: Boolean(cfg.rejectFakeBreakout),

    policyBlockCategory: MICRO_MICRO_STATUS_POLICY_BLOCKED,
    policyBlockReason: 'E_WEAK_CONTRA_POLICY_BLOCK',
    blocksVirtualEntry: true,
    blocksRiskEntry: true,
    blocksDiscordTradeReady: true,
    blocksLearning: false
  };
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
    const weakContraGate = buildWeakContraEntryGate(metrics, {
      setup: parsed.setup,
      regime: parsed.regime,
      confirmationProfile: parsed.confirmationProfile
    });

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
      selectable: false,

      weakContraEntryGate: weakContraGate,
      weakContraEntryAllowed: weakContraGate.allowed,
      weakContraRejected: weakContraGate.rejected,
      weakContraRejectReason: weakContraGate.rejected ? weakContraGate.reason : null,
      policyBlocked: Boolean(weakContraGate.policyBlocked),
      policyBlockedReason: weakContraGate.policyBlocked ? weakContraGate.reason : null,
      blockVirtualEntry: weakContraGate.rejected,
      virtualObservationAllowed: true,
      tradeCandidateAllowed: !weakContraGate.rejected
    };
  }

  const setup = classifySetupType(metrics);
  const regime = classifyRegimeBucket(metrics);
  const confirmationProfile = classifyConfirmationProfile(metrics);

  const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
  const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
  const weakContraGate = buildWeakContraEntryGate(metrics, {
    setup,
    regime,
    confirmationProfile
  });

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
    selectable: false,

    weakContraEntryGate: weakContraGate,
    weakContraEntryAllowed: weakContraGate.allowed,
    weakContraRejected: weakContraGate.rejected,
    weakContraRejectReason: weakContraGate.rejected ? weakContraGate.reason : null,
    policyBlocked: Boolean(weakContraGate.policyBlocked),
    policyBlockedReason: weakContraGate.policyBlocked ? weakContraGate.reason : null,
    blockVirtualEntry: weakContraGate.rejected,
    virtualObservationAllowed: true,
    tradeCandidateAllowed: !weakContraGate.rejected
  };
}

function buildExecutionFingerprintParts(metrics = {}, parent = {}, taxonomy = {}, microMicroBuckets = {}) {
  const spreadPct = getSpreadPct(metrics);
  const entryDistancePct = getEntryDistancePct(metrics);
  const slDistancePct = getSlDistancePct(metrics);
  const tpDistancePct = getTpDistancePct(metrics);
  const liqDistancePct = getLiquidationDistancePct(metrics);
  const volatilityPct = getVolatilityPct(metrics);
  const spoofScore = getSpoofScore(metrics);
  const orderbookImbalance = getOrderbookImbalance(metrics);
  const rsiSlope = getRsiSlope(metrics);
  const costR = getCostR(metrics);
  const confluence = getConfluenceScore(metrics);

  const scannerReason = firstValue(
    metrics.scannerReasonCoarse,
    metrics.scannerReason,
    metrics.reason,
    metrics.signalReason
  );

  return [
    `xrSchema=${EXECUTION_MICRO_SUFFIX}`,
    `tradeSide=${TARGET_TRADE_SIDE}`,
    `trueMicro=${normalizeToken(taxonomy.childTrueMicroFamilyId || 'NO_TRUE_MICRO')}`,
    `parentTrueMicro=${normalizeToken(taxonomy.parentTrueMicroFamilyId || 'NO_PARENT_TRUE_MICRO')}`,
    `setupType=${normalizeToken(taxonomy.setup || 'NA')}`,
    `regimeBucket=${normalizeToken(taxonomy.regime || 'NA')}`,
    `confirmationProfile=${normalizeToken(taxonomy.confirmationProfile || 'NA')}`,

    `entryBucket=${normalizeToken(microMicroBuckets.entryBucket || 'ENTRY_NA')}`,
    `spreadBucket=${normalizeToken(microMicroBuckets.spreadBucket || 'SPREAD_NA')}`,
    `btcBucket=${normalizeToken(microMicroBuckets.btcBucket || 'BTC_NA')}`,
    `riskBucket=${normalizeToken(microMicroBuckets.riskBucket || 'RISK_NA')}`,

    `family=${normalizeToken(parent.familyId || 'SHORT_FIXED_TAXONOMY')}`,
    `parent=${normalizeToken(parent.microFamilyId || taxonomy.parentTrueMicroFamilyId || 'NO_PARENT')}`,

    `assetClass=${normalizeToken(assetClass(metrics))}`,
    `symbolClass=${symbolClassBucket(metrics)}`,

    `rsi=${normalizeToken(coarseRsi(metrics.rsiZone))}`,
    `rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,

    `flow=${normalizeToken(coarseFlow(metrics.flow))}`,
    `obRelation=${normalizeToken(normalizeObRelation(metrics))}`,
    `obImb=${signedThreeTier(orderbookImbalance, {
      prefix: 'OB_IMB',
      low: -0.25,
      high: 0.25,
      lowLabel: 'ASK_HEAVY',
      midLabel: 'BALANCED',
      highLabel: 'BID_HEAVY'
    })}`,
    `spoof=${scoreBucket(spoofScore, 'SPOOF')}`,
    `btc=${normalizeToken(btcRelation(TARGET_TRADE_SIDE, metrics.btcState))}`,
    `regime=${normalizeToken(coarseRegime(metrics.regime))}`,
    `scanner=${normalizeToken(coarseScannerReason(scannerReason))}`,

    `spread=${spreadTier(spreadPct)}`,
    `entryDist=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
    `risk=${pctThreeTier(slDistancePct, {
      prefix: 'RISK',
      lowBps: 70,
      highBps: 200,
      lowLabel: 'TIGHT',
      midLabel: 'NORMAL',
      highLabel: 'WIDE'
    })}`,
    `reward=${pctThreeTier(tpDistancePct, {
      prefix: 'REWARD',
      lowBps: 100,
      highBps: 350,
      lowLabel: 'SMALL',
      midLabel: 'NORMAL',
      highLabel: 'LARGE'
    })}`,
    `liqDist=${pctThreeTier(liqDistancePct, {
      prefix: 'LIQ_DIST',
      lowBps: 100,
      highBps: 500,
      lowLabel: 'NEAR',
      midLabel: 'MID',
      highLabel: 'FAR'
    })}`,

    `vol=${bucketVolatilityPct(volatilityPct)}`,
    `depth=${depthTier(metrics.depthMinUsd1p)}`,
    `funding=${fundingTier(metrics.fundingRate)}`,
    `rr=${rrTier(metrics.rr)}`,
    `cost=${costTier(costR)}`,
    `confluence=${scoreBucket(confluence, 'CONF')}`,
    `entryQuality=${normalizeToken(entryQuality(metrics))}`,
    `fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
    `fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`,

    `weakContraGate=${taxonomy.weakContraEntryGate?.reason || 'NA'}`,
    `weakContraAllowed=${boolToken(taxonomy.weakContraEntryAllowed)}`,
    `weakContraRejected=${boolToken(taxonomy.weakContraRejected)}`,
    `policyBlocked=${boolToken(taxonomy.policyBlocked)}`
  ];
}

function buildMarketWeatherDefinitionParts(metrics = {}) {
  const weather = resolveEntryMarketWeather(metrics, metrics.createdAt || metrics.openedAt || now());

  return [
    `entryMarketWeatherKey=${weather.entryMarketWeatherKey}`,
    `entryMarketWeatherKeyVersion=${weather.entryMarketWeatherKeyVersion}`,
    `entryMarketWeatherRegime=${weather.entryMarketWeatherRegime}`,
    `entryMarketWeatherTrendSide=${weather.entryMarketWeatherTrendSide}`,
    `entryMarketWeatherCapturedAt=${weather.entryMarketWeatherCapturedAt}`,
    `entryMarketWeatherRawAvailableFields=${weather.entryMarketWeatherRawAvailableFields.join(',') || 'NONE'}`,
    `entryMarketWeatherCaptureVersion=${ENTRY_MARKET_WEATHER_CAPTURE_VERSION}`,
    `entryMarketWeatherImmutable=${boolToken(weather.entryMarketWeatherImmutable)}`,
    `entryMarketWeatherNeverRecomputedAtExit=${boolToken(weather.entryMarketWeatherNeverRecomputedAtExit)}`,
    `entryMarketWeatherPartialKeyRepaired=${boolToken(weather.entryMarketWeatherPartialKeyRepaired)}`,
    `marketWeatherKnown=${boolToken(weather.marketWeatherKnown)}`,
    `marketWeatherAggregationVersion=${MARKET_WEATHER_AGGREGATION_VERSION}`,
    `marketWeatherSelectorVersion=${MARKET_WEATHER_SELECTOR_VERSION}`
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

  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId || `MICRO_SHORT_${setup}_${regime}`;
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
      taxonomy.weakContraEntryGate?.reason || 'NA'
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
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    hashSeedParts,
    hashExcludesMarketWeather: true,
    weatherIsContextOnly: true,
    source: 'DERIVED_EXECUTION_CONTEXT_HASH'
  };
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

function lcb95AvgR(metrics = {}) {
  const explicit = safeNumber(
    metrics.standaloneMicroMicroLifetimeLCB95AvgR ??
      metrics.standaloneLifetimeLCB95AvgR ??
      metrics.avgRLCB95 ??
      metrics.lcb95AvgR ??
      metrics.avgRLowerBound95,
    NaN
  );

  if (Number.isFinite(explicit)) return explicit;

  const completed = safeNumber(metrics.completed ?? metrics.outcomeSample ?? metrics.closed, 0);
  const avgR = safeNumber(metrics.avgR ?? metrics.netAvgR, 0);
  const stdDevR = safeNumber(metrics.stdDevR, NaN);

  if (completed <= 1) return 0;

  if (Number.isFinite(stdDevR) && stdDevR >= 0) {
    return avgR - 1.96 * (stdDevR / Math.sqrt(completed));
  }

  return avgR - 1.96 * (1 / Math.sqrt(completed));
}

function buildEmpiricalVeto(metrics = {}, microMicroFamilyId = null) {
  const completed = safeNumber(metrics.completed ?? metrics.outcomeSample ?? metrics.closed, 0);
  const lcb = lcb95AvgR(metrics);
  const exact = Boolean(microMicroFamilyId && isMicroMicroFamilyId(microMicroFamilyId));

  const triggered =
    exact &&
    completed >= MICRO_MICRO_MIN_COMPLETED_HARD &&
    lcb < 0;

  return {
    version: EMPIRICAL_VETO_VERSION,
    empiricalVeto: triggered,
    empiricalVetoReason: triggered ? 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE' : null,
    status: triggered ? MICRO_MICRO_STATUS_EMPIRICAL_VETO : null,
    exactMicroMicroFamilyId: exact ? microMicroFamilyId : null,
    completed,
    minCompleted: MICRO_MICRO_MIN_COMPLETED_HARD,
    standaloneMicroMicroLifetimeLCB95AvgR: round6(lcb),
    lcb95AvgR: round6(lcb),
    usesRawAvgR: false,
    usesLcb95AvgR: true,
    blocksDiscordTradeReady: triggered,
    blocksRiskEntry: triggered,
    blocksParentFallbackRescue: triggered,
    shrinkageCanDiagnoseButCannotOverride: true,
    mustRunBeforeFallbackShrinkage: true
  };
}

function explicitForbiddenFamilyFlag(metrics = {}, taxonomy = {}) {
  return Boolean(
    metrics.knownForbiddenFamily === true ||
      metrics.forbiddenFamily === true ||
      metrics.blacklistedFamily === true ||
      metrics.familyBlacklisted === true ||
      metrics.policy?.knownForbiddenFamily === true ||
      metrics.policy?.forbiddenFamily === true ||
      metrics.policyFlags?.knownForbiddenFamily === true ||
      metrics.policyFlags?.forbiddenFamily === true ||
      taxonomy.knownForbiddenFamily === true ||
      taxonomy.forbiddenFamily === true ||
      taxonomy.policy?.knownForbiddenFamily === true ||
      taxonomy.policy?.forbiddenFamily === true ||
      taxonomy.policyFlags?.knownForbiddenFamily === true ||
      taxonomy.policyFlags?.forbiddenFamily === true
  );
}

function inheritedForbiddenText(metrics = {}, taxonomy = {}) {
  return [
    metrics.familyPolicy,
    metrics.policyBlockedReason,
    metrics.policyReason,
    metrics.reason,
    taxonomy.policyBlockedReason,
    taxonomy.policyReason,
    ...(Array.isArray(metrics.definitionParts) ? metrics.definitionParts : [])
  ]
    .map((value) => String(value ?? '').toUpperCase())
    .join('|');
}

function hasBroadForbiddenReasonText(metrics = {}, taxonomy = {}) {
  const text = inheritedForbiddenText(metrics, taxonomy);

  return (
    text.includes('KNOWN_FORBIDDEN_FAMILY') ||
    text.includes('FORBIDDEN_FAMILY') ||
    text.includes('BLACKLISTED_FAMILY')
  );
}

function knownForbiddenFamily(metrics = {}, taxonomy = {}) {
  return explicitForbiddenFamilyFlag(metrics, taxonomy);
}

function shouldHonorPolicyBlocked(metrics = {}, taxonomy = {}) {
  const reasonText = inheritedForbiddenText(metrics, taxonomy);
  const broadForbidden = hasBroadForbiddenReasonText(metrics, taxonomy);
  const explicitForbidden = explicitForbiddenFamilyFlag(metrics, taxonomy);

  if (taxonomy.weakContraEntryGate?.policyBlocked || taxonomy.weakContraEntryGate?.reason === 'E_WEAK_CONTRA_POLICY_BLOCK') {
    return {
      honor: true,
      reason:
        taxonomy.weakContraEntryGate?.policyBlockReason ||
        taxonomy.weakContraEntryGate?.reason ||
        'E_WEAK_CONTRA_POLICY_BLOCK',
      inheritedBroadForbiddenIgnored: false
    };
  }

  if (taxonomy.policyBlocked === true) {
    if (broadForbidden && !explicitForbidden) {
      return {
        honor: false,
        reason: null,
        inheritedBroadForbiddenIgnored: true,
        ignoredReasonText: reasonText
      };
    }

    return {
      honor: true,
      reason: taxonomy.policyBlockedReason || 'POLICY_BLOCKED',
      inheritedBroadForbiddenIgnored: false
    };
  }

  if (metrics.policyBlocked === true) {
    if (broadForbidden && !explicitForbidden) {
      return {
        honor: false,
        reason: null,
        inheritedBroadForbiddenIgnored: true,
        ignoredReasonText: reasonText
      };
    }

    return {
      honor: true,
      reason: metrics.policyBlockedReason || 'POLICY_BLOCKED',
      inheritedBroadForbiddenIgnored: false
    };
  }

  return {
    honor: false,
    reason: null,
    inheritedBroadForbiddenIgnored: false
  };
}

function shortGeometryPolicy(metrics = {}) {
  const entry = safeNumber(metrics.entry ?? metrics.entryPrice, 0);
  const sl = safeNumber(metrics.initialSl ?? metrics.sl ?? metrics.stopLoss, 0);
  const tp = safeNumber(metrics.tp ?? metrics.takeProfit, 0);

  const provided = entry > 0 || sl > 0 || tp > 0;

  if (!provided) {
    return {
      provided: false,
      valid: true,
      reason: null
    };
  }

  const valid = tp > 0 && entry > 0 && sl > 0 && tp < entry && entry < sl;

  return {
    provided,
    valid,
    reason: valid ? null : 'INVALID_SHORT_GEOMETRY'
  };
}

function buildPolicyGate(metrics = {}, taxonomy = {}) {
  const side = inferTradeSide(metrics);
  const geometry = shortGeometryPolicy(metrics);
  const inheritedPolicy = shouldHonorPolicyBlocked(metrics, taxonomy);
  const reasons = [];

  if (side === OPPOSITE_TRADE_SIDE) reasons.push('LONG_DISABLED_SHORT_ONLY_SYSTEM');
  if (side !== TARGET_TRADE_SIDE && side !== 'UNKNOWN' && side !== 'MIXED') reasons.push('NON_SHORT_POLICY_BLOCK');
  if (side === 'MIXED') reasons.push('INVALID_SIDE_MIXED_LONG_SHORT');

  if (inheritedPolicy.honor) {
    reasons.push(inheritedPolicy.reason || 'POLICY_BLOCKED');
  }

  if (!geometry.valid) reasons.push(geometry.reason);

  if (knownForbiddenFamily(metrics, taxonomy)) {
    reasons.push('EXPLICIT_KNOWN_FORBIDDEN_FAMILY');
  }

  return {
    version: 'SHORT_POLICY_BLOCK_GATE_V4_BROAD_FORBIDDEN_POLICY_DISABLED',
    policyBlocked: reasons.length > 0,
    blocked: reasons.length > 0,
    reasons: [...new Set(reasons.filter(Boolean))],
    reason: reasons.filter(Boolean)[0] || null,
    empiricalVetoIsSeparate: true,

    broadKnownForbiddenFamilyPolicyDisabled: true,
    bFlowAlignAutoForbiddenDisabled: true,
    explicitForbiddenFamilyFlagRequired: true,
    inheritedBroadForbiddenIgnored: inheritedPolicy.inheritedBroadForbiddenIgnored,
    ignoredInheritedForbiddenReasonText: inheritedPolicy.ignoredReasonText || null
  };
}

function buildRuntimeDecision(metrics = {}, microMicroFamilyId = null, taxonomy = {}) {
  const weather = resolveEntryMarketWeather(metrics);
  const policy = buildPolicyGate(metrics, taxonomy);
  const empirical = buildEmpiricalVeto(metrics, microMicroFamilyId);

  let status = MICRO_MICRO_STATUS_OBSERVING;
  let signalType = SIGNAL_TYPE_OBSERVE_ONLY;
  let riskFractionForEntry = 0;
  let reason = 'OBSERVE_ONLY_NOT_ENOUGH_PROOF';
  let proofTier = 'OBSERVATION_ONLY';

  if (!microMicroFamilyId) {
    status = MICRO_MICRO_STATUS_CONTEXT_ONLY;
    signalType = SIGNAL_TYPE_OBSERVE_ONLY;
    reason = 'CONTEXT_ONLY_NO_EXACT_MICRO_MICRO';
    proofTier = 'CONTEXT_ONLY';
  } else if (policy.policyBlocked) {
    status = MICRO_MICRO_STATUS_POLICY_BLOCKED;
    signalType = SIGNAL_TYPE_BLOCKED;
    reason = policy.reason || 'POLICY_BLOCKED';
    proofTier = 'POLICY_BLOCKED';
  } else if (empirical.empiricalVeto) {
    status = MICRO_MICRO_STATUS_EMPIRICAL_VETO;
    signalType = SIGNAL_TYPE_BLOCKED;
    reason = empirical.empiricalVetoReason;
    proofTier = 'EMPIRICAL_VETO';
  } else if (!weather.marketWeatherKnown) {
    status = MICRO_MICRO_STATUS_OBSERVING;
    signalType = SIGNAL_TYPE_OBSERVE_ONLY;
    reason = 'MARKET_WEATHER_UNKNOWN';
    proofTier = 'OBSERVATION_ONLY';
  } else {
    const completed = safeNumber(metrics.completed ?? metrics.outcomeSample ?? metrics.closed, 0);
    const lcb = lcb95AvgR(metrics);
    const totalR = safeNumber(metrics.totalR ?? metrics.netTotalR, 0);
    const pf = safeNumber(metrics.profitFactor ?? metrics.pf, 0);
    const providedRisk = safeNumber(metrics.riskFractionForEntry, 0);

    if (completed >= MICRO_MICRO_MIN_COMPLETED_HARD && lcb > 0 && totalR > 0 && pf > 1) {
      status = MICRO_MICRO_STATUS_PASSED;
      proofTier = 'EXACT_MICRO_MICRO_LIFETIME_LCB95_PROOF';

      if (
        providedRisk > 0 &&
        String(metrics.signalType || '').toUpperCase() === SIGNAL_TYPE_TRADE_READY
      ) {
        signalType = SIGNAL_TYPE_TRADE_READY;
        riskFractionForEntry = providedRisk;
        reason = 'EXACT_MICRO_MICRO_LCB95_POSITIVE_RISK_APPLIED';
      } else {
        signalType = SIGNAL_TYPE_WATCH_ONLY;
        riskFractionForEntry = 0;
        reason = 'EDGE_POSITIVE_WAITING_FOR_POSITION_SIZING';
      }
    } else if (completed >= MICRO_MICRO_MIN_COMPLETED_HARD) {
      status = MICRO_MICRO_STATUS_REJECTED;
      signalType = SIGNAL_TYPE_BLOCKED;
      reason = 'EXACT_MICRO_MICRO_NOT_POSITIVE_AFTER_HARD_SAMPLE';
      proofTier = 'OBSERVATION_ONLY';
    }
  }

  return {
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroRuntimeStatus: status,
    microMicroRuntimeGateStatus: status,
    microMicroStatus: status,

    signalType,
    proofTier,
    riskFractionForEntry,

    empiricalVeto: empirical.empiricalVeto,
    empiricalVetoReason: empirical.empiricalVetoReason,
    empiricalVetoGate: empirical,

    policyBlocked: policy.policyBlocked,
    policyBlockedReason: policy.reason,
    policyBlockedGate: policy,

    inheritedBroadForbiddenIgnored: policy.inheritedBroadForbiddenIgnored,
    ignoredInheritedForbiddenReasonText: policy.ignoredInheritedForbiddenReasonText,

    marketWeatherKnown: weather.marketWeatherKnown,
    marketWeatherUnknown: !weather.marketWeatherKnown,

    runtimeReason: reason,
    reason,
    whyBlocked:
      status === MICRO_MICRO_STATUS_POLICY_BLOCKED ||
      status === MICRO_MICRO_STATUS_EMPIRICAL_VETO ||
      status === MICRO_MICRO_STATUS_REJECTED ||
      reason === 'MARKET_WEATHER_UNKNOWN'
        ? reason
        : null,

    microMicroRuntimeGate: {
      version: MICRO_MICRO_RUNTIME_GATE_VERSION,
      status,
      reason,
      signalType,
      proofTier,
      empiricalVeto: empirical.empiricalVeto,
      empiricalVetoReason: empirical.empiricalVetoReason,
      policyBlocked: policy.policyBlocked,
      policyBlockedReason: policy.reason,
      inheritedBroadForbiddenIgnored: policy.inheritedBroadForbiddenIgnored,
      ignoredInheritedForbiddenReasonText: policy.ignoredInheritedForbiddenReasonText,
      marketWeatherKnown: weather.marketWeatherKnown,
      marketWeatherUnknown: !weather.marketWeatherKnown,
      riskFractionForEntry
    }
  };
}

function buildMacroDefinitionParts(metrics = {}, familyId, taxonomy = null) {
  const normalizedSide = normalizeSide(metrics);
  const obRelation = normalizeObRelation(metrics);
  const btcRel = btcRelation(metrics);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);

  return [
    `schema=${PARENT_TRUE_MICRO_SCHEMA}`,
    `legacySchema=${getMacroSchema()}`,
    `granularity=${PARENT_LEARNING_GRANULARITY}`,
    `side=${normalizedSide}`,
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
    `weakContraEntryGateVersion=${E_WEAK_CONTRA_GATE_VERSION}`,
    `weakContraEntryAllowed=${boolToken(taxonomy?.weakContraEntryAllowed)}`,
    `weakContraRejected=${boolToken(taxonomy?.weakContraRejected)}`,
    `weakContraRejectReason=${taxonomy?.weakContraRejectReason || 'NONE'}`,
    `policyBlocked=${boolToken(taxonomy?.policyBlocked)}`,
    `policyBlockedReason=${taxonomy?.policyBlockedReason || 'NONE'}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    `empiricalVetoVersion=${EMPIRICAL_VETO_VERSION}`,
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'microMicroRollup=CHILD_STATS_ROLL_UP_TO_PARENT_15',
    'broadKnownForbiddenFamilyPolicyDisabled=true',
    ...buildMarketWeatherDefinitionParts(metrics)
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
    `symbolClass=${symbolClassBucket(metrics)}`,
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
    `weakContraEntryGateVersion=${E_WEAK_CONTRA_GATE_VERSION}`,
    `weakContraEntryAllowed=${boolToken(taxonomy.weakContraEntryAllowed)}`,
    `weakContraRejected=${boolToken(taxonomy.weakContraRejected)}`,
    `weakContraRejectReason=${taxonomy.weakContraRejectReason || 'NONE'}`,
    `policyBlocked=${boolToken(taxonomy.policyBlocked)}`,
    `policyBlockedReason=${taxonomy.policyBlockedReason || 'NONE'}`,
    `blockVirtualEntry=${boolToken(taxonomy.blockVirtualEntry)}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    `empiricalVetoVersion=${EMPIRICAL_VETO_VERSION}`,
    `microMicroRuntimeGateVersion=${MICRO_MICRO_RUNTIME_GATE_VERSION}`,
    'selectionUsesWeeklyWinnerOnly=false',
    'selectionUsesLCBAvgR=true',
    'microMicroLayer=ENABLED_CHILD_OF_75',
    'microMicroDoesNotReplaceMicro75Learning=true',
    'microMicroRollsUpToMicro75=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'grossRFormula=(entry-exitPrice)/(initialSl-entry)',
    'currentRFormula=(entry-currentPrice)/(initialSl-entry)',
    'broadKnownForbiddenFamilyPolicyDisabled=true',
    'bFlowAlignAutoForbiddenDisabled=true',
    ...buildMarketWeatherDefinitionParts(metrics)
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
    `hashExcludesMarketWeather=${boolToken(true)}`,
    `weatherIsContextOnly=${boolToken(true)}`,
    `microMicroParentTrueMicroFamilyId=${taxonomy.childTrueMicroFamilyId}`,
    `setupType=${taxonomy.setup}`,
    `regimeBucket=${taxonomy.regime}`,
    `confirmationProfile=${taxonomy.confirmationProfile}`,
    `entryBucket=${microMicro.entryBucket}`,
    `spreadBucket=${microMicro.spreadBucket}`,
    `btcBucket=${microMicro.btcBucket}`,
    `riskBucket=${microMicro.riskBucket}`,
    `weakContraEntryGateVersion=${E_WEAK_CONTRA_GATE_VERSION}`,
    `weakContraEntryAllowed=${boolToken(taxonomy.weakContraEntryAllowed)}`,
    `weakContraRejected=${boolToken(taxonomy.weakContraRejected)}`,
    `weakContraRejectReason=${taxonomy.weakContraRejectReason || 'NONE'}`,
    `policyBlocked=${boolToken(taxonomy.policyBlocked)}`,
    `policyBlockedReason=${taxonomy.policyBlockedReason || 'NONE'}`,
    `blockVirtualEntry=${boolToken(taxonomy.blockVirtualEntry)}`,
    `empiricalVetoVersion=${EMPIRICAL_VETO_VERSION}`,
    `empiricalVetoReason=EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE`,
    `microMicroRuntimeGateVersion=${MICRO_MICRO_RUNTIME_GATE_VERSION}`,
    `learningHierarchy=PARENT_15>MICRO_75>MICRO_MICRO`,
    `rollupParent15=${taxonomy.parentTrueMicroFamilyId}`,
    `rollupMicro75=${taxonomy.childTrueMicroFamilyId}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,
    'selectionUsesWeeklyWinnerOnly=false',
    'selectionUsesLCBAvgR=true',
    'selectionRequiresEligibleGate=true',
    'microMicroSelectionGranularity=EXACT_MICRO_MICRO_ONLY',
    `microMicroMinCompletedSoft=${MICRO_MICRO_MIN_COMPLETED_SOFT}`,
    `microMicroMinCompletedHard=${MICRO_MICRO_MIN_COMPLETED_HARD}`,
    'microMicroFallbackRule=USE_MICRO_75_CONTEXT_UNTIL_MICRO_MICRO_HAS_SAMPLE',
    'microMicroDoesNotReplaceMicro75Learning=true',
    'microMicroRollsUpToMicro75=true',
    'microMicroRollsUpToParent15=true',
    'discordSelectionPriority=MICRO_MICRO_ONLY',
    'discordSelectionRule=EXACT_MICRO_MICRO_ONLY',
    'executionFingerprintRole=MICRO_MICRO_IDENTITY_HASH_SOURCE',
    'executionFingerprintsUsedAsLearningFamily=false',
    'executionFingerprintsCanDeriveMicroMicroContextHash=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'tpHitRule=SHORT:price<=tp',
    'slHitRule=SHORT:price>=sl',
    'broadKnownForbiddenFamilyPolicyDisabled=true',
    'bFlowAlignAutoForbiddenDisabled=true',
    ...buildMarketWeatherDefinitionParts(metrics)
  ];
}

export function buildMicroFamilyV1(metrics = {}) {
  const inputWithWeather = attachEntryMarketWeather(metrics);
  const sideSafeMetrics = assertShortOnly(inputWithWeather);
  const tradeSide = TARGET_TRADE_SIDE;

  const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);
  const familyId = resolveAnalyzeFamilyId(sideSafeMetrics);

  const normalizedSide = TARGET_DASHBOARD_SIDE;
  const obRelation = normalizeObRelation(sideSafeMetrics);
  const btcRel = btcRelation(tradeSide, metrics.btcState);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);
  const definitionParts = buildMacroDefinitionParts(sideSafeMetrics, familyId, taxonomy);
  const schema = PARENT_TRUE_MICRO_SCHEMA;

  const microFamilyId = taxonomy.parentTrueMicroFamilyId;
  const runtimeDecision = buildRuntimeDecision(sideSafeMetrics, null, taxonomy);

  return {
    ...modeFlags(),
    ...resolveEntryMarketWeather(sideSafeMetrics),

    schema,
    version: 'parent-fixed-taxonomy-15-v7-market-weather-capture-policy-fix',
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

    weakContraEntryGate: taxonomy.weakContraEntryGate,
    weakContraEntryGateVersion: E_WEAK_CONTRA_GATE_VERSION,
    weakContraEntryAllowed: taxonomy.weakContraEntryAllowed,
    weakContraRejected: taxonomy.weakContraRejected,
    weakContraRejectReason: taxonomy.weakContraRejectReason,
    policyBlocked: taxonomy.policyBlocked,
    policyBlockedReason: taxonomy.policyBlockedReason,
    blockVirtualEntry: taxonomy.blockVirtualEntry,
    virtualObservationAllowed: taxonomy.virtualObservationAllowed,
    tradeCandidateAllowed: taxonomy.tradeCandidateAllowed,

    ...runtimeDecision,

    definition: definitionParts.join(' | '),
    definitionParts,
    parentDefinition: definitionParts.join(' | '),
    parentDefinitionParts: definitionParts,

    side: normalizedSide,
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
  const inputWithWeather = attachEntryMarketWeather(metrics);
  const sideSafeMetrics = assertShortOnly(inputWithWeather);
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

  const runtimeDecision = buildRuntimeDecision(sideSafeMetrics, microMicroFamilyId, taxonomy);

  const baseDefinitionParts = buildMicroDefinitionParts(sideSafeMetrics, parent, taxonomy);
  const microMicroDefinitionParts = microMicro
    ? buildMicroMicroDefinitionParts(sideSafeMetrics, parent, taxonomy, microMicro)
    : [];

  const executionFingerprintParts = shouldBuildExecutionFingerprintMetadata()
    ? buildExecutionFingerprintParts(sideSafeMetrics, parent, taxonomy, microMicro || {})
    : [];

  const executionFingerprintHash =
    microMicro?.executionFingerprintHash ||
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
    `hashExcludesMarketWeather=${boolToken(true)}`,
    `weatherIsContextOnly=${boolToken(true)}`,
    `weakContraEntryGateVersion=${E_WEAK_CONTRA_GATE_VERSION}`,
    `weakContraEntryAllowed=${boolToken(taxonomy.weakContraEntryAllowed)}`,
    `weakContraRejected=${boolToken(taxonomy.weakContraRejected)}`,
    `weakContraRejectReason=${taxonomy.weakContraRejectReason || 'NONE'}`,
    `policyBlocked=${boolToken(taxonomy.policyBlocked)}`,
    `policyBlockedReason=${taxonomy.policyBlockedReason || 'NONE'}`,
    `blockVirtualEntry=${boolToken(taxonomy.blockVirtualEntry)}`,
    `virtualObservationAllowed=${boolToken(taxonomy.virtualObservationAllowed)}`,
    `tradeCandidateAllowed=${boolToken(taxonomy.tradeCandidateAllowed)}`,
    `empiricalVetoVersion=${EMPIRICAL_VETO_VERSION}`,
    `empiricalVeto=${boolToken(runtimeDecision.empiricalVeto)}`,
    `empiricalVetoReason=${runtimeDecision.empiricalVetoReason || 'NONE'}`,
    `policyBlockedGateVersion=${runtimeDecision.policyBlockedGate?.version || 'NA'}`,
    `broadKnownForbiddenFamilyPolicyDisabled=${boolToken(true)}`,
    `inheritedBroadForbiddenIgnored=${boolToken(runtimeDecision.inheritedBroadForbiddenIgnored)}`,
    `microMicroRuntimeGateVersion=${MICRO_MICRO_RUNTIME_GATE_VERSION}`,
    `microMicroRuntimeStatus=${runtimeDecision.microMicroRuntimeStatus}`,
    `signalType=${runtimeDecision.signalType}`,
    `reason=${runtimeDecision.reason || runtimeDecision.runtimeReason || 'NA'}`,
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
    'learningIdentity=ANALYZE_MICRO_MICRO_FAMILY_FIXED_TAXONOMY',
    'learningHierarchy=PARENT_15>MICRO_75>MICRO_MICRO',
    'microMicroDoesNotReplaceMicro75Learning=true',
    'microMicroRollsUpToMicro75=true',
    'microMicroRollsUpToParent15=true',
    'scannerFingerprintRole=METADATA_ONLY',
    'scannerFingerprintsUsedAsLearningFamily=false',
    'executionFingerprintRole=MICRO_MICRO_IDENTITY_HASH_SOURCE',
    'executionFingerprintsUsedAsLearningFamily=false',
    'executionFingerprintsCanDeriveMicroMicroContextHash=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometryRule=SHORT:tp<entry<sl',
    'tpHitRule=SHORT:price<=tp',
    'slHitRule=SHORT:price>=sl',
    ...buildMarketWeatherDefinitionParts(sideSafeMetrics)
  ].filter(Boolean));

  const rollupLearningFamilyIds = uniqueStrings([
    parentTrueMicroFamilyId,
    analyzeMicroFamilyId,
    microMicroFamilyId
  ]);

  return {
    ...modeFlags(),
    ...resolveEntryMarketWeather(sideSafeMetrics),

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    legacyMicroFamilySchema: getMicroSchema(),
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    version: 'child-fixed-taxonomy-75-with-hash-micro-micro-v7-market-weather-policy-fix',

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
    hashExcludesMarketWeather: true,
    weatherIsContextOnly: true,
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
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

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

    weakContraEntryGate: taxonomy.weakContraEntryGate,
    weakContraEntryGateVersion: E_WEAK_CONTRA_GATE_VERSION,
    weakContraEntryAllowed: taxonomy.weakContraEntryAllowed,
    weakContraRejected: taxonomy.weakContraRejected,
    weakContraRejectReason: taxonomy.weakContraRejectReason,
    policyBlocked: runtimeDecision.policyBlocked,
    policyBlockedReason: runtimeDecision.policyBlockedReason,
    policyBlockedGate: runtimeDecision.policyBlockedGate,
    inheritedBroadForbiddenIgnored: runtimeDecision.inheritedBroadForbiddenIgnored,
    ignoredInheritedForbiddenReasonText: runtimeDecision.ignoredInheritedForbiddenReasonText,
    broadKnownForbiddenFamilyPolicyDisabled: true,
    bFlowAlignAutoForbiddenDisabled: true,
    blockVirtualEntry: taxonomy.blockVirtualEntry || runtimeDecision.policyBlocked || runtimeDecision.empiricalVeto,
    virtualObservationAllowed: true,
    tradeCandidateAllowed: taxonomy.tradeCandidateAllowed && !runtimeDecision.policyBlocked && !runtimeDecision.empiricalVeto,

    ...runtimeDecision,

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
    exactMicroMicroVetoCheckedBeforeFallback: true,

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,

    executionFingerprintHash,
    executionFingerprintParts,
    executionFingerprintSchema: executionFingerprintHash ? EXECUTION_MICRO_SUFFIX : null,
    executionMicroFamilyId,
    executionFingerprintRole: executionFingerprintHash ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !executionFingerprintHash,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: Boolean(executionFingerprintHash),

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

    isTrueMicro: true,
    trueMicro: true,
    isChildTrueMicro: true,
    selectable: false,
    selectionGranularity: 'EXACT_75_CHILD_CONTEXT_ONLY',
    isLegacyMacro: false,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    fixedTaxonomyLearningId: true,
    parentSelectionAllowed: false,

    isMicroMicro: Boolean(microMicroFamilyId),
    trueMicroMicro: Boolean(microMicroFamilyId),
    exactMicroMicroOnly: Boolean(microMicroFamilyId),

    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordMatchId: microMicroFamilyId,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3)),
    entryDistanceBps: numericBps(getEntryDistancePct(metrics)),
    slDistanceBps: numericBps(getSlDistancePct(metrics)),
    tpDistanceBps: numericBps(getTpDistancePct(metrics)),
    liqDistanceBps: numericBps(getLiquidationDistancePct(metrics))
  };
}

export function buildMicroFamily(metrics = {}, options = {}) {
  const sideSafeMetrics = assertShortOnly(attachEntryMarketWeather(metrics));
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

export function getWeakContraEntryGate(metrics = {}) {
  const sideSafeMetrics = assertShortOnly(metrics);
  const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);

  return buildWeakContraEntryGate(sideSafeMetrics, taxonomy);
}

export function getEntryMarketWeatherKey(metrics = {}) {
  return resolveEntryMarketWeather(metrics).entryMarketWeatherKey;
}

export function getEntryMarketWeather(metrics = {}) {
  return resolveEntryMarketWeather(metrics);
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
  const inputWithWeather = attachEntryMarketWeather(metrics);
  const sideSafeMetrics = assertShortOnly(inputWithWeather);

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
    ...resolveEntryMarketWeather(sideSafeMetrics),

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

    hashExcludesMarketWeather: true,
    weatherIsContextOnly: true,

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
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,
    microMicroFallbackRule: 'USE_MICRO_75_CONTEXT_UNTIL_MICRO_MICRO_HAS_SAMPLE',
    microMicroMinCompletedSoft: MICRO_MICRO_MIN_COMPLETED_SOFT,
    microMicroMinCompletedHard: MICRO_MICRO_MIN_COMPLETED_HARD,
    exactMicroMicroVetoCheckedBeforeFallback: true,

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

    weakContraEntryGate: micro.weakContraEntryGate,
    weakContraEntryGateVersion: E_WEAK_CONTRA_GATE_VERSION,
    weakContraEntryAllowed: micro.weakContraEntryAllowed,
    weakContraRejected: micro.weakContraRejected,
    weakContraRejectReason: micro.weakContraRejectReason,
    policyBlocked: micro.policyBlocked,
    policyBlockedReason: micro.policyBlockedReason,
    policyBlockedGate: micro.policyBlockedGate,
    inheritedBroadForbiddenIgnored: micro.inheritedBroadForbiddenIgnored,
    ignoredInheritedForbiddenReasonText: micro.ignoredInheritedForbiddenReasonText,
    broadKnownForbiddenFamilyPolicyDisabled: true,
    bFlowAlignAutoForbiddenDisabled: true,
    blockVirtualEntry: micro.blockVirtualEntry,
    virtualObservationAllowed: micro.virtualObservationAllowed,
    tradeCandidateAllowed: micro.tradeCandidateAllowed,

    empiricalVeto: micro.empiricalVeto,
    empiricalVetoReason: micro.empiricalVetoReason,
    empiricalVetoGate: micro.empiricalVetoGate,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroRuntimeStatus: micro.microMicroRuntimeStatus,
    microMicroRuntimeGateStatus: micro.microMicroRuntimeGateStatus,
    microMicroStatus: micro.microMicroStatus,
    microMicroRuntimeGate: micro.microMicroRuntimeGate,

    signalType: micro.signalType,
    proofTier: micro.proofTier,
    riskFractionForEntry: micro.riskFractionForEntry,
    whyBlocked: micro.whyBlocked,
    runtimeReason: micro.runtimeReason,
    reason: micro.reason,

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
    executionFingerprintsMetadataOnly: micro.executionFingerprintsMetadataOnly,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: micro.executionFingerprintsCanDeriveMicroMicroContextHash,

    schema: micro.schema,
    microFamilySchema: micro.microFamilySchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
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
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    fixedTaxonomyLearningId: true,

    selectable: false,
    selectionGranularity: 'EXACT_75_CHILD_CONTEXT_ONLY',
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

    defaultRanking: 'signalType|shrunkLCB95AvgR|avgRLCB95|totalR|avgR|profitFactor|directSLPct|avgCostR',
    bareWinrateRankingDisabled: true,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,
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

    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,

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

export {
  isFixedTaxonomyMicroId,
  isFixedTaxonomyChildMicroId,
  isFixedTaxonomyParentMicroId,
  normalizeChildTrueMicroFamilyId,
  normalizeParentTrueMicroFamilyId
};