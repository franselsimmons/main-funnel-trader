// ================= FILE: api/admin/rotation.js =================
//
// SHORT-only admin rotation endpoint.
//
// Doel:
// - Alleen exacte SHORT micro-micro IDs zijn selecteerbaar voor Discord.
// - Parent 15 blijft metadata/context.
// - 75-child blijft context/rollup en is niet selecteerbaar.
// - Geen macro/parent expansion.
// - Geen auto-rotation.
// - Alleen manual Discord selectie.
// - SHORT-only, virtual-only, geen real orders.
//
// Selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
// - MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_{CONTEXT_TAGS} wordt genormaliseerd naar canonical MICRO_SHORT_..._MM_{HASH}
//
// Niet selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - scanner fingerprints
// - raw XR execution fingerprints
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

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING = 35;
const MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES = 2;

const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const TRUE_MICRO_SCHEMA = CHILD_TRUE_MICRO_SCHEMA;

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const MICRO_MICRO_MARKER = '_MM_';
const MICRO_MICRO_HASH_LEN = 10;
const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V1';

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const POSITION_COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V11';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V3';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MICRO_MICRO_ONLY_V3';

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

const SETUP_SET = new Set(SETUP_ORDER);

const ALLOWED_ACTIONS = [
  'activateSelected',
  'activateSelectedMicroFamilies'
];

const BLOCKED_AUTO_ACTIONS = new Set([
  'activateSelectedMacroFamilies',
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
  'adaptive',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed',
  'cost',
  'currentFit'
]);

const DEFAULT_AVAILABLE_LIMIT = 120;
const MAX_AVAILABLE_LIMIT = 500;
const DEFAULT_ACTIVE_ROWS_LIMIT = 160;
const MAX_ACTIVE_ROWS_LIMIT = 500;

function now() {
  return Date.now();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : 0;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, num(value, min)));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function isTrue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = lower(value);
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

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length > 0) {
    const value = stack.shift();
    if (Array.isArray(value)) stack.unshift(...value);
    else output.push(value);
  }

  return output;
}

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value.split(/[\s,;\n\r]+/g).map((part) => part.trim());
        }
        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function uniqueWarnings(values = []) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function firstFiniteNumber(values = []) {
  for (const value of flattenValues(values)) {
    if (!hasValue(value)) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
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

function stableHash10(input = '') {
  const text = String(input || '').trim();
  if (!text) return '';

  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const tail = String(text.length).toString(16).toUpperCase().padStart(2, '0');

  return `${hex}${tail}`.slice(0, MICRO_MICRO_HASH_LEN);
}

function normalizeMicroMicroHash(value = '') {
  const raw = upper(value).replace(/[^A-Z0-9]/g, '');
  if (raw.length >= 3) return raw.slice(0, MICRO_MICRO_HASH_LEN);
  return '';
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
    observationAlwaysCounted: true,
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
    currentFitCanBlockDiscordOnly: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    rawExecutionFingerprintsNotSelectable: true,
    rawXrExecutionIdsRejected: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesIncludedOnlyInsideMicroMicroId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    fixedTaxonomyPreferred: true,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75ContextFamilyCount: 75,
    selectableChildMicroFamilyCount: 0,
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75FamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
    selectableMicroMicroRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
    selectableIdsAreMicroMicroOnly: true,
    selectableIdsAreChildOrMicroMicroOnly: false,
    child75Selectable: false,
    microMicroPreferredAfterSampleTier: false,
    parentIdsAreMetadataOnly: true,
    child75IdsAreContextOnly: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    manualSelectionMustUseExactMicroMicroId: true,
    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    child75ActivationDisabled: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    child75MatchDoesNotTriggerDiscord: true,
    scannerMatchDoesNotTriggerDiscord: true,
    executionFingerprintMatchDoesNotTriggerDiscord: true,

    persistentLearningOnly: true,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKeyIgnored: true,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForMicroMicroActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    statusRules: {
      MICRO_MICRO_OBSERVING: 'completed == 0',
      MICRO_MICRO_EARLY: `completed > 0 && completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING}`,
      MICRO_MICRO_ACTIVE: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING}`
    },

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
  };
}

function taxonomyMeta() {
  return {
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75ContextFamilyCount: 75,
    selectableChildMicroFamilyCount: 0,
    selectableMicroMicroCount: 'DYNAMIC_PER_75_CHILD',

    setups: SETUP_ORDER,
    regimes: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER,

    parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75ContextFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableMicroMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
    alternateInputAccepted: 'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}',

    exampleParentRejected: 'MICRO_SHORT_BREAKOUT_TREND',
    exampleChild75Rejected: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
    exampleSelectableMicroMicro: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_MM_AB12CD34EF',
    exampleAlternateInput: 'MM_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_OB_STRONG_RR_GOOD',

    selectableIdsAreMicroMicroOnly: true,
    child75IdsAreContextOnly: true,
    parentIdsAreMetadataOnly: true
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

function isCanonicalMicroMicroId(id = '') {
  return /^MICRO_SHORT_.+_MM_[A-Z0-9]{3,24}$/u.test(upper(id));
}

function isAlternateMicroMicroId(id = '') {
  return upper(id).startsWith('MM_SHORT_');
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);
  if (isCanonicalMicroMicroId(value) || isAlternateMicroMicroId(value)) return false;
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

function invalidParsed(rawId = '') {
  return {
    valid: false,
    selectable: false,
    selectableForDiscord: false,
    isParent: false,
    isChild: false,
    isBaseChild: false,
    isMicroMicro: false,
    rawId,
    id: null,
    key: null,
    setup: null,
    regime: null,
    setupType: null,
    regimeBucket: null,
    confirmationProfile: null,
    microMicroContext: '',
    microMicroHash: null,
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    base75ChildTrueMicroFamilyId: null,
    trueMicroFamilyId: null,
    microMicroFamilyId: null,
    trueMicroMicroFamilyId: null,
    exactMicroMicroFamilyId: null,
    learningLayer: 'UNKNOWN',
    selectionLayer: 'UNKNOWN'
  };
}

function parseBodySetupRegimeConfirmation(body = '') {
  const cleanBody = upper(body).replace(/^_+|_+$/g, '');

  for (const regime of REGIME_ORDER) {
    const marker = `_${regime}`;
    const idx = cleanBody.indexOf(marker);
    if (idx < 0) continue;

    const setup = cleanBody.slice(0, idx);
    const rest = cleanBody.slice(idx + marker.length).replace(/^_+/, '');

    if (!SETUP_SET.has(setup)) continue;

    if (!rest) {
      return { ok: true, setup, regime, confirmationProfile: null, rest: '' };
    }

    for (const profile of CONFIRMATION_PROFILE_ORDER) {
      if (rest === profile) {
        return { ok: true, setup, regime, confirmationProfile: profile, rest: '' };
      }

      if (rest.startsWith(`${profile}_`)) {
        return {
          ok: true,
          setup,
          regime,
          confirmationProfile: profile,
          rest: rest.slice(profile.length + 1)
        };
      }
    }
  }

  return { ok: false, setup: null, regime: null, confirmationProfile: null, rest: '' };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value || isScannerFingerprintId(value) || isExecutionFingerprintId(value)) {
    return invalidParsed(rawId);
  }

  if (value.includes('_MF_V1_') || value.includes('_MF_V2_') || value.includes('_MF_V3_')) {
    return invalidParsed(rawId);
  }

  let body = '';
  let explicitMicroMicro = false;
  let context = '';

  if (value.startsWith('MM_SHORT_')) {
    body = value.slice('MM_SHORT_'.length);
    explicitMicroMicro = true;
  } else if (value.startsWith('MICRO_SHORT_')) {
    body = value.slice('MICRO_SHORT_'.length);
    const markerIndex = body.lastIndexOf(MICRO_MICRO_MARKER);
    if (markerIndex > -1) {
      explicitMicroMicro = true;
      context = body.slice(markerIndex + MICRO_MICRO_MARKER.length);
      body = body.slice(0, markerIndex);
    }
  } else {
    return invalidParsed(rawId);
  }

  const parsed = parseBodySetupRegimeConfirmation(body);
  if (!parsed.ok) return invalidParsed(rawId);

  if (explicitMicroMicro && !context && parsed.rest) context = parsed.rest;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setup}_${parsed.regime}`;
  const childTrueMicroFamilyId = parsed.confirmationProfile
    ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}`
    : null;

  const isParent = !parsed.confirmationProfile;
  const isChild = Boolean(parsed.confirmationProfile && !explicitMicroMicro && !parsed.rest);
  const isMicroMicro = Boolean(parsed.confirmationProfile && (explicitMicroMicro || parsed.rest));

  const microMicroHash = isMicroMicro
    ? normalizeMicroMicroHash(context || parsed.rest || stableHash10(value)) || stableHash10(value)
    : null;

  const microMicroFamilyId = isMicroMicro
    ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`
    : null;

  const trueMicroFamilyId = microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId;

  return {
    valid: true,
    selectable: isMicroMicro,
    selectableForDiscord: isMicroMicro,
    isParent,
    isChild,
    isBaseChild: Boolean(childTrueMicroFamilyId),
    isMicroMicro,
    rawId,
    id: trueMicroFamilyId,
    key: trueMicroFamilyId,
    setup: parsed.setup,
    regime: parsed.regime,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroContext: context || parsed.rest || '',
    microMicroHash,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : isChild ? TRUE_MICRO_SCHEMA : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : isChild ? TRUE_MICRO_SCHEMA : PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningLayer: isMicroMicro ? 'MICRO_MICRO' : isChild ? 'CHILD_75_CONTEXT' : isParent ? 'PARENT_15_CONTEXT' : 'UNKNOWN',
    selectionLayer: isMicroMicro ? 'MICRO_MICRO' : 'NOT_SELECTABLE',
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : isChild ? CHILD75_LEARNING_GRANULARITY : PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: isMicroMicro ? 'EXACT_MICRO_MICRO_ONLY' : 'NOT_SELECTABLE'
  };
}

function isFixedShortParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedShortChild75Id(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isFixedShortMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function validLearningId(id = '') {
  const value = String(id || '').trim();
  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;
  return parseShortTaxonomyMicroId(value).valid === true;
}

function isSelectableMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.selectable === true && parsed.isMicroMicro === true;
}

function firstParsed(values = [], predicate = () => true) {
  for (const value of flattenValues(values)) {
    const parsed = parseShortTaxonomyMicroId(value);
    if (parsed.valid && predicate(parsed)) return parsed;
  }
  return null;
}

function getExplicitMicroMicroId(row = {}) {
  if (typeof row === 'string') return firstParsed([row], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;

  return firstParsed([
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.executionMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key
  ], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
}

function getBase75ChildTrueMicroFamilyId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback], (parsed) => parsed.isBaseChild)?.base75ChildTrueMicroFamilyId || null;
  }

  return firstParsed([
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], (parsed) => parsed.isBaseChild)?.base75ChildTrueMicroFamilyId || null;
}

