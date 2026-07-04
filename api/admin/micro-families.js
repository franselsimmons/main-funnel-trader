// ================= FILE: api/admin/micro-families.js =================
//
// SHORT-only micro-micro admin endpoint.
//
// Doel:
// - Dashboard toont alleen exacte SHORT micro-micro rows.
// - Parent 15 blijft verborgen metadata/context.
// - 75-child blijft verborgen context/rollup.
// - Geen child75 proxy rows.
// - Geen scanner fingerprints.
// - Geen raw XR execution fingerprints.
// - Geen LONG rows.
// - Geen real orders.
// - Learning blijft broad in backend, maar admin-selectie is exact micro-micro only.
//
// Selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
// - MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_{CONTEXT_TAGS}
//   wordt genormaliseerd naar canonical MICRO_SHORT_..._MM_{HASH}

import { sideToTradeSide, safeNumber } from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

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
const CURRENT_FIT_VERSION = 'SHORT_CURRENTFIT_MARKETWEATHER_SOFT_ADMIN_V5';

const DISCORD_ACTIVATION_GATE_VERSION = 'SHORT_MM_DISCORD_ACTIVATION_NET_EDGE_GATE_V1';
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const MIN_DISCORD_ACTIVATION_COMPLETED = 35;
const MIN_DISCORD_ACTIVATION_AVG_R = 0;
const MIN_DISCORD_ACTIVATION_TOTAL_R = 0;
const MIN_DISCORD_ACTIVATION_PROFIT_FACTOR = 1;
const MAX_DISCORD_ACTIVATION_AVG_COST_R = 0.35;
const MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT = 0.25;
const BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION = true;
const BLOCK_MISFIT_FOR_DISCORD_ACTIVATION = true;

const MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES = 2;
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 300;
const DEFAULT_BEST_LIMIT = 120;
const MAX_BEST_LIMIT = 300;
const WEEK_MICROS_TIMEOUT_MS = 8_500;
const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const CACHE_TTL_MS = 45_000;
const CACHE_MAX_KEYS = 8;

const DEFAULT_RANK_MODE = 'adaptive';
const VALID_MODES = new Set([
  'adaptive',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed',
  'cost',
  'currentFit',
  'microMicro',
  'clean'
]);

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

const cache = globalThis.__ADMIN_MICRO_FAMILIES_SHORT_EXACT_MM_V5_CACHE__ ||= {
  weekMicros: new Map()
};

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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (!hasValue(value)) return fallback;
  return value;
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

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const out = [];

  while (stack.length) {
    const value = stack.shift();
    if (Array.isArray(value)) stack.unshift(...value);
    else out.push(value);
  }

  return out;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];

  for (const value of flattenValues(values)) {
    const parts = typeof value === 'string'
      ? value.split(/[\s,;\n\r]+/g)
      : [value];

    for (const part of parts) {
      const clean = String(part || '').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
  }

  return out;
}

function uniqueWarnings(values = []) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) {
    return micros.map((row, index) => [
      row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.microFamilyId || String(index),
      row
    ]);
  }

  if (!micros || typeof micros !== 'object') return [];
  return Object.entries(micros);
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, Math.max(1, timeoutMs));
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  return raw.length >= 3 ? raw.slice(0, MICRO_MICRO_HASH_LEN) : '';
}

function modePayload() {
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

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    virtualPositionsOnly: true,

    noRealOrders: true,
    noExchangeOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    netOutcomesOnly: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRSource: 'costR',
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    manualSelectionOnly: true,
    manualSelectionRequired: true,
    autoRotationActivationDisabled: true,

    maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
    maxActiveDiscordMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',

    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    child75MatchDoesNotTriggerDiscord: true,
    scannerMatchDoesNotTriggerDiscord: true,
    executionFingerprintMatchDoesNotTriggerDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'METADATA_TO_MICRO_MICRO_CONTEXT_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    child75ContextFamilyCount: 75,
    selectableChildMicroFamilyCount: 0,
    selectableMicroMicroOnly: true,
    selectableChild75Allowed: false,
    selectableParentAllowed: false,

    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    child75FamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    microMicroFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',

    learningRemainsBroad: true,
    parent15StillMetadataOnly: true,
    child75StillContextOnly: true,
    child75HiddenFromAdminRows: true,
    parent15HiddenFromAdminRows: true,
    child75ProxyRowsDisabled: true,
    microMicroLayerEnabled: true,
    microMicroActsAsExecutionPreference: true,
    microMicroSelectionOnly: true,

    currentFitVersion: CURRENT_FIT_VERSION,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscordOnly: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    discordActivationRequiresNetEdge: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,

    adaptiveLayerBuilt: true,
    currentFitScoreBuilt: true,
    microMicroLayerBuilt: true,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: POSITION_COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    rankingPrimary: 'ADAPTIVE_THEN_FAIR_WINRATE_THEN_NET_TOTALR',
    rankingDefaultMode: DEFAULT_RANK_MODE,
    rankingPnlSource: 'totalR',
    rankingWinrateSource: 'fairWinrate',

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
    positionTimeStopMinDefault: 720,

    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
  };
}

function activationGateConfig() {
  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    minCompleted: MIN_DISCORD_ACTIVATION_COMPLETED,
    minAvgR: MIN_DISCORD_ACTIVATION_AVG_R,
    minTotalR: MIN_DISCORD_ACTIVATION_TOTAL_R,
    minProfitFactor: MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
    maxAvgCostR: MAX_DISCORD_ACTIVATION_AVG_COST_R,
    maxDirectSLPct: MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,
    blockEWeakContra: BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION,
    blockMisfit: BLOCK_MISFIT_FOR_DISCORD_ACTIVATION,
    rule: 'completed>=35 && avgR>0 && totalR>0 && profitFactor>1 && avgCostR<=0.35 && directSLPct<=0.25 && currentFit!=MISFIT && confirmationProfile!=E_WEAK_CONTRA'
  };
}

function normalizeMode(value) {
  const raw = String(value || DEFAULT_RANK_MODE).trim();
  const rawLower = lower(raw);

  if (VALID_MODES.has(raw)) return raw;
  if (rawLower === 'totalr') return 'totalR';
  if (rawLower === 'avgr') return 'avgR';
  if (rawLower === 'directsl') return 'directSL';
  if (rawLower === 'currentfit') return 'currentFit';
  if (rawLower === 'micromicro') return 'microMicro';

  return VALID_MODES.has(rawLower) ? rawLower : DEFAULT_RANK_MODE;
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
    confirmationProfile: null,
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
  if (value.includes('MICRO_LONG_') || value.startsWith('MM_LONG_')) {
    return invalidParsed(rawId, 'LONG_DISABLED_SHORT_ONLY');
  }
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
      ? normalizeMicroMicroHash(context)
      : normalizeMicroMicroHash(context || parsed.rest) || stableHash10(value);
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
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : isChild ? TRUE_MICRO_SCHEMA : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : isChild ? TRUE_MICRO_SCHEMA : PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : isChild ? CHILD75_LEARNING_GRANULARITY : PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
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

function isMicroMicroFamilyId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isSelectableMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.isMicroMicro === true && parsed.selectable === true;
}

