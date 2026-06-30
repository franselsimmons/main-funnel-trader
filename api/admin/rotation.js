// ================= FILE: api/admin/rotation.js =================
//
// SHORT-only admin rotation endpoint.
//
// Aangepast:
// - Parent 15 = metadata only.
// - 75-child = selecteerbaar.
// - Micro-micro MM = ook selecteerbaar, en krijgt voorkeur als jouw rotationEngine/analyzeEngine MM ondersteunt.
// - Geen macro/parent expansion.
// - Geen auto-rotation.
// - Alleen manual Discord selectie.
// - SHORT-only, virtual-only, geen real orders.
//
// Selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
//
// Niet selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}
// - scanner fingerprints
// - XR execution fingerprints
// - LONG ids

import {
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import {
  activateSelectedMicroFamilies,
  getActiveRotation,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_STABLE_OUTCOME_DEDUPE_V2';
const POSITION_MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_V4';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_MICRO_MICRO_LAYERING_V1';

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const SHORT_FIXED_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const SHORT_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

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

const ALLOWED_ACTIONS = [
  'activateSelected',
  'activateSelectedMicroFamilies',
  'activateSelectedMacroFamilies'
];

const BLOCKED_AUTO_ACTIONS = new Set([
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestShortMicroFamily',
  'activateBestLongMicroFamily',
  'activateBestBearMicroFamily',
  'activateBestBullMicroFamily',
  'activateBestLong',
  'activateLong',
  'activateBestShort',
  'activateShort',
  'activateNextRotation',
  'autoActivate',
  'autoBootstrap'
]);

const ALLOWED_MODES = new Set([
  'manual',
  'selected',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const DEFAULT_AVAILABLE_LIMIT = 120;
const MAX_AVAILABLE_LIMIT = 500;

const DEFAULT_ACTIVE_ROWS_LIMIT = 160;
const MAX_ACTIVE_ROWS_LIMIT = 500;

function now() {
  return Date.now();
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,
    virtualTracked: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    observationAlwaysCounted: false,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    timeStopEnabled: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    rawExecutionFingerprintsNotSelectable: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_OR_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableMicroMicroRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
    selectableIdsAreChildrenOnly: false,
    selectableIdsAreChildOrMicroMicroOnly: true,
    microMicroPreferred: true,
    parentIdsAreMetadataOnly: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD',
    manualSelectionMustUseSelectable75ChildOrMicroMicroId: true,
    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function taxonomyMeta() {
  return {
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    selectableMicroMicroCount: 'DYNAMIC_PER_75_CHILD',

    setups: SETUP_ORDER,
    regimes: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER,

    validSetupTypes: [...SHORT_FIXED_SETUP_TYPES],
    validRegimeBuckets: [...SHORT_FIXED_REGIME_BUCKETS],
    validConfirmationProfiles: [...SHORT_CONFIRMATION_PROFILES],

    parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableChildFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableMicroMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',

    exampleParent: 'MICRO_SHORT_BREAKOUT_TREND',
    exampleSelectableChild: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
    exampleSelectableMicroMicro: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_MM_AB12CD34EF',

    selectableIdsAreChildOrMicroMicroOnly: true,
    microMicroPreferred: true,
    parentIdsAreMetadataOnly: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...modeFlags()
  });
}

function parseJson(text) {
  const clean = String(text || '').trim();

  if (!clean) return {};

  try {
    return JSON.parse(clean);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function toLimit(value, fallback = DEFAULT_AVAILABLE_LIMIT, max = MAX_AVAILABLE_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n < 1) return fallback;

  return Math.min(n, max);
}

function normalizeMode(value, fallback = 'manual') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
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
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
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

function firstFiniteNumber(values = []) {
  for (const value of flattenValues(values)) {
    if (value === undefined || value === null || value === '') continue;

    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return null;
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function getDefinitionParts(row = {}) {
  return [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
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

  return (
    value.includes('_XR_') ||
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

  const mmMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);

  if (mmMatch) {
    baseValue = mmMatch[1];
    microMicroHash = mmMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
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
    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: isMicroMicro
      ? 'MICRO_MICRO'
      : isChild
        ? 'MICRO_75'
        : isParent
          ? 'PARENT_15'
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

function isFixedShortParentMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.valid && parsed.isParent;
}

function isFixedShortChildMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.valid && parsed.isChild;
}

function isFixedShortMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.valid && parsed.isMicroMicro;
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function firstValidLearningId(values = [], fallback = null) {
  for (const value of values) {
    const id = String(value || '').trim();

    if (validLearningId(id)) return id;
  }

  return fallback;
}

function getMicroFamilyId(row = {}, fallback = null) {
  return firstValidLearningId([
    row.trueMicroMicroFamilyId,
    row.microMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], null);
}

function getTrueMicroFamilyId(row = {}, fallback = null) {
  const id = getMicroFamilyId(row, fallback);
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.selectable ? parsed.trueMicroFamilyId : id;
}

function getChildTrueMicroFamilyId(row = {}, fallback = null) {
  const id = getTrueMicroFamilyId(row, fallback);
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.childTrueMicroFamilyId || null;
}

function getMicroMicroFamilyId(row = {}, fallback = null) {
  const id = getTrueMicroFamilyId(row, fallback);
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.microMicroFamilyId || null;
}

function getParentTrueMicroFamilyId(row = {}, fallback = null) {
  const trueMicroFamilyId = getTrueMicroFamilyId(row, fallback);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  if (parsed.parentTrueMicroFamilyId) return parsed.parentTrueMicroFamilyId;

  return firstValidLearningId([
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.familyId
  ], null);
}

function getFamilyId(row = {}) {
  const parent = getParentTrueMicroFamilyId(row);

  return firstValidLearningId([
    row.familyId,
    row.family,
    row.baseFamilyId,
    parent
  ], null);
}

function getMacroFamilyId(row = {}) {
  const parent = getParentTrueMicroFamilyId(row);

  return firstValidLearningId([
    parent,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.familyId
  ], null);
}

function definitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.microMicroDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    if (parseShortTaxonomyMicroId(input).valid) return TARGET_TRADE_SIDE;

    const value = cleanSideText(input);

    if (value.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (value.includes('LONG') || value.includes('BULL') || value.includes('BUY')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('SHORT') || value.includes('BEAR') || value.includes('SELL')) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const directSources = [
    input.tradeSide,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.side,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const trueMicroFamilyId = cleanSideText(getTrueMicroFamilyId(input) || getMicroFamilyId(input));
  const macroFamilyId = cleanSideText(getMacroFamilyId(input));

  if (parseShortTaxonomyMicroId(trueMicroFamilyId).valid) return TARGET_TRADE_SIDE;
  if (trueMicroFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  if (parseShortTaxonomyMicroId(macroFamilyId).valid) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  const definition = definitionHaystack(input);

  if (definition.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
  if (definition.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (input.longOnly === true || input.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isSelectableTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  const parsed = parseShortTaxonomyMicroId(value);

  return parsed.selectable === true;
}

function isShortFamilyId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (upper(value).includes('MICRO_LONG_')) return false;

  return parseShortTaxonomyMicroId(value).valid;
}

function isShortRow(row = {}) {
  const id = getTrueMicroFamilyId(row) || getMicroFamilyId(row);

  if (!validLearningId(id)) return false;
  if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;

  return true;
}

function isTrueMicroFamilyRow(row = {}) {
  const id = getTrueMicroFamilyId(row) || getMicroFamilyId(row);

  if (!validLearningId(id)) return false;
  if (!isShortRow(row)) return false;

  return isSelectableTrueMicroId(id);
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      getMicroFamilyId(row, String(index)),
      row
    ]);
  }

  if (!value || typeof value !== 'object') return [];

  return Object.entries(value);
}

function hasVirtualShadowOutcomeFields(row = {}) {
  return [
    'virtualCompleted',
    'shadowCompleted',
    'virtualWins',
    'virtualLosses',
    'virtualFlats',
    'shadowWins',
    'shadowLosses',
    'shadowFlats',
    'virtualTotalR',
    'shadowTotalR'
  ].some((key) => hasValue(row[key]));
}

function virtualKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `virtual${String(realKey).slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
  if (!realKey || !String(realKey).startsWith('real')) return null;

  return `shadow${String(realKey).slice(4)}`;
}

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey = null) {
  const virtualKey = virtualKeyFromReal(realKey);
  const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

  const virtualShadow =
    num(virtualKey ? row[virtualKey] : 0, 0) +
    num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0);

  if (virtualShadow > 0 || hasVirtualShadowOutcomeFields(row)) {
    return virtualShadow;
  }

  if (aggregateKey && hasValue(row[aggregateKey])) {
    return num(row[aggregateKey], 0);
  }

  return 0;
}

function getShortRiskGeometry(row = {}) {
  const entry = firstFiniteNumber([
    row.entryPrice,
    row.entry,
    row.avgEntryPrice,
    row.averageEntryPrice,
    row.averageEntry,
    row.openPrice
  ]);

  const initialSl = firstFiniteNumber([
    row.initialSl,
    row.initialSL,
    row.initialStopLoss,
    row.initialStopLossPrice,
    row.stopLoss,
    row.stopLossPrice,
    row.sl,
    row.slPrice
  ]);

  const tp = firstFiniteNumber([
    row.tp,
    row.takeProfit,
    row.takeProfitPrice,
    row.targetPrice,
    row.finalTp,
    row.finalTakeProfit
  ]);

  const exitPrice = firstFiniteNumber([
    row.exitPrice,
    row.closePrice,
    row.closedPrice,
    row.outcomePrice,
    row.fillExitPrice,
    row.exit
  ]);

  const currentPrice = firstFiniteNumber([
    row.currentPrice,
    row.markPrice,
    row.lastPrice,
    row.price
  ]);

  const denominator =
    Number.isFinite(entry) && Number.isFinite(initialSl)
      ? initialSl - entry
      : 0;

  const validGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(initialSl) &&
    Number.isFinite(tp) &&
    denominator > 0 &&
    tp < entry &&
    entry < initialSl;

  const shortGrossR =
    validGeometry && Number.isFinite(exitPrice)
      ? (entry - exitPrice) / denominator
      : null;

  const shortCurrentR =
    validGeometry && Number.isFinite(currentPrice)
      ? (entry - currentPrice) / denominator
      : null;

  const shortTpHit =
    validGeometry &&
    (
      row.shortTpHit === true ||
      row.tpHit === true ||
      (Number.isFinite(exitPrice) && exitPrice <= tp) ||
      (Number.isFinite(currentPrice) && currentPrice <= tp)
    );

  const shortSlHit =
    validGeometry &&
    (
      row.shortSlHit === true ||
      row.slHit === true ||
      (Number.isFinite(exitPrice) && exitPrice >= initialSl) ||
      (Number.isFinite(currentPrice) && currentPrice >= initialSl)
    );

  return {
    entry,
    initialSl,
    tp,
    exitPrice,
    currentPrice,
    denominator,
    validGeometry,
    shortTpHit: Boolean(shortTpHit),
    shortSlHit: Boolean(shortSlHit),
    shortGrossR,
    shortCurrentR,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}

function outcomeNetR(row = {}) {
  const explicitShortR = firstFiniteNumber([
    row.shortNetR,
    row.netShortR,
    row.shortExitR,
    row.shortRealizedNetR,
    row.shortRealizedR
  ]);

  if (explicitShortR !== null) return explicitShortR;

  const geometry = getShortRiskGeometry(row);
  const costR = num(row.costR ?? row.avgCostR, 0);

  if (geometry.validGeometry && geometry.shortGrossR !== null) {
    return geometry.shortGrossR - costR;
  }

  return num(
    row.netR ??
      row.exitR ??
      row.realizedNetR ??
      row.realizedR ??
      row.r,
    0
  );
}

function outcomeCounts(row = {}) {
  const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
  const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
  const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');

  const virtualShadowCompleted =
    num(row.virtualCompleted, 0) +
    num(row.shadowCompleted, 0);

  const aggregateCompleted = hasVirtualShadowOutcomeFields(row)
    ? 0
    : Math.max(
      num(row.completed, 0),
      num(row.outcomeSample, 0),
      0
    );

  const countedTotal = wins + losses + flats;
  const total = Math.max(countedTotal, virtualShadowCompleted, aggregateCompleted, 0);
  const inferredFlats = Math.max(0, total - wins - losses);

  return {
    wins,
    losses,
    flats: Math.max(flats, inferredFlats),
    total
  };
}

function completedSample(row = {}) {
  return outcomeCounts(row).total;
}

function observationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    completedSample(row),
    0
  );
}

function totalR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  const virtualShadowTotalR =
    num(row.virtualTotalR, 0) +
    num(row.shadowTotalR, 0);

  if (virtualShadowTotalR !== 0 || hasVirtualShadowOutcomeFields(row)) {
    return virtualShadowTotalR;
  }

  if (hasValue(row.shortNetTotalR)) return num(row.shortNetTotalR, 0);
  if (hasValue(row.netShortTotalR)) return num(row.netShortTotalR, 0);
  if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
  if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
  if (hasValue(row.totalR)) return num(row.totalR, 0);

  if (Array.isArray(row.recentOutcomes)) {
    return row.recentOutcomes
      .filter(Boolean)
      .filter((outcome) => inferTradeSide({ ...row, ...outcome }) !== OPPOSITE_TRADE_SIDE)
      .reduce((sum, outcome) => sum + outcomeNetR(outcome), 0);
  }

  return 0;
}

function avgR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  return totalR(row) / completed;
}

function totalCostR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  const virtualShadowCost =
    num(row.virtualTotalCostR, 0) +
    num(row.shadowTotalCostR, 0);

  if (virtualShadowCost > 0 || hasVirtualShadowOutcomeFields(row)) return virtualShadowCost;

  if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);
  if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;

  return 0;
}

function avgCostR(row = {}) {
  const completed = completedSample(row);

  if (completed <= 0) return 0;

  return totalCostR(row) / completed;
}

function marketBiasHaystack(row = {}) {
  return [
    row.currentMarketTrendSide,
    row.marketTrendSide,
    row.trendSide,
    row.dashboardSide,
    row.marketSide,
    row.marketBias,
    row.bias,
    row.direction,
    row.currentRegime,
    row.marketRegime,
    row.regime,
    row.currentFitReason,
    ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
  ]
    .map((value) => upper(value))
    .join(' | ');
}

function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
  if (!Number.isFinite(score)) return fallback || 'UNKNOWN';
  if (score >= 45) return 'FIT';
  if (score >= 20) return 'OK';
  if (score <= -20) return 'MISFIT';

  return 'NEUTRAL';
}

function getShortCurrentFit(row = {}) {
  const explicitShort = firstFiniteNumber([
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore
  ]);

  if (explicitShort !== null) {
    return {
      score: explicitShort,
      label: currentFitLabel(explicitShort, row.currentFit || 'UNKNOWN'),
      source: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const explicitLong = firstFiniteNumber([
    row.longCurrentFit,
    row.bullCurrentFit,
    row.bullishCurrentFit,
    row.currentFitLong,
    row.currentFitBull,
    row.longFitScore,
    row.bullFitScore
  ]);

  if (explicitLong !== null) {
    const score = -Math.abs(explicitLong);

    return {
      score,
      label: currentFitLabel(score, row.currentFit || 'UNKNOWN'),
      source: 'INVERTED_LONG_OR_BULL_CURRENT_FIT'
    };
  }

  const rawFit = firstFiniteNumber([
    row.currentFitScore,
    row.fitScore,
    row.marketFitScore,
    row.marketFit,
    row.currentFitNumeric
  ]);

  if (rawFit === null) {
    return {
      score: 0,
      label: row.currentFit || row.currentFitLabel || 'UNKNOWN',
      source: 'NO_NUMERIC_CURRENT_FIT'
    };
  }

  const haystack = marketBiasHaystack(row);
  let score;

  if (
    haystack.includes('BEAR') ||
    haystack.includes('BEARISH') ||
    haystack.includes('SHORT') ||
    haystack.includes('SELL') ||
    haystack.includes('DOWNSIDE')
  ) {
    score = Math.abs(rawFit);
  } else if (
    haystack.includes('BULL') ||
    haystack.includes('BULLISH') ||
    haystack.includes('LONG') ||
    haystack.includes('BUY') ||
    haystack.includes('UPSIDE')
  ) {
    score = -Math.abs(rawFit);
  } else {
    score = -rawFit;
  }

  return {
    score,
    label: currentFitLabel(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
    source: 'SHORT_MIRRORED_GENERIC_CURRENT_FIT'
  };
}

function learningStatus(row = {}) {
  const completed = completedSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function eligibilityTier(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'HARD';
  if (completed > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function learningQualityRank(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);

  if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 3;
  if (completed > 0) return 2;
  if (observed > 0) return 1;

  return 0;
}

function normalizeRotationRow(row = {}, index = 0) {
  const selectedId = getTrueMicroFamilyId(row) || getMicroFamilyId(row);

  if (!isSelectableTrueMicroId(selectedId)) return null;

  const parsed = parseShortTaxonomyMicroId(selectedId);
  const childTrueMicroFamilyId = parsed.childTrueMicroFamilyId;
  const microMicroFamilyId = parsed.microMicroFamilyId;
  const isMicroMicro = parsed.isMicroMicro === true;

  const rawSide = inferTradeSide({
    ...row,
    microFamilyId: selectedId,
    trueMicroFamilyId: selectedId,
    childTrueMicroFamilyId,
    microMicroFamilyId
  });

  if (rawSide === OPPOSITE_TRADE_SIDE) return null;

  const parentTrueMicroFamilyId = parsed.parentTrueMicroFamilyId;
  const counts = outcomeCounts(row);
  const completed = completedSample(row);
  const observed = observationSample(row);
  const tier = row.selectedTier || row.rotationEligibilityTier || eligibilityTier(row);
  const risk = getShortRiskGeometry(row);
  const fit = getShortCurrentFit(row);

  return {
    rank: index + 1,

    microFamilyId: selectedId,
    trueMicroFamilyId: selectedId,
    analyzeMicroFamilyId: selectedId,
    learningMicroFamilyId: selectedId,

    childTrueMicroFamilyId,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash: parsed.microMicroHash || row.microMicroHash || null,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    familyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,

    parentMacroFamilyId: parentTrueMicroFamilyId,
    parentMicroFamilyId: parentTrueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    ...modeFlags(),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: true,
    selectableMicroMicroFamily: isMicroMicro,
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: parsed.learningLayer,
    learningGranularity: parsed.learningGranularity,
    selectionGranularity: isMicroMicro ? 'EXACT_MICRO_MICRO' : 'EXACT_75_CHILD',

    inferredTradeSide: rawSide === 'UNKNOWN' ? TARGET_TRADE_SIDE : rawSide,
    inferredFromShortOnlyMode: rawSide === 'UNKNOWN',

    schema: row.schema || row.microFamilySchema || parsed.trueMicroFamilySchema || TRUE_MICRO_SCHEMA,
    microFamilySchema: row.microFamilySchema || row.schema || parsed.trueMicroFamilySchema || TRUE_MICRO_SCHEMA,
    version: row.version || null,

    isTrueMicro: true,
    isChildTrueMicro: !isMicroMicro,
    isMicroMicro,
    isLegacyMacro: false,

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(completed, 4),
    virtualCompleted: round(row.virtualCompleted, 4),
    shadowCompleted: round(row.shadowCompleted, 4),
    realCompleted: 0,

    outcomeSample: round(completed, 4),
    observationSample: round(observed, 4),
    awaitingOutcomes: completed <= 0 && observed > 0,
    learningStatus: learningStatus(row),
    status: learningStatus(row),

    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_ACTIVE_LEARNING
      ? `COMPLETED_BELOW_${MIN_COMPLETED_ACTIVE_LEARNING}`
      : null,

    wins: round(counts.wins, 4),
    losses: round(counts.losses, 4),
    flats: round(counts.flats, 4),

    virtualWins: round(row.virtualWins, 4),
    virtualLosses: round(row.virtualLosses, 4),
    virtualFlats: round(row.virtualFlats, 4),

    shadowWins: round(row.shadowWins, 4),
    shadowLosses: round(row.shadowLosses, 4),
    shadowFlats: round(row.shadowFlats, 4),

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate, 4),

    winrateSample: round(row.winrateSample ?? completed, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? row.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),

    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    nearTpPct: round(row.nearTpPct, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitPct: round(row.beWouldExitPct, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(totalCostR(row), 4),
    avgCostR: round(avgCostR(row), 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? row.balancedScore, 4),
    adaptiveScore: round(row.adaptiveScore ?? row.microMicroScore ?? row.dashboardBalancedScore ?? row.balancedScore, 4),

    currentFit: fit.label,
    currentFitLabel: fit.label,
    currentFitScore: round(fit.score, 4),
    fitScore: round(fit.score, 4),
    currentFitSource: fit.source,
    shortCurrentFit: round(fit.score, 4),
    bearCurrentFit: round(fit.score, 4),
    bullishCurrentFit: round(-Math.abs(fit.score), 4),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    entry: risk.entry ?? row.entry ?? null,
    entryPrice: risk.entry ?? row.entryPrice ?? null,
    sl: risk.initialSl ?? row.sl ?? null,
    initialSl: risk.initialSl ?? row.initialSl ?? null,
    tp: risk.tp ?? row.tp ?? null,
    validShortRiskShape: Boolean(risk.validGeometry),
    validShortGeometry: Boolean(risk.validGeometry),
    shortTpHit: risk.shortTpHit,
    shortSlHit: risk.shortSlHit,
    tpHit: risk.shortTpHit,
    slHit: risk.shortSlHit,
    shortGrossR: risk.shortGrossR === null ? null : round(risk.shortGrossR, 4),
    shortCurrentR: risk.shortCurrentR === null ? null : round(risk.shortCurrentR, 4),
    currentR: risk.shortCurrentR === null ? row.currentR ?? null : round(risk.shortCurrentR, 4),
    riskGeometryRule: risk.riskGeometryRule,
    tpHitRule: risk.tpHitRule,
    slHitRule: risk.slHitRule,
    grossRFormula: risk.grossRFormula,
    currentRFormula: risk.currentRFormula,

    selectedTier: tier,
    rotationEligibilityTier: tier,

    assetClass: row.assetClass || null,

    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,

    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,

    obRelation: row.obRelation || null,

    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,

    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,
    executionFingerprintRole: isMicroMicro
      ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE'
      : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !isMicroMicro,
    executionFingerprintsUsedAsLearningFamily: isMicroMicro,

    definitionParts: getDefinitionParts(row),
    definition: row.definition || '',

    macroDefinitionParts: getMacroDefinitionParts(row),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      row.positionMeasurementFixVersion ||
      row.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function compareRows(a = {}, b = {}) {
  return (
    Number(Boolean(b.isMicroMicro)) - Number(Boolean(a.isMicroMicro)) ||
    learningQualityRank(b) - learningQualityRank(a) ||
    num(b.outcomeSample ?? completedSample(b), 0) - num(a.outcomeSample ?? completedSample(a), 0) ||
    num(b.adaptiveScore, 0) - num(a.adaptiveScore, 0) ||
    num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
    num(b.balancedScore, 0) - num(a.balancedScore, 0) ||
    num(b.fairWinrate, 0) - num(a.fairWinrate, 0) ||
    num(b.totalR, 0) - num(a.totalR, 0) ||
    num(b.avgR, 0) - num(a.avgR, 0) ||
    num(b.currentFitScore, 0) - num(a.currentFitScore, 0) ||
    num(a.directSLPct, 0) - num(b.directSLPct, 0) ||
    num(b.observationSample, 0) - num(a.observationSample, 0) ||
    String(a.trueMicroFamilyId || a.microFamilyId || '').localeCompare(String(b.trueMicroFamilyId || b.microFamilyId || ''))
  );
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    const key = row?.trueMicroFamilyId || row?.microFamilyId;

    if (!key) continue;
    if (seen.has(key)) continue;
    if (!isShortRow(row)) continue;
    if (!isTrueMicroFamilyRow(row)) continue;

    seen.add(key);
    output.push(row);
  }

  return output;
}

async function loadAvailableRows({
  weekKey,
  includePrevious = true,
  limit = DEFAULT_AVAILABLE_LIMIT
} = {}) {
  const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
  const currentWeekKey = PERSISTENT_LEARNING_KEY;
  const previousWeekKey = PERSISTENT_LEARNING_KEY;

  const current = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));

  const previous = includePrevious && previousWeekKey !== currentWeekKey
    ? await getWeekMicros(previousWeekKey).catch(() => ({}))
    : {};

  const merged = {
    ...(previous || {}),
    ...(current || {})
  };

  const rows = sourceEntries(merged)
    .map(([key, row], index) => {
      const rowId = getTrueMicroFamilyId(row, getMicroFamilyId(row, key));
      const currentHasKey = Boolean(current?.[key] || current?.[rowId]);
      const previousHasKey = Boolean(previous?.[key] || previous?.[rowId]);

      return normalizeRotationRow({
        ...(row || {}),
        key,
        microFamilyId: rowId,
        trueMicroFamilyId: rowId,
        analyzeMicroFamilyId: rowId,
        learningMicroFamilyId: rowId,
        sourceWeekKey: row?.sourceWeekKey || PERSISTENT_LEARNING_KEY,
        sourceWeekPrimary: currentHasKey || !previousHasKey,
        sourceWeekFallback: Boolean(!currentHasKey && previousHasKey)
      }, index);
    })
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow)
    .sort(compareRows);

  return {
    requestedWeekKey,
    currentWeekKey,
    previousWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,
    currentRows: sourceEntries(current).length,
    previousRows: sourceEntries(previous).length,
    mergedRows: rows.length,
    rows: dedupeRows(rows).slice(0, limit)
  };
}

function extractIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return uniqueStrings([
    rotation?.microFamilyIds || [],
    rotation?.activeMicroFamilyIds || [],
    rotation?.trueMicroFamilyIds || [],
    rotation?.childTrueMicroFamilyIds || [],
    rotation?.microMicroFamilyIds || [],
    rotation?.trueMicroMicroFamilyIds || [],
    rotation?.exactMicroMicroFamilyIds || [],
    rotation?.activeMicroMicroFamilyIds || [],
    rotation?.activeTrueMicroMicroFamilyIds || [],
    rotation?.ids || [],
    rows.map((row) => getTrueMicroFamilyId(row, getMicroFamilyId(row)))
  ]).filter(isSelectableTrueMicroId);
}

function extractMacroIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return uniqueStrings([
    rotation?.macroFamilyIds || [],
    rotation?.activeMacroFamilyIds || [],
    rotation?.parentTrueMicroFamilyIds || [],
    rows.map((row) => getMacroFamilyId(row))
  ])
    .filter(validLearningId)
    .filter(isFixedShortParentMicroId);
}

function manualActiveRowFromId(id, index = 0) {
  if (!id || !isSelectableTrueMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  return normalizeRotationRow({
    microFamilyId: parsed.trueMicroFamilyId,
    trueMicroFamilyId: parsed.trueMicroFamilyId,
    analyzeMicroFamilyId: parsed.trueMicroFamilyId,
    learningMicroFamilyId: parsed.trueMicroFamilyId,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    microMicroFamilyId: parsed.microMicroFamilyId,
    trueMicroMicroFamilyId: parsed.microMicroFamilyId,
    exactMicroMicroFamilyId: parsed.microMicroFamilyId,

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,

    trueMicro: true,
    isTrueMicro: true,
    isMicroMicro: parsed.isMicroMicro,
    active: true,
    fixedTaxonomyLearningId: true,

    trueMicroFamilySchema: parsed.isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    selectedTier: 'RAW',
    rotationEligibilityTier: 'RAW',
    seen: 0,
    observations: 0,
    completed: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    virtualWins: 0,
    virtualLosses: 0,
    virtualFlats: 0,
    shadowWins: 0,
    shadowLosses: 0,
    shadowFlats: 0,
    totalR: 0,
    avgR: 0,
    totalCostR: 0,
    avgCostR: 0
  }, index);
}

function compactActiveRotation(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;

  const activeMicroFamilyIds = extractIdsFromRotation(rotation);
  const activeMacroFamilyIds = extractMacroIdsFromRotation(rotation);

  const rowList = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const rows = rowList
    .map((row, index) => normalizeRotationRow(row, index))
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow);

  const existing = new Set(rows.map((row) => row.trueMicroFamilyId || row.microFamilyId).filter(Boolean));

  for (const id of activeMicroFamilyIds) {
    if (existing.has(id)) continue;

    const manualRow = manualActiveRowFromId(id, rows.length);
    if (!manualRow) continue;

    rows.push(manualRow);
    existing.add(id);
  }

  rows.sort(compareRows);

  const microMicroIds = activeMicroFamilyIds.filter(isFixedShortMicroMicroId);
  const childIds = uniqueStrings(
    activeMicroFamilyIds
      .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
      .filter(Boolean)
  );

  return {
    rotationId: rotation.rotationId || null,
    source: rotation.source || null,
    mode: rotation.mode || null,
    sourceWeekKey: rotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: rotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
    generatedAt: rotation.generatedAt || null,
    activatedAt: rotation.activatedAt || null,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: activeMicroFamilyIds.length > 0,

    empty: activeMicroFamilyIds.length === 0,
    emptyReason: activeMicroFamilyIds.length === 0
      ? 'NO_MANUAL_SHORT_EXACT_MICRO_OR_75_CHILD_SELECTION_ACTIVE'
      : null,

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    childTrueMicroFamilyIds: childIds,
    microMicroFamilyIds: microMicroIds,
    trueMicroMicroFamilyIds: microMicroIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    microFamilies: rows,

    count: activeMicroFamilyIds.length,
    activeCount: activeMicroFamilyIds.length,
    activeMicroMicroCount: microMicroIds.length,
    activeChildTrueMicroCount: childIds.length,

    bestShort: rows[0] || null,
    bestLong: null,
    missingSides: activeMicroFamilyIds.length ? [] : [TARGET_TRADE_SIDE]
  };
}

function parseSelectedIds(body = {}) {
  const microFamilyIds = uniqueStrings([
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.childTrueMicroFamilyIds,
    body.ids,
    body.id,
    body.microFamilyId,
    body.trueMicroFamilyId,
    body.childTrueMicroFamilyId
  ]);

  const microMicroFamilyIds = uniqueStrings([
    body.microMicroFamilyIds,
    body.trueMicroMicroFamilyIds,
    body.exactMicroMicroFamilyIds,
    body.activeMicroMicroFamilyIds,
    body.activeTrueMicroMicroFamilyIds,
    body.microMicroFamilyId,
    body.trueMicroMicroFamilyId,
    body.exactMicroMicroFamilyId
  ]);

  const macroFamilyIds = uniqueStrings([
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.macroFamilyId,
    body.parentTrueMicroFamilyId,
    body.parentMicroFamilyId
  ]);

  const requestedIds = uniqueStrings([
    microFamilyIds,
    microMicroFamilyIds,
    macroFamilyIds
  ]);

  const acceptedIds = uniqueStrings([
    microMicroFamilyIds,
    microFamilyIds
  ])
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId || id)
    .filter(isSelectableTrueMicroId);

  const ignoredRequestedIds = requestedIds
    .filter((id) => !acceptedIds.includes(parseShortTaxonomyMicroId(id).trueMicroFamilyId || id))
    .map((id) => {
      const side = inferTradeSide(id);
      const parsed = parseShortTaxonomyMicroId(id);
      const isMacroRequest = macroFamilyIds.includes(id) || parsed.isParent;

      return {
        id,
        normalizedId: parsed.trueMicroFamilyId || upper(id),
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'LONG_DISABLED_SHORT_ONLY'
          : isMacroRequest
            ? 'PARENT_OR_MACRO_ID_REJECTED_EXACT_MICRO_MICRO_OR_75_CHILD_REQUIRED'
            : isScannerFingerprintId(id)
              ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
              : isExecutionFingerprintId(id)
                ? 'EXECUTION_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
                : parsed.valid && !parsed.selectable
                  ? 'PARENT_15_ID_REJECTED_SELECT_75_CHILD_OR_MICRO_MICRO_ID'
                  : 'UNKNOWN_OR_NON_SELECTABLE_SHORT_MICRO_ID_REJECTED'
      };
    });

  return {
    requestedIds,
    microFamilyIds: acceptedIds,
    trueMicroFamilyIds: acceptedIds,
    childTrueMicroFamilyIds: uniqueStrings(
      acceptedIds
        .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
        .filter(Boolean)
    ),
    microMicroFamilyIds: acceptedIds.filter(isFixedShortMicroMicroId),
    macroFamilyIds: [],
    requestedMacroFamilyIds: macroFamilyIds,
    acceptedIds,
    ignoredRequestedIds
  };
}

function normalizeAction(body = {}) {
  const raw = String(body?.action || '').trim();

  if (raw) return raw;

  const ids = parseSelectedIds(body);

  if (ids.acceptedIds.length > 0) return 'activateSelectedMicroFamilies';

  return '';
}

function buildTierSummary(rows = []) {
  return rows.reduce((acc, row) => {
    const tier = row.rotationEligibilityTier || row.selectedTier || eligibilityTier(row);
    const layer = row.isMicroMicro ? 'MICRO_MICRO' : 'MICRO_75';

    acc.total += 1;
    acc[tier] = (acc[tier] || 0) + 1;
    acc[layer] = (acc[layer] || 0) + 1;

    return acc;
  }, {
    total: 0,
    HARD: 0,
    SOFT: 0,
    OBSERVATION: 0,
    RAW: 0,
    MICRO_75: 0,
    MICRO_MICRO: 0
  });
}

async function resolveSelectedIdsForActivation({
  selected,
  action
}) {
  const microFamilyIds = uniqueStrings(selected.microFamilyIds)
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId || id)
    .filter(isSelectableTrueMicroId);

  return {
    microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,
    childTrueMicroFamilyIds: uniqueStrings(
      microFamilyIds
        .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
        .filter(Boolean)
    ),
    microMicroFamilyIds: microFamilyIds.filter(isFixedShortMicroMicroId),

    macroFamilyIds: [],
    requestedMacroFamilyIds: selected.requestedMacroFamilyIds || [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: selected.requestedMacroFamilyIds || [],
    macroExpansionDisabled: action === 'activateSelectedMacroFamilies' ||
      (selected.requestedMacroFamilyIds || []).length > 0,
    parentExpansionDisabled: true,
    matchMode: 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD',
    selectionRule: 'EXACT_MICRO_MICRO_OR_75_CHILD_ONLY'
  };
}

async function handleGet(req, res) {
  const startedAt = now();

  const requestedWeekKey = String(
    firstValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY)
  ).trim();

  const availableLimit = toLimit(
    firstValue(req.query?.availableLimit, DEFAULT_AVAILABLE_LIMIT),
    DEFAULT_AVAILABLE_LIMIT,
    MAX_AVAILABLE_LIMIT
  );

  const activeRowsLimit = toLimit(
    firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT),
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ACTIVE_ROWS_LIMIT
  );

  const includeAvailable = isTrue(
    firstValue(req.query?.includeAvailable, true),
    true
  );

  const includePrevious = isTrue(
    firstValue(req.query?.includePrevious, true),
    true
  );

  const [dashboard, activeRotation, availableResult] = await Promise.all([
    getRotationDashboard({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      weekKey: PERSISTENT_LEARNING_KEY,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
    }).catch(() => null),

    getActiveRotation({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      weekKey: PERSISTENT_LEARNING_KEY,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
    }).catch(() => null),

    includeAvailable
      ? loadAvailableRows({
        weekKey: requestedWeekKey,
        includePrevious,
        limit: availableLimit
      }).catch((error) => ({
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        previousWeekKey: PERSISTENT_LEARNING_KEY,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
          ? requestedWeekKey
          : null,
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        rows: [],
        warning: error?.message || String(error)
      }))
      : Promise.resolve({
        requestedWeekKey,
        currentWeekKey: PERSISTENT_LEARNING_KEY,
        previousWeekKey: PERSISTENT_LEARNING_KEY,
        queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
          ? requestedWeekKey
          : null,
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        rows: []
      })
  ]);

  const active = compactActiveRotation(activeRotation);
  const availableRows = availableResult.rows || [];

  return res.status(200).json({
    ok: true,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKey,
    queryWeekKeyIgnored: availableResult.queryWeekKeyIgnored || null,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    activeRowsLimit,
    availableLimit,
    includeAvailable,
    includePrevious,

    activeRotation: active,
    active,

    activeRotationId: active?.rotationId || null,
    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: active?.childTrueMicroFamilyIds || [],
    activeMicroMicroFamilyIds: active?.microMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    activeRows: (active?.microFamilies || []).slice(0, activeRowsLimit),
    activeCount: active?.activeMicroFamilyIds?.length || 0,

    dashboard: dashboard || null,
    nextRotation: dashboard?.next || dashboard?.nextRotation || null,
    nextRotationStoredOnly: true,
    nextRotationAutoActivationDisabled: true,

    availableMicroFamilies: availableRows,
    availableRows,
    availableCount: availableRows.length,

    availableTierSummary: buildTierSummary(availableRows),

    sourceRows: {
      currentWeekRows: availableResult.currentRows,
      previousWeekRows: availableResult.previousRows,
      mergedRows: availableResult.mergedRows,
      warning: availableResult.warning || null
    },

    allowedActions: ALLOWED_ACTIONS,
    blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],

    buttons: {
      selectExact75Child: true,
      selectExactMicroMicro: true,
      selectParent15Disabled: true,
      copy: true,
      activateVisibleIdsForDiscord: true
    },

    perf: {
      durationMs: now() - startedAt,
      source: 'short_manual_selection_exact_micro_micro_or_75_child_rotation_dashboard'
    },

    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const action = normalizeAction(body);

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (BLOCKED_AUTO_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'AUTO_ROTATION_DISABLED_MANUAL_SELECTION_ONLY',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (!ALLOWED_ACTIONS.includes(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNKNOWN_OR_DISABLED_ACTION',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  const selected = parseSelectedIds(body);

  if (selected.acceptedIds.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: selected.ignoredRequestedIds.some((row) => row.reason === 'LONG_DISABLED_SHORT_ONLY')
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'SHORT_EXACT_MICRO_MICRO_OR_75_CHILD_IDS_REQUIRED',

      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,

      expectedFormats: [
        'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
        'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}'
      ],
      example75Child: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
      exampleMicroMicro: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_MM_AB12CD34EF',
      parentExampleRejected: 'MICRO_SHORT_BREAKOUT_TREND',

      allowedActions: ALLOWED_ACTIONS,
      ...modeFlags()
    });
  }

  const requestedWeekKey = String(
    firstValue(body.weekKey, PERSISTENT_LEARNING_KEY)
  ).trim();

  const weekKey = PERSISTENT_LEARNING_KEY;

  const mode = normalizeMode(
    firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'),
    'manual'
  );

  const resolved = await resolveSelectedIdsForActivation({
    selected,
    action,
    weekKey
  });

  if (resolved.microFamilyIds.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: 'NO_EXACT_SHORT_MICRO_MICRO_OR_75_CHILD_FAMILIES_RESOLVED',

      requestedMicroFamilyIds: selected.microFamilyIds,
      requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,
      unresolvedMacroFamilyIds: resolved.unresolvedMacroFamilyIds,
      macroExpansionDisabled: true,
      parentExpansionDisabled: true,

      ...modeFlags()
    });
  }

  const activation = await activateSelectedMicroFamilies({
    microFamilyIds: resolved.microFamilyIds,
    trueMicroFamilyIds: resolved.microFamilyIds,
    activeMicroFamilyIds: resolved.microFamilyIds,
    ids: resolved.microFamilyIds,

    childTrueMicroFamilyIds: resolved.childTrueMicroFamilyIds,
    microMicroFamilyIds: resolved.microMicroFamilyIds,
    trueMicroMicroFamilyIds: resolved.microMicroFamilyIds,
    exactMicroMicroFamilyIds: resolved.microMicroFamilyIds,
    activeMicroMicroFamilyIds: resolved.microMicroFamilyIds,
    activeTrueMicroMicroFamilyIds: resolved.microMicroFamilyIds,

    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    macroIds: [],

    weekKey,
    mode,

    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,

    manualOnly: true,
    exactTrueMicroFamilyOnly: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,
    selectableChildOnly: false,
    selectableChildOrMicroMicroOnly: true,
    selectableIdsAreChildrenOnly: false,
    selectableIdsAreChildOrMicroMicroOnly: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    rawExecutionFingerprintsNotSelectable: true,

    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    autoRotationActivationDisabled: true,

    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD',
    discordSelectionRule: 'EXACT_MICRO_MICRO_OR_75_CHILD_ONLY',

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION
  });

  const active = compactActiveRotation(activation);

  return res.status(200).json({
    ok: true,
    action,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY
      ? requestedWeekKey
      : null,
    mode,

    requestedMicroFamilyIds: selected.microFamilyIds,
    requestedTrueMicroFamilyIds: selected.trueMicroFamilyIds,
    requestedChildTrueMicroFamilyIds: selected.childTrueMicroFamilyIds,
    requestedMicroMicroFamilyIds: selected.microMicroFamilyIds,
    requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
    requestedIds: selected.requestedIds,

    resolvedMicroFamilyIds: resolved.microFamilyIds,
    resolvedTrueMicroFamilyIds: resolved.microFamilyIds,
    resolvedChildTrueMicroFamilyIds: resolved.childTrueMicroFamilyIds,
    resolvedMicroMicroFamilyIds: resolved.microMicroFamilyIds,
    resolvedMacroFamilyIds: [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: resolved.unresolvedMacroFamilyIds,
    macroExpansionDisabled: true,
    parentExpansionDisabled: true,

    acceptedIds: resolved.microFamilyIds,
    ignoredRequestedIds: [
      ...selected.ignoredRequestedIds,
      ...(Array.isArray(activation?.ignoredRequestedIds)
        ? activation.ignoredRequestedIds
        : [])
    ],

    activeRotation: active,
    active,

    activatedCount: active?.activeMicroFamilyIds?.length || 0,
    activatedMicroCount: active?.activeMicroFamilyIds?.length || 0,
    activatedChildTrueMicroCount: active?.childTrueMicroFamilyIds?.length || 0,
    activatedMicroMicroCount: active?.microMicroFamilyIds?.length || 0,
    activatedMacroCount: 0,

    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: active?.childTrueMicroFamilyIds || [],
    activeMicroMicroFamilyIds: active?.microMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    bestShort: active?.bestShort || null,
    bestLong: null,

    discordEntryAlertsEnabledForSelectedMicroFamiliesOnly:
      (active?.activeMicroFamilyIds || []).length > 0,

    noSelectionMeansNoDiscord:
      (active?.activeMicroFamilyIds || []).length === 0,

    rawActivation: activation,

    perf: {
      durationMs: now() - startedAt,
      source: 'activateSelectedShortExactMicroMicroOr75Child_manual_only_exact_match'
    },

    serverTs: Date.now()
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'short-only-manual-selection-exact-micro-micro-or-75-child-v1');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Micro-Micro-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Selectable-Child-Micro-Families', '75');
  res.setHeader('X-Selectable-Micro-Micro-Families', 'dynamic');
  res.setHeader('X-Parent-Micro-Families', '15');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_OR_75_CHILD_ONLY');
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}