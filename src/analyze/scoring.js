// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;
const DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT = 5000;

const MIN_COMPLETED_ACTIVE = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;

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
const LEGACY_EXECUTION_SUFFIX = 'XR';

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V2';
const MICRO_MICRO_MEASUREMENT_VERSION = 'SHORT_MICRO_MICRO_ROLLUP_SELECTION_V1';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_SHADOW = 'SHADOW';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const SELECTION_PARENT_CONTEXT = 'PARENT_15_CONTEXT_ONLY';
const SELECTION_EXACT_75_CHILD = 'EXACT_75_CHILD';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO';

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

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function positive(value) {
  return Math.max(0, safeNumber(value, 0));
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function observationDedupeCacheLimit() {
  return Math.max(
    100,
    Math.floor(analyzeNumber('observationDedupeCacheLimit', DEFAULT_OBSERVATION_DEDUPE_CACHE_LIMIT))
  );
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
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
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
    learningLayer: {}
  };
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

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
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
    selectable: isChild || isMicroMicro,
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
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: isMicroMicro ? LAYER_MICRO_MICRO : isChild ? LAYER_MICRO_75 : isParent ? LAYER_PARENT_15 : 'UNKNOWN',
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
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

function isSelectableShortMicroMicroFamilyId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isSelectableLearningFamilyId(id = '') {
  return isSelectableShortChildTrueMicroId(id) || isSelectableShortMicroMicroFamilyId(id);
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

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
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
    row.learningMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
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
    row.learningMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.id,
    row.key
  ];
}