function validLearningId(id = '') {
  const value = String(id || '').trim();
  if (!value) return false;
  if (isScannerFingerprintId(value) || isExecutionFingerprintId(value)) return false;
  return parseShortTaxonomyMicroId(value).valid === true;
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
    row.executionMicroMicroFamilyId,
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
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
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

  for (const field of [
    input.tradeSide,
    input.targetTradeSide,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.dashboardSide,
    input.side,
    input.bias,
    input.marketBias
  ]) {
    const side = normalizeDirectSide(field);
    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const text = upper([
    input.microFamilyId,
    input.trueMicroFamilyId,
    input.learningFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.base75ChildTrueMicroFamilyId,
    input.microMicroFamilyId,
    input.trueMicroMicroFamilyId,
    input.exactMicroMicroFamilyId,
    input.parentTrueMicroFamilyId,
    input.coarseMicroFamilyId,
    input.id,
    input.key,
    input.definition,
    input.microDefinition,
    input.microMicroDefinition,
    input.macroDefinition,
    input.parentDefinition
  ].filter(Boolean).join(' | '));

  if (text.includes('MICRO_LONG_') || text.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
  if (text.includes('MICRO_SHORT_') || text.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isMicroMicroAnalyzeRow(row = {}) {
  const id = getExplicitMicroMicroId(row, row?.key);
  if (!id) return false;
  if (!validLearningId(id) || !isMicroMicroFamilyId(id)) return false;
  if (row.legacyScannerFamilyFallback === true || row.scannerFingerprintLegacy === true) return false;
  return isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id });
}

function getOutcomeCounts(row = {}) {
  const wins = Math.max(0, num(row.virtualWins, 0) + num(row.shadowWins, 0), num(row.wins, 0));
  const losses = Math.max(0, num(row.virtualLosses, 0) + num(row.shadowLosses, 0), num(row.losses, 0));
  const flats = Math.max(0, num(row.virtualFlats, 0) + num(row.shadowFlats, 0), num(row.flats, 0));

  const virtualShadowCompleted = num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0);
  const completed = Math.max(
    wins + losses + flats,
    virtualShadowCompleted,
    num(row.completed, 0),
    num(row.outcomeSample, 0)
  );

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, completed - wins - losses)),
    total: completed
  };
}

function getCompletedSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.observationSample, 0),
    num(row.seen, 0),
    num(row.observations, 0),
    getCompletedSample(row),
    0
  );
}

function getObservationDuplicateSkippedCount(row = {}) {
  return Math.max(
    num(row.observationDuplicateSkippedCount, 0),
    num(row.duplicateObservationsSkipped, 0),
    num(row.seenDuplicateSkippedCount, 0),
    0
  );
}

function getSeenCompletedRatio(row = {}) {
  const completed = getCompletedSample(row);
  return completed <= 0 ? getObservationSample(row) : getObservationSample(row) / completed;
}

function getTotalR(row = {}) {
  const completed = getCompletedSample(row);
  if (completed <= 0) return 0;

  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;

  const direct = row.shortNetTotalR ?? row.netShortTotalR ?? row.netTotalR ?? row.totalNetR ?? row.totalR;
  if (hasValue(direct)) return num(direct, 0);

  const avg = row.avgNetR ?? row.netAvgR ?? row.avgR;
  if (hasValue(avg)) return num(avg, 0) * completed;

  return 0;
}

function getAvgR(row = {}) {
  const completed = getCompletedSample(row);
  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR) && !hasValue(row.totalR) && !hasValue(row.netTotalR) && !hasValue(row.totalNetR)) {
    return num(row.avgR, 0);
  }

  return getTotalR(row) / completed;
}

function getTotalCostR(row = {}) {
  const completed = getCompletedSample(row);
  if (completed <= 0) return 0;

  const virtualShadowCost = Math.max(0, num(row.virtualTotalCostR, 0)) + Math.max(0, num(row.shadowTotalCostR, 0));
  if (virtualShadowCost > 0) return virtualShadowCost;

  if (hasValue(row.totalCostR)) return Math.max(0, num(row.totalCostR, 0));
  if (hasValue(row.totalNetCostR)) return Math.max(0, num(row.totalNetCostR, 0));
  if (hasValue(row.avgCostR)) return Math.max(0, num(row.avgCostR, 0)) * completed;
  if (hasValue(row.costR)) return Math.max(0, num(row.costR, 0)) * completed;

  return 0;
}

function getAvgCostR(row = {}) {
  const completed = getCompletedSample(row);
  return completed > 0 ? getTotalCostR(row) / completed : 0;
}

function getDirectSLCount(row = {}) {
  return Math.max(
    0,
    num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0),
    num(row.directSLCount, 0),
    num(row.directToSLCount, 0)
  );
}

function getDirectSLPct(row = {}) {
  const completed = getCompletedSample(row);
  return completed > 0 ? clamp(getDirectSLCount(row) / completed, 0, 1) : 0;
}

function getProfitFactor(row = {}) {
  if (hasValue(row.netProfitFactor)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor)) return num(row.profitFactor, 0);

  const winR = Math.max(
    num(row.virtualWinR, 0) + num(row.shadowWinR, 0),
    num(row.netWinR, 0),
    num(row.totalWinR, 0),
    num(row.grossWinR, 0),
    0
  );

  const lossR = Math.max(
    Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)),
    Math.abs(num(row.netLossR, 0)),
    Math.abs(num(row.totalLossR, 0)),
    Math.abs(num(row.grossLossR, 0)),
    0
  );

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
  return n > 0 ? clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1) : 0;
}