function getParentTrueMicroFamilyId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback])?.parentTrueMicroFamilyId || null;
  }

  return firstParsed([
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.familyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ])?.parentTrueMicroFamilyId || null;
}

function microMicroContextParts(row = {}) {
  return uniqueStrings([
    row.microMicroHash,
    row.microMicroContextHash,
    row.executionContextHash,
    row.executionContextId,
    row.entryTimingBucket,
    row.entryTiming,
    row.entryTimingClass,
    row.entryQualityBucket,
    row.entryQualityClass,
    row.spreadBucket,
    row.spreadClass,
    row.depthBucket,
    row.liquidityBucket,
    row.btcFit,
    row.btcFitBucket,
    row.btcContext,
    row.btcState,
    row.btcRelation,
    row.riskShape,
    row.riskShapeBucket,
    row.riskBucket,
    row.rrBucket,
    row.stopDistanceBucket,
    row.volatilityBucket,
    row.orderbookBucket,
    row.obRelation,
    row.flow,
    row.flowCoarse,
    row.regime,
    row.regimeCoarse,
    row.rsiZone,
    row.rsiCoarse,
    row.currentFit,
    row.currentFitLabel,
    row.executionFingerprintHash,
    ...(Array.isArray(row.microMicroContextParts) ? row.microMicroContextParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ])
    .map(upper)
    .filter(Boolean)
    .filter((part) => !part.includes('FIRST_MOVE'))
    .filter((part) => !part.includes('AFTER_OPEN'));
}

function buildMicroMicroFamilyId(baseChildId = '', row = {}, { allowChildProxy = true } = {}) {
  const child = parseShortTaxonomyMicroId(baseChildId);
  if (!child.isBaseChild) return null;

  const explicit = getExplicitMicroMicroId(row);
  if (explicit) {
    const parsedExplicit = parseShortTaxonomyMicroId(explicit);
    if (parsedExplicit.isMicroMicro && parsedExplicit.base75ChildTrueMicroFamilyId === child.base75ChildTrueMicroFamilyId) {
      return parsedExplicit.trueMicroFamilyId;
    }
  }

  const explicitHash = normalizeMicroMicroHash(
    row.microMicroHash ||
      row.microMicroContextHash ||
      row.executionContextHash ||
      row.executionFingerprintHash ||
      ''
  );

  if (explicitHash) return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${explicitHash}`;

  const parts = microMicroContextParts(row);
  if (parts.length > 0) return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(parts.join('|'))}`;

  if (allowChildProxy) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(`${child.base75ChildTrueMicroFamilyId}|DEFAULT_ENTRY_CONTEXT_PENDING`)}`;
  }

  return null;
}

function getMicroMicroId(row = {}, fallback = null, options = {}) {
  const explicit = getExplicitMicroMicroId(row);
  if (explicit) return explicit;

  const childId = getBase75ChildTrueMicroFamilyId(row, fallback);
  return buildMicroMicroFamilyId(childId, row, options);
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
    ...getArray(row.executionFingerprintParts),
    ...getArray(row.microMicroContextParts)
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

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    if (parseShortTaxonomyMicroId(input).valid) return TARGET_TRADE_SIDE;

    const value = cleanSideText(input);
    if (value.includes('MICRO_LONG_') || value.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('MICRO_SHORT_') || value.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (value.includes('LONG') || value.includes('BULL') || value.includes('BUY')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('SHORT') || value.includes('BEAR') || value.includes('SELL')) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  for (const source of [
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
  ]) {
    const side = normalizeDirectSide(source);
    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const idText = cleanSideText([
    input.microMicroFamilyId,
    input.trueMicroMicroFamilyId,
    input.exactMicroMicroFamilyId,
    input.trueMicroFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.base75ChildTrueMicroFamilyId,
    input.microFamilyId,
    input.parentTrueMicroFamilyId,
    input.coarseMicroFamilyId,
    input.id,
    input.key
  ].filter(Boolean).join(' | '));

  if (parseShortTaxonomyMicroId(idText).valid || idText.includes('MICRO_SHORT_') || idText.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
  if (idText.includes('MICRO_LONG_') || idText.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;

  const definition = definitionHaystack(input);
  if (definition.includes('MICRO_SHORT_') || definition.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
  if (definition.includes('MICRO_LONG_') || definition.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isSelectableMicroMicroRow(row = {}) {
  const id = getMicroMicroId(row, row.key, { allowChildProxy: false }) || row.trueMicroFamilyId || row.microFamilyId;
  if (!id || !isSelectableMicroMicroId(id)) return false;
  if (!isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id })) return false;
  return true;
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.microFamilyId || String(index),
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
    'shadowTotalR',
    'virtualTotalCostR',
    'shadowTotalCostR'
  ].some((key) => hasValue(row[key]));
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

  const denominator = Number.isFinite(entry) && Number.isFinite(initialSl)
    ? initialSl - entry
    : 0;

  const validGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(initialSl) &&
    Number.isFinite(tp) &&
    denominator > 0 &&
    tp < entry &&
    entry < initialSl;

  const shortGrossR = validGeometry && Number.isFinite(exitPrice)
    ? (entry - exitPrice) / denominator
    : null;

  const shortCurrentR = validGeometry && Number.isFinite(currentPrice)
    ? (entry - currentPrice) / denominator
    : null;

  const shortTpHit = validGeometry && (
    row.shortTpHit === true ||
    row.tpHit === true ||
    (Number.isFinite(exitPrice) && exitPrice <= tp) ||
    (Number.isFinite(currentPrice) && currentPrice <= tp)
  );

  const shortSlHit = validGeometry && (
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

  return num(row.netR ?? row.exitR ?? row.realizedNetR ?? row.realizedR ?? row.r, 0);
}

function isLearningOutcomeSource(source = '') {
  const value = upper(source || 'VIRTUAL');
  return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value === '';
}

function aggregateRecentOutcomes(row = {}) {
  const outcomes = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];

  return outcomes.reduce((acc, outcome) => {
    if (!outcome || typeof outcome !== 'object') return acc;
    if (!isLearningOutcomeSource(outcome.source || outcome.outcomeSource || 'VIRTUAL')) return acc;
    if (!isShortRow({ ...row, ...outcome })) return acc;

    const netR = outcomeNetR(outcome);
    const costR = Math.max(0, num(outcome.costR ?? outcome.avgCostR, 0));

    acc.completed += 1;
    acc.totalR += netR;
    acc.totalCostR += costR;

    if (netR > 0) {
      acc.wins += 1;
      acc.grossWinR += netR;
    } else if (netR < 0) {
      acc.losses += 1;
      acc.grossLossR += Math.abs(netR);
    } else {
      acc.flats += 1;
    }

    if (
      outcome.directSL ||
      outcome.directToSL ||
      outcome.directStopLoss ||
      outcome.isDirectSL ||
      upper(outcome.exitReason) === 'SL'
    ) {
      acc.directSLCount += 1;
    }

    return acc;
  }, {
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    totalCostR: 0,
    grossWinR: 0,
    grossLossR: 0,
    directSLCount: 0
  });
}

function outcomeCounts(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  const sourceWins = num(row.virtualWins, 0) + num(row.shadowWins, 0);
  const sourceLosses = num(row.virtualLosses, 0) + num(row.shadowLosses, 0);
  const sourceFlats = num(row.virtualFlats, 0) + num(row.shadowFlats, 0);

  const wins = sourceWins > 0 ? sourceWins : num(row.wins, 0);
  const losses = sourceLosses > 0 ? sourceLosses : num(row.losses, 0);
  const flats = sourceFlats > 0 ? sourceFlats : num(row.flats, 0);

  const virtualShadowCompleted = num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0);
  const aggregateCompleted = Math.max(num(row.completed, 0), num(row.outcomeSample, 0), 0);
  const countedTotal = wins + losses + flats;

  if (virtualShadowCompleted <= 0 && aggregateCompleted <= 0 && countedTotal <= 0 && recent.completed > 0) {
    return {
      wins: recent.wins,
      losses: recent.losses,
      flats: recent.flats,
      total: recent.completed
    };
  }

  const total = Math.max(countedTotal, virtualShadowCompleted, aggregateCompleted, recent.completed, 0);

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, total - wins - losses)),
    total
  };
}

function completedSample(row = {}) {
  return outcomeCounts(row).total;
}

function observationSample(row = {}) {
  return Math.max(
    num(row.observationSample, 0),
    num(row.seen, 0),
    num(row.observations, 0),
    completedSample(row),
    0
  );
}

function totalR(row = {}) {
  const completed = completedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;
  if (recent.completed > 0) return recent.totalR;

  return num(row.shortNetTotalR ?? row.netShortTotalR ?? row.netTotalR ?? row.totalNetR ?? row.totalR, 0);
}

function avgR(row = {}) {
  const completed = completedSample(row);
  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR) && !hasVirtualShadowOutcomeFields(row)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR) && !hasVirtualShadowOutcomeFields(row)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR) && !hasVirtualShadowOutcomeFields(row)) return num(row.avgR, 0);

  return totalR(row) / completed;
}

function totalCostR(row = {}) {
  const completed = completedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowCost = Math.max(0, num(row.virtualTotalCostR, 0)) + Math.max(0, num(row.shadowTotalCostR, 0));
  if (virtualShadowCost > 0) return virtualShadowCost;
  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;

  if (hasValue(row.totalCostR)) return Math.max(0, num(row.totalCostR, 0));
  if (hasValue(row.totalNetCostR)) return Math.max(0, num(row.totalNetCostR, 0));

  for (const key of ['avgCostR', 'costR', 'netCostR', 'estimatedCostR']) {
    if (hasValue(row[key]) && num(row[key], 0) > 0) {
      return Math.max(0, num(row[key], 0)) * completed;
    }
  }

  return 0;
}

function avgCostR(row = {}) {
  const completed = completedSample(row);
  if (completed <= 0) return 0;
  return totalCostR(row) / completed;
}

function directSLCount(row = {}) {
  const sourceCount = num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0);
  if (sourceCount > 0) return sourceCount;
  if (hasValue(row.directSLCount)) return num(row.directSLCount, 0);
  return aggregateRecentOutcomes(row).directSLCount;
}

function directSLPct(row = {}) {
  const completed = completedSample(row);
  if (completed <= 0) return 0;
  return clamp(directSLCount(row) / completed, 0, 1);
}

function profitFactor(row = {}) {
  if (hasValue(row.netProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.profitFactor, 0);

  const recent = aggregateRecentOutcomes(row);
  let winR = recent.grossWinR;
  let lossR = recent.grossLossR;

  if (winR <= 0) {
    winR = Math.max(
      num(row.virtualWinR, 0) + num(row.shadowWinR, 0),
      num(row.netWinR, 0),
      num(row.totalWinR, 0),
      num(row.grossWinR, 0),
      0
    );
  }

  if (lossR <= 0) {
    lossR = Math.max(
      Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)),
      Math.abs(num(row.netLossR, 0)),
      Math.abs(num(row.totalLossR, 0)),
      Math.abs(num(row.grossLossR, 0)),
      0
    );
  }

  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 99 : 0;

  return winR / lossR;
}

function wilsonLowerBound(successes, trials, z = 1.96) {
  const n = num(trials, 0);
  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function sampleReliability(sample, cap = 50) {
  const n = num(sample, 0);
  if (n <= 0) return 0;
  return clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1);
}

function sampleAdjustedWinrate(row = {}) {
  const counts = outcomeCounts(row);
  const completed = counts.total;
  const observed = observationSample(row);

  if (completed <= 0) {
    return {
      sample: observed,
      outcomeSample: 0,
      observationSample: observed,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(observed),
      score: 0,
      awaitingOutcomes: observed > 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / completed, 0, 1);
  const bayesianWinrate = clamp((successes + 1) / (completed + 2), 0, 1);
  const wilson = wilsonLowerBound(successes, completed);
  const reliability = sampleReliability(completed, 50);
  const score = clamp(wilson * 0.8 + bayesianWinrate * 0.15 + rawWinrate * 0.05, 0, 1);

  return {
    sample: completed,
    outcomeSample: completed,
    observationSample: observed,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score,
    awaitingOutcomes: false
  };
}

function balancedScore(row = {}, winrate = null) {
  const wr = winrate || sampleAdjustedWinrate(row);

  if (wr.outcomeSample <= 0 && wr.observationSample > 0) {
    return Math.min(45, Math.log1p(wr.observationSample) * 8 + wr.reliability * 18);
  }

  return (
    wr.score * 100 +
    wr.reliability * 20 +
    Math.log1p(Math.max(0, totalR(row))) * 12 +
    Math.log1p(Math.max(0, avgR(row))) * 8 +
    Math.log1p(Math.min(Math.max(0, profitFactor(row)), 20)) * 3 -
    directSLPct(row) * 60 -
    avgCostR(row) * 3
  );
}

function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
  const n = Number(score);
  if (!Number.isFinite(n)) return fallback || 'UNKNOWN';
  if (n >= 45) return 'FIT';
  if (n >= 20) return 'OK';
  if (n <= -20) return 'MISFIT';
  return 'NEUTRAL';
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
    .map(upper)
    .join(' | ');
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

  if (haystack.includes('BEAR') || haystack.includes('SHORT') || haystack.includes('SELL') || haystack.includes('DOWNSIDE')) {
    score = Math.abs(rawFit);
  } else if (haystack.includes('BULL') || haystack.includes('LONG') || haystack.includes('BUY') || haystack.includes('UPSIDE')) {
    score = -Math.abs(rawFit);
  } else {
    score = rawFit;
  }

  return {
    score,
    label: currentFitLabel(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
    source: 'SHORT_MIRRORED_GENERIC_CURRENT_FIT'
  };
}

function learningStatus(row = {}) {
  const completed = completedSample(row);
  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING) return 'MICRO_MICRO_ACTIVE';
  if (completed > 0) return 'MICRO_MICRO_EARLY';
  return 'MICRO_MICRO_OBSERVING';
}

function eligibilityTier(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);
  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING) return 'MICRO_MICRO';
  if (completed > 0) return 'MICRO_MICRO_SOFT';
  if (observed > 0) return 'OBSERVATION';
  return 'RAW';
}

function learningQualityRank(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);
  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING) return 4;
  if (completed > 0) return 2.5;
  if (observed > 0) return 1.2;
  return 0;
}

function cleanMeasurementScore(row = {}) {
  const fix = row.measurementFixVersion || row.measurementVersion || row.positionMeasurementFixVersion || '';
  const cost = row.costModelVersion || row.positionCostModelVersion || '';
  const obs = row.observationDedupeVersion || row.obsDedupeVersion || '';
  const out = row.outcomeDedupeVersion || row.outcomeDeduplicationVersion || '';

  if (row.measurementClean === true || row.cleanMeasurement === true || row.cleanLearningRow === true) return 1;

  const fixOk = !fix || fix === MEASUREMENT_FIX_VERSION || String(fix).includes('CANDLE_FIRST_TOUCH');
  const costOk = !cost || cost === POSITION_COST_MODEL_VERSION;
  const obsOk = !obs || obs === OBSERVATION_DEDUPE_VERSION || String(obs).includes('OBS_DEDUPE');
  const outOk = !out || out === OUTCOME_DEDUPE_VERSION || String(out).includes('OUTCOME_DEDUPE');

  return fixOk && costOk && obsOk && outOk ? 1 : 0;
}

function normalizeRotationRow(row = {}, index = 0, activeSet = new Set()) {
  const id = getMicroMicroId(row, row.key, { allowChildProxy: true });
  if (!id || !isSelectableMicroMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);
  const rawSide = inferTradeSide({ ...row, microFamilyId: id, trueMicroFamilyId: id, microMicroFamilyId: id });
  if (rawSide === OPPOSITE_TRADE_SIDE) return null;

  const wr = sampleAdjustedWinrate(row);
  const risk = getShortRiskGeometry(row);
  const fit = getShortCurrentFit(row);
  const bScore = balancedScore(row, wr);
  const adaptiveScore = num(row.adaptiveScore ?? row.microMicroScore, bScore + fit.score * 0.15 + wr.reliability * 10 - directSLPct(row) * 10 - avgCostR(row) * 2);
  const completed = completedSample(row);
  const observed = observationSample(row);
  const tier = row.selectedTier || row.rotationEligibilityTier || eligibilityTier(row);

  return {
    rank: index + 1,

    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMicroFamilyId: parsed.parentTrueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroHash: parsed.microMicroHash,
    microMicroContext: parsed.microMicroContext,

    ...modeFlags(),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: true,
    selectableMicroMicroFamily: true,
    selectable75Child: false,
    selectableParent: false,

    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: 'MICRO_MICRO',
    selectionLayer: 'MICRO_MICRO',
    selectableLayer: 'MICRO_MICRO',
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    inferredTradeSide: rawSide === 'UNKNOWN' ? TARGET_TRADE_SIDE : rawSide,
    inferredFromShortOnlyMode: rawSide === 'UNKNOWN',

    schema: row.schema || row.microFamilySchema || MICRO_MICRO_SCHEMA,
    microFamilySchema: row.microFamilySchema || row.schema || MICRO_MICRO_SCHEMA,
    version: row.version || null,

    isTrueMicro: true,
    isChildTrueMicro: false,
    isMicroMicro: true,
    isBase75Child: false,
    isLegacyMacro: false,

    active: Boolean(row.active || activeSet.has(id)),
    macroActive: Boolean(row.macroActive),

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

    tooEarly: completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    tooEarlyReason: completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING
      ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING}`
      : null,

    minCompletedForActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,
    microMicroMinCompletedForActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,

    wins: round(wr.wins, 4),
    losses: round(wr.losses, 4),
    flats: round(wr.flats, 4),

    virtualWins: round(row.virtualWins, 4),
    virtualLosses: round(row.virtualLosses, 4),
    virtualFlats: round(row.virtualFlats, 4),
    shadowWins: round(row.shadowWins, 4),
    shadowLosses: round(row.shadowLosses, 4),
    shadowFlats: round(row.shadowFlats, 4),
    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: round(wr.rawWinrate, 4),
    bayesianWinrate: round(wr.bayesianWinrate, 4),
    wilsonLowerBound: round(wr.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? wr.score, 4),
    winrateSample: round(wr.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? wr.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? wr.reliability, 4),

    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),
    virtualTotalR: round(row.virtualTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),
    realTotalR: 0,

    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),
    profitFactor: round(profitFactor(row), 4),

    directSLCount: round(directSLCount(row), 4),
    directSLPct: round(directSLPct(row), 4),
    nearTpPct: round(row.nearTpPct, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),
    beWouldExitPct: round(row.beWouldExitPct, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(totalCostR(row), 4),
    avgCostR: round(avgCostR(row), 4),

    balancedScore: round(row.balancedScore ?? bScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? bScore, 4),
    adaptiveScore: round(adaptiveScore, 4),

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
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksDiscord: fit.label === 'MISFIT',
    discordCurrentFitAllowed: fit.label !== 'MISFIT',

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
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts) ? row.scannerDefinitionParts : [],
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || parsed.microMicroHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    definitionParts: [
      ...getArray(row.definitionParts),
      ...getArray(row.microDefinitionParts),
      ...getArray(row.microMicroDefinitionParts)
    ],
    definition: row.definition || row.microDefinition || '',
    microDefinition: row.microDefinition || row.definition || '',
    microMicroDefinition: row.microMicroDefinition || '',
    microMicroDefinitionParts: Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : microMicroContextParts(row),

    macroDefinitionParts: Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : getArray(row.parentDefinitionParts),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    persistentLearningOnly: true,
    requestedWeekKeyIgnored: true,

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    costModelVersion: row.costModelVersion || row.positionCostModelVersion || POSITION_COST_MODEL_VERSION,
    measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: row.observationDedupeVersion || OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: row.outcomeDedupeVersion || OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: row.adaptiveUiVersion || ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function compareRows(a = {}, b = {}) {
  return (
    cleanMeasurementScore(b) - cleanMeasurementScore(a) ||
    learningQualityRank(b) - learningQualityRank(a) ||
    num(b.outcomeSample ?? completedSample(b), 0) - num(a.outcomeSample ?? completedSample(a), 0) ||
    num(b.adaptiveScore, 0) - num(a.adaptiveScore, 0) ||
    num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
    num(b.balancedScore, 0) - num(a.balancedScore, 0) ||
    num(b.fairWinrate, 0) - num(a.fairWinrate, 0) ||
    num(b.totalR, 0) - num(a.totalR, 0) ||
    num(b.avgR, 0) - num(a.avgR, 0) ||
    num(b.profitFactor, 0) - num(a.profitFactor, 0) ||
    num(b.currentFitScore, 0) - num(a.currentFitScore, 0) ||
    num(a.directSLPct, 0) - num(b.directSLPct, 0) ||
    num(a.avgCostR, 0) - num(b.avgCostR, 0) ||
    num(b.observationSample, 0) - num(a.observationSample, 0) ||
    String(a.trueMicroFamilyId || a.microFamilyId || '').localeCompare(String(b.trueMicroFamilyId || b.microFamilyId || ''))
  );
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    const key = row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.microFamilyId;
    if (!key || seen.has(key)) continue;
    if (!isShortRow(row)) continue;
    if (!isSelectableMicroMicroRow(row)) continue;
    seen.add(key);
    output.push(row);
  }

  return output;
}

