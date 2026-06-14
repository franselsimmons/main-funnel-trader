// ================= FILE: src/analyze/analyzeEngine.js =================

import { createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  classifyMicroFamily,
  classifyMacroFamily
} from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const OBSERVATION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

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

const REAL_VOLUME_FIELDS = [
  'volBucket',
  'volumeBucket',
  'volumeScore',
  'relativeVolume',
  'volumeSpike',
  'volumeConfirmed',
  'quoteVolumeSpike'
];

const IGNORED_AS_VOLUME_FIELDS = [
  'volatilityTier',
  'atrPct',
  'rangePct',
  'realizedVolPct',
  'volume24h',
  'quoteVolume24h',
  'quoteVolume'
];

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const LEGACY_SETUP_ALIASES = {
  BO: 'BREAKOUT',
  BREAK: 'BREAKOUT',
  BREAK_OUT: 'BREAKOUT',
  BREAKOUT_SHORT: 'BREAKOUT',
  BREAKDOWN: 'BREAKOUT',
  BREAK_DOWN: 'BREAKOUT',
  BD: 'BREAKOUT',

  RETEST_SHORT: 'RETEST',
  PULLBACK: 'RETEST',
  PULL_BACK: 'RETEST',
  PB: 'RETEST',

  SWEEP: 'SWEEP_REVERSAL',
  SWEEP_REVERSE: 'SWEEP_REVERSAL',
  SWEEP_REVERSAL_SHORT: 'SWEEP_REVERSAL',
  REVERSAL: 'SWEEP_REVERSAL',
  LIQ_SWEEP: 'SWEEP_REVERSAL',
  LIQUIDITY_SWEEP: 'SWEEP_REVERSAL',

  CONT: 'CONTINUATION',
  CONTINUATION_SHORT: 'CONTINUATION',
  MOMENTUM: 'CONTINUATION',
  TREND_CONTINUATION: 'CONTINUATION',

  COMPRESS: 'COMPRESSION',
  COMPRESSION_SHORT: 'COMPRESSION',
  COIL: 'COMPRESSION',
  SQUEEZE_SETUP: 'COMPRESSION'
};

const LEGACY_REGIME_ALIASES = {
  TRENDING: 'TREND',
  BEAR_TREND: 'TREND',
  DOWNTREND: 'TREND',
  IMPULSE: 'TREND',

  RANGE: 'CHOP',
  RANGING: 'CHOP',
  SIDEWAYS: 'CHOP',
  CHOPPY: 'CHOP',
  MEAN_REVERT: 'CHOP',

  VOL_SQUEEZE: 'SQUEEZE',
  SQUEEZE_REGIME: 'SQUEEZE',
  COMPRESSION: 'SQUEEZE',
  TIGHT_RANGE: 'SQUEEZE'
};

const LEGACY_CONFIRMATION_ALIASES = {
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
  BEAR_FLOW: 'B_FLOW_ALIGN',
  BEARISH_FLOW: 'B_FLOW_ALIGN',

  C: 'C_VOLUME_ALIGN',
  VOLUME: 'C_VOLUME_ALIGN',
  VOLUME_ALIGN: 'C_VOLUME_ALIGN',
  VOL_ALIGN: 'C_VOLUME_ALIGN',
  OB_VOLUME_ALIGN: 'C_VOLUME_ALIGN',

  D: 'D_MIXED_OK',
  MIXED: 'D_MIXED_OK',
  MIXED_OK: 'D_MIXED_OK',
  NEUTRAL_OK: 'D_MIXED_OK',

  E: 'E_WEAK_CONTRA',
  WEAK: 'E_WEAK_CONTRA',
  WEAK_CONTRA: 'E_WEAK_CONTRA',
  CONTRA: 'E_WEAK_CONTRA',
  AVOID: 'E_WEAK_CONTRA',
  AVOID_SHORT: 'E_WEAK_CONTRA'
};

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function hashText(value, length = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}

function stripKnownNamespace(key = '') {
  let value = String(key || '').trim();

  while (value.startsWith('SHORT:') || value.startsWith('LONG:')) {
    value = value.replace(/^(SHORT|LONG):/, '');
  }

  return value;
}

function shortKey(key, fallback = null) {
  const raw = stripKnownNamespace(key || fallback || '');

  if (!raw) return null;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function callKey(fn, ...args) {
  try {
    return typeof fn === 'function' ? fn(...args) : null;
  } catch {
    return null;
  }
}

function getWeekMicrosKey(weekKey = PERSISTENT_LEARNING_KEY) {
  return shortKey(
    callKey(KEYS.short?.analyze?.weekMicros, weekKey) ||
      callKey(KEYS.analyze?.shortWeekMicros, weekKey) ||
      callKey(KEYS.analyze?.weekMicros, weekKey) ||
      `ANALYZE:WEEK_MICROS:${weekKey}`
  );
}

function getWeekMetaKey(weekKey = PERSISTENT_LEARNING_KEY) {
  return shortKey(
    callKey(KEYS.short?.analyze?.weekMeta, weekKey) ||
      callKey(KEYS.analyze?.shortWeekMeta, weekKey) ||
      callKey(KEYS.analyze?.weekMeta, weekKey) ||
      `ANALYZE:WEEK_META:${weekKey}`
  );
}

function getObsLastKey(snapshotId, symbol, microFamilyId) {
  return shortKey(
    callKey(KEYS.short?.analyze?.obsLast, snapshotId, symbol, microFamilyId) ||
      callKey(KEYS.analyze?.shortObsLast, snapshotId, symbol, microFamilyId) ||
      callKey(KEYS.analyze?.obsLast, snapshotId, symbol, microFamilyId) ||
      `ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${microFamilyId}`
  );
}

function obsDedupeTtlSec() {
  return Math.max(
    60,
    Math.floor(safeNumber(CONFIG?.analyze?.obsDedupeTtlSec, 60 * 60 * 24))
  );
}

function normalizeSource(source) {
  const raw = upper(source || OUTCOME_SOURCE);

  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'VIRTUAL') return 'VIRTUAL';

  return OUTCOME_SOURCE;
}

