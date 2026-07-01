// ================= FILE: src/analyze/analyzeEngine.js =================
//
// SHORT-only Analyze engine.
//
// Meetlat-fix:
// - avgCostR wordt gebaseerd op echte costR.
// - directSL wordt correct afgeleid en doorgegeven.
// - seen-spam wordt geblokkeerd via echte observation dedupe.
// - completed = alleen gesloten virtual/shadow outcomes.
// - scoring gebruikt netR na kosten.
// - wins/losses/flats worden bepaald op netR.
// - outcome dedupe gebruikt stabiele close identity, niet random outcomeId.
// - first-touch / conservative SL metadata uit positionEngine blijft bewaard.
//
// Selectie-fix:
// - Geen pure “beste van de week” selectie meer.
// - Weekly candidates komen uit lifetime/learning stats.
// - Eligible vereist LCB95(avgR) > 0, positieve net edge, sample, PF, directSL en cost-gate.
// - currentFit is zacht voor learning, maar hard/optioneel voor selectie via hook.
// - Ranking gebruikt eligible → avgRLCB95 → totalR → avgR.
// - Dit voorkomt winner’s curse op kleine weekly samples.
//
// Architectuur:
// - Parent 15 blijft breed voor sample-bescherming.
// - Micro 75 blijft context/rollup.
// - Micro-micro wordt afgeleid uit execution fingerprint en is exact selecteerbaar.
// - Discord moet later exact op micro-micro matchen.
// - CurrentFit is zacht en blokkeert geen virtual/shadow learning.
//
// Core identity:
// - Parent:      MICRO_SHORT_{SETUP}_{REGIME}
// - Micro:       MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - Micro-micro: MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
// - Scanner buckets, symbol/coin/hash are metadata only.
// - XR execution fingerprint blijft metadata, maar dezelfde hash maakt MM identity.

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
  classifyMacroFamily,
  isMicroFamilyV1Id,
  isMicroFamilyV2Id
} from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats,
  getWeeklyTradingCandidates as scoreWeeklyTradingCandidates
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

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const SELECTION_PARENT_CONTEXT = 'PARENT_15_CONTEXT_ONLY';
const SELECTION_EXACT_75_CHILD = 'EXACT_75_CHILD';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_STABLE_OUTCOME_DEDUPE_V3_LCB_SELECTION';
const POSITION_MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_V4';
const CLASSIFIER_VERSION = 'SHORT_STRICT_EVIDENCE_DISTRIBUTION_V2';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_MICRO_MICRO_LAYERING_V1';
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_CHILD_MICRO_ENTRY_V3';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_STABLE_CLOSED_POSITION_CHILD_MICRO_V4';
const SELECTION_ENGINE_VERSION = 'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V1';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

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

const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const REAL_VOLUME_FIELDS = Object.freeze([
  'volBucket',
  'volumeBucket',
  'volumeScore',
  'relativeVolume',
  'volumeSpike',
  'volumeConfirmed',
  'quoteVolumeSpike'
]);

const NOT_VOLUME_FIELDS = Object.freeze([
  'volatilityTier',
  'atrPct',
  'rangePct',
  'realizedVolPct',
  'volume24h',
  'tickerVolume24h',
  'candleVolume24h'
]);

const LEGACY_SETUP_ALIASES = {
  BO: 'BREAKOUT',
  BREAK: 'BREAKOUT',
  BREAK_OUT: 'BREAKOUT',
  BREAKOUT_SHORT: 'BREAKOUT',
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
  CONTRA: 'E_WEAK_CONTRA'
};

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function shortKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function normalizeSource(source) {
  const raw = upper(source || OUTCOME_SOURCE);

  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'VIRTUAL') return 'VIRTUAL';

  return OUTCOME_SOURCE;
}

function obsDedupeTtlSec() {
  return Math.max(
    60,
    Math.floor(safeNumber(CONFIG?.analyze?.obsDedupeTtlSec, 60 * 60 * 24))
  );
}

function outcomeDedupeTtlSec() {
  return Math.max(
    60,
    Math.floor(safeNumber(CONFIG?.analyze?.outcomeDedupeTtlSec, 60 * 60 * 24 * 14))
  );
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
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizeCurrentFitValue(value = '') {
  const text = upper(value);

  if (!text) return 'UNKNOWN';

  if (
    text === 'MATCH' ||
    text === 'FIT' ||
    text === 'ALIGNED' ||
    text === 'CURRENT_MATCH' ||
    text === 'MARKET_MATCH'
  ) {
    return 'MATCH';
  }

  if (
    text.includes('MISFIT') ||
    text.includes('NO_MATCH') ||
    text.includes('MISMATCH') ||
    text.includes('AGAINST')
  ) {
    return 'MISFIT';
  }

  if (text.includes('MATCH') || text.includes('ALIGNED')) return 'MATCH';

  return text;
}

function currentFitLookupFromStoredRow(row = {}) {
  const direct = normalizeCurrentFitValue(
    row.currentFit ??
      row.entryCurrentFit ??
      row.marketFit ??
      row.currentMarketFit ??
      row.currentFitStatus ??
      row.entryCurrentFitNormalized ??
      ''
  );

  if (direct === 'MATCH' || direct === 'MISFIT') return direct;

  const recentOutcomes = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  for (let i = recentOutcomes.length - 1; i >= 0; i -= 1) {
    const outcome = recentOutcomes[i];
    const fit = normalizeCurrentFitValue(
      outcome?.entryCurrentFitNormalized ??
        outcome?.entryCurrentFit ??
        outcome?.currentFit ??
        outcome?.marketFit ??
        ''
    );

    if (fit === 'MATCH' || fit === 'MISFIT') return fit;
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
    value.startsWith('LONG_SCANNER_') ||
    value.includes('LONG_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  if (isFixedTaxonomyMicroMicroId(value)) return false;

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
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
    setup,
    regime,
    confirmationProfile,
    setupType: setup,
    regimeBucket: regime,
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

function isFixedTaxonomyChildMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isFixedTaxonomyParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedTaxonomyMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isFixedTaxonomyLearningId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.isParent || parsed.isChild || parsed.isMicroMicro;
}

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function symbolTokensFromRow(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
}

function removeSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  const taxonomy = parseShortTaxonomyMicroId(raw);

  if (taxonomy.valid) return upper(raw);

  const tokens = symbolTokensFromRow(row);

  if (!tokens.length) return raw;

  let next = raw;

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    next = next
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'), '$1ASSET$2');
  }

  return next
    .replace(/_{2,}/g, '_')
    .replace(/\|{2,}/g, '|')
    .replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '') || raw;
}

function isMicroFamilyV3Id(id = '') {
  const value = upper(id);
  return value.startsWith('MICRO_SHORT_') && value.includes('_MF_V3_');
}

function normalizeAnalyzeFamilyId(id = '', row = {}, {
  allowParent = true,
  requireChild = false,
  allowMicroMicro = true
} = {}) {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (!validLearningId(raw)) return '';

  const parsed = parseShortTaxonomyMicroId(raw);

  if (parsed.isMicroMicro) return allowMicroMicro && !requireChild ? parsed.microMicroFamilyId : '';
  if (parsed.isChild) return parsed.childTrueMicroFamilyId;
  if (parsed.isParent) return requireChild ? '' : allowParent ? parsed.parentTrueMicroFamilyId : '';

  if (isMicroFamilyV1Id(raw) || isMicroFamilyV2Id(raw) || isMicroFamilyV3Id(raw)) {
    return removeSymbolTokensFromFamilyId(raw, row);
  }

  return removeSymbolTokensFromFamilyId(raw, row);
}

function normalizeChildTrueMicroFamilyId(id = '', row = {}) {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return parsed.childTrueMicroFamilyId || '';

  const normalized = normalizeAnalyzeFamilyId(id, row, {
    allowParent: false,
    requireChild: true,
    allowMicroMicro: false
  });

  return isFixedTaxonomyChildMicroId(normalized) ? normalized : '';
}

function normalizeParentTrueMicroFamilyId(id = '', row = {}) {
  const parsedRaw = parseShortTaxonomyMicroId(id);

  if (parsedRaw.isMicroMicro || parsedRaw.isChild || parsedRaw.isParent) {
    return parsedRaw.parentTrueMicroFamilyId || '';
  }

  const normalized = normalizeAnalyzeFamilyId(id, row, {
    allowParent: true,
    requireChild: false,
    allowMicroMicro: true
  });

  const parsed = parseShortTaxonomyMicroId(normalized);

  if (parsed.isMicroMicro || parsed.isChild || parsed.isParent) {
    return parsed.parentTrueMicroFamilyId || '';
  }

  const child = normalizeChildTrueMicroFamilyId(
    row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microMicroFamilyId ||
      '',
    row
  );

  return parseShortTaxonomyMicroId(child).parentTrueMicroFamilyId || '';
}

function normalizeMicroMicroFamilyId(id = '', row = {}) {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return parsed.microMicroFamilyId;

  const direct = String(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      ''
  ).trim();

  const parsedDirect = parseShortTaxonomyMicroId(direct);

  if (parsedDirect.isMicroMicro) return parsedDirect.microMicroFamilyId;

  const childId = normalizeChildTrueMicroFamilyId(
    row.childTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      parsed.childTrueMicroFamilyId ||
      '',
    row
  );

  if (!childId) return '';

  const directHash = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  ).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');

  if (directHash && directHash.length >= 6) {
    return `${childId}_${MICRO_MICRO_SUFFIX}_${directHash.slice(0, MICRO_MICRO_HASH_LEN)}`;
  }

  const executionId = String(
    row.executionMicroFamilyId ||
      row.executionFingerprintMicroFamilyId ||
      row.refinedExecutionMicroFamilyId ||
      ''
  ).trim().toUpperCase();

  const xrMatch = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,24})$/u.exec(executionId);

  if (xrMatch) {
    const base = parseShortTaxonomyMicroId(xrMatch[1]);

    if (base.isChild) {
      return `${base.childTrueMicroFamilyId}_${MICRO_MICRO_SUFFIX}_${xrMatch[2].slice(0, MICRO_MICRO_HASH_LEN)}`;
    }
  }

  return '';
}

function normalizeLearningFamilyId(id = '', row = {}, { allowParent = true } = {}) {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
  if (parsed.isChild) return parsed.childTrueMicroFamilyId;
  if (parsed.isParent && allowParent) return parsed.parentTrueMicroFamilyId;

  const microMicroId = normalizeMicroMicroFamilyId(id, row);

  if (microMicroId) return microMicroId;

  const childId = normalizeChildTrueMicroFamilyId(id, row);

  if (childId) return childId;

  const parentId = normalizeParentTrueMicroFamilyId(id, row);

  if (allowParent && parentId) return parentId;

  return '';
}

function buildMicroMicroFamilyIdFromExecution(childTrueMicroFamilyId, executionFingerprintHash) {
  const childId = normalizeChildTrueMicroFamilyId(childTrueMicroFamilyId);
  const hash = String(executionFingerprintHash || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);

  if (!childId || hash.length < 6) return '';

  return `${childId}_${MICRO_MICRO_SUFFIX}_${hash}`;
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
  if (raw.includes('SWEEP') || raw.includes('REVERSAL') || raw.includes('LIQUIDITY')) return 'SWEEP_REVERSAL';
  if (raw.includes('RETEST') || raw.includes('PULLBACK') || raw.includes('PULL_BACK')) return 'RETEST';
  if (raw.includes('COMPRESSION') || raw.includes('SQUEEZE') || raw.includes('COIL')) return 'COMPRESSION';
  if (raw.includes('BREAKOUT') || raw.includes('BREAK_OUT')) return 'BREAKOUT';
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
  if (raw.includes('SQUEEZE') || raw.includes('TIGHT_RANGE') || raw.includes('VOL_SQUEEZE')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE')) return 'TREND';

  return null;
}

function normalizeConfirmationProfile(value = '') {
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
  if (raw.includes('VOLUME') || raw.includes('VOL_') || raw.includes('OB_VOLUME')) return 'C_VOLUME_ALIGN';
  if (raw.includes('MIXED') || raw.includes('OK') || raw.includes('NEUTRAL')) return 'D_MIXED_OK';
  if (raw.includes('WEAK') || raw.includes('CONTRA')) return 'E_WEAK_CONTRA';

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

function exactChildIdentityFromSource(row = {}, classified = {}) {
  const candidates = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    classified.childTrueMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId,
    classified.microMicroFamilyId,
    classified.trueMicroMicroFamilyId,
    classified.exactMicroMicroFamilyId
  ];

  for (const candidate of candidates) {
    const parsed = parseShortTaxonomyMicroId(candidate);

    if (parsed.isMicroMicro || parsed.isChild) {
      return {
        ...parsed,
        setupType: parsed.setup,
        regimeBucket: parsed.regime,
        confirmationProfile: parsed.confirmationProfile,
        trueMicroFamilyId: parsed.childTrueMicroFamilyId,
        microFamilyId: parsed.childTrueMicroFamilyId,
        childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        microMicroFamilyId: parsed.microMicroFamilyId || null,
        trueMicroMicroFamilyId: parsed.microMicroFamilyId || null,
        exactMicroMicroFamilyId: parsed.microMicroFamilyId || null,
        fixedTaxonomyLearningId: true,
        source: parsed.isMicroMicro ? 'EXPLICIT_MICRO_MICRO_ID' : 'EXPLICIT_EXACT_75_CHILD_ID'
      };
    }
  }

  return null;
}

function definitionText(row = {}, classified = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.entryQuality,
    classified.definition,
    classified.microDefinition,
    classified.macroDefinition,
    classified.parentDefinition,
    classified.scannerReason,
    classified.reason,
    classified.signalReason,
    classified.entryQuality,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : []),
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(classified.microDefinitionParts) ? classified.microDefinitionParts : []),
    ...(Array.isArray(classified.executionFingerprintParts) ? classified.executionFingerprintParts : []),
    ...(Array.isArray(classified.microMicroDefinitionParts) ? classified.microMicroDefinitionParts : [])
  ]
    .map(upper)
    .filter(Boolean)
    .join('|');
}

function valueText(...values) {
  return values
    .map(upper)
    .filter(Boolean)
    .join('|');
}

function hasAnyText(text = '', needles = []) {
  const raw = upper(text);
  return needles.some((needle) => raw.includes(needle));
}

function boolish(...values) {
  return values.some((value) => bool(value, false));
}

function realVolumeEvidence(row = {}, classified = {}) {
  const text = valueText(
    row.volBucket,
    row.volumeBucket,
    classified.volBucket,
    classified.volumeBucket
  );

  const bucketVolume =
    hasAnyText(text, [
      'VOL_EXP',
      'VOLUME_EXP',
      'HIGH_VOLUME',
      'VOLUME_HIGH',
      'VOL_HIGH',
      'SPIKE',
      'SURGE',
      'EXPANSION',
      'CONFIRMED',
      'STRONG'
    ]) &&
    !hasAnyText(text, [
      'LOW',
      'NONE',
      'NO_VOLUME',
      'VOL_EXP_LOW'
    ]);

  const volumeScore = safeNumber(
    row.volumeScore ?? classified.volumeScore,
    0
  );

  const relativeVolume = safeNumber(
    row.relativeVolume ?? classified.relativeVolume,
    0
  );

  const volumeSpike = safeNumber(
    row.volumeSpike ?? classified.volumeSpike,
    0
  );

  const quoteVolumeSpike = safeNumber(
    row.quoteVolumeSpike ?? classified.quoteVolumeSpike,
    0
  );

  const confirmed = boolish(
    row.volumeConfirmed,
    row.volumeSpikeConfirmed,
    classified.volumeConfirmed,
    classified.volumeSpikeConfirmed
  );

  const scoreVolume =
    volumeScore >= 60 ||
    relativeVolume >= 1.25 ||
    volumeSpike >= 1.25 ||
    quoteVolumeSpike >= 1.25;

  const evidence = Boolean(
    confirmed ||
    bucketVolume ||
    scoreVolume
  );

  return {
    evidence,
    confirmed,
    bucketVolume,
    scoreVolume,
    volumeScore,
    relativeVolume,
    volumeSpike,
    quoteVolumeSpike,
    fieldsUsed: REAL_VOLUME_FIELDS,
    fieldsNotUsed: NOT_VOLUME_FIELDS
  };
}