function buildAvailableRowsFromMicros(micros = {}, activeSet = new Set()) {
  const rows = [];

  for (const [key, row] of sourceEntries(micros)) {
    if (!row || typeof row !== 'object') continue;

    const microMicroId = getMicroMicroId({ ...row, key }, key, { allowChildProxy: true });
    if (!microMicroId || !isSelectableMicroMicroId(microMicroId)) continue;

    const normalized = normalizeRotationRow({
      ...row,
      key,
      id: microMicroId,
      microFamilyId: microMicroId,
      trueMicroFamilyId: microMicroId,
      analyzeMicroFamilyId: microMicroId,
      learningMicroFamilyId: microMicroId,
      microMicroFamilyId: microMicroId,
      trueMicroMicroFamilyId: microMicroId,
      exactMicroMicroFamilyId: microMicroId,
      generatedMicroMicroFromChild75: !getExplicitMicroMicroId(row),
      microMicroContextFallback: microMicroContextParts(row).length === 0,
      microMicroStatsSource: getExplicitMicroMicroId(row)
        ? 'EXPLICIT_MICRO_MICRO_ROW'
        : 'CHILD75_CONTEXT_PROXY_FOR_SELECTION_DISPLAY',
      sourceWeekKey: PERSISTENT_LEARNING_KEY,
      sourceWeekPrimary: true,
      active: activeSet.has(microMicroId)
    }, rows.length, activeSet);

    if (normalized) rows.push(normalized);
  }

  return dedupeRows(rows).sort(compareRows);
}