function cleanSideText(value = '') {
  return upper(value)
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
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function sideTextToTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if ([
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'ASK',
    'DOWN',
    'DOWNSIDE',
    'RED'
  ].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if ([
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'BID',
    'UP',
    'UPSIDE',
    'GREEN'
  ].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const shortPatterns = [
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
  ];

  const longPatterns = [
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
  ];

  const hit = (patterns) => patterns.some((pattern) => (
    normalized === pattern ||
    normalized.startsWith(`${pattern}_`) ||
    normalized.endsWith(`_${pattern}`) ||
    normalized.includes(`_${pattern}_`)
  ));

  const shortHit = hit(shortPatterns);
  const longHit = hit(longPatterns);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (normalized.includes('MICRO_SHORT')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isScannerFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.includes('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('SHORT_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
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
      rawId
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

  return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
    rawId,
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function validShortLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return parseShortTaxonomyMicroId(value).isChild;
}

function normalizeChildTrueMicroFamilyId(id = '') {
  const raw = String(id || '').trim();

  if (!raw) return '';

  const parsed = parseShortTaxonomyMicroId(raw);

  return parsed.isChild ? parsed.childTrueMicroFamilyId : '';
}

function normalizeParentTrueMicroFamilyId(id = '', row = {}) {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isChild || parsed.isParent) return parsed.parentTrueMicroFamilyId;

  const child = normalizeChildTrueMicroFamilyId(
    row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.childTrueMicroFamilyId ||
      ''
  );

  return parseShortTaxonomyMicroId(child).parentTrueMicroFamilyId || '';
}

function normalizeSetupType(value = '') {
  const raw = upper(value)
    .replace(/^SHORT_/, '')
    .replace(/^MICRO_SHORT_/, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) return null;
  if (SHORT_FIXED_SETUP_TYPES.has(raw)) return raw;
  if (LEGACY_SETUP_ALIASES[raw]) return LEGACY_SETUP_ALIASES[raw];

  if (raw.includes('SWEEP') || raw.includes('REVERSAL')) return 'SWEEP_REVERSAL';
  if (raw.includes('RETEST') || raw.includes('PULLBACK') || raw.includes('PULL_BACK')) return 'RETEST';
  if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') || raw.includes('COIL')) return 'COMPRESSION';
  if (raw.includes('BREAKDOWN') || raw.includes('BREAK_DOWN') || raw.includes('BREAKOUT') || raw.includes('BREAK_OUT')) return 'BREAKOUT';
  if (raw.includes('CONTINUATION') || raw.includes('MOMENTUM') || raw.includes('TREND_CONT')) return 'CONTINUATION';

  return null;
}

function normalizeRegimeBucket(value = '') {
  const raw = upper(value)
    .replace(/^SHORT_/, '')
    .replace(/^MICRO_SHORT_/, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) return null;
  if (SHORT_FIXED_REGIME_BUCKETS.has(raw)) return raw;
  if (LEGACY_REGIME_ALIASES[raw]) return LEGACY_REGIME_ALIASES[raw];

  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION') || raw.includes('TIGHT')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE') || raw.includes('MOMENTUM')) return 'TREND';

  return null;
}

function normalizeConfirmationProfile(value = '') {
  const parsed = parseShortTaxonomyMicroId(value);

  if (parsed.isChild) return parsed.confirmationProfile;

  const raw = upper(value)
    .replace(/^CONFIRMATION_/, '')
    .replace(/^CONFIRM_/, '')
    .replace(/^PROFILE_/, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!raw) return null;
  if (SHORT_CONFIRMATION_PROFILES.has(raw)) return raw;
  if (LEGACY_CONFIRMATION_ALIASES[raw]) return LEGACY_CONFIRMATION_ALIASES[raw];

  for (const profile of CONFIRMATION_PROFILE_ORDER) {
    if (raw.endsWith(profile) || raw.includes(profile)) return profile;
  }

  if (raw.includes('STRONG') || raw.includes('FULL_ALIGN') || raw.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
  if (raw.includes('FLOW') || raw.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
  if (raw.includes('VOLUME') || raw.includes('VOL_') || raw.includes('OB_')) return 'C_VOLUME_ALIGN';
  if (raw.includes('MIXED') || raw.includes('OK') || raw.includes('NEUTRAL')) return 'D_MIXED_OK';
  if (raw.includes('WEAK') || raw.includes('CONTRA') || raw.includes('AVOID')) return 'E_WEAK_CONTRA';

  return null;
}

function firstNormalizedSetup(...values) {
  for (const value of values) {
    const setup = normalizeSetupType(value);
    if (setup) return setup;
  }

  return null;
}

function firstNormalizedRegime(...values) {
  for (const value of values) {
    const regime = normalizeRegimeBucket(value);
    if (regime) return regime;
  }

  return null;
}

function firstNormalizedConfirmation(...values) {
  for (const value of values) {
    const profile = normalizeConfirmationProfile(value);
    if (profile) return profile;
  }

  return null;
}

function boolish(...values) {
  return values.some((value) => (
    value === true ||
    value === 1 ||
    value === '1' ||
    String(value || '').trim().toLowerCase() === 'true' ||
    String(value || '').trim().toLowerCase() === 'yes'
  ));
}

function numberish(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function hasTextSignal(values = [], patterns = []) {
  const text = (Array.isArray(values) ? values : [values])
    .map(upper)
    .filter(Boolean)
    .join('|');

  return patterns.some((pattern) => text.includes(pattern));
}

function hasRealVolume(row = {}, classified = {}) {
  const combined = {
    ...classified,
    ...row
  };

  for (const field of IGNORED_AS_VOLUME_FIELDS) {
    if (combined[field] !== undefined) {
      // This field is explicitly not used as volume confirmation.
    }
  }

  const volBucket = upper(firstDefined(combined.volBucket, combined.volumeBucket));

  if (
    volBucket.includes('HIGH') ||
    volBucket.includes('SPIKE') ||
    volBucket.includes('STRONG') ||
    volBucket.includes('CONFIRMED') ||
    volBucket === 'YES' ||
    volBucket === 'TRUE'
  ) {
    return true;
  }

  if (boolish(combined.volumeConfirmed)) return true;
  if (boolish(combined.volumeSpike)) return true;
  if (boolish(combined.quoteVolumeSpike)) return true;

  if (numberish(combined.volumeScore, 0) >= 55) return true;
  if (numberish(combined.relativeVolume, 0) >= 1.25) return true;
  if (numberish(combined.volumeSpike, 0) > 0) return true;
  if (numberish(combined.quoteVolumeSpike, 0) > 0) return true;

  return false;
}

function hasBearishFlow(row = {}, classified = {}) {
  const combined = {
    ...classified,
    ...row
  };

  if (boolish(
    combined.bearishFlow,
    combined.bearFlow,
    combined.sellFlow,
    combined.askFlow,
    combined.flowBearish,
    combined.flowAlignShort,
    combined.shortFlowAlign,
    combined.askFlowAlign,
    combined.sellFlowAlign,
    combined.momentumAlignShort,
    combined.bearishMomentum
  )) {
    return true;
  }

  if (hasTextSignal([
    combined.flow,
    combined.flowCoarse,
    combined.flowDirection,
    combined.momentum,
    combined.scannerReason,
    combined.reason,
    combined.signalReason
  ], ['BEAR', 'SELL', 'ASK_HEAVY', 'SHORT_FLOW', 'FLOW_SHORT', 'DOWNSIDE'])) {
    return true;
  }

  const flowScore = numberish(
    firstDefined(
      combined.bearishFlowScore,
      combined.shortFlowScore,
      combined.sellFlowScore,
      combined.askFlowScore,
      combined.flowScore,
      combined.flowStrength,
      combined.momentumScore
    ),
    0
  );

  if (flowScore >= 55) return true;

  const signedFlow = numberish(
    firstDefined(
      combined.signedFlowScore,
      combined.flowDelta,
      combined.orderFlowDelta,
      combined.cvdDelta
    ),
    0
  );

  return signedFlow < 0;
}

function hasStructureAlign(row = {}, classified = {}, setup = null) {
  const combined = {
    ...classified,
    ...row
  };

  if (boolish(
    combined.structureAlign,
    combined.shortStructureAlign,
    combined.bearishStructure,
    combined.breakdownConfirmed,
    combined.breakoutConfirmed,
    combined.retestConfirmed,
    combined.pullbackConfirmed,
    combined.sweepConfirmed,
    combined.liquiditySweep,
    combined.continuationConfirmed,
    combined.squeezeBreak,
    combined.compressionBreak
  )) {
    return true;
  }

  if (setup === 'BREAKOUT' && boolish(combined.breakdownSetup, combined.breakoutSetup)) return true;
  if (setup === 'RETEST' && boolish(combined.retestSetup, combined.pullbackSetup)) return true;
  if (setup === 'SWEEP_REVERSAL' && boolish(combined.sweepSetup, combined.reversalSetup, combined.stopRun)) return true;
  if (setup === 'CONTINUATION' && boolish(combined.continuationSetup, combined.trendContinuation)) return true;
  if (setup === 'COMPRESSION' && boolish(combined.compressionSetup, combined.squeezeSetup, combined.volCompression, combined.rangeCompression)) return true;

  return hasTextSignal([
    combined.setup,
    combined.setupType,
    combined.pattern,
    combined.scannerReason,
    combined.reason,
    combined.signalReason,
    combined.definition
  ], ['BREAKDOWN', 'BREAKOUT', 'RETEST', 'SWEEP', 'REVERSAL', 'CONTINUATION', 'COMPRESSION', 'SQUEEZE']);
}

function hasBullishContra(row = {}, classified = {}) {
  const combined = {
    ...classified,
    ...row
  };

  if (boolish(
    combined.bullishContra,
    combined.contraSignal,
    combined.weakContra,
    combined.avoidShort,
    combined.shortAvoid,
    combined.fakeout,
    combined.fakeBreakout,
    combined.fakeBreakoutRisk,
    combined.btcAgainstShort,
    combined.btcAgainst,
    combined.btcBullish,
    combined.flowAgainst,
    combined.flowAgainstShort,
    combined.bullishFlow,
    combined.longFlow,
    combined.bidFlowAlign,
    combined.bullishDivergence,
    combined.longBias,
    combined.bullBias
  )) {
    return true;
  }

  return hasTextSignal([
    combined.contraReason,
    combined.scannerReason,
    combined.reason,
    combined.signalReason,
    combined.btcState,
    combined.btcRelation,
    combined.flow,
    combined.flowCoarse
  ], ['AVOID_SHORT', 'BULL_CONTRA', 'BULLISH_CONTRA', 'BTC_AGAINST', 'FLOW_AGAINST', 'FAKEOUT', 'FAKE_BREAKOUT', 'LONG_BIAS']);
}

function inferSetupType(row = {}, classified = {}) {
  const explicit = firstNormalizedSetup(
    classified.setupType,
    classified.setup,
    classified.shortSetup,
    classified.pattern,
    row.setupType,
    row.setup,
    row.shortSetup,
    row.pattern,
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.entryQuality
  );

  if (explicit) return explicit;

  if (row.sweepConfirmed || row.liquiditySweep || row.stopRun || row.reversalSetup) return 'SWEEP_REVERSAL';
  if (row.retestConfirmed || row.pullbackConfirmed || row.retestSetup || row.pullbackSetup) return 'RETEST';
  if (row.squeezeBreak || row.compressionBreak || row.volCompression || row.rangeCompression) return 'COMPRESSION';
  if (row.breakdownConfirmed || row.breakdownSetup || row.breakoutConfirmed || row.breakoutSetup || row.newLowBreakout) return 'BREAKOUT';

  const text = [
    classified.definition,
    classified.microDefinition,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].map(upper).join('|');

  if (text.includes('SWEEP') || text.includes('REVERSAL')) return 'SWEEP_REVERSAL';
  if (text.includes('RETEST') || text.includes('PULLBACK')) return 'RETEST';
  if (text.includes('COMPRESSION') || text.includes('SQUEEZE') || text.includes('COIL')) return 'COMPRESSION';
  if (text.includes('BREAKDOWN') || text.includes('BREAKOUT')) return 'BREAKOUT';

  return 'CONTINUATION';
}

function inferRegimeBucket(row = {}, classified = {}) {
  const explicit = firstNormalizedRegime(
    classified.regimeBucket,
    classified.regimeCoarse,
    classified.regime,
    row.regimeBucket,
    row.regimeCoarse,
    row.regime,
    row.marketRegime,
    row.btcState,
    row.scannerReason,
    row.reason
  );

  if (explicit) return explicit;

  if (row.squeezeRegime || row.volCompression || row.rangeCompression || row.squeezeActive) return 'SQUEEZE';
  if (row.chopRegime || row.rangeRegime || row.sidewaysRegime) return 'CHOP';

  const text = [
    classified.definition,
    classified.microDefinition,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].map(upper).join('|');

  if (text.includes('SQUEEZE') || text.includes('COMPRESSION')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAYS')) return 'CHOP';

  return 'TREND';
}

function inferConfirmationProfile(row = {}, classified = {}, setup = null) {
  const explicit = firstNormalizedConfirmation(
    classified.confirmationProfile,
    classified.confirmation,
    classified.confirmProfile,
    row.confirmationProfile,
    row.confirmation,
    row.confirmProfile,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.childTrueMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId,
    classified.childTrueMicroFamilyId
  );

  if (explicit) return explicit;

  const confluence = safeNumber(
    row.confluence ??
      row.sniperScore ??
      row.scannerScore ??
      row.moveScore ??
      classified.confluence,
    0
  );

  const structure = hasStructureAlign(row, classified, setup);
  const bearishFlow = hasBearishFlow(row, classified);
  const realVolume = hasRealVolume(row, classified);
  const hardContra = hasBullishContra(row, classified);

  if (hardContra) return 'E_WEAK_CONTRA';
  if (structure && bearishFlow && realVolume) return 'A_STRONG_ALIGN';
  if (bearishFlow) return 'B_FLOW_ALIGN';
  if (realVolume) return 'C_VOLUME_ALIGN';

  const softContra = boolish(row.weakContra, classified.weakContra, row.softContra, classified.softContra);

  if (softContra && confluence < 35) return 'E_WEAK_CONTRA';

  return 'D_MIXED_OK';
}

function taxonomyMetaFromParts({ setup, regime, confirmationProfile }) {
  const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
  const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
  const parsed = parseShortTaxonomyMicroId(childTrueMicroFamilyId);

  return {
    ...parsed,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,
    trueMicroFamilyId: childTrueMicroFamilyId,
    microFamilyId: childTrueMicroFamilyId,
    childTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    fixedTaxonomyLearningId: true,
    exactTrueMicroFamilyRequired: true
  };
}

function extractFixedTaxonomyMicroId(source = {}, classified = {}) {
  const candidates = [
    source.trueMicroFamilyId,
    source.microFamilyId,
    source.childTrueMicroFamilyId,
    source.analyzeMicroFamilyId,
    source.learningMicroFamilyId,
    source.fixedTaxonomyMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId,
    classified.childTrueMicroFamilyId
  ];

  for (const candidate of candidates) {
    const parsed = parseShortTaxonomyMicroId(candidate);

    if (parsed.isChild) {
      return taxonomyMetaFromParts({
        setup: parsed.setup,
        regime: parsed.regime,
        confirmationProfile: parsed.confirmationProfile
      });
    }
  }

  const setup = inferSetupType(source, classified);
  const regime = inferRegimeBucket(source, classified);
  const confirmationProfile = inferConfirmationProfile(source, classified, setup);

  if (
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile)
  ) {
    return taxonomyMetaFromParts({
      setup,
      regime,
      confirmationProfile
    });
  }

  return null;
}

function analyzeIdentityFlags() {
  return {
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    bareWinrateRankingDisabled: true,

    bucketGranularity: 'LOW_MID_HIGH',
    bucketsCoarseOnly: true,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    realVolumeFields: REAL_VOLUME_FIELDS,
    ignoredAsVolumeFields: IGNORED_AS_VOLUME_FIELDS,

    validShortRiskShape: 'tp < entry < sl',
    shortRiskShape: 'tp < entry < sl',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortExitRules: {
      tp: 'price <= tp',
      sl: 'price >= sl',
      timeStop: 'TIME_STOP'
    },

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    virtualLearning: true,
    virtualOnly: true,
    paperOnly: true,
    shadowOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    longRootTouched: false,
    shortRootTouched: true
  };
}

function withAnalyzeIdentityFlags(row = {}) {
  return {
    ...analyzeIdentityFlags(),
    ...row
  };
}

function inferTradeSide(row = {}, classified = {}) {
  if (typeof row === 'string') return sideTextToTradeSide(row);

  const direct = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side,
    classified.tradeSide,
    classified.positionSide,
    classified.direction,
    classified.side
  ]
    .map(sideTextToTradeSide)
    .find((side) => side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE);

  if (direct) return direct;

  const textValues = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.definition,
    row.microDefinition,
    row.parentDefinition,
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.id,
    row.key,
    classified.familyId,
    classified.microFamilyId,
    classified.trueMicroFamilyId,
    classified.definition,
    classified.reason,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : [])
  ];

  let shortHit = false;
  let longHit = false;

  for (const value of textValues) {
    const side = sideTextToTradeSide(value);

    if (side === TARGET_TRADE_SIDE) shortHit = true;
    if (side === OPPOSITE_TRADE_SIDE) longHit = true;
  }

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microFamilyId || row.id || row.key).isChild) {
      return TARGET_TRADE_SIDE;
    }

    if (upper(row.trueMicroFamilyId || row.microFamilyId || row.id || row.key).includes('MICRO_LONG_')) {
      return OPPOSITE_TRADE_SIDE;
    }
  }

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortOnlyRow(row = {}, classified = {}) {
  return inferTradeSide(row, classified) === TARGET_TRADE_SIDE;
}

