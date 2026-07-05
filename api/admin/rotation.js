// ================= FILE: api/admin/rotation.js =================

import { safeNumber, sideToTradeSide } from '../../src/utils.js';
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

const MICRO_MICRO_RUNTIME_GATE_VERSION = 'SHORT_MM_RUNTIME_GATE_OBSERVING_PASSED_REJECTED_POLICY_BLOCKED_V1_ADMIN_INLINE';
const MICRO_MICRO_BEST_SELECTOR_VERSION = 'SHORT_MM_BEST_SELECTOR_PASSED_FIRST_NET_EDGE_V1_ADMIN_INLINE';
const DISCORD_ACTIVATION_GATE_VERSION = 'SHORT_MM_DISCORD_ACTIVATION_NET_EDGE_GATE_V3_ADMIN_INLINE_RUNTIME_GATE';
const ACTIVE_ROTATION_RUNTIME_GATE_VERSION = 'SHORT_ACTIVE_ROTATION_RUNTIME_NET_EDGE_GATE_V2_ADMIN_INLINE_CLEANUP';

const MIN_DISCORD_ACTIVATION_COMPLETED = 35;
const MIN_DISCORD_ACTIVATION_AVG_R = 0;
const MIN_DISCORD_ACTIVATION_TOTAL_R = 0;
const MIN_DISCORD_ACTIVATION_PROFIT_FACTOR = 1;
const MAX_DISCORD_ACTIVATION_AVG_COST_R = 0.35;
const MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT = 0.25;
const BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION = true;
const BLOCK_MISFIT_FOR_DISCORD_ACTIVATION = true;

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
const POSITION_COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V13_MM_OUTCOME_RUNTIME_GATE';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V5_MM_IDENTITY_RUNTIME_GATE';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MICRO_MICRO_ONLY_V4';

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

const ALLOWED_ACTIONS = Object.freeze([
  'activateSelected',
  'activateSelectedMicroFamilies'
]);

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
  'autoBootstrap',
  'weeklyFreeze',
  'activateFreeze'
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
  const parsed = safeNumber(value, fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(decimals)) : 0;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp(value, min = 0, max = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return hasValue(value) ? value : fallback;
}

function toLimit(value, fallback, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isTrue(value, fallback = false) {
  if (!hasValue(value)) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = lower(value);
  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length) {
    const value = stack.shift();
    if (Array.isArray(value)) stack.unshift(...value);
    else output.push(value);
  }

  return output;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];

  for (const value of flattenValues(values)) {
    const parts = typeof value === 'string'
      ? value.split(/[\s,;\n\r]+/g)
      : [value];

    for (const part of parts) {
      const clean = String(part || '').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      output.push(clean);
    }
  }

  return output;
}

function uniqueWarnings(values = []) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
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

function normalizeHash(value = '') {
  const raw = upper(value).replace(/[^A-Z0-9]/g, '');
  return raw.length >= 3 ? raw.slice(0, MICRO_MICRO_HASH_LEN) : '';
}

function activationGateConfig() {
  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    bestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    minCompleted: MIN_DISCORD_ACTIVATION_COMPLETED,
    minAvgR: MIN_DISCORD_ACTIVATION_AVG_R,
    minTotalR: MIN_DISCORD_ACTIVATION_TOTAL_R,
    minProfitFactor: MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
    maxAvgCostR: MAX_DISCORD_ACTIVATION_AVG_COST_R,
    maxDirectSLPct: MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,
    blockEWeakContra: BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION,
    blockMisfit: BLOCK_MISFIT_FOR_DISCORD_ACTIVATION,
    statuses: {
      OBSERVING: 'completed < 35 -> virtual leren, geen Discord',
      PASSED: 'completed >= 35 + positieve net-edge -> bovenaan, selecteerbaar',
      REJECTED: 'completed >= 35 + slechte net-edge -> onderaan, geen entry, geen Discord',
      POLICY_BLOCKED: 'E_WEAK_CONTRA / MISFIT / non-short / non-MM -> geen entry, geen Discord'
    },
    rule: 'completed>=35 && avgR>0 && totalR>0 && profitFactor>1 && avgCostR<=0.35 && directSLPct<=0.25 && currentFit!=MISFIT && confirmationProfile!=E_WEAK_CONTRA'
  };
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
    realOutcomesExcluded: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    activeRotationRuntimeGateVersion: ACTIVE_ROTATION_RUNTIME_GATE_VERSION,
    automaticBestMicroMicroRanking: true,
    automaticBestMicroMicroFamilies: true,
    rankingOrder: 'PASSED > OBSERVING > REJECTED > POLICY_BLOCKED',
    rejectedRowsCannotCreateNewVirtualEntry: true,
    observingRowsCanCreateVirtualEntry: true,
    passedRowsCanBeSelectedForDiscord: true,
    policyBlockedRowsCannotCreateEntryOrDiscord: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitCanBlockDiscordOnly: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

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

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75ContextFamilyCount: 75,
    selectableChildMicroFamilyCount: 0,
    selectableIdsAreMicroMicroOnly: true,
    child75Selectable: false,
    child75ProxySelectionDisabled: true,
    parentIdsAreMetadataOnly: true,
    child75IdsAreContextOnly: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    macroActivationExpansionDisabled: true,
    parentActivationExpansionDisabled: true,
    child75ActivationDisabled: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,

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

    discordActivationRequiresNetEdge: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationGate: activationGateConfig(),

    adminGetFiltersBlockedActiveSelections: true,
    adminPostRejectsBlockedSelections: true,
    oldRedisActiveSelectionCleanup: true,

    persistentLearningOnly: true,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    requestedWeekKeyIgnored: true,
    weekResetDisabled: true,

    minCompletedForMicroMicroActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE_LEARNING,

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
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

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
    parentIdsAreMetadataOnly: true,
    child75ProxySelectionDisabled: true,

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationGate: activationGateConfig()
  };
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