function getSampleAdjustedWinrate(row = {}) {
  const counts = getOutcomeCounts(row);
  const completed = counts.total;
  const observationSample = getObservationSample(row);

  if (completed <= 0) {
    return {
      sample: observationSample,
      outcomeSample: 0,
      observationSample,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(observationSample),
      score: 0,
      awaitingOutcomes: observationSample > 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / completed, 0, 1);
  const bayesianWinrate = clamp((successes + 1) / (completed + 2), 0, 1);
  const wilson = wilsonLowerBound(successes, completed);
  const reliability = sampleReliability(completed);
  const score = clamp(wilson * 0.8 + bayesianWinrate * 0.15 + rawWinrate * 0.05, 0, 1);

  return {
    sample: completed,
    outcomeSample: completed,
    observationSample,
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

function getDashboardBalancedScore(row = {}, winrateMeta = null) {
  const winrate = winrateMeta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample <= 0 && winrate.observationSample > 0) {
    return Math.min(45, Math.log1p(winrate.observationSample) * 8 + winrate.reliability * 18);
  }

  return (
    winrate.score * 100 +
    winrate.reliability * 20 +
    Math.log1p(Math.max(0, getTotalR(row))) * 12 +
    Math.log1p(Math.max(0, getAvgR(row))) * 8 +
    Math.log1p(Math.min(Math.max(0, getProfitFactor(row)), 20)) * 3 -
    getDirectSLPct(row) * 60 -
    getAvgCostR(row) * 3
  );
}

function learningStatusFor(row = {}, winrateMeta = null) {
  const winrate = winrateMeta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO_ACTIVE';
  if (winrate.outcomeSample > 0) return 'MICRO_MICRO_EARLY';
  return 'MICRO_MICRO_OBSERVING';
}

function tierFor(row = {}, winrateMeta = null) {
  const winrate = winrateMeta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO';
  if (winrate.outcomeSample > 0) return 'MICRO_MICRO_SOFT';
  if (winrate.observationSample > 0) return 'OBSERVATION';
  return 'RAW';
}

function normalizeCurrentFitLabel(value = '') {
  const raw = upper(value);

  if (['FIT', 'MATCH', 'GOOD', 'ALIGNED', 'STRONG_MATCH'].includes(raw)) return 'FIT';
  if (['OK', 'WEAK_MATCH', 'PARTIAL_MATCH', 'SOFT_MATCH'].includes(raw)) return 'OK';
  if (['MISFIT', 'BAD', 'AGAINST', 'CONTRA', 'NO_FIT'].includes(raw)) return 'MISFIT';
  if (['NEUTRAL', 'MIXED'].includes(raw)) return 'NEUTRAL';

  return raw || 'UNKNOWN';
}

function currentFitLabelFromScore(score = 0, fallback = 'UNKNOWN') {
  const parsed = Number(score);
  if (!Number.isFinite(parsed)) return normalizeCurrentFitLabel(fallback);
  if (parsed >= 45) return 'FIT';
  if (parsed >= 20) return 'OK';
  if (parsed <= -20) return 'MISFIT';
  return 'NEUTRAL';
}

function getShortCurrentFit(row = {}) {
  const directShort = [
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore
  ].find((value) => Number.isFinite(Number(value)));

  if (hasValue(directShort)) {
    const score = Number(directShort);
    return {
      currentFit: currentFitLabelFromScore(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      currentFitLabel: currentFitLabelFromScore(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      currentFitScore: round(score, 4),
      fitScore: round(score, 4),
      shortCurrentFit: round(score, 4),
      bearCurrentFit: round(score, 4),
      currentFitSource: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const direct = [
    row.currentFitScore,
    row.entryCurrentFitScore,
    row.marketFitScore,
    row.currentMarketFitScore,
    row.fitScore
  ].find((value) => Number.isFinite(Number(value)));

  if (hasValue(direct)) {
    const rawScore = Number(direct);
    const polarity = upper(row.currentFitPolarity || row.currentFitDefinition || '');
    const haystack = upper([
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
    ].filter(Boolean).join('|'));

    let score = rawScore;

    if (!polarity.includes('BEARISH_POSITIVE_BULLISH_NEGATIVE') && !polarity.includes('SHORT_MIRRORED_CURRENT_FIT')) {
      if (haystack.includes('BULL') || haystack.includes('LONG') || haystack.includes('BUY')) {
        score = -Math.abs(rawScore);
      } else if (haystack.includes('BEAR') || haystack.includes('SHORT') || haystack.includes('SELL')) {
        score = Math.abs(rawScore);
      }
    }

    return {
      currentFit: currentFitLabelFromScore(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      currentFitLabel: currentFitLabelFromScore(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      currentFitScore: round(score, 4),
      fitScore: round(score, 4),
      shortCurrentFit: round(score, 4),
      bearCurrentFit: round(score, 4),
      currentFitSource: 'MIRRORED_GENERIC_CURRENT_FIT'
    };
  }

  const label = normalizeCurrentFitLabel(row.currentFitLabel || row.currentFit || row.fitLabel || row.marketFit || 'UNKNOWN');

  return {
    currentFit: label,
    currentFitLabel: label,
    currentFitScore: 0,
    fitScore: 0,
    shortCurrentFit: 0,
    bearCurrentFit: 0,
    currentFitSource: 'NO_NUMERIC_CURRENT_FIT'
  };
}

function getShortRiskGeometry(row = {}) {
  const entry = Number(row.entryPrice ?? row.entry ?? row.avgEntryPrice ?? row.averageEntryPrice ?? row.openPrice);
  const initialSl = Number(row.initialSl ?? row.initialSL ?? row.initialStopLoss ?? row.stopLoss ?? row.stopLossPrice ?? row.sl ?? row.slPrice);
  const tp = Number(row.tp ?? row.takeProfit ?? row.takeProfitPrice ?? row.targetPrice ?? row.finalTp);
  const exitPrice = Number(row.exitPrice ?? row.closePrice ?? row.closedPrice ?? row.outcomePrice ?? row.exit);
  const currentPrice = Number(row.currentPrice ?? row.markPrice ?? row.lastPrice ?? row.price);

  const denominator = Number.isFinite(entry) && Number.isFinite(initialSl) ? initialSl - entry : 0;
  const validGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(initialSl) &&
    Number.isFinite(tp) &&
    denominator > 0 &&
    tp < entry &&
    entry < initialSl;

  const shortGrossR = validGeometry && Number.isFinite(exitPrice) ? (entry - exitPrice) / denominator : null;
  const shortCurrentR = validGeometry && Number.isFinite(currentPrice) ? (entry - currentPrice) / denominator : null;

  return {
    entry: Number.isFinite(entry) ? entry : null,
    initialSl: Number.isFinite(initialSl) ? initialSl : null,
    tp: Number.isFinite(tp) ? tp : null,
    exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    denominator,
    validGeometry,
    shortGrossR,
    shortCurrentR,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}

function cleanMeasurementScore(row = {}) {
  if (row.measurementClean === true || row.cleanMeasurement === true || row.cleanLearningRow === true) return 1;

  const fix = String(row.measurementFixVersion || row.measurementVersion || '').trim();
  const cost = String(row.costModelVersion || row.positionCostModelVersion || '').trim();
  const obs = String(row.observationDedupeVersion || row.obsDedupeVersion || '').trim();
  const out = String(row.outcomeDedupeVersion || row.outcomeDeduplicationVersion || '').trim();

  const fixOk = !fix || fix === MEASUREMENT_FIX_VERSION || fix.includes('CANDLE_FIRST_TOUCH');
  const costOk = !cost || cost === POSITION_COST_MODEL_VERSION;
  const obsOk = !obs || obs === OBSERVATION_DEDUPE_VERSION || obs.includes('OBS_DEDUPE');
  const outOk = !out || out === OUTCOME_DEDUPE_VERSION || out.includes('OUTCOME_DEDUPE');

  return fixOk && costOk && obsOk && outOk ? 1 : 0;
}

function getRankWinrate(row = {}) {
  return num(
    row.fairWinrate ??
    row.sampleAdjustedWinrate ??
    row.sampleWilsonLowerBound ??
    row.wilsonLowerBound ??
    row.sampleBayesianWinrate ??
    row.bayesianWinrate ??
    row.winrate,
    0
  );
}

function learningQualityRank(row = {}) {
  const completed = num(row.outcomeSample ?? getCompletedSample(row), 0);
  const observed = num(row.observationSample ?? getObservationSample(row), 0);

  if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 4;
  if (completed > 0) return 2.5;
  if (observed > 0) return 1.2;

  return 0;
}

function compareNumberDesc(a, b) {
  return num(b, 0) - num(a, 0);
}

function compareNumberAsc(a, b) {
  return num(a, 0) - num(b, 0);
}

function compareIdAsc(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function compareRowsBase(a, b) {
  const aCompleted = num(a.outcomeSample ?? getCompletedSample(a), 0);
  const bCompleted = num(b.outcomeSample ?? getCompletedSample(b), 0);

  return (
    compareNumberDesc(cleanMeasurementScore(a), cleanMeasurementScore(b)) ||
    compareNumberDesc(aCompleted >= MIN_COMPLETED_MICRO_MICRO_ACTIVE ? 1 : 0, bCompleted >= MIN_COMPLETED_MICRO_MICRO_ACTIVE ? 1 : 0) ||
    compareNumberDesc(getRankWinrate(a), getRankWinrate(b)) ||
    compareNumberDesc(getTotalR(a) > 0 ? 1 : 0, getTotalR(b) > 0 ? 1 : 0) ||
    compareNumberDesc(getTotalR(a), getTotalR(b)) ||
    compareNumberDesc(getAvgR(a), getAvgR(b)) ||
    compareNumberDesc(getProfitFactor(a), getProfitFactor(b)) ||
    compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) ||
    compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) ||
    compareNumberDesc(aCompleted, bCompleted) ||
    compareNumberDesc(a.observationSample ?? getObservationSample(a), b.observationSample ?? getObservationSample(b)) ||
    compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId)
  );
}

function compareRowsByMode(a, b, mode = DEFAULT_RANK_MODE) {
  if (mode === 'clean') return compareNumberDesc(cleanMeasurementScore(a), cleanMeasurementScore(b)) || compareRowsBase(a, b);
  if (mode === 'totalR') return compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) || compareNumberDesc(getTotalR(a), getTotalR(b)) || compareRowsBase(a, b);
  if (mode === 'avgR') return compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) || compareNumberDesc(getAvgR(a), getAvgR(b)) || compareRowsBase(a, b);
  if (mode === 'directSL') return compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) || compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) || compareRowsBase(a, b);
  if (mode === 'observed') return compareNumberDesc(a.observationSample ?? getObservationSample(a), b.observationSample ?? getObservationSample(b)) || compareRowsBase(a, b);
  if (mode === 'cost') return compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) || compareRowsBase(a, b);
  if (mode === 'currentFit') return compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) || compareRowsBase(a, b);
  if (mode === 'balanced') return compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) || compareRowsBase(a, b);
  if (mode === 'adaptive') return compareNumberDesc(a.adaptiveScore, b.adaptiveScore) || compareRowsBase(a, b);

  return compareRowsBase(a, b);
}

function discordActivationGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row.key);
  const parsed = parseShortTaxonomyMicroId(id);
  const fit = getShortCurrentFit(row);

  const completed = getCompletedSample(row);
  const observed = getObservationSample(row);
  const netAvgR = getAvgR(row);
  const netTotalR = getTotalR(row);
  const pf = getProfitFactor(row);
  const cost = getAvgCostR(row);
  const dsl = getDirectSLPct(row);
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);

  const reasons = [];

  if (!id || !isSelectableMicroMicroId(id)) reasons.push('EXACT_MICRO_MICRO_ID_REQUIRED');
  if (observed <= 0 && completed <= 0) reasons.push('NO_PERSISTENT_STATS_FOR_MICRO_MICRO_ID');
  if (completed < MIN_DISCORD_ACTIVATION_COMPLETED) reasons.push(`COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`);
  if (!(netAvgR > MIN_DISCORD_ACTIVATION_AVG_R)) reasons.push('AVG_R_NET_NOT_POSITIVE');
  if (!(netTotalR > MIN_DISCORD_ACTIVATION_TOTAL_R)) reasons.push('TOTAL_R_NET_NOT_POSITIVE');
  if (!(pf > MIN_DISCORD_ACTIVATION_PROFIT_FACTOR)) reasons.push('PROFIT_FACTOR_NOT_ABOVE_1');
  if (cost > MAX_DISCORD_ACTIVATION_AVG_COST_R) reasons.push('AVG_COST_R_TOO_HIGH');
  if (dsl > MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT) reasons.push('DIRECT_SL_PCT_TOO_HIGH');

  if (BLOCK_MISFIT_FOR_DISCORD_ACTIVATION && upper(fit.currentFitLabel) === 'MISFIT') {
    reasons.push('CURRENTFIT_MISFIT_BLOCKS_DISCORD');
  }

  if (BLOCK_E_WEAK_CONTRA_FOR_DISCORD_ACTIVATION && confirmationProfile === 'E_WEAK_CONTRA') {
    reasons.push('E_WEAK_CONTRA_BLOCKED_FOR_DISCORD_ACTIVATION');
  }

  const eligible = reasons.length === 0;

  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    eligible,
    blocked: !eligible,
    reason: eligible ? 'DISCORD_ACTIVATION_ELIGIBLE_NET_EDGE_CONFIRMED' : reasons[0],
    reasons,
    id,
    completed: round(completed, 4),
    observed: round(observed, 4),
    avgR: round(netAvgR, 4),
    totalR: round(netTotalR, 4),
    profitFactor: round(pf, 4),
    avgCostR: round(cost, 4),
    directSLPct: round(dsl, 4),
    currentFit: fit.currentFitLabel || 'UNKNOWN',
    currentFitScore: round(fit.currentFitScore, 4),
    confirmationProfile,
    thresholds: activationGateConfig()
  };
}