function rowMicroMicroId(row = {}) {
  const child = rowChildTrueMicroId(row);

  const directValues = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microMicroId,
    row.mmFamilyId
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

function rowChildTrueMicroId(row = {}) {
  const values = [
    row.childTrueMicroFamilyId,
    row.baseTrueMicroFamilyId,
    row.trueMicro75FamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.id,
    row.key
  ];

  for (const value of values) {
    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.isMicroMicro || parsed.isChild) {
      return parsed.childTrueMicroFamilyId;
    }
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
    row.microFamilyId ||
      row.trueMicroFamilyId ||
      row.learningMicroFamilyId ||
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
        part.includes('MICRO_MICRO')
      )) ||
      definitionText(row).includes('MICRO_MICRO')
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
  if (row.isParentTrueMicro === true) return false;
  if (isParentShortTrueMicroId(id)) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO') || version.includes('PARENT')) return false;

  if (schema === macroSchema) return false;
  if (schema === PARENT_TRUE_MICRO_SCHEMA) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (idHasSchema(id, PARENT_TRUE_MICRO_SCHEMA)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  if (isSelectableLearningFamilyId(id)) return true;

  if (
    row.fixedTaxonomyLearningId === true &&
    row.exactTrueMicroFamilyRequired === true &&
    idLooksLikeShortMicroFamily(id) &&
    !idHasSchema(id, legacyMicroSchema) &&
    !idHasSchema(id, macroSchema)
  ) {
    return isSelectableLearningFamilyId(id);
  }

  return false;
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
    selectableChild: parsed.isChild,
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

function applyLearningIdentityFlags(stats = {}, row = {}) {
  const existingId = rowMicroId(stats);
  const rowId = rowMicroId(row);
  const id = existingId || rowId;

  const taxonomy = fixedTaxonomyMeta({
    ...row,
    microFamilyId: id || row.microFamilyId,
    learningMicroFamilyId: id || row.learningMicroFamilyId
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
  stats.baseTrueMicroFamilyId = childId;
  stats.trueMicro75FamilyId = childId;

  stats.microMicroFamilyId = microMicroId;
  stats.trueMicroMicroFamilyId = microMicroId;
  stats.exactMicroMicroFamilyId = microMicroId;

  if (id) {
    stats.microFamilyId = id;
    stats.learningMicroFamilyId = id;
    stats.analyzeMicroFamilyId = id;
    stats.trueMicroFamilyId = id;
  }

  if (isMicro75Layer && childId) {
    stats.microFamilyId = childId;
    stats.trueMicroFamilyId = childId;
    stats.childTrueMicroFamilyId = childId;
    stats.analyzeMicroFamilyId = childId;
    stats.learningMicroFamilyId = childId;
  }

  if (isParentLayer && parentId) {
    stats.microFamilyId = parentId;
    stats.trueMicroFamilyId = parentId;
    stats.childTrueMicroFamilyId = null;
    stats.analyzeMicroFamilyId = parentId;
    stats.learningMicroFamilyId = parentId;
  }

  if (isMicroMicroLayer && microMicroId) {
    stats.microFamilyId = microMicroId;
    stats.trueMicroFamilyId = microMicroId;
    stats.childTrueMicroFamilyId = childId;
    stats.analyzeMicroFamilyId = microMicroId;
    stats.learningMicroFamilyId = microMicroId;
  }

  stats.setupType = taxonomy.setupType || stats.setupType || null;
  stats.regimeBucket = taxonomy.regimeBucket || stats.regimeBucket || null;
  stats.confirmationProfile = taxonomy.confirmationProfile || stats.confirmationProfile || null;

  stats.trueMicroOnly = !isParentLayer;
  stats.exactTrueMicroOnly = !isParentLayer;
  stats.exactTrueMicroFamilyRequired = !isParentLayer;

  stats.trueMicroFamilySchema = isMicroMicroLayer ? MICRO_MICRO_SCHEMA : isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA;
  stats.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
  stats.exactTrueMicroFamilySchema = isMicroMicroLayer ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA;
  stats.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;
  stats.broadTrueMicroFamilySchema = TRUE_MICRO_SCHEMA;
  stats.microFamilySchema = isMicroMicroLayer ? MICRO_MICRO_SCHEMA : isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA;
  stats.microMicroFamilySchema = MICRO_MICRO_SCHEMA;
  stats.schema = stats.microFamilySchema;

  stats.learningGranularity = isMicroMicroLayer
    ? MICRO_MICRO_LEARNING_GRANULARITY
    : isParentLayer
      ? PARENT_LEARNING_GRANULARITY
      : LEARNING_GRANULARITY;

  stats.parentLearningGranularity = PARENT_LEARNING_GRANULARITY;
  stats.microMicroLearningGranularity = MICRO_MICRO_LEARNING_GRANULARITY;

  stats.fixedTaxonomyPreferred = true;
  stats.fixedTaxonomyLearningId = taxonomy.fixedTaxonomyLearningId;
  stats.fixedTaxonomyBaseId = taxonomy.fixedTaxonomyBaseId || stats.fixedTaxonomyBaseId || parentId || null;
  stats.selectableChild = isMicro75Layer;
  stats.selectableMicroMicro = isMicroMicroLayer;
  stats.selectable = isMicro75Layer || isMicroMicroLayer;

  stats.parentSelectionAllowed = false;
  stats.micro75SelectionAllowed = isMicro75Layer;
  stats.microMicroSelectionAllowed = isMicroMicroLayer;

  stats.selectionGranularity = isMicroMicroLayer
    ? SELECTION_EXACT_MICRO_MICRO
    : isMicro75Layer
      ? SELECTION_EXACT_75_CHILD
      : SELECTION_PARENT_CONTEXT;

  stats.fallbackRankingGranularity = isMicroMicroLayer
    ? 'MICRO_75_UNTIL_MICRO_MICRO_MIN_COMPLETED'
    : 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED';

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

  stats.executionFingerprintRole = isMicroMicroLayer ? 'MICRO_MICRO_IDENTITY' : 'METADATA_ONLY';
  stats.executionFingerprintsMetadataOnly = !isMicroMicroLayer;
  stats.executionFingerprintsUsedAsLearningFamily = isMicroMicroLayer;

  stats.analyzeMicroFamiliesOnly = true;
  stats.learningIdentitySource = isMicroMicroLayer
    ? 'ANALYZE_MICRO_MICRO_FAMILY'
    : isMicro75Layer
      ? 'ANALYZE_TRUE_MICRO_FAMILY'
      : 'ANALYZE_PARENT_TRUE_MICRO_FAMILY';

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

  stats.measurementFixVersion = MEASUREMENT_FIX_VERSION;
  stats.microMicroMeasurementVersion = MICRO_MICRO_MEASUREMENT_VERSION;
  stats.seenDefinition = 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY';
  stats.observationDedupeRequired = true;
  stats.observationAlwaysCounted = false;

  stats.defaultRanking = 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR';
  stats.bareWinrateRankingDisabled = true;
  stats.rawWinrateRankingDisabled = true;
  stats.rankingUsesBalancedScore = true;
  stats.rankingUsesFairWinrate = true;
  stats.rankingUsesTotalR = true;
  stats.rankingUsesAvgR = true;
  stats.rankingUsesAvgCostR = true;

  stats.currentFitSoftOnly = true;
  stats.currentFitBlocksLearning = false;
  stats.currentFitPolarity = 'BEARISH_POSITIVE_BULLISH_NEGATIVE';
  stats.currentFitDefinition = 'SHORT_MIRRORED_CURRENT_FIT';
  stats.learningRemainsBroad = true;
  stats.selectionWillBeAdaptive = true;
  stats.discordWillBeStrict = true;
  stats.discordSelectionRule = isMicroMicroLayer
    ? 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY'
    : 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY';
  stats.discordCanSelectExactMicroMicro = isMicroMicroLayer;
  stats.discordCanSelectExact75Child = isMicro75Layer;
  stats.discordParentMatchAllowed = false;

  stats.adaptiveLayerBuilt = false;
  stats.adaptiveScoreBuilt = false;
  stats.recentMomentumScoreBuilt = false;
  stats.currentFitScoreBuilt = false;
  stats.parentDiversificationBuilt = false;

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
    safeNumber(stats.shadowTotalCostR, 0) !== 0
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
  const w = shadowWeight();

  return {
    wins:
      safeNumber(stats.virtualWins, 0) +
      safeNumber(stats.shadowWins, 0) * w,

    losses:
      safeNumber(stats.virtualLosses, 0) +
      safeNumber(stats.shadowLosses, 0) * w,

    flats:
      safeNumber(stats.virtualFlats, 0) +
      safeNumber(stats.shadowFlats, 0) * w,

    completed:
      safeNumber(stats.virtualCompleted, 0) +
      safeNumber(stats.shadowCompleted, 0) * w
  };
}

function weightedSourceTotals(stats = {}) {
  const w = shadowWeight();

  return {
    totalR:
      safeNumber(stats.virtualTotalR, 0) +
      safeNumber(stats.shadowTotalR, 0) * w,

    totalPnlPct:
      safeNumber(stats.virtualTotalPnlPct, 0) +
      safeNumber(stats.shadowTotalPnlPct, 0) * w,

    totalCostR:
      safeNumber(stats.virtualTotalCostR, 0) +
      safeNumber(stats.shadowTotalCostR, 0) * w,

    grossWinR:
      safeNumber(stats.virtualGrossWinR, 0) +
      safeNumber(stats.shadowGrossWinR, 0) * w,

    grossLossR:
      safeNumber(stats.virtualGrossLossR, 0) +
      safeNumber(stats.shadowGrossLossR, 0) * w
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
    return Math.max(0, costPct / riskPct);
  }

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

function maxPositive(...values) {
  return Math.max(0, ...values.map((value) => positive(value)));
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
  const n = safeNumber(completed, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, sampleCap()) / sampleCap()), 0, 1);
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

function learningStatus(stats = {}) {
  const completed = safeNumber(stats.completed, 0);
  const minCompleted = safeNumber(stats.minCompletedForActiveLearning, rowLayerMinCompleted(stats));

  if (completed <= 0) return 'OBSERVING';
  if (completed < minCompleted) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
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

  const resolvedMicroFamilyId = parsed.valid
    ? parsed.id
    : String(microFamilyId || '').trim().toUpperCase();

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId || null;
  const childTrueMicroFamilyId = parsed.childTrueMicroFamilyId || null;
  const microMicroFamilyId = parsed.microMicroFamilyId || null;

  const inferredTradeSide = inferTradeSide({
    microFamilyId: resolvedMicroFamilyId,
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

  return {
    microFamilyId: resolvedMicroFamilyId,
    trueMicroFamilyId: resolvedMicroFamilyId,
    childTrueMicroFamilyId: childTrueMicroFamilyId || null,
    baseTrueMicroFamilyId: childTrueMicroFamilyId || null,
    trueMicro75FamilyId: childTrueMicroFamilyId || null,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,

    analyzeMicroFamilyId: resolvedMicroFamilyId,
    learningMicroFamilyId: resolvedMicroFamilyId,

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
    trueMicroFamilySchema: isMicroMicroLayer ? MICRO_MICRO_SCHEMA : isParentLayer ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicroLayer ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: isMicroMicroLayer
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParentLayer
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer,
    learningHierarchy: 'PARENT_15_TO_MICRO_75_TO_MICRO_MICRO',

    setupType: parsed.setupType || null,
    regimeBucket: parsed.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || null,
    fixedTaxonomyLearningId: isMicro75Layer || isMicroMicroLayer,
    fixedTaxonomyBaseId: parentTrueMicroFamilyId,
    selectableChild: isMicro75Layer,
    selectableMicroMicro: isMicroMicroLayer,
    selectable: isMicro75Layer || isMicroMicroLayer,

    trueMicroOnly: !isParentLayer,
    exactTrueMicroOnly: !isParentLayer,
    exactTrueMicroFamilyRequired: !isParentLayer,

    selectionGranularity: isMicroMicroLayer
      ? SELECTION_EXACT_MICRO_MICRO
      : isMicro75Layer
        ? SELECTION_EXACT_75_CHILD
        : SELECTION_PARENT_CONTEXT,

    parentSelectionAllowed: false,
    micro75SelectionAllowed: isMicro75Layer,
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

    totalPnlPct: 0,
    virtualTotalPnlPct: 0,
    realTotalPnlPct: 0,
    shadowTotalPnlPct: 0,

    totalCostR: 0,
    virtualTotalCostR: 0,
    realTotalCostR: 0,
    shadowTotalCostR: 0,

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

    executionFingerprintRole: isMicroMicroLayer ? 'MICRO_MICRO_IDENTITY' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !isMicroMicroLayer,
    executionFingerprintsUsedAsLearningFamily: isMicroMicroLayer,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: isMicroMicroLayer
      ? 'ANALYZE_MICRO_MICRO_FAMILY'
      : isMicro75Layer
        ? 'ANALYZE_TRUE_MICRO_FAMILY'
        : 'ANALYZE_PARENT_TRUE_MICRO_FAMILY',
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
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,
    discordSelectionRule: isMicroMicroLayer
      ? 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY'
      : 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    discordCanSelectExactMicroMicro: isMicroMicroLayer,
    discordCanSelectExact75Child: isMicro75Layer,
    discordParentMatchAllowed: false,

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

    'totalPnlPct',
    'virtualTotalPnlPct',
    'realTotalPnlPct',
    'shadowTotalPnlPct',

    'totalCostR',
    'virtualTotalCostR',
    'realTotalCostR',
    'shadowTotalCostR',

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

    'minCompletedForActiveLearning',
    'microMicroMinCompletedForActiveLearning'
  ];

  for (const field of numericFields) {
    stats[field] = safeNumber(stats[field], field === 'microMicroMinCompletedForActiveLearning' ? MIN_COMPLETED_MICRO_MICRO_ACTIVE : 0);
  }

  stats.realCompleted = 0;
  stats.realWins = 0;
  stats.realLosses = 0;
  stats.realFlats = 0;
  stats.realTotalR = 0;
  stats.realTotalPnlPct = 0;
  stats.realTotalCostR = 0;
  stats.realGrossWinR = 0;
  stats.realGrossLossR = 0;

  stats.currentFitSoftOnly = true;
  stats.currentFitBlocksLearning = false;
  stats.currentFitPolarity = 'BEARISH_POSITIVE_BULLISH_NEGATIVE';
  stats.currentFitDefinition = 'SHORT_MIRRORED_CURRENT_FIT';
  stats.learningRemainsBroad = true;
  stats.selectionWillBeAdaptive = true;
  stats.discordWillBeStrict = true;

  stats.adaptiveLayerBuilt = false;
  stats.adaptiveScoreBuilt = false;
  stats.recentMomentumScoreBuilt = false;
  stats.currentFitScoreBuilt = false;
  stats.parentDiversificationBuilt = false;

  stats.createdAt ||= now();
  stats.updatedAt ||= now();

  return stats;
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
  const parentId = rowParentTrueMicroId(stats) || rowParentTrueMicroId(row) || null;
  const childId = rowChildTrueMicroId(stats) || rowChildTrueMicroId(row) || null;
  const microMicroId = rowMicroMicroId(stats) || rowMicroMicroId(row) || null;
  const learningLayer = rowLearningLayer(stats);

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

  if (stats.examples.length < 20) {
    const parsed = parseShortTaxonomyMicroId(learningId);

    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      source: row.source || SOURCE_VIRTUAL,

      learningLayer,
      microFamilyId: learningId,
      trueMicroFamilyId: learningId,
      childTrueMicroFamilyId: childId,
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

      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFingerprintRole: row.scannerFingerprintRole || 'METADATA_ONLY',

      executionMicroFamilyId: row.executionMicroFamilyId || null,
      executionFingerprintHash: row.executionFingerprintHash || null,
      executionFingerprintRole: learningLayer === LAYER_MICRO_MICRO ? 'MICRO_MICRO_IDENTITY' : 'METADATA_ONLY',

      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      btcState: row.btcState || null,
      btcRelation: row.btcRelation || null,
      regime: row.regime || null,
      scannerReason: row.scannerReason || null,

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
      learningGranularity: stats.learningGranularity,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

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
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

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

  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (src === SOURCE_SHADOW) {
    stats.shadowCompleted += 1;
    stats.shadowTotalR += exitR;
    stats.shadowTotalPnlPct += pnlPct;
    stats.shadowTotalCostR += costR;

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

  const learningId = rowMicroId(stats);
  const parsed = parseShortTaxonomyMicroId(learningId);
  const parentId = parsed.parentTrueMicroFamilyId || rowParentTrueMicroId(row) || stats.parentTrueMicroFamilyId || null;
  const childId = parsed.childTrueMicroFamilyId || rowChildTrueMicroId(row) || stats.childTrueMicroFamilyId || null;
  const microMicroId = parsed.microMicroFamilyId || rowMicroMicroId(row) || stats.microMicroFamilyId || null;
  const learningLayer = parsed.learningLayer || rowLearningLayer(stats);

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    learningLayer,
    microFamilyId: learningId,
    trueMicroFamilyId: learningId,
    learningMicroFamilyId: learningId,

    childTrueMicroFamilyId: childId,
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
    grossR: safeNumber(row.grossR ?? row.rawR ?? row.realizedGrossR ?? geometry.shortGrossR, 0),
    shortGrossR: safeNumber(row.shortGrossR ?? geometry.shortGrossR ?? row.grossR, 0),
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
    learningGranularity: stats.learningGranularity,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

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

    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-50);
  stats.updatedAt = now();

  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
  const n = safeNumber(completed, 0);
  const w = clamp(safeNumber(wins, 0), 0, n);

  if (n <= 0) return 0;

  const p = w / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return clamp((centre - margin) / denominator, 0, 1);
}

export function bayesianWinrate(wins, completed) {
  const n = safeNumber(completed, 0);
  const w = safeNumber(wins, 0);

  const priorN = priorTrades();
  const priorW = priorN * priorWinrate();

  const denominator = n + priorN;

  return denominator > 0
    ? clamp((w + priorW) / denominator, 0, 1)
    : 0;
}

function buildBalancedScore({
  fair,
  avgR,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR,
  sampleFallbackPenalty
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;

  const totalRComponent = Math.log1p(positive(totalR)) * 12;
  const avgRComponent = Math.log1p(positive(avgR)) * 8;

  return (
    fair * 100 +
    sampleRel * 25 +
    totalRComponent +
    avgRComponent +
    pfNorm * 8 +
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
  sampleFallbackPenalty
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;
  const totalRComponent = Math.log1p(positive(totalR)) * 8;

  return (
    sampleAdjustedAvgRValue * 100 +
    fair * 35 +
    sampleRel * 25 +
    totalRComponent +
    pfNorm * 8 +
    nearTpPct * 3 +
    reachedOneRPct * 3 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8 -
    sampleFallbackPenalty
  );
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

  const grossWinR = hasBuckets
    ? sourceTotals.grossWinR
    : maxPositive(
      stats.grossWinR,
      recent.grossWinR,
      totalR > 0 && weightedLosses <= 0 ? totalR : 0
    );

  const grossLossR = hasBuckets
    ? sourceTotals.grossLossR
    : maxPositive(
      stats.grossLossR,
      recent.grossLossR,
      totalR < 0 && weightedWins <= 0 ? Math.abs(totalR) : 0
    );

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

  const avgPnlPct = weightedCompletedForR > 0
    ? totalPnlPct / weightedCompletedForR
    : 0;

  const avgWinR = weightedWins > 0
    ? grossWinR / weightedWins
    : 0;

  const avgLossR = weightedLosses > 0
    ? -grossLossR / weightedLosses
    : 0;

  const profitFactor =
    grossLossR > 0 ? grossWinR / grossLossR :
      grossWinR > 0 ? 99 :
        0;

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

  const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);

  const microMicroSampleTooSmall =
    learningLayer === LAYER_MICRO_MICRO &&
    closedCompleted < MIN_COMPLETED_MICRO_MICRO_ACTIVE;

  const sampleFallbackPenalty = microMicroSampleTooSmall ? 6 : 0;

  const balancedScore = buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR,
    sampleFallbackPenalty
  });

  const avgRScore = buildAvgRScore({
    sampleAdjustedAvgRValue,
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
    sampleFallbackPenalty
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

    virtualTotalR: round4(stats.virtualTotalR),
    realTotalR: 0,
    shadowTotalR: round4(stats.shadowTotalR),

    virtualTotalPnlPct: round4(stats.virtualTotalPnlPct),
    realTotalPnlPct: 0,
    shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),

    virtualTotalCostR: round4(stats.virtualTotalCostR),
    realTotalCostR: 0,
    shadowTotalCostR: round4(stats.shadowTotalCostR),

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
    costStatsInferredFromRecent,
    directSLStatsInferredFromRecent,

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

    executionFingerprintRole: learningLayer === LAYER_MICRO_MICRO ? 'MICRO_MICRO_IDENTITY' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: learningLayer !== LAYER_MICRO_MICRO,
    executionFingerprintsUsedAsLearningFamily: learningLayer === LAYER_MICRO_MICRO,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: learningLayer === LAYER_MICRO_MICRO
      ? 'ANALYZE_MICRO_MICRO_FAMILY'
      : learningLayer === LAYER_MICRO_75
        ? 'ANALYZE_TRUE_MICRO_FAMILY'
        : 'ANALYZE_PARENT_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: learningLayer !== LAYER_MICRO_MICRO,

    trueMicroOnly: learningLayer !== LAYER_PARENT_15,
    exactTrueMicroOnly: learningLayer !== LAYER_PARENT_15,
    exactTrueMicroFamilyRequired: learningLayer !== LAYER_PARENT_15,

    trueMicroFamilySchema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : learningLayer === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microFamilySchema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : learningLayer === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    schema: learningLayer === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : learningLayer === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,

    learningGranularity: learningLayer === LAYER_MICRO_MICRO
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : learningLayer === LAYER_PARENT_15
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer,
    learningHierarchy: 'PARENT_15_TO_MICRO_75_TO_MICRO_MICRO',

    selectionGranularity: learningLayer === LAYER_MICRO_MICRO
      ? SELECTION_EXACT_MICRO_MICRO
      : learningLayer === LAYER_MICRO_75
        ? SELECTION_EXACT_75_CHILD
        : SELECTION_PARENT_CONTEXT,

    parentSelectionAllowed: false,
    micro75SelectionAllowed: learningLayer === LAYER_MICRO_75,
    microMicroSelectionAllowed: learningLayer === LAYER_MICRO_MICRO,

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

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    microMicroMeasurementVersion: MICRO_MICRO_MEASUREMENT_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    observationAlwaysCounted: false,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,
    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,
    discordSelectionRule: learningLayer === LAYER_MICRO_MICRO
      ? 'EXACT_MICRO_MICRO_FAMILY_ID_ONLY'
      : 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    discordCanSelectExactMicroMicro: learningLayer === LAYER_MICRO_MICRO,
    discordCanSelectExact75Child: learningLayer === LAYER_MICRO_75,
    discordParentMatchAllowed: false,

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

  applySideIdentity(stats);

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;

  return stats;
}

export function normalizeDashboardMicro(row = {}, rank = null) {
  const stats = refreshStats(row);

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
  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function compareWinrate(a, b) {
  return (
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0) ||
    safeNumber(b.bayesianWinrate, 0) - safeNumber(a.bayesianWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function compareAvgR(a, b) {
  return (
    safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
    safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    sortById(a, b)
  );
}

function compareTotalR(a, b) {
  return (
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    sortById(a, b)
  );
}

function compareBalanced(a, b) {
  return (
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    compareWinrate(a, b)
  );
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const safeMode = mode === 'winrate'
    ? 'balanced'
    : String(mode || 'balanced');

  const rows = Object.values(micros || {})
    .filter(Boolean)
    .filter(isRealAnalyzeMicroRow)
    .map((row) => refreshStats(row))
    .filter((row) => row.tradeSide === TARGET_TRADE_SIDE)
    .filter((row) => validLearningId(row.microFamilyId))
    .filter((row) => validLearningId(row.trueMicroFamilyId))
    .filter((row) => isSelectableLearningFamilyId(row.microFamilyId || row.trueMicroFamilyId));

  const sorted = [...rows].sort((a, b) => {
    if (safeMode === 'totalR') {
      return compareTotalR(a, b);
    }

    if (safeMode === 'avgR') {
      return compareAvgR(a, b);
    }

    if (safeMode === 'directSL') {
      return (
        safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
        safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
        safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
        sortById(a, b)
      );
    }

    if (safeMode === 'observed') {
      return (
        safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
        safeNumber(b.observations, 0) - safeNumber(a.observations, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
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

    return compareBalanced(a, b);
  });

  return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}

export function getLearningLayerIds(row = {}) {
  const childId = rowChildTrueMicroId(row);
  const parentId = rowParentTrueMicroId(row);
  const microMicroId = rowMicroMicroId(row);

  return {
    parentTrueMicroFamilyId: parentId || null,
    trueMicroFamilyId: childId || null,
    childTrueMicroFamilyId: childId || null,
    microMicroFamilyId: microMicroId || null,
    trueMicroMicroFamilyId: microMicroId || null,
    exactMicroMicroFamilyId: microMicroId || null,
    orderedLearningIds: [
      parentId,
      childId,
      microMicroId
    ].filter(Boolean),
    rollupPolicy: 'UPDATE_PARENT_15_AND_MICRO_75_AND_OPTIONAL_MICRO_MICRO',
    sampleDoesNotSplitParent: true,
    sampleDoesNotSplitMicro75: true,
    microMicroSelectable: Boolean(microMicroId)
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
    microFamilyId: learningId || null,

    trueMicroFamilyId: childId || (parsed.isParent ? parentId : learningId) || null,
    childTrueMicroFamilyId: childId,

    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,

    learningLayer: parsed.learningLayer || 'UNKNOWN',

    parentTrueMicroFamilyId: parentId,

    selectionGranularity: parsed.isMicroMicro
      ? SELECTION_EXACT_MICRO_MICRO
      : parsed.isChild
        ? SELECTION_EXACT_75_CHILD
        : parsed.isParent
          ? SELECTION_PARENT_CONTEXT
          : 'UNKNOWN',

    trueMicroFamilySchema: parsed.isParent ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: parsed.isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,

    learningGranularity: parsed.isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : parsed.isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,

    sampleFallbackAllowed: parsed.isMicroMicro,
    sampleFallbackLayer: parsed.isMicroMicro ? LAYER_MICRO_75 : parsed.isChild ? LAYER_PARENT_15 : null,
    sampleFallbackId: parsed.isMicroMicro
      ? parsed.childTrueMicroFamilyId
      : parsed.isChild
        ? parsed.parentTrueMicroFamilyId
        : null,

    selectableChild: parsed.isChild,
    selectableMicroMicro: parsed.isMicroMicro,
    selectable: parsed.isChild || parsed.isMicroMicro
  };
}

export {
  dashboardSideFromTradeSide
};