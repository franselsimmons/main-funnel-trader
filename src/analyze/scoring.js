// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_AVG_R_LCB_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;
const DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT = 5000;

const MIN_COMPLETED_ACTIVE = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;

const DEFAULT_ELIGIBLE_MIN_COMPLETED = 35;
const DEFAULT_ELIGIBLE_MIN_AVG_R_LCB = 0;
const DEFAULT_ELIGIBLE_MAX_DIRECT_SL_PCT = 0.45;
const DEFAULT_ELIGIBLE_MAX_AVG_COST_R = 0.5;
const DEFAULT_ELIGIBLE_MIN_PROFIT_FACTOR = 1.0;

const DEFAULT_SHRINKAGE_K = 35;
const DEFAULT_MARKET_WEATHER_FDR_Q = 0.1;

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
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;
const LEGACY_EXECUTION_SUFFIX = 'XR';

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const CHILD75_LEARNING_GRANULARITY = LEARNING_GRANULARITY;
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const MICRO_MICRO_MEASUREMENT_VERSION = 'SHORT_MICRO_MICRO_ROLLUP_SELECTION_V5_MARKET_WEATHER_SHRINKAGE';
const LCB_MODEL_VERSION = 'SHORT_AVGR_LCB95_SELECTION_V2_MARKET_WEATHER';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V2_MARKET_WEATHER';
const SELECTION_ENGINE_VERSION = 'SHORT_CURRENT_MARKET_PLAYBOOK_SHRINKAGE_FDR_OBSERVE_V1';

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1_REGIME_TREND';
const MARKET_WEATHER_AGGREGATION_VERSION = 'SHORT_MARKET_WEATHER_AGGREGATION_V1_REGIME_REGIMETREND';
const MARKET_WEATHER_SHRINKAGE_VERSION = 'SHORT_MARKET_WEATHER_RECURSIVE_SHRINKAGE_V1';
const MARKET_WEATHER_FDR_VERSION = 'SHORT_MARKET_WEATHER_PLAYBOOK_FDR_FINAL_SLOTS_V1_OBSERVE';
const MARKET_WEATHER_SELECTOR_VERSION = 'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V1_OBSERVE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION = 'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V1_OBSERVE';

const EMPIRICAL_VETO_VERSION = 'SHORT_EXACT_MM_EMPIRICAL_VETO_LCB95_V1';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_SHADOW = 'SHADOW';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const SELECTION_PARENT_CONTEXT = 'PARENT_15_CONTEXT_ONLY';
const SELECTION_75_CHILD_CONTEXT = 'MICRO_75_CONTEXT_ONLY';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO_ONLY';
const LEGACY_SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO';

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

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const SHORT_FIXED_REGIME_ORDER = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const SHORT_FIXED_REGIME_BUCKETS = new Set(SHORT_FIXED_REGIME_ORDER);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

function now() {
  return Date.now();
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function positive(value) {
  return Math.max(0, safeNumber(value, 0));
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const x = Number(value);
    if (Number.isFinite(x)) return x;
  }

  return null;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function normalizeHashToken(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 24);
}

function normalizeMicroMicroHash(value = '') {
  return normalizeHashToken(value).slice(0, MICRO_MICRO_HASH_LEN);
}

function rotationNumber(key, fallback) {
  return safeNumber(
    CONFIG.short?.rotation?.[key] ??
      CONFIG.rotation?.[key],
    fallback
  );
}

function analyzeNumber(key, fallback) {
  return safeNumber(
    CONFIG.short?.analyze?.[key] ??
      CONFIG.analyze?.[key],
    fallback
  );
}

function selectionNumber(key, fallback) {
  return safeNumber(
    CONFIG.short?.selection?.[key] ??
      CONFIG.selection?.[key] ??
      CONFIG.short?.rotation?.[key] ??
      CONFIG.rotation?.[key],
    fallback
  );
}

function observationDedupeCacheLimit() {
  return Math.max(
    100,
    Math.floor(analyzeNumber('observationDedupeCacheLimit', DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT))
  );
}

function shadowWeight() {
  return clamp(analyzeNumber('shadowWeight', 0.35), 0, 1);
}

function priorTrades() {
  return Math.max(0, rotationNumber('priorTrades', DEFAULT_PRIOR_TRADES));
}

function priorWinrate() {
  return clamp(rotationNumber('priorWinrate', DEFAULT_PRIOR_WINRATE), 0, 1);
}

function wilsonZ() {
  return Math.max(0.1, rotationNumber('wilsonZ', DEFAULT_WILSON_Z));
}

function avgRLCBZ() {
  return Math.max(0.1, selectionNumber('avgRLCBZ', DEFAULT_AVG_R_LCB_Z));
}

function sampleCap() {
  return Math.max(1, rotationNumber('sampleReliabilityCap', DEFAULT_SAMPLE_CAP));
}

function avgRCap() {
  return Math.max(0.5, rotationNumber('avgRCap', DEFAULT_AVG_R_CAP));
}

function avgRSampleExponent() {
  return clamp(
    rotationNumber('avgRSampleExponent', DEFAULT_AVG_R_SAMPLE_EXPONENT),
    0.5,
    3
  );
}

function shrinkageK() {
  return Math.max(
    1,
    selectionNumber('marketWeatherShrinkageK', DEFAULT_SHRINKAGE_K)
  );
}

function marketWeatherFdrQ() {
  return clamp(
    selectionNumber('marketWeatherFdrQ', DEFAULT_MARKET_WEATHER_FDR_Q),
    0.001,
    0.5
  );
}

function eligibleMinCompletedForLayer(layer = LAYER_MICRO_MICRO) {
  const configured = Math.floor(selectionNumber('eligibleMinCompleted', DEFAULT_ELIGIBLE_MIN_COMPLETED));

  if (layer === LAYER_MICRO_MICRO) {
    return Math.max(MIN_COMPLETED_MICRO_MICRO_ACTIVE, configured);
  }

  return Math.max(MIN_COMPLETED_ACTIVE, configured);
}

function eligibleMinAvgRLCB() {
  return selectionNumber('eligibleMinAvgRLCB', DEFAULT_ELIGIBLE_MIN_AVG_R_LCB);
}

function eligibleMaxDirectSLPct() {
  return clamp(
    selectionNumber('eligibleMaxDirectSLPct', DEFAULT_ELIGIBLE_MAX_DIRECT_SL_PCT),
    0,
    1
  );
}

function eligibleMaxAvgCostR() {
  return Math.max(
    0,
    selectionNumber('eligibleMaxAvgCostR', DEFAULT_ELIGIBLE_MAX_AVG_COST_R)
  );
}

function eligibleMinProfitFactor() {
  return Math.max(
    0,
    selectionNumber('eligibleMinProfitFactor', DEFAULT_ELIGIBLE_MIN_PROFIT_FACTOR)
  );
}

function inc(obj, key, amount = 1) {
  const k = String(key || 'UNKNOWN').toUpperCase();
  obj[k] = safeNumber(obj[k], 0) + amount;
}

function makeCounters() {
  return {
    rsiZone: {},
    flow: {},
    obRelation: {},
    btcState: {},
    regime: {},
    scannerReason: {},
    microMicroFamilyId: {},
    learningLayer: {},
    currentFit: {},
    entryMarketWeatherRegime: {},
    entryMarketWeatherTrendSide: {},
    entryMarketWeatherKey: {}
  };
}

function makeOutcomeAccumulator() {
  return {
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    totalPnlPct: 0,
    totalCostR: 0,
    totalExecutionCostR: 0,
    totalFundingCostR: 0,
    sumR: 0,
    sumSquaredR: 0,
    grossWinR: 0,
    grossLossR: 0,
    directSLCount: 0,
    nearTpCount: 0,
    reachedHalfRCount: 0,
    reachedOneRCount: 0,
    beWouldExitCount: 0,
    gaveBackAfterHalfRCount: 0,
    gaveBackAfterOneRCount: 0,
    nearTpThenLossCount: 0
  };
}

function makeMarketWeatherStats() {
  return {
    version: MARKET_WEATHER_AGGREGATION_VERSION,
    keyVersion: MARKET_WEATHER_KEY_VERSION,
    regime: {},
    regimeTrend: {},
    counters: {
      regime: {},
      trendSide: {},
      key: {}
    }
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

    marketWeatherCaptureEnabled: true,
    marketWeatherAggregationEnabled: true,

    marketWeatherSelectorEnabled: true,
    marketWeatherSelectorMode: 'OBSERVE_ONLY',

    marketWeatherFdrEnabled: true,
    marketWeatherFdrMode: 'OBSERVE_ONLY',

    marketWeatherSizingCapEnabled: true,
    marketWeatherSizingCapMode: 'OBSERVE_ONLY',

    marketWeatherDiscordTradeReadyEnabled: false,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKeyDimensionsV1: [
      'entryMarketWeatherRegime',
      'entryMarketWeatherTrendSide'
    ],

    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    tierIsLabelOnly: true,
    signalTypeIsDecisionLabelOnly: true,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoBlocksParentRescue: true,

    recursiveShrinkageVersion: MARKET_WEATHER_SHRINKAGE_VERSION,
    recursiveShrinkageOrder: [
      'MICRO_MICRO_REGIME_TREND',
      'MICRO_MICRO_REGIME',
      'MICRO_MICRO_LIFETIME',
      'CHILD_75_REGIME_TREND',
      'CHILD_75_REGIME',
      'CHILD_75_LIFETIME',
      'PARENT_15_REGIME_TREND',
      'PARENT_15_REGIME',
      'PARENT_15_LIFETIME'
    ],
    recursiveShrinkageParentMeanRule: 'parentMean = already-shrunk result from next coarser level',
    disagreementPenaltyIsHeuristic: true,
    fdrCorrectionScope: 'FINAL_PLAYBOOK_SLOTS_ONLY'
  };
}

function isScannerFamilyId(id = '') {
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

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

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

  if (isScannerFamilyId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_')
  ) {
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
    microMicroHash = normalizeMicroMicroHash(microMicroMatch[2]);
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

  for (const candidateRegime of SHORT_FIXED_REGIME_ORDER) {
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

  if (validChild && microMicroHash && microMicroHash.length >= 6) {
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
    isExactChild: validChild,
    rawId,
    id: microMicroFamilyId || childId || parentId || value,

    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    microFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    base75ChildTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: isParent ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningLayer: isMicroMicro ? LAYER_MICRO_MICRO : isChild ? LAYER_MICRO_75 : isParent ? LAYER_PARENT_15 : 'UNKNOWN',
    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
}

function isSelectableShortMicroMicroFamilyId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  if (!value) return false;

  if (isSelectableShortMicroMicroFamilyId(value)) {
    return false;
  }

  return (
    value.includes(`_${LEGACY_EXECUTION_SUFFIX}_`) ||
    value.includes(`__${LEGACY_EXECUTION_SUFFIX}__`) ||
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
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return parseShortTaxonomyMicroId(value).valid;
}

function normalizeExecutionToMicroMicroId(value = '', fallbackChildId = '') {
  const raw = upper(value);

  if (!raw) return '';

  const direct = parseShortTaxonomyMicroId(raw);

  if (direct.isMicroMicro) {
    return direct.microMicroFamilyId;
  }

  const xrMatch = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,24})$/u.exec(raw);

  if (xrMatch) {
    const base = parseShortTaxonomyMicroId(xrMatch[1]);
    const hash = normalizeMicroMicroHash(xrMatch[2]);

    if (base.isChild && hash.length >= 6) {
      return `${base.childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${hash}`;
    }
  }

  const hash = normalizeMicroMicroHash(raw);

  if (hash && fallbackChildId && hash.length >= 6) {
    const child = parseShortTaxonomyMicroId(fallbackChildId);

    if (child.isChild) {
      return `${child.childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${hash}`;
    }
  }

  return '';
}

function isSelectableShortChildTrueMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.isChild === true && parsed.isMicroMicro !== true;
}

function isParentShortTrueMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function learningLayerFromId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return LAYER_MICRO_MICRO;
  if (parsed.isChild) return LAYER_MICRO_75;
  if (parsed.isParent) return LAYER_PARENT_15;

  return 'UNKNOWN';
}

function minCompletedForLayer(layer = LAYER_MICRO_75) {
  return layer === LAYER_MICRO_MICRO
    ? MIN_COMPLETED_MICRO_MICRO_ACTIVE
    : MIN_COMPLETED_ACTIVE;
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
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

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function directSide(row = {}) {
  const values = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  return 'UNKNOWN';
}

function definitionValues(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.baseTrueMicroFamilyId,
    row.trueMicro75FamilyId,

    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microMicroId,
    row.mmFamilyId,

    row.coarseMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

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
  ];
}

function definitionText(row = {}) {
  return definitionValues(row)
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function definitionSide(row = {}) {
  const values = definitionValues(row);

  let shortHit = false;
  let longHit = false;

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE) shortHit = true;
    if (side === OPPOSITE_TRADE_SIDE) longHit = true;
  }

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit && longHit) {
    const text = values
      .map((value) => cleanSideText(value))
      .filter(Boolean)
      .join('|');

    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') return normalizeTradeSide(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = directSide(row);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE || fromDefinition === OPPOSITE_TRADE_SIDE) {
    return fromDefinition;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function rowSchema(row = {}) {
  const microMicroCandidates = [
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microMicroId,
    row.mmFamilyId
  ];

  for (const value of microMicroCandidates) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro) return MICRO_MICRO_SCHEMA;
  }

  const idCandidates = [
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.id,
    row.key
  ];

  for (const value of idCandidates) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro) return MICRO_MICRO_SCHEMA;
    if (parsed.isChild) return TRUE_MICRO_SCHEMA;
    if (parsed.isParent) return PARENT_TRUE_MICRO_SCHEMA;
  }

  return String(
    row.schema ||
      row.microFamilySchema ||
      row.trueMicroFamilySchema ||
      row.childTrueMicroFamilySchema ||
      row.exactTrueMicroFamilySchema ||
      row.broadTrueMicroFamilySchema ||
      row.versionSchema ||
      ''
  ).toUpperCase();
}

function candidateLearningValues(row = {}) {
  return [
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microMicroId,
    row.mmFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.id,
    row.key
  ];
}

function rowChildTrueMicroId(row = {}) {
  const values = [
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.baseTrueMicroFamilyId,
    row.trueMicro75FamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.learningFamilyId,
    row.analyzeMicroFamilyId,
    row.id,
    row.key,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ];

  for (const value of values) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro || parsed.isChild) {
      return parsed.childTrueMicroFamilyId;
    }
  }

  return '';
}

function rowMicroMicroId(row = {}) {
  const child = rowChildTrueMicroId(row);

  const directValues = [
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microMicroId,
    row.mmFamilyId,
    row.id,
    row.key
  ];

  for (const value of directValues) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro) {
      return parsed.microMicroFamilyId;
    }
  }

  const fromExecution = normalizeExecutionToMicroMicroId(
    firstValue(
      row.executionMicroFamilyId,
      row.executionFingerprintMicroFamilyId,
      row.refinedExecutionMicroFamilyId,
      row.executionFingerprintId
    ),
    child
  );

  if (fromExecution) {
    return fromExecution;
  }

  const hash = normalizeMicroMicroHash(
    firstValue(
      row.microMicroHash,
      row.executionFingerprintHash,
      row.executionHash,
      row.xrayHash
    )
  );

  if (hash && child && hash.length >= 6) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
  }

  return '';
}

function rowMicroId(row = {}) {
  const schema = rowSchema(row);
  const selectionGranularity = upper(row.selectionGranularity);
  const learningLayer = upper(row.learningLayer);

  const explicitMicroMicro =
    schema === MICRO_MICRO_SCHEMA ||
    selectionGranularity === SELECTION_EXACT_MICRO_MICRO ||
    selectionGranularity === LEGACY_SELECTION_EXACT_MICRO_MICRO ||
    learningLayer === LAYER_MICRO_MICRO ||
    row.isMicroMicroFamily === true ||
    row.microMicroLearningEnabled === true;

  if (explicitMicroMicro) {
    const mm = rowMicroMicroId(row);

    if (mm) return mm;
  }

  for (const value of candidateLearningValues(row)) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
    if (parsed.isChild) return parsed.childTrueMicroFamilyId;
    if (parsed.isParent) return parsed.parentTrueMicroFamilyId;
  }

  const child = rowChildTrueMicroId(row);

  if (child) return child;

  const raw = String(
    row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.microFamilyId ||
      row.trueMicroFamilyId ||
      row.id ||
      row.key ||
      ''
  ).trim();

  return validLearningId(raw) ? raw.toUpperCase() : '';
}

function rowParentTrueMicroId(row = {}) {
  const direct = String(
    row.parentTrueMicroFamilyId ||
      row.coarseMicroFamilyId ||
      row.baseMicroFamilyId ||
      row.legacyMicroFamilyId ||
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
  ).trim();

  const parsedDirect = parseShortTaxonomyMicroId(direct);

  if (parsedDirect.valid) {
    return parsedDirect.parentTrueMicroFamilyId;
  }

  const parsedMicro = parseShortTaxonomyMicroId(rowMicroId(row));

  if (parsedMicro.valid) {
    return parsedMicro.parentTrueMicroFamilyId;
  }

  const child = parseShortTaxonomyMicroId(rowChildTrueMicroId(row));

  if (child.valid) {
    return child.parentTrueMicroFamilyId;
  }

  return '';
}

function rowLearningLayer(row = {}) {
  const id = rowMicroId(row);
  return learningLayerFromId(id);
}

function rowLayerMinCompleted(row = {}) {
  return minCompletedForLayer(rowLearningLayer(row));
}

function rowMatchesStatsIdentity(stats = {}, row = {}) {
  const statsId = rowMicroId(stats);

  if (!statsId) return true;

  const statsParsed = parseShortTaxonomyMicroId(statsId);

  if (statsParsed.isMicroMicro) {
    const rowMm = rowMicroMicroId(row);
    const rowLearning = rowMicroId(row);

    return rowMm === statsParsed.microMicroFamilyId || rowLearning === statsParsed.microMicroFamilyId;
  }

  if (statsParsed.isChild) {
    const rowChild = rowChildTrueMicroId(row);
    const rowLearning = rowMicroId(row);

    return rowChild === statsParsed.childTrueMicroFamilyId || rowLearning === statsParsed.childTrueMicroFamilyId;
  }

  if (statsParsed.isParent) {
    const rowParent = rowParentTrueMicroId(row);

    return rowParent === statsParsed.parentTrueMicroFamilyId;
  }

  const rowLearning = rowMicroId(row);

  return !rowLearning || rowLearning === statsId;
}

function dedupeLearningIdForStats(stats = {}, row = {}) {
  const statsId = rowMicroId(stats);
  const statsParsed = parseShortTaxonomyMicroId(statsId);

  if (statsParsed.isMicroMicro) {
    return rowMicroMicroId(row) || statsId;
  }

  if (statsParsed.isChild) {
    return rowChildTrueMicroId(row) || statsId;
  }

  if (statsParsed.isParent) {
    return rowParentTrueMicroId(row) || statsId;
  }

  return rowMicroId(row) || statsId;
}