async function loadAvailableRows({ weekKey, limit = DEFAULT_AVAILABLE_LIMIT, activeSet = new Set() } = {}) {
  const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
  const current = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));
  const rows = buildAvailableRowsFromMicros(current || {}, activeSet).slice(0, limit);

  return {
    requestedWeekKey,
    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningOnly: true,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
    currentRows: sourceEntries(current).length,
    previousRows: 0,
    mergedRows: rows.length,
    rows
  };
}

function normalizeActiveRotationObject(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;
  return rotation.activeRotation || rotation.active || rotation.rotation || rotation;
}

function extractIdsFromRotation(rotation = {}) {
  const activeRotation = normalizeActiveRotationObject(rotation) || {};
  const rows = Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : [];

  return uniqueStrings([
    activeRotation.microMicroFamilyIds || [],
    activeRotation.trueMicroMicroFamilyIds || [],
    activeRotation.exactMicroMicroFamilyIds || [],
    activeRotation.activeMicroMicroFamilyIds || [],
    activeRotation.activeTrueMicroMicroFamilyIds || [],
    activeRotation.selectedMicroMicroFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    rows.map((row) => getMicroMicroId(row, row?.key, { allowChildProxy: false }))
  ])
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractLegacyActiveChild75Ids(rotation = {}) {
  const activeRotation = normalizeActiveRotationObject(rotation) || {};
  const rows = Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : [];

  return uniqueStrings([
    activeRotation.childTrueMicroFamilyIds || [],
    activeRotation.active75ChildFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    rows.map((row) => row?.childTrueMicroFamilyId || row?.base75ChildTrueMicroFamilyId || row?.trueMicroFamilyId)
  ]).filter(isFixedShortChild75Id);
}

function extractParentIdsFromIds(ids = []) {
  return uniqueStrings(
    ids
      .map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
      .filter(Boolean)
  ).filter(isFixedShortParentMicroId);
}

function manualActiveRowFromId(id, index = 0, activeSet = new Set()) {
  if (!id || !isSelectableMicroMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  return normalizeRotationRow({
    id: parsed.trueMicroFamilyId,
    key: parsed.trueMicroFamilyId,
    microFamilyId: parsed.trueMicroFamilyId,
    trueMicroFamilyId: parsed.trueMicroFamilyId,
    analyzeMicroFamilyId: parsed.trueMicroFamilyId,
    learningMicroFamilyId: parsed.trueMicroFamilyId,
    microMicroFamilyId: parsed.trueMicroFamilyId,
    trueMicroMicroFamilyId: parsed.trueMicroFamilyId,
    exactMicroMicroFamilyId: parsed.trueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    trueMicro: true,
    isTrueMicro: true,
    isMicroMicro: true,
    active: true,
    fixedTaxonomyLearningId: true,
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
    avgCostR: 0,
    microMicroStatsSource: 'MANUAL_ACTIVE_MICRO_MICRO_ID'
  }, index, activeSet);
}

function compactActiveRotation(rotation = null) {
  const activeRotation = normalizeActiveRotationObject(rotation);
  if (!activeRotation || typeof activeRotation !== 'object') {
    return {
      rotationId: null,
      ...modeFlags(),
      taxonomy: taxonomyMeta(),
      manualOnly: true,
      adminSelected: false,
      autoRotation: false,
      liveSelectable: false,
      empty: true,
      emptyReason: 'NO_MANUAL_SHORT_EXACT_MICRO_MICRO_SELECTION_ACTIVE',
      microFamilyIds: [],
      activeMicroFamilyIds: [],
      trueMicroFamilyIds: [],
      microMicroFamilyIds: [],
      trueMicroMicroFamilyIds: [],
      exactMicroMicroFamilyIds: [],
      activeMicroMicroFamilyIds: [],
      childTrueMicroFamilyIds: [],
      legacyChild75ActiveIdsIgnored: [],
      macroFamilyIds: [],
      activeMacroFamilyIds: [],
      microFamilies: [],
      count: 0,
      activeCount: 0,
      activeMicroMicroCount: 0,
      bestShort: null,
      bestLong: null,
      missingSides: [TARGET_TRADE_SIDE]
    };
  }

  const activeMicroMicroFamilyIds = extractIdsFromRotation(activeRotation);
  const activeParentIds = extractParentIdsFromIds(activeMicroMicroFamilyIds);
  const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotation);
  const activeSet = new Set(activeMicroMicroFamilyIds);

  const rows = [];
  const existing = new Set();

  if (Array.isArray(activeRotation.microFamilies)) {
    for (const row of activeRotation.microFamilies) {
      const id = getMicroMicroId(row, row?.key, { allowChildProxy: false });
      if (!id || !activeSet.has(id) || existing.has(id)) continue;
      const normalized = normalizeRotationRow({ ...row, active: true }, rows.length, activeSet);
      if (!normalized) continue;
      rows.push(normalized);
      existing.add(id);
    }
  }

  for (const id of activeMicroMicroFamilyIds) {
    if (existing.has(id)) continue;
    const manualRow = manualActiveRowFromId(id, rows.length, activeSet);
    if (!manualRow) continue;
    rows.push(manualRow);
    existing.add(id);
  }

  rows.sort(compareRows);

  return {
    rotationId: activeRotation.rotationId || null,
    source: activeRotation.source || null,
    mode: activeRotation.mode || null,
    sourceWeekKey: activeRotation.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    activeWeekKey: activeRotation.activeWeekKey || PERSISTENT_LEARNING_KEY,
    generatedAt: activeRotation.generatedAt || null,
    activatedAt: activeRotation.activatedAt || null,

    ...modeFlags(),
    taxonomy: taxonomyMeta(),

    manualOnly: true,
    adminSelected: Boolean(activeRotation.adminSelected || activeRotation.manualOnly || activeMicroMicroFamilyIds.length),
    autoRotation: false,
    liveSelectable: activeMicroMicroFamilyIds.length > 0,

    empty: activeMicroMicroFamilyIds.length === 0,
    emptyReason: activeMicroMicroFamilyIds.length === 0
      ? 'NO_MANUAL_SHORT_EXACT_MICRO_MICRO_SELECTION_ACTIVE'
      : null,

    microFamilyIds: activeMicroMicroFamilyIds,
    activeMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroFamilyIds: activeMicroMicroFamilyIds,
    microMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    exactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    activeMicroMicroFamilyIds,
    selectedMicroMicroFamilyIds: activeMicroMicroFamilyIds,

    childTrueMicroFamilyIds: uniqueStrings(
      activeMicroMicroFamilyIds
        .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
        .filter(Boolean)
    ),
    legacyChild75ActiveIdsIgnored,

    macroFamilyIds: activeParentIds,
    activeMacroFamilyIds: activeParentIds,
    parentTrueMicroFamilyIds: activeParentIds,

    microFamilies: rows,

    count: activeMicroMicroFamilyIds.length,
    activeCount: activeMicroMicroFamilyIds.length,
    activeMicroMicroCount: activeMicroMicroFamilyIds.length,
    activeChildTrueMicroCount: 0,

    bestShort: rows[0] || null,
    bestLong: null,
    missingSides: activeMicroMicroFamilyIds.length ? [] : [TARGET_TRADE_SIDE]
  };
}

function parseSelectedIds(body = {}) {
  const candidateIds = uniqueStrings([
    body.microMicroFamilyIds,
    body.trueMicroMicroFamilyIds,
    body.exactMicroMicroFamilyIds,
    body.activeMicroMicroFamilyIds,
    body.activeTrueMicroMicroFamilyIds,
    body.selectedMicroMicroFamilyIds,
    body.microMicroFamilyId,
    body.trueMicroMicroFamilyId,
    body.exactMicroMicroFamilyId,
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids,
    body.id,
    body.microFamilyId,
    body.trueMicroFamilyId
  ]);

  const macroFamilyIds = uniqueStrings([
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.macroFamilyId,
    body.parentTrueMicroFamilyId,
    body.parentMicroFamilyId
  ]);

  const requestedIds = uniqueStrings([candidateIds, macroFamilyIds]);
  const acceptedIds = uniqueStrings(
    candidateIds
      .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
      .filter(Boolean)
      .filter(isSelectableMicroMicroId)
  ).slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  const ignoredRequestedIds = requestedIds
    .filter((id) => !acceptedIds.includes(parseShortTaxonomyMicroId(id).trueMicroFamilyId))
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
            ? 'PARENT_OR_MACRO_ID_REJECTED_EXACT_MICRO_MICRO_REQUIRED'
            : isScannerFingerprintId(id)
              ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
              : isExecutionFingerprintId(id)
                ? 'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE_USE_NORMALIZED_MM_ID'
                : parsed.isChild
                  ? 'CHILD75_ID_REJECTED_EXACT_MICRO_MICRO_REQUIRED'
                  : parsed.valid && !parsed.selectable
                    ? 'NON_SELECTABLE_SHORT_TAXONOMY_ID_REJECTED_EXACT_MICRO_MICRO_REQUIRED'
                    : 'UNKNOWN_OR_NON_SELECTABLE_SHORT_MICRO_ID_REJECTED'
      };
    });

  return {
    requestedIds,
    acceptedIds,
    microFamilyIds: acceptedIds,
    trueMicroFamilyIds: acceptedIds,
    microMicroFamilyIds: acceptedIds,
    trueMicroMicroFamilyIds: acceptedIds,
    exactMicroMicroFamilyIds: acceptedIds,
    activeMicroMicroFamilyIds: acceptedIds,
    selectedMicroMicroFamilyIds: acceptedIds,
    childTrueMicroFamilyIds: uniqueStrings(
      acceptedIds
        .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
        .filter(Boolean)
    ),
    macroFamilyIds: [],
    requestedMacroFamilyIds: macroFamilyIds,
    ignoredRequestedIds,
    ignoredAboveLimitIds: uniqueStrings(
      candidateIds
        .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
        .filter(Boolean)
        .filter(isSelectableMicroMicroId)
    ).slice(MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES)
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
    acc.total += 1;
    acc[tier] = (acc[tier] || 0) + 1;
    acc.MICRO_MICRO += 1;
    return acc;
  }, {
    total: 0,
    MICRO_MICRO: 0,
    MICRO_MICRO_SOFT: 0,
    OBSERVATION: 0,
    RAW: 0
  });
}