function normalizeStatsSide() {
  return TARGET_DASHBOARD_SIDE;
}

function normalizeClassifiedSide(classified = {}) {
  return withAnalyzeIdentityFlags({
    ...classified,
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
    shortDisabled: false
  });
}

function normalizeClassificationInput(row = {}, forcedSide = null) {
  const tradeSide = forcedSide || inferTradeSide(row);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return withAnalyzeIdentityFlags({
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    source: row.source || OBSERVATION_SOURCE,
    virtualOnly: row.virtualOnly !== false,
    paperOnly: true,
    virtualTracked: row.virtualTracked !== false,
    shadowOnly: row.shadowOnly !== false,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  });
}

function normalizeBucketText(value, fallback = 'NA') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || fallback;
}

function buildDefinitionParts(row = {}, classified = {}, taxonomy = {}) {
  const volumeParts = REAL_VOLUME_FIELDS.map((field) => {
    const value = firstDefined(row[field], classified[field]);

    return value === null || value === undefined
      ? null
      : `${field.toUpperCase()}=${normalizeBucketText(value)}`;
  }).filter(Boolean);

  return uniqueStrings([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile}`,
    `FLOW=${normalizeBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(classified.btcState || row.btcState || 'NA')}`,
    `REGIME=${normalizeBucketText(classified.regimeCoarse || row.regimeCoarse || classified.regime || row.regime || 'NA')}`,
    ...volumeParts
  ]);
}

function buildParentDefinitionParts(taxonomy = {}) {
  return uniqueStrings([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`
  ]);
}

