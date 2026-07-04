// ================= FILE: src/trade/riskEngine.js =================
//
// SHORT-only risk engine.
//
// Doel:
// - Geen LONG.
// - Geen echte orders.
// - Risk geometry blijft SHORT-valid: tp < entry < sl.
// - Risk wordt structureel + cost-aware:
//   eerst echte invalidation / orderbook-wall / swing-high,
//   daarna pas ATR/spread fallback.
// - Als structurele SL te krap is voor costR-cap: GEEN trade.
// - Geen kunstmatig bredere SL los van structuur.
// - TP wordt structureel bepaald via liquidity target:
//   swing-low / bid-wall / OI-funding proxy.
// - RR-shadow grid wordt meegegeven:
//   1.0R / 1.25R / 1.5R / 1.75R / 2.0R.
// - Micro-micro identity:
//   MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
// - XR blijft execution metadata, geen learning family.
// - Scanner buckets blijven metadata.

import { CONFIG } from '../config.js';
import {
  calculateAtrPct,
  calculateRsi,
  getRsiSlope,
  getRsiZone,
  classifyFlow
} from '../market/indicators.js';
import {
  clamp,
  getObRelation,
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
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MICRO_MICRO_SUFFIX = 'MM';
const EXECUTION_MICRO_SUFFIX = 'XR';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const RR_SHADOW_GRID_VERSION = 'SHORT_RR_SHADOW_GRID_1_125_15_175_2_V1';
const SELECTION_ENGINE_VERSION = 'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V1';

const DEFAULT_RR_VARIANTS = Object.freeze([1.0, 1.25, 1.5, 1.75, 2.0]);

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

function now() {
  return Date.now();
}

function tradeConfig() {
  return {
    minRR: safeNumber(
      CONFIG.short?.trade?.minRR ??
        CONFIG.trade?.shortMinRR ??
        CONFIG.trade?.minRR,
      0.5
    ),

    defaultRR: safeNumber(
      CONFIG.short?.trade?.defaultRR ??
        CONFIG.trade?.shortDefaultRR ??
        CONFIG.trade?.defaultRR,
      1.5
    ),

    maxSpreadPct: safeNumber(
      CONFIG.short?.trade?.maxSpreadPct ??
        CONFIG.trade?.shortMaxSpreadPct ??
        CONFIG.trade?.maxSpreadPct,
      0.015
    ),

    minRiskPct: safeNumber(
      CONFIG.short?.trade?.minRiskPct ??
        CONFIG.trade?.shortMinRiskPct ??
        CONFIG.trade?.minRiskPct,
      0.004
    ),

    maxRiskPct: safeNumber(
      CONFIG.short?.trade?.maxRiskPct ??
        CONFIG.trade?.shortMaxRiskPct ??
        CONFIG.trade?.maxRiskPct,
      0.025
    ),

    fallbackRiskPct: safeNumber(
      CONFIG.short?.trade?.fallbackRiskPct ??
        CONFIG.trade?.shortFallbackRiskPct ??
        CONFIG.trade?.fallbackRiskPct,
      0.005
    ),

    atrRiskMult: safeNumber(
      CONFIG.short?.trade?.atrRiskMult ??
        CONFIG.trade?.shortAtrRiskMult ??
        CONFIG.trade?.atrRiskMult,
      1.2
    ),

    spreadRiskMult: safeNumber(
      CONFIG.short?.trade?.spreadRiskMult ??
        CONFIG.trade?.shortSpreadRiskMult ??
        CONFIG.trade?.spreadRiskMult,
      5
    ),

    costAwareRiskEnabled:
      CONFIG.short?.trade?.costAwareRiskEnabled ??
      CONFIG.trade?.shortCostAwareRiskEnabled ??
      CONFIG.trade?.costAwareRiskEnabled ??
      true,

    maxEstimatedCostR: safeNumber(
      CONFIG.short?.trade?.maxEstimatedCostR ??
        CONFIG.trade?.shortMaxEstimatedCostR ??
        CONFIG.trade?.maxEstimatedCostR,
      0.35
    ),

    hardMaxEstimatedCostR: safeNumber(
      CONFIG.short?.trade?.hardMaxEstimatedCostR ??
        CONFIG.trade?.shortHardMaxEstimatedCostR ??
        CONFIG.trade?.hardMaxEstimatedCostR,
      0.55
    ),

    rejectCostHeavyRisk:
      CONFIG.short?.trade?.rejectCostHeavyRisk ??
      CONFIG.trade?.shortRejectCostHeavyRisk ??
      CONFIG.trade?.rejectCostHeavyRisk ??
      false,

    positionTimeStopMin: safeNumber(
      CONFIG.short?.trade?.positionTimeStopMin ??
        CONFIG.trade?.shortPositionTimeStopMin ??
        CONFIG.trade?.positionTimeStopMin,
      DEFAULT_POSITION_TIME_STOP_MIN
    ),

    structuralRiskEnabled:
      CONFIG.short?.trade?.structuralRiskEnabled ??
      CONFIG.trade?.shortStructuralRiskEnabled ??
      CONFIG.trade?.structuralRiskEnabled ??
      true,

    structuralStopLookback: Math.max(
      5,
      Math.floor(safeNumber(
        CONFIG.short?.trade?.structuralStopLookback ??
          CONFIG.trade?.shortStructuralStopLookback ??
          CONFIG.trade?.structuralStopLookback,
        24
      ))
    ),

    structuralTargetLookback: Math.max(
      5,
      Math.floor(safeNumber(
        CONFIG.short?.trade?.structuralTargetLookback ??
          CONFIG.trade?.shortStructuralTargetLookback ??
          CONFIG.trade?.structuralTargetLookback,
        24
      ))
    ),

    structuralBufferAtrMult: safeNumber(
      CONFIG.short?.trade?.structuralBufferAtrMult ??
        CONFIG.trade?.shortStructuralBufferAtrMult ??
        CONFIG.trade?.structuralBufferAtrMult,
      0.15
    ),

    structuralBufferSpreadMult: safeNumber(
      CONFIG.short?.trade?.structuralBufferSpreadMult ??
        CONFIG.trade?.shortStructuralBufferSpreadMult ??
        CONFIG.trade?.structuralBufferSpreadMult,
      2
    ),

    minOrderbookWallUsd: safeNumber(
      CONFIG.short?.trade?.minOrderbookWallUsd ??
        CONFIG.trade?.shortMinOrderbookWallUsd ??
        CONFIG.trade?.minOrderbookWallUsd,
      100_000
    ),

    liquidityTargetEnabled:
      CONFIG.short?.trade?.liquidityTargetEnabled ??
      CONFIG.trade?.shortLiquidityTargetEnabled ??
      CONFIG.trade?.liquidityTargetEnabled ??
      true,

    liquidityTargetMaxRR: safeNumber(
      CONFIG.short?.trade?.liquidityTargetMaxRR ??
        CONFIG.trade?.shortLiquidityTargetMaxRR ??
        CONFIG.trade?.liquidityTargetMaxRR,
      4
    )
  };
}

function costConfig() {
  return {
    fallbackSpreadPct: safeNumber(
      CONFIG.short?.cost?.fallbackSpreadPct ??
        CONFIG.cost?.shortFallbackSpreadPct ??
        CONFIG.cost?.fallbackSpreadPct,
      0.0008
    ),

    roundTripFeePct: safeNumber(
      CONFIG.short?.cost?.roundTripFeePct ??
        CONFIG.cost?.shortRoundTripFeePct ??
        CONFIG.cost?.roundTripFeePct ??
        CONFIG.short?.cost?.feePct ??
        CONFIG.cost?.feePct,
      0.0012
    ),

    roundTripSlippagePct: safeNumber(
      CONFIG.short?.cost?.roundTripSlippagePct ??
        CONFIG.cost?.shortRoundTripSlippagePct ??
        CONFIG.cost?.roundTripSlippagePct ??
        CONFIG.short?.cost?.slippagePct ??
        CONFIG.cost?.slippagePct,
      0.0004
    ),

    spreadCostMult: safeNumber(
      CONFIG.short?.cost?.spreadCostMult ??
        CONFIG.cost?.shortSpreadCostMult ??
        CONFIG.cost?.spreadCostMult,
      1
    )
  };
}

function fallbackSpreadPct() {
  return costConfig().fallbackSpreadPct;
}

function scoreInput(candidate = {}) {
  return safeNumber(
    candidate.scannerScore ?? candidate.moveScore,
    0
  );
}

function roundPrice(value) {
  const n = safeNumber(value, 0);

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(6));

  return Number(n.toFixed(10));
}

function round2(value) {
  return Number(safeNumber(value, 0).toFixed(2));
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const text = String(value || '').toLowerCase().trim();

  return ['true', '1', 'yes', 'y', 'on'].includes(text);
}

function upper(value, fallback = 'UNKNOWN') {
  const text = String(value || '').trim();

  return text
    ? text.toUpperCase()
    : fallback;
}