function layerCounts(rows = []) {
  return {
    parent15: 0,
    child75: 0,
    microMicro: rows.filter((row) => isSelectableMicroMicroId(row.trueMicroFamilyId || row.microMicroFamilyId)).length,
    unknown: 0
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

async function handleGet(req, res) {
  const startedAt = now();

  const requestedWeekKey = String(firstValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY)).trim();
  const availableLimit = toLimit(firstValue(req.query?.availableLimit, DEFAULT_AVAILABLE_LIMIT), DEFAULT_AVAILABLE_LIMIT, MAX_AVAILABLE_LIMIT);
  const activeRowsLimit = toLimit(firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT), DEFAULT_ACTIVE_ROWS_LIMIT, MAX_ACTIVE_ROWS_LIMIT);
  const includeAvailable = isTrue(firstValue(req.query?.includeAvailable, true), true);

  const [dashboard, activeRotationRaw] = await Promise.all([
    getRotationDashboard({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      weekKey: PERSISTENT_LEARNING_KEY,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      microMicroOnly: true,
      selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
      trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
      child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
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
      microMicroOnly: true,
      selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
      trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
      child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
    }).catch(() => null)
  ]);

  const active = compactActiveRotation(activeRotationRaw);
  const activeSet = new Set(active.activeMicroMicroFamilyIds || []);

  const availableResult = includeAvailable
    ? await loadAvailableRows({ weekKey: requestedWeekKey, limit: availableLimit, activeSet }).catch((error) => ({
      requestedWeekKey,
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      previousWeekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningOnly: true,
      queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
      currentRows: 0,
      previousRows: 0,
      mergedRows: 0,
      rows: [],
      warning: error?.message || String(error)
    }))
    : {
      requestedWeekKey,
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      previousWeekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningOnly: true,
      queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
      currentRows: 0,
      previousRows: 0,
      mergedRows: 0,
      rows: []
    };

  const availableRows = availableResult.rows || [];
  const warnings = uniqueWarnings([
    availableResult.warning,
    availableResult.queryWeekKeyIgnored ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${availableResult.queryWeekKeyIgnored}` : null,
    (active.legacyChild75ActiveIdsIgnored || []).length > 0 ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED:${active.legacyChild75ActiveIdsIgnored.length}` : null,
    availableRows.length === 0 ? 'NO_AVAILABLE_MICRO_MICRO_ROWS' : null
  ]);

  return res.status(200).json({
    ok: true,
    fixed: true,

    ...modeFlags(),
    taxonomy: taxonomyMeta(),

    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKey,
    queryWeekKeyIgnored: availableResult.queryWeekKeyIgnored || null,
    persistentLearningOnly: true,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    activeRowsLimit,
    availableLimit,
    includeAvailable,
    includePrevious: false,

    activeRotation: active,
    active,

    activeRotationId: active?.rotationId || null,
    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: [],
    activeMicroMicroFamilyIds: active?.activeMicroMicroFamilyIds || [],
    selectedMicroMicroFamilyIds: active?.selectedMicroMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],
    legacyChild75ActiveIdsIgnored: active?.legacyChild75ActiveIdsIgnored || [],

    activeRows: (active?.microFamilies || []).slice(0, activeRowsLimit),
    activeCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activeMicroMicroCount: active?.activeMicroMicroFamilyIds?.length || 0,

    dashboard: dashboard || null,
    nextRotation: dashboard?.next || dashboard?.nextRotation || null,
    nextRotationStoredOnly: true,
    nextRotationAutoActivationDisabled: true,

    availableMicroFamilies: availableRows,
    availableRows,
    availableMicroMicroFamilies: availableRows,
    availableMicroMicroRows: availableRows,
    availableCount: availableRows.length,
    availableMicroMicroCount: availableRows.length,

    availableTierSummary: buildTierSummary(availableRows),
    availableLayerCounts: layerCounts(availableRows),

    sourceRows: {
      currentWeekRows: availableResult.currentRows,
      previousWeekRows: availableResult.previousRows,
      mergedRows: availableResult.mergedRows,
      persistentLearningOnly: true,
      warning: availableResult.warning || null
    },

    allowedActions: ALLOWED_ACTIONS,
    blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],

    buttons: {
      selectExact75Child: false,
      selectExactMicroMicro: true,
      selectParent15Disabled: true,
      copy: true,
      activateVisibleIdsForDiscord: true
    },

    warnings,
    error: null,

    perf: {
      durationMs: now() - startedAt,
      source: 'short_manual_selection_exact_micro_micro_only_rotation_dashboard'
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
      reason: 'AUTO_ROTATION_DISABLED_MANUAL_EXACT_MICRO_MICRO_SELECTION_ONLY',
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
        : 'SHORT_EXACT_MICRO_MICRO_IDS_REQUIRED',

      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,

      expectedFormats: [
        'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',
        'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}'
      ],
      exampleMicroMicro: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_MM_AB12CD34EF',
      exampleAlternateInput: 'MM_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN_OB_STRONG_RR_GOOD',
      child75ExampleRejected: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
      parentExampleRejected: 'MICRO_SHORT_BREAKOUT_TREND',

      allowedActions: ALLOWED_ACTIONS,
      ...modeFlags()
    });
  }

  const requestedWeekKey = String(firstValue(body.weekKey, PERSISTENT_LEARNING_KEY)).trim();
  const weekKey = PERSISTENT_LEARNING_KEY;
  const mode = normalizeMode(firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'), 'manual');

  const activation = await activateSelectedMicroFamilies({
    microFamilyIds: selected.acceptedIds,
    trueMicroFamilyIds: selected.acceptedIds,
    activeMicroFamilyIds: selected.acceptedIds,
    ids: selected.acceptedIds,

    microMicroFamilyIds: selected.acceptedIds,
    trueMicroMicroFamilyIds: selected.acceptedIds,
    exactMicroMicroFamilyIds: selected.acceptedIds,
    activeMicroMicroFamilyIds: selected.acceptedIds,
    activeTrueMicroMicroFamilyIds: selected.acceptedIds,
    selectedMicroMicroFamilyIds: selected.acceptedIds,

    childTrueMicroFamilyIds: selected.childTrueMicroFamilyIds,
    base75ChildTrueMicroFamilyIds: selected.childTrueMicroFamilyIds,

    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    macroIds: [],
    parentTrueMicroFamilyIds: extractParentIdsFromIds(selected.acceptedIds),

    maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxActiveDiscordMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,

    weekKey,
    mode,

    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    shortOnly: true,
    longDisabled: true,
    manualOnly: true,
    adminSelected: true,
    autoRotation: false,

    exactTrueMicroFamilyOnly: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,
    microMicroOnly: true,
    selectableMicroMicroOnly: true,
    selectableChildOnly: false,
    selectableChildOrMicroMicroOnly: false,
    selectableIdsAreChildrenOnly: false,
    selectableIdsAreMicroMicroOnly: true,

    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    rawExecutionFingerprintsNotSelectable: true,

    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    child75ActivationDisabled: true,
    autoRotationActivationDisabled: true,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    child75MatchDoesNotTriggerDiscord: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    persistentLearningOnly: true,
    requestedWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION
  });

  const active = compactActiveRotation(activation);

  return res.status(200).json({
    ok: true,
    fixed: true,
    action,

    ...modeFlags(),
    taxonomy: taxonomyMeta(),

    weekKey,
    requestedWeekKey,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
    persistentLearningOnly: true,
    mode,

    requestedMicroFamilyIds: selected.requestedIds,
    requestedTrueMicroFamilyIds: selected.requestedIds,
    requestedChildTrueMicroFamilyIds: selected.childTrueMicroFamilyIds,
    requestedMicroMicroFamilyIds: selected.microMicroFamilyIds,
    requestedMacroFamilyIds: selected.requestedMacroFamilyIds,
    requestedIds: selected.requestedIds,

    resolvedMicroFamilyIds: selected.acceptedIds,
    resolvedTrueMicroFamilyIds: selected.acceptedIds,
    resolvedMicroMicroFamilyIds: selected.acceptedIds,
    resolvedChildTrueMicroFamilyIds: selected.childTrueMicroFamilyIds,
    resolvedMacroFamilyIds: [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: selected.requestedMacroFamilyIds,
    macroExpansionDisabled: true,
    parentExpansionDisabled: true,
    child75ActivationDisabled: true,

    acceptedIds: selected.acceptedIds,
    ignoredRequestedIds: [
      ...selected.ignoredRequestedIds,
      ...(Array.isArray(activation?.ignoredRequestedIds) ? activation.ignoredRequestedIds : [])
    ],
    ignoredAboveLimitIds: selected.ignoredAboveLimitIds,

    activeRotation: active,
    active,

    activatedCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activatedMicroCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activatedChildTrueMicroCount: 0,
    activatedMicroMicroCount: active?.activeMicroMicroFamilyIds?.length || 0,
    activatedMacroCount: 0,

    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    activeChildTrueMicroFamilyIds: [],
    activeMicroMicroFamilyIds: active?.activeMicroMicroFamilyIds || [],
    selectedMicroMicroFamilyIds: active?.selectedMicroMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    bestShort: active?.bestShort || null,
    bestLong: null,

    discordEntryAlertsEnabledForSelectedMicroMicroFamiliesOnly:
      (active?.activeMicroMicroFamilyIds || []).length > 0,
    discordEntryAlertsEnabledForSelectedMicroFamiliesOnly: false,
    noSelectionMeansNoDiscord: (active?.activeMicroMicroFamilyIds || []).length === 0,

    rawActivation: activation,

    perf: {
      durationMs: now() - startedAt,
      source: 'activateSelectedShortExactMicroMicro_manual_only_exact_match'
    },

    serverTs: Date.now()
  });
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'short-only-manual-selection-exact-micro-micro-only-v3');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-True-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Exact-True-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Child-75-Learning-Granularity', CHILD75_LEARNING_GRANULARITY);
  res.setHeader('X-Micro-Micro-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Selectable-Child-Micro-Families', '0');
  res.setHeader('X-Selectable-Micro-Micro-Families', 'dynamic');
  res.setHeader('X-Parent-Micro-Families', '15');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Persistent-Learning-Only', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-Min-Completed-Micro-Micro-Active', String(MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING));
}

export default async function handler(req, res) {
  setHeaders(res);

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    return methodNotAllowed(res);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,
      ...modeFlags(),
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}