function bearishFlowEvidence(row = {}, classified = {}) {
  const flowText = valueText(
    row.flow,
    row.flowCoarse,
    row.flowBucket,
    row.momentumBucket,
    row.obRelation,
    row.btcRelation,
    classified.flow,
    classified.flowCoarse,
    classified.flowBucket,
    classified.momentumBucket,
    classified.obRelation,
    classified.btcRelation
  );

  const flowScore = safeNumber(
    row.flowScore ??
      row.flowStrength ??
      row.momentumScore ??
      classified.flowScore ??
      classified.flowStrength ??
      classified.momentumScore,
    0
  );

  const negativeChange =
    safeNumber(row.change1h ?? classified.change1h, 0) < -0.15 ||
    safeNumber(row.change24h ?? classified.change24h, 0) < -0.5;

  const explicitBearish =
    hasAnyText(flowText, [
      'BEAR',
      'ASK',
      'WITH',
      'TREND',
      'IMPULSE',
      'BUILDING',
      'MOM_WITH',
      'FLOW_WITH',
      'OB_ASK',
      'RSI_WITH',
      'FUNDING_WITH'
    ]) ||
    boolish(
      row.flowAlign,
      row.momentumAlign,
      row.askFlowAlign,
      classified.flowAlign,
      classified.momentumAlign,
      classified.askFlowAlign
    );

  const explicitBullish =
    hasAnyText(flowText, [
      'BULL',
      'BID',
      'AGAINST',
      'UP',
      'MOM_AGAINST',
      'FLOW_AGAINST',
      'OB_BID',
      'RSI_AGAINST',
      'FUNDING_AGAINST'
    ]) ||
    boolish(
      row.flowAgainst,
      row.bullishFlow,
      row.bidFlowAlign,
      classified.flowAgainst,
      classified.bullishFlow,
      classified.bidFlowAlign
    );

  return {
    evidence: Boolean((explicitBearish || flowScore >= 55 || negativeChange) && !explicitBullish),
    explicitBearish,
    explicitBullish,
    flowScore,
    negativeChange
  };
}

function structureEvidence(row = {}, classified = {}) {
  const text = definitionText(row, classified);

  const sweep = boolish(
    row.sweepConfirmed,
    row.liquiditySweep,
    row.stopRun,
    row.reversalSetup,
    classified.sweepConfirmed,
    classified.liquiditySweep,
    classified.stopRun,
    classified.reversalSetup
  ) || hasAnyText(text, [
    'SWEEP',
    'LIQUIDITY',
    'STOP_RUN',
    'REVERSAL'
  ]);

  const retest = boolish(
    row.retestConfirmed,
    row.pullbackConfirmed,
    row.retestSetup,
    row.pullbackSetup,
    classified.retestConfirmed,
    classified.pullbackConfirmed,
    classified.retestSetup,
    classified.pullbackSetup
  ) || hasAnyText(text, [
    'RETEST',
    'PULLBACK',
    'PULL_BACK'
  ]);

  const compression = boolish(
    row.squeezeBreak,
    row.compressionBreak,
    row.volCompression,
    row.rangeCompression,
    row.compressionSetup,
    classified.squeezeBreak,
    classified.compressionBreak,
    classified.volCompression,
    classified.rangeCompression,
    classified.compressionSetup
  ) || hasAnyText(text, [
    'COMPRESSION_SETUP',
    'SQUEEZE_SETUP',
    'COIL',
    'TIGHT_RANGE_SETUP'
  ]);

  const breakout = boolish(
    row.breakoutConfirmed,
    row.breakoutSetup,
    row.newLowBreakout,
    classified.breakoutConfirmed,
    classified.breakoutSetup,
    classified.newLowBreakout
  ) || (
    hasAnyText(text, ['BREAKOUT', 'BREAK_OUT', 'VALID_BREAKOUT']) &&
    !boolish(row.fakeBreakout, row.fakeBreakoutRisk, classified.fakeBreakout, classified.fakeBreakoutRisk)
  );

  const continuation = boolish(
    row.continuationSetup,
    row.trendContinuation,
    classified.continuationSetup,
    classified.trendContinuation
  ) || hasAnyText(text, [
    'CONTINUATION',
    'TREND_CONT',
    'MOMENTUM_CONT'
  ]);

  return {
    sweep,
    retest,
    compression,
    breakout,
    continuation,
    any: Boolean(sweep || retest || compression || breakout || continuation)
  };
}

function contraEvidence(row = {}, classified = {}) {
  const text = definitionText(row, classified);

  const btcAgainst =
    upper(row.btcRelation || classified.btcRelation) === 'BTC_AGAINST' ||
    hasAnyText(text, ['BTC_AGAINST']);

  const obAgainst =
    upper(row.obRelation || classified.obRelation) === 'AGAINST' ||
    hasAnyText(text, ['OB_REL=AGAINST', 'OB_BID', 'BID_HEAVY']);

  const flow = bearishFlowEvidence(row, classified);

  const hardContra = Boolean(
    boolish(
      row.avoidShort,
      row.weakContra,
      row.contraSignal,
      row.bullishDivergence,
      row.fakeBreakout,
      row.fakeBreakoutRisk,
      row.flowAgainst,
      classified.avoidShort,
      classified.weakContra,
      classified.contraSignal,
      classified.bullishDivergence,
      classified.fakeBreakout,
      classified.fakeBreakoutRisk,
      classified.flowAgainst
    ) ||
    btcAgainst ||
    obAgainst ||
    flow.explicitBullish ||
    hasAnyText(text, [
      'AVOID_SHORT',
      'BULLISH_CONTRA',
      'CONTRA',
      'FAKE_BREAKOUT',
      'FAKE_RISK',
      'FLOW_AGAINST'
    ])
  );

  const softContra = Boolean(
    !hardContra &&
    (
      safeNumber(row.confluence ?? row.sniperScore ?? classified.confluence, 0) < 35 ||
      hasAnyText(text, ['WEAK', 'LOW_CONFLUENCE'])
    )
  );

  return {
    hardContra,
    softContra,
    btcAgainst,
    obAgainst,
    flowAgainst: flow.explicitBullish
  };
}

function inferSetupType(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);

  if (exact?.setup) return exact.setup;

  const fromFields = firstNormalizedSetup(
    classified.setupType,
    classified.setup,
    classified.shortSetup,
    classified.pattern,
    row.setupType,
    row.setup,
    row.shortSetup,
    row.pattern
  );

  if (fromFields) return fromFields;

  const structure = structureEvidence(row, classified);

  if (structure.sweep) return 'SWEEP_REVERSAL';
  if (structure.breakout) return 'BREAKOUT';
  if (structure.retest) return 'RETEST';
  if (structure.compression) return 'COMPRESSION';
  if (structure.continuation) return 'CONTINUATION';

  const flow = bearishFlowEvidence(row, classified);
  const text = definitionText(row, classified);

  if (flow.evidence || hasAnyText(text, ['MOMENTUM', 'TREND'])) {
    return 'CONTINUATION';
  }

  return 'CONTINUATION';
}

function inferRegimeBucket(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);

  if (exact?.regime) return exact.regime;

  const directRegime = firstNormalizedRegime(
    classified.regimeBucket,
    row.regimeBucket,
    classified.marketRegime,
    row.marketRegime
  );

  if (directRegime) return directRegime;

  const text = definitionText(row, classified);

  const explicitSqueeze =
    boolish(
      row.squeezeRegime,
      row.squeezeActive,
      row.volCompression,
      row.rangeCompression,
      classified.squeezeRegime,
      classified.squeezeActive,
      classified.volCompression,
      classified.rangeCompression
    ) ||
    hasAnyText(
      valueText(
        row.regime,
        row.regimeCoarse,
        row.volBucket,
        row.volumeBucket,
        classified.regime,
        classified.regimeCoarse,
        classified.volBucket,
        classified.volumeBucket,
        text
      ),
      [
        'SQUEEZE',
        'VOL_SQUEEZE',
        'TIGHT_RANGE',
        'COMPRESSION_REGIME'
      ]
    );

  if (explicitSqueeze) return 'SQUEEZE';

  const explicitChop =
    boolish(
      row.chopRegime,
      row.rangeRegime,
      row.sidewaysRegime,
      classified.chopRegime,
      classified.rangeRegime,
      classified.sidewaysRegime
    ) ||
    hasAnyText(
      valueText(
        row.regime,
        row.regimeCoarse,
        classified.regime,
        classified.regimeCoarse,
        text
      ),
      [
        'CHOP',
        'RANGE',
        'SIDEWAYS',
        'RANGING',
        'MEAN_REVERT'
      ]
    );

  if (explicitChop) return 'CHOP';

  const flow = bearishFlowEvidence(row, classified);

  const trendText =
    hasAnyText(
      valueText(
        row.regime,
        row.regimeCoarse,
        row.flow,
        row.flowCoarse,
        row.momentumBucket,
        classified.regime,
        classified.regimeCoarse,
        classified.flow,
        classified.flowCoarse,
        classified.momentumBucket,
        text
      ),
      [
        'TREND',
        'TRENDING',
        'IMPULSE',
        'MOM_WITH',
        'FLOW_WITH',
        'BUILDING'
      ]
    );

  if (flow.evidence || trendText) return 'TREND';

  return 'CHOP';
}

function inferConfirmationProfile(row = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(row, classified);

  if (exact?.confirmationProfile) return exact.confirmationProfile;

  const confluence = safeNumber(
    row.confluence ??
      row.sniperScore ??
      classified.confluence ??
      classified.sniperScore,
    0
  );

  const structure = structureEvidence(row, classified);
  const flow = bearishFlowEvidence(row, classified);
  const volume = realVolumeEvidence(row, classified);
  const contra = contraEvidence(row, classified);

  if (contra.hardContra) return 'E_WEAK_CONTRA';
  if (contra.softContra && confluence < 35) return 'E_WEAK_CONTRA';

  if (structure.any && flow.evidence && volume.evidence) {
    return 'A_STRONG_ALIGN';
  }

  if (flow.evidence) {
    return 'B_FLOW_ALIGN';
  }

  if (volume.evidence) {
    return 'C_VOLUME_ALIGN';
  }

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
    selectionGranularity: SELECTION_EXACT_75_CHILD,
    parentSelectionAllowed: false,
    discordSelectionRule: 'EXACT_75_CHILD_OR_MICRO_MICRO',
    fixedTaxonomyLearningId: true,
    exactTrueMicroFamilyRequired: true
  };
}

function extractFixedTaxonomyMicroId(source = {}, classified = {}) {
  const exact = exactChildIdentityFromSource(source, classified);

  if (exact) {
    return taxonomyMetaFromParts({
      setup: exact.setup,
      regime: exact.regime,
      confirmationProfile: exact.confirmationProfile
    });
  }

  const setup = inferSetupType(source, classified);
  const regime = inferRegimeBucket(source, classified);
  const confirmationProfile = inferConfirmationProfile(source, classified);

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
    scannerFingerprintLegacy: false,
    legacyScannerFamilyFallback: false,
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    old25BucketsMetadataOnly: true,
    scannerBucketsUsedAsLearningFamily: false,

    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    exactTrueMicroFamilyRequired: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    fixedTaxonomyPreferred: true,
    fixedTaxonomyLearningId: true,
    fineMicroFamilyAsMetadataOnly: false,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,
    layeredLearningEnabled: true,
    sampleProtectionLayeringEnabled: true,

    selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ONLY',
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    adaptiveShortRiskExpected: true,

    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    observationDedupeRequired: true,
    observationAlwaysCounted: false,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    outcomeDedupeRequired: true,
    stableOutcomeIdentityRequired: true,
    randomOutcomeIdNotUsedForPrimaryDedupe: true,
    completedOnlyClosedVirtualOrShadow: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,

    selectionWillBeAdaptive: true,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionAvoidsWinnerCurse: true,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,
    rankingPrimary: 'eligible|avgRLCB95|totalR|avgR|profitFactor|directSLPct|avgCostR',

    discordWillBeStrict: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      MICRO_MICRO_ACTIVE: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`
    },

    defaultRanking: 'eligible|avgRLCB95|totalR|avgR|fairWinrate|directSLPct|avgCostR',
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    rankingUsesAvgRLCB95: true,
    bareWinrateRankingDisabled: true,

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

    firstTouchPreserved: true,
    conservativeExitPreserved: true,
    candleFirstTouchCompatible: true,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    virtualLearning: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function withAnalyzeIdentityFlags(row = {}) {
  return {
    ...analyzeIdentityFlags(),
    ...row
  };
}

function directSideProbeValues(row = {}, classified = {}) {
  return [
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
  ];
}

function idSideProbeValues(row = {}, classified = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.id,
    row.key,
    classified.familyId,
    classified.family,
    classified.baseFamilyId,
    classified.microFamilyId,
    classified.trueMicroFamilyId,
    classified.childTrueMicroFamilyId,
    classified.microMicroFamilyId,
    classified.trueMicroMicroFamilyId,
    classified.exactMicroMicroFamilyId,
    classified.coarseMicroFamilyId,
    classified.baseMicroFamilyId,
    classified.legacyMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    classified.macroFamilyId,
    classified.parentMacroFamilyId,
    classified.parentMicroFamilyId,
    classified.parentFamilyId,
    classified.macroId
  ];
}

function definitionSideProbeValues(row = {}, classified = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    row.microMicroDefinition,
    classified.definition,
    classified.microDefinition,
    classified.macroDefinition,
    classified.parentDefinition,
    classified.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : []),
    ...(Array.isArray(classified.definitionParts) ? classified.definitionParts : []),
    ...(Array.isArray(classified.microDefinitionParts) ? classified.microDefinitionParts : []),
    ...(Array.isArray(classified.macroDefinitionParts) ? classified.macroDefinitionParts : []),
    ...(Array.isArray(classified.parentDefinitionParts) ? classified.parentDefinitionParts : []),
    ...(Array.isArray(classified.executionFingerprintParts) ? classified.executionFingerprintParts : []),
    ...(Array.isArray(classified.microMicroDefinitionParts) ? classified.microMicroDefinitionParts : [])
  ];
}

function firstResolvedSide(values = []) {
  for (const value of values) {
    const side = sideTextToTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  return 'UNKNOWN';
}

function resolveMixedTextSide(values = [], row = {}) {
  let hasShort = false;
  let hasLong = false;

  for (const value of values) {
    const side = sideTextToTradeSide(value);

    if (side === TARGET_TRADE_SIDE) hasShort = true;
    if (side === OPPOSITE_TRADE_SIDE) hasLong = true;
  }

  if (hasShort && !hasLong) return TARGET_TRADE_SIDE;
  if (hasLong && !hasShort) return OPPOSITE_TRADE_SIDE;

  if (hasShort && hasLong) {
    const explicitIdSide = firstResolvedSide([
      row.microMicroFamilyId,
      row.trueMicroMicroFamilyId,
      row.exactMicroMicroFamilyId,
      row.childTrueMicroFamilyId,
      row.trueMicroFamilyId,
      row.microFamilyId,
      row.id,
      row.key
    ]);

    if (explicitIdSide !== 'UNKNOWN') return explicitIdSide;
    if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
    if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}, classified = {}) {
  const direct = firstResolvedSide(directSideProbeValues(row, classified));

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const idSide = resolveMixedTextSide(idSideProbeValues(row, classified), row);

  if (idSide === TARGET_TRADE_SIDE || idSide === OPPOSITE_TRADE_SIDE) {
    return idSide;
  }

  const definitionSide = resolveMixedTextSide(definitionSideProbeValues(row, classified), row);

  if (definitionSide === TARGET_TRADE_SIDE || definitionSide === OPPOSITE_TRADE_SIDE) {
    return definitionSide;
  }

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortOnlyRow(row = {}, classified = {}) {
  return inferTradeSide(row, classified) === TARGET_TRADE_SIDE;
}

function isTargetShortSide(side) {
  return sideTextToTradeSide(side) === TARGET_TRADE_SIDE;
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
    virtualTracked: row.virtualTracked !== false,
    shadowOnly: row.shadowOnly !== false,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false
  });
}

function normalizeClassifiedSide(classified = {}) {
  return withAnalyzeIdentityFlags({
    ...classified,
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
    shortDisabled: false
  });
}

function normalizeStatsSide() {
  return TARGET_DASHBOARD_SIDE;
}

function getWeekMicrosBaseKey(weekKey) {
  return shortKey(KEYS.analyze.weekMicros(weekKey), `ANALYZE:WEEK_MICROS:${weekKey}`);
}

function getWeekMetaKey(weekKey) {
  return shortKey(KEYS.analyze.weekMeta(weekKey), `ANALYZE:WEEK_META:${weekKey}`);
}

function normalizeEntryDedupeBucket(entry = 0) {
  const n = safeNumber(entry, 0);

  if (n <= 0) return 'NO_ENTRY';

  return n.toFixed(8);
}

function getObsLastKey(snapshotId, symbol, microFamilyId, entry = 0) {
  const entryBucket = normalizeEntryDedupeBucket(entry);
  const baseFromKeys =
    typeof KEYS.analyze?.obsLast === 'function'
      ? KEYS.analyze.obsLast(snapshotId, symbol, microFamilyId)
      : null;

  const baseKey = shortKey(
    baseFromKeys,
    `ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${microFamilyId}`
  );

  return `${baseKey}:ENTRY:${entryBucket}`;
}

function getOutcomeLastKey(weekKey, outcomeIdentity, microFamilyId) {
  const fromKeys =
    typeof KEYS.analyze?.outcomeLast === 'function'
      ? KEYS.analyze.outcomeLast(weekKey, outcomeIdentity, microFamilyId)
      : null;

  return shortKey(
    fromKeys,
    `ANALYZE:OUTCOME_LAST:${weekKey}:${outcomeIdentity}:${microFamilyId}`
  );
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

function getWeekTradingCandidatesKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TRADING_CANDIDATES`;
}