function idHasSchema(id, schema) {
  const value = upper(id);
  const target = upper(schema);

  if (!value || !target) return false;

  if (target === MICRO_MICRO_SCHEMA) {
    return (
      isSelectableShortMicroMicroFamilyId(value) ||
      value.includes(`_${MICRO_MICRO_SCHEMA}_`) ||
      value.endsWith(`_${MICRO_MICRO_SCHEMA}`) ||
      value.includes(`|SCHEMA=${MICRO_MICRO_SCHEMA}`) ||
      value.includes(`SCHEMA=${MICRO_MICRO_SCHEMA}`)
    );
  }

  if (target === TRUE_MICRO_SCHEMA) {
    return (
      isSelectableShortChildTrueMicroId(value) ||
      value.includes(`_${TRUE_MICRO_SCHEMA}_`) ||
      value.endsWith(`_${TRUE_MICRO_SCHEMA}`) ||
      value.includes(`|SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
      value.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`)
    );
  }

  if (target === PARENT_TRUE_MICRO_SCHEMA) {
    return (
      isParentShortTrueMicroId(value) ||
      value.includes(`_${PARENT_TRUE_MICRO_SCHEMA}_`) ||
      value.endsWith(`_${PARENT_TRUE_MICRO_SCHEMA}`) ||
      value.includes(`|SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
      value.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`)
    );
  }

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function definitionHasSchema(row = {}, schema) {
  const target = upper(schema);

  if (!target) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : []),
    ...(Array.isArray(row.broadTrueDefinitionParts) ? row.broadTrueDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];

  const upperParts = parts.map((part) => String(part || '').toUpperCase());

  if (target === MICRO_MICRO_SCHEMA) {
    return (
      upperParts.some((part) => (
        part === `SCHEMA=${MICRO_MICRO_SCHEMA}` ||
        part === `MICROMICROFAMILYSCHEMA=${MICRO_MICRO_SCHEMA}` ||
        part.includes(`SCHEMA=${MICRO_MICRO_SCHEMA}`) ||
        part.includes('MICRO_MICRO') ||
        part.includes('_MM_')
      )) ||
      definitionText(row).includes('MICRO_MICRO') ||
      definitionText(row).includes('_MM_')
    );
  }

  if (target === TRUE_MICRO_SCHEMA) {
    return (
      upperParts.some((part) => (
        part === `SCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part === `TRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part === `CHILDTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part === `BROADTRUEMICROFAMILYSCHEMA=${TRUE_MICRO_SCHEMA}` ||
        part.includes(`SCHEMA=${TRUE_MICRO_SCHEMA}`) ||
        part.includes('FIXED_TAXONOMY_75') ||
        part.includes('LEARNINGIDENTITY=ANALYZE_TRUE_MICRO_FAMILY_FIXED_TAXONOMY')
      )) ||
      definitionText(row).includes('FIXED_TAXONOMY_75')
    );
  }

  if (target === PARENT_TRUE_MICRO_SCHEMA) {
    return (
      upperParts.some((part) => (
        part === `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
        part === `PARENTTRUEMICROFAMILYSCHEMA=${PARENT_TRUE_MICRO_SCHEMA}` ||
        part.includes(`SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`) ||
        part.includes('FIXED_TAXONOMY_15')
      )) ||
      definitionText(row).includes('FIXED_TAXONOMY_15')
    );
  }

  if (upperParts.some((part) => part === `SCHEMA=${target}`)) {
    return true;
  }

  return definitionText(row).includes(`SCHEMA=${target}`);
}

function schemaConfig() {
  const macroSchema = String(
    CONFIG.short?.analyze?.macroSchema ??
      CONFIG.analyze?.macroSchema ??
      CONFIG.analyze?.legacySchema ??
      'MF_V1'
  ).toUpperCase();

  const configuredLegacyMicroSchema = String(
    CONFIG.short?.analyze?.legacyMicroSchema ??
      CONFIG.short?.analyze?.microSchema ??
      CONFIG.analyze?.legacyMicroSchema ??
      CONFIG.analyze?.microSchema ??
      'MF_V2'
  ).toUpperCase();

  return {
    currentSchema: TRUE_MICRO_SCHEMA,
    macroSchema,
    microSchema: TRUE_MICRO_SCHEMA,
    legacyMicroSchema: configuredLegacyMicroSchema,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
}

function idLooksLikeSimpleMacroFamily(id = '') {
  const value = String(id || '').trim();

  return (
    /^SHORT(?:_F)?_?\d+$/iu.test(value) ||
    /^SHORT_F\d+$/iu.test(value)
  );
}

function idLooksLikeShortMicroFamily(id = '') {
  const value = upper(id);

  if (!value) return false;
  if (!validLearningId(value)) return false;

  return value.startsWith('MICRO_SHORT_');
}

function isTrueAnalyzeMicroRow(row = {}) {
  const { macroSchema, legacyMicroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = upper(row.version);

  if (!row || !id) return false;
  if (!validLearningId(id)) return false;
  if (!isShortRow(row) && !idLooksLikeShortMicroFamily(id)) return false;

  if (row.isLegacyMacro === true) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO')) return false;

  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  if (
    idHasSchema(id, legacyMicroSchema) ||
    id.includes('_MF_V1_') ||
    id.includes('_MF_V2_') ||
    id.includes('_MF_V3_')
  ) {
    return false;
  }

  return isSelectableShortMicroMicroFamilyId(id);
}

function isRealAnalyzeMicroRow(row = {}) {
  return isTrueAnalyzeMicroRow(row);
}

function dashboardSideFromTradeSide(side, fallback = 'unknown') {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return String(fallback || 'unknown').toLowerCase();
}

function normalizeSource(source = SOURCE_VIRTUAL) {
  const src = String(source || SOURCE_VIRTUAL).trim().toUpperCase();

  if (src === SOURCE_REAL) return SOURCE_REAL;
  if (src === SOURCE_SHADOW) return SOURCE_SHADOW;
  if (src === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;

  return SOURCE_VIRTUAL;
}

function sourceWeight(source) {
  return normalizeSource(source) === SOURCE_SHADOW
    ? shadowWeight()
    : 1;
}

function fixedTaxonomyMeta(row = {}) {
  const id = rowMicroId(row);
  const parsed = parseShortTaxonomyMicroId(id);

  if (!parsed.valid) {
    return {
      setupType: row.setupType || null,
      regimeBucket: row.regimeBucket || null,
      confirmationProfile: row.confirmationProfile || null,
      parentTrueMicroFamilyId: rowParentTrueMicroId(row) || null,
      childTrueMicroFamilyId: rowChildTrueMicroId(row) || null,
      microMicroFamilyId: rowMicroMicroId(row) || null,
      fixedTaxonomyLearningId: false,
      selectableChild: false,
      selectableMicroMicro: false,
      learningLayer: 'UNKNOWN'
    };
  }

  return {
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    microMicroFamilyId: parsed.microMicroFamilyId,
    microMicroHash: parsed.microMicroHash,
    fixedTaxonomyLearningId: parsed.isChild || parsed.isMicroMicro,
    fixedTaxonomyBaseId: parsed.parentTrueMicroFamilyId,
    selectableChild: false,
    selectableMicroMicro: parsed.isMicroMicro,
    isParentTrueMicro: parsed.isParent,
    learningLayer: parsed.learningLayer
  };
}

function shortRiskGeometry(row = {}) {
  const entry = safeNumber(row.entry ?? row.entryPrice, 0);
  const initialSl = safeNumber(row.initialSl ?? row.sl ?? row.stopLoss, 0);
  const tp = safeNumber(row.tp ?? row.takeProfit, 0);
  const exitPrice = safeNumber(row.exitPrice ?? row.exit ?? row.closePrice, 0);
  const currentPrice = safeNumber(row.currentPrice ?? row.markPrice ?? row.price, 0);

  const riskDistance =
    entry > 0 &&
    initialSl > 0 &&
    initialSl > entry
      ? initialSl - entry
      : 0;

  const validShortRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    tp < entry &&
    entry < initialSl;

  const shortGrossR =
    validShortRiskShape &&
    riskDistance > 0 &&
    exitPrice > 0
      ? (entry - exitPrice) / riskDistance
      : null;

  const shortCurrentR =
    validShortRiskShape &&
    riskDistance > 0 &&
    currentPrice > 0
      ? (entry - currentPrice) / riskDistance
      : null;

  return {
    entry,
    initialSl,
    sl: initialSl,
    tp,
    exitPrice,
    currentPrice,
    riskDistance,
    validShortRiskShape,
    validShortGeometry: validShortRiskShape,
    shortTpHit: validShortRiskShape && currentPrice > 0 ? currentPrice <= tp : false,
    shortSlHit: validShortRiskShape && currentPrice > 0 ? currentPrice >= initialSl : false,
    shortGrossR,
    shortCurrentR
  };
}

function outcomeExitR(row = {}) {
  const explicitShort = finiteOrNull(
    row.shortNetR ??
      row.netShortR ??
      row.shortExitR ??
      row.realizedShortR
  );

  if (explicitShort !== null) return explicitShort;

  const explicitGeneric = finiteOrNull(
    row.netR ??
      row.exitR ??
      row.realizedNetR ??
      row.realizedR ??
      row.r
  );

  if (explicitGeneric !== null) return explicitGeneric;

  const geometry = shortRiskGeometry(row);

  if (geometry.shortGrossR !== null) return geometry.shortGrossR;

  const explicitShortGross = finiteOrNull(row.shortGrossR ?? row.grossShortR);

  if (explicitShortGross !== null) return explicitShortGross;

  const explicitGross = finiteOrNull(
    row.grossR ??
      row.rawR ??
      row.realizedGrossR
  );

  if (explicitGross !== null) return explicitGross;

  return 0;
}

function normalizeMarketWeatherRegime(value = '') {
  const text = upper(value);

  if (text.includes('SQUEEZE') || text.includes('COMPRESS')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('DIRECTION')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value = '') {
  const side = normalizeTradeSide(value);

  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const text = upper(value);

  if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT')) return 'NEUTRAL';
  if (text.includes('BEAR') || text.includes('RISK_OFF') || text === 'SHORT') return TARGET_TRADE_SIDE;
  if (text.includes('BULL') || text.includes('RISK_ON') || text === 'LONG') return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildMarketWeatherKeyV1({ regime, trendSide } = {}) {
  const cleanRegime = normalizeMarketWeatherRegime(regime);
  const cleanTrendSide = normalizeMarketWeatherTrendSide(trendSide);

  return `${cleanRegime || 'UNKNOWN'}|${cleanTrendSide || 'UNKNOWN'}`;
}

function entryMarketWeatherFields(row = {}) {
  const regime = normalizeMarketWeatherRegime(firstValue(
    row.entryMarketWeatherRegime,
    row.entryCurrentRegime,
    row.currentRegime
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstValue(
    row.entryMarketWeatherTrendSide,
    row.entryCurrentTrendSide,
    row.currentTrendSide
  ));

  const key = firstValue(
    row.entryMarketWeatherKey,
    regime !== 'UNKNOWN' || trendSide !== 'UNKNOWN'
      ? buildMarketWeatherKeyV1({ regime, trendSide })
      : null
  );

  return {
    entryMarketWeatherKey: key || null,
    entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: regime,
    entryMarketWeatherTrendSide: trendSide,
    entryMarketWeatherCapturedAt: row.entryMarketWeatherCapturedAt || row.entryCreatedAt || row.createdAt || null,
    entryMarketWeatherRaw: row.entryMarketWeatherRaw || null,
    entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
      ? row.entryMarketWeatherRawAvailableFields
      : [],
    entryMarketWeatherSourceReadFrom: row.entryMarketWeatherSourceReadFrom || null,
    entryMarketWeatherSourceKey: row.entryMarketWeatherSourceKey || null,
    entryMarketWeatherAgeSec: row.entryMarketWeatherAgeSec ?? null,
    entryMarketWeatherStale: Boolean(row.entryMarketWeatherStale),
    entryMarketWeatherImmutable: row.entryMarketWeatherImmutable !== false,
    entryMarketWeatherNeverRecomputedAtExit: row.entryMarketWeatherNeverRecomputedAtExit !== false
  };
}

function hasMarketWeather(row = {}) {
  const fields = entryMarketWeatherFields(row);

  return Boolean(
    fields.entryMarketWeatherKey &&
      fields.entryMarketWeatherRegime &&
      fields.entryMarketWeatherTrendSide &&
      fields.entryMarketWeatherRegime !== 'UNKNOWN' &&
      fields.entryMarketWeatherTrendSide !== 'UNKNOWN'
  );
}

function marketWeatherRegimeKey(row = {}) {
  const fields = entryMarketWeatherFields(row);
  return fields.entryMarketWeatherRegime && fields.entryMarketWeatherRegime !== 'UNKNOWN'
    ? fields.entryMarketWeatherRegime
    : null;
}

function marketWeatherRegimeTrendKey(row = {}) {
  const fields = entryMarketWeatherFields(row);
  return fields.entryMarketWeatherKey || (
    fields.entryMarketWeatherRegime && fields.entryMarketWeatherTrendSide
      ? buildMarketWeatherKeyV1({
          regime: fields.entryMarketWeatherRegime,
          trendSide: fields.entryMarketWeatherTrendSide
        })
      : null
  );
}

function addAccumulator(acc = {}, row = {}, source = SOURCE_VIRTUAL) {
  const src = normalizeSource(source || row.source || SOURCE_VIRTUAL);
  if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) return acc;

  const weight = sourceWeight(src);
  const exitR = outcomeExitR(row);
  const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
  const costR = inferCostR(row, exitR);
  const executionCostR = inferExecutionCostR(row, costR);
  const fundingCostR = inferFundingCostR(row);
  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  acc.completed += weight;
  acc.totalR += exitR * weight;
  acc.totalPnlPct += pnlPct * weight;
  acc.totalCostR += costR * weight;
  acc.totalExecutionCostR += executionCostR * weight;
  acc.totalFundingCostR += fundingCostR * weight;
  acc.sumR += exitR * weight;
  acc.sumSquaredR += exitR * exitR * weight;

  if (win) {
    acc.wins += weight;
    acc.grossWinR += exitR * weight;
  }

  if (loss) {
    acc.losses += weight;
    acc.grossLossR += Math.abs(exitR) * weight;
  }

  if (flat) acc.flats += weight;

  if (isDirectSL(row)) acc.directSLCount += weight;
  if (row.nearTpSeen) acc.nearTpCount += weight;
  if (row.reachedHalfR) acc.reachedHalfRCount += weight;
  if (row.reachedOneR) acc.reachedOneRCount += weight;

  if (row.beWouldExit) acc.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) acc.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) acc.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) acc.nearTpThenLossCount += weight;

  return acc;
}

function refreshAccumulator(acc = {}) {
  const completed = safeNumber(acc.completed, 0);
  const totalR = safeNumber(acc.totalR, 0);
  const grossWinR = safeNumber(acc.grossWinR, 0);
  const grossLossR = safeNumber(acc.grossLossR, 0);

  const avgR = completed > 0 ? totalR / completed : 0;
  const variance = varianceFromTotals({
    sumR: safeNumber(acc.sumR, totalR),
    sumSquaredR: safeNumber(acc.sumSquaredR, 0),
    completed
  });

  const lcb95 = avgRLowerConfidenceBound({
    avgR,
    stdDevR: variance.stdDevR,
    completed,
    z: avgRLCBZ()
  });

  const profitFactor = grossLossR > 0
    ? grossWinR / grossLossR
    : grossWinR > 0
      ? 99
      : 0;

  return {
    ...acc,
    completed: round4(completed),
    wins: round4(acc.wins),
    losses: round4(acc.losses),
    flats: round4(acc.flats),
    totalR: round4(totalR),
    avgR: round4(avgR),
    sumR: round4(acc.sumR || totalR),
    sumSquaredR: round4(acc.sumSquaredR),
    varianceR: round6(variance.varianceR),
    sampleVarianceR: round6(variance.sampleVarianceR),
    stdDevR: round6(variance.stdDevR),
    standardErrorAvgR: round6(variance.standardErrorAvgR),
    avgRLCB95: round6(lcb95),
    lcb95AvgR: round6(lcb95),
    avgRLowerBound95: round6(lcb95),
    profitFactor: round4(profitFactor),
    avgCostR: completed > 0 ? round4(safeNumber(acc.totalCostR, 0) / completed) : 0,
    directSLPct: completed > 0 ? round4(safeNumber(acc.directSLCount, 0) / completed) : 0,
    nearTpPct: completed > 0 ? round4(safeNumber(acc.nearTpCount, 0) / completed) : 0,
    reachedOneRPct: completed > 0 ? round4(safeNumber(acc.reachedOneRCount, 0) / completed) : 0
  };
}

function addMarketWeatherOutcome(stats = {}, row = {}, source = SOURCE_VIRTUAL) {
  if (!hasMarketWeather(row)) return stats;

  stats.marketWeatherStats ||= makeMarketWeatherStats();
  stats.marketWeatherStats.version = MARKET_WEATHER_AGGREGATION_VERSION;
  stats.marketWeatherStats.keyVersion = MARKET_WEATHER_KEY_VERSION;
  stats.marketWeatherStats.regime ||= {};
  stats.marketWeatherStats.regimeTrend ||= {};
  stats.marketWeatherStats.counters ||= { regime: {}, trendSide: {}, key: {} };

  const fields = entryMarketWeatherFields(row);
  const regimeKey = marketWeatherRegimeKey(row);
  const regimeTrendKey = marketWeatherRegimeTrendKey(row);

  if (regimeKey) {
    stats.marketWeatherStats.regime[regimeKey] ||= makeOutcomeAccumulator();
    addAccumulator(stats.marketWeatherStats.regime[regimeKey], row, source);
    inc(stats.marketWeatherStats.counters.regime, regimeKey);
  }

  if (regimeTrendKey) {
    stats.marketWeatherStats.regimeTrend[regimeTrendKey] ||= makeOutcomeAccumulator();
    addAccumulator(stats.marketWeatherStats.regimeTrend[regimeTrendKey], row, source);
    inc(stats.marketWeatherStats.counters.key, regimeTrendKey);
    inc(stats.marketWeatherStats.counters.trendSide, fields.entryMarketWeatherTrendSide);
  }

  stats.marketWeatherAggregationVersion = MARKET_WEATHER_AGGREGATION_VERSION;
  stats.marketWeatherKeyVersion = MARKET_WEATHER_KEY_VERSION;
  stats.marketWeatherAggregationEnabled = true;

  return stats;
}

function refreshMarketWeatherStats(stats = {}) {
  stats.marketWeatherStats ||= makeMarketWeatherStats();
  stats.marketWeatherStats.version = MARKET_WEATHER_AGGREGATION_VERSION;
  stats.marketWeatherStats.keyVersion = MARKET_WEATHER_KEY_VERSION;
  stats.marketWeatherStats.regime ||= {};
  stats.marketWeatherStats.regimeTrend ||= {};
  stats.marketWeatherStats.counters ||= { regime: {}, trendSide: {}, key: {} };

  for (const [key, value] of Object.entries(stats.marketWeatherStats.regime || {})) {
    stats.marketWeatherStats.regime[key] = refreshAccumulator(value);
  }

  for (const [key, value] of Object.entries(stats.marketWeatherStats.regimeTrend || {})) {
    stats.marketWeatherStats.regimeTrend[key] = refreshAccumulator(value);
  }

  stats.marketWeatherAggregationVersion = MARKET_WEATHER_AGGREGATION_VERSION;
  stats.marketWeatherKeyVersion = MARKET_WEATHER_KEY_VERSION;
  stats.marketWeatherFeatureFlags = marketWeatherFeatureFlags();

  return stats;
}

function marketWeatherAccumulatorFor(stats = {}, resolution = 'LIFETIME', key = null) {
  const row = refreshStatsLite(stats);

  if (resolution === 'REGIME_TREND') {
    return row.marketWeatherStats?.regimeTrend?.[key] || null;
  }

  if (resolution === 'REGIME') {
    return row.marketWeatherStats?.regime?.[key] || null;
  }

  return {
    completed: safeNumber(row.completed, 0),
    wins: safeNumber(row.wins, 0),
    losses: safeNumber(row.losses, 0),
    flats: safeNumber(row.flats, 0),
    totalR: safeNumber(row.totalR, 0),
    avgR: safeNumber(row.avgR, 0),
    sumR: safeNumber(row.sumR, row.totalR),
    sumSquaredR: safeNumber(row.sumSquaredR, 0),
    stdDevR: safeNumber(row.stdDevR, 0),
    standardErrorAvgR: safeNumber(row.standardErrorAvgR, 0),
    avgRLCB95: safeNumber(row.avgRLCB95, 0),
    lcb95AvgR: safeNumber(row.lcb95AvgR, row.avgRLCB95),
    profitFactor: safeNumber(row.profitFactor, 0),
    avgCostR: safeNumber(row.avgCostR, 0),
    directSLPct: safeNumber(row.directSLPct, 0),
    grossWinR: safeNumber(row.grossWinR, 0),
    grossLossR: safeNumber(row.grossLossR, 0)
  };
}

function inferCostR(row = {}, exitR = 0) {
  const explicit = finiteOrNull(
    row.costR ??
      row.avgCostR ??
      row.estimatedCostR ??
      row.netCostR
  );

  if (explicit !== null && explicit >= 0) {
    return explicit;
  }

  const geometry = shortRiskGeometry(row);
  const shortGrossR = finiteOrNull(
    row.shortGrossR ??
      row.grossShortR ??
      geometry.shortGrossR
  );

  if (shortGrossR !== null) {
    return Math.max(0, shortGrossR - safeNumber(exitR, 0));
  }

  const grossR = finiteOrNull(
    row.grossR ??
      row.rawR ??
      row.realizedGrossR
  );

  if (grossR !== null) {
    return Math.max(0, grossR - safeNumber(exitR, 0));
  }

  const costPct = finiteOrNull(row.costPct);
  const riskPct = finiteOrNull(row.riskPct);

  if (costPct !== null && riskPct !== null && riskPct > 0) {
    return Math.max(0, (costPct / 100) / riskPct);
  }

  return 0;
}

function inferExecutionCostR(row = {}, totalCostR = 0) {
  const explicit = finiteOrNull(row.executionCostR);

  if (explicit !== null) return explicit;

  return Math.max(0, totalCostR - Math.max(0, safeNumber(row.fundingCostR, 0)));
}

function inferFundingCostR(row = {}) {
  const explicit = finiteOrNull(row.fundingCostR);

  if (explicit !== null) return explicit;

  return 0;
}

function normalizeDedupeKey(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .slice(0, 240);
}

function observationDedupeKeyForStats(stats = {}, row = {}) {
  const direct = normalizeDedupeKey(
    row.observationDedupeKey ||
      row.observationKey ||
      row.obsKey ||
      row.dedupeKey ||
      ''
  );

  if (direct) return direct;

  const learningId = dedupeLearningIdForStats(stats, row);
  const snapshotId = normalizeDedupeKey(row.snapshotId || row.scanId || row.batchId || '');
  const symbol = normalizeDedupeKey(row.symbol || row.baseSymbol || row.contractSymbol || '');
  const entry = safeNumber(row.entry || row.entryPrice, 0);

  if (!learningId || !symbol) return '';

  if (snapshotId) {
    return normalizeDedupeKey(`${snapshotId}|${symbol}|${learningId}|${entry || 'NO_ENTRY'}`);
  }

  return normalizeDedupeKey(`NO_SNAPSHOT|${symbol}|${learningId}|${entry || 'NO_ENTRY'}`);
}

function observationAlreadySeen(stats = {}, key = '') {
  const normalized = normalizeDedupeKey(key);

  if (!normalized) return false;

  const keys = Array.isArray(stats.observationDedupeKeys)
    ? stats.observationDedupeKeys
    : [];

  return keys.includes(normalized);
}

function rememberObservationKey(stats = {}, key = '') {
  const normalized = normalizeDedupeKey(key);

  if (!normalized) return stats;

  const keys = Array.isArray(stats.observationDedupeKeys)
    ? stats.observationDedupeKeys
    : [];

  keys.push(normalized);

  stats.observationDedupeKeys = [...new Set(keys)].slice(-observationDedupeCacheLimit());
  stats.lastObservationDedupeKey = normalized;

  return stats;
}

function observationIsDuplicate(stats = {}, row = {}, key = '') {
  if (
    row.observationDuplicate === true ||
    row.observationAlreadyCounted === true ||
    row.observationCounted === false ||
    row.countObservation === false ||
    row.skipObservationCount === true ||
    row.observationSkipped === true
  ) {
    return true;
  }

  const dedupeKey = key || observationDedupeKeyForStats(stats, row);

  return Boolean(dedupeKey && observationAlreadySeen(stats, dedupeKey));
}

function outcomeIsDuplicate(row = {}) {
  return (
    row.outcomeDuplicate === true ||
    row.outcomeAlreadyRecorded === true ||
    row.outcomeCounted === false ||
    row.countOutcome === false ||
    row.skipOutcomeCount === true ||
    row.outcomeSkipped === true
  );
}

function aggregateRecentOutcomes(stats = {}) {
  const outcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isShortRow)
    : [];

  return outcomes.reduce(
    (acc, row) => {
      if (!rowMatchesStatsIdentity(stats, row)) {
        return acc;
      }

      const src = normalizeSource(row.source);

      if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
        return acc;
      }

      const weight = sourceWeight(src);

      const exitR = outcomeExitR(row);
      const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
      const costR = inferCostR(row, exitR);
      const executionCostR = inferExecutionCostR(row, costR);
      const fundingCostR = inferFundingCostR(row);

      const win = exitR > 0;
      const loss = exitR < 0;
      const flat = !win && !loss;

      acc.completed += weight;
      acc.actualCompleted += 1;

      if (win) {
        acc.wins += weight;
        acc.actualWins += 1;
        acc.grossWinR += exitR * weight;
      }

      if (loss) {
        acc.losses += weight;
        acc.actualLosses += 1;
        acc.grossLossR += Math.abs(exitR) * weight;
      }

      if (flat) {
        acc.flats += weight;
        acc.actualFlats += 1;
      }

      acc.totalR += exitR * weight;
      acc.totalPnlPct += pnlPct * weight;
      acc.totalCostR += costR * weight;
      acc.totalExecutionCostR += executionCostR * weight;
      acc.totalFundingCostR += fundingCostR * weight;

      acc.sumR += exitR * weight;
      acc.sumSquaredR += exitR * exitR * weight;

      if (isDirectSL(row)) acc.directSLCount += weight;
      if (row.nearTpSeen) acc.nearTpCount += weight;
      if (row.reachedHalfR) acc.reachedHalfRCount += weight;
      if (row.reachedOneR) acc.reachedOneRCount += weight;

      if (row.beWouldExit) acc.beWouldExitCount += weight;
      if (row.gaveBackAfterHalfR) acc.gaveBackAfterHalfRCount += weight;
      if (row.gaveBackAfterOneR) acc.gaveBackAfterOneRCount += weight;
      if (row.nearTpThenLoss) acc.nearTpThenLossCount += weight;

      return acc;
    },
    {
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,

      actualCompleted: 0,
      actualWins: 0,
      actualLosses: 0,
      actualFlats: 0,

      totalR: 0,
      totalPnlPct: 0,
      totalCostR: 0,
      totalExecutionCostR: 0,
      totalFundingCostR: 0,

      sumR: 0,
      sumSquaredR: 0,

      grossWinR: 0,
      grossLossR: 0,

      directSLCount: 0,
      nearTpCount: 0,
      reachedHalfRCount: 0,
      reachedOneRCount: 0,

      beWouldExitCount: 0,
      gaveBackAfterHalfRCount: 0,
      gaveBackAfterOneRCount: 0,
      nearTpThenLossCount: 0
    }
  );
}