function getScannerMetadata(row = {}) {
  const scannerMicroFamilyId = firstDefined(
    row.scannerMicroFamilyId,
    isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
    isScannerFingerprintId(row.id) ? row.id : null,
    isScannerFingerprintId(row.key) ? row.key : null
  );

  const scannerFamilyId = firstDefined(
    row.scannerFamilyId,
    isScannerFingerprintId(row.familyId) ? row.familyId : null,
    isScannerFingerprintId(row.baseFamilyId) ? row.baseFamilyId : null
  );

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts) ? row.scannerDefinitionParts : [],
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false
  };
}

function attachExecutionFingerprintMetadata(classified = {}, row = {}, taxonomy = {}) {
  if (bool(CONFIG?.analyze?.buildExecutionFingerprintMetadata, true) !== true) {
    return withAnalyzeIdentityFlags({
      ...classified,
      executionFingerprintHash: null,
      executionFingerprintParts: [],
      executionFingerprintSchema: null,
      executionMicroFamilyId: null,
      executionFingerprintRole: 'DISABLED'
    });
  }

  const analyzeMicroFamilyId = normalizeChildTrueMicroFamilyId(
    taxonomy.trueMicroFamilyId ||
      classified.trueMicroFamilyId ||
      classified.microFamilyId
  );

  if (!analyzeMicroFamilyId) return withAnalyzeIdentityFlags(classified);

  const executionParts = uniqueStrings([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile}`,
    `FLOW=${normalizeBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(classified.btcState || row.btcState || 'NA')}`,
    `SCANNER=${normalizeBucketText(classified.scannerReasonCoarse || row.scannerReasonCoarse || classified.scannerReason || row.scannerReason || 'NA')}`,
    `SPREAD=${normalizeBucketText(row.spreadBps ?? classified.spreadBps ?? 'NA')}`,
    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`
  ]);

  const executionHash = hashText(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);
  const executionMicroFamilyId = `${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`;

  return withAnalyzeIdentityFlags({
    ...classified,
    microFamilyId: analyzeMicroFamilyId,
    trueMicroFamilyId: analyzeMicroFamilyId,
    childTrueMicroFamilyId: analyzeMicroFamilyId,
    coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    executionFingerprintHash: executionHash,
    executionFingerprintParts: executionParts,
    executionFingerprintSchema: EXECUTION_MICRO_SUFFIX,
    executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY'
  });
}

function safeClassifyMacro(row = {}) {
  try {
    return classifyMacroFamily(row) || {};
  } catch {
    return {};
  }
}

function safeClassifyMicro(row = {}) {
  try {
    return classifyMicroFamily(row) || {};
  } catch {
    return {};
  }
}

function enrichWithMicroFamily(row = {}, { forcedSide = null } = {}) {
  const classifyInput = normalizeClassificationInput(row, forcedSide);

  if (!classifyInput) return null;

  const scannerMetadata = getScannerMetadata(classifyInput);
  const macro = normalizeClassifiedSide(safeClassifyMacro(classifyInput));
  const rawClassified = normalizeClassifiedSide({
    ...macro,
    ...safeClassifyMicro(classifyInput)
  });

  const taxonomy = extractFixedTaxonomyMicroId(classifyInput, rawClassified);

  if (!taxonomy?.trueMicroFamilyId || !taxonomy?.parentTrueMicroFamilyId) return null;

  const classified = attachExecutionFingerprintMetadata(rawClassified, classifyInput, taxonomy);
  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(taxonomy.trueMicroFamilyId);

  if (!trueMicroFamilyId) return null;

  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;
  const definitionParts = buildDefinitionParts(classifyInput, classified, taxonomy);
  const parentDefinitionParts = buildParentDefinitionParts(taxonomy);

  return withAnalyzeIdentityFlags({
    ...row,

    familyId: classified.familyId || row.familyId || 'SHORT_FIXED_TAXONOMY',

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fixedTaxonomyLearningId: true,
    fineMicroFamilyAsMetadataOnly: true,

    executionFingerprintHash: classified.executionFingerprintHash || null,
    executionFingerprintParts: classified.executionFingerprintParts || [],
    executionFingerprintSchema: classified.executionFingerprintSchema || null,
    executionMicroFamilyId: classified.executionMicroFamilyId || null,
    executionFingerprintRole: classified.executionFingerprintRole || 'METADATA_ONLY',

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,

    definitionParts,
    microDefinitionParts: definitionParts,
    definition: definitionParts.join(' | '),
    microDefinition: definitionParts.join(' | '),

    parentDefinitionParts,
    macroDefinitionParts: parentDefinitionParts,
    parentDefinition: parentDefinitionParts.join(' | '),
    macroDefinition: parentDefinitionParts.join(' | '),

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'short-fixed-taxonomy-75-child',

    assetClass: classified.assetClass || row.assetClass || 'CRYPTO',

    obRelation: classified.obRelation || row.obRelation,
    btcRelation: classified.btcRelation || row.btcRelation,
    btcState: classified.btcState || row.btcState,

    flow: classified.flow || row.flow,
    flowCoarse: classified.flowCoarse || row.flowCoarse,

    regime: classified.regime || row.regime,
    regimeCoarse: classified.regimeCoarse || row.regimeCoarse,

    scannerReason: classified.scannerReason || row.scannerReason,
    scannerReasonCoarse: classified.scannerReasonCoarse || row.scannerReasonCoarse,

    rsiZone: classified.rsiZone || row.rsiZone,
    rsiCoarse: classified.rsiCoarse || row.rsiCoarse,

    spreadBps: classified.spreadBps ?? row.spreadBps,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: row.source || OBSERVATION_SOURCE,
    virtualOnly: row.virtualOnly !== false,
    paperOnly: true,
    virtualTracked: row.virtualTracked !== false,
    shadowOnly: row.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,
    mirrorOfSide: null
  });
}