function normalizeMicroMicroRow(row = {}, index = 0, activeSet = new Set(), activeParentSet = new Set(), compact = true) {
  const id = getExplicitMicroMicroId(row, row.key);
  const parsed = parseShortTaxonomyMicroId(id);

  if (!parsed.isMicroMicro) return null;
  if (!isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id })) return null;

  const winrate = getSampleAdjustedWinrate(row);
  const completed = winrate.outcomeSample;
  const observed = winrate.observationSample;
  const riskGeometry = getShortRiskGeometry(row);
  const fit = getShortCurrentFit(row);
  const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);
  const gate = discordActivationGate({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id });

  const adaptiveScore =
    num(row.adaptiveScore, NaN) ||
    dashboardBalancedScore +
      num(fit.currentFitScore, 0) * 0.15 +
      winrate.reliability * 10 -
      getDirectSLPct(row) * 10 -
      getAvgCostR(row) * 2 -
      (cleanMeasurementScore(row) === 1 ? 0 : 25);

  const parentId = parsed.parentTrueMicroFamilyId;
  const childId = parsed.childTrueMicroFamilyId;
  const status = learningStatusFor(row, winrate);
  const tier = row.selectedTier || row.rotationEligibilityTier || tierFor(row, winrate);

  const normalized = {
    ...row,
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

    childTrueMicroFamilyId: childId,
    base75ChildTrueMicroFamilyId: childId,
    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,
    baseMicroFamilyId: parentId,
    legacyMicroFamilyId: parentId,
    familyId: parentId,
    macroFamilyId: parentId,
    parentMacroFamilyId: parentId,
    parentMicroFamilyId: parentId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    taxonomySetup: parsed.setup,
    taxonomyRegime: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroHash: parsed.microMicroHash,
    microMicroContext: parsed.microMicroContext,

    ...modePayload(),

    fixedTaxonomyLearningId: true,
    selectableTrueMicroFamily: true,
    selectableMicroMicro: true,
    selectableMicroMicroFamily: true,
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
    generatedMicroMicroFromChild75: false,
    child75ProxySelectionDisabled: true,
    microMicroStatsSource: row.microMicroStatsSource || 'EXPLICIT_MICRO_MICRO_ROW',

    active: Boolean(row.active || activeSet.has(id)),
    macroActive: Boolean(row.macroActive || activeParentSet.has(parentId)),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),
    observationSample: round(observed, 4),
    outcomeSample: round(completed, 4),
    completed: round(completed, 4),
    virtualCompleted: round(row.virtualCompleted, 4),
    shadowCompleted: round(row.shadowCompleted, 4),
    realCompleted: 0,

    observationDuplicateSkippedCount: round(getObservationDuplicateSkippedCount(row), 4),
    seenCompletedRatio: round(getSeenCompletedRatio(row), 4),
    awaitingOutcomes: Boolean(winrate.awaitingOutcomes),

    wins: round(winrate.wins, 4),
    losses: round(winrate.losses, 4),
    flats: round(winrate.flats, 4),

    winrateSample: round(winrate.sample, 4),
    winrate: round(winrate.rawWinrate, 4),
    sampleRawWinrate: round(winrate.rawWinrate, 4),
    bayesianWinrate: round(winrate.bayesianWinrate, 4),
    sampleBayesianWinrate: round(winrate.bayesianWinrate, 4),
    wilsonLowerBound: round(winrate.wilsonLowerBound, 4),
    sampleWilsonLowerBound: round(winrate.wilsonLowerBound, 4),
    sampleReliability: round(winrate.reliability, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),

    totalR: round(getTotalR(row), 4),
    avgR: round(getAvgR(row), 4),
    profitFactor: round(getProfitFactor(row), 4),
    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),
    directSLCount: round(getDirectSLCount(row), 4),
    directSLPct: round(getDirectSLPct(row), 4),

    dashboardBalancedScore: round(row.dashboardBalancedScore ?? dashboardBalancedScore, 4),
    balancedScore: round(row.balancedScore ?? dashboardBalancedScore, 4),
    adaptiveScore: round(row.adaptiveScore ?? adaptiveScore, 4),

    ...fit,
    currentFitConfidence: round(row.currentFitConfidence ?? Math.min(1, Math.abs(num(fit.currentFitScore, 0)) / 100), 4),
    currentFitReason: row.currentFitReason || fit.currentFitSource,
    currentFitReasons: Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [fit.currentFitSource],
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitBlocksDiscord: fit.currentFitLabel === 'MISFIT',
    discordCurrentFitAllowed: fit.currentFitLabel !== 'MISFIT',

    status,
    learningStatus: status,
    tier,
    selectedTier: tier,
    rotationEligibilityTier: tier,
    tooEarly: completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    tooEarlyReason: completed < MIN_COMPLETED_MICRO_MICRO_ACTIVE
      ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`
      : null,
    minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    discordActivationEligible: gate.eligible,
    discordActivationBlocked: gate.blocked,
    discordActivationReason: gate.reason,
    discordActivationBlockedReason: gate.blocked ? gate.reason : null,
    discordActivationBlockedReasons: gate.reasons,
    discordActivationGate: gate,
    activationEligible: gate.eligible,
    activationBlocked: gate.blocked,
    activationBlockedReason: gate.blocked ? gate.reason : null,

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortGeometry: Boolean(riskGeometry.validGeometry),
    shortValidGeometry: Boolean(riskGeometry.validGeometry),
    riskGeometryRule: riskGeometry.riskGeometryRule,
    tpHitRule: riskGeometry.tpHitRule,
    slHitRule: riskGeometry.slHitRule,
    grossRFormula: riskGeometry.grossRFormula,
    currentRFormula: riskGeometry.currentRFormula,
    shortGrossR: round(riskGeometry.shortGrossR ?? row.shortGrossR ?? row.grossR, 4),
    shortCurrentR: round(riskGeometry.shortCurrentR ?? row.shortCurrentR ?? row.currentR, 4),
    currentR: round(riskGeometry.shortCurrentR ?? row.currentR, 4),

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: row.executionMicroFamilyId || null,
    executionFingerprintHash: row.executionFingerprintHash || parsed.microMicroHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [],
    executionFingerprintRole: 'METADATA_TO_MICRO_MICRO_CONTEXT_ONLY',
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

    measurementClean: cleanMeasurementScore(row) === 1,
    cleanMeasurement: cleanMeasurementScore(row) === 1,

    definition: row.definition || row.microDefinition || '',
    microDefinition: row.microDefinition || row.definition || '',
    microMicroDefinition: row.microMicroDefinition || '',
    definitionParts: Array.isArray(row.definitionParts) ? row.definitionParts : [],
    microDefinitionParts: Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : [],
    microMicroDefinitionParts: Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [],

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  if (compact) {
    delete normalized.recentOutcomes;
    delete normalized.examples;
    delete normalized.counters;
    delete normalized.rawCandles;
    delete normalized.rawKlines;
  }

  return normalized;
}

function hiddenLayerCountsFromMicros(micros = {}) {
  const counts = {
    parent15: 0,
    child75: 0,
    microMicro: 0,
    scanner: 0,
    executionFingerprint: 0,
    long: 0,
    unknown: 0
  };

  for (const [key, row] of sourceEntriesFromMicros(micros)) {
    const idText = row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.microFamilyId || key || '';
    const parsed = parseShortTaxonomyMicroId(idText);

    if (inferTradeSide({ ...row, key }) === OPPOSITE_TRADE_SIDE || parsed.reason === 'LONG_DISABLED_SHORT_ONLY') {
      counts.long += 1;
    } else if (isScannerFingerprintId(idText) || isScannerFingerprintId(key)) {
      counts.scanner += 1;
    } else if (isExecutionFingerprintId(idText) || isExecutionFingerprintId(key)) {
      counts.executionFingerprint += 1;
    } else if (parsed.isMicroMicro) {
      counts.microMicro += 1;
    } else if (parsed.isChild) {
      counts.child75 += 1;
    } else if (parsed.isParent) {
      counts.parent15 += 1;
    } else {
      counts.unknown += 1;
    }
  }

  return counts;
}

function buildMicroMicroRowsFromMicros(micros = {}, activeSet = new Set(), activeParentSet = new Set(), compact = true) {
  const rows = [];
  const seen = new Set();

  for (const [key, row] of sourceEntriesFromMicros(micros)) {
    if (!row || typeof row !== 'object') continue;

    const id = getExplicitMicroMicroId({ ...row, key }, key);
    if (!id || !isSelectableMicroMicroId(id)) continue;

    if (seen.has(id)) continue;
    seen.add(id);

    const normalized = normalizeMicroMicroRow({
      ...row,
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
      generatedMicroMicroFromChild75: false,
      child75ProxySelectionDisabled: true,
      microMicroStatsSource: 'EXPLICIT_MICRO_MICRO_ROW',
      sourceWeekKey: PERSISTENT_LEARNING_KEY,
      sourceWeekPrimary: true,
      active: activeSet.has(id)
    }, rows.length, activeSet, activeParentSet, compact);

    if (normalized) rows.push(normalized);
  }

  return rows;
}

function normalizeActiveRotationObject(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;
  return rotation.activeRotation || rotation.active || rotation.rotation || rotation;
}

function extractActiveMicroMicroIds(activeRotationRaw = null) {
  const activeRotation = normalizeActiveRotationObject(activeRotationRaw);
  if (!activeRotation) return [];

  const rows = [
    ...(Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : []),
    ...(Array.isArray(activeRotation.rows) ? activeRotation.rows : []),
    ...(Array.isArray(activeRotation.activeRows) ? activeRotation.activeRows : []),
    ...(Array.isArray(activeRotation.selectedRows) ? activeRotation.selectedRows : [])
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
    .filter((id) => inferTradeSide(id) !== OPPOSITE_TRADE_SIDE)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractLegacyActiveChild75Ids(activeRotationRaw = null) {
  const activeRotation = normalizeActiveRotationObject(activeRotationRaw);
  if (!activeRotation) return [];

  const rows = [
    ...(Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : []),
    ...(Array.isArray(activeRotation.rows) ? activeRotation.rows : []),
    ...(Array.isArray(activeRotation.activeRows) ? activeRotation.activeRows : []),
    ...(Array.isArray(activeRotation.selectedRows) ? activeRotation.selectedRows : [])
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

function extractActiveParentIds(activeRotationRaw = null, activeMicroMicroIds = []) {
  const activeRotation = normalizeActiveRotationObject(activeRotationRaw);
  const idsFromMm = uniqueStrings(activeMicroMicroIds.map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId).filter(Boolean));

  if (!activeRotation) return idsFromMm.filter(isFixedShortParentMicroId);

  const rows = [
    ...(Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : []),
    ...(Array.isArray(activeRotation.rows) ? activeRotation.rows : []),
    ...(Array.isArray(activeRotation.activeRows) ? activeRotation.activeRows : []),
    ...(Array.isArray(activeRotation.selectedRows) ? activeRotation.selectedRows : [])
  ];

  return uniqueStrings([
    idsFromMm,
    activeRotation.macroFamilyIds || [],
    activeRotation.activeMacroFamilyIds || [],
    activeRotation.parentTrueMicroFamilyIds || [],
    activeRotation.macroIds || [],
    rows.map((row) => row?.parentTrueMicroFamilyId || row?.macroFamilyId || row?.parentMicroFamilyId)
  ])
    .filter((id) => inferTradeSide(id) !== OPPOSITE_TRADE_SIDE)
    .filter(validLearningId)
    .filter(isFixedShortParentMicroId);
}

function buildRowsFromActiveRotation(activeRotationRaw = null, activeSet = new Set(), activeParentSet = new Set(), compact = true) {
  const rows = [];

  for (const id of extractActiveMicroMicroIds(activeRotationRaw)) {
    const parsed = parseShortTaxonomyMicroId(id);
    const normalized = normalizeMicroMicroRow({
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
      selectedTier: 'MANUAL',
      rotationEligibilityTier: 'MANUAL',
      microMicroStatsSource: 'MANUAL_ACTIVE_MICRO_MICRO_ID',
      measurementClean: true,
      shortOnly: true,
      longDisabled: true
    }, rows.length, activeSet, activeParentSet, compact);

    if (normalized) rows.push(normalized);
  }

  return rows;
}

function mergeRows(primaryRows = [], fallbackRows = []) {
  const byId = new Map();

  for (const row of fallbackRows) {
    const id = getExplicitMicroMicroId(row, row?.key);
    if (id && isMicroMicroAnalyzeRow(row)) byId.set(id, row);
  }

  for (const row of primaryRows) {
    const id = getExplicitMicroMicroId(row, row?.key);
    if (!id || !isMicroMicroAnalyzeRow(row)) continue;

    const existing = byId.get(id);
    byId.set(id, existing ? { ...existing, ...row, active: Boolean(existing.active || row.active) } : row);
  }

  return [...byId.values()].filter(isMicroMicroAnalyzeRow);
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.trueMicroFamilyId,
    row.microMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.setupType,
    row.regimeBucket,
    row.confirmationProfile,
    row.status,
    row.learningStatus,
    row.tier,
    row.currentFit,
    row.currentFitLabel,
    row.microMicroHash,
    row.microMicroContext,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition
  ].filter(Boolean).join(' | ');

  return upper(haystack).includes(q);
}

function parseFilters(req) {
  return {
    side: upper(firstQueryValue(req.query?.side, TARGET_TRADE_SIDE)),
    q: upper(firstQueryValue(req.query?.q, '')),
    activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false), false),
    minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
    setup: upper(firstQueryValue(req.query?.setup, '')),
    regime: upper(firstQueryValue(req.query?.regime, '')),
    confirmationProfile: upper(firstQueryValue(req.query?.confirmationProfile, '')),
    currentFit: upper(firstQueryValue(req.query?.currentFit, ''))
  };
}

function rowPassesFilters(row = {}, filters, activeSet = new Set()) {
  const parsed = parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microMicroFamilyId);

  if (!isMicroMicroAnalyzeRow(row)) return false;
  if (filters.side && ['LONG', 'BULL', 'BULLISH', 'BUY'].includes(filters.side)) return false;
  if (filters.activeOnly && !activeSet.has(row.trueMicroFamilyId)) return false;
  if (filters.minCompleted > 0 && getCompletedSample(row) < filters.minCompleted) return false;
  if (filters.setup && parsed.setup !== filters.setup) return false;
  if (filters.regime && parsed.regime !== filters.regime) return false;
  if (filters.confirmationProfile && parsed.confirmationProfile !== filters.confirmationProfile) return false;
  if (filters.currentFit && upper(row.currentFitLabel || row.currentFit) !== filters.currentFit) return false;

  return rowMatchesSearch(row, filters.q);
}

function layerCounts(rows = []) {
  return {
    parent15: 0,
    child75: 0,
    microMicro: rows.filter(isMicroMicroAnalyzeRow).length,
    unknown: 0
  };
}

function tierCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const tier = upper(row.tier || tierFor(row));
    if (tier === 'MICRO_MICRO') acc.MICRO_MICRO += 1;
    else if (tier === 'MICRO_MICRO_SOFT') acc.MICRO_MICRO_SOFT += 1;
    else if (tier === 'OBSERVATION') acc.OBSERVATION += 1;
    else acc.RAW += 1;
    return acc;
  }, {
    MICRO_MICRO: 0,
    MICRO_MICRO_SOFT: 0,
    OBSERVATION: 0,
    RAW: 0
  });
}

function statusCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const status = upper(row.status || learningStatusFor(row));
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function currentFitCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const fit = upper(row.currentFitLabel || row.currentFit || 'UNKNOWN') || 'UNKNOWN';
    acc[fit] = (acc[fit] || 0) + 1;
    return acc;
  }, {
    FIT: 0,
    OK: 0,
    NEUTRAL: 0,
    MISFIT: 0,
    UNKNOWN: 0
  });
}

function sideCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const side = inferTradeSide(row);
    if (side === OPPOSITE_TRADE_SIDE) acc.long += 1;
    else acc.short += 1;
    if (side === 'UNKNOWN') acc.unknown += 1;
    return acc;
  }, {
    short: 0,
    long: 0,
    unknown: 0
  });
}

function activationSummary(rows = []) {
  const eligible = rows.filter((row) => row.discordActivationEligible === true);
  const blocked = rows.filter((row) => row.discordActivationEligible !== true);

  const blockedReasonCounts = blocked.reduce((acc, row) => {
    for (const reason of row.discordActivationBlockedReasons || [row.discordActivationBlockedReason || 'UNKNOWN']) {
      acc[reason] = (acc[reason] || 0) + 1;
    }
    return acc;
  }, {});

  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    total: rows.length,
    eligible: eligible.length,
    blocked: blocked.length,
    eligibleIds: eligible.map((row) => row.trueMicroFamilyId),
    topEligibleIds: eligible.slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES).map((row) => row.trueMicroFamilyId),
    blockedReasonCounts,
    thresholds: activationGateConfig()
  };
}

function compactBestRow(row = null) {
  if (!row || !isMicroMicroAnalyzeRow(row)) return null;
  return normalizeMicroMicroRow(row, row.rank || 1, new Set(), new Set(), true);
}

function buildParentSummaries(rows = []) {
  const ids = uniqueStrings(rows.map((row) => row.parentTrueMicroFamilyId).filter(Boolean)).slice(0, 25);

  return ids.map((parentTrueMicroFamilyId) => {
    const parentRows = rows
      .filter((row) => row.parentTrueMicroFamilyId === parentTrueMicroFamilyId)
      .sort(compareRowsBase);

    return {
      parentTrueMicroFamilyId,
      macroFamilyId: parentTrueMicroFamilyId,
      microMicroCount: parentRows.length,
      child75Hidden: true,
      parent15Hidden: true,
      bestMicroMicro: compactBestRow(parentRows[0])
    };
  });
}

function buildSummary(rows = [], activeSet = new Set()) {
  const completed = rows.reduce((sum, row) => sum + num(row.outcomeSample ?? getCompletedSample(row), 0), 0);
  const observationSample = rows.reduce((sum, row) => sum + getObservationSample(row), 0);
  const totalR = rows.reduce((sum, row) => sum + getTotalR(row), 0);
  const totalCostR = rows.reduce((sum, row) => sum + getTotalCostR(row), 0);
  const directSLCount = rows.reduce((sum, row) => sum + getDirectSLCount(row), 0);

  const best = [...rows].sort(compareRowsBase)[0] || null;

  return {
    rows: rows.length,
    microMicroRows: rows.length,
    child75Rows: 0,
    parent15Rows: 0,
    activeRows: rows.filter((row) => activeSet.has(row.trueMicroFamilyId)).length,
    activeIds: activeSet.size,

    ...modePayload(),

    completed: round(completed, 4),
    observationSample: round(observationSample, 4),
    completedMicroMicroFamilies: rows.filter((row) => getCompletedSample(row) > 0).length,

    tierCounts: tierCounts(rows),
    statusCounts: statusCounts(rows),
    currentFitCounts: currentFitCounts(rows),
    layerCounts: layerCounts(rows),

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: completed > 0 ? round(totalR / completed, 4) : 0,
    avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0,
    directSLCount: round(directSLCount, 4),
    directSLPct: completed > 0 ? round(directSLCount / completed, 4) : 0,

    bestMicroMicro: compactBestRow(best),
    bestAdaptive: compactBestRow(best),
    bestWinratePnl: compactBestRow(best),

    short: {
      rows: rows.length,
      layerCounts: layerCounts(rows),
      bestMicroMicro: compactBestRow(best)
    },
    long: {
      rows: 0
    }
  };
}

function getCachedWeekMicros(weekKey) {
  const cached = cache.weekMicros.get(weekKey);
  if (cached && now() - cached.ts <= CACHE_TTL_MS) return cached.micros || {};
  return null;
}

async function getWeekMicrosCached(weekKey, timeoutMs = WEEK_MICROS_TIMEOUT_MS) {
  const cached = getCachedWeekMicros(weekKey);
  if (cached) {
    return {
      weekKey,
      micros: cached,
      cacheHit: true,
      stale: false,
      warning: null
    };
  }

  try {
    const micros = await withTimeout(getWeekMicros(weekKey), timeoutMs, `GET_WEEK_MICROS_TIMEOUT_${weekKey}`);
    const safeMicros = micros && typeof micros === 'object' ? micros : {};

    cache.weekMicros.set(weekKey, {
      ts: now(),
      micros: safeMicros
    });

    while (cache.weekMicros.size > CACHE_MAX_KEYS) {
      cache.weekMicros.delete(cache.weekMicros.keys().next().value);
    }

    return {
      weekKey,
      micros: safeMicros,
      cacheHit: false,
      stale: false,
      warning: null
    };
  } catch (error) {
    const stale = cache.weekMicros.get(weekKey);

    if (stale?.micros) {
      return {
        weekKey,
        micros: stale.micros,
        cacheHit: true,
        stale: true,
        warning: error?.message || String(error)
      };
    }

    return {
      weekKey,
      micros: {},
      cacheHit: false,
      stale: false,
      warning: error?.message || String(error)
    };
  }
}

async function getActiveRotationSafe() {
  try {
    return await withTimeout(
      getActiveRotation({
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        weekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX,
        shortOnly: true,
        longDisabled: true,
        microMicroOnly: true,
        selectableMicroMicroOnly: true,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        discordOnlyForExactMicroMicroMatch: true
      }),
      ACTIVE_ROTATION_TIMEOUT_MS,
      'GET_ACTIVE_ROTATION_TIMEOUT'
    );
  } catch {
    return null;
  }
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modePayload()
  });
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'short-only-exact-micro-micro-only-v5-no-child-proxy');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Micro-Micro-Only', 'true');
  res.setHeader('X-Child75-Proxy-Selection-Disabled', 'true');
  res.setHeader('X-Micro-Micro-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_MICRO_MICRO_FAMILY');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Min-Completed-Micro-Micro-Active', String(MIN_COMPLETED_MICRO_MICRO_ACTIVE));
  res.setHeader('X-Discord-Activation-Gate-Version', DISCORD_ACTIVATION_GATE_VERSION);
}

export default async function handler(req, res) {
  const startedAt = now();
  setHeaders(res);

  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const requestedQueryWeekKey = String(firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) || PERSISTENT_LEARNING_KEY).trim();
    const mode = normalizeMode(firstQueryValue(req.query?.mode, DEFAULT_RANK_MODE));
    const limit = toSafeLimit(firstQueryValue(req.query?.limit, DEFAULT_LIMIT), DEFAULT_LIMIT, MAX_LIMIT);
    const bestLimit = toSafeLimit(firstQueryValue(req.query?.bestLimit, DEFAULT_BEST_LIMIT), DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);
    const compact = !isTrue(firstQueryValue(req.query?.details, false), false);
    const filters = parseFilters(req);

    const [activeRotationRaw, weekResult] = await Promise.all([
      getActiveRotationSafe(),
      getWeekMicrosCached(PERSISTENT_LEARNING_KEY, WEEK_MICROS_TIMEOUT_MS)
    ]);

    const activeMicroMicroFamilyIds = extractActiveMicroMicroIds(activeRotationRaw);
    const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotationRaw);
    const activeParentIds = extractActiveParentIds(activeRotationRaw, activeMicroMicroFamilyIds);
    const activeSet = new Set(activeMicroMicroFamilyIds);
    const activeParentSet = new Set(activeParentIds);

    const hiddenCounts = hiddenLayerCountsFromMicros(weekResult.micros);
    const explicitRows = buildMicroMicroRowsFromMicros(weekResult.micros, activeSet, activeParentSet, compact);
    const activeFallbackRows = buildRowsFromActiveRotation(activeRotationRaw, activeSet, activeParentSet, compact);

    const mergedRows = mergeRows(explicitRows, activeFallbackRows)
      .map((row) => ({
        ...row,
        active: Boolean(row.active || activeSet.has(row.trueMicroFamilyId)),
        macroActive: Boolean(row.macroActive || activeParentSet.has(row.parentTrueMicroFamilyId))
      }))
      .filter(isMicroMicroAnalyzeRow);

    const filteredRows = mergedRows.filter((row) => rowPassesFilters(row, filters, activeSet));
    const rankedRows = [...filteredRows]
      .sort((a, b) => compareRowsByMode(a, b, mode))
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const bestRawRows = [...mergedRows]
      .sort((a, b) => compareRowsByMode(a, b, mode))
      .slice(0, bestLimit)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const normalizedRows = rankedRows
      .slice(0, limit)
      .map((row, index) => normalizeMicroMicroRow(row, index, activeSet, activeParentSet, compact))
      .filter(Boolean);

    const bestMicroMicroFamilies = bestRawRows
      .map((row, index) => normalizeMicroMicroRow(row, index, activeSet, activeParentSet, compact))
      .filter(Boolean);

    const activation = activationSummary(mergedRows);
    const filteredActivation = activationSummary(rankedRows);
    const fitCounts = currentFitCounts(mergedRows);
    const weekEntries = sourceEntriesFromMicros(weekResult.micros);

    const warnings = uniqueWarnings([
      requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}`
        : null,
      weekResult.warning,
      weekResult.stale ? 'USING_STALE_WEEK_MICROS_CACHE' : null,
      legacyChild75ActiveIdsIgnored.length > 0
        ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED_MICRO_MICRO_ONLY:${legacyChild75ActiveIdsIgnored.length}`
        : null,
      hiddenCounts.scanner > 0 ? `SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${hiddenCounts.scanner}` : null,
      hiddenCounts.executionFingerprint > 0 ? `EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${hiddenCounts.executionFingerprint}` : null,
      hiddenCounts.child75 > 0 ? `CHILD75_ROWS_USED_AS_CONTEXT_ONLY_HIDDEN_FROM_ADMIN:${hiddenCounts.child75}` : null,
      hiddenCounts.parent15 > 0 ? `PARENT15_ROWS_HIDDEN_METADATA_ONLY:${hiddenCounts.parent15}` : null,
      hiddenCounts.long > 0 ? `LONG_ROWS_IGNORED_SHORT_ONLY:${hiddenCounts.long}` : null,
      explicitRows.length === 0 ? 'NO_EXPLICIT_MICRO_MICRO_ROWS_AVAILABLE' : null,
      mergedRows.length === 0 ? 'NO_MICRO_MICRO_ROWS_AVAILABLE' : null,
      activation.total > 0 && activation.eligible === 0
        ? 'NO_DISCORD_ACTIVATION_ELIGIBLE_MICRO_MICRO_ROWS_NET_EDGE_GATE'
        : null
    ]);

    return res.status(200).json({
      ok: true,
      fixed: true,

      ...modePayload(),

      availableTiers: ['MICRO_MICRO', 'MICRO_MICRO_SOFT', 'OBSERVATION', 'RAW'],
      availableStatuses: ['MICRO_MICRO_ACTIVE', 'MICRO_MICRO_EARLY', 'MICRO_MICRO_OBSERVING'],
      availableCurrentFit: ['FIT', 'OK', 'NEUTRAL', 'MISFIT', 'UNKNOWN'],
      availableLayers: ['MICRO_MICRO'],

      manualSelectionPolicy: {
        maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        selectableMicroMicroIdsAllowed: true,
        selectable75ChildIdsAllowed: false,
        selectableChildIdsAllowed: false,
        selectableParentIdsAllowed: false,
        child75ProxySelectionDisabled: true,
        parentIdsAreMetadataOnly: true,
        child75IdsAreContextOnly: true,
        parentMatchDoesNotTriggerDiscord: true,
        macroMatchDoesNotTriggerDiscord: true,
        child75MatchDoesNotTriggerDiscord: true,
        scannerFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsCanDeriveMicroMicroContextHash: true
      },

      measurementPolicy: {
        version: MEASUREMENT_FIX_VERSION,
        completed: 'closed VIRTUAL + SHADOW outcomes only',
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        rawWinrateRankingDisabled: true
      },

      currentFitPolicy: {
        version: CURRENT_FIT_VERSION,
        softOnly: true,
        blocksLearning: false,
        blocksVirtualLearning: false,
        blocksShadowLearning: false,
        canBlockDiscordOnly: true,
        currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
        currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
      },

      discordActivationGate: activationGateConfig(),
      discordActivationSummary: activation,
      filteredDiscordActivationSummary: filteredActivation,
      discordActivationEligibleRows: activation.eligible,
      discordActivationBlockedRows: activation.blocked,
      discordActivationEligibleIds: activation.eligibleIds,
      topDiscordActivationEligibleIds: activation.topEligibleIds,

      microMicroPolicy: {
        version: MICRO_MICRO_VERSION,
        enabled: true,
        only: true,
        schema: MICRO_MICRO_SCHEMA,
        marker: MICRO_MICRO_MARKER,
        hashLength: MICRO_MICRO_HASH_LEN,
        learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        minCompletedForActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
        format: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',
        altFormatAccepted: 'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}',
        base75ChildIsContextOnly: true,
        parent15StillMetadataOnly: true,
        child75ProxyRowsDisabled: true,
        microMicroSelectable: true,
        microMicroActsAsExecutionPreference: true,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        explicitRowsFound: explicitRows.length,
        child75ProxyRows: 0,
        rowsCount: mergedRows.length,
        activeMicroMicroIds: activeMicroMicroFamilyIds
      },

      statusRules: {
        MICRO_MICRO_OBSERVING: 'completed == 0 for micro-micro',
        MICRO_MICRO_EARLY: `completed > 0 && completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} for micro-micro`,
        MICRO_MICRO_ACTIVE: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} for micro-micro`
      },

      taxonomy: {
        parentCount: 15,
        child75ContextCount: 75,
        selectableChildCount: 0,
        selectableMicroMicroCount: layerCounts(mergedRows).microMicro,
        setups: SETUP_ORDER,
        regimes: REGIME_ORDER,
        confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
        parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
        childFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
        microMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',
        alternateInputAccepted: 'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}',
        selectableIdsAreMicroMicroOnly: true,
        child75IdsAreContextOnly: true,
        parentIdsAreMetadataOnly: true,
        child75ProxySelectionDisabled: true,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA
      },

      rankingPolicy: {
        defaultMode: DEFAULT_RANK_MODE,
        activeMode: mode,
        defaultSort: 'adaptive/fairWinrate/positivePnl/totalR/avgR/profitFactor/directSL/avgCostR/completed',
        bestDataFirst: true,
        completedBeforeRawScore: true,
        rawWinrateIsNeverDefault: true,
        pnlSource: 'totalR',
        winrateSource: 'fairWinrate',
        scannerFingerprintsExcludedFromRows: true,
        exactMicroMicroOnly: true,
        selectableMicroMicroOnly: true,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        scoringRSource: 'netR',
        winsLossesFlatsSource: 'netR',
        winrateDefinition: 'netR > 0',
        avgCostRSource: 'costR'
      },

      adaptiveLayerPolicy: {
        learningRemainsBroad: true,
        child75RemainsContextLayer: true,
        child75HiddenFromAdminRows: true,
        child75ProxyRowsDisabled: true,
        microMicroLayerEnabled: true,
        microMicroActsAsExecutionPreference: true,
        microMicroSelectionOnly: true,
        discordWillBeStrict: true,
        currentFitSoftOnly: true,
        currentFitBlocksLearning: false
      },

      weekKey: PERSISTENT_LEARNING_KEY,
      requestedWeekKey: PERSISTENT_LEARNING_KEY,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY ? requestedQueryWeekKey : null,
      sourceWeekKeyUsed: PERSISTENT_LEARNING_KEY,
      source: 'persistentLearningKey',
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      previousWeekKey: PERSISTENT_LEARNING_KEY,
      primaryWeekKey: PERSISTENT_LEARNING_KEY,
      primaryWeekRows: weekEntries.length,
      previousWeekRows: 0,
      mergedPreviousWeek: false,
      recentWeekLookback: 1,
      recentWeekKeysScanned: [PERSISTENT_LEARNING_KEY],
      recentWeekRows: [
        {
          weekKey: PERSISTENT_LEARNING_KEY,
          rows: weekEntries.length,
          cacheHit: Boolean(weekResult.cacheHit),
          stale: Boolean(weekResult.stale)
        }
      ],

      mode,
      requestedMode: firstQueryValue(req.query?.mode, DEFAULT_RANK_MODE),
      requestedLimit: Number(firstQueryValue(req.query?.limit, DEFAULT_LIMIT)) || DEFAULT_LIMIT,
      limit,
      limitCapped: (Number(firstQueryValue(req.query?.limit, DEFAULT_LIMIT)) || DEFAULT_LIMIT) > limit,
      sideLimit: toSafeLimit(firstQueryValue(req.query?.sideLimit, DEFAULT_LIMIT), DEFAULT_LIMIT, MAX_LIMIT),
      sideEnsureLimit: toSafeLimit(firstQueryValue(req.query?.sideEnsureLimit, DEFAULT_LIMIT), DEFAULT_LIMIT, MAX_LIMIT),
      bestLimit,

      bestCount: bestMicroMicroFamilies.length,
      bestRows: bestMicroMicroFamilies,
      best: bestMicroMicroFamilies,
      bestMicroFamilies: bestMicroMicroFamilies,
      topMicroFamilies: bestMicroMicroFamilies,
      bestMicroMicroCount: bestMicroMicroFamilies.length,
      bestMicroMicroRows: bestMicroMicroFamilies,
      bestMicroMicroFamilies,
      best75Count: 0,
      best75MicroFamilies: [],
      best25Count: bestMicroMicroFamilies.slice(0, 25).length,
      best25MicroFamilies: bestMicroMicroFamilies.slice(0, 25),

      filters,
      compact,

      count: normalizedRows.length,
      rowsRendered: normalizedRows.length,
      cleanRows: normalizedRows.filter((row) => cleanMeasurementScore(row) === 1).length,
      legacyRows: normalizedRows.filter((row) => cleanMeasurementScore(row) !== 1).length,
      filtered: rankedRows.length,
      totalAvailable: mergedRows.length,
      rawExtractedRows: mergedRows.length,

      rawRows: compact ? [] : mergedRows,
      rawMicroMicroRows: compact ? [] : mergedRows,

      rows: normalizedRows,
      microRows: normalizedRows,
      microFamilies: normalizedRows,
      availableRows: normalizedRows,
      availableMicroFamilies: normalizedRows,
      microMicroRows: normalizedRows,
      microMicroFamilies: normalizedRows,

      generatedMicroMicroRows: mergedRows.length,
      explicitMicroMicroRows: explicitRows.length,
      outcomeDerivedMicroMicroRows: 0,
      child75ProxyMicroMicroRows: 0,

      selectableChildFamiliesTotal: 0,
      selectableMicroMicroFamiliesTotal: layerCounts(mergedRows).microMicro,
      parentFamiliesTotal: 15,

      weekRows: weekEntries.length,
      microMicroRowsCount: mergedRows.length,
      microMicroRowsTotal: mergedRows.length,
      activeFallbackRows: activeFallbackRows.length,

      child75RowsHidden: hiddenCounts.child75,
      parentRowsHidden: hiddenCounts.parent15,
      rawScannerFingerprintRowsHidden: hiddenCounts.scanner,
      rawExecutionFingerprintRowsHidden: hiddenCounts.executionFingerprint,
      rawLongRowsHidden: hiddenCounts.long,
      hiddenLayerCounts: hiddenCounts,

      rawSideCounts: sideCounts(mergedRows),
      filteredSideCounts: sideCounts(rankedRows),
      responseSideCounts: sideCounts(normalizedRows),
      bestSideCounts: sideCounts(bestMicroMicroFamilies),

      rawLayerCounts: layerCounts(mergedRows),
      filteredLayerCounts: layerCounts(rankedRows),
      responseLayerCounts: layerCounts(normalizedRows),
      bestLayerCounts: layerCounts(bestMicroMicroFamilies),

      tierCounts: tierCounts(rankedRows),
      statusCounts: statusCounts(rankedRows),
      currentFitCounts: fitCounts,
      currentFitUnknownRows: fitCounts.UNKNOWN || 0,

      activeRotationId: normalizeActiveRotationObject(activeRotationRaw)?.rotationId || null,
      activeRotation: {
        rotationId: normalizeActiveRotationObject(activeRotationRaw)?.rotationId || null,
        activeMicroMicroFamilyIds,
        microMicroFamilyIds: activeMicroMicroFamilyIds,
        activeMicroFamilyIds: activeMicroMicroFamilyIds,
        trueMicroFamilyIds: activeMicroMicroFamilyIds,
        activeMacroFamilyIds: activeParentIds,
        legacyChild75ActiveIdsIgnored,
        ...modePayload()
      },

      activeMicroFamilyIds: activeMicroMicroFamilyIds,
      activeTrueMicroFamilyIds: activeMicroMicroFamilyIds,
      activeMicroMicroFamilyIds,
      activeTrueMicroMicroFamilyIds: activeMicroMicroFamilyIds,
      activeExactMicroMicroFamilyIds: activeMicroMicroFamilyIds,
      selectedMicroMicroFamilyIds: activeMicroMicroFamilyIds,
      active75ChildFamilyIds: [],
      legacyChild75ActiveIdsIgnored,
      activeMacroFamilyIds: activeParentIds,

      bestShort: compactBestRow(bestRawRows[0] || null),
      bestLong: null,

      parentSummaries: buildParentSummaries(mergedRows),
      shortRows: bestMicroMicroFamilies,
      longRows: [],
      unknownRows: [],

      summary: buildSummary(rankedRows, activeSet),

      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,

      rankingPolicyText: 'microMicroOnly|adaptive|fairWinrate|positivePnl|totalR|avgR|profitFactor|directSL|avgCostR|completed',
      rankingPolicyShort: 'adaptive|fairWinrate|totalR|avgR|profitFactor|directSL|avgCostR',

      measurementFixVersion: MEASUREMENT_FIX_VERSION,
      adaptiveUiVersion: ADAPTIVE_UI_VERSION,
      currentFitVersion: CURRENT_FIT_VERSION,
      microMicroVersion: MICRO_MICRO_VERSION,

      warnings,
      error: null,

      perf: {
        durationMs: now() - startedAt,
        weekMicrosCacheHit: Boolean(weekResult.cacheHit),
        weekMicrosCacheStale: Boolean(weekResult.stale),
        weekMicrosCacheSize: cache.weekMicros.size,
        path: 'shortOnlyExactMicroMicroOnlyPersistentLearningNoChildProxyV5',
        bestSource: 'explicitMicroMicroRowsOnly',
        compactPayload: compact
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      ...modePayload(),
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}