async function claimDedupeKey(redis, key, ttlSec, {
  type = 'DEDUPE'
} = {}) {
  if (!key) {
    return {
      claimed: true,
      duplicate: false,
      method: 'NO_KEY',
      key: null,
      type
    };
  }

  const value = String(now());

  const setAttempts = [
    { ex: ttlSec, nx: true },
    { ex: ttlSec, NX: true },
    { EX: ttlSec, NX: true }
  ];

  for (const options of setAttempts) {
    try {
      const result = await redis.set(key, value, options);

      if (result === null || result === false) {
        return {
          claimed: false,
          duplicate: true,
          method: 'SET_NX',
          key,
          type
        };
      }

      const raw = String(result).toUpperCase();

      if (result === true || result === 1 || raw === 'OK' || raw === 'QUEUED') {
        return {
          claimed: true,
          duplicate: false,
          method: 'SET_NX',
          key,
          type
        };
      }
    } catch {
      // Try next client option shape.
    }
  }

  try {
    const existing = await redis.get(key).catch(() => null);

    if (existing !== null && existing !== undefined) {
      return {
        claimed: false,
        duplicate: true,
        method: 'GET_THEN_SET',
        key,
        type
      };
    }

    await redis.set(key, value, { ex: ttlSec }).catch(() => null);

    return {
      claimed: true,
      duplicate: false,
      method: 'GET_THEN_SET',
      key,
      type
    };
  } catch {
    return {
      claimed: true,
      duplicate: false,
      method: 'DEDUPE_UNAVAILABLE_FAIL_OPEN',
      key,
      type
    };
  }
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function mergeDefinitionParts(...groups) {
  return uniqueStrings(
    groups.flatMap((group) => {
      if (!group) return [];
      if (Array.isArray(group)) return group;
      return [group];
    })
  );
}

function truncateString(value, maxLength = 480) {
  const text = String(value ?? '');

  if (text.length <= maxLength) return text;

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactDefinitionParts(parts = [], maxItems = 64, maxStringLength = 480) {
  if (!Array.isArray(parts)) return [];

  return parts
    .slice(0, maxItems)
    .map((part) => truncateString(part, maxStringLength))
    .filter(Boolean);
}

function normalizeBucketText(value, fallback = 'NA') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || fallback;
}

function normalizeBroadBucketText(value, fallback = 'NA') {
  const text = normalizeBucketText(value, fallback);

  if (!text || text === 'NA') return fallback;

  return text
    .replace(/VERY_/g, '')
    .replace(/EXTREME_/g, '')
    .replace(/STRONG_/g, '')
    .replace(/WEAK_/g, '')
    .replace(/MIDRANGE/g, 'MID')
    .replace(/NEUTRAL/g, 'MID')
    .replace(/BALANCED/g, 'MID')
    .replace(/SIDEWAYS/g, 'RANGE')
    .slice(0, 32) || fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function hashText(value, length = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
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

  const scannerDefinitionParts = Array.isArray(row.scannerDefinitionParts)
    ? row.scannerDefinitionParts
    : scannerMicroFamilyId && Array.isArray(row.definitionParts)
      ? row.definitionParts
      : [];

  const scannerDefinition = firstDefined(
    row.scannerDefinition,
    scannerMicroFamilyId ? row.definition : null,
    scannerMicroFamilyId ? row.microDefinition : null
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

function buildFixedTaxonomyDefinitionParts(row = {}, classified = {}, taxonomy = {}) {
  const volume = realVolumeEvidence(row, classified);
  const flow = bearishFlowEvidence(row, classified);
  const contra = contraEvidence(row, classified);

  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile}`,
    `RSI=${normalizeBroadBucketText(classified.rsiCoarse || row.rsiCoarse || classified.rsiZone || row.rsiZone || 'NA')}`,
    `FLOW=${normalizeBroadBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,
    `OB_REL=${normalizeBroadBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBroadBucketText(classified.btcState || row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBroadBucketText(classified.btcRelation || row.btcRelation || 'NA')}`,
    `REGIME=${normalizeBroadBucketText(classified.regimeCoarse || row.regimeCoarse || classified.regime || row.regime || taxonomy.regimeBucket || 'NA')}`,
    'STRICT_CLASSIFIER=TRUE',
    `STRUCTURE_EVIDENCE=${structureEvidence(row, classified).any ? 'YES' : 'NO'}`,
    `FLOW_EVIDENCE=${flow.evidence ? 'YES' : 'NO'}`,
    `REAL_VOLUME_EVIDENCE=${volume.evidence ? 'YES' : 'NO'}`,
    `CONTRA_EVIDENCE=${contra.hardContra ? 'HARD' : contra.softContra ? 'SOFT' : 'NO'}`,
    'VOLUME_FIELDS_ALLOWED=volBucket,volumeBucket,volumeScore,relativeVolume,volumeSpike,volumeConfirmed,quoteVolumeSpike',
    'VOLUME_FIELDS_EXCLUDED=volatilityTier,atrPct,rangePct,realizedVolPct,volume24h',
    'CURRENT_FIT_POLARITY=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'CURRENT_FIT_DEFINITION=SHORT_MIRRORED_CURRENT_FIT',
    'CURRENT_FIT_SOFT_ONLY=true',
    'CURRENT_FIT_BLOCKS_LEARNING=false',
    'LEARNING_REMAINS_BROAD=true',
    `MEASUREMENT_FIX=${MEASUREMENT_FIX_VERSION}`,
    `POSITION_MEASUREMENT_FIX=${POSITION_MEASUREMENT_FIX_VERSION}`,
    `RISK_PLAN=${SHORT_RISK_PLAN_VERSION}`,
    'RISK_GEOMETRY=SHORT:tp<entry<sl',
    'OUTCOME_DEDUPE=STABLE_CLOSE_IDENTITY',
    `SELECTION_ENGINE=${SELECTION_ENGINE_VERSION}`,
    'SELECTION_USES_LCB_AVGR=true',
    'SELECTION_USES_WEEKLY_WINNER_ONLY=false'
  ]);
}

function buildParentDefinitionParts(taxonomy = {}) {
  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SETUP=${taxonomy.setupType}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket}`,
    `SCHEMA=${PARENT_TRUE_MICRO_SCHEMA}`,
    `GRANULARITY=${PARENT_LEARNING_GRANULARITY}`,
    'LAYER=PARENT_15',
    'SELECTION=PARENT_CONTEXT_ONLY'
  ]);
}

function buildMicroMicroDefinitionParts(row = {}, classified = {}, taxonomy = {}) {
  return mergeDefinitionParts([
    ...(Array.isArray(classified.executionFingerprintParts) ? classified.executionFingerprintParts : []),
    `MICRO_MICRO=${taxonomy.microMicroFamilyId || classified.microMicroFamilyId || 'NO_MM'}`,
    `MICRO_MICRO_HASH=${taxonomy.microMicroHash || classified.microMicroHash || classified.executionFingerprintHash || 'NO_HASH'}`,
    `CHILD_TRUE_MICRO=${taxonomy.childTrueMicroFamilyId || taxonomy.trueMicroFamilyId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId}`,
    `SCHEMA=${MICRO_MICRO_SCHEMA}`,
    `GRANULARITY=${MICRO_MICRO_LEARNING_GRANULARITY}`,
    'LAYER=MICRO_MICRO',
    'SELECTION=EXACT_MICRO_MICRO',
    'SAMPLE_PROTECTION=ALSO_WRITES_PARENT_AND_MICRO_75',
    `SELECTION_ENGINE=${SELECTION_ENGINE_VERSION}`,
    'SELECTION_RANK=eligible|avgRLCB95|totalR|avgR'
  ]);
}

function buildExecutionFingerprintParts(row = {}, classified = {}, taxonomy = {}) {
  return mergeDefinitionParts([
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.trueMicroFamilyId || 'NO_TRUE_MICRO'}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentTrueMicroFamilyId || 'NO_PARENT_TRUE_MICRO'}`,
    `SETUP=${taxonomy.setupType || 'NA'}`,
    `REGIME_BUCKET=${taxonomy.regimeBucket || 'NA'}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmationProfile || 'NA'}`,
    `RSI=${normalizeBucketText(classified.rsiZone || row.rsiZone || 'NA')}`,
    `FLOW=${normalizeBucketText(classified.flowCoarse || row.flowCoarse || classified.flow || row.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(classified.obRelation || row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(classified.btcState || row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(classified.btcRelation || row.btcRelation || 'NA')}`,
    `REGIME=${normalizeBucketText(classified.regimeCoarse || row.regimeCoarse || classified.regime || row.regime || 'NA')}`,
    `SCANNER=${normalizeBucketText(classified.scannerReasonCoarse || row.scannerReasonCoarse || classified.scannerReason || row.scannerReason || 'NA')}`,
    `SPREAD_BPS=${normalizeBucketText(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${normalizeBucketText(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${normalizeBucketText(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONFLUENCE=${normalizeBucketText(row.confluence ?? row.sniperScore ?? row.scannerScore ?? 'NA')}`,
    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`,
    `ENTRY_DIST=${normalizeBucketText(row.entryDistancePct ?? row.entryDistanceBps ?? 'NA')}`,
    `RISK_PCT=${normalizeBucketText(row.riskPct ?? row.slDistancePct ?? 'NA')}`,
    `REWARD_PCT=${normalizeBucketText(row.rewardPct ?? row.tpDistancePct ?? 'NA')}`,
    `RISK_REWARD_RATIO=${normalizeBucketText(row.riskToRewardDistanceRatio ?? 'NA')}`,
    `FAKE_BREAKOUT=${bool(row.fakeBreakout, false) ? 'YES' : 'NO'}`,
    `FAKE_RISK=${bool(row.fakeBreakoutRisk, false) ? 'YES' : 'NO'}`,
    `RISK_PLAN=${row.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    'EXECUTION_FINGERPRINT_ROLE=MICRO_MICRO_HASH_SOURCE',
    'EXECUTION_FINGERPRINT_USED_AS_LEARNING_FAMILY=true'
  ]);
}