function chooseTotal({
  sourceValue,
  storedValue,
  recentValue,
  sourceCompleted,
  storedCompleted,
  recentCompleted,
  allowRecentFallback = true
}) {
  if (sourceCompleted > 0) return safeNumber(sourceValue, 0);
  if (storedCompleted > 0) return safeNumber(storedValue, 0);
  if (allowRecentFallback && recentCompleted > 0) return safeNumber(recentValue, 0);

  return safeNumber(storedValue ?? sourceValue ?? recentValue, 0);
}

function sampleReliability(completed) {
  const sample = safeNumber(completed, 0);

  if (sample <= 0) return 0;

  return clamp(Math.sqrt(Math.min(sample, sampleCap()) / sampleCap()), 0, 1);
}

function sampleAdjustedAvgR(avgR, reliability) {
  const cappedAvgR = clamp(
    safeNumber(avgR, 0),
    -avgRCap(),
    avgRCap()
  );

  const samplePenalty = Math.pow(
    clamp(reliability, 0, 1),
    avgRSampleExponent()
  );

  return cappedAvgR * samplePenalty;
}

function varianceFromTotals({
  sumR,
  sumSquaredR,
  completed
} = {}) {
  const sample = safeNumber(completed, 0);
  const sum = safeNumber(sumR, 0);
  const sumSq = safeNumber(sumSquaredR, 0);

  if (sample <= 1) {
    return {
      varianceR: 0,
      sampleVarianceR: 0,
      stdDevR: 0,
      standardErrorAvgR: 0
    };
  }

  const populationVariance = Math.max(0, (sumSq / sample) - Math.pow(sum / sample, 2));
  const sampleVariance = Math.max(0, (sumSq - (sum * sum) / sample) / (sample - 1));
  const stdDevR = Math.sqrt(sampleVariance);
  const standardErrorAvgR = stdDevR / Math.sqrt(sample);

  return {
    varianceR: populationVariance,
    sampleVarianceR: sampleVariance,
    stdDevR,
    standardErrorAvgR
  };
}

export function avgRLowerConfidenceBound({
  avgR,
  stdDevR,
  completed,
  z = avgRLCBZ()
} = {}) {
  const mean = safeNumber(avgR, 0);
  const sd = Math.max(0, safeNumber(stdDevR, 0));
  const sample = safeNumber(completed, 0);

  if (sample <= 1) return 0;

  return mean - Math.max(0, safeNumber(z, DEFAULT_AVG_R_LCB_Z)) * (sd / Math.sqrt(sample));
}

function normalizeCurrentFit(value = '') {
  const text = upper(value);

  if (!text) return 'UNKNOWN';
  if (text.includes('MISFIT')) return 'MISFIT';
  if (text.includes('NO_MATCH')) return 'MISFIT';
  if (text.includes('MISMATCH')) return 'MISFIT';
  if (text.includes('AGAINST')) return 'MISFIT';
  if (text.includes('MATCH')) return 'MATCH';
  if (text.includes('FIT')) return 'MATCH';
  if (text.includes('ALIGNED')) return 'MATCH';

  return text;
}

function isCurrentFitMatch(row = {}, currentFitLookup = null) {
  const direct = normalizeCurrentFit(
    row.currentFit ??
      row.entryCurrentFit ??
      row.marketFit ??
      row.currentMarketFit ??
      ''
  );

  if (direct === 'MATCH') return true;
  if (direct === 'MISFIT') return false;

  if (typeof currentFitLookup === 'function') {
    const value = currentFitLookup(row);
    return normalizeCurrentFit(value) === 'MATCH';
  }

  if (currentFitLookup && typeof currentFitLookup === 'object') {
    const id = rowMicroId(row);
    const value = currentFitLookup[id] ??
      currentFitLookup[row.learningMicroFamilyId] ??
      currentFitLookup[row.microMicroFamilyId] ??
      currentFitLookup[row.trueMicroMicroFamilyId] ??
      currentFitLookup[row.exactMicroMicroFamilyId] ??
      currentFitLookup[row.microFamilyId] ??
      currentFitLookup[row.trueMicroFamilyId];

    return normalizeCurrentFit(value) === 'MATCH';
  }

  return false;
}

function learningStatus(stats = {}) {
  const completed = safeNumber(stats.completed, 0);
  const minCompleted = safeNumber(stats.minCompletedForActiveLearning, rowLayerMinCompleted(stats));

  if (completed <= 0) return 'OBSERVING';
  if (completed < minCompleted) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
}

function netRProfitFactorFromOutcomes(outcomes = [], fallbackWeight = 1) {
  let grossWinR = 0;
  let grossLossR = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let totalR = 0;
  let completed = 0;
  let sumSquaredR = 0;

  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== 'object') continue;
    if (!isShortRow(outcome)) continue;

    const src = normalizeSource(outcome.source);
    if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) continue;

    const weight = src === SOURCE_SHADOW ? shadowWeight() : fallbackWeight;
    const netR = outcomeExitR(outcome);

    completed += weight;
    totalR += netR * weight;
    sumSquaredR += netR * netR * weight;

    if (netR > 0) {
      wins += weight;
      grossWinR += netR * weight;
    } else if (netR < 0) {
      losses += weight;
      grossLossR += Math.abs(netR) * weight;
    } else {
      flats += weight;
    }
  }

  const profitFactor = grossLossR > 0
    ? grossWinR / grossLossR
    : grossWinR > 0
      ? 99
      : 0;

  return {
    completed,
    wins,
    losses,
    flats,
    totalR,
    sumSquaredR,
    grossWinR,
    grossLossR,
    profitFactor
  };
}

function repairProfitFactorComponents({
  grossWinR,
  grossLossR,
  totalR,
  weightedWins,
  weightedLosses,
  recentGrossWinR,
  recentGrossLossR,
  stats = {}
} = {}) {
  let winR = Math.max(
    0,
    safeNumber(grossWinR, 0),
    safeNumber(recentGrossWinR, 0),
    safeNumber(stats.grossWinR, 0),
    safeNumber(stats.virtualGrossWinR, 0),
    safeNumber(stats.shadowGrossWinR, 0)
  );

  let lossR = Math.max(
    0,
    safeNumber(grossLossR, 0),
    safeNumber(recentGrossLossR, 0),
    safeNumber(stats.grossLossR, 0),
    safeNumber(stats.virtualGrossLossR, 0),
    safeNumber(stats.shadowGrossLossR, 0)
  );

  const wins = safeNumber(weightedWins, 0);
  const losses = safeNumber(weightedLosses, 0);
  const netTotal = safeNumber(totalR, 0);

  if (winR <= 0 && losses <= 0 && wins > 0 && netTotal > 0) {
    winR = netTotal;
  }

  if (lossR <= 0 && wins <= 0 && losses > 0 && netTotal < 0) {
    lossR = Math.abs(netTotal);
  }

  if (winR <= 0 && netTotal > 0 && wins > 0) {
    winR = netTotal + lossR;
  }

  if (lossR <= 0 && netTotal < 0 && losses > 0) {
    lossR = Math.abs(netTotal) + winR;
  }

  if (winR <= 0 && lossR <= 0 && wins > 0 && losses > 0 && netTotal !== 0) {
    const nonFlat = Math.max(1, wins + losses);
    const absUnit = Math.max(0.0001, Math.abs(netTotal) / nonFlat);

    if (netTotal > 0) {
      lossR = absUnit * losses;
      winR = netTotal + lossR;
    } else {
      winR = absUnit * wins;
      lossR = Math.abs(netTotal) + winR;
    }
  }

  if (lossR <= 0 && losses > 0 && winR > 0 && netTotal > 0) {
    const nonFlat = Math.max(1, wins + losses);
    lossR = Math.max(0.0001, Math.abs(netTotal) * (losses / nonFlat));
    winR = Math.max(winR, netTotal + lossR);
  }

  if (winR <= 0 && wins > 0 && lossR > 0 && netTotal < 0) {
    const nonFlat = Math.max(1, wins + losses);
    winR = Math.max(0.0001, Math.abs(netTotal) * (wins / nonFlat));
    lossR = Math.max(lossR, Math.abs(netTotal) + winR);
  }

  const profitFactor = lossR > 0
    ? winR / lossR
    : winR > 0
      ? 99
      : 0;

  return {
    grossWinR: winR,
    grossLossR: lossR,
    profitFactor
  };
}

function empiricalVetoGate(stats = {}) {
  const row = refreshStatsLite(stats);
  const layer = rowLearningLayer(row);
  const completed = safeNumber(row.completed, 0);
  const lcb95AvgR = safeNumber(row.lcb95AvgR ?? row.avgRLCB95 ?? row.avgRLowerBound95, 0);
  const microMicroId = rowMicroMicroId(row);

  const exactMicroMicro =
    layer === LAYER_MICRO_MICRO &&
    Boolean(microMicroId) &&
    isSelectableShortMicroMicroFamilyId(microMicroId);

  const triggered =
    exactMicroMicro &&
    completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE &&
    lcb95AvgR < 0;

  return {
    version: EMPIRICAL_VETO_VERSION,
    triggered,
    empiricalVeto: triggered,
    empiricalVetoReason: triggered ? 'EXACT_MICRO_MICRO_LCB95_NEGATIVE' : null,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoBlocksParentFallbackRescue: true,
    id: microMicroId || null,
    microMicroFamilyId: microMicroId || null,
    learningLayer: layer,
    completed,
    minCompleted: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    lcb95AvgR,
    threshold: 0
  };
}

function policyBlockedGate(stats = {}) {
  const row = refreshStatsLite(stats);
  const confirmation = upper(row.confirmationProfile);
  const fit = normalizeCurrentFit(row.currentFit || row.entryCurrentFit || '');
  const side = inferTradeSide(row);
  const id = rowMicroId(row);
  const parsed = parseShortTaxonomyMicroId(id);

  const reasons = [];

  if (side === OPPOSITE_TRADE_SIDE) reasons.push('LONG_DISABLED_SHORT_ONLY_SYSTEM');
  if (!id || !parsed.valid) reasons.push('VALID_SHORT_TAXONOMY_ID_REQUIRED');
  if (parsed.isMicroMicro !== true) reasons.push('EXACT_MICRO_MICRO_ID_REQUIRED');
  if (confirmation === 'E_WEAK_CONTRA') reasons.push('E_WEAK_CONTRA_POLICY_BLOCK');
  if (fit === 'MISFIT') reasons.push('CURRENTFIT_MISFIT_POLICY_BLOCK');

  return {
    version: 'SHORT_POLICY_BLOCK_GATE_V1',
    blocked: reasons.length > 0,
    policyBlocked: reasons.length > 0,
    reasons,
    reason: reasons[0] || null
  };
}

function eligibleGate(stats = {}, options = {}) {
  const row = { ...stats };

  const layer = rowLearningLayer(row);
  const completed = safeNumber(row.completed, 0);
  const minCompleted = safeNumber(
    options.minCompleted,
    eligibleMinCompletedForLayer(layer)
  );

  const avgRLCB95 = safeNumber(row.avgRLCB95 ?? row.avgRLowerBound95 ?? row.lcb95AvgR, 0);
  const minAvgRLCB = safeNumber(options.minAvgRLCB, eligibleMinAvgRLCB());

  const directSLPct = safeNumber(row.directSLPct, 0);
  const maxDirectSLPct = safeNumber(options.maxDirectSLPct, eligibleMaxDirectSLPct());

  const avgCostR = safeNumber(row.avgCostR, 0);
  const maxAvgCostR = safeNumber(options.maxAvgCostR, eligibleMaxAvgCostR());

  const profitFactor = safeNumber(row.profitFactor, 0);
  const minProfitFactor = safeNumber(options.minProfitFactor, eligibleMinProfitFactor());

  const totalR = safeNumber(row.totalR, 0);
  const avgR = safeNumber(row.avgR, 0);

  const requireCurrentFitMatch = options.requireCurrentFitMatch === true;
  const currentFitMatched = isCurrentFitMatch(row, options.currentFitLookup);

  const policy = policyBlockedGate(row);
  const veto = empiricalVetoGate(row);

  const checks = {
    microMicroOnlyOk: layer === LAYER_MICRO_MICRO,
    policyOk: !policy.blocked,
    empiricalVetoOk: !veto.triggered,
    completedOk: completed >= minCompleted,
    avgRLCBOk: avgRLCB95 > minAvgRLCB,
    directSLOk: directSLPct < maxDirectSLPct,
    avgCostROk: avgCostR <= maxAvgCostR,
    profitFactorOk: profitFactor >= minProfitFactor,
    totalROk: totalR > 0,
    avgROk: avgR > 0,
    currentFitOk: requireCurrentFitMatch ? currentFitMatched : true
  };

  const eligible = Object.values(checks).every(Boolean);

  const reasons = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  return {
    eligible,
    checks,
    reasons,
    completed,
    minCompleted,
    avgRLCB95,
    minAvgRLCB,
    directSLPct,
    maxDirectSLPct,
    avgCostR,
    maxAvgCostR,
    profitFactor,
    minProfitFactor,
    totalR,
    avgR,
    currentFitMatched,
    requireCurrentFitMatch,
    empiricalVeto: veto.triggered,
    empiricalVetoGate: veto,
    policyBlocked: policy.blocked,
    policyBlockedGate: policy,
    lcbModelVersion: LCB_MODEL_VERSION,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    gateVersion: 'SHORT_LIFETIME_ELIGIBLE_LCB_CURRENTFIT_MICRO_MICRO_ONLY_V4_MARKET_WEATHER'
  };
}