function cleanSideText(value = '') {
  return upper(value, '')
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
  const raw = normalizedSignalText(value);

  if (!raw) return false;
  if (SHORT_TOKENS.has(raw)) return true;

  return hasSignalPattern(raw, [
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
  const raw = normalizedSignalText(value);

  if (!raw) return false;
  if (LONG_TOKENS.has(raw)) return true;

  return hasSignalPattern(raw, [
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

function normalizeTradeSideValue(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isModernMicroMicroId(id = '') {
  return /^MICRO_SHORT_.+_MM_[A-Z0-9]{6,24}$/u.test(upper(id, ''));
}

function isScannerFingerprintId(id = '') {
  const value = upper(id, '');

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
  const value = upper(id, '');

  if (isModernMicroMicroId(value)) return false;

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
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
  const value = upper(rawId, '');

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
    microMicroHash = microMicroMatch[2].slice(0, 10);
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
    selectable: isMicroMicro,
    selectableForDiscord: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    base75ChildTrueMicroFamilyId: validChild ? childId : null,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : isChild
        ? 'EXACT_75_CHILD_CONTEXT_ONLY'
        : 'PARENT_15_CONTEXT_ONLY'
  };
}

function normalizeMicroMicroFamilyId(id = '', row = {}) {
  const direct = String(id || '').trim().toUpperCase();

  if (direct && validLearningId(direct)) {
    const parsed = parseShortTaxonomyMicroId(direct);

    if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
  }

  const child = normalizeChildTrueMicroFamilyId(
    row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      ''
  );

  const hash = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  )
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 10);

  if (child && hash.length >= 6) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
  }

  return '';
}

function normalizeChildTrueMicroFamilyId(id = '') {
  const value = String(id || '').trim().toUpperCase();

  if (!value || !validLearningId(value)) return '';

  const parsed = parseShortTaxonomyMicroId(value);

  if (parsed.isMicroMicro) return parsed.childTrueMicroFamilyId || '';
  if (parsed.isChild) return parsed.childTrueMicroFamilyId || '';

  return '';
}

function identityFromCandidate(row = {}) {
  const rawMicroMicroId = String(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      ''
  ).trim().toUpperCase();

  const parsedMicroMicro = parseShortTaxonomyMicroId(rawMicroMicroId);

  if (parsedMicroMicro.isMicroMicro) {
    return {
      trueMicroFamilyId: parsedMicroMicro.microMicroFamilyId,
      microFamilyId: parsedMicroMicro.microMicroFamilyId,
      childTrueMicroFamilyId: parsedMicroMicro.childTrueMicroFamilyId,
      base75ChildTrueMicroFamilyId: parsedMicroMicro.childTrueMicroFamilyId,
      parentTrueMicroFamilyId: parsedMicroMicro.parentTrueMicroFamilyId,
      microMicroFamilyId: parsedMicroMicro.microMicroFamilyId,
      trueMicroMicroFamilyId: parsedMicroMicro.microMicroFamilyId,
      exactMicroMicroFamilyId: parsedMicroMicro.microMicroFamilyId,
      microMicroHash: parsedMicroMicro.microMicroHash,
      setupType: parsedMicroMicro.setup,
      regimeBucket: parsedMicroMicro.regime,
      confirmationProfile: parsedMicroMicro.confirmationProfile,
      exact75Child: false,
      parent15: false,
      microMicro: true
    };
  }

  const rawId = String(
    row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.analyzeMicroFamilyId ||
      row.learningMicroFamilyId ||
      ''
  ).trim().toUpperCase();

  if (!rawId || !validLearningId(rawId)) {
    return {
      trueMicroFamilyId: null,
      microFamilyId: null,
      childTrueMicroFamilyId: null,
      base75ChildTrueMicroFamilyId: null,
      parentTrueMicroFamilyId: null,
      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,
      microMicroHash: null,
      setupType: null,
      regimeBucket: null,
      confirmationProfile: null,
      exact75Child: false,
      parent15: false,
      microMicro: false
    };
  }

  const parsed = parseShortTaxonomyMicroId(rawId);

  if (!parsed.valid) {
    return {
      trueMicroFamilyId: rawId,
      microFamilyId: rawId,
      childTrueMicroFamilyId: null,
      base75ChildTrueMicroFamilyId: null,
      parentTrueMicroFamilyId: null,
      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,
      microMicroHash: null,
      setupType: null,
      regimeBucket: null,
      confirmationProfile: null,
      exact75Child: false,
      parent15: false,
      microMicro: false
    };
  }

  const microMicroFamilyId = normalizeMicroMicroFamilyId('', {
    ...row,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId
  });

  return {
    trueMicroFamilyId: parsed.childTrueMicroFamilyId || parsed.trueMicroFamilyId,
    microFamilyId: parsed.childTrueMicroFamilyId || parsed.trueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: row.microMicroHash || row.executionFingerprintHash || null,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    exact75Child: parsed.isChild,
    parent15: parsed.isParent,
    microMicro: false
  };
}

function inferTradeSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,

    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,

    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  const shortHit = hasShortSignal(haystack);
  const longHit = hasLongSignal(haystack);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromDefinition(row = {}) {
  const haystack = [
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

  if (!haystack) return 'UNKNOWN';

  const shortHit = hasShortSignal(haystack);
  const longHit = hasLongSignal(haystack);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromReason(row = {}) {
  const reason = cleanSideText(
    row.scannerReason ||
      row.reason ||
      row.signalReason ||
      row.actionReason ||
      ''
  );

  if (!reason) return 'UNKNOWN';
  if (hasShortSignal(reason) && !hasLongSignal(reason)) return TARGET_TRADE_SIDE;
  if (hasLongSignal(reason) && !hasShortSignal(reason)) return OPPOSITE_TRADE_SIDE;
  if (hasShortSignal(reason)) return TARGET_TRADE_SIDE;
  if (hasLongSignal(reason)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSideValue(row);
  }

  const candidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.expectedSide,
    row.predictedSide,
    row.intentSide,
    row.biasSide,
    row.side
  ];

  for (const value of candidates) {
    const side = normalizeTradeSideValue(value);

    if (side !== 'UNKNOWN') return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds !== 'UNKNOWN') return fromIds;

  const fromDefinition = inferTradeSideFromDefinition(row);

  if (fromDefinition !== 'UNKNOWN') return fromDefinition;

  const fromReason = inferTradeSideFromReason(row);

  if (fromReason !== 'UNKNOWN') return fromReason;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasExplicitLongSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSideValue(row) === OPPOSITE_TRADE_SIDE;
  }

  const directCandidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.expectedSide,
    row.predictedSide,
    row.intentSide,
    row.biasSide,
    row.side
  ];

  for (const value of directCandidates) {
    if (normalizeTradeSideValue(value) === OPPOSITE_TRADE_SIDE) return true;
  }

  return (
    inferTradeSideFromIds(row) === OPPOSITE_TRADE_SIDE ||
    inferTradeSideFromDefinition(row) === OPPOSITE_TRADE_SIDE ||
    inferTradeSideFromReason(row) === OPPOSITE_TRADE_SIDE
  );
}

function sideLabel(sideOrRow) {
  return typeof sideOrRow === 'object' && sideOrRow !== null
    ? inferTradeSide(sideOrRow)
    : normalizeTradeSideValue(sideOrRow);
}

function isShort(side) {
  return sideLabel(side) === TARGET_TRADE_SIDE;
}

function modeFlags(row = {}) {
  const identity = identityFromCandidate(row);

  return {
    sideMode: 'SHORT_ONLY',

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
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    noRealOrders: true,
    noExchangeOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    scannerBucketsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    analyzeAssignsTrueMicroFamily: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    trueMicroFamilyId: identity.trueMicroFamilyId || null,
    microFamilyId: identity.microFamilyId || identity.trueMicroFamilyId || null,
    childTrueMicroFamilyId: identity.childTrueMicroFamilyId || null,
    base75ChildTrueMicroFamilyId: identity.base75ChildTrueMicroFamilyId || identity.childTrueMicroFamilyId || null,
    parentTrueMicroFamilyId: identity.parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: identity.parentTrueMicroFamilyId || null,

    microMicroFamilyId: identity.microMicroFamilyId || null,
    trueMicroMicroFamilyId: identity.trueMicroMicroFamilyId || null,
    exactMicroMicroFamilyId: identity.exactMicroMicroFamilyId || null,
    microMicroHash: identity.microMicroHash || null,

    setupType: identity.setupType,
    regimeBucket: identity.regimeBucket,
    confirmationProfile: identity.confirmationProfile,

    exact75ChildTrueMicro: identity.exact75Child,
    parent15TrueMicroMetadataOnly: identity.parent15,
    exactMicroMicro: identity.microMicro,

    exactTrueMicroFamilySchema: identity.microMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: identity.microMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: identity.microMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,
    selectionGranularity: identity.microMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : 'CONTEXT_ONLY_NOT_SELECTABLE',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

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

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    observingStatusRule: 'completed = 0',
    earlyOutcomesStatusRule: 'completed > 0 && completed < 20',
    activeLearningStatusRule: 'completed >= 20',
    microMicroActiveLearningStatusRule: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`,

    defaultRanking: 'eligible|avgRLCB95|totalR|avgR|profitFactor|directSLPct|avgCostR',
    noBareWinrateRanking: true,

    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,

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

    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function dashboardSideFromTradeSide(side) {
  return isShort(side) ? TARGET_DASHBOARD_SIDE : 'unknown';
}

function withTradeSide(candidate = {}, side = TARGET_TRADE_SIDE) {
  const requestedTradeSide = normalizeTradeSideValue(side);

  if (requestedTradeSide !== TARGET_TRADE_SIDE) return null;
  if (hasExplicitLongSide(candidate)) return null;

  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return null;

  return {
    ...candidate,
    originalSide: candidate.side ?? candidate.tradeSide ?? null,
    ...modeFlags(candidate)
  };
}

function btcRelation(side, btcState) {
  const tradeSide = sideLabel(side);
  const btc = upper(btcState, 'NEUTRAL');

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';

  if (tradeSide === TARGET_TRADE_SIDE && ['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN'].includes(btc)) {
    return 'BTC_WITH';
  }

  if (tradeSide === TARGET_TRADE_SIDE) return 'BTC_AGAINST';

  return 'BTC_UNKNOWN';
}

function directionalReward({
  entry,
  tp,
  side
} = {}) {
  if (!isShort(side)) return 0;

  return entry - tp;
}

function directionalChange({
  side,
  change
} = {}) {
  const value = safeNumber(change, 0);

  if (!isShort(side)) return 0;

  return -value;
}

function rsiBucket(value) {
  const rsi = safeNumber(value, 50);

  if (rsi < 25) return 'RSI_LT_25';
  if (rsi < 30) return 'RSI_25_30';
  if (rsi < 35) return 'RSI_30_35';
  if (rsi < 40) return 'RSI_35_40';
  if (rsi < 45) return 'RSI_40_45';
  if (rsi < 50) return 'RSI_45_50';
  if (rsi < 55) return 'RSI_50_55';
  if (rsi < 60) return 'RSI_55_60';
  if (rsi < 65) return 'RSI_60_65';
  if (rsi < 70) return 'RSI_65_70';
  if (rsi < 75) return 'RSI_70_75';

  return 'RSI_GT_75';
}

function rsiSlopeBucket(value) {
  const slope = safeNumber(value, 0);

  if (slope <= -5) return 'SLOPE_STRONG_DOWN';
  if (slope <= -2) return 'SLOPE_DOWN';
  if (slope < -0.5) return 'SLOPE_SOFT_DOWN';
  if (slope <= 0.5) return 'SLOPE_FLAT';
  if (slope < 2) return 'SLOPE_SOFT_UP';
  if (slope < 5) return 'SLOPE_UP';

  return 'SLOPE_STRONG_UP';
}

function rsiAlignment({
  side,
  rsi,
  rsiHTF,
  rsiSlope
} = {}) {
  if (!isShort(side)) return 'RSI_UNKNOWN';

  const slope = safeNumber(rsiSlope, 0);
  const local = safeNumber(rsi, 50);
  const htf = safeNumber(rsiHTF, 50);

  if (slope < -0.5 && htf <= 55 && local >= 28) return 'RSI_WITH';
  if (slope > 0.5 || htf > 62 || local < 22) return 'RSI_AGAINST';

  return 'RSI_NEUTRAL';
}

function momentumBucket({
  side,
  change1h,
  change24h
} = {}) {
  const d1h = directionalChange({ side, change: change1h });
  const d24h = directionalChange({ side, change: change24h });

  if (d1h >= 3 || d24h >= 10) return 'MOM_STRONG_WITH';
  if (d1h >= 1 || d24h >= 4) return 'MOM_WITH';
  if (d1h <= -3 || d24h <= -10) return 'MOM_STRONG_AGAINST';
  if (d1h <= -1 || d24h <= -4) return 'MOM_AGAINST';

  return 'MOM_NEUTRAL';
}

function volatilityBucket(atrPct) {
  const atr = safeNumber(atrPct, 0);

  if (atr <= 0) return 'ATR_UNKNOWN';
  if (atr < 0.003) return 'ATR_LT_30BPS';
  if (atr < 0.006) return 'ATR_30_60BPS';
  if (atr < 0.010) return 'ATR_60_100BPS';
  if (atr < 0.015) return 'ATR_100_150BPS';
  if (atr < 0.025) return 'ATR_150_250BPS';

  return 'ATR_GT_250BPS';
}

function riskPctBucket(riskPct) {
  const risk = safeNumber(riskPct, 0);

  if (risk <= 0) return 'RISK_UNKNOWN';
  if (risk < 0.005) return 'RISK_LT_50BPS';
  if (risk < 0.008) return 'RISK_50_80BPS';
  if (risk < 0.012) return 'RISK_80_120BPS';
  if (risk < 0.018) return 'RISK_120_180BPS';
  if (risk < 0.025) return 'RISK_180_250BPS';

  return 'RISK_GT_250BPS';
}

function spreadBps(spreadPct) {
  return round4(safeNumber(spreadPct, 0) * 10000);
}

function spreadBucket(spreadPct) {
  const bps = spreadBps(spreadPct);

  if (bps <= 0) return 'SPREAD_UNKNOWN';
  if (bps < 4) return 'SPREAD_LT_4BPS';
  if (bps < 8) return 'SPREAD_4_8BPS';
  if (bps < 12) return 'SPREAD_8_12BPS';
  if (bps < 20) return 'SPREAD_12_20BPS';

  return 'SPREAD_GT_20BPS';
}

function depthBucket(depthUsd) {
  const depth = safeNumber(depthUsd, 0);

  if (depth >= 1_000_000) return 'DEPTH_GT_1M';
  if (depth >= 500_000) return 'DEPTH_500K_1M';
  if (depth >= 250_000) return 'DEPTH_250K_500K';
  if (depth >= 100_000) return 'DEPTH_100K_250K';
  if (depth >= 50_000) return 'DEPTH_50K_100K';
  if (depth > 0) return 'DEPTH_LT_50K';

  return 'DEPTH_UNKNOWN';
}

function fundingBucket(rate) {
  const funding = safeNumber(rate, 0);

  if (funding >= 0.0005) return 'FUNDING_POS_EXTREME';
  if (funding >= 0.0002) return 'FUNDING_POS_HIGH';
  if (funding > 0.00005) return 'FUNDING_POS';
  if (funding <= -0.0005) return 'FUNDING_NEG_EXTREME';
  if (funding <= -0.0002) return 'FUNDING_NEG_HIGH';
  if (funding < -0.00005) return 'FUNDING_NEG';

  return 'FUNDING_NEUTRAL';
}

function fundingAlignment({
  side,
  fundingRate
} = {}) {
  const rate = safeNumber(fundingRate, 0);

  if (Math.abs(rate) < 0.00005) return 'FUNDING_NEUTRAL';
  if (!isShort(side)) return 'FUNDING_UNKNOWN';

  return rate > 0 ? 'FUNDING_WITH' : 'FUNDING_AGAINST';
}

function obDepthValue(ob = {}) {
  return safeNumber(
    ob.depthMinUsd1p ??
      ob.minDepthUsd1p ??
      ob.depthUsd1p ??
      ob.depthUsd ??
      0,
    0
  );
}

function obImbalance(ob = {}) {
  const bidDepth = safeNumber(
    ob.bidDepthUsd1p ??
      ob.bidUsd1p ??
      ob.bidsUsd1p ??
      ob.bidDepthUsd ??
      0,
    0
  );

  const askDepth = safeNumber(
    ob.askDepthUsd1p ??
      ob.askUsd1p ??
      ob.asksUsd1p ??
      ob.askDepthUsd ??
      0,
    0
  );

  const total = bidDepth + askDepth;

  if (total <= 0) return 0;

  return clamp((bidDepth - askDepth) / total, -1, 1);
}

function obImbalanceBucket(value) {
  const imbalance = safeNumber(value, 0);

  if (imbalance >= 0.35) return 'OB_BID_STRONG';
  if (imbalance >= 0.12) return 'OB_BID';
  if (imbalance <= -0.35) return 'OB_ASK_STRONG';
  if (imbalance <= -0.12) return 'OB_ASK';

  return 'OB_BALANCED';
}

function scannerReason(candidate = {}) {
  const reason = upper(
    candidate.scannerReason ||
      candidate.reason ||
      candidate.signalReason ||
      'UNKNOWN'
  );

  if (reason.includes('RETEST')) return 'RETEST';
  if (reason.includes('PULLBACK')) return 'PULLBACK';
  if (reason.includes('BREAKOUT')) return 'BREAKOUT';
  if (reason.includes('VOLUME')) return 'VOLUME';
  if (reason.includes('MOMENTUM')) return 'MOMENTUM';
  if (reason.includes('SWEEP')) return 'SWEEP';

  return reason;
}

function inferEntryFlags(candidate = {}) {
  const reason = scannerReason(candidate);

  const pullbackConfirmed =
    bool(candidate.pullbackConfirmed) ||
    reason.includes('PULLBACK');

  const retestConfirmed =
    bool(candidate.retestConfirmed) ||
    reason.includes('RETEST');

  const sweepConfirmed =
    bool(candidate.sweepConfirmed) ||
    reason.includes('SWEEP');

  const fakeBreakout =
    bool(candidate.fakeBreakout) ||
    bool(candidate.fakeBreakoutRisk);

  let entryQuality = 'RAW';

  if (retestConfirmed) entryQuality = 'RETEST';
  else if (pullbackConfirmed) entryQuality = 'PULLBACK';
  else if (sweepConfirmed) entryQuality = 'SWEEP';
  else if (reason.includes('BREAKOUT')) entryQuality = 'BREAKOUT';
  else if (reason.includes('MOMENTUM')) entryQuality = 'MOMENTUM';

  return {
    pullbackConfirmed,
    retestConfirmed,
    sweepConfirmed,
    fakeBreakout,
    fakeBreakoutRisk: fakeBreakout,
    entryQuality
  };
}

function directionalMoveScore({
  side,
  rsiZone,
  rsiSlope,
  rsiHTF,
  rsiAlign
} = {}) {
  if (!isShort(side)) return -20;

  const zone = upper(rsiZone, 'MID');
  const slope = safeNumber(rsiSlope, 0);
  const htf = safeNumber(rsiHTF, 50);

  let score = 0;

  if (zone.startsWith('UPPER')) score += 10;
  if (zone === 'MID') score += 5;
  if (slope < 0) score += 5;
  if (htf <= 55 && htf >= 32) score += 5;
  if (htf < 26) score -= 6;

  if (rsiAlign === 'RSI_WITH') score += 4;
  if (rsiAlign === 'RSI_AGAINST') score -= 6;

  return score;
}

function spreadQualityScore(spreadPct) {
  const cfg = tradeConfig();
  const spread = safeNumber(spreadPct, 0);

  if (spread <= 0) return -4;
  if (spread <= 0.0004) return 8;
  if (spread <= 0.0008) return 5;
  if (spread <= 0.0015) return 1;
  if (spread <= cfg.maxSpreadPct) return -4;

  return -12;
}

function depthQualityScore(depthUsd) {
  const depth = safeNumber(depthUsd, 0);

  if (depth >= 1_000_000) return 10;
  if (depth >= 500_000) return 8;
  if (depth >= 250_000) return 6;
  if (depth >= 100_000) return 4;
  if (depth >= 50_000) return 1;
  if (depth > 0) return -4;

  return -8;
}

function rrScore(rr) {
  const cfg = tradeConfig();
  const r = safeNumber(rr, 0);

  if (r >= 2.5) return 14;
  if (r >= 2.0) return 12;
  if (r >= 1.5) return 10;
  if (r >= 1.0) return 6;
  if (r >= cfg.minRR) return 2;

  return -12;
}

function flowScore(flow) {
  const f = upper(flow, 'NEUTRAL');

  if (f === 'TREND') return 18;
  if (f === 'IMPULSE') return 15;
  if (f === 'BUILDING') return 10;

  return 2;
}

function obRelationScore(obRelation) {
  const relation = upper(obRelation, 'UNKNOWN');

  if (relation === 'WITH') return 15;
  if (relation === 'NEUTRAL') return 4;
  if (relation === 'AGAINST') return -12;

  return -4;
}

function sniperObScore(obRelation) {
  const relation = upper(obRelation, 'UNKNOWN');

  if (relation === 'WITH') return 18;
  if (relation === 'NEUTRAL') return 6;
  if (relation === 'AGAINST') return -15;

  return -5;
}

function btcScore(relationToBtc) {
  const relation = upper(relationToBtc, 'BTC_UNKNOWN');

  if (relation === 'BTC_WITH') return 8;
  if (relation === 'BTC_NEUTRAL') return 2;
  if (relation === 'BTC_AGAINST') return -8;

  return -3;
}

function entryQualityScore(flags = {}) {
  if (flags.retestConfirmed) return 8;
  if (flags.pullbackConfirmed) return 7;
  if (flags.sweepConfirmed) return 5;
  if (flags.entryQuality === 'MOMENTUM') return 3;

  return 0;
}

function fundingScore(alignment) {
  const value = upper(alignment, 'FUNDING_UNKNOWN');

  if (value === 'FUNDING_WITH') return 3;
  if (value === 'FUNDING_NEUTRAL') return 1;
  if (value === 'FUNDING_AGAINST') return -3;

  return 0;
}

function estimateTotalCostPct({
  spreadPct
} = {}) {
  const cfg = costConfig();
  const spread = Math.max(0, safeNumber(spreadPct, cfg.fallbackSpreadPct));

  return Math.max(
    0,
    safeNumber(cfg.roundTripFeePct, 0) +
      safeNumber(cfg.roundTripSlippagePct, 0) +
      spread * safeNumber(cfg.spreadCostMult, 1)
  );
}

function estimateCostR({
  spreadPct,
  riskPct
} = {}) {
  const risk = safeNumber(riskPct, 0);

  if (risk <= 0) return 999;

  return estimateTotalCostPct({ spreadPct }) / risk;
}

function normalizeRR(value) {
  const rr = safeNumber(value, NaN);

  if (!Number.isFinite(rr)) return null;
  if (rr <= 0) return null;

  return Number(rr.toFixed(4));
}

function normalizeRRVariants(primaryRR) {
  const cfg = tradeConfig();

  const configured =
    CONFIG.short?.trade?.rrVariants ??
    CONFIG.trade?.shortRRVariants ??
    CONFIG.trade?.rrVariants ??
    DEFAULT_RR_VARIANTS;

  const raw = Array.isArray(configured) ? configured : DEFAULT_RR_VARIANTS;

  return [...new Set([
    ...raw,
    primaryRR
  ]
    .map(normalizeRR)
    .filter((rr) => rr !== null)
    .filter((rr) => rr >= cfg.minRR)
    .filter((rr) => rr <= 5)
    .map((rr) => Number(rr.toFixed(4))))]
    .sort((a, b) => a - b);
}

function buildRRVariantTargets({
  entry,
  riskPct,
  variants
} = {}) {
  const e = safeNumber(entry, 0);
  const risk = safeNumber(riskPct, 0);

  if (e <= 0 || risk <= 0) return [];

  const sl = roundPrice(e * (1 + risk));

  return variants.map((rr) => {
    const rewardPct = risk * rr;
    const tp = roundPrice(e * (1 - rewardPct));

    return {
      rr,
      label: `RR_${String(rr).replace('.', '_')}`,
      entry: roundPrice(e),
      sl,
      tp,
      riskPct: round6(risk),
      rewardPct: round6(rewardPct),
      validShortRiskShape: tp < e && e < sl,
      tpHitRule: 'SHORT: price <= tp',
      slHitRule: 'SHORT: price >= sl',
      grossRFormula: '(entry - exitPrice) / (initialSl - entry)'
    };
  });
}

function candleValue(candle, key, indexFallback = null) {
  if (!candle) return 0;

  if (Array.isArray(candle)) {
    return safeNumber(candle[indexFallback], 0);
  }

  return safeNumber(candle[key], 0);
}

function candleHigh(candle) {
  if (!candle) return 0;

  return safeNumber(
    candle.high ??
      candle.h ??
      candle[2],
    0
  );
}

function candleLow(candle) {
  if (!candle) return 0;

  return safeNumber(
    candle.low ??
      candle.l ??
      candle[3],
    0
  );
}

function recentSwingHigh(candles = [], lookback = 24) {
  const rows = Array.isArray(candles)
    ? candles.slice(-Math.max(1, lookback))
    : [];

  let high = 0;

  for (const candle of rows) {
    high = Math.max(high, candleHigh(candle));
  }

  return high > 0 ? high : 0;
}

function recentSwingLow(candles = [], lookback = 24) {
  const rows = Array.isArray(candles)
    ? candles.slice(-Math.max(1, lookback))
    : [];

  let low = Number.POSITIVE_INFINITY;

  for (const candle of rows) {
    const value = candleLow(candle);
    if (value > 0) low = Math.min(low, value);
  }

  return Number.isFinite(low) && low > 0 ? low : 0;
}

function firstPositiveNumber(values = []) {
  for (const value of values) {
    const n = safeNumber(value, 0);
    if (n > 0) return n;
  }

  return 0;
}

function normalizeBookLevel(level) {
  if (!level) return null;

  if (Array.isArray(level)) {
    const price = safeNumber(level[0], 0);
    const size = safeNumber(level[1], 0);
    const notional = safeNumber(level[2], price * size);

    if (price <= 0) return null;

    return {
      price,
      size,
      notionalUsd: Math.max(0, notional)
    };
  }

  if (typeof level === 'object') {
    const price = safeNumber(
      level.price ??
        level.p ??
        level.px ??
        level.level,
      0
    );

    const size = safeNumber(
      level.size ??
        level.sz ??
        level.qty ??
        level.quantity ??
        level.amount ??
        level.baseSize,
      0
    );

    const notional = safeNumber(
      level.notionalUsd ??
        level.notional ??
        level.usd ??
        level.valueUsd ??
        level.value,
      price * size
    );

    if (price <= 0) return null;

    return {
      price,
      size,
      notionalUsd: Math.max(0, notional)
    };
  }

  return null;
}

function normalizeLevels(levels = []) {
  return Array.isArray(levels)
    ? levels.map(normalizeBookLevel).filter(Boolean)
    : [];
}

function orderbookAsks(ob = {}) {
  return normalizeLevels(
    ob.asks ??
      ob.askLevels ??
      ob.asksRaw ??
      ob.book?.asks ??
      ob.levels?.asks ??
      []
  );
}

function orderbookBids(ob = {}) {
  return normalizeLevels(
    ob.bids ??
      ob.bidLevels ??
      ob.bidsRaw ??
      ob.book?.bids ??
      ob.levels?.bids ??
      []
  );
}

function findNearestWall({
  levels = [],
  entry,
  direction,
  minNotionalUsd,
  minDistancePct,
  maxDistancePct
} = {}) {
  const e = safeNumber(entry, 0);

  if (e <= 0) return null;

  const candidates = normalizeLevels(levels)
    .map((level) => {
      const distancePct = direction === 'above'
        ? (level.price - e) / e
        : (e - level.price) / e;

      return {
        ...level,
        distancePct
      };
    })
    .filter((level) => level.distancePct > 0)
    .filter((level) => level.distancePct >= minDistancePct)
    .filter((level) => level.distancePct <= maxDistancePct)
    .filter((level) => level.notionalUsd >= minNotionalUsd)
    .sort((a, b) => (
      a.distancePct - b.distancePct ||
      b.notionalUsd - a.notionalUsd
    ));

  return candidates[0] || null;
}

function structuralBufferPct({
  atrPct,
  spreadPct
} = {}) {
  const cfg = tradeConfig();

  return Math.max(
    0.0002,
    safeNumber(atrPct, 0) * cfg.structuralBufferAtrMult,
    safeNumber(spreadPct, 0) * cfg.structuralBufferSpreadMult
  );
}

function buildStructuralStopPlan({
  candidate = {},
  ob = {},
  candles15m = [],
  entry,
  atrPct,
  spreadPct,
  costAwareMinRiskPct
} = {}) {
  const cfg = tradeConfig();
  const e = safeNumber(entry, 0);

  if (!cfg.structuralRiskEnabled || e <= 0) {
    return {
      found: false,
      valid: false,
      source: 'STRUCTURAL_STOP_DISABLED_OR_NO_ENTRY'
    };
  }

  const bufferPct = structuralBufferPct({ atrPct, spreadPct });
  const minDistancePct = Math.max(
    safeNumber(cfg.minRiskPct, 0),
    safeNumber(costAwareMinRiskPct, 0)
  );

  const explicitStop = firstPositiveNumber([
    candidate.shortInvalidationPrice,
    candidate.structuralStopPrice,
    candidate.stopStructurePrice,
    candidate.invalidationPrice,
    candidate.recentSwingHigh,
    candidate.swingHighPrice,
    candidate.swingHigh,
    candidate.localHigh,
    candidate.resistancePrice
  ]);

  const askWall = findNearestWall({
    levels: orderbookAsks(ob),
    entry: e,
    direction: 'above',
    minNotionalUsd: cfg.minOrderbookWallUsd,
    minDistancePct: Math.max(0.0002, spreadPct * 1.5),
    maxDistancePct: cfg.maxRiskPct * 1.5
  });

  const swingHigh = recentSwingHigh(candles15m, cfg.structuralStopLookback);

  const candidates = [];

  if (explicitStop > e) {
    candidates.push({
      rawPrice: explicitStop,
      price: explicitStop * (1 + bufferPct),
      source: 'SHORT_EXPLICIT_STRUCTURAL_INVALIDATION'
    });
  }

  if (askWall?.price > e) {
    candidates.push({
      rawPrice: askWall.price,
      price: askWall.price * (1 + bufferPct),
      source: 'SHORT_ORDERBOOK_ASK_WALL_INVALIDATION',
      wallNotionalUsd: askWall.notionalUsd
    });
  }

  if (swingHigh > e) {
    candidates.push({
      rawPrice: swingHigh,
      price: swingHigh * (1 + bufferPct),
      source: 'SHORT_RECENT_SWING_HIGH_INVALIDATION'
    });
  }

  const normalized = candidates
    .map((item) => {
      const sl = roundPrice(item.price);
      const riskPct = (sl - e) / e;

      return {
        ...item,
        sl,
        riskPct
      };
    })
    .filter((item) => item.sl > e && item.riskPct > 0)
    .sort((a, b) => a.riskPct - b.riskPct);

  const selected = normalized[0] || null;

  if (!selected) {
    return {
      found: false,
      valid: false,
      source: 'NO_STRUCTURAL_STOP_FOUND',
      bufferPct: round6(bufferPct)
    };
  }

  if (selected.riskPct < minDistancePct) {
    return {
      found: true,
      valid: false,
      reject: true,
      rejectReason: 'STRUCTURAL_STOP_TOO_TIGHT_FOR_COST_CAP',
      source: selected.source,
      sl: selected.sl,
      rawPrice: roundPrice(selected.rawPrice),
      riskPct: round6(selected.riskPct),
      minRequiredRiskPct: round6(minDistancePct),
      costAwareMinRiskPct: round6(costAwareMinRiskPct),
      bufferPct: round6(bufferPct)
    };
  }

  if (selected.riskPct > cfg.maxRiskPct) {
    return {
      found: true,
      valid: false,
      reject: true,
      rejectReason: 'STRUCTURAL_STOP_TOO_WIDE_FOR_MAX_RISK',
      source: selected.source,
      sl: selected.sl,
      rawPrice: roundPrice(selected.rawPrice),
      riskPct: round6(selected.riskPct),
      maxRiskPct: round6(cfg.maxRiskPct),
      bufferPct: round6(bufferPct)
    };
  }

  return {
    found: true,
    valid: true,
    source: selected.source,
    sl: selected.sl,
    rawPrice: roundPrice(selected.rawPrice),
    riskPct: round6(selected.riskPct),
    bufferPct: round6(bufferPct),
    wallNotionalUsd: selected.wallNotionalUsd || null
  };
}

function oiFundingProxy({
  candidate = {},
  funding = {},
  openInterest = {},
  side = TARGET_TRADE_SIDE
} = {}) {
  const fundingRate = safeNumber(
    funding.rate ??
      candidate.fundingRate ??
      candidate.currentFundingRate,
    0
  );

  const oiChangePct = safeNumber(
    openInterest.changePct ??
      openInterest.oiChangePct ??
      candidate.openInterestChangePct ??
      candidate.oiChangePct ??
      candidate.oiDeltaPct,
    0
  );

  const d1h = directionalChange({
    side,
    change: candidate.change1h
  });

  const d24h = directionalChange({
    side,
    change: candidate.change24h
  });

  let score = 0;
  const reasons = [];

  if (fundingRate > 0.0002) {
    score += 25;
    reasons.push('POSITIVE_FUNDING_SUPPORTS_SHORT_LIQUIDATION_PROXY');
  } else if (fundingRate < -0.0002) {
    score -= 18;
    reasons.push('NEGATIVE_FUNDING_CROWDED_SHORT_HEADWIND');
  }

  if (oiChangePct > 3 && (d1h > 0.5 || d24h > 2)) {
    score += 25;
    reasons.push('OI_RISING_WITH_SHORT_DIRECTION');
  } else if (oiChangePct > 3 && d1h < -0.5) {
    score -= 18;
    reasons.push('OI_RISING_AGAINST_SHORT_DIRECTION');
  } else if (oiChangePct > 0) {
    score += 6;
    reasons.push('OI_RISING_LIGHT_SUPPORT');
  }

  if (d1h >= 1 || d24h >= 4) {
    score += 15;
    reasons.push('PRICE_MOVING_WITH_SHORT');
  } else if (d1h <= -1 || d24h <= -4) {
    score -= 15;
    reasons.push('PRICE_MOVING_AGAINST_SHORT');
  }

  const clamped = clamp(score, -60, 80);

  let rrAdjustment = 0;

  if (clamped >= 50) rrAdjustment = 0.5;
  else if (clamped >= 25) rrAdjustment = 0.25;
  else if (clamped <= -30) rrAdjustment = -0.35;
  else if (clamped <= -15) rrAdjustment = -0.15;

  return {
    score: round4(clamped),
    rrAdjustment: round4(rrAdjustment),
    fundingRate: round6(fundingRate),
    oiChangePct: round4(oiChangePct),
    directionalChange1h: round4(d1h),
    directionalChange24h: round4(d24h),
    reasons
  };
}

function buildLiquidityTargetPlan({
  candidate = {},
  ob = {},
  candles15m = [],
  funding = {},
  openInterest = {},
  entry,
  riskPct
} = {}) {
  const cfg = tradeConfig();
  const e = safeNumber(entry, 0);
  const risk = safeNumber(riskPct, 0);

  if (!cfg.liquidityTargetEnabled || e <= 0 || risk <= 0) {
    return {
      found: false,
      valid: false,
      source: 'LIQUIDITY_TARGET_DISABLED_OR_NO_RISK'
    };
  }

  const proxy = oiFundingProxy({
    candidate,
    funding,
    openInterest,
    side: TARGET_TRADE_SIDE
  });

  const explicitTarget = firstPositiveNumber([
    candidate.shortLiquidityTargetPrice,
    candidate.liquidityTargetPrice,
    candidate.structuralTargetPrice,
    candidate.liquidationTargetPrice,
    candidate.shortTargetPrice,
    candidate.recentSwingLow,
    candidate.swingLowPrice,
    candidate.swingLow,
    candidate.localLow,
    candidate.supportPrice,
    candidate.targetPrice,
    candidate.takeProfitPrice
  ]);

  const bidWall = findNearestWall({
    levels: orderbookBids(ob),
    entry: e,
    direction: 'below',
    minNotionalUsd: cfg.minOrderbookWallUsd,
    minDistancePct: risk * cfg.minRR * 0.5,
    maxDistancePct: risk * cfg.liquidityTargetMaxRR
  });

  const swingLow = recentSwingLow(candles15m, cfg.structuralTargetLookback);
  const bufferPct = structuralBufferPct({
    atrPct: safeNumber(calculateAtrPct(candles15m, 14), 0),
    spreadPct: safeNumber(ob?.spreadPct, fallbackSpreadPct())
  });

  const candidates = [];

  if (explicitTarget > 0 && explicitTarget < e) {
    candidates.push({
      rawPrice: explicitTarget,
      price: explicitTarget * (1 + bufferPct),
      source: 'SHORT_EXPLICIT_LIQUIDITY_TARGET'
    });
  }

  if (bidWall?.price > 0 && bidWall.price < e) {
    candidates.push({
      rawPrice: bidWall.price,
      price: bidWall.price * (1 + bufferPct),
      source: 'SHORT_ORDERBOOK_BID_WALL_TARGET',
      wallNotionalUsd: bidWall.notionalUsd
    });
  }

  if (swingLow > 0 && swingLow < e) {
    candidates.push({
      rawPrice: swingLow,
      price: swingLow * (1 + bufferPct),
      source: 'SHORT_RECENT_SWING_LOW_TARGET'
    });
  }

  const normalized = candidates
    .map((item) => {
      const tp = roundPrice(Math.min(item.price, e * 0.999));
      const rewardPct = (e - tp) / e;
      const rr = rewardPct / risk;

      return {
        ...item,
        tp,
        rewardPct,
        rr
      };
    })
    .filter((item) => item.tp > 0 && item.tp < e && item.rewardPct > 0)
    .sort((a, b) => (
      a.rewardPct - b.rewardPct ||
      b.wallNotionalUsd - a.wallNotionalUsd
    ));

  const selected = normalized[0] || null;

  if (selected) {
    if (selected.rr < cfg.minRR) {
      return {
        found: true,
        valid: false,
        reject: true,
        rejectReason: 'STRUCTURAL_TARGET_TOO_CLOSE_FOR_MIN_RR',
        source: selected.source,
        tp: selected.tp,
        rawPrice: roundPrice(selected.rawPrice),
        rewardPct: round6(selected.rewardPct),
        rr: round4(selected.rr),
        minRR: round4(cfg.minRR),
        proxy
      };
    }

    return {
      found: true,
      valid: true,
      source: selected.source,
      tp: selected.tp,
      rawPrice: roundPrice(selected.rawPrice),
      rewardPct: round6(selected.rewardPct),
      rr: round4(selected.rr),
      wallNotionalUsd: selected.wallNotionalUsd || null,
      proxy
    };
  }

  const fallbackRR = clamp(
    cfg.defaultRR + proxy.rrAdjustment,
    cfg.minRR,
    cfg.liquidityTargetMaxRR
  );

  const rewardPct = risk * fallbackRR;
  const tp = roundPrice(e * (1 - rewardPct));

  return {
    found: false,
    valid: true,
    source: 'SHORT_OI_FUNDING_PROXY_DEFAULT_RR_TARGET',
    tp,
    rewardPct: round6(rewardPct),
    rr: round4(fallbackRR),
    proxy
  };
}

function buildMicroSignalParts({
  tradeSide,
  rsiZone,
  rsiLocalBucket,
  rsiHtfBucket,
  rsiSlopeGroup,
  rsiAlign,
  flow,
  momentum,
  obRelation,
  obImbalanceGroup,
  btcRel,
  regime,
  atrGroup,
  spreadGroup,
  depthGroup,
  fundingGroup,
  fundingAlign,
  riskGroup,
  costGroup,
  entryQuality,
  fakeBreakout,
  slSource,
  tpSource,
  liquidityProxyScore
} = {}) {
  return [
    `schema=${TRUE_MICRO_SCHEMA}`,
    `parentSchema=${PARENT_TRUE_MICRO_SCHEMA}`,
    `childSchema=${CHILD_TRUE_MICRO_SCHEMA}`,
    `microMicroSchema=${MICRO_MICRO_SCHEMA}`,
    `granularity=${LEARNING_GRANULARITY}`,
    `parentGranularity=${PARENT_LEARNING_GRANULARITY}`,
    `microMicroGranularity=${MICRO_MICRO_LEARNING_GRANULARITY}`,

    `tradeSide=${tradeSide}`,
    `side=${TARGET_DASHBOARD_SIDE}`,
    `positionSide=${TARGET_TRADE_SIDE}`,
    `direction=${TARGET_TRADE_SIDE}`,
    `shortOnly=true`,
    `longDisabled=true`,

    `rsiZone=${rsiZone}`,
    `rsiBucket=${rsiLocalBucket}`,
    `rsiHTFBucket=${rsiHtfBucket}`,
    `rsiSlopeBucket=${rsiSlopeGroup}`,
    `rsiAlignment=${rsiAlign}`,

    `flow=${flow}`,
    `momentum=${momentum}`,

    `obRelation=${obRelation}`,
    `obImbalance=${obImbalanceGroup}`,

    `btcRelation=${btcRel}`,
    `regime=${upper(regime, 'UNKNOWN')}`,

    `atrBucket=${atrGroup}`,
    `spreadBucket=${spreadGroup}`,
    `depthBucket=${depthGroup}`,

    `fundingBucket=${fundingGroup}`,
    `fundingAlignment=${fundingAlign}`,

    `riskBucket=${riskGroup}`,
    `costBucket=${costGroup}`,
    `entryQuality=${entryQuality}`,
    `fakeBreakout=${Boolean(fakeBreakout)}`,

    `slSource=${upper(slSource, 'UNKNOWN')}`,
    `tpSource=${upper(tpSource, 'UNKNOWN')}`,
    `liquidityProxyScore=${round4(liquidityProxyScore)}`,

    `riskPlanVersion=${SHORT_RISK_PLAN_VERSION}`,
    `rrShadowGridVersion=${RR_SHADOW_GRID_VERSION}`,
    `selectionEngine=${SELECTION_ENGINE_VERSION}`,

    'scannerFingerprintRole=METADATA_ONLY',
    'executionFingerprintRole=MICRO_MICRO_IDENTITY_HASH_SOURCE',
    'executionFingerprintsUsedAsLearningFamily=false',
    'executionFingerprintsCanDeriveMicroMicroContextHash=true',
    'learningIdentitySource=ANALYZE_MICRO_MICRO_FAMILY',
    'symbolExcludedFromFamilyId=true',
    'coinNameExcludedFromFamilyId=true',
    'hashesExcludedFromFamilyId=true',
    'currentFitPolarity=BEARISH_POSITIVE_BULLISH_NEGATIVE',
    'currentFitDefinition=SHORT_MIRRORED_CURRENT_FIT',
    'riskGeometry=SHORT:tp<entry<sl'
  ];
}

function costBucketFromEstimatedCostR(value) {
  const n = safeNumber(value, 999);

  if (n < 0.15) return 'COST_R_LOW';
  if (n < 0.35) return 'COST_R_MID';
  if (n < 0.55) return 'COST_R_HIGH';

  return 'COST_R_EXTREME';
}

export function calculateRR({
  entry,
  sl,
  tp,
  side = TARGET_TRADE_SIDE
} = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);

  if (e <= 0 || s <= 0 || t <= 0) return 0;
  if (!(t < e && e < s)) return 0;

  const risk = s - e;

  if (risk <= 0) return 0;

  const reward = directionalReward({
    entry: e,
    tp: t,
    side
  });

  return reward > 0
    ? reward / risk
    : 0;
}

export function isValidRiskGeometry(risk, side = TARGET_TRADE_SIDE) {
  if (!risk) return false;

  const cfg = tradeConfig();
  const tradeSide = sideLabel(side || risk.side || risk.tradeSide);

  if (tradeSide !== TARGET_TRADE_SIDE) return false;

  const entry = safeNumber(risk.entry, 0);
  const sl = safeNumber(risk.sl, 0);
  const tp = safeNumber(risk.tp, 0);

  if (entry <= 0 || sl <= 0 || tp <= 0) return false;
  if (!(tp < entry && entry < sl)) return false;

  const rr = calculateRR({
    entry,
    sl,
    tp,
    side: TARGET_TRADE_SIDE
  });

  if (rr < cfg.minRR) return false;

  const riskPct = safeNumber(risk.riskPct, 0);

  if (riskPct <= 0) return false;
  if (riskPct > cfg.maxRiskPct * 1.05) return false;

  const estimated = safeNumber(risk.estimatedCostR, 0);

  if (
    cfg.rejectCostHeavyRisk === true &&
    estimated > cfg.hardMaxEstimatedCostR
  ) {
    return false;
  }

  return true;
}

export function buildRiskGeometry({
  candidate,
  ob,
  funding,
  openInterest,
  candles15m,
  sideOverride = TARGET_TRADE_SIDE
} = {}) {
  const cfg = tradeConfig();

  if (hasExplicitLongSide(candidate)) return null;

  const overrideSide = normalizeTradeSideValue(sideOverride);
  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return null;

  const tradeSide = overrideSide !== 'UNKNOWN'
    ? overrideSide
    : inferredSide;

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  const entry = safeNumber(
    ob?.mid ??
      candidate?.entry ??
      candidate?.entryPrice ??
      candidate?.price,
    0
  );

  if (entry <= 0) return null;

  const atrPct = safeNumber(calculateAtrPct(candles15m, 14), 0);
  const spreadPct = safeNumber(ob?.spreadPct, fallbackSpreadPct());

  if (spreadPct > cfg.maxSpreadPct) return null;

  const estimatedCostPct = estimateTotalCostPct({ spreadPct });
  const costAwareMinRiskPct = cfg.costAwareRiskEnabled
    ? estimatedCostPct / Math.max(0.05, cfg.maxEstimatedCostR)
    : 0;

  const structuralStop = buildStructuralStopPlan({
    candidate,
    ob,
    candles15m,
    entry,
    atrPct,
    spreadPct,
    costAwareMinRiskPct
  });

  if (structuralStop.found && structuralStop.reject) {
    return null;
  }

  const fallbackRawRiskPct = Math.max(
    cfg.fallbackRiskPct,
    atrPct * cfg.atrRiskMult,
    spreadPct * cfg.spreadRiskMult,
    costAwareMinRiskPct
  );

  const riskPct = structuralStop.valid
    ? safeNumber(structuralStop.riskPct, 0)
    : clamp(
      fallbackRawRiskPct,
      cfg.minRiskPct,
      cfg.maxRiskPct
    );

  const sl = structuralStop.valid
    ? structuralStop.sl
    : entry * (1 + riskPct);

  const estimatedCostR = estimateCostR({
    spreadPct,
    riskPct
  });

  if (
    cfg.rejectCostHeavyRisk === true &&
    estimatedCostR > cfg.hardMaxEstimatedCostR
  ) {
    return null;
  }

  const liquidityTarget = buildLiquidityTargetPlan({
    candidate,
    ob,
    candles15m,
    funding,
    openInterest,
    entry,
    riskPct
  });

  if (liquidityTarget.found && liquidityTarget.reject) {
    return null;
  }

  const tp = liquidityTarget.valid
    ? liquidityTarget.tp
    : entry * (1 - riskPct * Math.max(cfg.minRR, cfg.defaultRR));

  const roundedEntry = roundPrice(entry);
  const roundedSl = roundPrice(sl);
  const roundedTp = roundPrice(tp);

  const rr = calculateRR({
    entry: roundedEntry,
    sl: roundedSl,
    tp: roundedTp,
    side: TARGET_TRADE_SIDE
  });

  const rewardPct = roundedEntry > 0
    ? Math.max(0, (roundedEntry - roundedTp) / roundedEntry)
    : 0;

  const rrVariants = normalizeRRVariants(rr || cfg.defaultRR);
  const rrVariantTargets = buildRRVariantTargets({
    entry: roundedEntry,
    riskPct,
    variants: rrVariants
  });

  const rowForFlags = {
    ...(candidate || {}),
    entry: roundedEntry,
    sl: roundedSl,
    tp: roundedTp,
    rr,
    riskPct,
    rewardPct,
    estimatedCostR,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION
  };

  const costSafetyState =
    estimatedCostR <= cfg.maxEstimatedCostR
      ? 'OK'
      : estimatedCostR <= cfg.hardMaxEstimatedCostR
        ? 'WARNING'
        : 'DANGER';

  const slSource = structuralStop.valid
    ? structuralStop.source
    : 'SHORT_ATR_SPREAD_COST_AWARE_FALLBACK';

  const tpSource = liquidityTarget.valid
    ? liquidityTarget.source
    : 'SHORT_DEFAULT_RR_TARGET_FALLBACK';

  const risk = {
    ...modeFlags(rowForFlags),

    entry: roundedEntry,
    sl: roundedSl,
    tp: roundedTp,

    rr: round4(rr),

    slSource,
    tpSource,
    riskRewardSource: structuralStop.valid || liquidityTarget.valid
      ? 'SHORT_STRUCTURAL_SL_LIQUIDITY_TP_COST_AWARE'
      : 'SHORT_ATR_SPREAD_COST_AWARE_DEFAULT_RR',

    structuralRiskEnabled: Boolean(cfg.structuralRiskEnabled),
    structuralStopFound: Boolean(structuralStop.found),
    structuralStopValid: Boolean(structuralStop.valid),
    structuralStopSource: structuralStop.source || null,
    structuralStopRawPrice: structuralStop.rawPrice || null,
    structuralStopBufferPct: structuralStop.bufferPct || 0,
    structuralStopWallNotionalUsd: structuralStop.wallNotionalUsd || null,

    liquidityTargetEnabled: Boolean(cfg.liquidityTargetEnabled),
    liquidityTargetFound: Boolean(liquidityTarget.found),
    liquidityTargetValid: Boolean(liquidityTarget.valid),
    liquidityTargetSource: liquidityTarget.source || null,
    liquidityTargetRawPrice: liquidityTarget.rawPrice || null,
    liquidityTargetWallNotionalUsd: liquidityTarget.wallNotionalUsd || null,
    liquidityTargetPct: round6(liquidityTarget.rewardPct ?? rewardPct),
    liquidityTargetRR: round4(liquidityTarget.rr ?? rr),

    liquidationProxyScore: round4(liquidityTarget.proxy?.score ?? 0),
    liquidationProxyRRAdjustment: round4(liquidityTarget.proxy?.rrAdjustment ?? 0),
    liquidationProxyReasons: Array.isArray(liquidityTarget.proxy?.reasons)
      ? liquidityTarget.proxy.reasons
      : [],
    openInterestChangePct: round4(liquidityTarget.proxy?.oiChangePct ?? 0),
    fundingRateForTarget: round6(liquidityTarget.proxy?.fundingRate ?? 0),

    atrPct: round6(atrPct),
    spreadPct: round6(spreadPct),
    riskPct: round6(riskPct),
    rewardPct: round6(rewardPct),

    estimatedCostPct: round6(estimatedCostPct),
    estimatedCostR: round6(estimatedCostR),
    estimatedAvgCostR: round6(estimatedCostR),
    costAwareRiskEnabled: Boolean(cfg.costAwareRiskEnabled),
    costAwareMinRiskPct: round6(costAwareMinRiskPct),
    maxEstimatedCostR: round6(cfg.maxEstimatedCostR),
    hardMaxEstimatedCostR: round6(cfg.hardMaxEstimatedCostR),
    costSafetyState,
    costBucket: costBucketFromEstimatedCostR(estimatedCostR),

    atrBucket: volatilityBucket(atrPct),
    riskBucket: riskPctBucket(riskPct),
    spreadBucket: spreadBucket(spreadPct),

    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    rrVariants,
    rrVariantTargets,
    rrVariantCount: rrVariantTargets.length,
    rrPrimary: round4(rr),
    rrPrimaryLabel: `RR_${String(round4(rr)).replace('.', '_')}`,

    positionTimeStopMin: cfg.positionTimeStopMin,

    validShortRiskShape: roundedTp < roundedEntry && roundedEntry < roundedSl,
    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    riskEngineAssignedTrueMicroFamily: false,
    analyzeAssignsTrueMicroFamily: true,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true
  };

  return isValidRiskGeometry(risk, TARGET_TRADE_SIDE)
    ? risk
    : null;
}

export function buildRiskGeometryForSide({
  candidate,
  ob,
  funding,
  openInterest,
  candles15m,
  side
} = {}) {
  const tradeSide = normalizeTradeSideValue(side);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return buildRiskGeometry({
    candidate,
    ob,
    funding,
    openInterest,
    candles15m,
    sideOverride: TARGET_TRADE_SIDE
  });
}

export function buildLiveMetrics({
  candidate,
  ob,
  funding,
  candles15m,
  candles1h,
  btcState,
  regime,
  risk,
  sideOverride = TARGET_TRADE_SIDE
} = {}) {
  if (!candidate || !risk) return null;
  if (hasExplicitLongSide(candidate)) return null;

  const overrideSide = normalizeTradeSideValue(sideOverride);
  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return null;

  const tradeSide = overrideSide !== 'UNKNOWN'
    ? overrideSide
    : inferredSide;

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isValidRiskGeometry(risk, TARGET_TRADE_SIDE)) return null;

  const sideCandidate = withTradeSide(candidate, TARGET_TRADE_SIDE);

  if (!sideCandidate) return null;

  const rsi = safeNumber(calculateRsi(candles15m, 14) ?? 50, 50);
  const rsiHTF = safeNumber(calculateRsi(candles1h, 14) ?? rsi, rsi);
  const rsiZone = getRsiZone(rsi);
  const rsiSlope = safeNumber(getRsiSlope(candles15m), 0);

  const flow = classifyFlow({
    side: TARGET_TRADE_SIDE,
    change1h: sideCandidate.change1h,
    change24h: sideCandidate.change24h,
    candles15m
  });

  if (flow === 'LONG_DISABLED_SHORT_ONLY') return null;

  const obBias = ob?.bias || 'NEUTRAL';
  const obRelation = getObRelation(TARGET_TRADE_SIDE, obBias);
  const relationToBtc = btcRelation(TARGET_TRADE_SIDE, btcState);

  const depthMinUsd1p = obDepthValue(ob);
  const spreadPct = safeNumber(ob?.spreadPct, risk.spreadPct ?? 0);
  const fundingRate = safeNumber(funding?.rate, risk.fundingRateForTarget ?? 0);
  const imbalance = obImbalance(ob);

  const flags = inferEntryFlags(sideCandidate);

  const rsiLocalBucket = rsiBucket(rsi);
  const rsiHtfBucket = rsiBucket(rsiHTF);
  const rsiSlopeGroup = rsiSlopeBucket(rsiSlope);

  const rsiAlign = rsiAlignment({
    side: TARGET_TRADE_SIDE,
    rsi,
    rsiHTF,
    rsiSlope
  });

  const momentum = momentumBucket({
    side: TARGET_TRADE_SIDE,
    change1h: sideCandidate.change1h,
    change24h: sideCandidate.change24h
  });

  const atrGroup = volatilityBucket(risk?.atrPct);
  const spreadGroup = spreadBucket(spreadPct);
  const depthGroup = depthBucket(depthMinUsd1p);
  const fundingGroup = fundingBucket(fundingRate);

  const fundingAlign = fundingAlignment({
    side: TARGET_TRADE_SIDE,
    fundingRate
  });

  const riskGroup = riskPctBucket(risk?.riskPct);
  const obImbalanceGroup = obImbalanceBucket(imbalance);
  const estimatedCostR = safeNumber(
    risk.estimatedCostR ??
      estimateCostR({
        spreadPct,
        riskPct: risk.riskPct
      }),
    0
  );
  const costGroup = costBucketFromEstimatedCostR(estimatedCostR);

  const baseScore = scoreInput(sideCandidate);

  let confluence = 0;

  confluence += clamp(baseScore, 0, 100) * 0.30;
  confluence += flowScore(flow);
  confluence += obRelationScore(obRelation);
  confluence += btcScore(relationToBtc);
  confluence += rrScore(risk?.rr);
  confluence += spreadQualityScore(spreadPct);
  confluence += depthQualityScore(depthMinUsd1p);
  confluence += entryQualityScore(flags);
  confluence += fundingScore(fundingAlign);
  confluence += flags.fakeBreakoutRisk ? -10 : 0;
  confluence += Math.abs(rsiSlope) > 2 ? 3 : 0;
  confluence += rsiAlign === 'RSI_WITH' ? 4 : 0;
  confluence += rsiAlign === 'RSI_AGAINST' ? -6 : 0;
  confluence += estimatedCostR <= 0.2 ? 4 : estimatedCostR >= 0.55 ? -10 : 0;
  confluence += safeNumber(risk.liquidationProxyScore, 0) >= 25 ? 3 : 0;
  confluence += safeNumber(risk.liquidationProxyScore, 0) <= -25 ? -4 : 0;

  confluence = Math.round(clamp(confluence, 0, 100));

  let sniperScore = 0;

  sniperScore += clamp(baseScore, 0, 100) * 0.32;
  sniperScore += sniperObScore(obRelation);
  sniperScore += btcScore(relationToBtc);
  sniperScore += flowScore(flow);
  sniperScore += rrScore(risk?.rr);
  sniperScore += directionalMoveScore({
    side: TARGET_TRADE_SIDE,
    rsiZone,
    rsiSlope,
    rsiHTF,
    rsiAlign
  });
  sniperScore += spreadQualityScore(spreadPct);
  sniperScore += depthQualityScore(depthMinUsd1p) * 0.35;
  sniperScore += entryQualityScore(flags);
  sniperScore += fundingScore(fundingAlign);
  sniperScore += flags.fakeBreakoutRisk ? -10 : 0;
  sniperScore += estimatedCostR <= 0.2 ? 4 : estimatedCostR >= 0.55 ? -10 : 0;
  sniperScore += safeNumber(risk.liquidationProxyScore, 0) >= 25 ? 3 : 0;
  sniperScore += safeNumber(risk.liquidationProxyScore, 0) <= -25 ? -4 : 0;

  sniperScore = Math.round(clamp(sniperScore, 0, 100));

  const microSignalParts = buildMicroSignalParts({
    tradeSide: TARGET_TRADE_SIDE,
    rsiZone,
    rsiLocalBucket,
    rsiHtfBucket,
    rsiSlopeGroup,
    rsiAlign,
    flow,
    momentum,
    obRelation,
    obImbalanceGroup,
    btcRel: relationToBtc,
    regime,
    atrGroup,
    spreadGroup,
    depthGroup,
    fundingGroup,
    fundingAlign,
    riskGroup,
    costGroup,
    entryQuality: flags.entryQuality,
    fakeBreakout: flags.fakeBreakout,
    slSource: risk.slSource,
    tpSource: risk.tpSource,
    liquidityProxyScore: risk.liquidationProxyScore
  });

  const base = {
    ...sideCandidate,
    ...modeFlags(sideCandidate),

    confluence,
    sniperScore,

    rr: safeNumber(risk?.rr, 0),
    rrPrimary: safeNumber(risk?.rrPrimary ?? risk?.rr, 0),
    rrVariants: Array.isArray(risk?.rrVariants) ? risk.rrVariants : DEFAULT_RR_VARIANTS,
    rrVariantTargets: Array.isArray(risk?.rrVariantTargets) ? risk.rrVariantTargets : [],
    rrVariantCount: safeNumber(risk?.rrVariantCount, Array.isArray(risk?.rrVariantTargets) ? risk.rrVariantTargets.length : 0),
    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,

    rsi: round2(rsi),
    rsiHTF: round2(rsiHTF),
    rsiZone,
    rsiBucket: rsiLocalBucket,
    rsiHTFBucket: rsiHtfBucket,
    rsiSlope: round4(rsiSlope),
    rsiSlopeBucket: rsiSlopeGroup,
    rsiAlignment: rsiAlign,
    rsiContinuationScore: round4(Math.abs(rsiSlope)),

    flow,
    momentumBucket: momentum,

    obBias,
    obRelation,
    obImbalance: round4(imbalance),
    obImbalanceBucket: obImbalanceGroup,

    spreadPct,
    spreadBps: spreadBps(spreadPct),
    spreadBucket: spreadGroup,

    depthMinUsd1p,
    depthBucket: depthGroup,

    fundingRate,
    fundingBucket: fundingGroup,
    fundingAlignment: fundingAlign,

    btcState,
    btcRelation: relationToBtc,
    regime,

    scannerReason: scannerReason(sideCandidate),

    pullbackConfirmed: flags.pullbackConfirmed,
    retestConfirmed: flags.retestConfirmed,
    sweepConfirmed: flags.sweepConfirmed,
    fakeBreakout: flags.fakeBreakout,
    fakeBreakoutRisk: flags.fakeBreakoutRisk,
    entryQuality: flags.entryQuality,

    entry: risk.entry,
    sl: risk.sl,
    tp: risk.tp,

    atrPct: risk.atrPct,
    atrBucket: atrGroup,
    riskPct: risk.riskPct,
    riskBucket: riskGroup,
    rewardPct: risk.rewardPct,

    structuralRiskEnabled: Boolean(risk.structuralRiskEnabled),
    structuralStopFound: Boolean(risk.structuralStopFound),
    structuralStopValid: Boolean(risk.structuralStopValid),
    structuralStopSource: risk.structuralStopSource || null,
    structuralStopRawPrice: risk.structuralStopRawPrice || null,
    structuralStopBufferPct: safeNumber(risk.structuralStopBufferPct, 0),
    structuralStopWallNotionalUsd: risk.structuralStopWallNotionalUsd || null,

    liquidityTargetEnabled: Boolean(risk.liquidityTargetEnabled),
    liquidityTargetFound: Boolean(risk.liquidityTargetFound),
    liquidityTargetValid: Boolean(risk.liquidityTargetValid),
    liquidityTargetSource: risk.liquidityTargetSource || null,
    liquidityTargetRawPrice: risk.liquidityTargetRawPrice || null,
    liquidityTargetWallNotionalUsd: risk.liquidityTargetWallNotionalUsd || null,
    liquidityTargetPct: safeNumber(risk.liquidityTargetPct, 0),
    liquidityTargetRR: safeNumber(risk.liquidityTargetRR, 0),

    liquidationProxyScore: safeNumber(risk.liquidationProxyScore, 0),
    liquidationProxyRRAdjustment: safeNumber(risk.liquidationProxyRRAdjustment, 0),
    liquidationProxyReasons: Array.isArray(risk.liquidationProxyReasons)
      ? risk.liquidationProxyReasons
      : [],
    openInterestChangePct: safeNumber(risk.openInterestChangePct, 0),
    fundingRateForTarget: safeNumber(risk.fundingRateForTarget, 0),

    estimatedCostPct: safeNumber(risk.estimatedCostPct, 0),
    estimatedCostR,
    estimatedAvgCostR: estimatedCostR,
    costAwareRiskEnabled: Boolean(risk.costAwareRiskEnabled),
    costAwareMinRiskPct: safeNumber(risk.costAwareMinRiskPct, 0),
    costSafetyState: risk.costSafetyState || 'UNKNOWN',
    costBucket: costGroup,

    slSource: risk.slSource,
    tpSource: risk.tpSource,
    riskRewardSource: risk.riskRewardSource,

    microSignalParts,
    executionFingerprintParts: microSignalParts,

    validShortRiskShape: true,
    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    riskEngineAssignedTrueMicroFamily: false,
    analyzeAssignsTrueMicroFamily: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    positionTimeStopMin: tradeConfig().positionTimeStopMin,

    ts: now()
  };

  return {
    ...base,
    ...modeFlags(base)
  };
}

export function buildLiveMetricsForSide(params = {}, side) {
  const tradeSide = normalizeTradeSideValue(side);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return buildLiveMetrics({
    ...params,
    sideOverride: TARGET_TRADE_SIDE
  });
}

export function buildRiskAndLiveMetricsForBothSides({
  candidate,
  ob,
  funding,
  openInterest,
  candles15m,
  candles1h,
  btcState,
  regime
} = {}) {
  if (!candidate) return [];
  if (hasExplicitLongSide(candidate)) return [];

  const inferredSide = inferTradeSide(candidate);

  if (inferredSide === OPPOSITE_TRADE_SIDE) return [];

  const sideCandidate = withTradeSide(candidate, TARGET_TRADE_SIDE);

  if (!sideCandidate) return [];

  const risk = buildRiskGeometry({
    candidate: sideCandidate,
    ob,
    funding,
    openInterest,
    candles15m,
    sideOverride: TARGET_TRADE_SIDE
  });

  if (!isValidRiskGeometry(risk, TARGET_TRADE_SIDE)) {
    return [];
  }

  const metrics = buildLiveMetrics({
    candidate: sideCandidate,
    ob,
    funding,
    candles15m,
    candles1h,
    btcState,
    regime,
    risk,
    sideOverride: TARGET_TRADE_SIDE
  });

  if (!metrics) return [];

  const outputSide = inferTradeSide(metrics);

  if (outputSide !== TARGET_TRADE_SIDE) return [];

  const out = {
    ...metrics,
    ...modeFlags(metrics),

    validShortRiskShape: true,
    shortRiskRule: 'tp < entry < sl',
    riskValidForAnalyzeTrueMicroAssignment: true,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION
  };

  return [out];
}

export {
  dashboardSideFromTradeSide
};