function compactMicroForStorage(row = {}) {
  const refreshed = refreshStats(withAnalyzeIdentityFlags(row));
  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    refreshed.trueMicroFamilyId || refreshed.microFamilyId || refreshed.childTrueMicroFamilyId
  );

  if (!trueMicroFamilyId) return null;

  const taxonomy = parseShortTaxonomyMicroId(trueMicroFamilyId);
  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  return withAnalyzeIdentityFlags({
    ...refreshed,

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmationProfile,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    realCompleted: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,
    realTotalR: 0,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    learningStatus: getLearningStatus(refreshed),
    status: getLearningStatus(refreshed),
    tooEarly: safeNumber(refreshed.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: safeNumber(refreshed.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING
      ? `completed ${safeNumber(refreshed.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    updatedAt: refreshed.updatedAt || now()
  });
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(
    Object.entries(micros || {})
      .map(([id, row]) => {
        const childId = normalizeChildTrueMicroFamilyId(
          row?.trueMicroFamilyId ||
            row?.microFamilyId ||
            row?.childTrueMicroFamilyId ||
            id
        );

        if (!childId || !row) return null;
        if (!isShortOnlyRow(row)) return null;

        const compact = compactMicroForStorage({
          ...row,
          microFamilyId: childId,
          trueMicroFamilyId: childId,
          childTrueMicroFamilyId: childId
        });

        if (!compact) return null;

        return [childId, compact];
      })
      .filter(Boolean)
  );
}

function getLearningStatus(row = {}) {
  const completed = safeNumber(row.completed || row.outcomeSample, 0);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function getOrCreateMicro(micros, classified, side = TARGET_DASHBOARD_SIDE) {
  if (!classified) {
    throw new Error('CLASSIFIED_MICRO_REQUIRED');
  }

  const microFamilyId = normalizeChildTrueMicroFamilyId(
    classified.trueMicroFamilyId ||
      classified.microFamilyId ||
      classified.childTrueMicroFamilyId
  );

  if (!microFamilyId) {
    throw new Error('EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED');
  }

  if (!validShortLearningId(microFamilyId)) {
    throw new Error('INVALID_SHORT_LEARNING_ID');
  }

  const parsed = parseShortTaxonomyMicroId(microFamilyId);

  if (!parsed.isChild) {
    throw new Error('PARENT_OR_NON_CHILD_MICRO_FAMILY_CANNOT_BE_STATS_KEY');
  }

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const familyId = classified.familyId || 'SHORT_FIXED_TAXONOMY';

  if (!micros[microFamilyId]) {
    micros[microFamilyId] = createMicroStats({
      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      familyId,
      side: normalizeStatsSide(side),
      tradeSide: TARGET_TRADE_SIDE,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[microFamilyId];

  Object.assign(micro, analyzeIdentityFlags(), {
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,

    familyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fixedTaxonomyLearningId: true,
    fineMicroFamilyAsMetadataOnly: true,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'short-fixed-taxonomy-75-child'
  });

  micro.executionFingerprintHash ||= classified.executionFingerprintHash || null;
  micro.executionFingerprintParts ||= classified.executionFingerprintParts || [];
  micro.executionFingerprintSchema ||= classified.executionFingerprintSchema || null;
  micro.executionMicroFamilyId ||= classified.executionMicroFamilyId || null;
  micro.executionFingerprintRole ||= classified.executionFingerprintRole || 'METADATA_ONLY';

  micro.scannerMicroFamilyId ||= classified.scannerMicroFamilyId || null;
  micro.scannerFamilyId ||= classified.scannerFamilyId || null;
  micro.scannerDefinition ||= classified.scannerDefinition || null;
  micro.scannerDefinitionParts ||= classified.scannerDefinitionParts || [];

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts ||= classified.parentDefinitionParts || [];

  micro.definitionParts = uniqueStrings([
    micro.definitionParts || [],
    classified.definitionParts || []
  ]);

  micro.definition = micro.definitionParts.length
    ? micro.definitionParts.join(' | ')
    : classified.definition || '';

  micro.learningStatus = getLearningStatus(micro);
  micro.status = micro.learningStatus;
  micro.tooEarly = safeNumber(micro.completed, 0) < MIN_COMPLETED_ACTIVE_LEARNING;
  micro.tooEarlyReason = micro.tooEarly
    ? `completed ${safeNumber(micro.completed, 0)}/${MIN_COMPLETED_ACTIVE_LEARNING}`
    : null;

  return micro;
}

function compareTopMicros(a = {}, b = {}) {
  const ar = refreshStats(a);
  const br = refreshStats(b);

  return (
    safeNumber(br.dashboardBalancedScore ?? br.balancedScore, 0) -
    safeNumber(ar.dashboardBalancedScore ?? ar.balancedScore, 0) ||

    safeNumber(br.fairWinrate ?? br.sampleAdjustedWinrate ?? br.wilsonLowerBound, 0) -
    safeNumber(ar.fairWinrate ?? ar.sampleAdjustedWinrate ?? ar.wilsonLowerBound, 0) ||

    safeNumber(br.totalR ?? br.netTotalR, 0) -
    safeNumber(ar.totalR ?? ar.netTotalR, 0) ||

    safeNumber(br.avgR ?? br.netAvgR, 0) -
    safeNumber(ar.avgR ?? ar.netAvgR, 0) ||

    safeNumber(ar.avgCostR ?? ar.totalCostR, 0) -
    safeNumber(br.avgCostR ?? br.totalCostR, 0) ||

    safeNumber(br.completed, 0) -
    safeNumber(ar.completed, 0) ||

    safeNumber(br.seen ?? br.observations, 0) -
    safeNumber(ar.seen ?? ar.observations, 0) ||

    String(ar.microFamilyId || '').localeCompare(String(br.microFamilyId || ''))
  );
}

function selectTopMicrosObject(micros = {}, limit = 25) {
  return Object.fromEntries(
    Object.values(normalizeMicros(micros))
      .filter(Boolean)
      .sort(compareTopMicros)
      .slice(0, Math.max(1, Math.floor(safeNumber(limit, 25))))
      .map((row) => [row.trueMicroFamilyId || row.microFamilyId, row])
      .filter(([id]) => Boolean(id))
  );
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const redis = getDurableRedis();
  const rows = await getJson(redis, getWeekMicrosKey(weekKey), {}).catch(() => ({}));

  return normalizeMicros(rows || {});
}

export async function getWeekMicrosByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  const micros = await getWeekMicros(weekKey);
  const safeIds = uniqueStrings(ids)
    .map((id) => normalizeChildTrueMicroFamilyId(id))
    .filter(Boolean);

  return Object.fromEntries(
    safeIds
      .filter((id) => micros[id])
      .map((id) => [id, micros[id]])
  );
}

export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, { limit = 25 } = {}) {
  return selectTopMicrosObject(await getWeekMicros(weekKey), limit);
}

export async function saveWeekMicros(
  weekKey,
  micros,
  {
    onlyIds = null,
    allowEmptyFullSave = false
  } = {}
) {
  if (!weekKey) {
    throw new Error('WEEK_KEY_MISSING');
  }

  const redis = getDurableRedis();
  const existing = await getWeekMicros(weekKey).catch(() => ({}));
  const incoming = normalizeMicros(micros || {});

  const targetIds = onlyIds
    ? uniqueStrings(onlyIds).map((id) => normalizeChildTrueMicroFamilyId(id)).filter(Boolean)
    : null;

  const next = targetIds
    ? {
      ...existing,
      ...Object.fromEntries(
        targetIds
          .filter((id) => incoming[id])
          .map((id) => [id, incoming[id]])
      )
    }
    : incoming;

  const clean = normalizeMicros(next);

  if (!allowEmptyFullSave && !onlyIds && Object.keys(clean).length === 0 && Object.keys(existing).length > 0) {
    return existing;
  }

  await setJson(
    redis,
    getWeekMicrosKey(weekKey),
    clean,
    {
      ex: Math.max(
        60 * 60,
        Math.floor(safeNumber(CONFIG?.analyze?.weekMicrosTtlSec, 60 * 60 * 24 * 21))
      )
    }
  );

  await setJson(
    redis,
    getWeekMetaKey(weekKey),
    {
      weekKey,
      updatedAt: now(),
      microFamilies: Object.keys(clean).length,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_SCANNER_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      scannerFingerprintsMetadataOnly: true,
      scannerFingerprintsUsedAsLearningFamily: false,
      executionFingerprintsMetadataOnly: true,
      executionFingerprintsUsedAsLearningFamily: false,

      analyzeMicroFamiliesOnly: true,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,

      symbolExcludedFromFamilyId: true,
      coinNameExcludedFromFamilyId: true,
      hashesExcludedFromFamilyId: true,

      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

      completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
      scoringRSource: 'netR',
      rankingPolicy: 'balancedScore|fairWinrate|totalR|avgR|avgCostR',
      bareWinrateRankingDisabled: true,

      redisNamespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      longRootTouched: false
    },
    {
      ex: Math.max(
        60 * 60,
        Math.floor(safeNumber(CONFIG?.analyze?.weekMetaTtlSec, 60 * 60 * 24 * 90))
      )
    }
  );

  return clean;
}

function buildAnalyzeVariants(metrics = {}) {
  const primary = enrichWithMicroFamily(metrics);

  return {
    primary,
    mirrors: []
  };
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = PERSISTENT_LEARNING_KEY } = {}
) {
  const rows = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean).filter((row) => isShortOnlyRow(row))
    : [];

  if (rows.length === 0) return [];

  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);

  const analyzed = [];
  const touchedIds = new Set();

  for (const metrics of rows) {
    const batch = {
      metrics: withAnalyzeIdentityFlags(metrics),
      ...buildAnalyzeVariants(metrics)
    };

    if (!batch.primary) continue;

    const classified = batch.primary;
    const microFamilyId = normalizeChildTrueMicroFamilyId(
      classified.trueMicroFamilyId || classified.microFamilyId || classified.childTrueMicroFamilyId
    );

    if (!microFamilyId) continue;

    const parentTrueMicroFamilyId = normalizeParentTrueMicroFamilyId(
      classified.parentTrueMicroFamilyId || classified.coarseMicroFamilyId || microFamilyId,
      classified
    );

    const observationKey = getObsLastKey(
      batch.metrics.snapshotId || 'NO_SNAPSHOT',
      batch.metrics.symbol || batch.metrics.contractSymbol || 'UNKNOWN',
      microFamilyId
    );

    await redis.set(observationKey, String(now()), {
      ex: obsDedupeTtlSec()
    }).catch(() => null);

    const micro = getOrCreateMicro(
      micros,
      {
        ...classified,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        childTrueMicroFamilyId: microFamilyId,
        coarseMicroFamilyId: parentTrueMicroFamilyId,
        parentTrueMicroFamilyId
      },
      TARGET_DASHBOARD_SIDE
    );

    const observation = withAnalyzeIdentityFlags({
      ...batch.metrics,
      ...classified,

      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      childTrueMicroFamilyId: microFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentTrueMicroFamilyId,
      parentMicroFamilyId: parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      parentMacroFamilyId: parentTrueMicroFamilyId,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      weekKey,
      strategyVersion: CONFIG.strategyVersion,

      source: OBSERVATION_SOURCE,
      analysisType: 'VIRTUAL_TRADE_SETUP_OBSERVATION',

      virtualOnly: true,
      paperOnly: true,
      virtualTracked: true,
      shadowOnly: true,

      realTrade: false,
      realOrder: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,

      observationRecorded: true,
      observationDuplicate: false,
      observationAlwaysCounted: true,
      observationDedupeKey: observationKey,

      mirrorMicroFamiliesCreated: 0,
      mirrorMicroFamilyIds: [],

      createdAt: batch.metrics.createdAt || now()
    });

    updateObservation(micro, observation);
    Object.assign(micro, analyzeIdentityFlags());

    touchedIds.add(microFamilyId);
    analyzed.push(observation);
  }

  if (touchedIds.size > 0) {
    await saveWeekMicros(
      weekKey,
      micros,
      {
        onlyIds: [...touchedIds]
      }
    );
  }

  return analyzed;
}

function hasLockedOutcomeIdentity(outcome = {}) {
  return Boolean(
    normalizeChildTrueMicroFamilyId(outcome.trueMicroFamilyId || outcome.microFamilyId || outcome.childTrueMicroFamilyId)
  );
}

function buildLockedOutcomeRow(outcome = {}) {
  const microFamilyId = normalizeChildTrueMicroFamilyId(
    outcome.trueMicroFamilyId ||
      outcome.microFamilyId ||
      outcome.childTrueMicroFamilyId ||
      ''
  );

  if (!microFamilyId) return null;

  const parsed = parseShortTaxonomyMicroId(microFamilyId);
  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;

  const definitionParts = uniqueStrings([
    outcome.definitionParts || [],
    outcome.broadTrueDefinitionParts || [],
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `LOCKED_MICRO=${microFamilyId}`,
    `LOCKED_TRUE_MICRO=${microFamilyId}`,
    `LOCKED_PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
    'OUTCOME_IDENTITY=POSITION_LOCKED'
  ]);

  const parentDefinitionParts = uniqueStrings([
    outcome.parentDefinitionParts || [],
    outcome.macroDefinitionParts || [],
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
    `SETUP=${parsed.setup}`,
    `REGIME_BUCKET=${parsed.regime}`
  ]);

  return withAnalyzeIdentityFlags({
    ...outcome,

    familyId: outcome.familyId || outcome.family || 'SHORT_VIRTUAL_OUTCOME',

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    definitionParts,
    definition: definitionParts.join(' | '),

    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.join(' | '),

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    source: outcome.source || OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,

    virtualOnly: true,
    paperOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY'
  });
}

function calcGrossMovePct({ side, entry, exit }) {
  if (entry <= 0 || exit <= 0) return 0;

  return sideTextToTradeSide(side) === TARGET_TRADE_SIDE
    ? (entry - exit) / entry
    : (exit - entry) / entry;
}

function calcRiskPct({ entry, sl }) {
  if (entry <= 0 || sl <= 0) return 0;

  return Math.abs(sl - entry) / entry;
}

function validShortRiskShape({ entry, initialSl, tp }) {
  return entry > 0 && initialSl > 0 && tp > 0 && tp < entry && entry < initialSl;
}

function calcShortGrossR({ entry, initialSl, exit }) {
  if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;

  const riskDistance = initialSl - entry;

  if (riskDistance <= 0) return 0;

  return (entry - exit) / riskDistance;
}

function calcShortCurrentR({ entry, initialSl, currentPrice }) {
  if (entry <= 0 || initialSl <= 0 || currentPrice <= 0) return 0;

  const riskDistance = initialSl - entry;

  if (riskDistance <= 0) return 0;

  return (entry - currentPrice) / riskDistance;
}

function ensureNetOutcome(outcome = {}) {
  const existingNetR = safeNumber(
    outcome.netR ??
      outcome.exitR ??
      outcome.realizedNetR ??
      outcome.realizedR ??
      outcome.r,
    null
  );

  const existingGrossR = safeNumber(
    outcome.grossR ??
      outcome.rawR ??
      outcome.realizedGrossR,
    null
  );

  const existingCostR = safeNumber(
    outcome.costR ??
      outcome.avgCostR ??
      outcome.totalCostR,
    null
  );

  const entry = safeNumber(outcome.entry, 0);
  const exit = safeNumber(outcome.exit ?? outcome.exitPrice, 0);
  const initialSl = safeNumber(outcome.initialSl || outcome.sl, 0);
  const tp = safeNumber(outcome.tp, 0);

  const riskShapeValid = validShortRiskShape({
    entry,
    initialSl,
    tp
  });

  const riskPct =
    safeNumber(outcome.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = safeNumber(
    outcome.grossMovePct,
    entry > 0 && exit > 0
      ? calcGrossMovePct({
        side: TARGET_TRADE_SIDE,
        entry,
        exit
      })
      : null
  );

  const computedGrossR = riskShapeValid
    ? calcShortGrossR({
      entry,
      initialSl,
      exit
    })
    : 0;

  if (Number.isFinite(grossMovePct) && riskPct > 0) {
    const cost = applyCosts({
      side: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      grossMovePct,
      riskPct,
      entrySpreadPct: safeNumber(outcome.entrySpreadPct ?? outcome.spreadPct, 0),
      exitSpreadPct: safeNumber(outcome.exitSpreadPct ?? outcome.spreadPct, 0)
    });

    const grossR = safeNumber(cost.grossR, existingGrossR ?? computedGrossR);
    const costR = safeNumber(cost.costR, existingCostR ?? 0);
    const netR = safeNumber(cost.netR, existingNetR ?? grossR - costR);

    return withAnalyzeIdentityFlags({
      ...outcome,

      validShortRiskShape: riskShapeValid,
      shortRiskShapeValid: riskShapeValid,

      grossMovePct,
      riskPct,

      grossR,
      rawR: grossR,
      realizedGrossR: grossR,
      grossPnlPct: safeNumber(cost.grossPnlPct, grossMovePct),

      netR,
      exitR: netR,
      realizedNetR: netR,
      realizedR: netR,
      r: netR,
      pnlPct: safeNumber(cost.netPnlPct, 0),
      netPnlPct: safeNumber(cost.netPnlPct, 0),

      costR,
      avgCostR: costR,
      costPct: safeNumber(cost.costPct, 0),
      feePct: safeNumber(cost.feePct, 0),
      slippagePct: safeNumber(cost.slippagePct, 0),

      win: netR > 0,
      loss: netR < 0,
      flat: netR === 0,
      isWin: netR > 0,

      costModelApplied: true,
      netCostModelApplied: true,
      costModel: outcome.costModel || 'APPLY_COSTS_NET_R_V1'
    });
  }

  const fallbackNetR = safeNumber(existingNetR, 0);
  const fallbackGrossR = safeNumber(existingGrossR, fallbackNetR);
  const fallbackCostR = safeNumber(existingCostR, Math.max(0, fallbackGrossR - fallbackNetR));

  return withAnalyzeIdentityFlags({
    ...outcome,

    validShortRiskShape: riskShapeValid,
    shortRiskShapeValid: riskShapeValid,

    netR: fallbackNetR,
    exitR: fallbackNetR,
    realizedNetR: fallbackNetR,
    realizedR: fallbackNetR,
    r: fallbackNetR,

    grossR: fallbackGrossR,
    rawR: fallbackGrossR,
    realizedGrossR: fallbackGrossR,

    costR: fallbackCostR,
    avgCostR: fallbackCostR,

    win: fallbackNetR > 0,
    loss: fallbackNetR < 0,
    flat: fallbackNetR === 0,
    isWin: fallbackNetR > 0,

    costModelApplied: Boolean(outcome.costModelApplied),
    netCostModelApplied: Boolean(outcome.netCostModelApplied),
    costModel: outcome.costModel || 'PRECOMPUTED_NET_R'
  });
}

export async function recordOutcome(
  outcome = {},
  {
    source = outcome.source || OUTCOME_SOURCE,
    weekKey = PERSISTENT_LEARNING_KEY
  } = {}
) {
  if (!isShortOnlyRow(outcome)) {
    return {
      ...outcome,
      source: normalizeSource(source),
      weekKey,
      skipped: true,
      reason: 'NON_SHORT_OUTCOME_SKIPPED_SHORT_ONLY',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const src = normalizeSource(source);

  const netOutcome = ensureNetOutcome(withAnalyzeIdentityFlags({
    ...outcome,
    source: src,
    weekKey,
    strategyVersion: CONFIG.strategyVersion,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    virtualOnly: outcome.virtualOnly !== false,
    paperOnly: true,
    virtualTracked: outcome.virtualTracked !== false,
    shadowOnly: outcome.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  }));

  const row = hasLockedOutcomeIdentity(netOutcome)
    ? buildLockedOutcomeRow(netOutcome)
    : enrichWithMicroFamily(netOutcome);

  if (!row) {
    return {
      ...netOutcome,
      source: src,
      weekKey,
      skipped: true,
      reason: 'SHORT_ONLY_CLASSIFICATION_SKIPPED_OR_EXACT_75_CHILD_MISSING',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const microFamilyId = normalizeChildTrueMicroFamilyId(row.trueMicroFamilyId || row.microFamilyId || row.childTrueMicroFamilyId);

  if (!microFamilyId) {
    return {
      ...row,
      source: src,
      weekKey,
      skipped: true,
      reason: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED_FOR_OUTCOME',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const parentTrueMicroFamilyId = normalizeParentTrueMicroFamilyId(
    row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || microFamilyId,
    row
  );

  const micros = await getWeekMicros(weekKey);

  const micro = getOrCreateMicro(
    micros,
    {
      ...row,
      microFamilyId,
      trueMicroFamilyId: microFamilyId,
      childTrueMicroFamilyId: microFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentTrueMicroFamilyId
    },
    TARGET_DASHBOARD_SIDE
  );

  updateOutcome(micro, withAnalyzeIdentityFlags({
    ...row,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    source: src,
    outcomeSource: OUTCOME_SOURCE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    virtualOnly: true,
    paperOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    netR: safeNumber(row.netR ?? row.exitR, 0),
    exitR: safeNumber(row.exitR ?? row.netR, 0),
    realizedR: safeNumber(row.realizedR ?? row.netR ?? row.exitR, 0),
    r: safeNumber(row.r ?? row.netR ?? row.exitR, 0),

    costR: safeNumber(row.costR, 0),
    avgCostR: safeNumber(row.avgCostR ?? row.costR, 0),
    grossR: safeNumber(row.grossR, 0),

    costModelApplied: Boolean(row.costModelApplied),
    netCostModelApplied: Boolean(row.netCostModelApplied),

    outcomeIdentityLocked: true,
    outcomeIdentitySource: row.outcomeIdentitySource || 'POSITION_MICRO_IDENTITY'
  }), src);

  Object.assign(micro, analyzeIdentityFlags());

  await saveWeekMicros(
    weekKey,
    micros,
    {
      onlyIds: [microFamilyId]
    }
  );

  return withAnalyzeIdentityFlags({
    ...row,
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    source: src,
    outcomeSource: OUTCOME_SOURCE,
    weekKey,
    recordedAt: now(),
    mirrorOutcomeRecorded: false,
    mirrorMicroFamilyId: null
  });
}

export async function createShadowPosition() {
  return {
    ok: false,
    created: false,
    skipped: true,
    reason: 'SHADOW_POSITION_CREATION_MOVED_TO_POSITION_ENGINE_VIRTUAL_TRACKING'
  };
}

function inferDirectToSL({ position, exitReason }) {
  const reason = upper(exitReason);

  const mfeR = safeNumber(position.mfeR, 0);
  const maeR = safeNumber(position.maeR, 0);

  const stoppedOut = [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS'
  ].includes(reason);

  return Boolean(position.directToSL) ||
    (
      stoppedOut &&
      mfeR < 0.25 &&
      maeR <= -0.8
    );
}

function copyMicroClassificationFields(position = {}) {
  const childFromPosition = normalizeChildTrueMicroFamilyId(
    position.trueMicroFamilyId ||
      position.microFamilyId ||
      position.childTrueMicroFamilyId
  );

  const taxonomy = childFromPosition
    ? parseShortTaxonomyMicroId(childFromPosition)
    : extractFixedTaxonomyMicroId(position, position);

  const microFamilyId = childFromPosition || taxonomy?.trueMicroFamilyId || '';
  const parsed = parseShortTaxonomyMicroId(microFamilyId);

  if (!parsed.isChild) {
    return withAnalyzeIdentityFlags({
      outcomeIdentityLocked: false,
      outcomeIdentitySource: 'POSITION_MICRO_IDENTITY_MISSING',
      learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
      symbolExcludedFromFamilyId: true
    });
  }

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;

  return withAnalyzeIdentityFlags({
    familyId: position.familyId || 'SHORT_FIXED_TAXONOMY',

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    broadTrueMicroFamilyId: microFamilyId,
    broadTrueDefinitionParts: position.broadTrueDefinitionParts || [],

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    executionFingerprintHash: position.executionFingerprintHash || null,
    executionFingerprintParts: position.executionFingerprintParts || [],
    executionFingerprintSchema: position.executionFingerprintSchema || null,
    executionMicroFamilyId: position.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',

    scannerMicroFamilyId: position.scannerMicroFamilyId || null,
    scannerFamilyId: position.scannerFamilyId || null,
    scannerDefinition: position.scannerDefinition || null,
    scannerDefinitionParts: position.scannerDefinitionParts || [],
    scannerFingerprintRole: 'METADATA_ONLY',

    definitionParts: position.definitionParts || [],
    definition: position.definition || null,

    parentDefinition: position.parentDefinition || null,
    parentDefinitionParts: position.parentDefinitionParts || [],

    schema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    version: 'short-fixed-taxonomy-75-child',

    assetClass: position.assetClass || null,

    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,

    obRelation: position.obRelation || null,
    obBias: position.obBias ?? null,
    obImbalance: position.obImbalance ?? null,
    orderbookImbalance: position.orderbookImbalance ?? null,
    bookImbalance: position.bookImbalance ?? null,
    bidAskImbalance: position.bidAskImbalance ?? null,

    btcState: position.btcState || null,
    btcRelation: position.btcRelation || null,

    flow: position.flow || null,
    flowCoarse: position.flowCoarse || null,

    regime: position.regime || null,
    regimeCoarse: position.regimeCoarse || null,

    confluence: position.confluence ?? null,
    sniperScore: position.sniperScore ?? null,

    scannerReason: position.scannerReason || null,
    scannerReasonCoarse: position.scannerReasonCoarse || null,

    spreadPct: position.spreadPct ?? null,
    exitSpreadPct: position.exitSpreadPct ?? null,
    spreadBps: position.spreadBps ?? null,

    volBucket: position.volBucket ?? null,
    volumeBucket: position.volumeBucket ?? null,
    volumeScore: position.volumeScore ?? null,
    relativeVolume: position.relativeVolume ?? null,
    volumeSpike: position.volumeSpike ?? null,
    volumeConfirmed: position.volumeConfirmed ?? null,
    quoteVolumeSpike: position.quoteVolumeSpike ?? null,

    atrPct: position.atrPct ?? null,
    volatilityPct: position.volatilityPct ?? null,
    rangePct: position.rangePct ?? null,
    realizedVolPct: position.realizedVolPct ?? null,

    costR: position.costR ?? position.estimatedCostR ?? null,
    avgCostR: position.avgCostR ?? null,
    estimatedCostR: position.estimatedCostR ?? null,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY'
  });
}

export function buildOutcomeFromPosition({
  position,
  exitPrice,
  exitReason,
  source = OUTCOME_SOURCE
}) {
  if (!position) {
    throw new Error('POSITION_REQUIRED_FOR_OUTCOME');
  }

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);
  const tp = safeNumber(position.tp, 0);

  const riskShapeValid = validShortRiskShape({
    entry,
    initialSl,
    tp
  });

  const riskPct =
    safeNumber(position.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = calcGrossMovePct({
    side: TARGET_TRADE_SIDE,
    entry,
    exit
  });

  const grossR = riskShapeValid
    ? calcShortGrossR({
      entry,
      initialSl,
      exit
    })
    : 0;

  const currentR = calcShortCurrentR({
    entry,
    initialSl,
    currentPrice: exit
  });

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct, 0),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const costR = safeNumber(cost.costR, 0);
  const netR = safeNumber(cost.netR, grossR - costR);
  const closedAt = now();
  const src = normalizeSource(source);
  const classification = copyMicroClassificationFields(position);

  return withAnalyzeIdentityFlags({
    type: 'OUTCOME',
    source: src,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || 'VIRTUAL',

    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    virtualOnly: true,
    paperOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    ...classification,

    entry,
    exit,
    exitPrice: exit,
    sl: safeNumber(position.sl, 0),
    initialSl,
    tp,
    rr: safeNumber(position.rr, 0),
    riskPct,

    validShortRiskShape: riskShapeValid,
    shortRiskShapeValid: riskShapeValid,
    exitReason,

    grossMovePct,

    grossR,
    rawR: grossR,
    realizedGrossR: grossR,
    grossPnlPct: safeNumber(cost.grossPnlPct, grossMovePct),

    currentR,

    exitR: netR,
    pnlPct: safeNumber(cost.netPnlPct, 0),
    netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,
    netPnlPct: safeNumber(cost.netPnlPct, 0),

    costR,
    avgCostR: costR,
    costPct: safeNumber(cost.costPct, 0),
    feePct: safeNumber(cost.feePct, 0),
    slippagePct: safeNumber(cost.slippagePct, 0),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: 'APPLY_COSTS_NET_R_V1',

    mfeR: safeNumber(position.mfeR, 0),
    maeR: safeNumber(position.maeR, 0),

    directToSL: inferDirectToSL({
      position,
      exitReason
    }),

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    openedAt: position.openedAt || position.createdAt || null,
    closedAt,
    completedAt: closedAt
  });
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}