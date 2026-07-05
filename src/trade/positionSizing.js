// ================= FILE: src/trade/positionSizing.js =================

import { CONFIG } from '../config.js';
import {
  clamp,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

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

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;

const POSITION_SIZING_VERSION = 'SHORT_POSITION_SIZING_RISK_SOURCE_OF_TRUTH_V2_ENTRY_MARKET_WEATHER';
const POSITION_SIZING_INPUT_VERSION = 'SHORT_POSITION_SIZING_INPUT_PROOFTIER_SIGNALTYPE_V1';
const SHORT_MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION = 'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V1_OBSERVE';
const EMPIRICAL_VETO_VERSION = 'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V1';

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_MICRO_MICRO_MARKET = 'MICRO_MICRO_MARKET_PROOF';
const PROOF_TIER_MICRO_MICRO_LIFETIME = 'MICRO_MICRO_LIFETIME_PROOF';
const PROOF_TIER_CHILD_75_MARKET = 'CHILD_75_MARKET_PROOF';
const PROOF_TIER_CHILD_75_LIFETIME = 'CHILD_75_LIFETIME_PROOF';
const PROOF_TIER_PARENT_15_MARKET = 'PARENT_15_MARKET_PROOF';
const PROOF_TIER_PARENT_15_LIFETIME = 'PARENT_15_LIFETIME_PROOF';
const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MAX_ALLOWED_RISK_BAND_HIGH = 'HIGH';
const MAX_ALLOWED_RISK_BAND_MEDIUM = 'MEDIUM';
const MAX_ALLOWED_RISK_BAND_LOW = 'LOW';
const MAX_ALLOWED_RISK_BAND_ZERO = 'ZERO';

const STATUS_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const STATUS_POLICY_BLOCKED = 'POLICY_BLOCKED';

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

const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return NaN;
}

function normalizeToken(value, fallback = '') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function normalizeRatioOrPct(value, fallback = 0) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return fallback;
  if (n > 1.5) return n / 100;

  return n;
}

function finiteOrInfinity(value, fallback = Number.POSITIVE_INFINITY) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(0, n);
}

function sizingConfig() {
  const baseRiskPct = Math.max(
    0,
    safeNumber(
      CONFIG.short?.sizing?.baseRiskPct ??
        CONFIG.sizing?.shortBaseRiskPct ??
        CONFIG.sizing?.baseRiskPct,
      0.0025
    )
  );

  const maxMult = Math.max(
    0,
    safeNumber(
      CONFIG.short?.sizing?.maxMult ??
        CONFIG.sizing?.shortMaxMult ??
        CONFIG.sizing?.maxMult,
      1.15
    )
  );

  return {
    enabled:
      CONFIG.short?.sizing?.enabled ??
      CONFIG.sizing?.shortEnabled ??
      CONFIG.sizing?.enabled ??
      true,

    baseRiskPct,

    minMult: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.minMult ??
          CONFIG.sizing?.shortMinMult ??
          CONFIG.sizing?.minMult,
        0.35
      )
    ),

    maxMult,

    maxTotalRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxTotalRiskPct ??
          CONFIG.sizing?.shortMaxTotalRiskPct ??
          CONFIG.sizing?.maxTotalRiskPct,
        0.03
      )
    ),

    maxSameSideRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxSameSideRiskPct ??
          CONFIG.sizing?.shortMaxSameSideRiskPct ??
          CONFIG.sizing?.maxSameSideRiskPct,
        0.015
      )
    ),

    maxCounterBtcRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxCounterBtcRiskPct ??
          CONFIG.sizing?.shortMaxCounterBtcRiskPct ??
          CONFIG.sizing?.maxCounterBtcRiskPct,
        0.0075
      )
    ),

    priorTrades: Math.max(
      1,
      safeNumber(
        CONFIG.short?.rotation?.priorTrades ??
          CONFIG.rotation?.shortPriorTrades ??
          CONFIG.rotation?.priorTrades,
        35
      )
    ),

    hardRejectBadStats:
      CONFIG.short?.sizing?.hardRejectBadStats ??
      CONFIG.sizing?.shortHardRejectBadStats ??
      CONFIG.sizing?.hardRejectBadStats ??
      true,

    minCompletedForStatsGate: Math.max(
      1,
      safeNumber(
        CONFIG.short?.sizing?.minCompletedForStatsGate ??
          CONFIG.sizing?.shortMinCompletedForStatsGate ??
          CONFIG.sizing?.minCompletedForStatsGate,
        MIN_COMPLETED_MICRO_MICRO_ACTIVE
      )
    ),

    maxDirectSlRate: normalizeRatioOrPct(
      CONFIG.short?.sizing?.maxDirectSlRate ??
        CONFIG.sizing?.shortMaxDirectSlRate ??
        CONFIG.sizing?.maxDirectSlRate,
      0.55
    ),

    maxAvgCostR: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxAvgCostR ??
          CONFIG.sizing?.shortMaxAvgCostR ??
          CONFIG.sizing?.maxAvgCostR,
        0.55
      )
    ),

    maxLeverage: Math.max(
      0.1,
      safeNumber(
        CONFIG.short?.sizing?.maxLeverage ??
          CONFIG.sizing?.shortMaxLeverage ??
          CONFIG.sizing?.maxLeverage,
        10
      )
    ),

    liquidationSafetyEnabled:
      CONFIG.short?.sizing?.liquidationSafetyEnabled ??
      CONFIG.sizing?.shortLiquidationSafetyEnabled ??
      CONFIG.sizing?.liquidationSafetyEnabled ??
      true,

    maintenanceMarginPct: Math.max(
      0,
      normalizeRatioOrPct(
        CONFIG.short?.sizing?.maintenanceMarginPct ??
          CONFIG.sizing?.shortMaintenanceMarginPct ??
          CONFIG.sizing?.maintenanceMarginPct,
        0.005
      )
    ),

    liquidationFeeBufferPct: Math.max(
      0,
      normalizeRatioOrPct(
        CONFIG.short?.sizing?.liquidationFeeBufferPct ??
          CONFIG.sizing?.shortLiquidationFeeBufferPct ??
          CONFIG.sizing?.liquidationFeeBufferPct,
        0.002
      )
    ),

    minLiquidationBufferPct: Math.max(
      0,
      normalizeRatioOrPct(
        CONFIG.short?.sizing?.minLiquidationBufferPct ??
          CONFIG.sizing?.shortMinLiquidationBufferPct ??
          CONFIG.sizing?.minLiquidationBufferPct,
        0.015
      )
    ),

    liquidationBufferRiskMult: Math.max(
      1,
      safeNumber(
        CONFIG.short?.sizing?.liquidationBufferRiskMult ??
          CONFIG.sizing?.shortLiquidationBufferRiskMult ??
          CONFIG.sizing?.liquidationBufferRiskMult,
        1.25
      )
    ),

    riskBandCapsEnabled:
      CONFIG.short?.sizing?.riskBandCapsEnabled ??
      CONFIG.sizing?.shortRiskBandCapsEnabled ??
      CONFIG.sizing?.riskBandCapsEnabled ??
      true,

    highRiskBandCapPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.highRiskBandCapPct ??
          CONFIG.sizing?.shortHighRiskBandCapPct ??
          CONFIG.sizing?.highRiskBandCapPct,
        baseRiskPct * maxMult
      )
    ),

    mediumRiskBandCapPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.mediumRiskBandCapPct ??
          CONFIG.sizing?.shortMediumRiskBandCapPct ??
          CONFIG.sizing?.mediumRiskBandCapPct,
        baseRiskPct * 0.75
      )
    ),

    lowRiskBandCapPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.lowRiskBandCapPct ??
          CONFIG.sizing?.shortLowRiskBandCapPct ??
          CONFIG.sizing?.lowRiskBandCapPct,
        baseRiskPct * 0.25
      )
    ),

    watchOnlyRiskFraction:
      CONFIG.short?.sizing?.watchOnlyRiskFraction ??
      CONFIG.sizing?.shortWatchOnlyRiskFraction ??
      CONFIG.sizing?.watchOnlyRiskFraction ??
      0,

    observeOnlyRiskFraction:
      CONFIG.short?.sizing?.observeOnlyRiskFraction ??
      CONFIG.sizing?.shortObserveOnlyRiskFraction ??
      CONFIG.sizing?.observeOnlyRiskFraction ??
      0,

    requirePositiveShrunkLcbForTradeReady:
      CONFIG.short?.sizing?.requirePositiveShrunkLcbForTradeReady ??
      CONFIG.sizing?.shortRequirePositiveShrunkLcbForTradeReady ??
      CONFIG.sizing?.requirePositiveShrunkLcbForTradeReady ??
      true,

    sizingCapMode:
      CONFIG.short?.sizing?.marketWeatherSizingCapMode ??
      CONFIG.sizing?.shortMarketWeatherSizingCapMode ??
      CONFIG.sizing?.marketWeatherSizingCapMode ??
      'OBSERVE',

    discordTradeReadyHardLiveEnabled:
      CONFIG.short?.sizing?.discordTradeReadyHardLiveEnabled ??
      CONFIG.sizing?.shortDiscordTradeReadyHardLiveEnabled ??
      CONFIG.sizing?.discordTradeReadyHardLiveEnabled ??
      false
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

    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKeyDimensionsV1: [
      'entryMarketWeatherRegime',
      'entryMarketWeatherTrendSide'
    ],

    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,

    positionSizingVersion: POSITION_SIZING_VERSION,
    positionSizingInputVersion: POSITION_SIZING_INPUT_VERSION,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksDiscordTradeReady: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    alwaysReturnAnswer: true,
    alwaysReturnAnswerDoesNotMeanAlwaysTrade: true
  };
}