function applyLearningIdentityFlags(stats = {}, row = {}) {
  const existingId = rowMicroId(stats);
  const rowId = rowMicroId(row);
  const id = existingId || rowId;

  const taxonomy = fixedTaxonomyMeta({
    ...row,
    learningMicroFamilyId: id || row.learningMicroFamilyId,
    learningFamilyId: id || row.learningFamilyId
  });

  const learningLayer = taxonomy.learningLayer || learningLayerFromId(id);
  const isParentLayer = learningLayer === LAYER_PARENT_15;
  const isMicroMicroLayer = learningLayer === LAYER_MICRO_MICRO;
  const isMicro75Layer = learningLayer === LAYER_MICRO_75;
  const minCompleted = minCompletedForLayer(learningLayer);

  const parentId =
    taxonomy.parentTrueMicroFamilyId ||
    rowParentTrueMicroId(stats) ||
    rowParentTrueMicroId(row) ||
    null;

  const childId =
    taxonomy.childTrueMicroFamilyId ||
    rowChildTrueMicroId(stats) ||
    rowChildTrueMicroId(row) ||
    null;

  const microMicroId =
    isMicroMicroLayer
      ? taxonomy.microMicroFamilyId || rowMicroMicroId(stats) || rowMicroMicroId(row) || id || null
      : null;

  stats.redisNamespace = SHORT_NAMESPACE;
  stats.redisKeyPrefix = SHORT_KEY_PREFIX;
  stats.persistentLearningKey = PERSISTENT_LEARNING_KEY;
  stats.redisKeysSeparatedFromLongRoot = true;
  stats.longRootTouched = false;

  stats.learningLayer = learningLayer;
  stats.learningHierarchy = 'PARENT_15_TO_MICRO_75_TO_MICRO_MICRO';

  stats.parentTrueMicroFamilyId = parentId;
  stats.parentMicroFamilyId = parentId;
  stats.parentMacroFamilyId = parentId;
  stats.macroFamilyId = parentId;
  stats.coarseMicroFamilyId = parentId;
  stats.baseMicroFamilyId = parentId;
  stats.legacyMicroFamilyId = parentId;

  stats.childTrueMicroFamilyId = childId;
  stats.base75ChildTrueMicroFamilyId = childId;
  stats.baseTrueMicroFamilyId = childId;
  stats.trueMicro75FamilyId = childId;

  stats.microMicroFamilyId = microMicroId;
  stats.trueMicroMicroFamilyId = microMicroId;
  stats.exactMicroMicroFamilyId = microMicroId;

  if (id) {
    stats.learningFamilyId = id;
    stats.learningMicroFamilyId = id;
    stats.analyzeMicroFamilyId = id;
  }

  if (isMicro75Layer && childId) {
    stats.microFamilyId = childId;
    stats.trueMicroFamilyId = childId;
    stats.childTrueMicroFamilyId = childId;
    stats.analyzeMicroFamilyId = childId;
    stats.learningMicroFamilyId = childId;
    stats.learningFamilyId = childId;
  }

  if (isParentLayer && parentId) {
    stats.microFamilyId = parentId;
    stats.trueMicroFamilyId = parentId;
    stats.childTrueMicroFamilyId = null;
    stats.base75ChildTrueMicroFamilyId = null;
    stats.analyzeMicroFamilyId = parentId;
    stats.learningMicroFamilyId = parentId;
    stats.learningFamilyId = parentId;
  }

  if (isMicroMicroLayer && microMicroId) {
    stats.microFamilyId = childId;
    stats.trueMicroFamilyId = childId;
    stats.childTrueMicroFamilyId = childId;
    stats.base75ChildTrueMicroFamilyId = childId;
    stats.analyzeMicroFamilyId = microMicroId;
    stats.learningMicroFamilyId = microMicroId;
    stats.learningFamilyId = microMicroId;
  }

  stats.setupType = taxonomy.setupType || stats.setupType || null;
  stats.regimeBucket = taxonomy.regimeBucket || stats.regimeBucket || null;
  stats.confirmationProfile = taxonomy.confirmationProfile || stats.confirmationProfile || null;

  stats.trueMicroOnly = !isParentLayer;
  stats.exactTrueMicroOnly = !isParentLayer;
  stats.exactTrueMicroFamilyRequired = !isParentLayer;

  stats.trueMicroFamilySchema = isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA;
  stats.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
  stats.exactTrueMicroFamilySchema = isMicroMicroLayer ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA;
  stats.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;
  stats.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.microFamilySchema = isMicroMicroLayer
    ? MICRO_MICRO_SCHEMA
    : isParentLayer
      ? PARENT_TRUE_MICRO_SCHEMA
      : TRUE_MICRO_SCHEMA;
  stats.microMicroFamilySchema = MICRO_MICRO_SCHEMA;
  stats.trueMicroMicroFamilySchema = TRUE_MICRO_MICRO_SCHEMA;
  stats.schema = stats.microFamilySchema;

  stats.learningGranularity = isMicroMicroLayer
    ? MICRO_MICRO_LEARNING_GRANULARITY
    : isParentLayer
      ? PARENT_LEARNING_GRANULARITY
      : LEARNING_GRANULARITY;

  stats.parentLearningGranularity = PARENT_LEARNING_GRANULARITY;
  stats.child75LearningGranularity = CHILD75_LEARNING_GRANULARITY;
  stats.microMicroLearningGranularity = MICRO_MICRO_LEARNING_GRANULARITY;

  stats.fixedTaxonomyPreferred = true;
  stats.fixedTaxonomyLearningId = taxonomy.fixedTaxonomyLearningId;
  stats.fixedTaxonomyBaseId = taxonomy.fixedTaxonomyBaseId || stats.fixedTaxonomyBaseId || parentId || null;
  stats.selectableChild = false;
  stats.selectableMicroMicro = isMicroMicroLayer;
  stats.selectable = isMicroMicroLayer;

  stats.parentSelectionAllowed = false;
  stats.micro75SelectionAllowed = false;
  stats.microMicroSelectionAllowed = isMicroMicroLayer;

  stats.selectionGranularity = isMicroMicroLayer
    ? SELECTION_EXACT_MICRO_MICRO
    : isMicro75Layer
      ? SELECTION_75_CHILD_CONTEXT
      : SELECTION_PARENT_CONTEXT;

  stats.sampleFallbackAllowed = isMicroMicroLayer;
  stats.sampleFallbackLayer = isMicroMicroLayer ? LAYER_MICRO_75 : isMicro75Layer ? LAYER_PARENT_15 : null;
  stats.sampleFallbackId = isMicroMicroLayer ? childId : isMicro75Layer ? parentId : null;
  stats.sampleDoesNotSplitParent = true;
  stats.sampleDoesNotSplitMicro75 = true;
  stats.rollupStatsRequired = true;
  stats.rollupParent15 = parentId;
  stats.rollupMicro75 = childId;
  stats.rollupMicroMicro = microMicroId;
  stats.rollupUpdatePolicy = 'COUNT_THIS_LAYER_AND_PARENT_LAYERS_SEPARATELY';

  stats.scannerFingerprintRole = 'METADATA_ONLY';
  stats.scannerFingerprintsMetadataOnly = true;
  stats.scannerFingerprintsUsedAsLearningFamily = false;
  stats.scannerBucketsMetadataOnly = true;
  stats.legacy25BucketsMetadataOnly = true;

  stats.executionFingerprintRole = isMicroMicroLayer ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY';
  stats.executionFingerprintsMetadataOnly = !isMicroMicroLayer;
  stats.executionFingerprintsUsedAsLearningFamily = false;
  stats.executionFingerprintsCanDeriveMicroMicroContextHash = true;

  stats.analyzeMicroFamiliesOnly = true;
  stats.learningIdentitySource = isMicroMicroLayer
    ? 'ANALYZE_MICRO_MICRO_FAMILY'
    : isMicro75Layer
      ? 'ANALYZE_TRUE_MICRO_FAMILY_CONTEXT_ONLY'
      : 'ANALYZE_PARENT_TRUE_MICRO_FAMILY_CONTEXT_ONLY';

  stats.symbolExcludedFromFamilyId = true;
  stats.coinNameExcludedFromFamilyId = true;
  stats.hashesExcludedFromFamilyId = !isMicroMicroLayer;

  stats.completedDefinition = 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES';
  stats.completedOnlyClosedVirtualOrShadow = true;
  stats.scoringRSource = 'netR';
  stats.winsLossesFlatsSource = 'netR';
  stats.winrateDefinition = 'netR > 0';
  stats.avgRSource = 'netR';
  stats.totalRSource = 'netR';
  stats.avgCostRShown = true;
  stats.avgCostRSource = 'costR';

  stats.lcbModelVersion = LCB_MODEL_VERSION;
  stats.avgRLCBDefinition = 'avgR - z * (stdDevR / sqrt(completed))';
  stats.avgRLCBUsesNetR = true;
  stats.avgRLCBSource = 'netR';
  stats.selectionUsesLCBAvgR = true;
  stats.selectionAvoidsWeeklyWinnerCurse = true;

  stats.measurementFixVersion = MEASUREMENT_FIX_VERSION;
  stats.microMicroMeasurementVersion = MICRO_MICRO_MEASUREMENT_VERSION;
  stats.microMicroVersion = MICRO_MICRO_VERSION;
  stats.selectionEngineVersion = SELECTION_ENGINE_VERSION;
  stats.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';
  stats.observationDedupeRequired = true;
  stats.observationAlwaysCounted = false;

  stats.defaultRanking = 'eligible|avgRLCB95|totalR|avgR|fairWinrate|directSLPct|avgCostR|profitFactor';
  stats.bareWinrateRankingDisabled = true;
  stats.rawWinrateRankingDisabled = true;
  stats.rankingUsesBalancedScore = true;
  stats.rankingUsesFairWinrate = true;
  stats.rankingUsesTotalR = true;
  stats.rankingUsesAvgR = true;
  stats.rankingUsesAvgCostR = true;
  stats.rankingUsesAvgRLCB95 = true;
  stats.rankingUsesProfitFactor = true;

  stats.currentFitSoftOnly = true;
  stats.currentFitBlocksLearning = false;
  stats.currentFitPolarity = 'BEARISH_POSITIVE_BULLISH_NEGATIVE';
  stats.currentFitDefinition = 'SHORT_MIRRORED_CURRENT_FIT';
  stats.learningRemainsBroad = true;
  stats.selectionWillBeAdaptive = true;
  stats.discordWillBeStrict = true;
  stats.discordSelectionRule = 'EXACT_MICRO_MICRO_ONLY';
  stats.manualSelectionMatchMode = 'EXACT_MICRO_MICRO_ID';
  stats.discordOnlyForSelectedMicroFamilies = false;
  stats.discordOnlyForSelectedMicroMicroFamilies = true;
  stats.discordOnlyForExactTrueMicroMatch = false;
  stats.discordOnlyForExactMicroMicroMatch = true;
  stats.discordCanSelectExactMicroMicro = isMicroMicroLayer;
  stats.discordCanSelectExact75Child = false;
  stats.discordParentMatchAllowed = false;
  stats.parent15MatchTriggersDiscord = false;
  stats.child75MatchTriggersDiscord = false;
  stats.micro75MatchDoesNotTriggerDiscord = true;
  stats.scannerMatchTriggersDiscord = false;

  stats.adaptiveLayerBuilt = false;
  stats.adaptiveScoreBuilt = false;
  stats.recentMomentumScoreBuilt = false;
  stats.currentFitScoreBuilt = false;
  stats.parentDiversificationBuilt = false;

  stats.marketWeatherKeyVersion = MARKET_WEATHER_KEY_VERSION;
  stats.marketWeatherAggregationVersion = MARKET_WEATHER_AGGREGATION_VERSION;
  stats.marketWeatherShrinkageVersion = MARKET_WEATHER_SHRINKAGE_VERSION;
  stats.marketWeatherFdrVersion = MARKET_WEATHER_FDR_VERSION;
  stats.marketWeatherSelectorVersion = MARKET_WEATHER_SELECTOR_VERSION;
  stats.marketWeatherFeatureFlags = marketWeatherFeatureFlags();
  stats.marketWeatherCaptureEnabled = true;
  stats.marketWeatherAggregationEnabled = true;
  stats.marketWeatherSelectorObserveOnly = true;
  stats.marketWeatherFdrObserveOnly = true;
  stats.marketWeatherSizingCapObserveOnly = true;
  stats.marketWeatherDiscordTradeReadyEnabled = false;

  stats.empiricalVetoVersion = EMPIRICAL_VETO_VERSION;
  stats.empiricalVetoUsesLcb95 = true;
  stats.empiricalVetoUsesRawAvgR = false;
  stats.empiricalVetoBlocksParentFallbackRescue = true;

  stats.validShortRiskShape = 'entry > 0 && tp < entry && sl > entry';
  stats.shortRiskShape = 'tp < entry < sl';
  stats.riskTradeSide = TARGET_TRADE_SIDE;
  stats.riskGeometryRule = 'SHORT: tp < entry < sl';
  stats.tpHitRule = 'SHORT: price <= tp';
  stats.slHitRule = 'SHORT: price >= sl';
  stats.grossRFormula = '(entry - exitPrice) / (initialSl - entry)';
  stats.currentRFormula = '(entry - currentPrice) / (initialSl - entry)';
  stats.shortGrossRFormula = '(entry - exitPrice) / (initialSl - entry)';
  stats.shortCurrentRFormula = '(entry - currentPrice) / (initialSl - entry)';

  stats.realOrdersDisabled = true;
  stats.exchangeOrdersDisabled = true;
  stats.bitgetOrdersDisabled = true;
  stats.exchangeCallsDisabled = true;
  stats.noRealOrders = true;
  stats.noExchangeOrders = true;

  stats.minCompletedForActiveLearning = minCompleted;
  stats.microMicroMinCompletedForActiveLearning = MIN_COMPLETED_MICRO_MICRO_ACTIVE;
  stats.eligibleMinCompleted = eligibleMinCompletedForLayer(learningLayer);
  stats.eligibleMinAvgRLCB = eligibleMinAvgRLCB();
  stats.eligibleMaxDirectSLPct = eligibleMaxDirectSLPct();
  stats.eligibleMaxAvgCostR = eligibleMaxAvgCostR();
  stats.eligibleMinProfitFactor = eligibleMinProfitFactor();

  return stats;
}

function applySideIdentity(stats = {}, row = {}) {
  const tradeSide = inferTradeSide({
    ...stats,
    ...row
  });

  stats.shortOnly = true;
  stats.longDisabled = true;
  stats.longOnly = false;
  stats.shortDisabled = false;

  applyLearningIdentityFlags(stats, row);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    stats.tradeSide = null;
    stats.side = 'unknown';
    return stats;
  }

  stats.tradeSide = TARGET_TRADE_SIDE;
  stats.side = TARGET_DASHBOARD_SIDE;
  stats.positionSide = TARGET_TRADE_SIDE;
  stats.direction = TARGET_TRADE_SIDE;
  stats.targetTradeSide = TARGET_TRADE_SIDE;
  stats.targetScannerSide = TARGET_SCANNER_SIDE;
  stats.dashboardSide = TARGET_DASHBOARD_SIDE;

  return stats;
}

function hasSourceBuckets(stats = {}) {
  return (
    safeNumber(stats.virtualCompleted, 0) > 0 ||
    safeNumber(stats.shadowCompleted, 0) > 0 ||
    safeNumber(stats.virtualWins, 0) > 0 ||
    safeNumber(stats.virtualLosses, 0) > 0 ||
    safeNumber(stats.virtualFlats, 0) > 0 ||
    safeNumber(stats.shadowWins, 0) > 0 ||
    safeNumber(stats.shadowLosses, 0) > 0 ||
    safeNumber(stats.shadowFlats, 0) > 0 ||
    safeNumber(stats.virtualTotalR, 0) !== 0 ||
    safeNumber(stats.shadowTotalR, 0) !== 0 ||
    safeNumber(stats.virtualTotalCostR, 0) !== 0 ||
    safeNumber(stats.shadowTotalCostR, 0) !== 0 ||
    safeNumber(stats.virtualSumSquaredR, 0) !== 0 ||
    safeNumber(stats.shadowSumSquaredR, 0) !== 0
  );
}

function closedCompletedCount(stats = {}) {
  return (
    safeNumber(stats.virtualCompleted, 0) +
    safeNumber(stats.shadowCompleted, 0)
  );
}

function actualOutcomeCounts(stats = {}) {
  if (hasSourceBuckets(stats)) {
    const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
    const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

    const virtualWins = safeNumber(stats.virtualWins, 0);
    const virtualLosses = safeNumber(stats.virtualLosses, 0);
    const virtualFlats = safeNumber(stats.virtualFlats, 0);

    const shadowWins = safeNumber(stats.shadowWins, 0);
    const shadowLosses = safeNumber(stats.shadowLosses, 0);
    const shadowFlats = safeNumber(stats.shadowFlats, 0);

    const completed = virtualCompleted + shadowCompleted;
    const bucketCompleted =
      virtualWins +
      virtualLosses +
      virtualFlats +
      shadowWins +
      shadowLosses +
      shadowFlats;

    const inferredFlats = Math.max(0, completed - bucketCompleted);

    return {
      wins: virtualWins + shadowWins,
      losses: virtualLosses + shadowLosses,
      flats: virtualFlats + shadowFlats + inferredFlats,
      completed: Math.max(completed, bucketCompleted)
    };
  }

  return {
    wins: safeNumber(stats.wins, 0),
    losses: safeNumber(stats.losses, 0),
    flats: safeNumber(stats.flats, 0),
    completed: safeNumber(stats.completed, 0)
  };
}

function weightedCompletedCount(stats = {}) {
  const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

  return virtualCompleted + shadowCompleted * shadowWeight();
}

function weightedSourceCounts(stats = {}) {
  const weight = shadowWeight();

  return {
    wins:
      safeNumber(stats.virtualWins, 0) +
      safeNumber(stats.shadowWins, 0) * weight,

    losses:
      safeNumber(stats.virtualLosses, 0) +
      safeNumber(stats.shadowLosses, 0) * weight,

    flats:
      safeNumber(stats.virtualFlats, 0) +
      safeNumber(stats.shadowFlats, 0) * weight,

    completed:
      safeNumber(stats.virtualCompleted, 0) +
      safeNumber(stats.shadowCompleted, 0) * weight
  };
}

function weightedSourceTotals(stats = {}) {
  const weight = shadowWeight();

  return {
    totalR:
      safeNumber(stats.virtualTotalR, 0) +
      safeNumber(stats.shadowTotalR, 0) * weight,

    totalPnlPct:
      safeNumber(stats.virtualTotalPnlPct, 0) +
      safeNumber(stats.shadowTotalPnlPct, 0) * weight,

    totalCostR:
      safeNumber(stats.virtualTotalCostR, 0) +
      safeNumber(stats.shadowTotalCostR, 0) * weight,

    totalExecutionCostR:
      safeNumber(stats.virtualTotalExecutionCostR, 0) +
      safeNumber(stats.shadowTotalExecutionCostR, 0) * weight,

    totalFundingCostR:
      safeNumber(stats.virtualTotalFundingCostR, 0) +
      safeNumber(stats.shadowTotalFundingCostR, 0) * weight,

    sumR:
      safeNumber(stats.virtualSumR, 0) +
      safeNumber(stats.shadowSumR, 0) * weight,

    sumSquaredR:
      safeNumber(stats.virtualSumSquaredR, 0) +
      safeNumber(stats.shadowSumSquaredR, 0) * weight,

    grossWinR:
      safeNumber(stats.virtualGrossWinR, 0) +
      safeNumber(stats.shadowGrossWinR, 0) * weight,

    grossLossR:
      safeNumber(stats.virtualGrossLossR, 0) +
      safeNumber(stats.shadowGrossLossR, 0) * weight
  };
}

function isSlExitReason(value = '') {
  const reason = upper(value);

  return [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS',
    'STOPPED',
    'HIT_STOP',
    'HARD_SL',
    'DIRECT_SL'
  ].includes(reason) ||
    reason.includes('STOP_LOSS') ||
    reason.includes('STOPLOSS') ||
    reason.includes('HIT_SL') ||
    reason.includes('DIRECT_SL');
}

function isDirectSL(row = {}) {
  if (
    row.directToSL === true ||
    row.directSL === true ||
    row.directStopLoss === true ||
    row.isDirectSL === true
  ) {
    return true;
  }

  if (!isSlExitReason(row.exitReason || row.reason)) {
    return false;
  }

  if (
    row.nearTpSeen === true ||
    row.reachedHalfR === true ||
    row.reachedOneR === true
  ) {
    return false;
  }

  const mfeR = safeNumber(row.mfeR, 0);
  const maeR = safeNumber(row.maeR, 0);

  return mfeR < 0.25 || maeR <= -0.8;
}