function attachExecutionFingerprintMetadata(classified = {}, row = {}, taxonomy = {}) {
  const enabled = bool(CONFIG?.analyze?.buildExecutionFingerprintMetadata, true) === true;

  if (!enabled) {
    return withAnalyzeIdentityFlags({
      ...classified,
      executionFingerprintHash: null,
      executionFingerprintParts: [],
      executionFingerprintSchema: null,
      executionMicroFamilyId: null,
      executionFingerprintRole: 'DISABLED',
      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,
      microMicroSelectionAllowed: false
    });
  }

  const analyzeMicroFamilyId = normalizeChildTrueMicroFamilyId(
    taxonomy.trueMicroFamilyId ||
      classified.trueMicroFamilyId ||
      classified.microFamilyId,
    row
  );

  if (!analyzeMicroFamilyId) return withAnalyzeIdentityFlags(classified);

  const executionParts = buildExecutionFingerprintParts(row, classified, taxonomy);
  const executionHash = hashText(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);
  const executionMicroFamilyId = `${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`;
  const microMicroFamilyId = buildMicroMicroFamilyIdFromExecution(
    analyzeMicroFamilyId,
    executionHash
  );

  const microMicroDefinitionParts = buildMicroMicroDefinitionParts(
    row,
    {
      ...classified,
      executionFingerprintParts: executionParts,
      executionFingerprintHash: executionHash,
      microMicroFamilyId,
      microMicroHash: executionHash
    },
    {
      ...taxonomy,
      microMicroFamilyId,
      microMicroHash: executionHash,
      childTrueMicroFamilyId: analyzeMicroFamilyId
    }
  );

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
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash: executionHash,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroSelectionAllowed: Boolean(microMicroFamilyId),
    microMicroDefinitionParts,
    microMicroDefinition: microMicroDefinitionParts.join(' | '),
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: Boolean(microMicroFamilyId)
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

  const taxonomy = extractFixedTaxonomyMicroId(
    classifyInput,
    rawClassified
  );

  if (!taxonomy || !taxonomy.trueMicroFamilyId || !taxonomy.parentTrueMicroFamilyId) {
    return null;
  }

  const classified = attachExecutionFingerprintMetadata(
    rawClassified,
    classifyInput,
    taxonomy
  );

  const trueMicroFamilyId = normalizeChildTrueMicroFamilyId(
    taxonomy.trueMicroFamilyId,
    classifyInput
  );

  if (!trueMicroFamilyId) return null;

  const parentTrueMicroFamilyId = taxonomy.parentTrueMicroFamilyId;

  const microMicroFamilyId = normalizeMicroMicroFamilyId(
    classified.microMicroFamilyId ||
      classified.trueMicroMicroFamilyId ||
      classified.exactMicroMicroFamilyId,
    {
      ...classifyInput,
      ...classified,
      childTrueMicroFamilyId: trueMicroFamilyId
    }
  );

  const definitionParts = buildFixedTaxonomyDefinitionParts(
    classifyInput,
    classified,
    taxonomy
  );

  const parentDefinitionParts = buildParentDefinitionParts(taxonomy);

  const microMicroDefinitionParts = microMicroFamilyId
    ? buildMicroMicroDefinitionParts(
      classifyInput,
      classified,
      {
        ...taxonomy,
        childTrueMicroFamilyId: trueMicroFamilyId,
        microMicroFamilyId,
        microMicroHash: classified.microMicroHash || classified.executionFingerprintHash
      }
    )
    : [];

  return withAnalyzeIdentityFlags({
    ...row,
    familyId: classified.familyId || row.familyId || 'SHORT_FIXED_TAXONOMY',

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: classified.microMicroHash || classified.executionFingerprintHash || null,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    fineMicroFamilyId: microMicroFamilyId || classified.fineMicroFamilyId || classified.narrowMicroFamilyId || classified.mfV2MicroFamilyId || null,
    narrowMicroFamilyId: microMicroFamilyId || classified.narrowMicroFamilyId || classified.fineMicroFamilyId || classified.mfV2MicroFamilyId || null,
    mfV2MicroFamilyId: classified.mfV2MicroFamilyId || classified.fineMicroFamilyId || classified.narrowMicroFamilyId || null,

    broadTrueMicroFamilyId: trueMicroFamilyId,
    broadTrueDefinitionParts: definitionParts,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    fixedTaxonomyLearningId: true,
    fineMicroFamilyAsMetadataOnly: false,

    executionFingerprintHash: classified.executionFingerprintHash || null,
    executionFingerprintParts: classified.executionFingerprintParts || [],
    executionFingerprintSchema: classified.executionFingerprintSchema || null,
    executionMicroFamilyId: classified.executionMicroFamilyId || null,
    executionFingerprintRole: classified.executionFingerprintRole || 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: Boolean(microMicroFamilyId),

    microMicroDefinitionParts,
    microMicroDefinition: microMicroDefinitionParts.join(' | '),
    microMicroSelectionAllowed: Boolean(microMicroFamilyId),

    scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
    scannerFamilyId: scannerMetadata.scannerFamilyId,
    scannerDefinition: scannerMetadata.scannerDefinition,
    scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

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
    version: 'fixed-taxonomy-75-child-smart-evidence-v2',
    microMicroVersion: MICRO_MICRO_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    classifierNoDefaultRetestSqueezeB: true,

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

    volumeEvidence: realVolumeEvidence(classifyInput, classified),
    flowEvidence: bearishFlowEvidence(classifyInput, classified),
    structureEvidence: structureEvidence(classifyInput, classified),
    contraEvidence: contraEvidence(classifyInput, classified),

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: safeNumber(row.rr, 0),
    riskPct: safeNumber(row.riskPct, 0),
    rewardPct: safeNumber(row.rewardPct, 0),
    riskToRewardDistanceRatio: safeNumber(row.riskToRewardDistanceRatio, 999),

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
    mirrorOfSide: null,

    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLCBAvgR: true,
    selectionUsesWeeklyWinnerOnly: false
  });
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

function selectionModeForLearningId(id = '') {
  const layer = learningLayerForId(id);

  if (layer === LAYER_MICRO_MICRO) return SELECTION_EXACT_MICRO_MICRO;
  if (layer === LAYER_PARENT_15) return SELECTION_PARENT_CONTEXT;

  return SELECTION_EXACT_75_CHILD;
}

function minCompletedForLearningId(id = '') {
  return learningLayerForId(id) === LAYER_MICRO_MICRO
    ? MIN_COMPLETED_MICRO_MICRO_ACTIVE
    : MIN_COMPLETED_ACTIVE_LEARNING;
}

function getLearningStatus(row = {}) {
  const completed = safeNumber(row.completed || row.outcomeSample, 0);
  const minCompleted = safeNumber(row.minCompletedForActiveLearning, MIN_COMPLETED_ACTIVE_LEARNING);

  if (completed >= minCompleted) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function layerIdsFromClassified(row = {}) {
  const childId = normalizeChildTrueMicroFamilyId(
    row.childTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId,
    row
  );

  const parentId = normalizeParentTrueMicroFamilyId(
    row.parentTrueMicroFamilyId ||
      row.coarseMicroFamilyId ||
      childId,
    row
  );

  const microMicroId = normalizeMicroMicroFamilyId(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId,
    {
      ...row,
      childTrueMicroFamilyId: childId
    }
  );

  return uniqueStrings([
    parentId,
    childId,
    microMicroId
  ])
    .map((id) => normalizeLearningFamilyId(id, row))
    .filter(Boolean)
    .filter(validLearningId)
    .filter(isFixedTaxonomyLearningId);
}

function applyLayerIdentity(row = {}, learningId = '') {
  const id = normalizeLearningFamilyId(learningId, row);

  if (!id) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  if (!parsed.valid) return null;

  const parentId = parsed.parentTrueMicroFamilyId || normalizeParentTrueMicroFamilyId(id, row);

  const childId = parsed.childTrueMicroFamilyId ||
    normalizeChildTrueMicroFamilyId(id, row) ||
    normalizeChildTrueMicroFamilyId(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);

  const microMicroId = parsed.microMicroFamilyId || normalizeMicroMicroFamilyId(id, row);
  const learningLayer = parsed.learningLayer || learningLayerForId(id);
  const schema = schemaForLearningId(id);
  const granularity = granularityForLearningId(id);
  const selectionGranularity = selectionModeForLearningId(id);
  const minCompleted = minCompletedForLearningId(id);

  return withAnalyzeIdentityFlags({
    ...row,

    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,

    childTrueMicroFamilyId: childId || (parsed.isChild ? id : null),
    parentTrueMicroFamilyId: parentId || null,
    coarseMicroFamilyId: parentId || null,
    baseMicroFamilyId: parentId || null,
    legacyMicroFamilyId: parentId || null,
    parentMicroFamilyId: parentId || null,
    macroFamilyId: parentId || null,
    parentMacroFamilyId: parentId || null,

    microMicroFamilyId: microMicroId || null,
    trueMicroMicroFamilyId: microMicroId || null,
    exactMicroMicroFamilyId: microMicroId || null,
    microMicroHash: parsed.microMicroHash || row.microMicroHash || row.executionFingerprintHash || null,

    setupType: parsed.setup || row.setupType || null,
    regimeBucket: parsed.regime || row.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,

    schema,
    microFamilySchema: schema,
    trueMicroFamilySchema: schema,
    exactTrueMicroFamilySchema: schema,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: granularity,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer,
    layer: learningLayer,
    selectionGranularity,

    parentSelectionAllowed: false,
    micro75SelectionAllowed: learningLayer === LAYER_MICRO_75,
    microMicroSelectionAllowed: learningLayer === LAYER_MICRO_MICRO,
    selectable: learningLayer === LAYER_MICRO_75 || learningLayer === LAYER_MICRO_MICRO,
    parentContextOnly: learningLayer === LAYER_PARENT_15,

    minCompletedForActiveLearning: minCompleted,

    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',
    layeredLearningEnabled: true,
    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,
    sampleProtectionLayeringEnabled: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLCBAvgR: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionAvoidsWinnerCurse: true,

    discordSelectionRule: learningLayer === LAYER_MICRO_MICRO
      ? 'EXACT_MICRO_MICRO_ONLY'
      : learningLayer === LAYER_MICRO_75
        ? 'EXACT_75_CHILD_CONTEXT_ONLY'
        : 'PARENT_CONTEXT_NOT_DISCORD_SELECTABLE'
  });
}

function compactExamples(examples = [], maxItems = 8, maxStringLength = 480) {
  if (!Array.isArray(examples) || maxItems <= 0) return [];

  return examples
    .slice(-maxItems)
    .map((example) => {
      if (!example || typeof example !== 'object') {
        return example ?? null;
      }

      const learningId = normalizeLearningFamilyId(
        example.trueMicroFamilyId || example.microFamilyId || example.learningMicroFamilyId,
        example
      );

      if (!learningId) return null;

      const layerRow = applyLayerIdentity(example, learningId);

      return withAnalyzeIdentityFlags({
        ...layerRow,
        symbol: example.symbol || example.baseSymbol || example.contractSymbol || null,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        source: example.source || OBSERVATION_SOURCE,
        rsiZone: example.rsiZone || null,
        flow: example.flow || null,
        obRelation: example.obRelation || null,
        btcRelation: example.btcRelation || null,
        regime: example.regime || null,
        scannerReason: example.scannerReason || null,
        observationDedupeKey: example.observationDedupeKey || null,
        observationRecorded: Boolean(example.observationRecorded),
        observationDuplicate: Boolean(example.observationDuplicate),
        currentFit: normalizeCurrentFitValue(example.currentFit ?? example.entryCurrentFit ?? ''),
        ts: safeNumber(example.ts || example.createdAt, null)
      });
    })
    .filter(Boolean)
    .map((example) => {
      if (typeof example === 'string') return truncateString(example, maxStringLength);
      return example;
    });
}

function compactRecentOutcomes(outcomes = [], maxItems = 8) {
  if (!Array.isArray(outcomes) || maxItems <= 0) return [];

  return outcomes
    .slice(-maxItems)
    .map((outcome) => {
      if (!outcome || typeof outcome !== 'object') return null;
      if (inferTradeSide(outcome) !== TARGET_TRADE_SIDE) return null;

      const learningId = normalizeLearningFamilyId(
        outcome.trueMicroFamilyId || outcome.microFamilyId || outcome.learningMicroFamilyId,
        outcome
      );

      if (!learningId) return null;

      const layerRow = applyLayerIdentity(outcome, learningId);

      return withAnalyzeIdentityFlags({
        ...layerRow,
        source: normalizeSource(outcome.source || OUTCOME_SOURCE),
        positionSource: outcome.positionSource || null,
        tradeId: outcome.tradeId || null,
        outcomeIdentity: outcome.outcomeIdentity || null,
        outcomeDedupeKey: outcome.outcomeDedupeKey || null,
        symbol: outcome.symbol || outcome.baseSymbol || outcome.contractSymbol || null,
        contractSymbol: outcome.contractSymbol || null,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        exitReason: outcome.exitReason || outcome.reason || null,
        exitTrigger: outcome.exitTrigger || null,
        exitPriceSource: outcome.exitPriceSource || null,
        exitRangeStart: outcome.exitRangeStart || null,
        exitRangeEnd: outcome.exitRangeEnd || null,
        firstTouch: outcome.firstTouch || null,
        conservativeExit: Boolean(outcome.conservativeExit),

        exitR: safeNumber(outcome.exitR ?? outcome.netR, 0),
        netR: safeNumber(outcome.netR ?? outcome.exitR, 0),
        grossR: safeNumber(outcome.grossR, 0),
        shortGrossR: safeNumber(outcome.shortGrossR ?? outcome.grossR, 0),

        costR: safeNumber(outcome.costR, 0),
        avgCostR: safeNumber(outcome.avgCostR ?? outcome.costR, 0),
        executionCostR: safeNumber(outcome.executionCostR, 0),
        fundingCostR: safeNumber(outcome.fundingCostR, 0),

        mfeR: safeNumber(outcome.mfeR, 0),
        maeR: safeNumber(outcome.maeR, 0),

        directToSL: Boolean(outcome.directToSL || outcome.directSL),
        directSL: Boolean(outcome.directSL || outcome.directToSL),
        nearTpSeen: Boolean(outcome.nearTpSeen),
        reachedHalfR: Boolean(outcome.reachedHalfR),
        reachedOneR: Boolean(outcome.reachedOneR),

        entryMarketWeather: outcome.entryMarketWeather || null,
        entryCurrentRegime: outcome.entryCurrentRegime || outcome.currentRegime || null,
        entryCurrentTrendSide: outcome.entryCurrentTrendSide || outcome.currentTrendSide || null,
        entryCurrentFit: outcome.entryCurrentFit ?? outcome.currentFit ?? null,
        entryCurrentFitNormalized: normalizeCurrentFitValue(outcome.entryCurrentFit ?? outcome.currentFit ?? null),
        entryCurrentFitConfidence: safeNumber(outcome.entryCurrentFitConfidence ?? outcome.currentMarketFitConfidence, null),

        riskPlanVersion: outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
        rr: safeNumber(outcome.rr, 0),
        riskPct: safeNumber(outcome.riskPct, 0),
        rewardPct: safeNumber(outcome.rewardPct, 0),
        riskToRewardDistanceRatio: safeNumber(outcome.riskToRewardDistanceRatio, 999),

        measurementFixVersion: outcome.measurementFixVersion || MEASUREMENT_FIX_VERSION,
        positionMeasurementFixVersion:
          outcome.positionMeasurementFixVersion ||
          outcome.monitorMeasurementFixVersion ||
          POSITION_MEASUREMENT_FIX_VERSION,

        currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
        currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

        costModelApplied: Boolean(outcome.costModelApplied),
        netCostModelApplied: Boolean(outcome.netCostModelApplied),
        costModel: outcome.costModel || null,

        riskTradeSide: TARGET_TRADE_SIDE,
        riskGeometryRule: 'SHORT: tp < entry < sl',
        tpHitRule: 'SHORT: price <= tp',
        slHitRule: 'SHORT: price >= sl',
        grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
        currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

        ts: safeNumber(
          outcome.ts ||
            outcome.closedAt ||
            outcome.completedAt ||
            outcome.updatedAt,
          now()
        )
      });
    })
    .filter(Boolean);
}

function removeKnownBulkyFields(row = {}) {
  const clean = { ...row };

  const bulkyKeys = [
    'raw',
    'payload',
    'debug',
    'request',
    'response',
    'stack',
    'html',
    'candles',
    'candles15m',
    'candles1h',
    'candles4h',
    'candles1d',
    'orderBook',
    'rawOrderBook',
    'bids',
    'asks',
    'ticks',
    'prices',
    'history',
    'marketData'
  ];

  for (const key of bulkyKeys) {
    delete clean[key];
  }

  return clean;
}

function compactMicroForStorage(row = {}) {
  const initialLearningId = normalizeLearningFamilyId(
    row.trueMicroFamilyId || row.microFamilyId || row.learningMicroFamilyId || row.id || row.key,
    row
  );

  if (!initialLearningId) return null;

  const layeredBeforeRefresh = applyLayerIdentity(
    withAnalyzeIdentityFlags(removeKnownBulkyFields(row)),
    initialLearningId
  );

  if (!layeredBeforeRefresh) return null;

  const refreshed = refreshStats(layeredBeforeRefresh);
  const layered = applyLayerIdentity(refreshed, initialLearningId);

  if (!layered) return null;

  const definitionParts = compactDefinitionParts(layered.definitionParts, 64, 480);
  const parentDefinitionParts = compactDefinitionParts(layered.parentDefinitionParts, 48, 480);
  const microMicroDefinitionParts = compactDefinitionParts(layered.microMicroDefinitionParts, 64, 480);
  const minCompleted = minCompletedForLearningId(initialLearningId);
  const tooEarly = safeNumber(layered.completed, 0) < minCompleted;

  return withAnalyzeIdentityFlags({
    ...layered,
    definitionParts,
    definition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(layered.definition || '', 1600),
    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(layered.parentDefinition || '', 1200),
    microMicroDefinitionParts,
    microMicroDefinition: microMicroDefinitionParts.length
      ? microMicroDefinitionParts.join(' | ')
      : truncateString(layered.microMicroDefinition || '', 1200),
    broadTrueDefinitionParts: compactDefinitionParts(layered.broadTrueDefinitionParts, 24, 480),
    examples: compactExamples(layered.examples, 8, 480),
    recentOutcomes: compactRecentOutcomes(layered.recentOutcomes, 8),
    currentFit: currentFitLookupFromStoredRow(layered),
    learningStatus: getLearningStatus({
      ...layered,
      minCompletedForActiveLearning: minCompleted
    }),
    status: getLearningStatus({
      ...layered,
      minCompletedForActiveLearning: minCompleted
    }),
    tooEarly,
    tooEarlyReason: tooEarly
      ? `completed ${safeNumber(layered.completed, 0)}/${minCompleted}`
      : null,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLCBAvgR: true,
    selectionUsesWeeklyWinnerOnly: false
  });
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(
    Object.entries(micros || {})
      .map(([id, row]) => {
        const learningId = normalizeLearningFamilyId(
          row?.trueMicroFamilyId || row?.microFamilyId || row?.learningMicroFamilyId || id,
          row || {}
        );

        if (!learningId || !row) return null;
        if (!isShortOnlyRow(row)) return null;

        const compact = compactMicroForStorage({
          ...row,
          microFamilyId: learningId,
          trueMicroFamilyId: learningId,
          learningMicroFamilyId: learningId
        });

        if (!compact) return null;

        return [
          learningId,
          compact
        ];
      })
      .filter(Boolean)
  );
}

function compareTopMicros(a = {}, b = {}) {
  const ar = refreshStats(a);
  const br = refreshStats(b);

  const layerBonus = (row) => {
    const layer = learningLayerForId(row.trueMicroFamilyId || row.microFamilyId);

    if (layer === LAYER_MICRO_MICRO) return 2;
    if (layer === LAYER_MICRO_75) return 1;

    return 0;
  };

  const eligible = (row) => Number(row.tradingEligible === true || row.eligible === true || row.eligibleGatePassed === true);

  return (
    eligible(br) - eligible(ar) ||
    layerBonus(br) - layerBonus(ar) ||
    safeNumber(br.avgRLCB95 ?? br.avgRLowerBound95 ?? br.lcb95AvgR, 0) -
      safeNumber(ar.avgRLCB95 ?? ar.avgRLowerBound95 ?? ar.lcb95AvgR, 0) ||
    safeNumber(br.totalR ?? br.netTotalR, 0) -
      safeNumber(ar.totalR ?? ar.netTotalR, 0) ||
    safeNumber(br.avgR ?? br.netAvgR, 0) -
      safeNumber(ar.avgR ?? ar.netAvgR, 0) ||
    safeNumber(br.profitFactor, 0) -
      safeNumber(ar.profitFactor, 0) ||
    safeNumber(ar.directSLPct, 0) -
      safeNumber(br.directSLPct, 0) ||
    safeNumber(ar.avgCostR ?? ar.totalCostR, 0) -
      safeNumber(br.avgCostR ?? br.totalCostR, 0) ||
    safeNumber(br.dashboardBalancedScore ?? br.balancedScore, 0) -
      safeNumber(ar.dashboardBalancedScore ?? ar.balancedScore, 0) ||
    safeNumber(br.completed, 0) -
      safeNumber(ar.completed, 0) ||
    safeNumber(br.seen ?? br.observations, 0) -
      safeNumber(ar.seen ?? ar.observations, 0) ||
    String(ar.microFamilyId || '').localeCompare(String(br.microFamilyId || ''))
  );
}

function selectTopMicrosObject(micros = {}, limit = 300) {
  const safeLimit = Math.max(1, Math.floor(safeNumber(limit, 300)));
  const normalized = normalizeMicros(micros);

  return Object.fromEntries(
    Object.values(normalized)
      .filter(Boolean)
      .filter(isShortOnlyRow)
      .filter((row) => {
        const id = row.trueMicroFamilyId || row.microFamilyId;
        return isFixedTaxonomyChildMicroId(id) || isFixedTaxonomyMicroMicroId(id);
      })
      .sort(compareTopMicros)
      .slice(0, safeLimit)
      .map((row) => [
        row.trueMicroFamilyId || row.microFamilyId,
        withAnalyzeIdentityFlags(row)
      ])
      .filter(([id]) => Boolean(id))
  );
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const redis = getDurableRedis();

  const raw = await getJson(
    redis,
    getWeekMicrosBaseKey(weekKey),
    null
  ).catch(() => null);

  if (!raw) return {};

  const rows = raw.rows || raw.micros || raw;

  return normalizeMicros(rows || {});
}

export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, {
  limit = 25
} = {}) {
  const redis = getDurableRedis();

  const top = await getJson(
    redis,
    getWeekMicrosTopKey(weekKey),
    null
  ).catch(() => null);

  if (top?.rows && Object.keys(top.rows).length > 0) {
    return selectTopMicrosObject(top.rows, limit);
  }

  return selectTopMicrosObject(
    await getWeekMicros(weekKey),
    limit
  );
}

export async function getWeekMicrosByIds(weekKey, ids = []) {
  const safeIds = uniqueStrings(ids)
    .map((id) => normalizeLearningFamilyId(id))
    .filter(Boolean);

  if (!safeIds.length) return {};

  const micros = await getWeekMicros(weekKey);

  return Object.fromEntries(
    safeIds
      .filter((id) => micros[id])
      .map((id) => [id, micros[id]])
  );
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

  const existing = onlyIds
    ? await getWeekMicros(weekKey).catch(() => ({}))
    : {};

  const clean = normalizeMicros({
    ...(existing || {}),
    ...(micros || {})
  });

  const ids = Object.keys(clean);

  if (!ids.length && !allowEmptyFullSave) {
    return existing || {};
  }

  const topRows = selectTopMicrosObject(clean, 300);

  const tradingCandidates = scoreWeeklyTradingCandidates(clean, {
    requireCurrentFitMatch: false,
    currentFitLookup: currentFitLookupFromStoredRow
  });

  const layerCounts = Object.values(clean).reduce(
    (acc, row) => {
      const layer = learningLayerForId(row.trueMicroFamilyId || row.microFamilyId);

      acc.total += 1;
      if (layer === LAYER_PARENT_15) acc.parent15 += 1;
      if (layer === LAYER_MICRO_75) acc.micro75 += 1;
      if (layer === LAYER_MICRO_MICRO) acc.microMicro += 1;

      return acc;
    },
    {
      total: 0,
      parent15: 0,
      micro75: 0,
      microMicro: 0
    }
  );

  const commonMeta = {
    weekKey,
    updatedAt: now(),
    layerCounts,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',

    analyzeMicroFamiliesOnly: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    layeredLearningEnabled: true,
    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,
    sampleProtectionLayeringEnabled: true,

    selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,
    selectionAvoidsWinnerCurse: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    avgCostRShown: true,

    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    outcomeDedupeRequired: true,
    stableOutcomeIdentityRequired: true,
    randomOutcomeIdNotUsedForPrimaryDedupe: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    adaptiveShortRiskExpected: true,

    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    firstTouchPreserved: true,
    conservativeExitPreserved: true,
    candleFirstTouchCompatible: true,

    classifierVersion: CLASSIFIER_VERSION,
    noDefaultRetestSqueezeB: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };

  const payload = {
    ...commonMeta,
    rows: clean,
    count: ids.length,
    microFamilies: ids.length
  };

  await setJson(redis, getWeekMicrosBaseKey(weekKey), payload);

  await setJson(redis, getWeekMicrosTopKey(weekKey), {
    ...commonMeta,
    rows: topRows,
    count: Object.keys(topRows).length,
    storageMode: 'TOP_MICROS_AND_MICRO_MICROS_SNAPSHOT'
  });

  await setJson(redis, getWeekTradingCandidatesKey(weekKey), {
    ...commonMeta,
    rows: Object.fromEntries(
      tradingCandidates.map((row) => [
        row.trueMicroFamilyId || row.microFamilyId,
        row
      ])
    ),
    count: tradingCandidates.length,
    storageMode: 'ELIGIBLE_LIFETIME_LCB_CANDIDATES_PREVIEW',
    requireCurrentFitMatch: false,
    note: 'Preview zonder harde currentFit-match. Weekly job kan getWeeklyTradingCandidates(..., { requireCurrentFitMatch: true, currentFitLookup }) gebruiken.'
  });

  await setJson(redis, getWeekMetaKey(weekKey), {
    ...commonMeta,
    microFamilies: ids.length,
    tradingCandidatesPreview: tradingCandidates.length
  });

  return clean;
}

function getOrCreateMicro(micros, classified, side) {
  if (!classified) {
    throw new Error('CLASSIFIED_MICRO_REQUIRED');
  }

  const learningId = normalizeLearningFamilyId(
    classified.trueMicroFamilyId || classified.microFamilyId || classified.learningMicroFamilyId,
    classified
  );

  if (!learningId) {
    throw new Error('LEARNING_FAMILY_ID_REQUIRED');
  }

  if (!validLearningId(learningId)) {
    throw new Error('INVALID_LEARNING_ID');
  }

  const parsed = parseShortTaxonomyMicroId(learningId);

  if (!parsed.valid) {
    throw new Error('INVALID_FIXED_TAXONOMY_LEARNING_ID');
  }

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const childTrueMicroFamilyId = parsed.childTrueMicroFamilyId || classified.childTrueMicroFamilyId || null;
  const microMicroFamilyId = parsed.microMicroFamilyId || classified.microMicroFamilyId || null;
  const familyId = classified.familyId || 'SHORT_FIXED_TAXONOMY';
  const normalizedSide = normalizeStatsSide(side, classified);

  if (!micros[learningId]) {
    micros[learningId] = createMicroStats({
      microFamilyId: learningId,
      trueMicroFamilyId: learningId,
      familyId,
      side: normalizedSide,
      tradeSide: TARGET_TRADE_SIDE,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[learningId];

  const layerRow = applyLayerIdentity(
    {
      ...classified,
      ...micro,
      microFamilyId: learningId,
      trueMicroFamilyId: learningId,
      familyId
    },
    learningId
  );

  Object.assign(micro, layerRow);

  micro.familyId ||= familyId;

  micro.childTrueMicroFamilyId = childTrueMicroFamilyId;
  micro.parentTrueMicroFamilyId = parentTrueMicroFamilyId;
  micro.coarseMicroFamilyId = parentTrueMicroFamilyId;
  micro.baseMicroFamilyId = parentTrueMicroFamilyId;
  micro.legacyMicroFamilyId = parentTrueMicroFamilyId;
  micro.parentMicroFamilyId = parentTrueMicroFamilyId;
  micro.macroFamilyId = parentTrueMicroFamilyId;
  micro.parentMacroFamilyId = parentTrueMicroFamilyId;

  micro.microMicroFamilyId = microMicroFamilyId;
  micro.trueMicroMicroFamilyId = microMicroFamilyId;
  micro.exactMicroMicroFamilyId = microMicroFamilyId;
  micro.microMicroHash = parsed.microMicroHash || classified.microMicroHash || classified.executionFingerprintHash || null;

  micro.broadTrueMicroFamilyId = childTrueMicroFamilyId || learningId;
  micro.broadTrueDefinitionParts ||= classified.broadTrueDefinitionParts || classified.definitionParts || [];
  micro.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;

  micro.fixedTaxonomyLearningId = true;
  micro.fineMicroFamilyAsMetadataOnly = false;

  micro.setupType = parsed.setup;
  micro.regimeBucket = parsed.regime;
  micro.confirmationProfile = parsed.confirmationProfile;

  micro.executionFingerprintHash ||= classified.executionFingerprintHash || null;
  micro.executionFingerprintParts ||= classified.executionFingerprintParts || [];
  micro.executionFingerprintSchema ||= classified.executionFingerprintSchema || null;
  micro.executionMicroFamilyId ||= classified.executionMicroFamilyId || null;
  micro.executionFingerprintRole ||= classified.executionFingerprintRole || 'MICRO_MICRO_IDENTITY_HASH_SOURCE';
  micro.executionFingerprintsMetadataOnly = !microMicroFamilyId;
  micro.executionFingerprintsUsedAsLearningFamily = Boolean(microMicroFamilyId);

  micro.microMicroDefinitionParts ||= classified.microMicroDefinitionParts || [];
  micro.microMicroDefinition ||= classified.microMicroDefinition || '';

  micro.scannerMicroFamilyId ||= classified.scannerMicroFamilyId || null;
  micro.scannerFamilyId ||= classified.scannerFamilyId || null;
  micro.scannerDefinition ||= classified.scannerDefinition || null;
  micro.scannerDefinitionParts ||= classified.scannerDefinitionParts || [];

  micro.side = TARGET_DASHBOARD_SIDE;
  micro.tradeSide = TARGET_TRADE_SIDE;
  micro.positionSide = TARGET_TRADE_SIDE;
  micro.direction = TARGET_TRADE_SIDE;
  micro.targetTradeSide = TARGET_TRADE_SIDE;
  micro.dashboardSide = TARGET_DASHBOARD_SIDE;

  micro.shortOnly = true;
  micro.longDisabled = true;
  micro.longOnly = false;
  micro.shortDisabled = false;

  micro.version = 'fixed-taxonomy-parent-micro-micro-layered-v1';
  micro.microMicroVersion = MICRO_MICRO_VERSION;

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts ||= classified.parentDefinitionParts || [];

  micro.definitionParts = mergeDefinitionParts(
    micro.definitionParts || [],
    classified.definitionParts || [],
    learningLayerForId(learningId) === LAYER_MICRO_MICRO ? classified.microMicroDefinitionParts || [] : []
  );

  micro.definition = micro.definitionParts.length
    ? micro.definitionParts.join(' | ')
    : classified.definition || '';

  micro.assetClass ||= classified.assetClass || null;
  micro.obRelation ||= classified.obRelation || null;
  micro.btcRelation ||= classified.btcRelation || null;
  micro.btcState ||= classified.btcState || null;
  micro.flow ||= classified.flow || null;
  micro.flowCoarse ||= classified.flowCoarse || null;
  micro.regime ||= classified.regime || null;
  micro.regimeCoarse ||= classified.regimeCoarse || null;
  micro.scannerReason ||= classified.scannerReason || null;
  micro.scannerReasonCoarse ||= classified.scannerReasonCoarse || null;
  micro.rsiZone ||= classified.rsiZone || null;
  micro.rsiCoarse ||= classified.rsiCoarse || null;

  if (classified.spreadBps !== undefined && micro.spreadBps === undefined) {
    micro.spreadBps = classified.spreadBps;
  }

  micro.riskPlanVersion = classified.riskPlanVersion || micro.riskPlanVersion || SHORT_RISK_PLAN_VERSION;
  micro.adaptiveShortRiskExpected = true;

  micro.classifierVersion = CLASSIFIER_VERSION;
  micro.noDefaultRetestSqueezeB = true;

  micro.measurementFixVersion = MEASUREMENT_FIX_VERSION;
  micro.positionMeasurementFixVersion = POSITION_MEASUREMENT_FIX_VERSION;

  micro.observationDedupeRequired = true;
  micro.observationDedupeVersion = OBSERVATION_DEDUPE_VERSION;
  micro.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';

  micro.outcomeDedupeRequired = true;
  micro.outcomeDedupeVersion = OUTCOME_DEDUPE_VERSION;
  micro.stableOutcomeIdentityRequired = true;
  micro.randomOutcomeIdNotUsedForPrimaryDedupe = true;

  micro.currentFitSoftOnly = true;
  micro.currentFitBlocksLearning = false;
  micro.currentFitBlocksVirtualLearning = false;
  micro.currentFitBlocksShadowLearning = false;
  micro.currentFitPolarity = 'BEARISH_POSITIVE_BULLISH_NEGATIVE';
  micro.currentFitDefinition = 'SHORT_MIRRORED_CURRENT_FIT';

  micro.learningRemainsBroad = true;

  micro.selectionWillBeAdaptive = true;
  micro.selectionEngineVersion = SELECTION_ENGINE_VERSION;
  micro.selectionUsesLifetimeStats = true;
  micro.selectionUsesWeeklyWinnerOnly = false;
  micro.selectionUsesLCBAvgR = true;
  micro.selectionUsesCurrentFitHook = true;
  micro.selectionRequiresEligibleGate = true;
  micro.selectionAvoidsWinnerCurse = true;

  micro.discordWillBeStrict = true;

  micro.riskTradeSide = TARGET_TRADE_SIDE;
  micro.riskGeometryRule = 'SHORT: tp < entry < sl';
  micro.tpHitRule = 'SHORT: price <= tp';
  micro.slHitRule = 'SHORT: price >= sl';
  micro.grossRFormula = '(entry - exitPrice) / (initialSl - entry)';
  micro.currentRFormula = '(entry - currentPrice) / (initialSl - entry)';

  micro.learningStatus = getLearningStatus(micro);
  micro.status = micro.learningStatus;
  micro.tooEarly = safeNumber(micro.completed, 0) < micro.minCompletedForActiveLearning;
  micro.tooEarlyReason = micro.tooEarly
    ? `completed ${safeNumber(micro.completed, 0)}/${micro.minCompletedForActiveLearning}`
    : null;

  return micro;
}

function buildAnalyzeVariants(metrics = {}) {
  const primary = enrichWithMicroFamily(metrics);

  if (!primary) {
    return {
      primary: null,
      mirrors: []
    };
  }

  return {
    primary,
    mirrors: []
  };
}

function buildObservationDedupeIdentity(row = {}, childMicroFamilyId = '') {
  const snapshotId = String(
    row.snapshotId ||
      row.scanSnapshotId ||
      row.scannerSnapshotId ||
      row.batchId ||
      row.runId ||
      row.createdBucket ||
      'NO_SNAPSHOT'
  ).trim();

  const symbol = String(
    row.symbol ||
      row.contractSymbol ||
      row.baseSymbol ||
      'UNKNOWN'
  ).trim().toUpperCase();

  const entry = safeNumber(row.entry || row.entryPrice, 0);

  return {
    snapshotId: snapshotId || 'NO_SNAPSHOT',
    symbol: symbol || 'UNKNOWN',
    microFamilyId: childMicroFamilyId,
    entry
  };
}

function buildLayerObservationRow({
  batchMetrics,
  classified,
  learningId,
  childMicroFamilyId,
  parentTrueMicroFamilyId,
  observationKey,
  observationClaim,
  observationIdentity,
  weekKey
}) {
  const layerRow = applyLayerIdentity(
    {
      ...batchMetrics,
      ...classified,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      weekKey,
      strategyVersion: CONFIG.strategyVersion,
      source: OBSERVATION_SOURCE,
      analysisType: 'VIRTUAL_TRADE_SETUP_OBSERVATION',

      virtualOnly: true,
      virtualTracked: true,
      shadowOnly: false,
      realTrade: false,
      realOrder: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,

      observationRecorded: true,
      observationDuplicate: false,
      observationAlreadyCounted: false,
      observationCounted: true,
      countObservation: true,
      skipObservationCount: false,
      observationAlwaysCounted: false,
      observationDedupeKey: observationKey,
      observationDedupeMethod: observationClaim.method,
      observationDedupeType: observationClaim.type,
      observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
      observationSnapshotId: observationIdentity.snapshotId,
      observationEntry: observationIdentity.entry,

      childTrueMicroFamilyId: childMicroFamilyId,
      parentTrueMicroFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,

      riskPlanVersion: batchMetrics.riskPlanVersion || classified.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
      rr: batchMetrics.rr ?? classified.rr ?? null,
      riskPct: batchMetrics.riskPct ?? classified.riskPct ?? null,
      rewardPct: batchMetrics.rewardPct ?? classified.rewardPct ?? null,
      riskToRewardDistanceRatio:
        batchMetrics.riskToRewardDistanceRatio ??
        classified.riskToRewardDistanceRatio ??
        null,

      riskTradeSide: TARGET_TRADE_SIDE,
      riskGeometryRule: 'SHORT: tp < entry < sl',

      currentFit: normalizeCurrentFitValue(batchMetrics.currentFit ?? classified.currentFit ?? batchMetrics.entryCurrentFit ?? classified.entryCurrentFit ?? ''),
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

      measurementFixVersion: MEASUREMENT_FIX_VERSION,
      positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
      selectionEngineVersion: SELECTION_ENGINE_VERSION,

      createdAt: batchMetrics.createdAt || now()
    },
    learningId
  );

  return layerRow;
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = PERSISTENT_LEARNING_KEY } = {}
) {
  const rows = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean).filter((row) => isShortOnlyRow(row))
    : [];

  if (rows.length === 0) {
    return [];
  }

  const redis = getDurableRedis();

  const variantRows = rows
    .map((metrics) => ({
      metrics: withAnalyzeIdentityFlags(metrics),
      ...buildAnalyzeVariants(metrics)
    }))
    .filter((row) => row.primary)
    .filter((row) => normalizeChildTrueMicroFamilyId(row.primary.trueMicroFamilyId || row.primary.microFamilyId, row.primary));

  if (variantRows.length === 0) {
    return [];
  }

  const allClassifiedRows = variantRows.flatMap((row) => [
    row.primary,
    ...row.mirrors
  ]).filter(Boolean);

  const touchedIds = uniqueStrings(
    allClassifiedRows.flatMap((row) => layerIdsFromClassified(row))
  ).filter(Boolean);

  if (touchedIds.length === 0) {
    return [];
  }

  const micros = await getWeekMicros(weekKey);
  const analyzed = [];
  const actuallyTouchedIds = new Set();

  for (const batch of variantRows) {
    const processRows = [
      {
        row: batch.primary,
        returnToCaller: true
      }
    ];

    for (const item of processRows) {
      const classified = item.row;

      if (!classified || !classified.microFamilyId) continue;

      const childMicroFamilyId = normalizeChildTrueMicroFamilyId(
        classified.trueMicroFamilyId || classified.microFamilyId,
        {
          ...batch.metrics,
          ...classified
        }
      );

      if (!childMicroFamilyId) continue;

      const parentTrueMicroFamilyId = normalizeParentTrueMicroFamilyId(
        classified.parentTrueMicroFamilyId || classified.coarseMicroFamilyId || childMicroFamilyId,
        classified
      );

      const learningIds = layerIdsFromClassified({
        ...classified,
        childTrueMicroFamilyId: childMicroFamilyId,
        parentTrueMicroFamilyId
      });

      if (!learningIds.length) continue;

      const observationIdentity = buildObservationDedupeIdentity(batch.metrics, childMicroFamilyId);

      const observationKey = getObsLastKey(
        observationIdentity.snapshotId,
        observationIdentity.symbol,
        observationIdentity.microFamilyId,
        observationIdentity.entry
      );

      const observationClaim = await claimDedupeKey(
        redis,
        observationKey,
        obsDedupeTtlSec(),
        {
          type: 'OBSERVATION'
        }
      );

      const observationDuplicate = observationClaim.duplicate === true;
      const observationRecorded = observationClaim.claimed === true && !observationDuplicate;

      if (observationRecorded) {
        for (const learningId of learningIds) {
          const layerClassified = applyLayerIdentity(
            {
              ...classified,
              childTrueMicroFamilyId: childMicroFamilyId,
              parentTrueMicroFamilyId,
              coarseMicroFamilyId: parentTrueMicroFamilyId
            },
            learningId
          );

          if (!layerClassified) continue;

          const micro = getOrCreateMicro(
            micros,
            layerClassified,
            TARGET_DASHBOARD_SIDE
          );

          const observationRow = buildLayerObservationRow({
            batchMetrics: batch.metrics,
            classified,
            learningId,
            childMicroFamilyId,
            parentTrueMicroFamilyId,
            observationKey,
            observationClaim,
            observationIdentity,
            weekKey
          });

          updateObservation(micro, observationRow);
          Object.assign(micro, analyzeIdentityFlags());
          Object.assign(micro, applyLayerIdentity(micro, learningId));
          actuallyTouchedIds.add(learningId);
        }
      }

      if (item.returnToCaller) {
        const microMicroLearningId = normalizeMicroMicroFamilyId(classified.microMicroFamilyId, {
          ...classified,
          childTrueMicroFamilyId: childMicroFamilyId
        }) || null;

        analyzed.push(withAnalyzeIdentityFlags({
          ...batch.metrics,
          ...classified,

          microFamilyId: childMicroFamilyId,
          trueMicroFamilyId: childMicroFamilyId,
          childTrueMicroFamilyId: childMicroFamilyId,

          coarseMicroFamilyId: parentTrueMicroFamilyId,
          parentTrueMicroFamilyId,
          parentMicroFamilyId: parentTrueMicroFamilyId,
          macroFamilyId: parentTrueMicroFamilyId,
          parentMacroFamilyId: parentTrueMicroFamilyId,

          microMicroFamilyId: microMicroLearningId,
          trueMicroMicroFamilyId: microMicroLearningId,
          exactMicroMicroFamilyId: microMicroLearningId,

          learningIds,
          parentLearningId: parentTrueMicroFamilyId,
          childLearningId: childMicroFamilyId,
          microMicroLearningId,

          side: TARGET_DASHBOARD_SIDE,
          tradeSide: TARGET_TRADE_SIDE,
          positionSide: TARGET_TRADE_SIDE,
          direction: TARGET_TRADE_SIDE,
          targetTradeSide: TARGET_TRADE_SIDE,
          dashboardSide: TARGET_DASHBOARD_SIDE,

          shortOnly: true,
          longDisabled: true,
          longOnly: false,
          shortDisabled: false,

          source: OBSERVATION_SOURCE,
          analysisType: 'VIRTUAL_TRADE_SETUP_OBSERVATION',

          observationRecorded,
          observationDuplicate,
          observationAlreadyCounted: observationDuplicate,
          observationCounted: observationRecorded,
          countObservation: observationRecorded,
          skipObservationCount: observationDuplicate,
          observationAlwaysCounted: false,
          observationDedupeKey: observationKey,
          observationDedupeMethod: observationClaim.method,
          observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,

          mirrorMicroFamiliesCreated: 0,
          mirrorMicroFamilyIds: [],

          virtualOnly: true,
          virtualTracked: true,
          shadowOnly: false,
          realTrade: false,
          realOrder: false,
          exchangeOrder: false,
          bitgetOrderPlaced: false,

          riskPlanVersion: batch.metrics.riskPlanVersion || classified.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
          rr: batch.metrics.rr ?? classified.rr ?? null,
          riskPct: batch.metrics.riskPct ?? classified.riskPct ?? null,
          rewardPct: batch.metrics.rewardPct ?? classified.rewardPct ?? null,
          riskToRewardDistanceRatio:
            batch.metrics.riskToRewardDistanceRatio ??
            classified.riskToRewardDistanceRatio ??
            null,

          riskTradeSide: TARGET_TRADE_SIDE,
          riskGeometryRule: 'SHORT: tp < entry < sl',

          currentFit: normalizeCurrentFitValue(batch.metrics.currentFit ?? classified.currentFit ?? batch.metrics.entryCurrentFit ?? classified.entryCurrentFit ?? ''),
          currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
          currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

          measurementFixVersion: MEASUREMENT_FIX_VERSION,
          positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
          microMicroVersion: MICRO_MICRO_VERSION,
          selectionEngineVersion: SELECTION_ENGINE_VERSION,

          weekKey,
          strategyVersion: CONFIG.strategyVersion
        }));
      }
    }
  }

  if (actuallyTouchedIds.size > 0) {
    await saveWeekMicros(
      weekKey,
      micros,
      {
        onlyIds: [...actuallyTouchedIds]
      }
    );
  }

  return analyzed;
}

function hasLockedOutcomeIdentity(outcome = {}) {
  return Boolean(
    normalizeChildTrueMicroFamilyId(outcome.trueMicroFamilyId || outcome.microFamilyId || outcome.childTrueMicroFamilyId, outcome)
  );
}

function buildLockedOutcomeRow(outcome = {}) {
  const childMicroFamilyId = normalizeChildTrueMicroFamilyId(
    outcome.trueMicroFamilyId ||
      outcome.microFamilyId ||
      outcome.childTrueMicroFamilyId ||
      '',
    outcome
  );

  if (!childMicroFamilyId) return null;

  const parsed = parseShortTaxonomyMicroId(childMicroFamilyId);
  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;

  const fallbackExecutionParts = buildExecutionFingerprintParts(
    outcome,
    outcome,
    {
      ...parsed,
      trueMicroFamilyId: childMicroFamilyId,
      childTrueMicroFamilyId: childMicroFamilyId,
      parentTrueMicroFamilyId
    }
  );

  const fallbackExecutionHash = hashText(
    fallbackExecutionParts.join('|'),
    EXECUTION_MICRO_HASH_LEN
  );

  const microMicroFamilyId = normalizeMicroMicroFamilyId(
    outcome.microMicroFamilyId ||
      outcome.trueMicroMicroFamilyId ||
      outcome.exactMicroMicroFamilyId ||
      outcome.executionMicroFamilyId ||
      '',
    {
      ...outcome,
      childTrueMicroFamilyId: childMicroFamilyId,
      executionFingerprintHash:
        outcome.executionFingerprintHash ||
        outcome.microMicroHash ||
        fallbackExecutionHash
    }
  ) || buildMicroMicroFamilyIdFromExecution(
    childMicroFamilyId,
    outcome.executionFingerprintHash ||
      outcome.microMicroHash ||
      fallbackExecutionHash
  );

  const familyId = String(
    outcome.familyId ||
      outcome.family ||
      'SHORT_VIRTUAL_OUTCOME'
  ).trim();

  const definitionParts = mergeDefinitionParts(
    outcome.definitionParts || [],
    outcome.broadTrueDefinitionParts || [],
    [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `LOCKED_MICRO=${childMicroFamilyId}`,
      `LOCKED_TRUE_MICRO=${childMicroFamilyId}`,
      `LOCKED_PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
      microMicroFamilyId ? `LOCKED_MICRO_MICRO=${microMicroFamilyId}` : null,
      'OUTCOME_IDENTITY=POSITION_LOCKED',
      `RISK_PLAN=${outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
      `MEASUREMENT_FIX=${MEASUREMENT_FIX_VERSION}`,
      `POSITION_MEASUREMENT_FIX=${outcome.positionMeasurementFixVersion || POSITION_MEASUREMENT_FIX_VERSION}`,
      `SELECTION_ENGINE=${SELECTION_ENGINE_VERSION}`
    ].filter(Boolean)
  );

  const parentDefinitionParts = mergeDefinitionParts(
    outcome.parentDefinitionParts || [],
    outcome.macroDefinitionParts || [],
    [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PARENT_TRUE_MICRO=${parentTrueMicroFamilyId}`,
      `SETUP=${parsed.setup}`,
      `REGIME_BUCKET=${parsed.regime}`
    ]
  );

  const microMicroDefinitionParts = microMicroFamilyId
    ? buildMicroMicroDefinitionParts(
      outcome,
      {
        ...outcome,
        executionFingerprintParts: Array.isArray(outcome.executionFingerprintParts)
          ? outcome.executionFingerprintParts
          : fallbackExecutionParts,
        executionFingerprintHash:
          outcome.executionFingerprintHash ||
          outcome.microMicroHash ||
          fallbackExecutionHash,
        microMicroFamilyId,
        microMicroHash:
          outcome.microMicroHash ||
          outcome.executionFingerprintHash ||
          fallbackExecutionHash
      },
      {
        ...parsed,
        trueMicroFamilyId: childMicroFamilyId,
        childTrueMicroFamilyId: childMicroFamilyId,
        parentTrueMicroFamilyId,
        microMicroFamilyId,
        microMicroHash:
          outcome.microMicroHash ||
          outcome.executionFingerprintHash ||
          fallbackExecutionHash
      }
    )
    : [];

  return withAnalyzeIdentityFlags({
    ...outcome,
    familyId,

    microFamilyId: childMicroFamilyId,
    trueMicroFamilyId: childMicroFamilyId,
    childTrueMicroFamilyId: childMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash:
      outcome.microMicroHash ||
      outcome.executionFingerprintHash ||
      fallbackExecutionHash ||
      null,

    broadTrueMicroFamilyId: childMicroFamilyId,
    broadTrueDefinitionParts: outcome.broadTrueDefinitionParts || definitionParts,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    fineMicroFamilyAsMetadataOnly: false,
    fixedTaxonomyLearningId: true,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    executionFingerprintHash:
      outcome.executionFingerprintHash ||
      outcome.microMicroHash ||
      fallbackExecutionHash ||
      null,
    executionFingerprintParts: Array.isArray(outcome.executionFingerprintParts)
      ? outcome.executionFingerprintParts
      : fallbackExecutionParts,
    executionFingerprintSchema: outcome.executionFingerprintSchema || EXECUTION_MICRO_SUFFIX,
    executionMicroFamilyId:
      outcome.executionMicroFamilyId ||
      `${childMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${(
        outcome.executionFingerprintHash ||
        outcome.microMicroHash ||
        fallbackExecutionHash
      ).slice(0, EXECUTION_MICRO_HASH_LEN)}`,
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: Boolean(microMicroFamilyId),

    microMicroDefinitionParts,
    microMicroDefinition: microMicroDefinitionParts.join(' | '),
    microMicroSelectionAllowed: Boolean(microMicroFamilyId),

    definitionParts,
    definition: definitionParts.join(' | '),
    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.join(' | '),

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: outcome.source || OUTCOME_SOURCE,
    outcomeSource: outcome.outcomeSource || outcome.source || OUTCOME_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    scannerMicroFamilyId: outcome.scannerMicroFamilyId || null,
    scannerFamilyId: outcome.scannerFamilyId || null,
    scannerDefinition: outcome.scannerDefinition || null,
    scannerDefinitionParts: outcome.scannerDefinitionParts || [],
    scannerFingerprintRole: 'METADATA_ONLY',

    riskPlanVersion: outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: safeNumber(outcome.rr, 0),
    riskPct: safeNumber(outcome.riskPct, 0),
    rewardPct: safeNumber(outcome.rewardPct, 0),
    riskToRewardDistanceRatio: safeNumber(outcome.riskToRewardDistanceRatio, 999),

    exitTrigger: outcome.exitTrigger || null,
    exitPriceSource: outcome.exitPriceSource || null,
    exitRangeStart: outcome.exitRangeStart || null,
    exitRangeEnd: outcome.exitRangeEnd || null,
    firstTouch: outcome.firstTouch || null,
    conservativeExit: Boolean(outcome.conservativeExit),

    measurementFixVersion: outcome.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      outcome.positionMeasurementFixVersion ||
      outcome.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFit: normalizeCurrentFitValue(outcome.entryCurrentFit ?? outcome.currentFit ?? ''),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    selectionEngineVersion: SELECTION_ENGINE_VERSION,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true
  });
}

function calcGrossMovePct({ side, entry, exit }) {
  if (entry <= 0 || exit <= 0) return 0;

  return isTargetShortSide(side)
    ? (entry - exit) / entry
    : (exit - entry) / entry;
}

function calcRiskPct({ entry, sl }) {
  if (entry <= 0 || sl <= 0) return 0;

  return Math.abs(entry - sl) / entry;
}

function ensureNetOutcome(outcome = {}) {
  const existingNetR = safeNumber(
    outcome.shortNetR ??
      outcome.netShortR ??
      outcome.netR ??
      outcome.exitR ??
      outcome.realizedNetR ??
      outcome.realizedR ??
      outcome.r,
    null
  );

  const existingGrossR = safeNumber(
    outcome.shortGrossR ??
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

  const validShortRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    tp < entry &&
    entry < initialSl;

  const riskPct =
    safeNumber(outcome.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const rewardPct =
    safeNumber(outcome.rewardPct, 0) ||
    (
      entry > 0 && tp > 0
        ? Math.max(0, (entry - tp) / entry)
        : 0
    );

  const riskToRewardDistanceRatio =
    safeNumber(
      outcome.riskToRewardDistanceRatio,
      rewardPct > 0 ? riskPct / rewardPct : 999
    );

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

  const directToSL = Boolean(
    outcome.directToSL ||
    outcome.directSL ||
    inferDirectToSL({
      position: outcome,
      exitReason: outcome.exitReason || outcome.reason
    })
  );

  if (
    Number.isFinite(grossMovePct) &&
    riskPct > 0
  ) {
    const cost = applyCosts({
      side: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      grossMovePct,
      riskPct,
      entrySpreadPct: safeNumber(outcome.entrySpreadPct ?? outcome.spreadPct, 0),
      exitSpreadPct: safeNumber(outcome.exitSpreadPct ?? outcome.spreadPct, 0)
    });

    const netR = safeNumber(cost.netR, existingNetR ?? 0);
    const grossR = safeNumber(cost.grossR, existingGrossR ?? 0);
    const costR = safeNumber(cost.costR, existingCostR ?? Math.max(0, grossR - netR));
    const fundingCostR = safeNumber(outcome.fundingCostR, 0);
    const executionCostR = Math.max(0, costR - Math.max(0, fundingCostR));

    return withAnalyzeIdentityFlags({
      ...outcome,
      validShortRiskShape,
      validShortGeometry: validShortRiskShape,
      shortValidGeometry: validShortRiskShape,

      grossMovePct,
      riskPct,
      rewardPct,
      riskToRewardDistanceRatio,

      grossR,
      shortGrossR: grossR,
      rawR: grossR,
      realizedGrossR: grossR,
      grossPnlPct: safeNumber(cost.grossPnlPct, 0),

      netR,
      shortNetR: netR,
      exitR: netR,
      realizedNetR: netR,
      realizedR: netR,
      r: netR,
      pnlPct: safeNumber(cost.netPnlPct, 0),
      netPnlPct: safeNumber(cost.netPnlPct, 0),

      costR,
      avgCostR: costR,
      executionCostR,
      fundingCostR,
      costPct: safeNumber(cost.costPct, 0),
      feePct: safeNumber(cost.feePct, 0),
      slippagePct: safeNumber(cost.slippagePct, 0),

      win: netR > 0,
      loss: netR < 0,
      flat: netR === 0,
      isWin: netR > 0,

      directToSL,
      directSL: directToSL,

      riskPlanVersion: outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
      rr: safeNumber(outcome.rr, 0),

      exitTrigger: outcome.exitTrigger || null,
      exitPriceSource: outcome.exitPriceSource || null,
      exitRangeStart: outcome.exitRangeStart || null,
      exitRangeEnd: outcome.exitRangeEnd || null,
      firstTouch: outcome.firstTouch || null,
      conservativeExit: Boolean(outcome.conservativeExit),

      measurementFixVersion: outcome.measurementFixVersion || MEASUREMENT_FIX_VERSION,
      positionMeasurementFixVersion:
        outcome.positionMeasurementFixVersion ||
        outcome.monitorMeasurementFixVersion ||
        POSITION_MEASUREMENT_FIX_VERSION,

      riskTradeSide: TARGET_TRADE_SIDE,
      riskGeometryRule: 'SHORT: tp < entry < sl',
      tpHitRule: 'SHORT: price <= tp',
      slHitRule: 'SHORT: price >= sl',
      grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
      currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

      currentFit: normalizeCurrentFitValue(outcome.entryCurrentFit ?? outcome.currentFit ?? ''),
      selectionEngineVersion: SELECTION_ENGINE_VERSION,

      costModelApplied: true,
      netCostModelApplied: true,
      costModel: outcome.costModel || 'APPLY_COSTS_NET_R_V2_EXECUTION_FUNDING_SPLIT'
    });
  }

  const fallbackNetR = safeNumber(existingNetR, 0);
  const fallbackGrossR = safeNumber(existingGrossR, fallbackNetR);
  const fallbackCostR = safeNumber(
    existingCostR,
    Math.max(0, fallbackGrossR - fallbackNetR)
  );
  const fallbackFundingCostR = safeNumber(outcome.fundingCostR, 0);
  const fallbackExecutionCostR = Math.max(0, fallbackCostR - Math.max(0, fallbackFundingCostR));

  return withAnalyzeIdentityFlags({
    ...outcome,
    validShortRiskShape,
    validShortGeometry: validShortRiskShape,
    shortValidGeometry: validShortRiskShape,

    netR: fallbackNetR,
    shortNetR: fallbackNetR,
    exitR: fallbackNetR,
    realizedNetR: fallbackNetR,
    realizedR: fallbackNetR,
    r: fallbackNetR,

    grossR: fallbackGrossR,
    shortGrossR: fallbackGrossR,
    rawR: fallbackGrossR,
    realizedGrossR: fallbackGrossR,

    costR: fallbackCostR,
    avgCostR: fallbackCostR,
    executionCostR: fallbackExecutionCostR,
    fundingCostR: fallbackFundingCostR,

    win: fallbackNetR > 0,
    loss: fallbackNetR < 0,
    flat: fallbackNetR === 0,
    isWin: fallbackNetR > 0,

    directToSL,
    directSL: directToSL,

    riskPlanVersion: outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: safeNumber(outcome.rr, 0),
    riskPct,
    rewardPct,
    riskToRewardDistanceRatio,

    exitTrigger: outcome.exitTrigger || null,
    exitPriceSource: outcome.exitPriceSource || null,
    exitRangeStart: outcome.exitRangeStart || null,
    exitRangeEnd: outcome.exitRangeEnd || null,
    firstTouch: outcome.firstTouch || null,
    conservativeExit: Boolean(outcome.conservativeExit),

    measurementFixVersion: outcome.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      outcome.positionMeasurementFixVersion ||
      outcome.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFit: normalizeCurrentFitValue(outcome.entryCurrentFit ?? outcome.currentFit ?? ''),
    selectionEngineVersion: SELECTION_ENGINE_VERSION,

    costModelApplied: Boolean(outcome.costModelApplied),
    netCostModelApplied: Boolean(outcome.netCostModelApplied),
    costModel: outcome.costModel || 'PRECOMPUTED_NET_R'
  });
}

function isLikelyRandomOutcomeId(value = '') {
  const raw = String(value || '').trim();

  if (!raw) return false;

  const upperRaw = upper(raw);

  return (
    upperRaw.startsWith('OUTCOME_SHORT_') ||
    upperRaw.startsWith('OUTCOME_TRADE_SHORT_') ||
    (
      upperRaw.startsWith('OUTCOME_') &&
      upperRaw.length >= 20 &&
      /[A-Z0-9]{8,}$/u.test(upperRaw)
    )
  );
}

function buildStableTradeCloseIdentity(outcome = {}) {
  const tradeId = String(outcome.tradeId || '').trim();
  const symbol = String(outcome.symbol || outcome.contractSymbol || 'UNKNOWN').toUpperCase();
  const openedAt = String(outcome.openedAt || outcome.createdAt || 'NO_OPEN').trim();
  const closedAt = String(outcome.closedAt || outcome.completedAt || outcome.ts || 'NO_CLOSE').trim();
  const exitReason = String(outcome.exitReason || outcome.reason || 'NO_REASON').trim().toUpperCase();
  const exitPrice = safeNumber(outcome.exit ?? outcome.exitPrice, 0).toFixed(8);

  const microMicroFamilyId = String(
    outcome.microMicroFamilyId ||
      outcome.trueMicroMicroFamilyId ||
      outcome.exactMicroMicroFamilyId ||
      ''
  ).trim();

  if (!tradeId || openedAt === 'NO_OPEN' || closedAt === 'NO_CLOSE') {
    return '';
  }

  return [
    TARGET_TRADE_SIDE,
    tradeId,
    symbol,
    openedAt,
    closedAt,
    exitReason,
    exitPrice,
    microMicroFamilyId
  ].join('|');
}

function buildOutcomeDedupeIdentity(outcome = {}, childMicroFamilyId = '') {
  const stableTradeCloseIdentity = buildStableTradeCloseIdentity(outcome);

  const directCandidates = [
    outcome.outcomeIdentity,
    outcome.stableOutcomeIdentity,
    outcome.learningOutcomeId,
    outcome.closeEventId,
    outcome.tradeCloseId,
    stableTradeCloseIdentity,
    outcome.positionId,
    isLikelyRandomOutcomeId(outcome.outcomeId) ? null : outcome.outcomeId
  ];

  for (const candidate of directCandidates) {
    const direct = String(candidate || '').trim();

    if (direct) {
      return hashText(`${TARGET_TRADE_SIDE}|${direct}|${childMicroFamilyId}`, 24);
    }
  }

  const symbol = String(outcome.symbol || outcome.contractSymbol || 'UNKNOWN').toUpperCase();
  const openedAt = String(outcome.openedAt || outcome.createdAt || 'NO_OPEN').trim();
  const closedAt = String(outcome.closedAt || outcome.completedAt || outcome.ts || 'NO_CLOSE').trim();
  const exitReason = String(outcome.exitReason || outcome.reason || 'NO_REASON').trim();
  const netR = safeNumber(outcome.netR ?? outcome.exitR, 0).toFixed(6);
  const exitPrice = safeNumber(outcome.exit ?? outcome.exitPrice, 0).toFixed(8);

  const microMicroFamilyId = String(
    outcome.microMicroFamilyId ||
      outcome.trueMicroMicroFamilyId ||
      outcome.exactMicroMicroFamilyId ||
      ''
  ).trim();

  return hashText([
    TARGET_TRADE_SIDE,
    symbol,
    openedAt,
    closedAt,
    exitReason,
    netR,
    exitPrice,
    childMicroFamilyId,
    microMicroFamilyId
  ].join('|'), 24);
}

function buildLayerOutcomeRow({
  row,
  learningId,
  childMicroFamilyId,
  parentTrueMicroFamilyId,
  src,
  weekKey,
  outcomeDedupeKey,
  outcomeClaim
}) {
  return applyLayerIdentity(
    withAnalyzeIdentityFlags({
      ...row,

      childTrueMicroFamilyId: childMicroFamilyId,
      parentTrueMicroFamilyId,
      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentMicroFamilyId: parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      parentMacroFamilyId: parentTrueMicroFamilyId,

      source: src,
      outcomeSource: src,
      weekKey,

      riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
      rr: safeNumber(row.rr, 0),
      riskPct: safeNumber(row.riskPct, 0),
      rewardPct: safeNumber(row.rewardPct, 0),
      riskToRewardDistanceRatio: safeNumber(row.riskToRewardDistanceRatio, 999),

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      virtualOnly: true,
      virtualTracked: true,
      shadowOnly: true,
      realTrade: false,
      realOrder: false,
      exchangeOrder: false,
      bitgetOrderPlaced: false,

      netR: safeNumber(row.netR ?? row.exitR, 0),
      shortNetR: safeNumber(row.shortNetR ?? row.netR ?? row.exitR, 0),
      exitR: safeNumber(row.exitR ?? row.netR, 0),
      realizedNetR: safeNumber(row.realizedNetR ?? row.netR ?? row.exitR, 0),
      realizedR: safeNumber(row.realizedR ?? row.netR ?? row.exitR, 0),
      r: safeNumber(row.r ?? row.netR ?? row.exitR, 0),

      costR: safeNumber(row.costR, 0),
      avgCostR: safeNumber(row.avgCostR ?? row.costR, 0),
      executionCostR: safeNumber(row.executionCostR, 0),
      fundingCostR: safeNumber(row.fundingCostR, 0),

      grossR: safeNumber(row.grossR, 0),
      shortGrossR: safeNumber(row.shortGrossR ?? row.grossR, 0),
      rawR: safeNumber(row.rawR ?? row.grossR, 0),
      realizedGrossR: safeNumber(row.realizedGrossR ?? row.grossR, 0),

      costModelApplied: Boolean(row.costModelApplied),
      netCostModelApplied: Boolean(row.netCostModelApplied),

      directToSL: Boolean(row.directToSL),
      directSL: Boolean(row.directSL || row.directToSL),

      exitTrigger: row.exitTrigger || null,
      exitPriceSource: row.exitPriceSource || null,
      exitRangeStart: row.exitRangeStart || null,
      exitRangeEnd: row.exitRangeEnd || null,
      firstTouch: row.firstTouch || null,
      conservativeExit: Boolean(row.conservativeExit),

      measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
      positionMeasurementFixVersion:
        row.positionMeasurementFixVersion ||
        row.monitorMeasurementFixVersion ||
        POSITION_MEASUREMENT_FIX_VERSION,

      riskTradeSide: TARGET_TRADE_SIDE,
      riskGeometryRule: 'SHORT: tp < entry < sl',
      tpHitRule: 'SHORT: price <= tp',
      slHitRule: 'SHORT: price >= sl',
      grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
      currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

      currentFit: normalizeCurrentFitValue(row.entryCurrentFit ?? row.currentFit ?? ''),
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

      selectionEngineVersion: SELECTION_ENGINE_VERSION,

      outcomeDuplicate: false,
      outcomeAlreadyRecorded: false,
      outcomeCounted: true,
      countOutcome: true,
      skipOutcomeCount: false,
      outcomeDedupeKey,
      outcomeDedupeMethod: outcomeClaim.method,
      outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
      stableOutcomeIdentityRequired: true,
      randomOutcomeIdNotUsedForPrimaryDedupe: true,
      outcomeIdentityLocked: true,
      outcomeIdentitySource: row.outcomeIdentitySource || 'POSITION_MICRO_IDENTITY'
    }),
    learningId
  );
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
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: outcome.virtualOnly !== false,
    virtualTracked: outcome.virtualTracked !== false,
    shadowOnly: outcome.shadowOnly !== false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    measurementFixVersion: outcome.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      outcome.positionMeasurementFixVersion ||
      outcome.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,

    selectionEngineVersion: SELECTION_ENGINE_VERSION
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

  const childMicroFamilyId = normalizeChildTrueMicroFamilyId(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);

  if (!childMicroFamilyId) {
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
    row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || childMicroFamilyId,
    row
  );

  const learningIds = layerIdsFromClassified({
    ...row,
    childTrueMicroFamilyId: childMicroFamilyId,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId
  });

  if (!learningIds.length) {
    return {
      ...row,
      source: src,
      weekKey,
      skipped: true,
      reason: 'NO_LAYERED_LEARNING_IDS_FOR_OUTCOME',
      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    };
  }

  const redis = getDurableRedis();
  const outcomeIdentity = buildOutcomeDedupeIdentity(row, childMicroFamilyId);
  const outcomeDedupeKey = getOutcomeLastKey(weekKey, outcomeIdentity, childMicroFamilyId);

  const outcomeClaim = await claimDedupeKey(
    redis,
    outcomeDedupeKey,
    outcomeDedupeTtlSec(),
    {
      type: 'OUTCOME'
    }
  );

  if (outcomeClaim.duplicate === true) {
    return withAnalyzeIdentityFlags({
      ...row,

      microFamilyId: childMicroFamilyId,
      trueMicroFamilyId: childMicroFamilyId,
      childTrueMicroFamilyId: childMicroFamilyId,

      coarseMicroFamilyId: parentTrueMicroFamilyId,
      parentTrueMicroFamilyId,
      parentMicroFamilyId: parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      parentMacroFamilyId: parentTrueMicroFamilyId,

      learningIds,
      source: src,
      outcomeSource: src,
      weekKey,

      skipped: true,
      reason: 'DUPLICATE_OUTCOME_SKIPPED_NO_STATS_UPDATE',

      outcomeDuplicate: true,
      outcomeAlreadyRecorded: true,
      outcomeCounted: false,
      countOutcome: false,
      skipOutcomeCount: true,

      outcomeDedupeKey,
      outcomeDedupeMethod: outcomeClaim.method,
      outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
      stableOutcomeIdentityRequired: true,
      randomOutcomeIdNotUsedForPrimaryDedupe: true,

      selectionEngineVersion: SELECTION_ENGINE_VERSION,

      recordedAt: now(),
      mirrorOutcomeRecorded: false,
      mirrorMicroFamilyId: null
    });
  }

  const micros = await getWeekMicros(weekKey);
  const actuallyTouchedIds = new Set();

  for (const learningId of learningIds) {
    const layerClassified = applyLayerIdentity(
      {
        ...row,
        childTrueMicroFamilyId: childMicroFamilyId,
        parentTrueMicroFamilyId,
        coarseMicroFamilyId: parentTrueMicroFamilyId
      },
      learningId
    );

    if (!layerClassified) continue;

    const micro = getOrCreateMicro(
      micros,
      layerClassified,
      TARGET_DASHBOARD_SIDE
    );

    const outcomeRow = buildLayerOutcomeRow({
      row,
      learningId,
      childMicroFamilyId,
      parentTrueMicroFamilyId,
      src,
      weekKey,
      outcomeDedupeKey,
      outcomeClaim
    });

    updateOutcome(micro, outcomeRow, src);
    Object.assign(micro, analyzeIdentityFlags());
    Object.assign(micro, applyLayerIdentity(micro, learningId));
    actuallyTouchedIds.add(learningId);
  }

  if (actuallyTouchedIds.size > 0) {
    await saveWeekMicros(
      weekKey,
      micros,
      {
        onlyIds: [...actuallyTouchedIds]
      }
    );
  }

  const microMicroLearningId = normalizeMicroMicroFamilyId(row.microMicroFamilyId, {
    ...row,
    childTrueMicroFamilyId: childMicroFamilyId
  }) || null;

  return withAnalyzeIdentityFlags({
    ...row,

    microFamilyId: childMicroFamilyId,
    trueMicroFamilyId: childMicroFamilyId,
    childTrueMicroFamilyId: childMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    learningIds,
    parentLearningId: parentTrueMicroFamilyId,
    childLearningId: childMicroFamilyId,
    microMicroLearningId,

    source: src,
    outcomeSource: src,
    weekKey,
    recordedAt: now(),

    outcomeDuplicate: false,
    outcomeAlreadyRecorded: false,
    outcomeCounted: true,
    countOutcome: true,
    skipOutcomeCount: false,

    outcomeDedupeKey,
    outcomeDedupeMethod: outcomeClaim.method,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    stableOutcomeIdentityRequired: true,
    randomOutcomeIdNotUsedForPrimaryDedupe: true,

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: safeNumber(row.rr, 0),
    riskPct: safeNumber(row.riskPct, 0),
    rewardPct: safeNumber(row.rewardPct, 0),
    riskToRewardDistanceRatio: safeNumber(row.riskToRewardDistanceRatio, 999),

    exitTrigger: row.exitTrigger || null,
    exitPriceSource: row.exitPriceSource || null,
    exitRangeStart: row.exitRangeStart || null,
    exitRangeEnd: row.exitRangeEnd || null,
    firstTouch: row.firstTouch || null,
    conservativeExit: Boolean(row.conservativeExit),

    measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      row.positionMeasurementFixVersion ||
      row.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,

    currentFit: normalizeCurrentFitValue(row.entryCurrentFit ?? row.currentFit ?? ''),
    selectionEngineVersion: SELECTION_ENGINE_VERSION,

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

function calcShortGrossR({ entry, initialSl, exit }) {
  if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;

  const riskDistance = initialSl - entry;

  if (riskDistance <= 0) return 0;

  return (entry - exit) / riskDistance;
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
    'STOPLOSS',
    'HARD_SL',
    'DIRECT_SL'
  ].includes(reason) ||
    reason.includes('STOP_LOSS') ||
    reason.includes('STOPLOSS') ||
    reason.includes('HIT_SL') ||
    reason.includes('DIRECT_SL');

  return Boolean(position.directToSL || position.directSL) ||
    (
      stoppedOut &&
      !Boolean(position.nearTpSeen || position.reachedHalfR || position.reachedOneR) &&
      (
        mfeR < 0.25 ||
        maeR <= -0.8
      )
    );
}

function copyMicroClassificationFields(position = {}) {
  const childFromPosition = normalizeChildTrueMicroFamilyId(
    position.trueMicroFamilyId ||
      position.microFamilyId ||
      position.childTrueMicroFamilyId,
    position
  );

  const taxonomy = childFromPosition
    ? parseShortTaxonomyMicroId(childFromPosition)
    : extractFixedTaxonomyMicroId(position, position);

  const childMicroFamilyId = childFromPosition || taxonomy?.trueMicroFamilyId || '';
  const parsed = parseShortTaxonomyMicroId(childMicroFamilyId);

  if (!parsed.isChild) {
    return withAnalyzeIdentityFlags({
      outcomeIdentityLocked: false,
      outcomeIdentitySource: 'POSITION_MICRO_IDENTITY_MISSING',
      learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
      symbolExcludedFromFamilyId: true
    });
  }

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;

  const fallbackExecutionParts = buildExecutionFingerprintParts(
    position,
    position,
    {
      ...parsed,
      trueMicroFamilyId: childMicroFamilyId,
      childTrueMicroFamilyId: childMicroFamilyId,
      parentTrueMicroFamilyId
    }
  );

  const fallbackExecutionHash = hashText(
    fallbackExecutionParts.join('|'),
    EXECUTION_MICRO_HASH_LEN
  );

  const resolvedExecutionHash =
    position.executionFingerprintHash ||
    position.microMicroHash ||
    fallbackExecutionHash;

  const microMicroFamilyId = normalizeMicroMicroFamilyId(
    position.microMicroFamilyId ||
      position.trueMicroMicroFamilyId ||
      position.exactMicroMicroFamilyId ||
      position.executionMicroFamilyId ||
      '',
    {
      ...position,
      childTrueMicroFamilyId: childMicroFamilyId,
      executionFingerprintHash: resolvedExecutionHash
    }
  ) || buildMicroMicroFamilyIdFromExecution(
    childMicroFamilyId,
    resolvedExecutionHash
  );

  const executionMicroFamilyId =
    position.executionMicroFamilyId ||
    `${childMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${String(resolvedExecutionHash || '').slice(0, EXECUTION_MICRO_HASH_LEN)}`;

  const microMicroDefinitionParts = microMicroFamilyId
    ? buildMicroMicroDefinitionParts(
      position,
      {
        ...position,
        executionFingerprintParts: Array.isArray(position.executionFingerprintParts)
          ? position.executionFingerprintParts
          : fallbackExecutionParts,
        executionFingerprintHash: resolvedExecutionHash,
        microMicroFamilyId,
        microMicroHash: resolvedExecutionHash
      },
      {
        ...parsed,
        trueMicroFamilyId: childMicroFamilyId,
        childTrueMicroFamilyId: childMicroFamilyId,
        parentTrueMicroFamilyId,
        microMicroFamilyId,
        microMicroHash: resolvedExecutionHash
      }
    )
    : [];

  return withAnalyzeIdentityFlags({
    familyId: position.familyId || 'SHORT_FIXED_TAXONOMY',

    microFamilyId: childMicroFamilyId,
    trueMicroFamilyId: childMicroFamilyId,
    childTrueMicroFamilyId: childMicroFamilyId,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: resolvedExecutionHash || null,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,

    broadTrueMicroFamilyId: childMicroFamilyId,
    broadTrueDefinitionParts: position.broadTrueDefinitionParts || [],
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    fineMicroFamilyAsMetadataOnly: false,
    fixedTaxonomyLearningId: true,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    executionFingerprintHash: resolvedExecutionHash || null,
    executionFingerprintParts: Array.isArray(position.executionFingerprintParts)
      ? position.executionFingerprintParts
      : fallbackExecutionParts,
    executionFingerprintSchema: position.executionFingerprintSchema || EXECUTION_MICRO_SUFFIX,
    executionMicroFamilyId,
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: Boolean(microMicroFamilyId),

    microMicroDefinitionParts: position.microMicroDefinitionParts || microMicroDefinitionParts,
    microMicroDefinition: position.microMicroDefinition || microMicroDefinitionParts.join(' | '),
    microMicroSelectionAllowed: Boolean(microMicroFamilyId),

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
    version: 'fixed-taxonomy-parent-micro-micro-layered-v1',
    microMicroVersion: MICRO_MICRO_VERSION,

    assetClass: position.assetClass || null,
    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,
    rsiSlope: position.rsiSlope ?? null,
    rsiVelocity: position.rsiVelocity ?? null,
    rsiDelta: position.rsiDelta ?? null,
    rsiMomentum: position.rsiMomentum ?? null,

    obRelation: position.obRelation || null,
    obBias: position.obBias ?? null,
    obImbalance: position.obImbalance ?? null,
    orderbookImbalance: position.orderbookImbalance ?? null,
    bookImbalance: position.bookImbalance ?? null,
    bidAskImbalance: position.bidAskImbalance ?? null,

    spoofScore: position.spoofScore ?? null,
    orderbookSpoofScore: position.orderbookSpoofScore ?? null,
    obSpoofScore: position.obSpoofScore ?? null,
    fakeLiquidityScore: position.fakeLiquidityScore ?? null,

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
    depthMinUsd1p: position.depthMinUsd1p ?? null,
    fundingRate: position.fundingRate ?? null,

    entryQuality: position.entryQuality || null,
    retestConfirmed: Boolean(position.retestConfirmed),
    pullbackConfirmed: Boolean(position.pullbackConfirmed),
    sweepConfirmed: Boolean(position.sweepConfirmed),
    fakeBreakout: Boolean(position.fakeBreakout),
    fakeBreakoutRisk: Boolean(position.fakeBreakoutRisk),

    entryDistancePct: position.entryDistancePct ?? null,
    entryDistanceToMidPct: position.entryDistanceToMidPct ?? null,
    pullbackDistancePct: position.pullbackDistancePct ?? null,
    distanceToEntryPct: position.distanceToEntryPct ?? null,
    distancePct: position.distancePct ?? null,
    slDistancePct: position.slDistancePct ?? null,
    stopDistancePct: position.stopDistancePct ?? null,
    stopLossDistancePct: position.stopLossDistancePct ?? null,
    tpDistancePct: position.tpDistancePct ?? null,
    takeProfitDistancePct: position.takeProfitDistancePct ?? null,

    liqDistancePct: position.liqDistancePct ?? null,
    liquidationDistancePct: position.liquidationDistancePct ?? null,
    distanceToLiquidationPct: position.distanceToLiquidationPct ?? null,
    nearestLiqDistancePct: position.nearestLiqDistancePct ?? null,

    atrPct: position.atrPct ?? null,
    volatilityPct: position.volatilityPct ?? null,
    rangePct: position.rangePct ?? null,
    realizedVolPct: position.realizedVolPct ?? null,

    costR: position.costR ?? position.estimatedCostR ?? null,
    avgCostR: position.avgCostR ?? null,
    estimatedCostR: position.estimatedCostR ?? null,
    executionCostR: position.executionCostR ?? null,
    fundingCostR: position.fundingCostR ?? null,

    riskPlanVersion: position.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: safeNumber(position.rr, 0),
    riskPct: safeNumber(position.riskPct, 0),
    rewardPct: safeNumber(position.rewardPct, 0),
    riskToRewardDistanceRatio: safeNumber(position.riskToRewardDistanceRatio, 999),

    exitTrigger: position.exitTrigger || null,
    exitPriceSource: position.exitPriceSource || null,
    exitRangeStart: position.exitRangeStart || null,
    exitRangeEnd: position.exitRangeEnd || null,
    firstTouch: position.firstTouch || null,
    conservativeExit: Boolean(position.conservativeExit),

    entryMarketWeather: position.entryMarketWeather || null,
    entryCurrentRegime: position.entryCurrentRegime || position.currentRegime || null,
    entryCurrentTrendSide: position.entryCurrentTrendSide || position.currentTrendSide || null,
    entryCurrentFit: position.entryCurrentFit ?? position.currentFit ?? null,
    entryCurrentFitConfidence: position.entryCurrentFitConfidence ?? position.currentMarketFitConfidence ?? null,
    entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ?? null,
    currentFit: normalizeCurrentFitValue(position.entryCurrentFit ?? position.currentFit ?? ''),

    classifierVersion: CLASSIFIER_VERSION,
    noDefaultRetestSqueezeB: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      position.positionMeasurementFixVersion ||
      position.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLCBAvgR: true,
    selectionUsesWeeklyWinnerOnly: false,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true
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

  const validShortRiskShape =
    entry > 0 &&
    initialSl > 0 &&
    tp > 0 &&
    tp < entry &&
    entry < initialSl;

  const riskPct =
    safeNumber(position.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const rewardPct =
    entry > 0 && tp > 0
      ? Math.max(0, (entry - tp) / entry)
      : 0;

  const riskToRewardDistanceRatio =
    rewardPct > 0
      ? safeNumber(riskPct / rewardPct, 999)
      : 999;

  const grossMovePct = calcGrossMovePct({
    side: TARGET_TRADE_SIDE,
    entry,
    exit
  });

  const grossR = validShortRiskShape
    ? calcShortGrossR({
      entry,
      initialSl,
      exit
    })
    : 0;

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct, 0),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const costR = safeNumber(cost.costR, 0);
  const fundingCostR = safeNumber(position.fundingCostR, 0);
  const executionCostR = Math.max(0, costR - Math.max(0, fundingCostR));

  const netR = safeNumber(
    cost.netR,
    grossR - costR
  );

  const closedAt = safeNumber(position.closedAt || position.completedAt, now());
  const src = normalizeSource(source);
  const classification = copyMicroClassificationFields(position);

  const directToSL = inferDirectToSL({
    position,
    exitReason
  });

  const stableOutcomeIdentity = [
    TARGET_TRADE_SIDE,
    position.tradeId || '',
    position.symbol || position.contractSymbol || '',
    position.openedAt || position.createdAt || '',
    closedAt || '',
    exitReason || '',
    exit,
    classification.trueMicroFamilyId || classification.microFamilyId || '',
    classification.microMicroFamilyId || ''
  ].join('|');

  return withAnalyzeIdentityFlags({
    type: 'OUTCOME',
    source: src,
    outcomeSource: src,
    positionSource: position.source || 'VIRTUAL',
    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,
    positionId: position.positionId || position.id || null,
    outcomeIdentity: position.outcomeIdentity || stableOutcomeIdentity,
    stableOutcomeIdentity,
    outcomeIdentityHashSource: 'TRADE_ID_SYMBOL_OPEN_CLOSE_REASON_EXIT_CHILD_MICRO_AND_MICRO_MICRO',

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
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
    rewardPct,
    riskToRewardDistanceRatio,
    riskPlanVersion: position.riskPlanVersion || SHORT_RISK_PLAN_VERSION,

    validShortRiskShape,
    validShortGeometry: validShortRiskShape,
    shortValidGeometry: validShortRiskShape,

    exitReason,
    exitTrigger: position.exitTrigger || null,
    exitPriceSource: position.exitPriceSource || null,
    exitRangeStart: position.exitRangeStart || null,
    exitRangeEnd: position.exitRangeEnd || null,
    firstTouch: position.firstTouch || null,
    conservativeExit: Boolean(position.conservativeExit),

    grossMovePct,
    grossR,
    shortGrossR: grossR,
    rawR: grossR,
    realizedGrossR: grossR,
    grossPnlPct: safeNumber(cost.grossPnlPct, grossMovePct),

    exitR: netR,
    pnlPct: safeNumber(cost.netPnlPct, 0),
    netR,
    shortNetR: netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,
    netPnlPct: safeNumber(cost.netPnlPct, 0),

    costR,
    avgCostR: costR,
    executionCostR,
    fundingCostR,
    costPct: safeNumber(cost.costPct, 0),
    feePct: safeNumber(cost.feePct, 0),
    slippagePct: safeNumber(cost.slippagePct, 0),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: 'APPLY_COSTS_NET_R_V2_EXECUTION_FUNDING_SPLIT',

    mfeR: safeNumber(position.mfeR, 0),
    maeR: safeNumber(position.maeR, 0),

    directToSL,
    directSL: directToSL,

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    entryMarketWeather: position.entryMarketWeather || null,
    entryCurrentRegime: position.entryCurrentRegime || position.currentRegime || null,
    entryCurrentTrendSide: position.entryCurrentTrendSide || position.currentTrendSide || null,
    entryCurrentFit: position.entryCurrentFit ?? position.currentFit ?? null,
    entryCurrentFitConfidence: position.entryCurrentFitConfidence ?? position.currentMarketFitConfidence ?? null,
    entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ?? null,
    currentFit: normalizeCurrentFitValue(position.entryCurrentFit ?? position.currentFit ?? ''),

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLCBAvgR: true,
    selectionUsesWeeklyWinnerOnly: false,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      position.positionMeasurementFixVersion ||
      position.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,

    stableOutcomeIdentityRequired: true,
    randomOutcomeIdNotUsedForPrimaryDedupe: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    openedAt: position.openedAt || position.createdAt || null,
    closedAt,
    completedAt: closedAt
  });
}

export async function getWeeklyTradingCandidates(
  weekKey = PERSISTENT_LEARNING_KEY,
  {
    limit = 10,
    requireCurrentFitMatch = true,
    currentFitLookup = null,
    includeMeta = false
  } = {}
) {
  const micros = await getWeekMicros(weekKey);

  const candidates = scoreWeeklyTradingCandidates(micros, {
    requireCurrentFitMatch,
    currentFitLookup: currentFitLookup || currentFitLookupFromStoredRow
  })
    .filter((row) => learningLayerForId(row.trueMicroFamilyId || row.microFamilyId) === LAYER_MICRO_MICRO)
    .slice(0, Math.max(1, Math.floor(safeNumber(limit, 10))))
    .map((row, index) => withAnalyzeIdentityFlags({
      ...row,
      rank: index + 1,
      weekKey,
      tradingCandidate: true,
      tradingEligible: true,
      eligibleGatePassed: true,
      selectionEngineVersion: SELECTION_ENGINE_VERSION,
      selectionSource: 'LIFETIME_LCB_CURRENTFIT',
      selectionUsesWeeklyWinnerOnly: false,
      selectionUsesLCBAvgR: true,
      selectionRequiresCurrentFitMatch: requireCurrentFitMatch,
      currentFit: normalizeCurrentFitValue(
        currentFitLookup
          ? currentFitLookup(row)
          : currentFitLookupFromStoredRow(row)
      ),
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
      discordMatchId: row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId || row.microFamilyId,
      note: 'Candidate is lifetime eligible by LCB avgR and optionally currentFit-matched.'
    }));

  if (!includeMeta) {
    return candidates;
  }

  return {
    weekKey,
    generatedAt: now(),
    count: candidates.length,
    candidates,
    requireCurrentFitMatch,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    rules: {
      selectionUsesWeeklyWinnerOnly: false,
      selectionUsesLifetimeStats: true,
      selectionUsesLCBAvgR: true,
      selectionRequiresEligibleGate: true,
      selectionRequiresCurrentFitMatch: requireCurrentFitMatch,
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY'
    },
    emptyReason: candidates.length
      ? null
      : requireCurrentFitMatch
        ? 'NO_ELIGIBLE_MICRO_MICRO_WITH_CURRENT_FIT_MATCH'
        : 'NO_ELIGIBLE_MICRO_MICRO'
  };
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}