function baseModeFlags() {
  return {
    positionSizingVersion: POSITION_SIZING_VERSION,
    positionSizingInputVersion: POSITION_SIZING_INPUT_VERSION,

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

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
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
    fixedTaxonomyPreferred: true,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    exactMicroMicroOnly: true,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    minCompletedForMicroMicroActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortRiskShape: 'tp < entry < sl',
    shortRiskShape: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    sizingFollowsStopDistance: true,
    sizingFormula: 'notional = (equity * riskFraction) / stopRiskPct',
    leverageIsDerivedFromStopRisk: true,
    fixedLeverageDisabled: true,
    liquidationSafetyEnabled: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,

    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKeyDimensionsV1: [
      'entryMarketWeatherRegime',
      'entryMarketWeatherTrendSide'
    ],
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
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

function isModernMicroMicroId(id = '') {
  return /^MICRO_SHORT_.+_MM_[A-Z0-9]{6,24}$/u.test(upper(id));
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

  if (isModernMicroMicroId(value)) return false;

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

function parseChildOrParentMicroShortId(id = '') {
  const value = upper(id);

  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId: String(id || '').trim()
    };
  }

  let body = value.slice('MICRO_SHORT_'.length);

  const mmHashMatch = /^(.+)_MM_([A-Z0-9]{6,24})$/u.exec(body);

  if (mmHashMatch) {
    body = mmHashMatch[1];
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

  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

  const validParent =
    Boolean(parentId) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);

  const microMicroHash = mmHashMatch?.[2] || null;
  const microMicroFamilyId = validChild && microMicroHash
    ? `${childId}_MM_${microMicroHash.slice(0, 10)}`
    : null;

  return {
    valid: validParent || validChild || Boolean(microMicroFamilyId),
    selectable: Boolean(microMicroFamilyId),
    selectableForDiscord: Boolean(microMicroFamilyId),
    isParent: validParent && !validChild && !microMicroFamilyId,
    isChild: validChild && !microMicroFamilyId,
    isMicroMicro: Boolean(microMicroFamilyId),
    rawId: String(id || '').trim(),

    setup,
    regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: microMicroFamilyId
      ? microMicroFamilyId
      : validChild
        ? childId
        : validParent
          ? parentId
          : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    base75ChildTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: microMicroFamilyId ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: microMicroFamilyId ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: microMicroFamilyId
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity: microMicroFamilyId
      ? 'EXACT_MICRO_MICRO_ONLY'
      : validChild
        ? 'EXACT_75_CHILD_CONTEXT_ONLY'
        : 'PARENT_15_CONTEXT_ONLY'
  };
}

function parseBucketMicroMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value.startsWith('MM_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isMicroMicro: false,
      rawId
    };
  }

  const body = value.slice('MM_SHORT_'.length);

  for (const setup of SETUP_ORDER) {
    for (const regime of REGIME_ORDER) {
      for (const confirmationProfile of CONFIRMATION_PROFILE_ORDER) {
        for (const entryBucket of MICRO_MICRO_ENTRY_BUCKETS) {
          for (const spreadBucket of MICRO_MICRO_SPREAD_BUCKETS) {
            for (const btcBucket of MICRO_MICRO_BTC_BUCKETS) {
              for (const riskBucket of MICRO_MICRO_RISK_BUCKETS) {
                const suffix = [
                  setup,
                  regime,
                  confirmationProfile,
                  entryBucket,
                  spreadBucket,
                  btcBucket,
                  riskBucket
                ].join('_');

                if (body !== suffix) continue;

                const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
                const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
                const microMicroFamilyId = `MM_SHORT_${suffix}`;

                return {
                  valid: true,
                  selectable: true,
                  selectableForDiscord: true,
                  isParent: false,
                  isChild: false,
                  isMicroMicro: true,
                  rawId,

                  setup,
                  regime,
                  confirmationProfile,
                  entryBucket,
                  spreadBucket,
                  btcBucket,
                  riskBucket,

                  parentTrueMicroFamilyId,
                  trueMicroFamilyId: microMicroFamilyId,
                  childTrueMicroFamilyId,
                  base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,

                  microMicroFamilyId,
                  trueMicroMicroFamilyId: microMicroFamilyId,
                  exactMicroMicroFamilyId: microMicroFamilyId,

                  trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
                  exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
                  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
                  microMicroFamilySchema: MICRO_MICRO_SCHEMA,
                  trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

                  learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
                  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
                  child75LearningGranularity: LEARNING_GRANULARITY,
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

function parseLearningFamilyId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value || !validLearningId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  if (value.startsWith('MM_SHORT_')) return parseBucketMicroMicroId(value);

  return parseChildOrParentMicroShortId(value);
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (SHORT_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = normalizeToken(raw);

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('MM_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit && longHit) {
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function textParts(row = {}) {
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
    .map((value) => upper(value))
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,

    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    row.id,
    row.key,

    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.executionMicroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasShortIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MM_SHORT_') ||
    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('|SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT')
  );
}

function hasLongIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('|LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MM_SHORT_') ||
    haystack.includes('MICRO_SHORT_')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  const shortHit = hasShortIdSignal(haystack);
  const longHit = hasLongIdSignal(haystack);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = textParts(row);

  if (!parts.length) return 'UNKNOWN';

  const shortHit = hasShortDefinitionSignal(parts);
  const longHit = hasLongDefinitionSignal(parts);
  const haystack = parts.join('|');

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) return fromIds;

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function extractLearningFamilyId(row = {}) {
  const candidates = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,

    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId
  ];

  for (const candidate of candidates) {
    const id = String(candidate || '').trim().toUpperCase();

    if (!id || !validLearningId(id)) continue;

    const parsed = parseLearningFamilyId(id);

    if (parsed.valid) return id;
  }

  return '';
}

function taxonomyIdentity(row = {}) {
  const id = extractLearningFamilyId(row);
  const parsed = parseLearningFamilyId(id);

  if (!parsed.valid) {
    return {
      exactChild: false,
      exactMicroMicro: false,
      selectable: false,

      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      base75ChildTrueMicroFamilyId: null,
      trueMicroFamilyId: id || null,

      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,

      setupType: null,
      regimeBucket: null,
      confirmationProfile: null,
      entryBucket: null,
      spreadBucket: null,
      btcBucket: null,
      riskBucket: null,

      selectionGranularity: null
    };
  }

  return {
    exactChild: Boolean(parsed.isChild && parsed.childTrueMicroFamilyId),
    exactMicroMicro: Boolean(parsed.isMicroMicro && parsed.microMicroFamilyId),
    selectable: Boolean(parsed.selectable),

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId || parsed.childTrueMicroFamilyId,
    trueMicroFamilyId: parsed.isMicroMicro
      ? parsed.microMicroFamilyId
      : parsed.childTrueMicroFamilyId || parsed.trueMicroFamilyId,

    microMicroFamilyId: parsed.microMicroFamilyId,
    trueMicroMicroFamilyId: parsed.trueMicroMicroFamilyId,
    exactMicroMicroFamilyId: parsed.exactMicroMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    entryBucket: parsed.entryBucket || null,
    spreadBucket: parsed.spreadBucket || null,
    btcBucket: parsed.btcBucket || null,
    riskBucket: parsed.riskBucket || null,

    selectionGranularity: parsed.selectionGranularity
  };
}

function exactSelectableRequiredButMissing(row = {}) {
  const id = extractLearningFamilyId(row);

  if (!id) return false;

  const parsed = parseLearningFamilyId(id);

  return !parsed.isMicroMicro;
}

function completedCount(row = {}) {
  const virtualCompleted = safeNumber(row.virtualCompleted, 0);
  const shadowCompleted = safeNumber(row.shadowCompleted, 0);
  const closed = safeNumber(row.closed, 0);
  const explicitCompleted = safeNumber(row.completed, 0);

  const fromVirtualShadow = virtualCompleted + shadowCompleted;

  return Math.max(0, fromVirtualShadow, closed, explicitCompleted);
}

function learningStatus(row = {}) {
  const completed = completedCount(row);

  if (completed <= 0) return 'OBSERVING';
  if (completed < MIN_COMPLETED_ACTIVE_LEARNING) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
}

function normalizeBtcRelation(value) {
  const relation = upper(value, 'BTC_UNKNOWN');

  if (relation === 'BTC_WITH' || relation === 'WITH') return 'BTC_WITH';
  if (relation === 'BTC_AGAINST' || relation === 'AGAINST') return 'BTC_AGAINST';
  if (relation === 'BTC_NEUTRAL' || relation === 'NEUTRAL') return 'BTC_NEUTRAL';
  if (relation === 'BTC_UNKNOWN' || relation === 'UNKNOWN') return 'BTC_UNKNOWN';

  if (['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN', 'BTC_BEAR'].includes(relation)) {
    return 'BTC_WITH';
  }

  if (['BULLISH', 'STRONG_BULL', 'BULL', 'UP', 'BTC_BULL'].includes(relation)) {
    return 'BTC_AGAINST';
  }

  return 'BTC_UNKNOWN';
}

function relationFromDefinitionParts(definitionParts = []) {
  const parts = Array.isArray(definitionParts) ? definitionParts : [];

  const directMatch = parts.find((part) => {
    const text = upper(part);

    return (
      text.startsWith('BTCRELATION=') ||
      text.startsWith('BTC_RELATION=') ||
      text.startsWith('BTC=') ||
      text.startsWith('BTC_STATE=') ||
      text.startsWith('BTCBUCKET=') ||
      text.startsWith('MICROMICROBTCBUCKET=')
    );
  });

  if (!directMatch) return 'BTC_UNKNOWN';

  return normalizeBtcRelation(String(directMatch).split('=').at(1));
}

function btcRelationFromRow(row = {}) {
  return normalizeBtcRelation(
    row.btcRelation ||
      row.btcStateRelation ||
      row.microMicroBtcBucket ||
      row.btcBucket ||
      row.btcState ||
      relationFromDefinitionParts(row.definitionParts) ||
      relationFromDefinitionParts(row.microMicroDefinitionParts)
  );
}

function validShortRiskGeometry(row = {}) {
  const hasGeometry =
    row.entry !== undefined ||
    row.sl !== undefined ||
    row.tp !== undefined ||
    row.stopLoss !== undefined ||
    row.takeProfit !== undefined;

  if (!hasGeometry) return true;

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl ?? row.stopLoss ?? row.initialSl, 0);
  const tp = safeNumber(row.tp ?? row.takeProfit ?? row.target, 0);

  return entry > 0 && sl > 0 && tp > 0 && tp < entry && entry < sl;
}

function stopRiskPct(row = {}) {
  const direct = firstFinite(
    row.riskPct,
    row.slDistancePct,
    row.stopDistancePct,
    row.stopLossDistancePct
  );

  if (Number.isFinite(direct) && direct > 0) {
    return normalizeRatioOrPct(direct, 0);
  }

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl ?? row.stopLoss ?? row.initialSl, 0);

  if (entry > 0 && sl > entry) {
    return (sl - entry) / entry;
  }

  return 0;
}

function positionRiskFraction(position = {}) {
  const cfg = sizingConfig();
  const direct = safeNumber(position.riskFraction, NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  return cfg.baseRiskPct;
}

function normalizeRiskFraction(value) {
  const cfg = sizingConfig();
  const risk = safeNumber(value, cfg.baseRiskPct);

  return clamp(
    risk,
    0,
    Math.max(
      cfg.maxTotalRiskPct,
      cfg.maxSameSideRiskPct,
      cfg.baseRiskPct,
      0
    )
  );
}

function buildStatsSideProbe({
  weeklyStats,
  side,
  tradeSide
} = {}) {
  return {
    ...(weeklyStats || {}),

    side: side ?? weeklyStats?.side,
    tradeSide: tradeSide ?? weeklyStats?.tradeSide,
    positionSide: tradeSide ?? weeklyStats?.positionSide,
    direction: tradeSide ?? weeklyStats?.direction
  };
}

function normalizeSignalType(value, row = {}) {
  const text = normalizeToken(value);

  if (
    text === SIGNAL_TYPE_TRADE_READY ||
    text === 'TRADE' ||
    text === 'READY' ||
    text === 'TRADE_READY_SIGNAL'
  ) {
    return SIGNAL_TYPE_TRADE_READY;
  }

  if (
    text === SIGNAL_TYPE_WATCH_ONLY ||
    text === 'WATCH' ||
    text === 'WATCHLIST' ||
    text === 'SMALL_RISK' ||
    text === 'SMALL_RISK_ONLY'
  ) {
    return SIGNAL_TYPE_WATCH_ONLY;
  }

  if (
    text === SIGNAL_TYPE_OBSERVE_ONLY ||
    text === 'OBSERVE' ||
    text === 'OBSERVATION' ||
    text === 'LEARN_ONLY' ||
    text === 'LEARNING_ONLY'
  ) {
    return SIGNAL_TYPE_OBSERVE_ONLY;
  }

  if (
    text === SIGNAL_TYPE_BLOCKED ||
    text === 'REJECTED' ||
    text === STATUS_EMPIRICAL_VETO ||
    text === STATUS_POLICY_BLOCKED ||
    text === 'POLICY_BLOCKED'
  ) {
    return SIGNAL_TYPE_BLOCKED;
  }

  if (row.policyBlocked === true || row.empiricalVeto === true) {
    return SIGNAL_TYPE_BLOCKED;
  }

  if (
    row.tradingEligible === true ||
    row.eligible === true ||
    row.eligibleGatePassed === true
  ) {
    return SIGNAL_TYPE_TRADE_READY;
  }

  return '';
}

function normalizeProofTier(value, row = {}) {
  const text = normalizeToken(value);

  if (text === PROOF_TIER_POLICY_BLOCKED || row.policyBlocked === true) return PROOF_TIER_POLICY_BLOCKED;
  if (text === PROOF_TIER_EMPIRICAL_VETO || row.empiricalVeto === true) return PROOF_TIER_EMPIRICAL_VETO;

  if (text === PROOF_TIER_MICRO_MICRO_MARKET) return PROOF_TIER_MICRO_MICRO_MARKET;
  if (text === PROOF_TIER_MICRO_MICRO_LIFETIME) return PROOF_TIER_MICRO_MICRO_LIFETIME;
  if (text === PROOF_TIER_CHILD_75_MARKET) return PROOF_TIER_CHILD_75_MARKET;
  if (text === PROOF_TIER_CHILD_75_LIFETIME) return PROOF_TIER_CHILD_75_LIFETIME;
  if (text === PROOF_TIER_PARENT_15_MARKET) return PROOF_TIER_PARENT_15_MARKET;
  if (text === PROOF_TIER_PARENT_15_LIFETIME) return PROOF_TIER_PARENT_15_LIFETIME;
  if (text === PROOF_TIER_OBSERVATION_ONLY) return PROOF_TIER_OBSERVATION_ONLY;

  return text || '';
}

function normalizeRiskBand(value, signalType = '') {
  const text = normalizeToken(value);

  if (text === MAX_ALLOWED_RISK_BAND_HIGH) return MAX_ALLOWED_RISK_BAND_HIGH;
  if (text === MAX_ALLOWED_RISK_BAND_MEDIUM) return MAX_ALLOWED_RISK_BAND_MEDIUM;
  if (text === MAX_ALLOWED_RISK_BAND_LOW) return MAX_ALLOWED_RISK_BAND_LOW;
  if (text === MAX_ALLOWED_RISK_BAND_ZERO || text === 'NONE' || text === 'NO_RISK') return MAX_ALLOWED_RISK_BAND_ZERO;

  if (signalType === SIGNAL_TYPE_TRADE_READY) return MAX_ALLOWED_RISK_BAND_HIGH;
  if (signalType === SIGNAL_TYPE_WATCH_ONLY) return MAX_ALLOWED_RISK_BAND_LOW;

  return MAX_ALLOWED_RISK_BAND_ZERO;
}

function policyBlocked(row = {}) {
  const status = normalizeToken(row.microMicroRuntimeStatus || row.status || row.runtimeStatus);
  const proofTier = normalizeProofTier(row.proofTier, row);
  const reason = normalizeToken(row.policyBlockedReason || row.whyBlocked || row.reason);

  return (
    row.policyBlocked === true ||
    row.policyBlock === true ||
    row.policyBlockedGate?.blocked === true ||
    proofTier === PROOF_TIER_POLICY_BLOCKED ||
    status === STATUS_POLICY_BLOCKED ||
    status === 'POLICY_BLOCKED' ||
    reason.includes('E_WEAK_CONTRA') ||
    reason.includes('INVALID_SHORT_GEOMETRY') ||
    reason.includes('INVALID_SIDE') ||
    reason.includes('NON_SHORT') ||
    reason.includes('KNOWN_FORBIDDEN_FAMILY') ||
    upper(row.confirmationProfile) === 'E_WEAK_CONTRA'
  );
}

function empiricalVeto(row = {}) {
  const status = normalizeToken(row.microMicroRuntimeStatus || row.status || row.runtimeStatus);
  const proofTier = normalizeProofTier(row.proofTier, row);
  const reason = normalizeToken(row.empiricalVetoReason || row.whyBlocked || row.reason);

  return (
    row.empiricalVeto === true ||
    row.empiricalVetoGate?.triggered === true ||
    proofTier === PROOF_TIER_EMPIRICAL_VETO ||
    status === STATUS_EMPIRICAL_VETO ||
    reason.includes('EXACT_MICRO_MICRO_LCB95_NEGATIVE')
  );
}

function hasShrunkLcbInput(row = {}) {
  return (
    row.shrunkLCB95AvgR !== undefined ||
    row.shrunkLcb95AvgR !== undefined ||
    row.shrunkAvgRLCB95 !== undefined ||
    row.currentMarketShrunkLCB95AvgR !== undefined
  );
}

function shrunkLcb95AvgR(row = {}) {
  return firstFinite(
    row.shrunkLCB95AvgR,
    row.shrunkLcb95AvgR,
    row.shrunkAvgRLCB95,
    row.currentMarketShrunkLCB95AvgR
  );
}

function hasSizingDecisionFields(row = {}) {
  return (
    row.proofTier !== undefined ||
    row.signalType !== undefined ||
    row.maxAllowedRiskBand !== undefined ||
    row.shrunkLCB95AvgR !== undefined ||
    row.shrunkLcb95AvgR !== undefined ||
    row.shrunkAvgRLCB95 !== undefined ||
    row.empiricalVeto !== undefined ||
    row.policyBlocked !== undefined ||
    row.policyBlockedGate !== undefined ||
    row.empiricalVetoGate !== undefined ||
    row.microMicroRuntimeStatus !== undefined ||
    row.tradingEligible !== undefined ||
    row.eligible !== undefined ||
    row.eligibleGatePassed !== undefined
  );
}

function riskBandCapPct(band, cfg = sizingConfig()) {
  const normalized = normalizeRiskBand(band);

  if (!cfg.riskBandCapsEnabled) {
    return Number.POSITIVE_INFINITY;
  }

  if (normalized === MAX_ALLOWED_RISK_BAND_ZERO) return 0;
  if (normalized === MAX_ALLOWED_RISK_BAND_LOW) return cfg.lowRiskBandCapPct;
  if (normalized === MAX_ALLOWED_RISK_BAND_MEDIUM) return cfg.mediumRiskBandCapPct;
  if (normalized === MAX_ALLOWED_RISK_BAND_HIGH) return cfg.highRiskBandCapPct;

  return Number.POSITIVE_INFINITY;
}

function shortModeFlags(extra = {}) {
  const taxonomy = taxonomyIdentity(extra);
  const completed = completedCount(extra);
  const status = learningStatus(extra);
  const signalType = normalizeSignalType(extra.signalType, extra) || SIGNAL_TYPE_OBSERVE_ONLY;
  const proofTier = normalizeProofTier(extra.proofTier, extra) || PROOF_TIER_OBSERVATION_ONLY;
  const maxAllowedRiskBand = normalizeRiskBand(extra.maxAllowedRiskBand, signalType);

  return {
    ...baseModeFlags(),

    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: taxonomy.base75ChildTrueMicroFamilyId,
    trueMicroFamilyId: taxonomy.trueMicroFamilyId,
    microFamilyId: taxonomy.trueMicroFamilyId,

    microMicroFamilyId: taxonomy.microMicroFamilyId,
    trueMicroMicroFamilyId: taxonomy.trueMicroMicroFamilyId,
    exactMicroMicroFamilyId: taxonomy.exactMicroMicroFamilyId,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,

    microMicroEntryBucket: taxonomy.entryBucket,
    microMicroSpreadBucket: taxonomy.spreadBucket,
    microMicroBtcBucket: taxonomy.btcBucket,
    microMicroRiskBucket: taxonomy.riskBucket,

    exact75ChildTrueMicro: taxonomy.exactChild,
    exactMicroMicro: taxonomy.exactMicroMicro,
    selectableLearningIdentity: taxonomy.selectable,
    selectionGranularity: taxonomy.selectionGranularity || 'UNKNOWN',

    learningStatus: status,
    status,
    completed,

    activeLearningUsable: completed >= MIN_COMPLETED_ACTIVE_LEARNING,
    microMicroActiveLearningUsable: completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,

    proofTier,
    signalType,
    maxAllowedRiskBand,
    shrunkLCB95AvgR: Number.isFinite(shrunkLcb95AvgR(extra)) ? round6(shrunkLcb95AvgR(extra)) : null,

    empiricalVeto: empiricalVeto(extra),
    empiricalVetoReason: empiricalVeto(extra)
      ? (extra.empiricalVetoReason || 'EXACT_MICRO_MICRO_LCB95_NEGATIVE')
      : null,

    policyBlocked: policyBlocked(extra),
    policyBlockedReason: policyBlocked(extra)
      ? (extra.policyBlockedReason || extra.policyBlockedGate?.reason || 'POLICY_BLOCKED')
      : null
  };
}

function statsGate(row = {}, cfg = sizingConfig()) {
  const completed = completedCount(row);

  if (!cfg.hardRejectBadStats) {
    return {
      ok: true,
      reason: 'HARD_STATS_GATE_DISABLED'
    };
  }

  if (completed < cfg.minCompletedForStatsGate) {
    return {
      ok: true,
      reason: 'SAMPLE_TOO_SMALL_FOR_HARD_STATS_GATE',
      completed,
      minCompletedForStatsGate: cfg.minCompletedForStatsGate
    };
  }

  const avgR = safeNumber(row.avgR ?? row.avgNetR, 0);
  const totalR = safeNumber(row.totalR ?? row.totalNetR, 0);
  const lcb95AvgR = firstFinite(
    row.lcb95AvgR,
    row.avgRLcb95,
    row.avgRLCB95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR
  );

  const directSlRate = normalizeRatioOrPct(
    firstValue(
      row.directSLRate,
      row.directSlRate,
      row.directSLPct,
      row.slRate,
      row.stopLossRate
    ),
    0
  );

  const avgCostR = Math.max(
    0,
    safeNumber(row.avgCostR ?? row.costR, 0)
  );

  if (totalR < 0 && avgR < 0) {
    return {
      ok: false,
      reason: 'BAD_STATS_NEGATIVE_TOTAL_AND_AVG_R',
      completed,
      totalR,
      avgR
    };
  }

  if (Number.isFinite(lcb95AvgR) && lcb95AvgR < 0) {
    return {
      ok: false,
      reason: 'BAD_STATS_LCB95_AVG_R_BELOW_ZERO',
      completed,
      lcb95AvgR
    };
  }

  if (directSlRate > 0 && directSlRate > cfg.maxDirectSlRate) {
    return {
      ok: false,
      reason: 'BAD_STATS_DIRECT_SL_RATE_TOO_HIGH',
      completed,
      directSlRate,
      maxDirectSlRate: cfg.maxDirectSlRate
    };
  }

  if (avgCostR > cfg.maxAvgCostR) {
    return {
      ok: false,
      reason: 'BAD_STATS_AVG_COST_R_TOO_HIGH',
      completed,
      avgCostR,
      maxAvgCostR: cfg.maxAvgCostR
    };
  }

  return {
    ok: true,
    reason: 'STATS_GATE_OK',
    completed,
    avgR,
    totalR,
    lcb95AvgR: Number.isFinite(lcb95AvgR) ? lcb95AvgR : null,
    directSlRate,
    avgCostR
  };
}

function sizingConfidence(row = {}, cfg = sizingConfig()) {
  const completed = completedCount(row);

  const balanced = safeNumber(
    row.dashboardBalancedScore ??
      row.balancedScore ??
      row.selectorScore,
    0
  );

  const fairWinrate = normalizeRatioOrPct(
    row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      row.sampleWilsonLowerBound ??
      row.wilsonLowerBound,
    0
  );

  const avgR = safeNumber(row.avgR ?? row.avgNetR, 0);
  const totalR = safeNumber(row.totalR ?? row.totalNetR, 0);

  const lcb95AvgR = firstFinite(
    row.lcb95AvgR,
    row.avgRLcb95,
    row.avgRLCB95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR
  );

  const shrunkLcb = shrunkLcb95AvgR(row);

  const avgCostR = Math.max(0, safeNumber(row.avgCostR ?? row.costR, 0));
  const directSlRate = normalizeRatioOrPct(
    row.directSLRate ??
      row.directSlRate ??
      row.directSLPct ??
      row.slRate,
    0
  );

  const sampleConf = clamp(completed / cfg.priorTrades, 0, 1);
  const qualityConf = clamp(balanced / 100, 0, 1);
  const winrateConf = fairWinrate > 0
    ? clamp((fairWinrate - 0.45) / 0.25, 0, 1)
    : 0;

  const avgRConf = clamp((avgR + 0.15) / 0.75, 0, 1);
  const totalRConf = clamp(totalR / 15, 0, 1);

  const lcbConf = Number.isFinite(lcb95AvgR)
    ? clamp((lcb95AvgR + 0.10) / 0.45, 0, 1)
    : 0.35;

  const shrunkLcbConf = Number.isFinite(shrunkLcb)
    ? clamp((shrunkLcb + 0.10) / 0.45, 0, 1)
    : lcbConf;

  const costPenalty = clamp(avgCostR / Math.max(cfg.maxAvgCostR, 0.01), 0, 1);
  const directSlPenalty = directSlRate > 0
    ? clamp(directSlRate / Math.max(cfg.maxDirectSlRate, 0.01), 0, 1)
    : 0;

  const currentFit = upper(row.currentFit || row.entryCurrentFit, 'UNKNOWN');
  const currentFitBoost =
    currentFit === 'MATCH' || currentFit === 'FIT'
      ? 0.08
      : currentFit === 'WEAK_MATCH' || currentFit === 'OK'
        ? 0.03
        : currentFit === 'MISFIT'
          ? -0.12
          : 0;

  const rawConfidence =
    sampleConf * 0.20 +
    qualityConf * 0.15 +
    winrateConf * 0.12 +
    avgRConf * 0.13 +
    totalRConf * 0.10 +
    lcbConf * 0.12 +
    shrunkLcbConf * 0.18 -
    costPenalty * 0.16 -
    directSlPenalty * 0.08 +
    currentFitBoost;

  return clamp(rawConfidence, 0, 1);
}

function baseStatsRiskFraction(row = {}, cfg = sizingConfig()) {
  if (!cfg.enabled) {
    return round6(cfg.baseRiskPct);
  }

  const gate = statsGate(row, cfg);

  if (!gate.ok) {
    return 0;
  }

  const confidence = sizingConfidence(row, cfg);
  const maxMult = Math.max(cfg.minMult, cfg.maxMult);

  const mult = clamp(
    cfg.minMult + (maxMult - cfg.minMult) * confidence,
    cfg.minMult,
    maxMult
  );

  return round6(cfg.baseRiskPct * mult);
}

export function riskDecisionForEntry({
  weeklyStats,
  side = null,
  tradeSide = null
} = {}) {
  const cfg = sizingConfig();

  const stats = weeklyStats || {};
  const row = {
    ...stats,
    side: side ?? stats.side,
    tradeSide: tradeSide ?? stats.tradeSide,
    positionSide: tradeSide ?? stats.positionSide,
    direction: tradeSide ?? stats.direction,
    shortOnly: true,
    longDisabled: true
  };

  const explicitSideProvided =
    side !== null ||
    tradeSide !== null ||
    stats?.tradeSide ||
    stats?.side ||
    stats?.positionSide ||
    stats?.direction;

  const statsSide = inferTradeSide(
    buildStatsSideProbe({
      weeklyStats: row,
      side,
      tradeSide
    })
  );

  const signalType = normalizeSignalType(row.signalType, row) || (
    hasSizingDecisionFields(row)
      ? SIGNAL_TYPE_OBSERVE_ONLY
      : ''
  );

  const proofTier = normalizeProofTier(row.proofTier, row) || (
    hasSizingDecisionFields(row)
      ? PROOF_TIER_OBSERVATION_ONLY
      : ''
  );

  const maxAllowedRiskBand = normalizeRiskBand(row.maxAllowedRiskBand, signalType);
  const bandCap = riskBandCapPct(maxAllowedRiskBand, cfg);
  const shrunkLcb = shrunkLcb95AvgR(row);
  const hasShrunk = hasShrunkLcbInput(row);

  const mode = shortModeFlags({
    ...row,
    signalType,
    proofTier,
    maxAllowedRiskBand
  });

  const zero = (reason, extra = {}) => ({
    ok: false,
    reason,
    riskFraction: 0,
    riskFractionForEntry: 0,
    riskFractionForEntrySource: reason,
    requestedSignalType: signalType || null,
    proofTier: proofTier || null,
    signalType: signalType || SIGNAL_TYPE_OBSERVE_ONLY,
    maxAllowedRiskBand,
    maxAllowedRiskBandCapPct: Number.isFinite(bandCap) ? round6(bandCap) : null,
    shrunkLCB95AvgR: Number.isFinite(shrunkLcb) ? round6(shrunkLcb) : null,
    empiricalVeto: empiricalVeto(row),
    policyBlocked: policyBlocked(row),
    sizingCapMode: cfg.sizingCapMode,
    discordTradeReadyHardLiveEnabled: Boolean(cfg.discordTradeReadyHardLiveEnabled),
    ...extra,
    ...mode
  });

  if (policyBlocked(row)) {
    return zero('POLICY_BLOCKED_RISK_ZERO', {
      policyBlockedReason: row.policyBlockedReason || row.policyBlockedGate?.reason || 'POLICY_BLOCKED'
    });
  }

  if (empiricalVeto(row)) {
    return zero('EMPIRICAL_VETO_RISK_ZERO', {
      empiricalVetoReason: row.empiricalVetoReason || 'EXACT_MICRO_MICRO_LCB95_NEGATIVE',
      empiricalVetoVersion: EMPIRICAL_VETO_VERSION
    });
  }

  if (explicitSideProvided && statsSide !== TARGET_TRADE_SIDE) {
    return zero('SHORT_ONLY_SYSTEM_REJECTED_NON_SHORT_RISK', {
      inferredTradeSide: statsSide
    });
  }

  if (exactSelectableRequiredButMissing(row)) {
    return zero('EXACT_MICRO_MICRO_FAMILY_ID_REQUIRED');
  }

  if (!validShortRiskGeometry(row)) {
    return zero('SHORT_RISK_GEOMETRY_INVALID_TP_LT_ENTRY_LT_SL_REQUIRED');
  }

  if (proofTier === PROOF_TIER_POLICY_BLOCKED) {
    return zero('POLICY_BLOCKED_PROOF_TIER_RISK_ZERO');
  }

  if (proofTier === PROOF_TIER_EMPIRICAL_VETO) {
    return zero('EMPIRICAL_VETO_PROOF_TIER_RISK_ZERO');
  }

  if (signalType === SIGNAL_TYPE_BLOCKED) {
    return zero('SIGNAL_TYPE_BLOCKED_RISK_ZERO');
  }

  if (signalType === SIGNAL_TYPE_OBSERVE_ONLY) {
    return zero('SIGNAL_TYPE_OBSERVE_ONLY_RISK_ZERO');
  }

  if (signalType === SIGNAL_TYPE_WATCH_ONLY) {
    const watchRisk = Math.max(0, safeNumber(cfg.watchOnlyRiskFraction, 0));
    const cappedWatchRisk = Math.min(watchRisk, bandCap);

    if (cappedWatchRisk <= 0) {
      return zero('SIGNAL_TYPE_WATCH_ONLY_RISK_ZERO', {
        shadowOnlyRiskAllowed: true,
        watchOnlyRiskFractionConfigured: round6(watchRisk)
      });
    }

    return {
      ok: true,
      reason: 'SIGNAL_TYPE_WATCH_ONLY_TINY_SHADOW_RISK',
      riskFraction: round6(cappedWatchRisk),
      riskFractionForEntry: round6(cappedWatchRisk),
      riskFractionForEntrySource: 'WATCH_ONLY_CONFIGURED_TINY_SHADOW_RISK',
      shadowOnlyRisk: true,
      realRiskAllowed: false,
      proofTier,
      signalType,
      maxAllowedRiskBand,
      maxAllowedRiskBandCapPct: Number.isFinite(bandCap) ? round6(bandCap) : null,
      shrunkLCB95AvgR: Number.isFinite(shrunkLcb) ? round6(shrunkLcb) : null,
      sizingCapMode: cfg.sizingCapMode,
      discordTradeReadyHardLiveEnabled: Boolean(cfg.discordTradeReadyHardLiveEnabled),
      ...mode
    };
  }

  if (signalType && signalType !== SIGNAL_TYPE_TRADE_READY) {
    return zero('UNKNOWN_SIGNAL_TYPE_RISK_ZERO');
  }

  if (
    cfg.requirePositiveShrunkLcbForTradeReady &&
    hasShrunk &&
    (!Number.isFinite(shrunkLcb) || shrunkLcb <= 0)
  ) {
    return zero('SHRUNK_LCB95_AVG_R_NOT_POSITIVE_RISK_ZERO', {
      shrunkLCB95AvgR: Number.isFinite(shrunkLcb) ? round6(shrunkLcb) : null
    });
  }

  if (
    proofTier === PROOF_TIER_OBSERVATION_ONLY &&
    hasSizingDecisionFields(row)
  ) {
    return zero('PROOF_TIER_OBSERVATION_ONLY_RISK_ZERO');
  }

  const rawRisk = baseStatsRiskFraction(row, cfg);
  const cappedRisk = Math.min(rawRisk, bandCap);

  if (cappedRisk <= 0) {
    return zero('RISK_BAND_CAP_ZERO');
  }

  return {
    ok: true,
    reason: signalType === SIGNAL_TYPE_TRADE_READY
      ? 'TRADE_READY_RISK_FRACTION_FOR_ENTRY_OK'
      : 'LEGACY_STATS_RISK_FRACTION_FOR_ENTRY_OK',

    riskFraction: round6(cappedRisk),
    riskFractionForEntry: round6(cappedRisk),
    riskFractionForEntrySource: 'riskFractionForEntry',

    rawRiskFractionBeforeBandCap: round6(rawRisk),
    bandCapApplied: cappedRisk < rawRisk,
    maxAllowedRiskBand,
    maxAllowedRiskBandCapPct: Number.isFinite(bandCap) ? round6(bandCap) : null,

    proofTier: proofTier || null,
    signalType: signalType || null,
    shrunkLCB95AvgR: Number.isFinite(shrunkLcb) ? round6(shrunkLcb) : null,

    empiricalVeto: false,
    policyBlocked: false,

    sizingCapMode: cfg.sizingCapMode,
    discordTradeReadyHardLiveEnabled: Boolean(cfg.discordTradeReadyHardLiveEnabled),

    ...mode
  };
}

export function riskFractionForEntry({
  weeklyStats,
  side = null,
  tradeSide = null
} = {}) {
  const decision = riskDecisionForEntry({
    weeklyStats,
    side,
    tradeSide
  });

  return round6(decision.riskFractionForEntry ?? decision.riskFraction ?? 0);
}

function liquidationRequiredDistancePct(stopRisk, cfg) {
  const risk = Math.max(0, safeNumber(stopRisk, 0));

  return Math.max(
    risk + cfg.minLiquidationBufferPct,
    risk * cfg.liquidationBufferRiskMult
  );
}

function maxSafeLeverageForStopRisk(stopRisk, cfg) {
  if (!cfg.liquidationSafetyEnabled) return cfg.maxLeverage;

  const requiredDistance = liquidationRequiredDistancePct(stopRisk, cfg);
  const denominator =
    requiredDistance +
    cfg.maintenanceMarginPct +
    cfg.liquidationFeeBufferPct;

  if (denominator <= 0) return cfg.maxLeverage;

  return clamp(
    1 / denominator,
    0.1,
    cfg.maxLeverage
  );
}

function estimatedShortLiquidationDistancePct(leverage, cfg) {
  const lev = safeNumber(leverage, 0);

  if (lev <= 0) return Number.POSITIVE_INFINITY;

  return Math.max(
    0,
    1 / lev -
      cfg.maintenanceMarginPct -
      cfg.liquidationFeeBufferPct
  );
}

export function positionSizeForStopRisk({
  equity,
  riskFraction,
  entry,
  sl,
  stopRiskPct: explicitStopRiskPct,
  maxNotional = Infinity,
  minNotional = 0
} = {}) {
  const cfg = sizingConfig();

  const accountEquity = safeNumber(equity, 0);
  const risk = normalizeRiskFraction(riskFraction);
  const entryPrice = safeNumber(entry, 0);
  const stopPrice = safeNumber(sl, 0);

  const derivedStopRiskPct =
    entryPrice > 0 && stopPrice > entryPrice
      ? (stopPrice - entryPrice) / entryPrice
      : 0;

  const riskPct = normalizeRatioOrPct(
    explicitStopRiskPct,
    derivedStopRiskPct
  );

  if (accountEquity <= 0 || risk <= 0 || entryPrice <= 0 || riskPct <= 0) {
    return {
      ok: false,
      reason: 'POSITION_SIZE_INPUT_INVALID',
      equity: accountEquity,
      riskFraction: risk,
      entry: entryPrice,
      sl: stopPrice,
      stopRiskPct: riskPct,
      notional: 0,
      quantity: 0,
      riskUsd: 0,
      rawNotional: 0,
      actualRiskUsd: 0,
      actualRiskFraction: 0,
      effectiveLeverage: 0,
      maxSafeLeverage: 0,
      liquidationSafetyOk: false,
      positionSizingVersion: POSITION_SIZING_VERSION,
      riskSourceOfTruth: 'riskFractionForEntry',
      ...baseModeFlags()
    };
  }

  const requestedMaxNotional = finiteOrInfinity(maxNotional, Number.POSITIVE_INFINITY);
  const requestedMinNotional = Math.max(0, safeNumber(minNotional, 0));

  const riskUsd = accountEquity * risk;
  const rawNotional = riskUsd / riskPct;

  const maxSafeLeverage = maxSafeLeverageForStopRisk(riskPct, cfg);
  const maxNotionalByConfiguredLeverage = accountEquity * cfg.maxLeverage;
  const maxNotionalByLiquidationBuffer = accountEquity * maxSafeLeverage;

  const effectiveMaxNotional = Math.min(
    requestedMaxNotional,
    maxNotionalByConfiguredLeverage,
    maxNotionalByLiquidationBuffer
  );

  if (requestedMinNotional > effectiveMaxNotional) {
    return {
      ok: false,
      reason: 'POSITION_SIZE_MIN_NOTIONAL_EXCEEDS_LIQUIDATION_SAFE_CAP',
      equity: round6(accountEquity),
      riskFraction: round6(risk),
      riskUsd: round6(riskUsd),
      entry: entryPrice,
      sl: stopPrice,
      stopRiskPct: round6(riskPct),
      notional: 0,
      rawNotional: round6(rawNotional),
      quantity: 0,
      actualRiskUsd: 0,
      actualRiskFraction: 0,

      requestedMinNotional: round6(requestedMinNotional),
      requestedMaxNotional: Number.isFinite(requestedMaxNotional)
        ? round6(requestedMaxNotional)
        : null,

      maxConfiguredLeverage: round4(cfg.maxLeverage),
      maxSafeLeverage: round4(maxSafeLeverage),
      maxNotionalByConfiguredLeverage: round6(maxNotionalByConfiguredLeverage),
      maxNotionalByLiquidationBuffer: round6(maxNotionalByLiquidationBuffer),
      effectiveMaxNotional: round6(effectiveMaxNotional),

      liquidationSafetyEnabled: Boolean(cfg.liquidationSafetyEnabled),
      requiredLiquidationDistancePct: round6(liquidationRequiredDistancePct(riskPct, cfg)),
      estimatedLiquidationDistancePct: 0,
      liquidationBufferPct: 0,
      liquidationSafetyOk: false,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      positionSizingVersion: POSITION_SIZING_VERSION,
      riskSourceOfTruth: 'riskFractionForEntry',
      ...baseModeFlags()
    };
  }

  const cappedNotional = clamp(
    rawNotional,
    requestedMinNotional,
    effectiveMaxNotional
  );

  const effectiveLeverage =
    accountEquity > 0
      ? cappedNotional / accountEquity
      : 0;

  const estimatedLiquidationDistance = estimatedShortLiquidationDistancePct(
    effectiveLeverage,
    cfg
  );

  const requiredLiquidationDistance = liquidationRequiredDistancePct(riskPct, cfg);
  const liquidationBufferPct = estimatedLiquidationDistance - riskPct;

  const liquidationSafetyOk =
    !cfg.liquidationSafetyEnabled ||
    estimatedLiquidationDistance >= requiredLiquidationDistance;

  const actualRiskUsd = cappedNotional * riskPct;
  const actualRiskFraction =
    accountEquity > 0
      ? actualRiskUsd / accountEquity
      : 0;

  let reason = 'POSITION_SIZE_OK';

  if (cappedNotional < rawNotional) {
    if (effectiveMaxNotional === maxNotionalByLiquidationBuffer) {
      reason = 'POSITION_SIZE_CAPPED_BY_LIQUIDATION_BUFFER';
    } else if (effectiveMaxNotional === maxNotionalByConfiguredLeverage) {
      reason = 'POSITION_SIZE_CAPPED_BY_MAX_LEVERAGE';
    } else {
      reason = 'POSITION_SIZE_CAPPED_BY_MAX_NOTIONAL';
    }
  }

  return {
    ok: liquidationSafetyOk,
    reason: liquidationSafetyOk ? reason : 'POSITION_SIZE_LIQUIDATION_BUFFER_TOO_SMALL',

    equity: round6(accountEquity),
    riskFraction: round6(risk),
    riskFractionForEntry: round6(risk),
    riskSourceOfTruth: 'riskFractionForEntry',
    requestedRiskFraction: round6(risk),
    riskUsd: round6(riskUsd),

    entry: entryPrice,
    sl: stopPrice,
    stopRiskPct: round6(riskPct),

    notional: round6(cappedNotional),
    rawNotional: round6(rawNotional),
    quantity: round6(cappedNotional / entryPrice),

    actualRiskUsd: round6(actualRiskUsd),
    actualRiskFraction: round6(actualRiskFraction),
    actualRiskFractionReducedByCap: actualRiskFraction < risk,

    effectiveLeverage: round4(effectiveLeverage),
    maxConfiguredLeverage: round4(cfg.maxLeverage),
    maxSafeLeverage: round4(maxSafeLeverage),

    requestedMaxNotional: Number.isFinite(requestedMaxNotional)
      ? round6(requestedMaxNotional)
      : null,
    requestedMinNotional: round6(requestedMinNotional),

    maxNotionalByConfiguredLeverage: round6(maxNotionalByConfiguredLeverage),
    maxNotionalByLiquidationBuffer: round6(maxNotionalByLiquidationBuffer),
    effectiveMaxNotional: round6(effectiveMaxNotional),

    liquidationSafetyEnabled: Boolean(cfg.liquidationSafetyEnabled),
    maintenanceMarginPct: round6(cfg.maintenanceMarginPct),
    liquidationFeeBufferPct: round6(cfg.liquidationFeeBufferPct),
    minLiquidationBufferPct: round6(cfg.minLiquidationBufferPct),
    liquidationBufferRiskMult: round4(cfg.liquidationBufferRiskMult),
    requiredLiquidationDistancePct: round6(requiredLiquidationDistance),
    estimatedLiquidationDistancePct: Number.isFinite(estimatedLiquidationDistance)
      ? round6(estimatedLiquidationDistance)
      : null,
    liquidationBufferPct: Number.isFinite(liquidationBufferPct)
      ? round6(liquidationBufferPct)
      : null,
    liquidationSafetyOk,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    noRealOrders: true,
    virtualOnly: true,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    sizingFormula: 'notional = (equity * riskFraction) / stopRiskPct',
    sizingFollowsStopDistance: true,
    leverageIsDerivedFromStopRisk: true,
    fixedLeverageDisabled: true,

    positionSizingVersion: POSITION_SIZING_VERSION,
    ...baseModeFlags()
  };
}

export function summarizeOpenRisk(openPositions = []) {
  const rows = Array.isArray(openPositions) ? openPositions : [];

  let total = 0;
  let shortRisk = 0;
  let nonShortRisk = 0;
  let unknownSideRisk = 0;
  let counterBtcRisk = 0;
  let exactChildPositions = 0;
  let exactMicroMicroPositions = 0;
  let invalidIdentityPositions = 0;
  let invalidRiskGeometryPositions = 0;
  let empiricalVetoPositions = 0;
  let policyBlockedPositions = 0;

  const trueMicroFamilyIds = new Set();
  const parentTrueMicroFamilyIds = new Set();
  const microMicroFamilyIds = new Set();

  for (const position of rows) {
    const tradeSide = inferTradeSide(position);
    const identity = taxonomyIdentity(position);
    const risk = positionRiskFraction(position);

    total += risk;

    if (tradeSide === TARGET_TRADE_SIDE) {
      shortRisk += risk;
    } else if (tradeSide === 'UNKNOWN') {
      unknownSideRisk += risk;
      nonShortRisk += risk;
    } else {
      nonShortRisk += risk;
    }

    if (identity.exactMicroMicro) {
      exactMicroMicroPositions += 1;
      if (identity.microMicroFamilyId) microMicroFamilyIds.add(identity.microMicroFamilyId);
      if (identity.childTrueMicroFamilyId) trueMicroFamilyIds.add(identity.childTrueMicroFamilyId);
      if (identity.parentTrueMicroFamilyId) parentTrueMicroFamilyIds.add(identity.parentTrueMicroFamilyId);
    } else if (identity.exactChild) {
      exactChildPositions += 1;
      if (identity.childTrueMicroFamilyId) trueMicroFamilyIds.add(identity.childTrueMicroFamilyId);
      if (identity.parentTrueMicroFamilyId) parentTrueMicroFamilyIds.add(identity.parentTrueMicroFamilyId);
    } else if (extractLearningFamilyId(position)) {
      invalidIdentityPositions += 1;
    }

    if (!validShortRiskGeometry(position)) {
      invalidRiskGeometryPositions += 1;
    }

    if (empiricalVeto(position)) {
      empiricalVetoPositions += 1;
    }

    if (policyBlocked(position)) {
      policyBlockedPositions += 1;
    }

    if (btcRelationFromRow(position) === 'BTC_AGAINST') {
      counterBtcRisk += risk;
    }
  }

  return {
    total: round6(total),

    shortRisk: round6(shortRisk),

    longRisk: 0,

    nonShortRisk: round6(nonShortRisk),
    nonLongRisk: round6(nonShortRisk),
    unknownSideRisk: round6(unknownSideRisk),
    counterBtcRisk: round6(counterBtcRisk),

    exactChildPositions,
    exact75ChildPositions: exactChildPositions,
    exactMicroMicroPositions,

    invalidIdentityPositions,
    invalidRiskGeometryPositions,
    empiricalVetoPositions,
    policyBlockedPositions,

    trueMicroFamilyIds: [...trueMicroFamilyIds],
    childTrueMicroFamilyIds: [...trueMicroFamilyIds],
    parentTrueMicroFamilyIds: [...parentTrueMicroFamilyIds],
    microMicroFamilyIds: [...microMicroFamilyIds],
    trueMicroMicroFamilyIds: [...microMicroFamilyIds],
    exactMicroMicroFamilyIds: [...microMicroFamilyIds],

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    positionSizingVersion: POSITION_SIZING_VERSION,
    riskSourceOfTruth: 'riskFractionForEntry',
    ...baseModeFlags()
  };
}

export function checkRiskCaps({
  openPositions = [],
  side,
  tradeSide = side,
  btcRelation,
  riskFraction,
  weeklyStats,
  entry,
  sl,
  tp,
  stopLoss,
  takeProfit,
  trueMicroFamilyId,
  childTrueMicroFamilyId,
  microFamilyId,
  parentTrueMicroFamilyId,
  microMicroFamilyId,
  trueMicroMicroFamilyId,
  exactMicroMicroFamilyId
} = {}) {
  const cfg = sizingConfig();

  const requestRow = {
    ...(weeklyStats || {}),

    entry: entry ?? weeklyStats?.entry,
    sl: sl ?? stopLoss ?? weeklyStats?.sl ?? weeklyStats?.stopLoss,
    tp: tp ?? takeProfit ?? weeklyStats?.tp ?? weeklyStats?.takeProfit,

    microMicroFamilyId:
      exactMicroMicroFamilyId ||
      trueMicroMicroFamilyId ||
      microMicroFamilyId ||
      weeklyStats?.exactMicroMicroFamilyId ||
      weeklyStats?.trueMicroMicroFamilyId ||
      weeklyStats?.microMicroFamilyId,

    trueMicroMicroFamilyId:
      exactMicroMicroFamilyId ||
      trueMicroMicroFamilyId ||
      microMicroFamilyId ||
      weeklyStats?.trueMicroMicroFamilyId ||
      weeklyStats?.microMicroFamilyId,

    exactMicroMicroFamilyId:
      exactMicroMicroFamilyId ||
      trueMicroMicroFamilyId ||
      microMicroFamilyId ||
      weeklyStats?.exactMicroMicroFamilyId ||
      weeklyStats?.trueMicroMicroFamilyId ||
      weeklyStats?.microMicroFamilyId,

    trueMicroFamilyId:
      childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.childTrueMicroFamilyId ||
      weeklyStats?.trueMicroFamilyId ||
      microFamilyId ||
      weeklyStats?.microFamilyId,

    childTrueMicroFamilyId:
      childTrueMicroFamilyId ||
      weeklyStats?.childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.trueMicroFamilyId ||
      microFamilyId ||
      weeklyStats?.microFamilyId,

    microFamilyId:
      microFamilyId ||
      childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.microFamilyId ||
      weeklyStats?.trueMicroFamilyId,

    parentTrueMicroFamilyId:
      parentTrueMicroFamilyId ||
      weeklyStats?.parentTrueMicroFamilyId ||
      weeklyStats?.coarseMicroFamilyId,

    side,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide,
    shortOnly: true,
    longDisabled: true
  };

  const want = normalizeRiskFraction(riskFraction);
  const open = summarizeOpenRisk(openPositions);

  const requestedTradeSide = inferTradeSide(requestRow);
  const relation = normalizeBtcRelation(btcRelation ?? btcRelationFromRow(requestRow));
  const identity = taxonomyIdentity(requestRow);

  const decision = riskDecisionForEntry({
    weeklyStats: requestRow,
    side,
    tradeSide
  });

  if (requestedTradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'SHORT_ONLY_SYSTEM_REJECTED_NON_SHORT_RISK',
      side,
      tradeSide: requestedTradeSide,
      riskFraction: 0,
      riskFractionForEntry: 0,
      want,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (extractLearningFamilyId(requestRow) && !identity.exactMicroMicro) {
    return {
      ok: false,
      reason: 'EXACT_MICRO_MICRO_FAMILY_ID_REQUIRED',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      riskFractionForEntry: 0,
      want,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (!validShortRiskGeometry(requestRow)) {
    return {
      ok: false,
      reason: 'SHORT_RISK_GEOMETRY_INVALID_TP_LT_ENTRY_LT_SL_REQUIRED',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      riskFractionForEntry: 0,
      want,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (hasSizingDecisionFields(requestRow)) {
    const allowedRisk = safeNumber(decision.riskFractionForEntry ?? decision.riskFraction, 0);

    if (allowedRisk <= 0) {
      return {
        ok: false,
        reason: decision.reason || 'RISK_SOURCE_OF_TRUTH_ZERO',
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        riskFraction: 0,
        riskFractionForEntry: 0,
        want,
        allowedRisk,
        riskState: open,
        riskDecision: decision,

        ...shortModeFlags(requestRow)
      };
    }

    if (want > allowedRisk + 0.0000001) {
      return {
        ok: false,
        reason: 'REQUESTED_RISK_EXCEEDS_RISK_SOURCE_OF_TRUTH',
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        riskFraction: 0,
        riskFractionForEntry: allowedRisk,
        want,
        allowedRisk,
        riskState: open,
        riskDecision: decision,

        ...shortModeFlags(requestRow)
      };
    }
  }

  if (want <= 0) {
    return {
      ok: false,
      reason: 'ZERO_RISK_FRACTION',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      riskFractionForEntry: 0,
      want,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (!cfg.enabled) {
    return {
      ok: true,
      reason: 'SIZING_DISABLED',
      riskFraction: want,
      riskFractionForEntry: want,
      openRiskBefore: open.total,
      openRiskAfter: round6(open.total + want),
      sideRiskAfter: round6(open.shortRisk + want),
      counterBtcRiskAfter: relation === 'BTC_AGAINST'
        ? round6(open.counterBtcRisk + want)
        : open.counterBtcRisk,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (open.total + want > cfg.maxTotalRiskPct) {
    return {
      ok: false,
      reason: 'MAX_TOTAL_RISK',
      open: open.total,
      want,
      cap: cfg.maxTotalRiskPct,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (open.shortRisk + want > cfg.maxSameSideRiskPct) {
    return {
      ok: false,
      reason: 'MAX_SHORT_SIDE_RISK',
      side: TARGET_TRADE_SIDE,
      open: open.shortRisk,
      want,
      cap: cfg.maxSameSideRiskPct,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  if (
    relation === 'BTC_AGAINST' &&
    open.counterBtcRisk + want > cfg.maxCounterBtcRiskPct
  ) {
    return {
      ok: false,
      reason: 'MAX_COUNTER_BTC_RISK',
      open: open.counterBtcRisk,
      want,
      cap: cfg.maxCounterBtcRiskPct,
      riskState: open,
      riskDecision: decision,

      ...shortModeFlags(requestRow)
    };
  }

  const riskDistance = stopRiskPct(requestRow);
  const maxSafeLeverage = maxSafeLeverageForStopRisk(riskDistance, cfg);
  const requiredLiquidationDistance = liquidationRequiredDistancePct(riskDistance, cfg);

  return {
    ok: true,
    reason: identity.exactMicroMicro
      ? 'RISK_CAPS_OK_EXACT_MICRO_MICRO'
      : 'RISK_CAPS_OK_SHORT_NO_ID',

    riskFraction: want,
    riskFractionForEntry: want,
    openRiskBefore: open.total,
    openRiskAfter: round6(open.total + want),
    sideRiskAfter: round6(open.shortRisk + want),
    counterBtcRiskAfter: relation === 'BTC_AGAINST'
      ? round6(open.counterBtcRisk + want)
      : open.counterBtcRisk,

    stopRiskPct: round6(riskDistance),
    maxSafeLeverage: round4(maxSafeLeverage),
    maxConfiguredLeverage: round4(cfg.maxLeverage),
    requiredLiquidationDistancePct: round6(requiredLiquidationDistance),
    liquidationSafetyEnabled: Boolean(cfg.liquidationSafetyEnabled),

    sizingFollowsStopDistance: true,
    leverageIsDerivedFromStopRisk: true,
    fixedLeverageDisabled: true,

    riskState: open,
    riskDecision: decision,

    positionSizingVersion: POSITION_SIZING_VERSION,
    riskSourceOfTruth: 'riskFractionForEntry',

    ...shortModeFlags(requestRow)
  };
}