function ensureStatsShape(stats = {}) {
  stats.counters ||= makeCounters();
  stats.counters.rsiZone ||= {};
  stats.counters.flow ||= {};
  stats.counters.obRelation ||= {};
  stats.counters.btcState ||= {};
  stats.counters.regime ||= {};
  stats.counters.scannerReason ||= {};
  stats.counters.microMicroFamilyId ||= {};
  stats.counters.learningLayer ||= {};
  stats.counters.currentFit ||= {};
  stats.counters.entryMarketWeatherRegime ||= {};
  stats.counters.entryMarketWeatherTrendSide ||= {};
  stats.counters.entryMarketWeatherKey ||= {};

  stats.marketWeatherStats ||= makeMarketWeatherStats();
  stats.marketWeatherStats.regime ||= {};
  stats.marketWeatherStats.regimeTrend ||= {};
  stats.marketWeatherStats.counters ||= { regime: {}, trendSide: {}, key: {} };

  stats.examples = Array.isArray(stats.examples) ? stats.examples.filter(isShortRow) : [];
  stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isShortRow)
    : [];

  stats.definitionParts = Array.isArray(stats.definitionParts)
    ? stats.definitionParts
    : [];

  stats.observationDedupeKeys = Array.isArray(stats.observationDedupeKeys)
    ? stats.observationDedupeKeys.map(normalizeDedupeKey).filter(Boolean).slice(-observationDedupeCacheLimit())
    : [];

  stats.definition ||= stats.definitionParts.join(' | ');

  stats.shortOnly = true;
  stats.longDisabled = true;
  stats.longOnly = false;
  stats.shortDisabled = false;
  stats.source ||= SOURCE_VIRTUAL;

  applySideIdentity(stats);

  const numericFields = [
    'seen',
    'observations',
    'observationDuplicateSkippedCount',
    'outcomeDuplicateSkippedCount',

    'virtualCompleted',
    'realCompleted',
    'shadowCompleted',
    'completed',
    'winrateSample',

    'wins',
    'losses',
    'flats',

    'virtualWins',
    'virtualLosses',
    'virtualFlats',

    'realWins',
    'realLosses',
    'realFlats',

    'shadowWins',
    'shadowLosses',
    'shadowFlats',

    'totalR',
    'virtualTotalR',
    'realTotalR',
    'shadowTotalR',

    'sumR',
    'virtualSumR',
    'realSumR',
    'shadowSumR',

    'sumSquaredR',
    'virtualSumSquaredR',
    'realSumSquaredR',
    'shadowSumSquaredR',

    'varianceR',
    'sampleVarianceR',
    'stdDevR',
    'standardErrorAvgR',
    'avgRLCB95',
    'avgRLowerBound95',
    'lcb95AvgR',
    'avgRLCBZ',

    'totalPnlPct',
    'virtualTotalPnlPct',
    'realTotalPnlPct',
    'shadowTotalPnlPct',

    'totalCostR',
    'virtualTotalCostR',
    'realTotalCostR',
    'shadowTotalCostR',

    'totalExecutionCostR',
    'virtualTotalExecutionCostR',
    'realTotalExecutionCostR',
    'shadowTotalExecutionCostR',

    'totalFundingCostR',
    'virtualTotalFundingCostR',
    'realTotalFundingCostR',
    'shadowTotalFundingCostR',

    'grossWinR',
    'grossLossR',

    'virtualGrossWinR',
    'virtualGrossLossR',
    'realGrossWinR',
    'realGrossLossR',
    'shadowGrossWinR',
    'shadowGrossLossR',

    'avgR',
    'avgWinR',
    'avgLossR',
    'sampleAdjustedAvgR',
    'avgRScore',

    'avgPnlPct',
    'avgCostR',
    'avgExecutionCostR',
    'avgFundingCostR',

    'directSLCount',
    'nearTpCount',
    'reachedHalfRCount',
    'reachedOneRCount',

    'beWouldExitCount',
    'gaveBackAfterHalfRCount',
    'gaveBackAfterOneRCount',
    'nearTpThenLossCount',

    'winrate',
    'bayesianWinrate',
    'wilsonLowerBound',
    'fairWinrate',
    'sampleAdjustedWinrate',

    'sampleRawWinrate',
    'sampleBayesianWinrate',
    'sampleWilsonLowerBound',
    'sampleReliabilityOld',

    'profitFactor',
    'sampleReliability',
    'balancedScore',
    'dashboardBalancedScore',

    'directSLPct',
    'nearTpPct',
    'reachedHalfRPct',
    'reachedOneRPct',

    'beWouldExitPct',
    'gaveBackAfterHalfRPct',
    'gaveBackAfterOneRPct',
    'nearTpThenLossPct',

    'eligibleMinCompleted',
    'eligibleMinAvgRLCB',
    'eligibleMaxDirectSLPct',
    'eligibleMaxAvgCostR',
    'eligibleMinProfitFactor',

    'minCompletedForActiveLearning',
    'microMicroMinCompletedForActiveLearning'
  ];

  for (const field of numericFields) {
    stats[field] = safeNumber(
      stats[field],
      field === 'microMicroMinCompletedForActiveLearning'
        ? MIN_COMPLETED_MICRO_MICRO_ACTIVE
        : field === 'avgRLCBZ'
          ? DEFAULT_AVG_R_LCB_Z
          : 0
    );
  }

  stats.realCompleted = 0;
  stats.realWins = 0;
  stats.realLosses = 0;
  stats.realFlats = 0;
  stats.realTotalR = 0;
  stats.realTotalPnlPct = 0;
  stats.realTotalCostR = 0;
  stats.realTotalExecutionCostR = 0;
  stats.realTotalFundingCostR = 0;
  stats.realGrossWinR = 0;
  stats.realGrossLossR = 0;
  stats.realSumR = 0;
  stats.realSumSquaredR = 0;

  stats.lcbModelVersion = LCB_MODEL_VERSION;
  stats.avgRLCBDefinition = 'avgR - z * (stdDevR / sqrt(completed))';
  stats.avgRLCBUsesNetR = true;
  stats.avgRLCBSource = 'netR';
  stats.selectionUsesLCBAvgR = true;
  stats.selectionAvoidsWeeklyWinnerCurse = true;

  stats.marketWeatherKeyVersion = MARKET_WEATHER_KEY_VERSION;
  stats.marketWeatherAggregationVersion = MARKET_WEATHER_AGGREGATION_VERSION;
  stats.marketWeatherShrinkageVersion = MARKET_WEATHER_SHRINKAGE_VERSION;
  stats.marketWeatherFdrVersion = MARKET_WEATHER_FDR_VERSION;
  stats.marketWeatherSelectorVersion = MARKET_WEATHER_SELECTOR_VERSION;
  stats.marketWeatherFeatureFlags = marketWeatherFeatureFlags();

  stats.empiricalVetoVersion = EMPIRICAL_VETO_VERSION;
  stats.empiricalVetoUsesLcb95 = true;
  stats.empiricalVetoUsesRawAvgR = false;
  stats.empiricalVetoBlocksParentFallbackRescue = true;

  stats.currentFitSoftOnly = true;
  stats.currentFitBlocksLearning = false;
  stats.currentFitPolarity = 'BEARISH_POSITIVE_BULLISH_NEGATIVE';
  stats.currentFitDefinition = 'SHORT_MIRRORED_CURRENT_FIT';
  stats.learningRemainsBroad = true;
  stats.selectionWillBeAdaptive = true;
  stats.discordWillBeStrict = true;
  stats.discordSelectionRule = 'EXACT_MICRO_MICRO_ONLY';
  stats.manualSelectionMatchMode = 'EXACT_MICRO_MICRO_ID';
  stats.discordOnlyForSelectedMicroFamilies = false;
  stats.discordOnlyForSelectedMicroMicroFamilies = true;
  stats.discordOnlyForExactTrueMicroMatch = false;
  stats.discordOnlyForExactMicroMicroMatch = true;
  stats.parent15MatchTriggersDiscord = false;
  stats.child75MatchTriggersDiscord = false;
  stats.micro75MatchDoesNotTriggerDiscord = true;
  stats.scannerMatchTriggersDiscord = false;

  stats.profitFactorSource = stats.profitFactorSource || 'NET_R_OUTCOMES';
  stats.profitFactorFixVersion = MICRO_MICRO_MEASUREMENT_VERSION;

  stats.adaptiveLayerBuilt = false;
  stats.adaptiveScoreBuilt = false;
  stats.recentMomentumScoreBuilt = false;
  stats.currentFitScoreBuilt = false;
  stats.parentDiversificationBuilt = false;

  stats.createdAt ||= now();
  stats.updatedAt ||= now();

  return stats;
}

export function createMicroStats({
  microFamilyId,
  familyId,
  side = TARGET_DASHBOARD_SIDE,
  tradeSide = TARGET_TRADE_SIDE,
  definitionParts = []
} = {}) {
  const ts = now();

  const parsed = parseShortTaxonomyMicroId(microFamilyId);
  const learningLayer = parsed.learningLayer || 'UNKNOWN';

  const resolvedLearningId = parsed.valid
    ? parsed.id
    : String(microFamilyId || '').trim().toUpperCase();

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId || null;
  const childTrueMicroFamilyId = parsed.childTrueMicroFamilyId || null;
  const microMicroFamilyId = parsed.microMicroFamilyId || null;

  const inferredTradeSide = inferTradeSide({
    learningMicroFamilyId: resolvedLearningId,
    microFamilyId: parsed.isMicroMicro ? childTrueMicroFamilyId : resolvedLearningId,
    familyId,
    side,
    tradeSide,
    definitionParts
  });

  const cleanTradeSide = inferredTradeSide === TARGET_TRADE_SIDE
    ? TARGET_TRADE_SIDE
    : normalizeTradeSide(tradeSide || side);

  const isShort = cleanTradeSide === TARGET_TRADE_SIDE;
  const isParentLayer = learningLayer === LAYER_PARENT_15;
  const isMicro75Layer = learningLayer === LAYER_MICRO_75;
  const isMicroMicroLayer = learningLayer === LAYER_MICRO_MICRO;
  const minCompleted = minCompletedForLayer(learningLayer);

  const visibleMicroFamilyId = isMicroMicroLayer
    ? childTrueMicroFamilyId
    : resolvedLearningId;

  const stats = {
    id: resolvedLearningId,
    key: resolvedLearningId,
    rowId: resolvedLearningId,

    learningFamilyId: resolvedLearningId,
    learningMicroFamilyId: resolvedLearningId,
    analyzeMicroFamilyId: resolvedLearningId,

    microFamilyId: visibleMicroFamilyId,
    trueMicroFamilyId: isParentLayer ? parentTrueMicroFamilyId : childTrueMicroFamilyId,
    childTrueMicroFamilyId: childTrueMicroFamilyId || null,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId || null,
    baseTrueMicroFamilyId: childTrueMicroFamilyId || null,
    trueMicro75FamilyId: childTrueMicroFamilyId || null,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,

    familyId,

    side: isShort ? TARGET_DASHBOARD_SIDE : 'unknown',
    tradeSide: isShort ? TARGET_TRADE_SIDE : null,
    positionSide: isShort ? TARGET_TRADE_SIDE : null,
    direction: isShort ? TARGET_TRADE_SIDE : null,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: SOURCE_VIRTUAL,

    schema: isMicroMicroLayer ? MICRO_MICRO_SCHEMA : isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    microFamilySchema: isMicroMicroLayer ? MICRO_MICRO_SCHEMA : isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicroLayer ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: isMicroMicroLayer
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParentLayer
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer,
    learningHierarchy: 'PARENT_15_TO_MICRO_75_TO_MICRO_MICRO',

    setupType: parsed.setupType || null,
    regimeBucket: parsed.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || null,
    fixedTaxonomyLearningId: isMicro75Layer || isMicroMicroLayer,
    fixedTaxonomyBaseId: parentTrueMicroFamilyId,
    selectableChild: false,
    selectableMicroMicro: isMicroMicroLayer,
    selectable: isMicroMicroLayer,

    trueMicroOnly: !isParentLayer,
    exactTrueMicroOnly: !isParentLayer,
    exactTrueMicroFamilyRequired: !isParentLayer,

    selectionGranularity: isMicroMicroLayer
      ? SELECTION_EXACT_MICRO_MICRO
      : isMicro75Layer
        ? SELECTION_75_CHILD_CONTEXT
        : SELECTION_PARENT_CONTEXT,

    parentSelectionAllowed: false,
    micro75SelectionAllowed: false,
    microMicroSelectionAllowed: isMicroMicroLayer,

    sampleFallbackAllowed: isMicroMicroLayer,
    sampleFallbackLayer: isMicroMicroLayer ? LAYER_MICRO_75 : isMicro75Layer ? LAYER_PARENT_15 : null,
    sampleFallbackId: isMicroMicroLayer ? childTrueMicroFamilyId : isMicro75Layer ? parentTrueMicroFamilyId : null,
    sampleDoesNotSplitParent: true,
    sampleDoesNotSplitMicro75: true,
    rollupStatsRequired: true,
    rollupParent15: parentTrueMicroFamilyId,
    rollupMicro75: childTrueMicroFamilyId,
    rollupMicroMicro: microMicroFamilyId,
    rollupUpdatePolicy: 'COUNT_THIS_LAYER_AND_PARENT_LAYERS_SEPARATELY',

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    definitionParts,
    definition: definitionParts.join(' | '),

    seen: 0,
    observations: 0,
    observationDuplicateSkippedCount: 0,
    outcomeDuplicateSkippedCount: 0,
    observationDedupeKeys: [],
    observationAlwaysCounted: false,

    virtualCompleted: 0,
    realCompleted: 0,
    shadowCompleted: 0,
    completed: 0,
    winrateSample: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    virtualWins: 0,
    virtualLosses: 0,
    virtualFlats: 0,

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    shadowWins: 0,
    shadowLosses: 0,
    shadowFlats: 0,

    totalR: 0,
    virtualTotalR: 0,
    realTotalR: 0,
    shadowTotalR: 0,

    sumR: 0,
    virtualSumR: 0,
    realSumR: 0,
    shadowSumR: 0,

    sumSquaredR: 0,
    virtualSumSquaredR: 0,
    realSumSquaredR: 0,
    shadowSumSquaredR: 0,

    varianceR: 0,
    sampleVarianceR: 0,
    stdDevR: 0,
    standardErrorAvgR: 0,
    avgRLCB95: 0,
    avgRLowerBound95: 0,
    lcb95AvgR: 0,
    avgRLCBZ: DEFAULT_AVG_R_LCB_Z,

    totalPnlPct: 0,
    virtualTotalPnlPct: 0,
    realTotalPnlPct: 0,
    shadowTotalPnlPct: 0,

    totalCostR: 0,
    virtualTotalCostR: 0,
    realTotalCostR: 0,
    shadowTotalCostR: 0,

    totalExecutionCostR: 0,
    virtualTotalExecutionCostR: 0,
    realTotalExecutionCostR: 0,
    shadowTotalExecutionCostR: 0,

    totalFundingCostR: 0,
    virtualTotalFundingCostR: 0,
    realTotalFundingCostR: 0,
    shadowTotalFundingCostR: 0,

    grossWinR: 0,
    grossLossR: 0,

    virtualGrossWinR: 0,
    virtualGrossLossR: 0,
    realGrossWinR: 0,
    realGrossLossR: 0,
    shadowGrossWinR: 0,
    shadowGrossLossR: 0,

    avgR: 0,
    avgWinR: 0,
    avgLossR: 0,
    sampleAdjustedAvgR: 0,
    avgRScore: 0,

    avgPnlPct: 0,

    directSLCount: 0,
    nearTpCount: 0,
    reachedHalfRCount: 0,
    reachedOneRCount: 0,

    beWouldExitCount: 0,
    gaveBackAfterHalfRCount: 0,
    gaveBackAfterOneRCount: 0,
    nearTpThenLossCount: 0,

    avgCostR: 0,
    avgExecutionCostR: 0,
    avgFundingCostR: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,

    sampleRawWinrate: 0,
    sampleBayesianWinrate: 0,
    sampleWilsonLowerBound: 0,
    sampleReliabilityOld: 0,

    profitFactor: 0,
    profitFactorSource: 'NET_R_OUTCOMES',
    sampleReliability: 0,
    balancedScore: 0,
    dashboardBalancedScore: 0,

    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    costStatsInferredFromRecent: false,
    directSLStatsInferredFromRecent: false,
    profitFactorRepairedFromNetR: false,

    tradingEligible: false,
    eligible: false,
    eligibleGatePassed: false,
    eligibleReason: 'NO_OUTCOMES_YET',
    eligibleReasons: ['NO_OUTCOMES_YET'],
    eligibleMinCompleted: eligibleMinCompletedForLayer(learningLayer),
    eligibleMinAvgRLCB: eligibleMinAvgRLCB(),
    eligibleMaxDirectSLPct: eligibleMaxDirectSLPct(),
    eligibleMaxAvgCostR: eligibleMaxAvgCostR(),
    eligibleMinProfitFactor: eligibleMinProfitFactor(),

    lcbModelVersion: LCB_MODEL_VERSION,
    avgRLCBDefinition: 'avgR - z * (stdDevR / sqrt(completed))',
    avgRLCBUsesNetR: true,
    avgRLCBSource: 'netR',
    selectionUsesLCBAvgR: true,
    selectionAvoidsWeeklyWinnerCurse: true,

    marketWeatherStats: makeMarketWeatherStats(),
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherShrinkageVersion: MARKET_WEATHER_SHRINKAGE_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVeto: false,
    empiricalVetoReason: null,

    validShortRiskShape: 'entry > 0 && tp < entry && sl > entry',
    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: isMicroMicroLayer ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !isMicroMicroLayer,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: isMicroMicroLayer
      ? 'ANALYZE_MICRO_MICRO_FAMILY'
      : isMicro75Layer
        ? 'ANALYZE_TRUE_MICRO_FAMILY_CONTEXT_ONLY'
        : 'ANALYZE_PARENT_TRUE_MICRO_FAMILY_CONTEXT_ONLY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: !isMicroMicroLayer,

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
    microMicroMeasurementVersion: MICRO_MICRO_MEASUREMENT_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,

    defaultRanking: 'eligible|avgRLCB95|totalR|avgR|fairWinrate|directSLPct|avgCostR|profitFactor',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    rankingUsesAvgRLCB95: true,
    rankingUsesProfitFactor: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordCanSelectExactMicroMicro: isMicroMicroLayer,
    discordCanSelectExact75Child: false,
    discordParentMatchAllowed: false,
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,
    scannerMatchTriggersDiscord: false,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    learningStatus: 'OBSERVING',
    status: 'OBSERVING',
    awaitingOutcomes: true,
    tooEarly: true,
    minCompletedForActiveLearning: minCompleted,
    microMicroMinCompletedForActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    counters: makeCounters(),

    examples: [],
    recentOutcomes: [],

    createdAt: ts,
    updatedAt: ts
  };

  return ensureStatsShape(stats);
}