function invalidParsed(rawId = '', reason = 'INVALID_SHORT_TAXONOMY_ID') {
  return {
    valid: false,
    reason,
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
    microMicroHash: null,
    microMicroContext: '',
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
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

  for (const setup of SETUP_ORDER) {
    const setupPrefix = `${setup}_`;
    if (!cleanBody.startsWith(setupPrefix)) continue;

    const afterSetup = cleanBody.slice(setupPrefix.length);

    for (const regime of REGIME_ORDER) {
      if (afterSetup === regime) {
        return { ok: true, setup, regime, confirmationProfile: null, rest: '' };
      }

      const regimePrefix = `${regime}_`;
      if (!afterSetup.startsWith(regimePrefix)) continue;

      const afterRegime = afterSetup.slice(regimePrefix.length);

      for (const profile of CONFIRMATION_PROFILE_ORDER) {
        if (afterRegime === profile) {
          return { ok: true, setup, regime, confirmationProfile: profile, rest: '' };
        }

        const profilePrefix = `${profile}_`;
        if (afterRegime.startsWith(profilePrefix)) {
          return {
            ok: true,
            setup,
            regime,
            confirmationProfile: profile,
            rest: afterRegime.slice(profilePrefix.length)
          };
        }
      }
    }
  }

  return { ok: false, setup: null, regime: null, confirmationProfile: null, rest: '' };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value) return invalidParsed(rawId, 'EMPTY_ID');
  if (value.includes('MICRO_LONG_') || value.startsWith('MM_LONG_')) return invalidParsed(rawId, 'LONG_DISABLED_SHORT_ONLY');
  if (isScannerFingerprintId(value)) return invalidParsed(rawId, 'SCANNER_FINGERPRINT_METADATA_ONLY');
  if (isExecutionFingerprintId(value)) return invalidParsed(rawId, 'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE');

  if (value.includes('_MF_V1_') || value.includes('_MF_V2_') || value.includes('_MF_V3_')) {
    return invalidParsed(rawId, 'LEGACY_MICRO_SCHEMA_NOT_SELECTABLE');
  }

  let body = '';
  let explicitMicroMicro = false;
  let context = '';
  let canonicalMicroMicroSyntax = false;

  if (value.startsWith('MM_SHORT_')) {
    body = value.slice('MM_SHORT_'.length);
    explicitMicroMicro = true;
  } else if (value.startsWith('MICRO_SHORT_')) {
    body = value.slice('MICRO_SHORT_'.length);

    const markerIndex = body.lastIndexOf(MICRO_MICRO_MARKER);
    if (markerIndex > -1) {
      explicitMicroMicro = true;
      canonicalMicroMicroSyntax = true;
      context = body.slice(markerIndex + MICRO_MICRO_MARKER.length);
      body = body.slice(0, markerIndex);
    }
  } else {
    return invalidParsed(rawId, 'NOT_SHORT_TAXONOMY_ID');
  }

  const parsed = parseBodySetupRegimeConfirmation(body);
  if (!parsed.ok) return invalidParsed(rawId, 'INVALID_SHORT_TAXONOMY_BODY');

  if (explicitMicroMicro && !context && parsed.rest) context = parsed.rest;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setup}_${parsed.regime}`;
  const childTrueMicroFamilyId = parsed.confirmationProfile
    ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}`
    : null;

  const isParent = Boolean(!parsed.confirmationProfile && !explicitMicroMicro);
  const isChild = Boolean(parsed.confirmationProfile && !explicitMicroMicro && !parsed.rest);
  const isMicroMicro = Boolean(parsed.confirmationProfile && (explicitMicroMicro || parsed.rest));

  let microMicroHash = null;
  if (isMicroMicro) {
    microMicroHash = canonicalMicroMicroSyntax
      ? normalizeHash(context)
      : normalizeHash(context || parsed.rest) || stableHash10(value);
  }

  if (isMicroMicro && !microMicroHash) {
    return invalidParsed(rawId, 'MICRO_MICRO_HASH_REQUIRED');
  }

  const microMicroFamilyId = isMicroMicro
    ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`
    : null;

  const trueMicroFamilyId = microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId;

  return {
    valid: true,
    reason: 'OK',
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
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningLayer: isMicroMicro ? 'MICRO_MICRO' : isChild ? 'CHILD_75_CONTEXT' : isParent ? 'PARENT_15_CONTEXT' : 'UNKNOWN',
    selectionLayer: isMicroMicro ? 'MICRO_MICRO' : 'NOT_SELECTABLE',
    selectionGranularity: isMicroMicro ? 'EXACT_MICRO_MICRO_ONLY' : 'NOT_SELECTABLE'
  };
}

function isFixedShortParentMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedShortChild75Id(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
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

function getExplicitMicroMicroId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
  }

  return firstParsed([
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.activeMicroMicroFamilyId,
    row.activeTrueMicroMicroFamilyId,
    row.activeExactMicroMicroFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
}

function getParentTrueMicroFamilyIdFromId(id = '') {
  return parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId || null;
}

function getChildTrueMicroFamilyIdFromId(id = '') {
  return parseShortTaxonomyMicroId(id).childTrueMicroFamilyId || null;
}

function normalizeDirectSide(value) {
  const raw = upper(value);
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
    const parsed = parseShortTaxonomyMicroId(input);
    if (parsed.valid) return TARGET_TRADE_SIDE;
    if (parsed.reason === 'LONG_DISABLED_SHORT_ONLY') return OPPOSITE_TRADE_SIDE;

    const value = upper(input);
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

  const idText = upper([
    input.microMicroFamilyId,
    input.trueMicroMicroFamilyId,
    input.exactMicroMicroFamilyId,
    input.trueMicroFamilyId,
    input.learningFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.microFamilyId,
    input.parentTrueMicroFamilyId,
    input.id,
    input.key,
    input.definition,
    input.microDefinition,
    input.microMicroDefinition
  ].filter(Boolean).join(' | '));

  if (idText.includes('MICRO_LONG_') || idText.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
  if (idText.includes('MICRO_SHORT_') || idText.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
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

function aggregateRecentOutcomes(row = {}) {
  const recent = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];

  return recent.reduce((acc, outcome) => {
    if (!outcome || typeof outcome !== 'object') return acc;

    const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');
    if (!['VIRTUAL', 'SHADOW', 'PAPER', ''].includes(source)) return acc;

    const r = num(
      outcome.netR ??
        outcome.exitR ??
        outcome.realizedNetR ??
        outcome.realizedR ??
        outcome.r,
      0
    );

    const costR = Math.max(0, num(outcome.costR ?? outcome.avgCostR, 0));

    acc.completed += 1;
    acc.totalR += r;
    acc.totalCostR += costR;

    if (r > 0) {
      acc.wins += 1;
      acc.grossWinR += r;
    } else if (r < 0) {
      acc.losses += 1;
      acc.grossLossR += Math.abs(r);
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

  const wins = Math.max(0, sourceWins, num(row.wins, 0), recent.wins);
  const losses = Math.max(0, sourceLosses, num(row.losses, 0), recent.losses);
  const flats = Math.max(0, sourceFlats, num(row.flats, 0), recent.flats);

  const completed = Math.max(
    wins + losses + flats,
    num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
    num(row.completed, 0),
    num(row.outcomeSample, 0),
    recent.completed
  );

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, completed - wins - losses)),
    total: completed
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

  const t = totalR(row);
  if (t !== 0) return t / completed;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR)) return num(row.avgR, 0);

  return 0;
}

function totalCostR(row = {}) {
  const completed = completedSample(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowCost = Math.max(0, num(row.virtualTotalCostR, 0)) + Math.max(0, num(row.shadowTotalCostR, 0));
  if (virtualShadowCost > 0) return virtualShadowCost;
  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;
  if (hasValue(row.totalCostR)) return Math.max(0, num(row.totalCostR, 0));
  if (hasValue(row.avgCostR)) return Math.max(0, num(row.avgCostR, 0)) * completed;
  if (hasValue(row.costR)) return Math.max(0, num(row.costR, 0)) * completed;

  return 0;
}

function avgCostR(row = {}) {
  const completed = completedSample(row);
  return completed > 0 ? totalCostR(row) / completed : 0;
}

function directSLCount(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  return Math.max(
    0,
    num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0),
    num(row.directSLCount, 0),
    recent.directSLCount
  );
}

function directSLPct(row = {}) {
  const explicit = num(row.directSLPct, NaN);

  if (Number.isFinite(explicit)) {
    return explicit > 1 ? clamp(explicit / 100, 0, 1) : clamp(explicit, 0, 1);
  }

  const completed = completedSample(row);
  return completed > 0 ? clamp(directSLCount(row) / completed, 0, 1) : 0;
}

function profitFactor(row = {}) {
  const recent = aggregateRecentOutcomes(row);

  const winR = Math.max(
    num(row.virtualWinR, 0) + num(row.shadowWinR, 0),
    num(row.virtualGrossWinR, 0) + num(row.shadowGrossWinR, 0),
    num(row.netWinR, 0),
    num(row.totalWinR, 0),
    num(row.grossWinR, 0),
    recent.grossWinR,
    0
  );

  const lossR = Math.max(
    Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)),
    Math.abs(num(row.virtualGrossLossR, 0) + num(row.shadowGrossLossR, 0)),
    Math.abs(num(row.netLossR, 0)),
    Math.abs(num(row.totalLossR, 0)),
    Math.abs(num(row.grossLossR, 0)),
    recent.grossLossR,
    0
  );

  if (winR > 0 || lossR > 0) {
    if (lossR <= 0) return 99;
    return winR / lossR;
  }

  const explicit = num(row.netProfitFactor ?? row.profitFactor ?? row.pf, NaN);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);

  return 0;
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
  return n > 0 ? clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1) : 0;
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
  const parsed = Number(score);
  if (!Number.isFinite(parsed)) return fallback || 'UNKNOWN';
  if (parsed >= 45) return 'FIT';
  if (parsed >= 20) return 'OK';
  if (parsed <= -20) return 'MISFIT';
  return 'NEUTRAL';
}

function getShortCurrentFit(row = {}) {
  const direct = [
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore,
    row.shortCurrentFitScore,
    row.bearCurrentFitScore
  ].find((value) => Number.isFinite(Number(value)));

  if (hasValue(direct)) {
    return {
      score: Number(direct),
      label: currentFitLabel(Number(direct), row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      source: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const explicitLabel = upper(row.currentFit || row.currentFitLabel || row.entryCurrentFit || '');
  if (
    explicitLabel.includes('MISFIT') ||
    explicitLabel.includes('MISMATCH') ||
    explicitLabel.includes('AGAINST') ||
    explicitLabel.includes('NO_MATCH')
  ) {
    return {
      score: -25,
      label: 'MISFIT',
      source: 'EXPLICIT_CURRENT_FIT_LABEL'
    };
  }

  const raw = [
    row.currentFitScore,
    row.fitScore,
    row.marketFitScore,
    row.marketFit,
    row.currentFitNumeric
  ].find((value) => Number.isFinite(Number(value)));

  if (!hasValue(raw)) {
    return {
      score: 0,
      label: explicitLabel || 'UNKNOWN',
      source: 'NO_NUMERIC_CURRENT_FIT'
    };
  }

  const haystack = [
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
    row.currentFitReason
  ].map(upper).join(' | ');

  const score = haystack.includes('BULL') || haystack.includes('LONG') || haystack.includes('BUY')
    ? -Math.abs(Number(raw))
    : Number(raw);

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

function microMicroRuntimeGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row.key);
  const parsed = parseShortTaxonomyMicroId(id || row.key || row.id || row.trueMicroFamilyId || '');
  const fitInfo = getShortCurrentFit(row);

  const completed = completedSample(row);
  const observed = observationSample(row);
  const netAvgR = avgR(row);
  const netTotalR = totalR(row);
  const pf = profitFactor(row);
  const cost = avgCostR(row);
  const dsl = directSLPct(row);
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);

  const checks = {
    exactMicroMicroOk: Boolean(id && parsed.isMicroMicro && isSelectableMicroMicroId(id)),
    shortOnlyOk: isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id }),
    completedOk: completed >= MIN_DISCORD_ACTIVATION_COMPLETED,
    avgROk: netAvgR > MIN_DISCORD_ACTIVATION_AVG_R,
    totalROk: netTotalR > MIN_DISCORD_ACTIVATION_TOTAL_R,
    profitFactorOk: pf > MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
    avgCostROk: cost <= MAX_DISCORD_ACTIVATION_AVG_COST_R,
    directSLOk: dsl <= MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,
    currentFitOk: !(BLOCK_MISFIT_FOR_DISCORD_ACTIVATION && upper(fitInfo.label) === 'MISFIT'),
    confirmationProfileOk: !(BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION && confirmationProfile === 'E_WEAK_CONTRA')
  };

  const policyReasons = [];

  if (!checks.exactMicroMicroOk) policyReasons.push('EXACT_MICRO_MICRO_ID_REQUIRED');
  if (!checks.shortOnlyOk) policyReasons.push('SHORT_ONLY_REQUIRED');
  if (!checks.currentFitOk) policyReasons.push('CURRENTFIT_MISFIT_BLOCKED');
  if (!checks.confirmationProfileOk) policyReasons.push('E_WEAK_CONTRA_BLOCKED');

  if (policyReasons.length > 0) {
    return {
      version: MICRO_MICRO_RUNTIME_GATE_VERSION,
      status: 'POLICY_BLOCKED',
      eligible: false,
      approved: false,
      blocked: true,
      allowVirtualEntry: false,
      allowDiscord: false,
      reason: policyReasons[0],
      firstReason: policyReasons[0],
      reasons: policyReasons,
      checks,
      id,
      parsed,
      completed: round(completed, 4),
      observed: round(observed, 4),
      avgR: round(netAvgR, 4),
      totalR: round(netTotalR, 4),
      profitFactor: round(pf, 4),
      avgCostR: round(cost, 4),
      directSLPct: round(dsl, 4),
      currentFit: fitInfo.label || 'UNKNOWN',
      currentFitScore: round(fitInfo.score, 4),
      currentFitSource: fitInfo.source,
      confirmationProfile,
      thresholds: activationGateConfig()
    };
  }

  if (completed < MIN_DISCORD_ACTIVATION_COMPLETED) {
    return {
      version: MICRO_MICRO_RUNTIME_GATE_VERSION,
      status: 'OBSERVING',
      eligible: false,
      approved: false,
      blocked: false,
      allowVirtualEntry: true,
      allowDiscord: false,
      reason: `COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`,
      firstReason: `COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`,
      reasons: [`COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`],
      checks,
      id,
      parsed,
      completed: round(completed, 4),
      observed: round(observed, 4),
      avgR: round(netAvgR, 4),
      totalR: round(netTotalR, 4),
      profitFactor: round(pf, 4),
      avgCostR: round(cost, 4),
      directSLPct: round(dsl, 4),
      currentFit: fitInfo.label || 'UNKNOWN',
      currentFitScore: round(fitInfo.score, 4),
      currentFitSource: fitInfo.source,
      confirmationProfile,
      thresholds: activationGateConfig()
    };
  }

  const failedReasons = [];

  if (!checks.avgROk) failedReasons.push('AVG_R_NET_NOT_POSITIVE');
  if (!checks.totalROk) failedReasons.push('TOTAL_R_NET_NOT_POSITIVE');
  if (!checks.profitFactorOk) failedReasons.push('PROFIT_FACTOR_NOT_ABOVE_1');
  if (!checks.avgCostROk) failedReasons.push('AVG_COST_R_TOO_HIGH');
  if (!checks.directSLOk) failedReasons.push('DIRECT_SL_PCT_TOO_HIGH');

  if (failedReasons.length > 0) {
    return {
      version: MICRO_MICRO_RUNTIME_GATE_VERSION,
      status: 'REJECTED',
      eligible: false,
      approved: false,
      blocked: true,
      allowVirtualEntry: false,
      allowDiscord: false,
      reason: failedReasons[0],
      firstReason: failedReasons[0],
      reasons: failedReasons,
      checks,
      id,
      parsed,
      completed: round(completed, 4),
      observed: round(observed, 4),
      avgR: round(netAvgR, 4),
      totalR: round(netTotalR, 4),
      profitFactor: round(pf, 4),
      avgCostR: round(cost, 4),
      directSLPct: round(dsl, 4),
      currentFit: fitInfo.label || 'UNKNOWN',
      currentFitScore: round(fitInfo.score, 4),
      currentFitSource: fitInfo.source,
      confirmationProfile,
      thresholds: activationGateConfig()
    };
  }

  return {
    version: MICRO_MICRO_RUNTIME_GATE_VERSION,
    status: 'PASSED',
    eligible: true,
    approved: true,
    blocked: false,
    allowVirtualEntry: true,
    allowDiscord: true,
    reason: 'PASSED_NET_EDGE_GATE',
    firstReason: null,
    reasons: [],
    checks,
    id,
    parsed,
    completed: round(completed, 4),
    observed: round(observed, 4),
    avgR: round(netAvgR, 4),
    totalR: round(netTotalR, 4),
    profitFactor: round(pf, 4),
    avgCostR: round(cost, 4),
    directSLPct: round(dsl, 4),
    currentFit: fitInfo.label || 'UNKNOWN',
    currentFitScore: round(fitInfo.score, 4),
    currentFitSource: fitInfo.source,
    confirmationProfile,
    thresholds: activationGateConfig()
  };
}

function microMicroStatusRank(row = {}) {
  const status = upper(row.microMicroRuntimeStatus || row.microMicroStatus || microMicroRuntimeGate(row).status);

  if (status === 'PASSED') return 4;
  if (status === 'OBSERVING') return 3;
  if (status === 'REJECTED') return 2;
  if (status === 'POLICY_BLOCKED') return 1;

  return 0;
}

function netEdgeScore(row = {}) {
  const gate = microMicroRuntimeGate(row);
  const reliability = sampleReliability(gate.completed, 100);
  const cappedPf = Math.min(Math.max(0, gate.profitFactor), 10);

  const statusBoost =
    gate.status === 'PASSED'
      ? 100000
      : gate.status === 'OBSERVING'
        ? 1000
        : gate.status === 'REJECTED'
          ? -100000
          : gate.status === 'POLICY_BLOCKED'
            ? -200000
            : 0;

  return (
    statusBoost +
    gate.avgR * 120 +
    gate.totalR * 1.5 +
    cappedPf * 12 +
    reliability * 25 -
    gate.avgCostR * 45 -
    gate.directSLPct * 90
  );
}

function compareBestMicroMicroRows(a = {}, b = {}) {
  const ga = microMicroRuntimeGate(a);
  const gb = microMicroRuntimeGate(b);

  return (
    microMicroStatusRank(b) - microMicroStatusRank(a) ||
    netEdgeScore(b) - netEdgeScore(a) ||
    gb.avgR - ga.avgR ||
    gb.totalR - ga.totalR ||
    gb.profitFactor - ga.profitFactor ||
    ga.avgCostR - gb.avgCostR ||
    ga.directSLPct - gb.directSLPct ||
    gb.completed - ga.completed ||
    gb.observed - ga.observed ||
    num(b.adaptiveScore, 0) - num(a.adaptiveScore, 0) ||
    num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
    String(a.trueMicroFamilyId || a.id || '').localeCompare(String(b.trueMicroFamilyId || b.id || ''))
  );
}

function discordActivationGate(row = {}) {
  const gate = microMicroRuntimeGate(row);

  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    eligible: gate.status === 'PASSED',
    blocked: gate.status !== 'PASSED',
    reason: gate.status === 'PASSED'
      ? 'DISCORD_ACTIVATION_ELIGIBLE_NET_EDGE_CONFIRMED'
      : gate.reason,
    reasons: gate.reasons,
    status: gate.status,

    id: gate.id,
    completed: gate.completed,
    observed: gate.observed,
    avgR: gate.avgR,
    totalR: gate.totalR,
    profitFactor: gate.profitFactor,
    avgCostR: gate.avgCostR,
    directSLPct: gate.directSLPct,
    currentFit: gate.currentFit,
    currentFitScore: gate.currentFitScore,
    confirmationProfile: gate.confirmationProfile,

    thresholds: activationGateConfig()
  };
}

function eligibilityTier(row = {}) {
  return microMicroRuntimeGate(row).status;
}

function normalizeRotationRow(row = {}, index = 0, activeSet = new Set()) {
  const id = getExplicitMicroMicroId(row, row.key);
  if (!id || !isSelectableMicroMicroId(id)) return null;
  if (!isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id })) return null;

  const parsed = parseShortTaxonomyMicroId(id);
  const wr = sampleAdjustedWinrate(row);
  const fit = getShortCurrentFit(row);
  const completed = completedSample(row);
  const observed = observationSample(row);
  const bScore = balancedScore(row, wr);
  const gate = microMicroRuntimeGate({ ...row, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id });
  const discordGate = discordActivationGate({ ...row, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id });

  return {
    rank: index + 1,

    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,

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
    selectableTrueMicroFamily: gate.status === 'PASSED',
    selectableMicroMicroFamily: gate.status === 'PASSED',
    selectable75Child: false,
    selectableParent: false,

    learningLayer: 'MICRO_MICRO',
    selectionLayer: 'MICRO_MICRO',
    selectableLayer: 'MICRO_MICRO',
    inferredTradeSide: TARGET_TRADE_SIDE,

    schema: row.schema || row.microFamilySchema || MICRO_MICRO_SCHEMA,
    microFamilySchema: row.microFamilySchema || row.schema || MICRO_MICRO_SCHEMA,

    isTrueMicro: true,
    isChildTrueMicro: false,
    isMicroMicro: true,
    isBase75Child: false,

    active: Boolean(row.active || activeSet.has(id)),

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

    winrate: round(wr.rawWinrate, 4),
    bayesianWinrate: round(wr.bayesianWinrate, 4),
    wilsonLowerBound: round(wr.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleReliability: round(row.sampleReliability ?? wr.reliability, 4),

    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),
    profitFactor: round(profitFactor(row), 4),

    directSLCount: round(directSLCount(row), 4),
    directSLPct: round(directSLPct(row), 4),

    totalCostR: round(totalCostR(row), 4),
    avgCostR: round(avgCostR(row), 4),

    balancedScore: round(row.balancedScore ?? bScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? bScore, 4),
    adaptiveScore: round(row.adaptiveScore ?? row.microMicroScore ?? bScore + fit.score * 0.15, 4),
    netEdgeScore: round(netEdgeScore({ ...row, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id }), 4),
    bestMicroMicroScore: round(netEdgeScore({ ...row, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id }), 4),

    currentFit: fit.label,
    currentFitLabel: fit.label,
    currentFitScore: round(fit.score, 4),
    fitScore: round(fit.score, 4),
    currentFitSource: fit.source,
    currentFitBlocksLearning: false,
    currentFitBlocksDiscord: fit.label === 'MISFIT',
    discordCurrentFitAllowed: fit.label !== 'MISFIT',

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    microMicroRuntimeGate: gate,
    microMicroStatus: gate.status,
    microMicroRuntimeStatus: gate.status,
    microMicroRuntimeEligible: gate.status === 'PASSED',
    microMicroRuntimeBlocked: gate.blocked,
    microMicroRuntimeReason: gate.reason,
    microMicroRuntimeReasons: gate.reasons,

    allowVirtualEntry: gate.allowVirtualEntry,
    virtualEntryAllowedByMicroMicroGate: gate.allowVirtualEntry,
    virtualEntryBlockedByMicroMicroGate: !gate.allowVirtualEntry,
    virtualEntryBlockedReason: gate.allowVirtualEntry ? null : gate.reason,

    eligibleForBestList: gate.status === 'PASSED',
    observingForLearning: gate.status === 'OBSERVING',
    rejectedForLearning: gate.status === 'REJECTED',
    policyBlockedForLearning: gate.status === 'POLICY_BLOCKED',

    discordActivationEligible: discordGate.eligible,
    discordActivationBlocked: discordGate.blocked,
    discordActivationReason: discordGate.reason,
    discordActivationBlockedReason: discordGate.blocked ? discordGate.reason : null,
    discordActivationBlockedReasons: discordGate.reasons,
    discordActivationGate: discordGate,

    activationEligible: discordGate.eligible,
    activationBlocked: discordGate.blocked,
    activationBlockedReason: discordGate.blocked ? discordGate.reason : null,

    runtimeGateApproved: discordGate.eligible,
    runtimeDiscordGateApproved: discordGate.eligible,
    discordRuntimeGateApproved: discordGate.eligible,
    exitAlertRuntimeGateApproved: discordGate.eligible,

    activeRotationRuntimeGateVersion: ACTIVE_ROTATION_RUNTIME_GATE_VERSION,
    activeRotationRuntimeGateApproved: discordGate.eligible,
    activeRotationRuntimeGateBlocked: discordGate.blocked,
    activeRotationRuntimeGateReason: discordGate.blocked ? discordGate.reason : null,
    activeRotationRuntimeGateReasons: discordGate.reasons,

    selectedTier: gate.status,
    rotationEligibilityTier: gate.status,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || parsed.microMicroHash || null,
    executionFingerprintParts: getArray(row.executionFingerprintParts),
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: row.sourceWeekPrimary !== false,
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
  return compareBestMicroMicroRows(a, b);
}

function buildAvailableRowsFromMicros(micros = {}, activeSet = new Set()) {
  const rows = [];
  const ignoredLayerCounts = {
    parent15: 0,
    child75: 0,
    scanner: 0,
    executionFingerprint: 0,
    long: 0,
    unknown: 0
  };

  for (const [key, row] of sourceEntries(micros)) {
    if (!row || typeof row !== 'object') continue;

    const id = getExplicitMicroMicroId({ ...row, key }, key);

    if (!id) {
      const parsed = firstParsed([
        key,
        row.trueMicroFamilyId,
        row.microFamilyId,
        row.childTrueMicroFamilyId,
        row.parentTrueMicroFamilyId
      ]) || invalidParsed(key);

      if (inferTradeSide({ ...row, key }) === OPPOSITE_TRADE_SIDE || parsed.reason === 'LONG_DISABLED_SHORT_ONLY') {
        ignoredLayerCounts.long += 1;
      } else if (isScannerFingerprintId(key)) {
        ignoredLayerCounts.scanner += 1;
      } else if (isExecutionFingerprintId(key)) {
        ignoredLayerCounts.executionFingerprint += 1;
      } else if (parsed.isParent) {
        ignoredLayerCounts.parent15 += 1;
      } else if (parsed.isChild) {
        ignoredLayerCounts.child75 += 1;
      } else {
        ignoredLayerCounts.unknown += 1;
      }

      continue;
    }

    const normalized = normalizeRotationRow({
      ...row,
      key,
      id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      microMicroFamilyId: id,
      trueMicroMicroFamilyId: id,
      exactMicroMicroFamilyId: id,
      generatedMicroMicroFromChild75: false,
      child75ProxySelectionDisabled: true,
      microMicroStatsSource: 'EXPLICIT_MICRO_MICRO_ROW',
      sourceWeekKey: PERSISTENT_LEARNING_KEY,
      sourceWeekPrimary: true,
      active: activeSet.has(id)
    }, rows.length, activeSet);

    if (normalized) rows.push(normalized);
  }

  const seen = new Set();
  const output = rows
    .filter((row) => {
      const key = row.trueMicroFamilyId;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareRows);

  output.ignoredLayerCounts = ignoredLayerCounts;

  return output;
}

async function loadAvailableRows({ weekKey, limit = DEFAULT_AVAILABLE_LIMIT, activeSet = new Set() } = {}) {
  const requestedWeekKey = String(weekKey || PERSISTENT_LEARNING_KEY).trim();
  const current = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));
  const allRows = buildAvailableRowsFromMicros(current || {}, activeSet);
  const rows = allRows.slice(0, limit);

  return {
    requestedWeekKey,
    currentWeekKey: PERSISTENT_LEARNING_KEY,
    previousWeekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningOnly: true,
    queryWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null,
    currentRows: sourceEntries(current).length,
    previousRows: 0,
    mergedRows: rows.length,
    ignoredLayerCounts: allRows.ignoredLayerCounts || {},
    activationEligibleRows: allRows.filter((row) => row.microMicroRuntimeStatus === 'PASSED').length,
    activationBlockedRows: allRows.filter((row) => row.microMicroRuntimeStatus !== 'PASSED').length,
    rows
  };
}

function normalizeActiveRotationObject(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;
  return rotation.activeRotation || rotation.active || rotation.rotation || rotation;
}

function extractIdsFromRotation(rotation = {}) {
  const activeRotation = normalizeActiveRotationObject(rotation) || {};

  const rows = [
    ...getArray(activeRotation.microFamilies),
    ...getArray(activeRotation.rows),
    ...getArray(activeRotation.activeRows),
    ...getArray(activeRotation.selectedRows)
  ];

  return uniqueStrings([
    activeRotation.microMicroFamilyIds || [],
    activeRotation.trueMicroMicroFamilyIds || [],
    activeRotation.exactMicroMicroFamilyIds || [],
    activeRotation.activeMicroMicroFamilyIds || [],
    activeRotation.activeTrueMicroMicroFamilyIds || [],
    activeRotation.activeExactMicroMicroFamilyIds || [],
    activeRotation.selectedMicroMicroFamilyIds || [],
    activeRotation.selectedTrueMicroMicroFamilyIds || [],
    activeRotation.selectedExactMicroMicroFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.activeMicroFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    rows.map((row) => getExplicitMicroMicroId(row, row?.key))
  ])
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractLegacyActiveChild75Ids(rotation = {}) {
  const activeRotation = normalizeActiveRotationObject(rotation) || {};

  const rows = [
    ...getArray(activeRotation.microFamilies),
    ...getArray(activeRotation.rows),
    ...getArray(activeRotation.activeRows),
    ...getArray(activeRotation.selectedRows)
  ];

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
  return uniqueStrings(ids.map(getParentTrueMicroFamilyIdFromId).filter(Boolean)).filter(isFixedShortParentMicroId);
}

function manualActiveRowFromId(id, index = 0, activeSet = new Set()) {
  if (!id || !isSelectableMicroMicroId(id)) return null;

  const parsed = parseShortTaxonomyMicroId(id);

  return normalizeRotationRow({
    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    active: true,
    selectedTier: 'OBSERVING',
    rotationEligibilityTier: 'OBSERVING',
    microMicroStatsSource: 'MANUAL_ACTIVE_MICRO_MICRO_ID_WITHOUT_STATS_BLOCKED_UNTIL_GATE_PASS'
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
      activeTrueMicroMicroFamilyIds: [],
      activeExactMicroMicroFamilyIds: [],
      selectedMicroMicroFamilyIds: [],
      selectedTrueMicroMicroFamilyIds: [],
      selectedExactMicroMicroFamilyIds: [],
      childTrueMicroFamilyIds: [],
      legacyChild75ActiveIdsIgnored: [],
      macroFamilyIds: [],
      activeMacroFamilyIds: [],
      parentTrueMicroFamilyIds: [],
      microFamilies: [],
      filteredBlockedMicroMicroIds: [],
      filteredBlockedMicroMicroRows: [],
      activeRotationBlockedFilteredCount: 0,
      activeRotationCleaned: false,
      count: 0,
      activeCount: 0,
      activeMicroMicroCount: 0,
      bestShort: null,
      bestLong: null,
      missingSides: [TARGET_TRADE_SIDE]
    };
  }

  const requestedActiveMicroMicroFamilyIds = extractIdsFromRotation(activeRotation);
  const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotation);
  const requestedSet = new Set(requestedActiveMicroMicroFamilyIds);

  const sourceRows = [
    ...getArray(activeRotation.microFamilies),
    ...getArray(activeRotation.rows),
    ...getArray(activeRotation.activeRows),
    ...getArray(activeRotation.selectedRows)
  ];

  const rows = [];
  const rejectedRows = [];
  const existing = new Set();

  for (const row of sourceRows) {
    const id = getExplicitMicroMicroId(row, row?.key);
    if (!id || !requestedSet.has(id) || existing.has(id)) continue;

    const normalized = normalizeRotationRow({ ...row, active: true }, rows.length, requestedSet);

    if (!normalized) {
      rejectedRows.push({
        id,
        reason: 'ACTIVE_ROW_COULD_NOT_NORMALIZE_TO_EXACT_MICRO_MICRO'
      });
      existing.add(id);
      continue;
    }

    if (normalized.microMicroRuntimeStatus !== 'PASSED') {
      rejectedRows.push({
        id,
        reason: normalized.microMicroRuntimeReason || 'MICRO_MICRO_RUNTIME_GATE_REJECTED',
        reasons: normalized.microMicroRuntimeReasons || [],
        status: normalized.microMicroRuntimeStatus,
        microMicroRuntimeGate: normalized.microMicroRuntimeGate || null,
        discordActivationGate: normalized.discordActivationGate || null,
        row: normalized
      });
      existing.add(id);
      continue;
    }

    rows.push(normalized);
    existing.add(id);
  }

  for (const id of requestedActiveMicroMicroFamilyIds) {
    if (existing.has(id)) continue;

    const manualRow = manualActiveRowFromId(id, rows.length, requestedSet);

    if (!manualRow) {
      rejectedRows.push({
        id,
        reason: 'MANUAL_ACTIVE_ID_COULD_NOT_BUILD_ROW'
      });
      existing.add(id);
      continue;
    }

    if (manualRow.microMicroRuntimeStatus !== 'PASSED') {
      rejectedRows.push({
        id,
        reason: manualRow.microMicroRuntimeReason || 'MICRO_MICRO_RUNTIME_GATE_REJECTED',
        reasons: manualRow.microMicroRuntimeReasons || [],
        status: manualRow.microMicroRuntimeStatus,
        microMicroRuntimeGate: manualRow.microMicroRuntimeGate || null,
        discordActivationGate: manualRow.discordActivationGate || null,
        row: manualRow
      });
      existing.add(id);
      continue;
    }

    rows.push(manualRow);
    existing.add(id);
  }

  rows.sort(compareRows);

  const activeMicroMicroFamilyIds = rows
    .map((row) => row.trueMicroFamilyId)
    .filter(Boolean)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  const activeParentIds = extractParentIdsFromIds(activeMicroMicroFamilyIds);
  const childIds = uniqueStrings(activeMicroMicroFamilyIds.map(getChildTrueMicroFamilyIdFromId).filter(Boolean));

  const emptyReason =
    requestedActiveMicroMicroFamilyIds.length > 0 && activeMicroMicroFamilyIds.length === 0
      ? 'ACTIVE_ROTATION_ALL_SELECTED_MICRO_MICROS_BLOCKED_BY_NET_EDGE_GATE'
      : 'NO_MANUAL_SHORT_EXACT_MICRO_MICRO_SELECTION_ACTIVE';

  return {
    rotationId: activeRotation.rotationId || activeRotation.id || null,
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
    emptyReason: activeMicroMicroFamilyIds.length === 0 ? emptyReason : null,

    requestedActiveMicroMicroFamilyIds,
    filteredBlockedMicroMicroIds: rejectedRows.map((row) => row.id).filter(Boolean),
    filteredBlockedMicroMicroRows: rejectedRows,
    activeRotationBlockedFilteredCount: rejectedRows.length,
    activeRotationCleaned: rejectedRows.length > 0,
    activeRotationFilteredBlockedRedisSelections: rejectedRows.length > 0,

    microFamilyIds: activeMicroMicroFamilyIds,
    activeMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroFamilyIds: activeMicroMicroFamilyIds,

    microMicroFamilyIds: activeMicroMicroFamilyIds,
    trueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    exactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    activeMicroMicroFamilyIds,
    activeTrueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    activeExactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    selectedMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: activeMicroMicroFamilyIds,

    childTrueMicroFamilyIds: childIds,
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
    body.activeExactMicroMicroFamilyIds,
    body.selectedMicroMicroFamilyIds,
    body.selectedTrueMicroMicroFamilyIds,
    body.selectedExactMicroMicroFamilyIds,
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

  const normalizedCandidates = candidateIds
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId);

  const uniqueNormalized = uniqueStrings(normalizedCandidates);
  const acceptedIds = uniqueNormalized.slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  const ignoredRequestedIds = requestedIds
    .filter((id) => !acceptedIds.includes(parseShortTaxonomyMicroId(id).trueMicroFamilyId))
    .map((id) => {
      const parsed = parseShortTaxonomyMicroId(id);
      const side = inferTradeSide(id);
      const isMacroRequest = macroFamilyIds.includes(id) || parsed.isParent;

      return {
        id,
        normalizedId: parsed.trueMicroFamilyId || upper(id),
        reason: side === OPPOSITE_TRADE_SIDE || parsed.reason === 'LONG_DISABLED_SHORT_ONLY'
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

  const childTrueMicroFamilyIds = uniqueStrings(acceptedIds.map(getChildTrueMicroFamilyIdFromId).filter(Boolean));

  return {
    requestedIds,
    acceptedIds,
    microFamilyIds: acceptedIds,
    trueMicroFamilyIds: acceptedIds,
    microMicroFamilyIds: acceptedIds,
    trueMicroMicroFamilyIds: acceptedIds,
    exactMicroMicroFamilyIds: acceptedIds,
    activeMicroMicroFamilyIds: acceptedIds,
    activeTrueMicroMicroFamilyIds: acceptedIds,
    activeExactMicroMicroFamilyIds: acceptedIds,
    selectedMicroMicroFamilyIds: acceptedIds,
    selectedTrueMicroMicroFamilyIds: acceptedIds,
    selectedExactMicroMicroFamilyIds: acceptedIds,
    childTrueMicroFamilyIds,
    macroFamilyIds: [],
    requestedMacroFamilyIds: macroFamilyIds,
    ignoredRequestedIds,
    ignoredAboveLimitIds: uniqueNormalized.slice(MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES)
  };
}

function normalizeAction(body = {}) {
  const raw = String(body?.action || '').trim();
  if (raw) return raw;

  const ids = parseSelectedIds(body);
  return ids.acceptedIds.length > 0 ? 'activateSelectedMicroFamilies' : '';
}

function normalizeMode(value, fallback = 'manual') {
  const mode = String(value || fallback).trim();
  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function buildTierSummary(rows = []) {
  return rows.reduce((acc, row) => {
    const status = row.microMicroRuntimeStatus || microMicroRuntimeGate(row).status;

    acc.total += 1;
    acc[status] = (acc[status] || 0) + 1;
    acc.MICRO_MICRO += 1;

    return acc;
  }, {
    total: 0,
    MICRO_MICRO: 0,
    PASSED: 0,
    OBSERVING: 0,
    REJECTED: 0,
    POLICY_BLOCKED: 0
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

function activationSummary(rows = []) {
  const passed = rows.filter((row) => row.microMicroRuntimeStatus === 'PASSED');
  const observing = rows.filter((row) => row.microMicroRuntimeStatus === 'OBSERVING');
  const rejected = rows.filter((row) => row.microMicroRuntimeStatus === 'REJECTED');
  const policyBlocked = rows.filter((row) => row.microMicroRuntimeStatus === 'POLICY_BLOCKED');

  const blocked = rows.filter((row) => row.microMicroRuntimeStatus !== 'PASSED');
  const reasons = blocked.reduce((acc, row) => {
    for (const reason of row.microMicroRuntimeReasons || [row.microMicroRuntimeReason || 'UNKNOWN']) {
      acc[reason] = (acc[reason] || 0) + 1;
    }
    return acc;
  }, {});

  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    bestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,

    total: rows.length,
    eligible: passed.length,
    passed: passed.length,
    observing: observing.length,
    rejected: rejected.length,
    policyBlocked: policyBlocked.length,
    blocked: blocked.length,

    eligibleIds: passed.map((row) => row.trueMicroFamilyId),
    topEligibleIds: passed.slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES).map((row) => row.trueMicroFamilyId),
    blockedReasonCounts: reasons,
    thresholds: activationGateConfig()
  };
}

function rotationOptions(extra = {}) {
  return {
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    weekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    shortOnly: true,
    longDisabled: true,
    manualOnly: true,
    autoRotation: false,

    exactTrueMicroFamilyOnly: true,
    exactTrueMicroOnly: true,
    trueMicroOnly: true,
    microMicroOnly: true,
    selectableMicroMicroOnly: true,
    selectableChildOnly: false,
    selectableIdsAreMicroMicroOnly: true,
    child75ProxySelectionDisabled: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
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

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroBestSelectorVersion: MICRO_MICRO_BEST_SELECTOR_VERSION,
    activeRotationRuntimeGateVersion: ACTIVE_ROTATION_RUNTIME_GATE_VERSION,

    discordActivationRequiresNetEdge: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationGate: activationGateConfig(),

    persistentLearningOnly: true,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    ...extra
  };
}

async function validateSelectedActivationIds(selectedIds = []) {
  const current = await getWeekMicros(PERSISTENT_LEARNING_KEY).catch(() => ({}));
  const rows = buildAvailableRowsFromMicros(current || {}, new Set());
  const rowById = new Map(rows.map((row) => [row.trueMicroFamilyId, row]));

  const requestedRows = [];
  const eligibleRows = [];
  const rejectedRows = [];

  for (const id of uniqueStrings(selectedIds).filter(isSelectableMicroMicroId)) {
    const row = rowById.get(id) || manualActiveRowFromId(id, requestedRows.length, new Set()) || null;

    if (!row) {
      rejectedRows.push({
        id,
        reason: 'MICRO_MICRO_ROW_NOT_FOUND_IN_PERSISTENT_LEARNING',
        microMicroRuntimeGate: {
          version: MICRO_MICRO_RUNTIME_GATE_VERSION,
          status: 'POLICY_BLOCKED',
          eligible: false,
          blocked: true,
          reason: 'MICRO_MICRO_ROW_NOT_FOUND_IN_PERSISTENT_LEARNING',
          reasons: ['MICRO_MICRO_ROW_NOT_FOUND_IN_PERSISTENT_LEARNING'],
          thresholds: activationGateConfig()
        }
      });
      continue;
    }

    requestedRows.push(row);

    if (row.microMicroRuntimeStatus === 'PASSED') {
      eligibleRows.push(row);
    } else {
      rejectedRows.push({
        id,
        reason: row.microMicroRuntimeReason || row.discordActivationBlockedReason || 'MICRO_MICRO_RUNTIME_GATE_REJECTED',
        reasons: row.microMicroRuntimeReasons || row.discordActivationBlockedReasons || [],
        status: row.microMicroRuntimeStatus,
        completed: row.completed,
        avgR: row.avgR,
        totalR: row.totalR,
        profitFactor: row.profitFactor,
        avgCostR: row.avgCostR,
        directSLPct: row.directSLPct,
        currentFit: row.currentFit,
        currentFitScore: row.currentFitScore,
        confirmationProfile: row.confirmationProfile,
        microMicroRuntimeGate: row.microMicroRuntimeGate || null,
        discordActivationGate: row.discordActivationGate || null
      });
    }
  }

  const eligibleIds = eligibleRows
    .map((row) => row.trueMicroFamilyId)
    .filter(Boolean)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);

  return {
    ok: eligibleIds.length > 0,
    eligibleIds,
    eligibleRows,
    rejectedRows,
    requestedRows,
    allAvailableRows: rows,
    activationSummary: activationSummary(rows)
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
  const includeAvailable = isTrue(firstValue(req.query?.includeAvailable, true), true);

  const [dashboard, activeRotationRaw] = await Promise.all([
    getRotationDashboard(rotationOptions()).catch(() => null),
    getActiveRotation(rotationOptions()).catch(() => null)
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
      ignoredLayerCounts: {},
      activationEligibleRows: 0,
      activationBlockedRows: 0,
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
      ignoredLayerCounts: {},
      activationEligibleRows: 0,
      activationBlockedRows: 0,
      rows: []
    };

  const availableRows = availableResult.rows || [];
  const activation = activationSummary(availableRows);

  const warnings = uniqueWarnings([
    availableResult.warning,
    availableResult.queryWeekKeyIgnored
      ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${availableResult.queryWeekKeyIgnored}`
      : null,
    (active.legacyChild75ActiveIdsIgnored || []).length > 0
      ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED:${active.legacyChild75ActiveIdsIgnored.length}`
      : null,
    active.activeRotationCleaned
      ? `OLD_ACTIVE_SELECTION_CLEANED_BLOCKED_IDS:${active.activeRotationBlockedFilteredCount}`
      : null,
    availableRows.length === 0 ? 'NO_AVAILABLE_EXPLICIT_MICRO_MICRO_ROWS' : null,
    availableRows.length > 0 && activation.eligible === 0 ? 'NO_PASSED_MICRO_MICRO_ROWS_NET_EDGE_GATE' : null
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
    activeTrueMicroMicroFamilyIds: active?.activeTrueMicroMicroFamilyIds || [],
    activeExactMicroMicroFamilyIds: active?.activeExactMicroMicroFamilyIds || [],
    selectedMicroMicroFamilyIds: active?.selectedMicroMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],
    legacyChild75ActiveIdsIgnored: active?.legacyChild75ActiveIdsIgnored || [],

    requestedActiveMicroMicroFamilyIds: active?.requestedActiveMicroMicroFamilyIds || [],
    filteredBlockedMicroMicroIds: active?.filteredBlockedMicroMicroIds || [],
    filteredBlockedMicroMicroRows: active?.filteredBlockedMicroMicroRows || [],
    activeRotationCleaned: Boolean(active?.activeRotationCleaned),
    activeRotationFilteredBlockedRedisSelections: Boolean(active?.activeRotationFilteredBlockedRedisSelections),
    activeRotationBlockedFilteredCount: active?.activeRotationBlockedFilteredCount || 0,

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

    microMicroRuntimeGateSummary: activation,
    discordActivationSummary: activation,
    discordActivationEligibleRows: activation.eligible,
    discordActivationBlockedRows: activation.blocked,
    discordActivationEligibleIds: activation.eligibleIds,
    topDiscordActivationEligibleIds: activation.topEligibleIds,

    sourceRows: {
      currentWeekRows: availableResult.currentRows,
      previousWeekRows: availableResult.previousRows,
      mergedRows: availableResult.mergedRows,
      ignoredLayerCounts: availableResult.ignoredLayerCounts || {},
      activationEligibleRows: availableResult.activationEligibleRows || 0,
      activationBlockedRows: availableResult.activationBlockedRows || 0,
      explicitMicroMicroOnly: true,
      child75ProxySelectionDisabled: true,
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
      activateVisibleIdsForDiscord: true,
      activateTop2VisibleRequiresNetEdge: true,
      activateTop2AdaptiveRequiresNetEdge: true
    },

    warnings,
    error: null,

    perf: {
      durationMs: now() - startedAt,
      source: 'short_manual_selection_exact_micro_micro_only_rotation_dashboard_admin_inline_runtime_gate'
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

  const activationValidation = await validateSelectedActivationIds(selected.acceptedIds);
  const activationIds = activationValidation.eligibleIds;

  if (!activationValidation.ok) {
    const activeRotationRaw = await getActiveRotation(rotationOptions()).catch(() => null);
    const active = compactActiveRotation(activeRotationRaw);

    return res.status(400).json({
      ok: false,
      fixed: true,
      reason: 'NO_ACTIVATION_ELIGIBLE_MICRO_MICRO_IDS_NET_EDGE_GATE',
      action,

      ...modeFlags(),
      taxonomy: taxonomyMeta(),

      requestedIds: selected.requestedIds,
      parsedAcceptedIds: selected.acceptedIds,
      acceptedIds: [],
      rejectedIds: activationValidation.rejectedRows.map((row) => row.id).filter(Boolean),
      activationRejectedRows: activationValidation.rejectedRows,
      ignoredRequestedIds: selected.ignoredRequestedIds,
      ignoredAboveLimitIds: selected.ignoredAboveLimitIds,

      activeRotation: active,
      active,
      activeRotationCleaned: Boolean(active?.activeRotationCleaned),
      filteredBlockedMicroMicroIds: active?.filteredBlockedMicroMicroIds || [],

      microMicroRuntimeGate: activationGateConfig(),
      discordActivationGate: activationGateConfig(),
      discordActivationSummary: activationValidation.activationSummary,

      expectedHardRules: [
        'completed >= 35',
        'avgR net > 0',
        'totalR net > 0',
        'profitFactor > 1',
        'avgCostR <= 0.35',
        'directSLPct <= 0.25',
        'currentFit != MISFIT',
        'confirmationProfile != E_WEAK_CONTRA'
      ],

      noSelectionMeansNoDiscord: true,

      perf: {
        durationMs: now() - startedAt,
        source: 'activateSelectedShortExactMicroMicro_rejected_by_admin_inline_runtime_gate'
      },

      serverTs: Date.now()
    });
  }

  const requestedWeekKey = String(firstValue(body.weekKey, PERSISTENT_LEARNING_KEY)).trim();
  const weekKey = PERSISTENT_LEARNING_KEY;
  const mode = normalizeMode(firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'), 'manual');
  const childIds = uniqueStrings(activationIds.map(getChildTrueMicroFamilyIdFromId).filter(Boolean));
  const parentIds = extractParentIdsFromIds(activationIds);

  const activation = await activateSelectedMicroFamilies({
    microFamilyIds: activationIds,
    trueMicroFamilyIds: activationIds,
    activeMicroFamilyIds: activationIds,
    ids: activationIds,

    microMicroFamilyIds: activationIds,
    trueMicroMicroFamilyIds: activationIds,
    exactMicroMicroFamilyIds: activationIds,
    activeMicroMicroFamilyIds: activationIds,
    activeTrueMicroMicroFamilyIds: activationIds,
    activeExactMicroMicroFamilyIds: activationIds,
    selectedMicroMicroFamilyIds: activationIds,
    selectedTrueMicroMicroFamilyIds: activationIds,
    selectedExactMicroMicroFamilyIds: activationIds,

    childTrueMicroFamilyIds: childIds,
    base75ChildTrueMicroFamilyIds: childIds,

    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    macroIds: [],
    parentTrueMicroFamilyIds: parentIds,

    maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxActiveDiscordMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,

    weekKey,
    mode,

    ...rotationOptions(),
    adminSelected: true,
    requestedWeekKeyIgnored: requestedWeekKey !== PERSISTENT_LEARNING_KEY ? requestedWeekKey : null
  });

  const activeRotationRaw = await getActiveRotation(rotationOptions()).catch(() => activation);
  const active = compactActiveRotation(activeRotationRaw || activation);

  if (!active?.activeMicroMicroFamilyIds?.length) {
    return res.status(400).json({
      ok: false,
      fixed: true,
      reason: 'ACTIVATION_RESULT_EMPTY_AFTER_RUNTIME_NET_EDGE_CLEANUP',
      action,

      ...modeFlags(),
      taxonomy: taxonomyMeta(),

      requestedIds: selected.requestedIds,
      parsedAcceptedIds: selected.acceptedIds,
      activationAcceptedIds: activationIds,
      rawActivation: activation,
      activeRotation: active,
      active,
      filteredBlockedMicroMicroIds: active?.filteredBlockedMicroMicroIds || [],

      noSelectionMeansNoDiscord: true,

      perf: {
        durationMs: now() - startedAt,
        source: 'activateSelectedShortExactMicroMicro_empty_after_admin_inline_cleanup'
      },

      serverTs: Date.now()
    });
  }

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

    parsedAcceptedIds: selected.acceptedIds,
    resolvedMicroFamilyIds: activationIds,
    resolvedTrueMicroFamilyIds: activationIds,
    resolvedMicroMicroFamilyIds: activationIds,
    resolvedChildTrueMicroFamilyIds: childIds,
    resolvedMacroFamilyIds: [],
    expandedFromMacro: [],
    unresolvedMacroFamilyIds: selected.requestedMacroFamilyIds,
    macroExpansionDisabled: true,
    parentExpansionDisabled: true,
    child75ActivationDisabled: true,

    acceptedIds: activationIds,
    activationAcceptedIds: activationIds,
    activationRejectedRows: activationValidation.rejectedRows,
    ignoredRequestedIds: [
      ...selected.ignoredRequestedIds,
      ...(Array.isArray(activation?.ignoredRequestedIds) ? activation.ignoredRequestedIds : [])
    ],
    ignoredAboveLimitIds: selected.ignoredAboveLimitIds,

    microMicroRuntimeGate: activationGateConfig(),
    discordActivationGate: activationGateConfig(),
    discordActivationSummary: activationValidation.activationSummary,

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
      source: 'activateSelectedShortExactMicroMicro_manual_only_exact_match_admin_inline_runtime_gate'
    },

    serverTs: Date.now()
  });
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'short-only-manual-selection-exact-micro-micro-only-v7-inline-runtime-gate');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');
  res.setHeader('X-Exact-True-Micro-Only', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
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
  res.setHeader('X-Child75-Proxy-Selection-Disabled', 'true');
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
  res.setHeader('X-Micro-Micro-Runtime-Gate-Version', MICRO_MICRO_RUNTIME_GATE_VERSION);
  res.setHeader('X-Micro-Micro-Best-Selector-Version', MICRO_MICRO_BEST_SELECTOR_VERSION);
  res.setHeader('X-Micro-Micro-Ranking-Order', 'PASSED>OBSERVING>REJECTED>POLICY_BLOCKED');
  res.setHeader('X-Discord-Activation-Gate-Version', DISCORD_ACTIVATION_GATE_VERSION);
  res.setHeader('X-Discord-Activation-Requires-Net-Edge', 'true');
  res.setHeader('X-Discord-Activation-Min-Completed', String(MIN_DISCORD_ACTIVATION_COMPLETED));
  res.setHeader('X-Discord-Activation-Min-AvgR', String(MIN_DISCORD_ACTIVATION_AVG_R));
  res.setHeader('X-Discord-Activation-Min-TotalR', String(MIN_DISCORD_ACTIVATION_TOTAL_R));
  res.setHeader('X-Discord-Activation-Min-ProfitFactor', String(MIN_DISCORD_ACTIVATION_PROFIT_FACTOR));
  res.setHeader('X-Discord-Activation-Max-AvgCostR', String(MAX_DISCORD_ACTIVATION_AVG_COST_R));
  res.setHeader('X-Discord-Activation-Max-DirectSLPct', String(MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT));
  res.setHeader('X-Discord-Activation-Blocks-E-Weak-Contra', String(BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION));
  res.setHeader('X-Admin-GET-Filters-Blocked-Active-Selections', 'true');
  res.setHeader('X-Admin-POST-Rejects-Blocked-Selections', 'true');
}

export default async function handler(req, res) {
  setHeaders(res);

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    return methodNotAllowed(res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      ...modeFlags(),
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}