export function updateObservation(stats, row = {}) {
  ensureStatsShape(stats);

  if (!isShortRow({ ...stats, ...row })) {
    return stats;
  }

  if (!rowMatchesStatsIdentity(stats, row)) {
    return stats;
  }

  applySideIdentity(stats, row);

  const dedupeKey = observationDedupeKeyForStats(stats, row);

  if (observationIsDuplicate(stats, row, dedupeKey)) {
    stats.observationDuplicateSkippedCount = safeNumber(stats.observationDuplicateSkippedCount, 0) + 1;
    stats.observationDuplicateLastSkippedAt = now();
    stats.lastObservationDedupeKey = dedupeKey || stats.lastObservationDedupeKey || null;
    stats.observationRecorded = false;
    stats.observationDuplicate = true;
    stats.observationAlwaysCounted = false;
    stats.updatedAt = now();

    stats.learningStatus = learningStatus(stats);
    stats.status = stats.learningStatus;
    stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;
    stats.tooEarly = safeNumber(stats.completed, 0) < safeNumber(stats.minCompletedForActiveLearning, rowLayerMinCompleted(stats));

    return stats;
  }

  if (dedupeKey) {
    rememberObservationKey(stats, dedupeKey);
  }

  const learningId = rowMicroId(stats);
  const parsed = parseShortTaxonomyMicroId(learningId);
  const parentId = rowParentTrueMicroId(stats) || rowParentTrueMicroId(row) || null;
  const childId = rowChildTrueMicroId(stats) || rowChildTrueMicroId(row) || null;
  const microMicroId = rowMicroMicroId(stats) || rowMicroMicroId(row) || null;
  const learningLayer = rowLearningLayer(stats);
  const fit = normalizeCurrentFit(row.currentFit ?? row.entryCurrentFit ?? row.marketFit ?? '');
  const market = entryMarketWeatherFields(row);

  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;
  stats.observationRecorded = true;
  stats.observationDuplicate = false;
  stats.observationAlwaysCounted = false;

  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState ?? row.btcRelation);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);
  inc(stats.counters.microMicroFamilyId, microMicroId || 'NO_MICRO_MICRO');
  inc(stats.counters.learningLayer, learningLayer);
  inc(stats.counters.currentFit, fit);
  inc(stats.counters.entryMarketWeatherRegime, market.entryMarketWeatherRegime);
  inc(stats.counters.entryMarketWeatherTrendSide, market.entryMarketWeatherTrendSide);
  inc(stats.counters.entryMarketWeatherKey, market.entryMarketWeatherKey);

  if (stats.examples.length < 20) {
    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      source: row.source || SOURCE_VIRTUAL,

      learningLayer,
      learningFamilyId: learningId,
      learningMicroFamilyId: learningId,
      analyzeMicroFamilyId: learningId,

      microFamilyId: learningLayer === LAYER_MICRO_MICRO ? childId : learningId,
      trueMicroFamilyId: learningLayer === LAYER_PARENT_15 ? parentId : childId,
      childTrueMicroFamilyId: childId,
      base75ChildTrueMicroFamilyId: childId,
      baseTrueMicroFamilyId: childId,
      trueMicro75FamilyId: childId,

      microMicroFamilyId,
      trueMicroMicroFamilyId: microMicroId,
      exactMicroMicroFamilyId: microMicroId,

      parentTrueMicroFamilyId: parentId,
      coarseMicroFamilyId: parentId,

      setupType: row.setupType || stats.setupType || parsed.setupType || null,
      regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket || null,
      confirmationProfile: row.confirmationProfile || stats.confirmationProfile || parsed.confirmationProfile || null,

      ...market,

      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFingerprintRole: row.scannerFingerprintRole || 'METADATA_ONLY',

      executionMicroFamilyId: row.executionMicroFamilyId || null,
      executionFingerprintHash: row.executionFingerprintHash || null,
      executionFingerprintRole: learningLayer === LAYER_MICRO_MICRO ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
      executionFingerprintsUsedAsLearningFamily: false,
      executionFingerprintsCanDeriveMicroMicroContextHash: true,

      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      btcState: row.btcState || null,
      btcRelation: row.btcRelation || null,
      regime: row.regime || null,
      scannerReason: row.scannerReason || null,

      currentFit: fit,
      entryCurrentFit: row.entryCurrentFit ?? row.currentFit ?? null,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

      observationDedupeKey: dedupeKey || null,
      observationRecorded: true,
      observationDuplicate: false,
      observationAlwaysCounted: false,

      isMirrorMicroFamily: false,
      observationMirror: false,
      mirrorOfSide: null,

      trueMicroFamilySchema: stats.trueMicroFamilySchema,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
      learningGranularity: stats.learningGranularity,
      child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

      selectionGranularity: stats.selectionGranularity,
      manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
      parent15MatchTriggersDiscord: false,
      child75MatchTriggersDiscord: false,
      micro75MatchDoesNotTriggerDiscord: true,

      sampleDoesNotSplitParent: true,
      sampleDoesNotSplitMicro75: true,
      rollupStatsRequired: true,
      rollupParent15: parentId,
      rollupMicro75: childId,
      rollupMicroMicro: microMicroId,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      riskGeometryRule: 'SHORT: tp < entry < sl',
      tpHitRule: 'SHORT: price <= tp',
      slHitRule: 'SHORT: price >= sl',
      grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
      currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

      marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,

      ts: row.createdAt || row.ts || now()
    });
  }

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;
  stats.tooEarly = safeNumber(stats.completed, 0) < safeNumber(stats.minCompletedForActiveLearning, rowLayerMinCompleted(stats));

  stats.updatedAt = now();

  return stats;
}

export function updateOutcome(stats, row = {}, source = SOURCE_VIRTUAL) {
  ensureStatsShape(stats);

  if (!isShortRow({ ...stats, ...row })) {
    return refreshStats(stats);
  }

  if (!rowMatchesStatsIdentity(stats, row)) {
    return refreshStats(stats);
  }

  applySideIdentity(stats, row);

  if (outcomeIsDuplicate(row)) {
    stats.outcomeDuplicateSkippedCount = safeNumber(stats.outcomeDuplicateSkippedCount, 0) + 1;
    stats.outcomeDuplicateLastSkippedAt = now();
    stats.updatedAt = now();

    return refreshStats(stats);
  }

  const src = normalizeSource(source || row.source || SOURCE_VIRTUAL);

  if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
    return refreshStats(stats);
  }

  const weight = sourceWeight(src);
  const geometry = shortRiskGeometry(row);

  const exitR = outcomeExitR(row);
  const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
  const costR = inferCostR(row, exitR);
  const executionCostR = inferExecutionCostR(row, costR);
  const fundingCostR = inferFundingCostR(row);

  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (src === SOURCE_SHADOW) {
    stats.shadowCompleted += 1;
    stats.shadowTotalR += exitR;
    stats.shadowTotalPnlPct += pnlPct;
    stats.shadowTotalCostR += costR;
    stats.shadowTotalExecutionCostR += executionCostR;
    stats.shadowTotalFundingCostR += fundingCostR;
    stats.shadowSumR += exitR;
    stats.shadowSumSquaredR += exitR * exitR;

    if (win) {
      stats.shadowWins += 1;
      stats.shadowGrossWinR += exitR;
    }

    if (loss) {
      stats.shadowLosses += 1;
      stats.shadowGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.shadowFlats += 1;
  } else {
    stats.virtualCompleted += 1;
    stats.virtualTotalR += exitR;
    stats.virtualTotalPnlPct += pnlPct;
    stats.virtualTotalCostR += costR;
    stats.virtualTotalExecutionCostR += executionCostR;
    stats.virtualTotalFundingCostR += fundingCostR;
    stats.virtualSumR += exitR;
    stats.virtualSumSquaredR += exitR * exitR;

    if (win) {
      stats.virtualWins += 1;
      stats.virtualGrossWinR += exitR;
    }

    if (loss) {
      stats.virtualLosses += 1;
      stats.virtualGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.virtualFlats += 1;
  }

  stats.completed = closedCompletedCount(stats);

  stats.wins += win ? weight : 0;
  stats.losses += loss ? weight : 0;
  stats.flats += flat ? weight : 0;

  stats.totalR += exitR * weight;
  stats.totalPnlPct += pnlPct * weight;
  stats.totalCostR += costR * weight;
  stats.totalExecutionCostR += executionCostR * weight;
  stats.totalFundingCostR += fundingCostR * weight;
  stats.sumR += exitR * weight;
  stats.sumSquaredR += exitR * exitR * weight;

  if (win) stats.grossWinR += exitR * weight;
  if (loss) stats.grossLossR += Math.abs(exitR) * weight;

  const directSL = isDirectSL(row);

  if (directSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;

  if (row.beWouldExit) stats.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount += weight;

  addMarketWeatherOutcome(stats, row, src);

  const learningId = rowMicroId(stats);
  const parsed = parseShortTaxonomyMicroId(learningId);
  const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row) || stats.parentTrueMicroFamilyId || null;
  const childId = parsed.childTrueMicroFamilyId || rowChildTrueMicroId(row) || stats.childTrueMicroFamilyId || null;
  const microMicroId = parsed.microMicroFamilyId || rowMicroMicroId(row) || stats.microMicroFamilyId || null;
  const learningLayer = parsed.learningLayer || rowLearningLayer(stats);
  const fit = normalizeCurrentFit(row.entryCurrentFit ?? row.currentFit ?? row.marketFit ?? '');
  const market = entryMarketWeatherFields(row);

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    learningLayer,
    learningFamilyId: learningId,
    learningMicroFamilyId: learningId,
    analyzeMicroFamilyId: learningId,

    microFamilyId: learningLayer === LAYER_MICRO_MICRO ? childId : learningId,
    trueMicroFamilyId: learningLayer === LAYER_PARENT_15 ? parentId : childId,

    childTrueMicroFamilyId: childId,
    base75ChildTrueMicroFamilyId: childId,
    baseTrueMicroFamilyId: childId,
    trueMicro75FamilyId: childId,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,

    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,

    setupType: row.setupType || stats.setupType || parsed.setupType || null,
    regimeBucket: row.regimeBucket || stats.regimeBucket || parsed.regimeBucket || null,
    confirmationProfile: row.confirmationProfile || stats.confirmationProfile || parsed.confirmationProfile || null,

    ...market,

    exitReason: row.exitReason || row.reason || null,

    entry: geometry.entry || row.entry || row.entryPrice || null,
    exit: geometry.exitPrice || row.exit || row.exitPrice || null,
    exitPrice: geometry.exitPrice || row.exitPrice || row.exit || null,
    initialSl: geometry.initialSl || row.initialSl || row.sl || null,
    sl: geometry.sl || row.sl || null,
    tp: geometry.tp || row.tp || null,
    currentPrice: geometry.currentPrice || row.currentPrice || null,

    validShortRiskShape: geometry.validShortRiskShape,
    validShortGeometry: geometry.validShortGeometry,
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    shortTpHit: geometry.shortTpHit,
    shortSlHit: geometry.shortSlHit,

    exitR,
    netR: safeNumber(row.netR ?? row.shortNetR ?? exitR, exitR),
    shortNetR: safeNumber(row.shortNetR ?? row.netR ?? exitR, exitR),
    grossR: safeNumber(row.grossR ?? row.rawR ?? row.realizedGrossR ?? geometry.shortGrossR, exitR),
    shortGrossR: safeNumber(row.shortGrossR ?? geometry.shortGrossR ?? row.grossR, exitR),
    shortCurrentR: safeNumber(row.shortCurrentR ?? geometry.shortCurrentR, 0),

    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    pnlPct,
    netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
    grossPnlPct: safeNumber(row.grossPnlPct, 0),

    costR,
    avgCostR: costR,
    executionCostR,
    fundingCostR,
    costPct: safeNumber(row.costPct, 0),
    feePct: safeNumber(row.feePct, 0),
    slippagePct: safeNumber(row.slippagePct, 0),

    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    directToSL: directSL,
    directSL,
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),

    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),

    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),

    entryMarketWeather: row.entryMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide || null,
    entryCurrentFit: row.entryCurrentFit ?? row.currentFit ?? null,
    entryCurrentFitNormalized: fit,
    entryCurrentFitConfidence: firstFinite(row.entryCurrentFitConfidence, row.currentMarketFitConfidence),
    entryWeatherFitMatchedFamily: row.entryWeatherFitMatchedFamily ?? null,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    isMirrorMicroFamily: false,
    outcomeMirror: false,
    mirrorOfSide: null,

    trueMicroFamilySchema: stats.trueMicroFamilySchema,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: stats.learningGranularity,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity: stats.selectionGranularity,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,

    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    sampleDoesNotSplitParent: true,
    sampleDoesNotSplitMicro75: true,
    rollupStatsRequired: true,
    rollupParent15: parentId,
    rollupMicro75: childId,
    rollupMicroMicro: microMicroId,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,

    profitFactorSource: 'NET_R_OUTCOME',
    profitFactorFixVersion: MICRO_MICRO_MEASUREMENT_VERSION,

    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-50);
  stats.updatedAt = now();

  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
  const sample = safeNumber(completed, 0);
  const winCount = clamp(safeNumber(wins, 0), 0, sample);

  if (sample <= 0) return 0;

  const p = winCount / sample;
  const z2 = z * z;
  const denominator = 1 + z2 / sample;
  const centre = p + z2 / (2 * sample);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * sample)) / sample);

  return clamp((centre - margin) / denominator, 0, 1);
}

export function bayesianWinrate(wins, completed) {
  const sample = safeNumber(completed, 0);
  const winCount = safeNumber(wins, 0);

  const priorN = priorTrades();
  const priorW = priorN * priorWinrate();

  const denominator = sample + priorN;

  return denominator > 0
    ? clamp((winCount + priorW) / denominator, 0, 1)
    : 0;
}

function buildBalancedScore({
  fair,
  avgR,
  avgRLCB95,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR,
  sampleFallbackPenalty,
  eligibleBonus
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;

  const totalRComponent = Math.log1p(positive(totalR)) * 12;
  const avgRComponent = Math.log1p(positive(avgR)) * 8;
  const lcbComponent = positive(avgRLCB95) * 120;

  return (
    eligibleBonus +
    lcbComponent +
    fair * 100 +
    sampleRel * 25 +
    totalRComponent +
    avgRComponent +
    pfNorm * 12 +
    nearTpPct * 4 +
    reachedOneRPct * 4 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8 -
    sampleFallbackPenalty
  );
}

function buildAvgRScore({
  sampleAdjustedAvgRValue,
  avgRLCB95,
  fair,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR,
  sampleFallbackPenalty,
  eligibleBonus
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;
  const totalRComponent = Math.log1p(positive(totalR)) * 8;
  const lcbComponent = positive(avgRLCB95) * 140;

  return (
    eligibleBonus +
    lcbComponent +
    sampleAdjustedAvgRValue * 100 +
    fair * 35 +
    sampleRel * 25 +
    totalRComponent +
    pfNorm * 12 +
    nearTpPct * 3 +
    reachedOneRPct * 3 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8 -
    sampleFallbackPenalty
  );
}

function refreshStatsLite(stats = {}) {
  if (stats.__refreshingLite) return stats;
  return {
    ...stats,
    __refreshingLite: true
  };
}

export function refreshStats(stats) {
  ensureStatsShape(stats);

  const learningLayer = rowLearningLayer(stats);
  const minCompleted = minCompletedForLayer(learningLayer);

  const hasBuckets = hasSourceBuckets(stats);
  const sourceCounts = weightedSourceCounts(stats);
  const sourceTotals = weightedSourceTotals(stats);
  const recent = aggregateRecentOutcomes(stats);

  const actualCounts = actualOutcomeCounts(stats);

  const closedCompleted = hasBuckets
    ? closedCompletedCount(stats)
    : Math.max(
      safeNumber(stats.completed, 0),
      actualCounts.completed,
      recent.actualCompleted
    );

  const weightedCompletedForR = hasBuckets
    ? weightedCompletedCount(stats)
    : Math.max(
      safeNumber(stats.completed, 0),
      sourceCounts.completed,
      recent.completed
    );

  const weightedWins = hasBuckets
    ? sourceCounts.wins
    : Math.max(
      safeNumber(stats.wins, 0),
      recent.wins
    );

  const weightedLosses = hasBuckets
    ? sourceCounts.losses
    : Math.max(
      safeNumber(stats.losses, 0),
      recent.losses
    );

  const weightedFlats = hasBuckets
    ? sourceCounts.flats
    : Math.max(
      safeNumber(stats.flats, 0),
      recent.flats
    );

  const totalR = chooseTotal({
    sourceValue: sourceTotals.totalR,
    storedValue: stats.totalR,
    recentValue: recent.totalR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  const totalPnlPct = chooseTotal({
    sourceValue: sourceTotals.totalPnlPct,
    storedValue: stats.totalPnlPct,
    recentValue: recent.totalPnlPct,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  let totalCostR = chooseTotal({
    sourceValue: sourceTotals.totalCostR,
    storedValue: stats.totalCostR,
    recentValue: recent.totalCostR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  let totalExecutionCostR = chooseTotal({
    sourceValue: sourceTotals.totalExecutionCostR,
    storedValue: stats.totalExecutionCostR,
    recentValue: recent.totalExecutionCostR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  let totalFundingCostR = chooseTotal({
    sourceValue: sourceTotals.totalFundingCostR,
    storedValue: stats.totalFundingCostR,
    recentValue: recent.totalFundingCostR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  let costStatsInferredFromRecent = false;

  if (
    weightedCompletedForR > 0 &&
    totalCostR <= 0 &&
    recent.completed > 0 &&
    recent.totalCostR > 0
  ) {
    const recentAvgCostR = recent.totalCostR / recent.completed;
    totalCostR = recentAvgCostR * weightedCompletedForR;
    costStatsInferredFromRecent = true;
  }

  if (
    weightedCompletedForR > 0 &&
    totalExecutionCostR <= 0 &&
    recent.completed > 0 &&
    recent.totalExecutionCostR > 0
  ) {
    const recentAvgExecutionCostR = recent.totalExecutionCostR / recent.completed;
    totalExecutionCostR = recentAvgExecutionCostR * weightedCompletedForR;
  }

  if (
    weightedCompletedForR > 0 &&
    totalFundingCostR === 0 &&
    recent.completed > 0 &&
    recent.totalFundingCostR !== 0
  ) {
    const recentAvgFundingCostR = recent.totalFundingCostR / recent.completed;
    totalFundingCostR = recentAvgFundingCostR * weightedCompletedForR;
  }

  const pfComponents = repairProfitFactorComponents({
    grossWinR: sourceTotals.grossWinR,
    grossLossR: sourceTotals.grossLossR,
    totalR,
    weightedWins,
    weightedLosses,
    recentGrossWinR: recent.grossWinR,
    recentGrossLossR: recent.grossLossR,
    stats
  });

  const grossWinR = pfComponents.grossWinR;
  const grossLossR = pfComponents.grossLossR;
  const profitFactor = pfComponents.profitFactor;

  const sumR = chooseTotal({
    sourceValue: sourceTotals.sumR,
    storedValue: stats.sumR,
    recentValue: recent.sumR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  const sumSquaredR = chooseTotal({
    sourceValue: sourceTotals.sumSquaredR,
    storedValue: stats.sumSquaredR,
    recentValue: recent.sumSquaredR,
    sourceCompleted: sourceCounts.completed,
    storedCompleted: safeNumber(stats.completed, 0),
    recentCompleted: recent.completed
  });

  const winrateSample = safeNumber(actualCounts.completed, 0);
  const winrateWins = safeNumber(actualCounts.wins, 0);

  const rawWinrate = winrateSample > 0
    ? winrateWins / winrateSample
    : 0;

  const bayes = bayesianWinrate(winrateWins, winrateSample);
  const wilson = wilsonLowerBound(winrateWins, winrateSample);

  const fair = winrateSample > 0
    ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
    : 0;

  const reliability = sampleReliability(winrateSample);

  const avgR = weightedCompletedForR > 0
    ? totalR / weightedCompletedForR
    : 0;

  const varianceStats = varianceFromTotals({
    sumR: sumR || totalR,
    sumSquaredR,
    completed: weightedCompletedForR
  });

  const avgRLCB95 = avgRLowerConfidenceBound({
    avgR,
    stdDevR: varianceStats.stdDevR,
    completed: weightedCompletedForR,
    z: avgRLCBZ()
  });

  const avgPnlPct = weightedCompletedForR > 0
    ? totalPnlPct / weightedCompletedForR
    : 0;

  const avgWinR = weightedWins > 0
    ? grossWinR / weightedWins
    : 0;

  const avgLossR = weightedLosses > 0
    ? -grossLossR / weightedLosses
    : 0;

  const directSLCount = safeNumber(stats.directSLCount, 0) > 0
    ? safeNumber(stats.directSLCount, 0)
    : recent.directSLCount;

  const directSLStatsInferredFromRecent =
    safeNumber(stats.directSLCount, 0) <= 0 && recent.directSLCount > 0;

  const nearTpCount = safeNumber(stats.nearTpCount, 0) > 0
    ? safeNumber(stats.nearTpCount, 0)
    : recent.nearTpCount;

  const reachedHalfRCount = safeNumber(stats.reachedHalfRCount, 0) > 0
    ? safeNumber(stats.reachedHalfRCount, 0)
    : recent.reachedHalfRCount;

  const reachedOneRCount = safeNumber(stats.reachedOneRCount, 0) > 0
    ? safeNumber(stats.reachedOneRCount, 0)
    : recent.reachedOneRCount;

  const beWouldExitCount = safeNumber(stats.beWouldExitCount, 0) > 0
    ? safeNumber(stats.beWouldExitCount, 0)
    : recent.beWouldExitCount;

  const gaveBackAfterHalfRCount = safeNumber(stats.gaveBackAfterHalfRCount, 0) > 0
    ? safeNumber(stats.gaveBackAfterHalfRCount, 0)
    : recent.gaveBackAfterHalfRCount;

  const gaveBackAfterOneRCount = safeNumber(stats.gaveBackAfterOneRCount, 0) > 0
    ? safeNumber(stats.gaveBackAfterOneRCount, 0)
    : recent.gaveBackAfterOneRCount;

  const nearTpThenLossCount = safeNumber(stats.nearTpThenLossCount, 0) > 0
    ? safeNumber(stats.nearTpThenLossCount, 0)
    : recent.nearTpThenLossCount;

  const directSLPct = weightedCompletedForR > 0
    ? directSLCount / weightedCompletedForR
    : 0;

  const nearTpPct = weightedCompletedForR > 0
    ? nearTpCount / weightedCompletedForR
    : 0;

  const reachedHalfRPct = weightedCompletedForR > 0
    ? reachedHalfRCount / weightedCompletedForR
    : 0;

  const reachedOneRPct = weightedCompletedForR > 0
    ? reachedOneRCount / weightedCompletedForR
    : 0;

  const beWouldExitPct = weightedCompletedForR > 0
    ? beWouldExitCount / weightedCompletedForR
    : 0;

  const gaveBackAfterHalfRPct = weightedCompletedForR > 0
    ? gaveBackAfterHalfRCount / weightedCompletedForR
    : 0;

  const gaveBackAfterOneRPct = weightedCompletedForR > 0
    ? gaveBackAfterOneRCount / weightedCompletedForR
    : 0;

  const nearTpThenLossPct = weightedCompletedForR > 0
    ? nearTpThenLossCount / weightedCompletedForR
    : 0;

  const avgCostR = weightedCompletedForR > 0
    ? totalCostR / weightedCompletedForR
    : 0;

  const avgExecutionCostR = weightedCompletedForR > 0
    ? totalExecutionCostR / weightedCompletedForR
    : 0;

  const avgFundingCostR = weightedCompletedForR > 0
    ? totalFundingCostR / weightedCompletedForR
    : 0;

  const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);

  const microMicroSampleTooSmall =
    learningLayer === LAYER_MICRO_MICRO &&
    closedCompleted < MIN_COMPLETED_MICRO_MICRO_ACTIVE;

  const sampleFallbackPenalty = microMicroSampleTooSmall ? 6 : 0;

  const preEligible = eligibleGate({
    ...stats,
    completed: closedCompleted,
    totalR,
    avgR,
    avgRLCB95,
    directSLPct,
    avgCostR,
    profitFactor
  });

  const eligibleBonus = preEligible.eligible ? 25 : 0;

  const balancedScore = buildBalancedScore({
    fair,
    avgR,
    avgRLCB95,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR,
    sampleFallbackPenalty,
    eligibleBonus
  });

  const avgRScore = buildAvgRScore({
    sampleAdjustedAvgRValue,
    avgRLCB95,
    fair,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR,
    sampleFallbackPenalty,
    eligibleBonus
  });

  Object.assign(stats, {
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: stats.source || SOURCE_VIRTUAL,

    completed: round4(closedCompleted),
    winrateSample: round4(winrateSample),

    wins: round4(weightedWins),
    losses: round4(weightedLosses),
    flats: round4(weightedFlats),

    totalR: round4(totalR),
    totalPnlPct: round4(totalPnlPct),
    totalCostR: round4(totalCostR),
    totalExecutionCostR: round4(totalExecutionCostR),
    totalFundingCostR: round4(totalFundingCostR),

    sumR: round4(sumR || totalR),
    sumSquaredR: round4(sumSquaredR),

    varianceR: round6(varianceStats.varianceR),
    sampleVarianceR: round6(varianceStats.sampleVarianceR),
    stdDevR: round6(varianceStats.stdDevR),
    standardErrorAvgR: round6(varianceStats.standardErrorAvgR),
    avgRLCB95: round6(avgRLCB95),
    avgRLowerBound95: round6(avgRLCB95),
    lcb95AvgR: round6(avgRLCB95),
    avgRLCBZ: round4(avgRLCBZ()),

    virtualTotalR: round4(stats.virtualTotalR),
    realTotalR: 0,
    shadowTotalR: round4(stats.shadowTotalR),

    virtualSumR: round4(stats.virtualSumR),
    realSumR: 0,
    shadowSumR: round4(stats.shadowSumR),

    virtualSumSquaredR: round4(stats.virtualSumSquaredR),
    realSumSquaredR: 0,
    shadowSumSquaredR: round4(stats.shadowSumSquaredR),

    virtualTotalPnlPct: round4(stats.virtualTotalPnlPct),
    realTotalPnlPct: 0,
    shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),

    virtualTotalCostR: round4(stats.virtualTotalCostR),
    realTotalCostR: 0,
    shadowTotalCostR: round4(stats.shadowTotalCostR),

    virtualTotalExecutionCostR: round4(stats.virtualTotalExecutionCostR),
    realTotalExecutionCostR: 0,
    shadowTotalExecutionCostR: round4(stats.shadowTotalExecutionCostR),

    virtualTotalFundingCostR: round4(stats.virtualTotalFundingCostR),
    realTotalFundingCostR: 0,
    shadowTotalFundingCostR: round4(stats.shadowTotalFundingCostR),

    virtualGrossWinR: round4(stats.virtualGrossWinR),
    virtualGrossLossR: round4(stats.virtualGrossLossR),
    realGrossWinR: 0,
    realGrossLossR: 0,
    shadowGrossWinR: round4(stats.shadowGrossWinR),
    shadowGrossLossR: round4(stats.shadowGrossLossR),

    grossWinR: round4(grossWinR),
    grossLossR: round4(grossLossR),

    winrate: round4(rawWinrate),
    bayesianWinrate: round4(bayes),
    wilsonLowerBound: round4(wilson),
    fairWinrate: round4(fair),

    sampleRawWinrate: round4(rawWinrate),
    sampleBayesianWinrate: round4(bayes),
    sampleWilsonLowerBound: round4(wilson),
    sampleAdjustedWinrate: round4(fair),
    sampleReliabilityOld: round4(reliability),

    sampleReliability: round4(reliability),

    avgR: round4(avgR),
    avgPnlPct: round4(avgPnlPct),
    avgWinR: round4(avgWinR),
    avgLossR: round4(avgLossR),
    sampleAdjustedAvgR: round4(sampleAdjustedAvgRValue),
    avgRScore: round4(avgRScore),

    profitFactor: round4(profitFactor),
    profitFactorSource: 'NET_R_OUTCOMES',
    profitFactorFixVersion: MICRO_MICRO_MEASUREMENT_VERSION,
    profitFactorRepairedFromNetR: (
      round4(profitFactor) > 0 &&
      safeNumber(sourceTotals.grossWinR, 0) <= 0 &&
      safeNumber(sourceTotals.grossLossR, 0) <= 0
    ),

    directSLCount: round4(directSLCount),
    nearTpCount: round4(nearTpCount),
    reachedHalfRCount: round4(reachedHalfRCount),
    reachedOneRCount: round4(reachedOneRCount),

    beWouldExitCount: round4(beWouldExitCount),
    gaveBackAfterHalfRCount: round4(gaveBackAfterHalfRCount),
    gaveBackAfterOneRCount: round4(gaveBackAfterOneRCount),
    nearTpThenLossCount: round4(nearTpThenLossCount),

    directSLPct: round4(directSLPct),
    nearTpPct: round4(nearTpPct),
    reachedHalfRPct: round4(reachedHalfRPct),
    reachedOneRPct: round4(reachedOneRPct),

    beWouldExitPct: round4(beWouldExitPct),
    gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
    gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
    nearTpThenLossPct: round4(nearTpThenLossPct),

    avgCostR: round4(avgCostR),
    avgExecutionCostR: round4(avgExecutionCostR),
    avgFundingCostR: round4(avgFundingCostR),
    costStatsInferredFromRecent,
    directSLStatsInferredFromRecent,

    tradingEligible: preEligible.eligible,
    eligible: preEligible.eligible,
    eligibleGatePassed: preEligible.eligible,
    eligibleReason: preEligible.eligible ? 'ELIGIBLE_LCB_AVGR_POSITIVE_MICRO_MICRO' : preEligible.reasons[0] || 'NOT_ELIGIBLE',
    eligibleReasons: preEligible.reasons,
    eligibleChecks: preEligible.checks,
    eligibleMinCompleted: preEligible.minCompleted,
    eligibleMinAvgRLCB: preEligible.minAvgRLCB,
    eligibleMaxDirectSLPct: preEligible.maxDirectSLPct,
    eligibleMaxAvgCostR: preEligible.maxAvgCostR,
    eligibleMinProfitFactor: preEligible.minProfitFactor,
    eligibleGateVersion: preEligible.gateVersion,

    empiricalVeto: preEligible.empiricalVeto,
    empiricalVetoGate: preEligible.empiricalVetoGate,
    empiricalVetoReason: preEligible.empiricalVetoGate?.empiricalVetoReason || null,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    policyBlocked: preEligible.policyBlocked,
    policyBlockedGate: preEligible.policyBlockedGate,

    balancedScore: round4(balancedScore),
    dashboardBalancedScore: round4(balancedScore),

    realCompleted: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: learningLayer === LAYER_MICRO_MICRO ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: learningLayer !== LAYER_MICRO_MICRO,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: learningLayer === LAYER_MICRO_MICRO
      ? 'ANALYZE_MICRO_MICRO_FAMILY'
      : learningLayer === LAYER_MICRO_75
        ? 'ANALYZE_TRUE_MICRO_FAMILY_CONTEXT_ONLY'
        : 'ANALYZE_PARENT_TRUE_MICRO_FAMILY_CONTEXT_ONLY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: learningLayer !== LAYER_MICRO_MICRO,

    trueMicroOnly: learningLayer !== LAYER_PARENT_15,
    exactTrueMicroOnly: learningLayer !== LAYER_PARENT_15,
    exactTrueMicroFamilyRequired: learningLayer !== LAYER_PARENT_15,

    trueMicroFamilySchema: learningLayer === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microFamilySchema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : learningLayer === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    schema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : learningLayer === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,

    learningGranularity: learningLayer === LAYER_MICRO_MICRO
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : learningLayer === LAYER_PARENT_15
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer,
    learningHierarchy: 'PARENT_15_TO_MICRO_75_TO_MICRO_MICRO',

    selectionGranularity: learningLayer === LAYER_MICRO_MICRO
      ? SELECTION_EXACT_MICRO_MICRO
      : learningLayer === LAYER_MICRO_75
        ? SELECTION_75_CHILD_CONTEXT
        : SELECTION_PARENT_CONTEXT,

    parentSelectionAllowed: false,
    micro75SelectionAllowed: false,
    microMicroSelectionAllowed: learningLayer === LAYER_MICRO_MICRO,

    selectableChild: false,
    selectableMicroMicro: learningLayer === LAYER_MICRO_MICRO,
    selectable: learningLayer === LAYER_MICRO_MICRO,

    sampleFallbackAllowed: learningLayer === LAYER_MICRO_MICRO,
    sampleFallbackLayer: learningLayer === LAYER_MICRO_MICRO ? LAYER_MICRO_75 : learningLayer === LAYER_MICRO_75 ? LAYER_PARENT_15 : null,
    sampleFallbackId: learningLayer === LAYER_MICRO_MICRO ? stats.childTrueMicroFamilyId : learningLayer === LAYER_MICRO_75 ? stats.parentTrueMicroFamilyId : null,
    sampleDoesNotSplitParent: true,
    sampleDoesNotSplitMicro75: true,
    microMicroSampleTooSmall,
    microMicroSampleStatus: learningLayer === LAYER_MICRO_MICRO
      ? microMicroSampleTooSmall
        ? 'USE_MICRO_75_FALLBACK_FOR_CONFIDENCE'
        : 'MICRO_MICRO_ACTIVE_SAMPLE'
      : null,

    rollupStatsRequired: true,
    rollupParent15: stats.parentTrueMicroFamilyId || null,
    rollupMicro75: stats.childTrueMicroFamilyId || null,
    rollupMicroMicro: stats.microMicroFamilyId || null,
    rollupUpdatePolicy: 'COUNT_THIS_LAYER_AND_PARENT_LAYERS_SEPARATELY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    lcbModelVersion: LCB_MODEL_VERSION,
    avgRLCBDefinition: 'avgR - z * (stdDevR / sqrt(completed))',
    avgRLCBUsesNetR: true,
    avgRLCBSource: 'netR',
    selectionUsesLCBAvgR: true,
    selectionAvoidsWeeklyWinnerCurse: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    microMicroMeasurementVersion: MICRO_MICRO_MEASUREMENT_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    observationAlwaysCounted: false,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherShrinkageVersion: MARKET_WEATHER_SHRINKAGE_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    defaultRanking: 'eligible|avgRLCB95|totalR|avgR|fairWinrate|directSLPct|avgCostR|profitFactor',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    rankingUsesAvgRLCB95: true,
    rankingUsesProfitFactor: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordCanSelectExactMicroMicro: learningLayer === LAYER_MICRO_MICRO,
    discordCanSelectExact75Child: false,
    discordParentMatchAllowed: false,
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,
    scannerMatchTriggersDiscord: false,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    validShortRiskShape: 'entry > 0 && tp < entry && sl > entry',
    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    tooEarly: closedCompleted < minCompleted,
    minCompletedForActiveLearning: minCompleted,
    microMicroMinCompletedForActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    updatedAt: now()
  });

  refreshMarketWeatherStats(stats);
  applySideIdentity(stats);

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;

  return stats;
}

export function normalizeDashboardMicro(row = {}, rank = null) {
  const stats = refreshStats({ ...row });

  const normalized = {
    ...stats,

    sampleRawWinrate: stats.winrate,
    sampleBayesianWinrate: stats.bayesianWinrate,
    sampleWilsonLowerBound: stats.wilsonLowerBound,
    sampleAdjustedWinrate: stats.fairWinrate,
    sampleReliabilityOld: stats.sampleReliability,

    dashboardBalancedScore: stats.balancedScore,

    tooEarly: safeNumber(stats.completed, 0) < safeNumber(stats.minCompletedForActiveLearning, rowLayerMinCompleted(stats)),
    minCompletedForActiveLearning: safeNumber(stats.minCompletedForActiveLearning, rowLayerMinCompleted(stats))
  };

  applySideIdentity(normalized);

  if (rank !== null && rank !== undefined) {
    normalized.rank = rank;
  }

  return normalized;
}

export function normalizeDashboardSummary(summary = {}) {
  const out = { ...summary };

  for (const key of ['bestBalanced', 'bestTotalR', 'bestWinrate', 'lowestDirectSL']) {
    if (out[key] && typeof out[key] === 'object' && isRealAnalyzeMicroRow(out[key])) {
      out[key] = normalizeDashboardMicro(out[key]);
    } else {
      out[key] = null;
    }
  }

  return out;
}

function sortById(a, b) {
  return String(a.learningMicroFamilyId || a.microMicroFamilyId || a.microFamilyId || '').localeCompare(
    String(b.learningMicroFamilyId || b.microMicroFamilyId || b.microFamilyId || '')
  );
}

function compareEligibility(a, b) {
  return (
    Number(b.tradingEligible === true || b.eligible === true) -
      Number(a.tradingEligible === true || a.eligible === true) ||
    safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0)
  );
}

function compareWinrate(a, b) {
  return (
    compareEligibility(a, b) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0) ||
    safeNumber(b.bayesianWinrate, 0) - safeNumber(a.bayesianWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function compareAvgR(a, b) {
  return (
    compareEligibility(a, b) ||
    safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
    safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
    safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function compareTotalR(a, b) {
  return (
    compareEligibility(a, b) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    sortById(a, b)
  );
}

function compareBalanced(a, b) {
  return (
    compareEligibility(a, b) ||
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
    safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    compareWinrate(a, b)
  );
}

function compareCurrentMarket(a, b) {
  return (
    signalTypeRank(a.signalType) - signalTypeRank(b.signalType) ||
    safeNumber(b.shrunkLCB95AvgR, 0) - safeNumber(a.shrunkLCB95AvgR, 0) ||
    safeNumber(b.shrunkAvgR, 0) - safeNumber(a.shrunkAvgR, 0) ||
    safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
    safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function signalTypeRank(signalType) {
  const type = upper(signalType);

  if (type === SIGNAL_TYPE_TRADE_READY) return 0;
  if (type === SIGNAL_TYPE_WATCH_ONLY) return 1;
  if (type === SIGNAL_TYPE_OBSERVE_ONLY) return 2;
  if (type === SIGNAL_TYPE_BLOCKED) return 3;

  return 4;
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const safeMode = mode === 'winrate'
    ? 'balanced'
    : String(mode || 'balanced');

  const rows = Object.values(micros || {})
    .filter(Boolean)
    .filter(isRealAnalyzeMicroRow)
    .map((row) => refreshStats({ ...row }))
    .filter((row) => row.tradeSide === TARGET_TRADE_SIDE)
    .filter((row) => validLearningId(row.learningMicroFamilyId || row.microMicroFamilyId))
    .filter((row) => isSelectableShortMicroMicroFamilyId(row.learningMicroFamilyId || row.microMicroFamilyId));

  const sorted = [...rows].sort((a, b) => {
    if (safeMode === 'currentMarket' || safeMode === 'market' || safeMode === 'best') {
      return compareCurrentMarket(a, b);
    }

    if (safeMode === 'totalR') {
      return compareTotalR(a, b);
    }

    if (safeMode === 'avgR') {
      return compareAvgR(a, b);
    }

    if (safeMode === 'directSL') {
      return (
        compareEligibility(a, b) ||
        safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
        safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
        safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
        safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
        safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
        sortById(a, b)
      );
    }

    if (safeMode === 'observed') {
      return (
        compareEligibility(a, b) ||
        safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
        safeNumber(b.observations, 0) - safeNumber(a.observations, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
        safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
        safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
        sortById(a, b)
      );
    }

    if (safeMode === 'microMicro') {
      return (
        Number(rowLearningLayer(b) === LAYER_MICRO_MICRO) - Number(rowLearningLayer(a) === LAYER_MICRO_MICRO) ||
        compareBalanced(a, b)
      );
    }

    if (safeMode === 'eligible') {
      return (
        compareEligibility(a, b) ||
        safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
        safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
        safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
        sortById(a, b)
      );
    }

    return compareBalanced(a, b);
  });

  return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}

export function isEligibleTradingCandidate(row = {}, options = {}) {
  return eligibleGate(refreshStats({ ...row }), options);
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * abs);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs);

  return 0.5 * (1 + sign * erf);
}

function oneSidedPositivePValue(mean, se) {
  const m = safeNumber(mean, 0);
  const s = Math.max(0, safeNumber(se, 0));

  if (s <= 0) return m > 0 ? 0.001 : 1;

  const z = m / s;
  return clamp(1 - normalCdf(z), 0.000001, 1);
}

function benjaminiHochberg(candidates = [], q = marketWeatherFdrQ()) {
  const rows = candidates
    .map((row, index) => ({
      index,
      pValue: clamp(safeNumber(row.pValue, 1), 0.000001, 1)
    }))
    .sort((a, b) => a.pValue - b.pValue);

  const m = Math.max(1, rows.length);
  let maxAcceptedRank = -1;

  rows.forEach((row, i) => {
    const threshold = ((i + 1) / m) * q;
    if (row.pValue <= threshold) {
      maxAcceptedRank = i;
    }
  });

  const accepted = new Set(
    rows.slice(0, maxAcceptedRank + 1).map((row) => row.index)
  );

  return candidates.map((row, index) => ({
    ...row,
    fdrVersion: MARKET_WEATHER_FDR_VERSION,
    fdrScope: 'FINAL_PLAYBOOK_SLOTS_ONLY',
    fdrQ: q,
    fdrPValue: clamp(safeNumber(row.pValue, 1), 0.000001, 1),
    fdrPassed: accepted.has(index),
    fdrObserveOnly: true
  }));
}

function statLevelFromAccumulator({
  stats,
  layer,
  familyResolution,
  marketResolution,
  proofSource,
  key = null
} = {}) {
  if (!stats) return null;

  const accumulator = marketWeatherAccumulatorFor(stats, marketResolution, key);
  if (!accumulator) return null;

  const completed = safeNumber(accumulator.completed, 0);
  const totalR = safeNumber(accumulator.totalR, 0);
  const avgR = completed > 0
    ? safeNumber(accumulator.avgR, totalR / completed)
    : 0;

  const stdDevR = safeNumber(accumulator.stdDevR, 0);
  const se = safeNumber(
    accumulator.standardErrorAvgR,
    completed > 1 ? stdDevR / Math.sqrt(completed) : 0
  );

  return {
    id: rowMicroId(stats),
    layer,
    familyResolution,
    marketResolution,
    proofSource,
    key,
    completed,
    avgR,
    totalR,
    stdDevR,
    standardErrorAvgR: se,
    varianceOfMean: se * se,
    avgRLCB95: safeNumber(accumulator.avgRLCB95 ?? accumulator.lcb95AvgR, 0),
    profitFactor: safeNumber(accumulator.profitFactor, 0),
    directSLPct: safeNumber(accumulator.directSLPct, 0),
    avgCostR: safeNumber(accumulator.avgCostR, 0),
    sourceStats: accumulator
  };
}

function shrinkLevelTowardParent(level = null, parent = null, k = shrinkageK()) {
  if (!parent && !level) {
    return {
      exists: false,
      completed: 0,
      shrunkAvgR: 0,
      shrunkVarianceOfMean: 0,
      shrunkStdError: 0,
      shrunkLCB95AvgR: 0,
      shrinkageWeight: 0,
      proofSource: 'NO_PROOF',
      proofChain: []
    };
  }

  if (!level || safeNumber(level.completed, 0) <= 0) {
    return {
      ...parent,
      inheritedOnly: true,
      proofChain: parent?.proofChain || []
    };
  }

  if (!parent || parent.exists === false) {
    const se = Math.max(0, safeNumber(level.standardErrorAvgR, 0));
    const lcb = level.avgR - avgRLCBZ() * se;

    return {
      exists: true,
      completed: level.completed,
      shrunkAvgR: round6(level.avgR),
      shrunkVarianceOfMean: round6(se * se),
      shrunkStdError: round6(se),
      shrunkLCB95AvgR: round6(lcb),
      shrinkageWeight: 1,
      proofSource: level.proofSource,
      familyResolution: level.familyResolution,
      marketResolution: level.marketResolution,
      directSLPct: level.directSLPct,
      avgCostR: level.avgCostR,
      profitFactor: level.profitFactor,
      totalR: level.totalR,
      proofChain: [{
        ...level,
        shrinkageWeight: 1,
        parentProofSource: null,
        shrunkAvgR: round6(level.avgR),
        shrunkLCB95AvgR: round6(lcb)
      }]
    };
  }

  const n = safeNumber(level.completed, 0);
  const weight = n / (n + Math.max(1, safeNumber(k, DEFAULT_SHRINKAGE_K)));

  const cellMean = safeNumber(level.avgR, 0);
  const parentMean = safeNumber(parent.shrunkAvgR, 0);

  const cellVar = Math.max(0, safeNumber(level.varianceOfMean, 0));
  const parentVar = Math.max(0, safeNumber(parent.shrunkVarianceOfMean, 0));
  const disagreementPenalty = weight * (1 - weight) * Math.pow(cellMean - parentMean, 2);

  const mean = weight * cellMean + (1 - weight) * parentMean;

  const variance =
    weight * weight * cellVar +
    (1 - weight) * (1 - weight) * parentVar +
    disagreementPenalty;

  const se = Math.sqrt(Math.max(0, variance));
  const lcb = mean - avgRLCBZ() * se;

  return {
    exists: true,
    completed: round4(n + safeNumber(parent.completed, 0)),
    cellCompleted: n,
    parentCompleted: parent.completed,
    shrunkAvgR: round6(mean),
    shrunkVarianceOfMean: round6(variance),
    shrunkStdError: round6(se),
    shrunkLCB95AvgR: round6(lcb),
    shrinkageWeight: round6(weight),
    disagreementPenalty: round6(disagreementPenalty),
    disagreementPenaltyIsHeuristic: true,
    proofSource: level.proofSource,
    familyResolution: level.familyResolution,
    marketResolution: level.marketResolution,
    directSLPct: level.directSLPct,
    avgCostR: level.avgCostR,
    profitFactor: level.profitFactor,
    totalR: level.totalR,
    parentProofSource: parent.proofSource,
    proofChain: [
      {
        ...level,
        shrinkageWeight: round6(weight),
        parentProofSource: parent.proofSource,
        parentMean,
        cellMean,
        disagreementPenalty: round6(disagreementPenalty),
        shrunkAvgR: round6(mean),
        shrunkLCB95AvgR: round6(lcb)
      },
      ...(Array.isArray(parent.proofChain) ? parent.proofChain : [])
    ]
  };
}

function recursiveShrinkage(levelsFinestToCoarsest = []) {
  const levels = levelsFinestToCoarsest.filter(Boolean);
  let posterior = null;

  for (const level of [...levels].reverse()) {
    posterior = shrinkLevelTowardParent(level, posterior);
  }

  return {
    version: MARKET_WEATHER_SHRINKAGE_VERSION,
    recursive: true,
    parentMeanRule: 'parentMean = already-shrunk result from next coarser level',
    finestToCoarsest: levels.map((level) => level.proofSource),
    ...(posterior || shrinkLevelTowardParent(null, null))
  };
}

function buildStatsLookup(micros = {}) {
  const byId = new Map();

  for (const raw of Object.values(micros || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const row = refreshStats({ ...raw });
    const id = rowMicroId(row);

    if (!id) continue;

    byId.set(id, row);

    const child = rowChildTrueMicroId(row);
    const parent = rowParentTrueMicroId(row);
    const mm = rowMicroMicroId(row);

    if (child && !byId.has(child)) byId.set(child, row);
    if (parent && !byId.has(parent)) byId.set(parent, row);
    if (mm && !byId.has(mm)) byId.set(mm, row);
  }

  return byId;
}

function currentMarketContextFromOptions(options = {}) {
  const regime = normalizeMarketWeatherRegime(firstValue(
    options.entryMarketWeatherRegime,
    options.currentMarketWeatherRegime,
    options.currentRegime,
    options.marketRegime,
    options.regime
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstValue(
    options.entryMarketWeatherTrendSide,
    options.currentMarketWeatherTrendSide,
    options.currentTrendSide,
    options.marketTrendSide,
    options.trendSide
  ));

  const key = firstValue(
    options.entryMarketWeatherKey,
    options.currentMarketWeatherKey,
    options.marketWeatherKey,
    buildMarketWeatherKeyV1({ regime, trendSide })
  );

  return {
    currentMarketWeatherKey: key,
    currentMarketWeatherRegime: regime,
    currentMarketWeatherTrendSide: trendSide,
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION
  };
}

function proofTierFromPosterior(posterior = {}, row = {}) {
  const proof = upper(posterior.proofSource);
  const lcb = safeNumber(posterior.shrunkLCB95AvgR, 0);
  const completed = safeNumber(row.completed, 0);

  if (row.policyBlocked) return PROOF_TIER_POLICY_BLOCKED;
  if (row.empiricalVeto) return PROOF_TIER_EMPIRICAL_VETO;

  if (lcb <= 0) return PROOF_TIER_OBSERVATION_ONLY;

  if (proof.includes('MICRO_MICRO') && proof.includes('REGIME')) return PROOF_TIER_MICRO_MICRO_MARKET;
  if (proof.includes('MICRO_MICRO') && completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return PROOF_TIER_MICRO_MICRO_LIFETIME;
  if (proof.includes('CHILD_75') && proof.includes('REGIME')) return PROOF_TIER_CHILD_75_MARKET;
  if (proof.includes('CHILD_75')) return PROOF_TIER_CHILD_75_LIFETIME;
  if (proof.includes('PARENT_15') && proof.includes('REGIME')) return PROOF_TIER_PARENT_15_MARKET;
  if (proof.includes('PARENT_15')) return PROOF_TIER_PARENT_15_LIFETIME;

  return PROOF_TIER_OBSERVATION_ONLY;
}

function signalTypeFromProof({ row = {}, posterior = {}, fdrPassed = false, requireFdr = false } = {}) {
  if (row.policyBlocked || row.empiricalVeto) return SIGNAL_TYPE_BLOCKED;

  const lcb = safeNumber(posterior.shrunkLCB95AvgR, 0);
  const proofTier = proofTierFromPosterior(posterior, row);

  if (lcb <= 0) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (requireFdr && !fdrPassed) return SIGNAL_TYPE_WATCH_ONLY;

  if (
    proofTier === PROOF_TIER_MICRO_MICRO_MARKET ||
    proofTier === PROOF_TIER_MICRO_MICRO_LIFETIME
  ) {
    return SIGNAL_TYPE_TRADE_READY;
  }

  if (
    proofTier === PROOF_TIER_CHILD_75_MARKET ||
    proofTier === PROOF_TIER_CHILD_75_LIFETIME ||
    proofTier === PROOF_TIER_PARENT_15_MARKET ||
    proofTier === PROOF_TIER_PARENT_15_LIFETIME
  ) {
    return SIGNAL_TYPE_WATCH_ONLY;
  }

  return SIGNAL_TYPE_OBSERVE_ONLY;
}

function maxAllowedRiskBandFromSignalType(signalType) {
  const type = upper(signalType);

  if (type === SIGNAL_TYPE_TRADE_READY) return MAX_ALLOWED_RISK_BAND_HIGH;
  if (type === SIGNAL_TYPE_WATCH_ONLY) return MAX_ALLOWED_RISK_BAND_LOW;

  return MAX_ALLOWED_RISK_BAND_ZERO;
}

function buildCurrentMarketProof(row = {}, lookup = new Map(), options = {}) {
  const stats = refreshStats({ ...row });
  const market = currentMarketContextFromOptions(options);

  const mmId = rowMicroMicroId(stats);
  const childId = rowChildTrueMicroId(stats);
  const parentId = rowParentTrueMicroId(stats);

  const mm = lookup.get(mmId) || stats;
  const child = lookup.get(childId) || null;
  const parent = lookup.get(parentId) || null;

  const regimeKey = market.currentMarketWeatherRegime;
  const regimeTrendKey = market.currentMarketWeatherKey;

  const levels = [
    statLevelFromAccumulator({
      stats: mm,
      layer: LAYER_MICRO_MICRO,
      familyResolution: LAYER_MICRO_MICRO,
      marketResolution: 'REGIME_TREND',
      proofSource: 'MICRO_MICRO_REGIME_TREND',
      key: regimeTrendKey
    }),
    statLevelFromAccumulator({
      stats: mm,
      layer: LAYER_MICRO_MICRO,
      familyResolution: LAYER_MICRO_MICRO,
      marketResolution: 'REGIME',
      proofSource: 'MICRO_MICRO_REGIME',
      key: regimeKey
    }),
    statLevelFromAccumulator({
      stats: mm,
      layer: LAYER_MICRO_MICRO,
      familyResolution: LAYER_MICRO_MICRO,
      marketResolution: 'LIFETIME',
      proofSource: 'MICRO_MICRO_LIFETIME'
    }),
    child ? statLevelFromAccumulator({
      stats: child,
      layer: LAYER_MICRO_75,
      familyResolution: LAYER_MICRO_75,
      marketResolution: 'REGIME_TREND',
      proofSource: 'CHILD_75_REGIME_TREND',
      key: regimeTrendKey
    }) : null,
    child ? statLevelFromAccumulator({
      stats: child,
      layer: LAYER_MICRO_75,
      familyResolution: LAYER_MICRO_75,
      marketResolution: 'REGIME',
      proofSource: 'CHILD_75_REGIME',
      key: regimeKey
    }) : null,
    child ? statLevelFromAccumulator({
      stats: child,
      layer: LAYER_MICRO_75,
      familyResolution: LAYER_MICRO_75,
      marketResolution: 'LIFETIME',
      proofSource: 'CHILD_75_LIFETIME'
    }) : null,
    parent ? statLevelFromAccumulator({
      stats: parent,
      layer: LAYER_PARENT_15,
      familyResolution: LAYER_PARENT_15,
      marketResolution: 'REGIME_TREND',
      proofSource: 'PARENT_15_REGIME_TREND',
      key: regimeTrendKey
    }) : null,
    parent ? statLevelFromAccumulator({
      stats: parent,
      layer: LAYER_PARENT_15,
      familyResolution: LAYER_PARENT_15,
      marketResolution: 'REGIME',
      proofSource: 'PARENT_15_REGIME',
      key: regimeKey
    }) : null,
    parent ? statLevelFromAccumulator({
      stats: parent,
      layer: LAYER_PARENT_15,
      familyResolution: LAYER_PARENT_15,
      marketResolution: 'LIFETIME',
      proofSource: 'PARENT_15_LIFETIME'
    }) : null
  ];

  const policy = policyBlockedGate(stats);
  const veto = empiricalVetoGate(stats);
  const posterior = recursiveShrinkage(levels);

  const baseCandidate = {
    ...stats,
    ...market,

    selectedFamilyId: mmId || rowMicroId(stats),
    selectedMicroMicroFamilyId: mmId || null,
    selectedChildTrueMicroFamilyId: childId || null,
    selectedParentTrueMicroFamilyId: parentId || null,

    policyBlocked: policy.blocked,
    policyBlockedReason: policy.reason,
    policyBlockedGate: policy,

    empiricalVeto: veto.triggered,
    empiricalVetoReason: veto.empiricalVetoReason,
    empiricalVetoGate: veto,

    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherShrinkageVersion: MARKET_WEATHER_SHRINKAGE_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),

    shrinkage: posterior,
    shrunkAvgR: posterior.shrunkAvgR,
    shrunkLCB95AvgR: posterior.shrunkLCB95AvgR,
    shrunkStdError: posterior.shrunkStdError,
    proofSource: posterior.proofSource,
    proofChain: posterior.proofChain,
    familyResolution: posterior.familyResolution || LAYER_MICRO_MICRO,
    marketResolution: posterior.marketResolution || 'LIFETIME',
    recursiveShrinkageParentMeanRule: posterior.parentMeanRule,

    pValue: oneSidedPositivePValue(posterior.shrunkAvgR, posterior.shrunkStdError)
  };

  const proofTier = proofTierFromPosterior(posterior, baseCandidate);
  const signalType = signalTypeFromProof({
    row: baseCandidate,
    posterior,
    fdrPassed: false,
    requireFdr: false
  });

  return {
    ...baseCandidate,
    proofTier,
    signalType,
    maxAllowedRiskBand: maxAllowedRiskBandFromSignalType(signalType),
    riskSourceOfTruth: 'riskFractionForEntry',
    selectorObserveOnly: true,
    reason: reasonForMarketCandidate({
      row: baseCandidate,
      posterior,
      proofTier,
      signalType
    })
  };
}

function reasonForMarketCandidate({ row = {}, posterior = {}, proofTier = '', signalType = '' } = {}) {
  if (row.policyBlocked) return row.policyBlockedReason || 'POLICY_BLOCKED';
  if (row.empiricalVeto) return row.empiricalVetoReason || 'EXACT_MICRO_MICRO_LCB95_NEGATIVE';
  if (safeNumber(posterior.shrunkLCB95AvgR, 0) <= 0) return 'BEST_CURRENT_MARKET_OBSERVATION_BUT_NO_POSITIVE_SHRUNK_LCB95';
  if (signalType === SIGNAL_TYPE_TRADE_READY) return 'CURRENT_MARKET_EDGE_CONFIRMED_OBSERVE_MODE';
  if (signalType === SIGNAL_TYPE_WATCH_ONLY) return `CURRENT_MARKET_EDGE_FALLBACK_${proofTier}`;
  return 'OBSERVE_ONLY_CURRENT_MARKET_CANDIDATE';
}

function applyFdrToCandidates(candidates = [], options = {}) {
  const q = clamp(
    safeNumber(options.fdrQ, marketWeatherFdrQ()),
    0.001,
    0.5
  );

  const tested = candidates.map((row) => ({
    ...row,
    pValue: clamp(safeNumber(row.pValue, 1), 0.000001, 1)
  }));

  const withFdr = benjaminiHochberg(tested, q);

  return withFdr.map((row) => {
    const signalType = signalTypeFromProof({
      row,
      posterior: row.shrinkage,
      fdrPassed: row.fdrPassed,
      requireFdr: options.requireFdrForTradeReady === true
    });

    return {
      ...row,
      signalType,
      proofTier: proofTierFromPosterior(row.shrinkage, row),
      maxAllowedRiskBand: maxAllowedRiskBandFromSignalType(signalType),
      fdrObserveOnly: true,
      reason: reasonForMarketCandidate({
        row,
        posterior: row.shrinkage,
        proofTier: proofTierFromPosterior(row.shrinkage, row),
        signalType
      })
    };
  });
}

export function getWeeklyTradingCandidates(micros = {}, options = {}) {
  const requireCurrentFitMatch = options.requireCurrentFitMatch !== false;
  const lookup = buildStatsLookup(micros);

  const baseRows = Object.values(micros || {})
    .filter(Boolean)
    .filter(isRealAnalyzeMicroRow)
    .map((row) => refreshStats({ ...row }))
    .filter((row) => rowLearningLayer(row) === LAYER_MICRO_MICRO)
    .map((row) => {
      const gate = eligibleGate(row, {
        ...options,
        requireCurrentFitMatch
      });

      const marketCandidate = buildCurrentMarketProof(row, lookup, options);

      return {
        ...marketCandidate,

        tradingEligible: gate.eligible && marketCandidate.signalType === SIGNAL_TYPE_TRADE_READY,
        eligible: gate.eligible,
        eligibleGatePassed: gate.eligible,
        eligibleReason: gate.eligible ? 'ELIGIBLE_LCB_AVGR_CURRENT_FIT_MICRO_MICRO' : gate.reasons[0] || 'NOT_ELIGIBLE',
        eligibleReasons: gate.reasons,
        eligibleChecks: gate.checks,
        currentFitMatched: gate.currentFitMatched,
        eligibleGateVersion: gate.gateVersion,

        selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
        manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
        discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
        parent15MatchTriggersDiscord: false,
        child75MatchTriggersDiscord: false,
        micro75MatchDoesNotTriggerDiscord: true,

        alwaysReturnsBestCandidate: true,
        alwaysReturnsBestCandidateDoesNotMeanAlwaysTrade: true
      };
    });

  const fdrRows = applyFdrToCandidates(baseRows, options);

  const sorted = fdrRows
    .sort((a, b) => (
      compareCurrentMarket(a, b) ||
      safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
      safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
      safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
      safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
      safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
      safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
      sortById(a, b)
    ));

  const hardTradeReadyOnly = options.hardTradeReadyOnly === true;

  return sorted
    .filter((row) => hardTradeReadyOnly ? row.signalType === SIGNAL_TYPE_TRADE_READY : true)
    .map((row, index) => normalizeDashboardMicro({
      ...row,
      rank: index + 1
    }, index + 1));
}

export function getLearningLayerIds(row = {}) {
  const childId = rowChildTrueMicroId(row);
  const parentId = rowParentTrueMicroId(row);
  const microMicroId = rowMicroMicroId(row);

  return {
    parentTrueMicroFamilyId: parentId || null,
    trueMicroFamilyId: childId || null,
    childTrueMicroFamilyId: childId || null,
    base75ChildTrueMicroFamilyId: childId || null,

    microMicroFamilyId: microMicroId || null,
    trueMicroMicroFamilyId: microMicroId || null,
    exactMicroMicroFamilyId: microMicroId || null,

    orderedLearningIds: [
      parentId,
      childId,
      microMicroId
    ].filter(Boolean),

    rollupPolicy: 'UPDATE_PARENT_15_AND_MICRO_75_AND_MICRO_MICRO',
    sampleDoesNotSplitParent: true,
    sampleDoesNotSplitMicro75: true,
    microMicroSelectable: Boolean(microMicroId),
    child75Selectable: false,
    parent15Selectable: false,
    selectionGranularity: SELECTION_EXACT_MICRO_MICRO
  };
}

export function normalizeLearningIdentity(row = {}) {
  const learningId = rowMicroId(row);
  const parsed = parseShortTaxonomyMicroId(learningId);

  const parentId =
    parsed.parentTrueMicroFamilyId ||
    rowParentTrueMicroId(row) ||
    null;

  const childId =
    parsed.childTrueMicroFamilyId ||
    rowChildTrueMicroId(row) ||
    null;

  const microMicroId =
    parsed.microMicroFamilyId ||
    rowMicroMicroId(row) ||
    null;

  return {
    learningFamilyId: learningId || null,
    learningMicroFamilyId: learningId || null,
    analyzeMicroFamilyId: learningId || null,

    microFamilyId: parsed.isMicroMicro ? childId : learningId || null,

    trueMicroFamilyId: childId || (parsed.isParent ? parentId : null) || null,
    childTrueMicroFamilyId: childId,
    base75ChildTrueMicroFamilyId: childId,

    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,

    learningLayer: parsed.learningLayer || 'UNKNOWN',

    parentTrueMicroFamilyId: parentId,

    selectionGranularity: parsed.isMicroMicro
      ? SELECTION_EXACT_MICRO_MICRO
      : parsed.isChild
        ? SELECTION_75_CHILD_CONTEXT
        : parsed.isParent
          ? SELECTION_PARENT_CONTEXT
          : 'UNKNOWN',

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,

    trueMicroFamilySchema: parsed.isParent ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: parsed.isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,

    learningGranularity: parsed.isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : parsed.isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,

    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    sampleFallbackAllowed: parsed.isMicroMicro,
    sampleFallbackLayer: parsed.isMicroMicro ? LAYER_MICRO_75 : parsed.isChild ? LAYER_PARENT_15 : null,
    sampleFallbackId: parsed.isMicroMicro
      ? parsed.childTrueMicroFamilyId
      : parsed.isChild
        ? parsed.parentTrueMicroFamilyId
        : null,

    selectableChild: false,
    selectableMicroMicro: parsed.isMicroMicro,
    selectable: parsed.isMicroMicro,

    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherShrinkageVersion: MARKET_WEATHER_SHRINKAGE_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION
  };
}

export {
  dashboardSideFromTradeSide
};