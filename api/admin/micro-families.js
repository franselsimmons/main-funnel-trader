// ================= FILE: api/admin/micro-families.js =================

import { sideToTradeSide, safeNumber } from '../../src/utils.js';
import { getDurableRedis, getVolatileRedis, getJson } from '../../src/redis.js';
import { KEYS } from '../../src/keys.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const MARKET_WEATHER_KEY = 'MARKET:WEATHER:LATEST';
const SHORT_MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}${MARKET_WEATHER_KEY}`;

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
const CURRENT_FIT_VERSION = 'SHORT_CURRENTFIT_MARKETWEATHER_SOFT_V4_STABLE_ADMIN';

const SETUP_ORDER = ['BREAKOUT', 'RETEST', 'SWEEP_REVERSAL', 'CONTINUATION', 'COMPRESSION'];
const REGIME_ORDER = ['TREND', 'CHOP', 'SQUEEZE'];
const CONFIRMATION_PROFILE_ORDER = ['A_STRONG_ALIGN', 'B_FLOW_ALIGN', 'C_VOLUME_ALIGN', 'D_MIXED_OK', 'E_WEAK_CONTRA'];

const SETUP_SET = new Set(SETUP_ORDER);
const DEFAULT_RANK_MODE = 'adaptive';
const VALID_MODES = new Set(['adaptive', 'balanced', 'winrate', 'totalR', 'avgR', 'directSL', 'observed', 'cost', 'currentFit', 'microMicro', 'clean']);

const WINRATE_Z = 1.96;
const SAMPLE_RELIABILITY_CAP = 50;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES = 2;

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 300;
const DEFAULT_BEST_LIMIT = 120;
const MAX_BEST_LIMIT = 300;
const ACTIVE_ROTATION_TIMEOUT_MS = 1_800;
const WEEK_MICROS_TIMEOUT_MS = 8_500;
const MARKET_WEATHER_REDIS_TIMEOUT_MS = 700;
const MARKET_WEATHER_TTL_MS = 60_000;
const CACHE_TTL_MS = 45_000;
const CACHE_MAX_KEYS = 12;

const cache = globalThis.__ADMIN_MICRO_FAMILIES_SHORT_MM_V4_CACHE__ ||= {
  weekMicros: new Map(),
  marketWeather: null
};

const now = () => Date.now();
const upper = (value) => String(value || '').trim().toUpperCase();
const lower = (value) => String(value || '').trim().toLowerCase();
const hasValue = (value) => value !== undefined && value !== null && value !== '';
const num = (value, fallback = 0) => {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
};
const round = (value, decimals = 4) => {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : 0;
};
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, num(value, min)));

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function isTrue(value) {
  return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
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
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => typeof value === 'string' ? value.split(/[\s,;\n\r]+/g) : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function uniqueWarnings(values = []) {
  return [...new Set(flattenValues(values).map((value) => String(value || '').trim()).filter(Boolean))];
}

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function firstFinite(...values) {
  for (const value of flattenValues(values)) {
    if (!hasValue(value)) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
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
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,
    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    virtualPositionsOnly: true,
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
    adaptiveLayerBuilt: true,
    marketWeatherEngineBuilt: true,
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

function normalizeMode(value) {
  const raw = String(value || DEFAULT_RANK_MODE).trim();
  if (VALID_MODES.has(raw)) return raw;
  const rawLower = lower(raw);
  if (rawLower === 'totalr') return 'totalR';
  if (rawLower === 'avgr') return 'avgR';
  if (rawLower === 'directsl') return 'directSL';
  if (rawLower === 'currentfit') return 'currentFit';
  if (rawLower === 'micromicro') return 'microMicro';
  return VALID_MODES.has(rawLower) ? rawLower : DEFAULT_RANK_MODE;
}

function cleanSideHaystack(text = '') {
  return upper(text)
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
    .replaceAll('LONG_DISABLED_SHORT_ONLY', '')
    .replaceAll('LONGDISABLED_SHORT_ONLY', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function hasSignal(text = '', words = []) {
  const clean = ` ${cleanSideHaystack(text).replace(/[^A-Z0-9]+/g, ' ')} `;
  return words.some((word) => clean.includes(` ${word} `) || clean.includes(` MICRO_${word}_`) || clean.includes(`MM_${word}_`));
}

function isScannerFingerprintId(id = '') {
  const value = upper(id);
  return value.includes('SCANNER_GATE_') || value.includes('__SCANNER__') || value.includes('MICRO_SHORT_SCANNER__') || value.includes('SHORT_SCANNER_') || value.includes('MICRO_LONG_SCANNER__') || value.includes('LONG_SCANNER_');
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);
  if (value.startsWith('MM_SHORT_')) return false;
  if (value.startsWith('MICRO_SHORT_') && value.includes(MICRO_MICRO_MARKER)) return false;
  return value.includes('_XR_') || value.includes('__XR__') || value.includes('|XR|') || value.includes('EXECUTION_FINGERPRINT') || value.includes('EXECUTION_MICRO') || value.includes('REFINED_EXECUTION');
}

function parseBody(body = '') {
  const clean = upper(body).replace(/^_+|_+$/g, '');
  for (const regime of REGIME_ORDER) {
    const marker = `_${regime}`;
    const idx = clean.indexOf(marker);
    if (idx < 0) continue;
    const setup = clean.slice(0, idx);
    const rest = clean.slice(idx + marker.length).replace(/^_+/, '');
    if (!SETUP_SET.has(setup)) continue;
    if (!rest) return { ok: true, setup, regime, confirmationProfile: null, rest: '' };
    for (const profile of CONFIRMATION_PROFILE_ORDER) {
      if (rest === profile) return { ok: true, setup, regime, confirmationProfile: profile, rest: '' };
      if (rest.startsWith(`${profile}_`)) return { ok: true, setup, regime, confirmationProfile: profile, rest: rest.slice(profile.length + 1) };
    }
  }
  return { ok: false, setup: null, regime: null, confirmationProfile: null, rest: '' };
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
    confirmationProfile: null,
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    base75ChildTrueMicroFamilyId: null,
    trueMicroFamilyId: null,
    microMicroFamilyId: null,
    trueMicroMicroFamilyId: null,
    exactMicroMicroFamilyId: null,
    selectionLayer: 'UNKNOWN'
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);
  if (!value || isScannerFingerprintId(value) || isExecutionFingerprintId(value)) return invalidParsed(rawId);

  let body = '';
  let explicitMicroMicro = false;
  let context = '';

  if (value.startsWith('MM_SHORT_')) {
    body = value.slice('MM_SHORT_'.length);
    explicitMicroMicro = true;
  } else if (value.startsWith('MICRO_SHORT_')) {
    body = value.slice('MICRO_SHORT_'.length);
    const idx = body.lastIndexOf(MICRO_MICRO_MARKER);
    if (idx > -1) {
      explicitMicroMicro = true;
      context = body.slice(idx + MICRO_MICRO_MARKER.length);
      body = body.slice(0, idx);
    }
  } else {
    return invalidParsed(rawId);
  }

  const parsed = parseBody(body);
  if (!parsed.ok) return invalidParsed(rawId);
  if (explicitMicroMicro && !context && parsed.rest) context = parsed.rest;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setup}_${parsed.regime}`;
  const childTrueMicroFamilyId = parsed.confirmationProfile ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}` : null;
  const isParent = !parsed.confirmationProfile;
  const isChild = Boolean(parsed.confirmationProfile && !explicitMicroMicro && !parsed.rest);
  const isMicroMicro = Boolean(parsed.confirmationProfile && (explicitMicroMicro || parsed.rest));
  const hash = isMicroMicro ? normalizeMicroMicroHash(context || parsed.rest || stableHash10(value)) || stableHash10(value) : null;
  const microMicroFamilyId = isMicroMicro ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${hash}` : null;
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
    microMicroHash: hash,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionLayer: isMicroMicro ? 'MICRO_MICRO' : isChild ? 'CHILD_75' : isParent ? 'PARENT_15' : 'UNKNOWN'
  };
}

const isFixedShortParentMicroId = (id = '') => parseShortTaxonomyMicroId(id).isParent === true;
const isFixedShortChildMicroId = (id = '') => parseShortTaxonomyMicroId(id).isChild === true;
const isMicroMicroFamilyId = (id = '') => parseShortTaxonomyMicroId(id).isMicroMicro === true;
const isSelectableMicroMicroId = (id = '') => parseShortTaxonomyMicroId(id).selectable === true;

function validLearningId(id = '') {
  const value = String(id || '').trim();
  if (!value || isScannerFingerprintId(value) || isExecutionFingerprintId(value)) return false;
  return parseShortTaxonomyMicroId(value).valid === true;
}

function firstParsed(values = [], predicate = () => true) {
  for (const value of flattenValues(values)) {
    const parsed = parseShortTaxonomyMicroId(value);
    if (parsed.valid && predicate(parsed)) return parsed;
  }
  return null;
}

function getExplicitMicroMicroId(row = {}) {
  if (typeof row === 'string') return firstParsed([row], (p) => p.isMicroMicro)?.trueMicroFamilyId || null;
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
  ], (p) => p.isMicroMicro)?.trueMicroFamilyId || null;
}

function getBase75ChildTrueMicroFamilyId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    const parsed = firstParsed([row, fallback], (p) => p.isBaseChild);
    return parsed?.base75ChildTrueMicroFamilyId || null;
  }
  const parsed = firstParsed([
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], (p) => p.isBaseChild);
  return parsed?.base75ChildTrueMicroFamilyId || null;
}

function getParentTrueMicroFamilyId(row = {}, fallback = null) {
  if (typeof row === 'string') return firstParsed([row, fallback])?.parentTrueMicroFamilyId || null;
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
  ]).map(upper).filter(Boolean).filter((p) => !p.includes('FIRST_MOVE') && !p.includes('AFTER_OPEN'));
}

function buildMicroMicroFamilyId(baseChildId = '', row = {}, { allowChildProxy = true } = {}) {
  const child = parseShortTaxonomyMicroId(baseChildId);
  if (!child.isBaseChild) return null;

  const explicit = getExplicitMicroMicroId(row);
  if (explicit) {
    const parsedExplicit = parseShortTaxonomyMicroId(explicit);
    if (parsedExplicit.isMicroMicro && parsedExplicit.base75ChildTrueMicroFamilyId === child.base75ChildTrueMicroFamilyId) return parsedExplicit.trueMicroFamilyId;
  }

  const explicitHash = normalizeMicroMicroHash(row.microMicroHash || row.microMicroContextHash || row.executionContextHash || row.executionFingerprintHash || '');
  if (explicitHash) return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${explicitHash}`;

  const parts = microMicroContextParts(row);
  if (parts.length > 0) return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(parts.join('|'))}`;

  if (allowChildProxy) return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(`${child.base75ChildTrueMicroFamilyId}|DEFAULT_ENTRY_CONTEXT_PENDING`)}`;
  return null;
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const direct = upper(input);
    if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(direct)) return TARGET_TRADE_SIDE;
    if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(direct)) return OPPOSITE_TRADE_SIDE;
    const converted = sideToTradeSide(direct);
    if (converted === TARGET_TRADE_SIDE || converted === OPPOSITE_TRADE_SIDE) return converted;
    if (parseShortTaxonomyMicroId(input).valid || direct.includes('MICRO_SHORT_') || direct.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (direct.includes('MICRO_LONG_') || direct.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
    return 'UNKNOWN';
  }

  for (const field of [input.tradeSide, input.side, input.positionSide, input.direction, input.signalSide, input.scannerSide, input.actualScannerSide, input.analysisSide, input.entrySide, input.bias, input.marketBias]) {
    const side = inferTradeSide(String(field || ''));
    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const text = [
    input.microFamilyId,
    input.trueMicroFamilyId,
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
  ].map(cleanSideHaystack).join(' | ');

  if (parseShortTaxonomyMicroId(text).valid || text.includes('MICRO_SHORT_') || text.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
  if (text.includes('MICRO_LONG_') || text.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;

  const shortSignal = hasSignal(text, ['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN']);
  const longSignal = hasSignal(text, ['LONG', 'BULL', 'BULLISH', 'BUY', 'UP']);
  if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
  if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;
  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;
  return 'UNKNOWN';
}

const isShortRow = (row = {}) => inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
const isLearningOutcomeSource = (source = '') => ['VIRTUAL', 'SHADOW', 'PAPER', ''].includes(upper(source || 'VIRTUAL'));

function isMicroMicroAnalyzeRow(row = {}) {
  const id = row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.trueMicroMicroFamilyId || row?.exactMicroMicroFamilyId || '';
  if (!id || !validLearningId(id) || !isMicroMicroFamilyId(id) || row.legacyScannerFamilyFallback === true) return false;
  return inferTradeSide({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id }) !== OPPOSITE_TRADE_SIDE;
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) return micros.map((row, index) => [row?.trueMicroFamilyId || row?.microMicroFamilyId || row?.microFamilyId || String(index), row]);
  if (!micros || typeof micros !== 'object') return [];
  return Object.entries(micros);
}

function getShortRiskGeometry(row = {}) {
  const entry = firstFinite(row.entryPrice, row.entry, row.avgEntryPrice, row.averageEntryPrice, row.averageEntry, row.openPrice);
  const initialSl = firstFinite(row.initialSl, row.initialSL, row.initialStopLoss, row.initialStopLossPrice, row.stopLoss, row.stopLossPrice, row.sl, row.slPrice);
  const tp = firstFinite(row.tp, row.takeProfit, row.takeProfitPrice, row.targetPrice, row.finalTp, row.finalTakeProfit);
  const exitPrice = firstFinite(row.exitPrice, row.closePrice, row.closedPrice, row.outcomePrice, row.fillExitPrice, row.exit);
  const currentPrice = firstFinite(row.currentPrice, row.markPrice, row.lastPrice, row.price);
  const denominator = Number.isFinite(entry) && Number.isFinite(initialSl) ? initialSl - entry : 0;
  const validGeometry = Number.isFinite(entry) && Number.isFinite(initialSl) && Number.isFinite(tp) && denominator > 0 && tp < entry && entry < initialSl;
  const shortGrossR = validGeometry && Number.isFinite(exitPrice) ? (entry - exitPrice) / denominator : null;
  const shortCurrentR = validGeometry && Number.isFinite(currentPrice) ? (entry - currentPrice) / denominator : null;
  const shortTpHit = validGeometry && (row.shortTpHit === true || row.tpHit === true || (Number.isFinite(exitPrice) && exitPrice <= tp) || (Number.isFinite(currentPrice) && currentPrice <= tp));
  const shortSlHit = validGeometry && (row.shortSlHit === true || row.slHit === true || (Number.isFinite(exitPrice) && exitPrice >= initialSl) || (Number.isFinite(currentPrice) && currentPrice >= initialSl));

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
  const explicit = firstFinite(row.shortNetR, row.netShortR, row.shortExitR, row.shortRealizedNetR, row.shortRealizedR);
  if (explicit !== null) return explicit;
  const geometry = getShortRiskGeometry(row);
  const costR = num(row.costR ?? row.avgCostR, 0);
  if (geometry.validGeometry && geometry.shortGrossR !== null) return geometry.shortGrossR - costR;
  return num(row.netR ?? row.exitR ?? row.realizedNetR ?? row.realizedR ?? row.r, 0);
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
    if (netR > 0) { acc.wins += 1; acc.grossWinR += netR; }
    else if (netR < 0) { acc.losses += 1; acc.grossLossR += Math.abs(netR); }
    else acc.flats += 1;
    if (outcome.directSL || outcome.directToSL || outcome.directStopLoss || outcome.isDirectSL || upper(outcome.exitReason) === 'SL') acc.directSLCount += 1;
    return acc;
  }, { completed: 0, wins: 0, losses: 0, flats: 0, totalR: 0, totalCostR: 0, grossWinR: 0, grossLossR: 0, directSLCount: 0 });
}

function hasVirtualShadowOutcomeFields(row = {}) {
  return ['virtualCompleted', 'shadowCompleted', 'virtualWins', 'virtualLosses', 'virtualFlats', 'shadowWins', 'shadowLosses', 'shadowFlats', 'virtualTotalR', 'shadowTotalR', 'virtualTotalCostR', 'shadowTotalCostR'].some((key) => hasValue(row[key]));
}

function getOutcomeCounts(row = {}) {
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
  if (virtualShadowCompleted <= 0 && aggregateCompleted <= 0 && countedTotal <= 0 && recent.completed > 0) return { wins: recent.wins, losses: recent.losses, flats: recent.flats, total: recent.completed };
  const total = Math.max(countedTotal, virtualShadowCompleted, aggregateCompleted, recent.completed, 0);
  return { wins, losses, flats: Math.max(flats, Math.max(0, total - wins - losses)), total };
}

const getCompletedSample = (row = {}) => getOutcomeCounts(row).total;
const getObservationSample = (row = {}) => Math.max(num(row.observationSample, 0), num(row.seen, 0), num(row.observations, 0), getCompletedSample(row), 0);
const getObservationDuplicateSkippedCount = (row = {}) => Math.max(num(row.observationDuplicateSkippedCount, 0), num(row.duplicateObservationsSkipped, 0), num(row.seenDuplicateSkippedCount, 0), 0);
const getSeenCompletedRatio = (row = {}) => getCompletedSample(row) <= 0 ? getObservationSample(row) : getObservationSample(row) / getCompletedSample(row);

function getTotalR(row = {}) {
  const completed = getCompletedSample(row);
  const recent = aggregateRecentOutcomes(row);
  if (completed <= 0) return 0;
  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;
  if (recent.completed > 0) return recent.totalR;
  return num(row.shortNetTotalR ?? row.netShortTotalR ?? row.netTotalR ?? row.totalNetR ?? row.totalR, 0);
}

function getAvgR(row = {}) {
  const completed = getCompletedSample(row);
  if (completed <= 0) return 0;
  if (hasValue(row.avgNetR) && !hasVirtualShadowOutcomeFields(row)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR) && !hasVirtualShadowOutcomeFields(row)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR) && !hasVirtualShadowOutcomeFields(row)) return num(row.avgR, 0);
  return getTotalR(row) / completed;
}

function getTotalCostR(row = {}) {
  const completed = getCompletedSample(row);
  const recent = aggregateRecentOutcomes(row);
  if (completed <= 0) return 0;
  const virtualShadowCost = Math.max(0, num(row.virtualTotalCostR, 0)) + Math.max(0, num(row.shadowTotalCostR, 0));
  if (virtualShadowCost > 0) return virtualShadowCost;
  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;
  if (hasValue(row.totalCostR)) return Math.max(0, num(row.totalCostR, 0));
  if (hasValue(row.totalNetCostR)) return Math.max(0, num(row.totalNetCostR, 0));
  for (const key of ['avgCostR', 'costR', 'netCostR', 'estimatedCostR']) {
    if (hasValue(row[key]) && num(row[key], 0) > 0) return Math.max(0, num(row[key], 0)) * completed;
  }
  return 0;
}

const getAvgCostR = (row = {}) => getCompletedSample(row) > 0 ? getTotalCostR(row) / getCompletedSample(row) : 0;

function getDirectSLCount(row = {}) {
  const sourceCount = num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0);
  if (sourceCount > 0) return sourceCount;
  if (hasValue(row.directSLCount)) return num(row.directSLCount, 0);
  return aggregateRecentOutcomes(row).directSLCount;
}

const getDirectSLPct = (row = {}) => getCompletedSample(row) > 0 ? clamp(getDirectSLCount(row) / getCompletedSample(row), 0, 1) : 0;

function getProfitFactor(row = {}) {
  if (hasValue(row.netProfitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor) && !hasVirtualShadowOutcomeFields(row)) return num(row.profitFactor, 0);
  const recent = aggregateRecentOutcomes(row);
  let winR = recent.grossWinR || Math.max(num(row.virtualWinR, 0) + num(row.shadowWinR, 0), num(row.netWinR, 0), num(row.totalWinR, 0), num(row.grossWinR, 0), 0);
  let lossR = recent.grossLossR || Math.max(Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)), Math.abs(num(row.netLossR, 0)), Math.abs(num(row.totalLossR, 0)), Math.abs(num(row.grossLossR, 0)), 0);
  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 99 : 0;
  return winR / lossR;
}

function wilsonLowerBound(successes, trials, z = WINRATE_Z) {
  const n = num(trials, 0);
  if (n <= 0) return 0;
  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;
  return clamp((p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n), 0, 1);
}

const sampleReliability = (sample, cap = SAMPLE_RELIABILITY_CAP) => sample > 0 ? clamp(Math.sqrt(Math.min(sample, cap) / cap), 0, 1) : 0;

function getSampleAdjustedWinrate(row = {}) {
  const counts = getOutcomeCounts(row);
  const completedSample = counts.total;
  const observationSample = getObservationSample(row);
  if (completedSample <= 0) return { sample: observationSample, outcomeSample: 0, observationSample, wins: 0, losses: 0, flats: 0, rawWinrate: 0, bayesianWinrate: 0, wilsonLowerBound: 0, reliability: sampleReliability(observationSample), score: 0, awaitingOutcomes: observationSample > 0 };
  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / completedSample, 0, 1);
  const bayesianWinrate = clamp((successes + 1) / (completedSample + 2), 0, 1);
  const wilson = wilsonLowerBound(successes, completedSample);
  const reliability = sampleReliability(completedSample);
  const score = clamp(wilson * 0.8 + bayesianWinrate * 0.15 + rawWinrate * 0.05, 0, 1);
  return { sample: completedSample, outcomeSample: completedSample, observationSample, wins: counts.wins, losses: counts.losses, flats: counts.flats, rawWinrate, bayesianWinrate, wilsonLowerBound: wilson, reliability, score, awaitingOutcomes: false };
}

function getDashboardBalancedScore(row = {}, meta = null) {
  const winrate = meta || getSampleAdjustedWinrate(row);
  if (winrate.outcomeSample <= 0 && winrate.observationSample > 0) return Math.min(45, Math.log1p(winrate.observationSample) * 8 + winrate.reliability * 18);
  return winrate.score * 100 + winrate.reliability * 20 + Math.log1p(Math.max(0, getTotalR(row))) * 12 + Math.log1p(Math.max(0, getAvgR(row))) * 8 + Math.log1p(Math.min(Math.max(0, getProfitFactor(row)), 20)) * 3 - getDirectSLPct(row) * 60 - getAvgCostR(row) * 3;
}

function learningStatusFor(row = {}, meta = null) {
  const winrate = meta || getSampleAdjustedWinrate(row);
  if (winrate.outcomeSample >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO_ACTIVE';
  if (winrate.outcomeSample > 0) return 'MICRO_MICRO_EARLY';
  return 'MICRO_MICRO_OBSERVING';
}

function tierFor(row = {}, meta = null) {
  const winrate = meta || getSampleAdjustedWinrate(row);
  if (winrate.outcomeSample >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 'MICRO_MICRO';
  if (winrate.outcomeSample > 0) return 'MICRO_MICRO_SOFT';
  if (winrate.observationSample > 0) return 'OBSERVATION';
  return 'RAW';
}

function normalizeMarketRegime(value = '') {
  const raw = upper(value);
  if (raw.includes('SQUEEZE') || raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('CHOP') || raw.includes('RANGE') || raw.includes('SIDEWAYS') || raw.includes('NEUTRAL')) return 'CHOP';
  if (raw.includes('TREND') || raw.includes('IMPULSE') || raw.includes('MOMENTUM') || raw.includes('BREAKOUT')) return 'TREND';
  return 'UNKNOWN';
}

function normalizeMarketTrendSide(value = '') {
  const raw = upper(value);
  if (['BULL', 'BULLISH', 'LONG', 'BUY', 'UP', 'UPSIDE'].includes(raw) || raw.includes('BULL')) return 'bull';
  if (['BEAR', 'BEARISH', 'SHORT', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw) || raw.includes('BEAR')) return 'bear';
  if (['CHOP', 'RANGE', 'SIDEWAYS', 'NEUTRAL', 'MIXED'].includes(raw) || raw.includes('NEUTRAL') || raw.includes('MIXED')) return 'neutral';
  return 'UNKNOWN';
}

function pct01To100(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function normalizeMarketWeather(payload = null, sourceKey = null, redisSource = null) {
  const data = payload?.marketWeather || payload?.weather || payload?.data?.marketWeather || payload?.data?.weather || payload?.data || payload;
  if (!data || typeof data !== 'object') return { available: false, ok: false, sourceKey, redisSource, reason: 'MARKET_WEATHER_EMPTY', currentRegime: 'UNKNOWN', currentTrendSide: 'UNKNOWN', bullishPct: null, bearishPct: null, squeezePct: null, confidence: 0 };
  const currentRegime = normalizeMarketRegime(data.currentRegime || data.regime || data.marketRegime || data.regimeBucket || data.state);
  const currentTrendSide = normalizeMarketTrendSide(data.currentTrendSide || data.trendSide || data.marketTrendSide || data.dashboardSide || data.marketSide || data.side || data.bias || data.direction || data.flow);
  const bullishPct = pct01To100(data.bullishPct ?? data.bullPct ?? data.longPct ?? data.breadth?.bullishPct, null);
  const bearishPct = pct01To100(data.bearishPct ?? data.bearPct ?? data.shortPct ?? data.breadth?.bearishPct, null);
  const squeezePct = pct01To100(data.squeezePct ?? data.compressionPct ?? data.breadth?.squeezePct, null);
  const rawConfidence = Number(data.currentMarketFitConfidence ?? data.confidence ?? data.marketConfidence ?? data.weatherConfidence ?? data.score ?? 0.6);
  const confidence = Number.isFinite(rawConfidence) ? (Math.abs(rawConfidence) > 1 ? clamp(rawConfidence / 100, 0, 1) : clamp(rawConfidence, 0, 1)) : 0.6;
  const available = payload?.ok !== false && data?.ok !== false && data?.available !== false && (currentRegime !== 'UNKNOWN' || currentTrendSide !== 'UNKNOWN' || bullishPct !== null || bearishPct !== null || squeezePct !== null);
  return { available, ok: available, sourceKey, redisSource, reason: available ? null : 'MARKET_WEATHER_INCOMPLETE', currentRegime, currentTrendSide, bullishPct: bullishPct === null ? null : round(bullishPct, 2), bearishPct: bearishPct === null ? null : round(bearishPct, 2), squeezePct: squeezePct === null ? null : round(squeezePct, 2), confidence: round(confidence, 4), currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE', currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT' };
}

function redisClientsVolatileFirst() {
  const clients = [];
  try { const r = getVolatileRedis(); if (r) clients.push({ name: 'volatile', redis: r }); } catch {}
  try { const r = getDurableRedis(); if (r) clients.push({ name: 'durable', redis: r }); } catch {}
  return clients;
}

async function softReadJson(redis, key, fallback = null) {
  if (!redis || !key) return fallback;
  try { return await withTimeout(getJson(redis, key, fallback), MARKET_WEATHER_REDIS_TIMEOUT_MS, `REDIS_READ_TIMEOUT:${key}`) ?? fallback; }
  catch { return fallback; }
}

const namespacedShortKey = (key, fallback = MARKET_WEATHER_KEY) => {
  const raw = String(key || fallback || '').trim();
  if (!raw) return SHORT_MARKET_WEATHER_KEY;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;
  return `${SHORT_KEY_PREFIX}${raw}`;
};

const rawNeutralKey = (key, fallback = MARKET_WEATHER_KEY) => {
  const raw = String(key || fallback || '').trim();
  if (!raw) return MARKET_WEATHER_KEY;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw.slice(SHORT_KEY_PREFIX.length);
  if (raw.startsWith('LONG:')) return raw.slice('LONG:'.length);
  return raw;
};

function marketWeatherKeyCandidates() {
  return uniqueStrings([SHORT_MARKET_WEATHER_KEY, namespacedShortKey(KEYS?.short?.market?.weatherLatest), namespacedShortKey(KEYS?.short?.market?.weather), namespacedShortKey(KEYS?.market?.shortWeatherLatest), namespacedShortKey(KEYS?.market?.shortWeather), namespacedShortKey(MARKET_WEATHER_KEY)]);
}

function rawMarketWeatherKeyCandidates() {
  return uniqueStrings([MARKET_WEATHER_KEY, rawNeutralKey(KEYS?.market?.weatherLatest), rawNeutralKey(KEYS?.market?.weather), rawNeutralKey(KEYS?.marketWeather?.latest), rawNeutralKey(KEYS?.weather?.latest)]).filter((key) => !String(key).startsWith('LONG:'));
}

async function getCurrentMarketWeatherSafe() {
  if (cache.marketWeather && now() - cache.marketWeather.ts <= MARKET_WEATHER_TTL_MS) return { ...cache.marketWeather.value, cacheHit: true };
  for (const key of uniqueStrings([...marketWeatherKeyCandidates(), ...rawMarketWeatherKeyCandidates()])) {
    for (const client of redisClientsVolatileFirst()) {
      const payload = await softReadJson(client.redis, key, null);
      if (!payload) continue;
      const normalized = normalizeMarketWeather(payload, key, client.name);
      if (normalized.available) {
        cache.marketWeather = { ts: now(), value: normalized };
        return normalized;
      }
    }
  }
  const empty = normalizeMarketWeather(null, null, null);
  cache.marketWeather = { ts: now(), value: empty };
  return empty;
}

function currentFitForMicro(row = {}, marketWeather = null) {
  const parsed = parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microMicroFamilyId || '');
  if (!parsed.isMicroMicro || !marketWeather?.available) {
    return { currentFit: 'UNKNOWN', currentFitLabel: 'UNKNOWN', currentFitScore: 0, fitScore: 0, shortCurrentFit: 0, bearCurrentFit: 0, longCurrentFit: 0, bullCurrentFit: 0, currentFitConfidence: 0, currentFitReason: 'MARKET_WEATHER_UNAVAILABLE', currentFitReasons: ['MARKET_WEATHER_UNAVAILABLE'], currentFitVersion: CURRENT_FIT_VERSION, currentFitSoftOnly: true, currentFitBlocksLearning: false, currentFitBlocksDiscord: false, discordCurrentFitAllowed: true, currentMarketRegime: 'UNKNOWN', currentMarketTrendSide: 'UNKNOWN', currentBullishPct: null, currentBearishPct: null, currentSqueezePct: null, currentMarketWeatherAvailable: false, currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE', currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT' };
  }

  const marketRegime = normalizeMarketRegime(marketWeather.currentRegime);
  const marketTrendSide = normalizeMarketTrendSide(marketWeather.currentTrendSide);
  const bullishPct = pct01To100(marketWeather.bullishPct, null);
  const bearishPct = pct01To100(marketWeather.bearishPct, null);
  const squeezePct = pct01To100(marketWeather.squeezePct, null);
  const reasons = [];
  let score = 0;

  if (marketTrendSide === 'bear') { score += 35; reasons.push('SHORT_MARKET_SIDE_MATCH_BEAR'); }
  else if (marketTrendSide === 'neutral') { score += 8; reasons.push('SHORT_MARKET_SIDE_NEUTRAL'); }
  else if (marketTrendSide === 'bull') { score -= 45; reasons.push('SHORT_MARKET_SIDE_MISFIT_BULL'); }
  else reasons.push('SHORT_MARKET_SIDE_UNKNOWN');

  if (marketRegime === parsed.regime) { score += 30; reasons.push(`REGIME_MATCH_${parsed.regime}`); }
  else if (marketRegime !== 'UNKNOWN') { score -= 15; reasons.push(`REGIME_MISMATCH_${parsed.regime}_VS_${marketRegime}`); }

  if (parsed.setup === 'COMPRESSION') score += (marketRegime === 'SQUEEZE' || (squeezePct !== null && squeezePct >= 35)) ? 18 : -8;
  if (parsed.setup === 'BREAKOUT' && marketTrendSide === 'bear' && ['TREND', 'SQUEEZE'].includes(marketRegime)) score += 12;
  if (parsed.setup === 'CONTINUATION' && marketTrendSide === 'bear' && marketRegime === 'TREND') score += 16;
  if (parsed.setup === 'RETEST' && marketTrendSide === 'bear' && ['TREND', 'CHOP'].includes(marketRegime)) score += 10;
  if (parsed.setup === 'SWEEP_REVERSAL' && ['CHOP', 'SQUEEZE'].includes(marketRegime)) score += 12;
  if (parsed.regime === 'SQUEEZE' && squeezePct !== null) score += squeezePct >= 35 ? 15 : squeezePct < 15 ? -10 : 0;
  if (parsed.regime === 'TREND' && bearishPct !== null) score += bearishPct >= 55 ? 15 : bearishPct < 40 ? -15 : 0;
  if (bullishPct !== null && bearishPct !== null) score += bearishPct > bullishPct + 10 ? 10 : bullishPct > bearishPct + 10 ? -20 : 0;

  if (parsed.confirmationProfile === 'A_STRONG_ALIGN') score += marketTrendSide === 'bear' ? 12 : 6;
  if (parsed.confirmationProfile === 'B_FLOW_ALIGN') score += marketTrendSide === 'bear' ? 9 : 4;
  if (parsed.confirmationProfile === 'C_VOLUME_ALIGN') score += 5;
  if (parsed.confirmationProfile === 'D_MIXED_OK') score += marketTrendSide === 'neutral' || marketRegime === 'CHOP' ? 6 : 0;
  if (parsed.confirmationProfile === 'E_WEAK_CONTRA') score -= 8;

  score += 4;
  reasons.push('MICRO_MICRO_EXECUTION_CONTEXT_LAYER');
  const normalizedScore = round(clamp(score, -100, 100), 2);
  const label = normalizedScore >= 45 ? 'FIT' : normalizedScore >= 20 ? 'OK' : normalizedScore <= -20 ? 'MISFIT' : 'NEUTRAL';
  const confidence = clamp(Math.abs(normalizedScore) / 100 * 0.7 + num(marketWeather.confidence, 0.6) * 0.3, 0, 1);

  return { currentFit: label, currentFitLabel: label, currentFitScore: normalizedScore, fitScore: normalizedScore, shortCurrentFit: normalizedScore, bearCurrentFit: normalizedScore, bearishCurrentFit: normalizedScore, longCurrentFit: -normalizedScore, bullCurrentFit: -normalizedScore, bullishCurrentFit: -normalizedScore, currentFitConfidence: round(confidence, 4), currentFitReason: reasons.join('|'), currentFitReasons: reasons, currentFitVersion: CURRENT_FIT_VERSION, currentFitSoftOnly: true, currentFitBlocksLearning: false, currentFitBlocksVirtualLearning: false, currentFitBlocksShadowLearning: false, currentFitBlocksDiscord: label === 'MISFIT', discordCurrentFitAllowed: label !== 'MISFIT', currentMarketRegime: marketRegime, currentMarketTrendSide: marketTrendSide, currentBullishPct: bullishPct === null ? null : round(bullishPct, 2), currentBearishPct: bearishPct === null ? null : round(bearishPct, 2), currentSqueezePct: squeezePct === null ? null : round(squeezePct, 2), currentMarketWeatherAvailable: true, currentMarketWeatherSourceKey: marketWeather.sourceKey || null, currentMarketWeatherRedisSource: marketWeather.redisSource || null, currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE', currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT' };
}

function scannerMetadata(row = {}) {
  return { scannerMicroFamilyId: row.scannerMicroFamilyId || null, scannerFamilyId: row.scannerFamilyId || null, scannerFingerprintRole: 'METADATA_ONLY', scannerFingerprintsMetadataOnly: true, scannerFingerprintsUsedAsLearningFamily: false, executionMicroFamilyId: row.executionMicroFamilyId || null, executionFingerprintHash: row.executionFingerprintHash || null, executionFingerprintParts: Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [], executionFingerprintRole: 'METADATA_TO_MICRO_MICRO_CONTEXT_ONLY', executionFingerprintsMetadataOnly: true, executionFingerprintsUsedAsLearningFamily: false, executionFingerprintsCanDeriveMicroMicroContextHash: true, microMicroHash: row.microMicroHash || null, microMicroContextHash: row.microMicroContextHash || null, microMicroContextParts: Array.isArray(row.microMicroContextParts) ? row.microMicroContextParts : microMicroContextParts(row) };
}

function buildRawMicroMicroRow(row = {}, id = null, index = 0) {
  const microMicroFamilyId = id || buildMicroMicroFamilyId(getBase75ChildTrueMicroFamilyId(row), row, { allowChildProxy: true });
  if (!microMicroFamilyId) return null;
  const parsed = parseShortTaxonomyMicroId(microMicroFamilyId);
  if (!parsed.isMicroMicro) return null;
  if (inferTradeSide({ ...row, trueMicroFamilyId: microMicroFamilyId, microMicroFamilyId }) === OPPOSITE_TRADE_SIDE) return null;

  const completed = getCompletedSample(row);
  const counts = getOutcomeCounts(row);
  const riskGeometry = getShortRiskGeometry(row);
  const contextParts = microMicroContextParts(row);
  const generatedFromChildProxy = row.generatedMicroMicroFromChild75 === true || row.microMicroContextFallback === true || contextParts.length === 0;

  return { ...row, sourceIndex: index, id: microMicroFamilyId, key: microMicroFamilyId, microFamilyId: microMicroFamilyId, trueMicroFamilyId: microMicroFamilyId, trueMicroMicroFamilyId: microMicroFamilyId, exactMicroMicroFamilyId: microMicroFamilyId, analyzeMicroFamilyId: microMicroFamilyId, learningMicroFamilyId: microMicroFamilyId, microMicroFamilyId, childTrueMicroFamilyId: parsed.childTrueMicroFamilyId, base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId, parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId, coarseMicroFamilyId: parsed.parentTrueMicroFamilyId, baseMicroFamilyId: parsed.parentTrueMicroFamilyId, legacyMicroFamilyId: parsed.parentTrueMicroFamilyId, familyId: parsed.parentTrueMicroFamilyId, macroFamilyId: parsed.parentTrueMicroFamilyId, parentMacroFamilyId: parsed.parentTrueMicroFamilyId, parentMicroFamilyId: parsed.parentTrueMicroFamilyId, taxonomySetup: parsed.setup, taxonomyRegime: parsed.regime, confirmationProfile: parsed.confirmationProfile, microMicroHash: parsed.microMicroHash, setupType: parsed.setup, regimeBucket: parsed.regime, selectionLayer: 'MICRO_MICRO', selectableLayer: 'MICRO_MICRO', isMicroMicro: true, isBase75Child: false, generatedMicroMicroRow: true, generatedMicroMicroFromChild75: Boolean(generatedFromChildProxy), microMicroContextFallback: Boolean(generatedFromChildProxy), microMicroStatsSource: generatedFromChildProxy ? 'CHILD75_CONTEXT_PROXY_UNTIL_BACKEND_WRITES_EXACT_MM' : 'EXPLICIT_OR_CONTEXT_DERIVED_MICRO_MICRO', ...scannerMetadata({ ...row, microMicroFamilyId, microMicroHash: parsed.microMicroHash, microMicroContextParts: contextParts }), ...modePayload(), fixedTaxonomyLearningId: true, selectableTrueMicroFamily: true, selectableMicroMicro: true, selectable75Child: false, parentTrueMicroFamily: false, inferredTradeSide: TARGET_TRADE_SIDE, sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY, sourceWeekPrimary: row.sourceWeekPrimary !== false, sourceWeekFallback: Boolean(row.sourceWeekFallback), active: Boolean(row.active), macroActive: Boolean(row.macroActive), seen: num(row.seen ?? row.observations, 0), observations: num(row.observations ?? row.seen, 0), observationSample: getObservationSample(row), observationDuplicateSkippedCount: getObservationDuplicateSkippedCount(row), seenCompletedRatio: round(getSeenCompletedRatio(row), 4), completed: round(completed, 4), outcomeSample: round(completed, 4), wins: round(counts.wins, 4), losses: round(counts.losses, 4), flats: round(counts.flats, 4), totalR: round(getTotalR(row), 4), avgR: round(getAvgR(row), 4), profitFactor: round(getProfitFactor(row), 4), directSLCount: round(getDirectSLCount(row), 4), directSLPct: round(getDirectSLPct(row), 4), totalCostR: round(getTotalCostR(row), 4), avgCostR: round(getAvgCostR(row), 4), riskTradeSide: TARGET_TRADE_SIDE, validShortGeometry: Boolean(riskGeometry.validGeometry), shortValidGeometry: Boolean(riskGeometry.validGeometry), riskGeometryRule: riskGeometry.riskGeometryRule, tpHitRule: riskGeometry.tpHitRule, slHitRule: riskGeometry.slHitRule, grossRFormula: riskGeometry.grossRFormula, currentRFormula: riskGeometry.currentRFormula, shortTpHit: riskGeometry.shortTpHit, shortSlHit: riskGeometry.shortSlHit, tpHit: riskGeometry.shortTpHit, slHit: riskGeometry.shortSlHit, shortGrossR: round(riskGeometry.shortGrossR ?? row.shortGrossR ?? row.grossR, 4), shortCurrentR: round(riskGeometry.shortCurrentR ?? row.shortCurrentR ?? row.currentR, 4), currentR: round(riskGeometry.shortCurrentR ?? row.currentR, 4), definition: row.definition || row.microDefinition || null, definitionParts: Array.isArray(row.definitionParts) ? row.definitionParts : [], macroDefinition: row.macroDefinition || row.parentDefinition || null, macroDefinitionParts: Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : [], microDefinition: row.microDefinition || row.definition || null, microDefinitionParts: Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : [], microMicroDefinition: row.microMicroDefinition || null, microMicroDefinitionParts: contextParts, createdAt: row.createdAt || null, updatedAt: row.updatedAt || null };
}

function decorateMicroMicroRow(row = {}, marketWeather = null) {
  const id = row.trueMicroFamilyId || row.microMicroFamilyId;
  if (!id || !isMicroMicroFamilyId(id)) return null;
  const winrate = getSampleAdjustedWinrate(row);
  const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);
  const fit = currentFitForMicro(row, marketWeather);
  const adaptiveScore = dashboardBalancedScore + fit.currentFitScore * 0.15 + winrate.reliability * 10 - getDirectSLPct(row) * 10 - getAvgCostR(row) * 2;
  const learningStatus = learningStatusFor(row, winrate);
  const tier = tierFor(row, winrate);
  const tooEarly = winrate.outcomeSample < MIN_COMPLETED_MICRO_MICRO_ACTIVE;
  return { ...row, id, key: id, microFamilyId: id, trueMicroFamilyId: id, trueMicroMicroFamilyId: id, exactMicroMicroFamilyId: id, analyzeMicroFamilyId: id, learningMicroFamilyId: id, microMicroFamilyId: id, ...modePayload(), ...fit, completed: round(winrate.outcomeSample, 4), outcomeSample: round(winrate.outcomeSample, 4), observationSample: round(winrate.observationSample, 4), wins: round(winrate.wins, 4), losses: round(winrate.losses, 4), flats: round(winrate.flats, 4), winrateSample: round(winrate.sample, 4), sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4), sampleRawWinrate: round(row.sampleRawWinrate ?? winrate.rawWinrate, 4), sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrate.bayesianWinrate, 4), sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4), sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4), winrate: round(winrate.rawWinrate, 4), bayesianWinrate: round(winrate.bayesianWinrate, 4), wilsonLowerBound: round(winrate.wilsonLowerBound, 4), fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? winrate.score ?? row.bayesianWinrate ?? row.wilsonLowerBound, 4), totalR: round(getTotalR(row), 4), avgR: round(getAvgR(row), 4), profitFactor: round(getProfitFactor(row), 4), totalCostR: round(getTotalCostR(row), 4), avgCostR: round(getAvgCostR(row), 4), directSLCount: round(getDirectSLCount(row), 4), directSLPct: round(getDirectSLPct(row), 4), dashboardBalancedScore: round(row.dashboardBalancedScore ?? dashboardBalancedScore, 4), balancedScore: round(row.balancedScore ?? dashboardBalancedScore, 4), adaptiveScore: round(row.adaptiveScore ?? adaptiveScore, 4), awaitingOutcomes: Boolean(winrate.awaitingOutcomes), learningStatus, status: learningStatus, tooEarly, tooEarlyReason: tooEarly ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE}` : null, tier, selectedTier: row.selectedTier || row.rotationEligibilityTier || tier, rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tier, minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE };
}

function sourceRowsFromMicros(micros = {}) {
  return sourceEntriesFromMicros(micros).map(([key, row], index) => {
    if (!row || typeof row !== 'object') return null;
    const merged = { ...row, key: row.key || key, sourceIndex: index };
    const explicitMicroMicro = getExplicitMicroMicroId(merged);
    const childId = getBase75ChildTrueMicroFamilyId(merged, key);
    if (!explicitMicroMicro && !childId) return null;
    if (inferTradeSide({ ...merged, trueMicroFamilyId: explicitMicroMicro || childId }) === OPPOSITE_TRADE_SIDE) return null;
    return { ...merged, sourceWeekKey: PERSISTENT_LEARNING_KEY, sourceWeekPrimary: true, childTrueMicroFamilyId: childId || parseShortTaxonomyMicroId(explicitMicroMicro).childTrueMicroFamilyId, base75ChildTrueMicroFamilyId: childId || parseShortTaxonomyMicroId(explicitMicroMicro).base75ChildTrueMicroFamilyId, parentTrueMicroFamilyId: getParentTrueMicroFamilyId(merged, key) || parseShortTaxonomyMicroId(explicitMicroMicro || childId).parentTrueMicroFamilyId };
  }).filter(Boolean);
}

function deriveMicroMicroRowsFromSourceRows(sourceRows = [], marketWeather = null) {
  const groups = new Map();
  let explicitRows = 0;
  let outcomeDerivedRows = 0;
  let childProxyRows = 0;

  function upsert(id, row, extra = {}) {
    const parsed = parseShortTaxonomyMicroId(id);
    if (!parsed.isMicroMicro) return;
    const existing = groups.get(id) || {};
    groups.set(id, { ...existing, ...row, ...extra, recentOutcomes: [...(Array.isArray(existing.recentOutcomes) ? existing.recentOutcomes : []), ...(Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [])].slice(-80), id, key: id, microFamilyId: id, trueMicroFamilyId: id, trueMicroMicroFamilyId: id, exactMicroMicroFamilyId: id, analyzeMicroFamilyId: id, learningMicroFamilyId: id, microMicroFamilyId: id, childTrueMicroFamilyId: parsed.childTrueMicroFamilyId, base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId, parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId, coarseMicroFamilyId: parsed.parentTrueMicroFamilyId, familyId: parsed.parentTrueMicroFamilyId, macroFamilyId: parsed.parentTrueMicroFamilyId, microMicroHash: parsed.microMicroHash, selectionLayer: 'MICRO_MICRO', isMicroMicro: true, isBase75Child: false, generatedMicroMicroRow: true, active: Boolean(existing.active || row.active), macroActive: Boolean(existing.macroActive || row.macroActive) });
  }

  for (const row of sourceRows) {
    const explicitId = getExplicitMicroMicroId(row);
    if (explicitId) {
      explicitRows += 1;
      upsert(explicitId, row, { generatedMicroMicroFromChild75: false, microMicroContextFallback: false, microMicroStatsSource: 'EXPLICIT_MICRO_MICRO_ROW' });
      continue;
    }

    const baseChildId = getBase75ChildTrueMicroFamilyId(row);
    const parsedChild = parseShortTaxonomyMicroId(baseChildId);
    if (!parsedChild.isBaseChild) continue;

    const outcomes = Array.isArray(row.recentOutcomes) ? row.recentOutcomes.filter((outcome) => outcome && typeof outcome === 'object' && isLearningOutcomeSource(outcome.source || outcome.outcomeSource || 'VIRTUAL') && isShortRow({ ...row, ...outcome })) : [];
    if (outcomes.length > 0) {
      for (const outcome of outcomes.slice(-60)) {
        const id = buildMicroMicroFamilyId(baseChildId, { ...row, ...outcome }, { allowChildProxy: true });
        if (!id || !isMicroMicroFamilyId(id)) continue;
        outcomeDerivedRows += 1;
        upsert(id, { ...row, recentOutcomes: [{ ...outcome, id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id }] }, { generatedMicroMicroFromChild75: false, microMicroContextFallback: microMicroContextParts({ ...row, ...outcome }).length === 0, microMicroStatsSource: 'RECENT_OUTCOME_CONTEXT_DERIVED' });
      }
      continue;
    }

    const proxyId = buildMicroMicroFamilyId(baseChildId, row, { allowChildProxy: true });
    if (!proxyId || !isMicroMicroFamilyId(proxyId)) continue;
    childProxyRows += 1;
    upsert(proxyId, row, { generatedMicroMicroFromChild75: true, microMicroContextFallback: microMicroContextParts(row).length === 0, microMicroStatsSource: microMicroContextParts(row).length === 0 ? 'CHILD75_DEFAULT_CONTEXT_PROXY' : 'CHILD75_CONTEXT_FIELDS_DERIVED' });
  }

  const rows = [...groups.values()].map((row, index) => decorateMicroMicroRow(buildRawMicroMicroRow(row, row.trueMicroFamilyId || row.microMicroFamilyId, index), marketWeather)).filter(Boolean).filter(isMicroMicroAnalyzeRow);
  return { rows, explicitRows, outcomeDerivedRows, childProxyRows };
}

const rowKey = (row = {}) => String(row.id || row.key || row.trueMicroFamilyId || row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId || row.learningMicroFamilyId || row.analyzeMicroFamilyId || row.microFamilyId || '').trim();

function mergeRows(primaryRows = [], fallbackRows = []) {
  const byKey = new Map();
  for (const row of fallbackRows) if (rowKey(row) && isMicroMicroAnalyzeRow(row)) byKey.set(rowKey(row), row);
  for (const row of primaryRows) {
    const key = rowKey(row);
    if (!key || !isMicroMicroAnalyzeRow(row)) continue;
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, ...row, id: key, key, active: Boolean(existing.active || row.active), macroActive: Boolean(existing.macroActive || row.macroActive), recentOutcomes: [...(Array.isArray(existing.recentOutcomes) ? existing.recentOutcomes : []), ...(Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [])].slice(-100) } : { ...row, id: key, key });
  }
  return [...byKey.values()].filter(isMicroMicroAnalyzeRow);
}

function extractActiveMicroMicroIds(activeRotation) {
  if (!activeRotation) return [];
  return uniqueStrings([activeRotation.microMicroFamilyIds || [], activeRotation.activeMicroMicroFamilyIds || [], activeRotation.selectedMicroMicroFamilyIds || [], activeRotation.microFamilyIds || [], activeRotation.activeMicroFamilyIds || [], activeRotation.trueMicroFamilyIds || [], activeRotation.ids || [], Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies.map((row) => row?.microMicroFamilyId || row?.trueMicroMicroFamilyId || row?.exactMicroMicroFamilyId || row?.trueMicroFamilyId) : []]).map((id) => parseShortTaxonomyMicroId(id)).filter((p) => p.isMicroMicro).map((p) => p.trueMicroFamilyId).filter((id) => inferTradeSide(id) !== OPPOSITE_TRADE_SIDE).slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractLegacyActiveChild75Ids(activeRotation) {
  if (!activeRotation) return [];
  return uniqueStrings([activeRotation.childTrueMicroFamilyIds || [], activeRotation.active75ChildFamilyIds || [], activeRotation.microFamilyIds || [], activeRotation.activeMicroFamilyIds || [], activeRotation.trueMicroFamilyIds || [], Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies.map((row) => row?.childTrueMicroFamilyId || row?.trueMicroFamilyId) : []]).filter(isFixedShortChildMicroId);
}

function extractActiveParentIds(activeRotation) {
  if (!activeRotation) return [];
  return uniqueStrings([activeRotation.macroFamilyIds || [], activeRotation.activeMacroFamilyIds || [], activeRotation.parentTrueMicroFamilyIds || [], activeRotation.macroIds || [], Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies.map((row) => row?.parentTrueMicroFamilyId || row?.macroFamilyId) : []]).filter((id) => inferTradeSide(id) !== OPPOSITE_TRADE_SIDE && validLearningId(id) && isFixedShortParentMicroId(id));
}

function buildRowsFromActiveRotation(activeRotation, marketWeather = null) {
  if (!activeRotation) return [];
  const rows = [];
  for (const id of extractActiveMicroMicroIds(activeRotation)) {
    const parsed = parseShortTaxonomyMicroId(id);
    const raw = buildRawMicroMicroRow({ id, key: id, trueMicroFamilyId: id, microMicroFamilyId: id, childTrueMicroFamilyId: parsed.childTrueMicroFamilyId, base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId, parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId, active: true, selectedTier: 'RAW', microMicroStatsSource: 'MANUAL_ACTIVE_MICRO_MICRO_ID' }, id, rows.length);
    const decorated = raw ? decorateMicroMicroRow(raw, marketWeather) : null;
    if (decorated) rows.push(decorated);
  }
  return rows;
}

function cleanMeasurementScore(row = {}) {
  const fix = row.measurementFixVersion || row.measurementVersion || '';
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

function getRankWinrate(row = {}) {
  return num(row.fairWinrate ?? row.sampleAdjustedWinrate ?? row.sampleWilsonLowerBound ?? row.wilsonLowerBound ?? row.sampleBayesianWinrate ?? row.bayesianWinrate ?? row.winrate, 0);
}

function compareNumberDesc(a, b) { return num(b, 0) - num(a, 0); }
function compareNumberAsc(a, b) { return num(a, 0) - num(b, 0); }
function compareIdAsc(a, b) { return String(a || '').localeCompare(String(b || '')); }
function learningQualityRank(row = {}) { const completed = num(row.outcomeSample ?? getCompletedSample(row), 0); const obs = num(row.observationSample ?? getObservationSample(row), 0); if (completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE) return 4; if (completed > 0) return 2.5; if (obs > 0) return 1.2; return 0; }

function compareRowsBase(a, b) {
  const aCompleted = num(a.outcomeSample ?? getCompletedSample(a), 0);
  const bCompleted = num(b.outcomeSample ?? getCompletedSample(b), 0);
  return compareNumberDesc(cleanMeasurementScore(a), cleanMeasurementScore(b)) || compareNumberDesc(aCompleted >= MIN_COMPLETED_MICRO_MICRO_ACTIVE ? 1 : 0, bCompleted >= MIN_COMPLETED_MICRO_MICRO_ACTIVE ? 1 : 0) || compareNumberDesc(getRankWinrate(a), getRankWinrate(b)) || compareNumberDesc(getTotalR(a) > 0 ? 1 : 0, getTotalR(b) > 0 ? 1 : 0) || compareNumberDesc(getTotalR(a), getTotalR(b)) || compareNumberDesc(getAvgR(a), getAvgR(b)) || compareNumberDesc(getProfitFactor(a), getProfitFactor(b)) || compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) || compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) || compareNumberDesc(aCompleted, bCompleted) || compareNumberDesc(a.observationSample ?? getObservationSample(a), b.observationSample ?? getObservationSample(b)) || compareIdAsc(a.trueMicroFamilyId, b.trueMicroFamilyId);
}

function compareRowsByMode(a, b, mode = DEFAULT_RANK_MODE) {
  if (mode === 'clean') return compareNumberDesc(cleanMeasurementScore(a), cleanMeasurementScore(b)) || compareRowsBase(a, b);
  if (mode === 'totalR') return compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) || compareNumberDesc(getTotalR(a), getTotalR(b)) || compareRowsBase(a, b);
  if (mode === 'avgR') return compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) || compareNumberDesc(getAvgR(a), getAvgR(b)) || compareRowsBase(a, b);
  if (mode === 'directSL') return compareNumberDesc(learningQualityRank(a), learningQualityRank(b)) || compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) || compareRowsBase(a, b);
  if (mode === 'observed') return compareNumberDesc(a.observationSample, b.observationSample) || compareRowsBase(a, b);
  if (mode === 'cost') return compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) || compareRowsBase(a, b);
  if (mode === 'currentFit') return compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) || compareRowsBase(a, b);
  if (mode === 'balanced') return compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) || compareRowsBase(a, b);
  if (mode === 'adaptive') return compareNumberDesc(a.adaptiveScore, b.adaptiveScore) || compareRowsBase(a, b);
  return compareRowsBase(a, b);
}

function normalizeRow(row = {}, index = 0, activeSet = new Set(), activeParentSet = new Set(), compact = true) {
  const id = row.trueMicroFamilyId || row.microMicroFamilyId;
  const parsed = parseShortTaxonomyMicroId(id);
  const parentId = parsed.parentTrueMicroFamilyId;
  const winrate = getSampleAdjustedWinrate(row);
  const riskGeometry = getShortRiskGeometry(row);
  const base = { ...row, rank: index + 1, id, key: id, microFamilyId: id, trueMicroFamilyId: id, trueMicroMicroFamilyId: id, exactMicroMicroFamilyId: id, analyzeMicroFamilyId: id, learningMicroFamilyId: id, microMicroFamilyId: id, childTrueMicroFamilyId: parsed.childTrueMicroFamilyId, base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId, parentTrueMicroFamilyId: parentId, coarseMicroFamilyId: parentId, familyId: parentId, macroFamilyId: parentId, taxonomySetup: parsed.setup, taxonomyRegime: parsed.regime, confirmationProfile: parsed.confirmationProfile, selectionLayer: 'MICRO_MICRO', selectableLayer: 'MICRO_MICRO', isMicroMicro: true, isBase75Child: false, ...modePayload(), active: Boolean(row.active || activeSet.has(id)), macroActive: Boolean(row.macroActive || activeParentSet.has(parentId)), completed: round(winrate.outcomeSample, 4), outcomeSample: round(winrate.outcomeSample, 4), observationSample: round(winrate.observationSample, 4), wins: round(winrate.wins, 4), losses: round(winrate.losses, 4), flats: round(winrate.flats, 4), winrate: round(winrate.rawWinrate, 4), fairWinrate: round(row.fairWinrate ?? winrate.score, 4), sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4), sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrate.wilsonLowerBound, 4), sampleReliability: round(row.sampleReliability ?? winrate.reliability, 4), totalR: round(getTotalR(row), 4), avgR: round(getAvgR(row), 4), profitFactor: round(getProfitFactor(row), 4), totalCostR: round(getTotalCostR(row), 4), avgCostR: round(getAvgCostR(row), 4), directSLCount: round(getDirectSLCount(row), 4), directSLPct: round(getDirectSLPct(row), 4), status: learningStatusFor(row, winrate), learningStatus: learningStatusFor(row, winrate), tier: tierFor(row, winrate), selectedTier: row.selectedTier || row.rotationEligibilityTier || tierFor(row, winrate), rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || tierFor(row, winrate), tooEarly: winrate.outcomeSample < MIN_COMPLETED_MICRO_MICRO_ACTIVE, tooEarlyReason: winrate.outcomeSample < MIN_COMPLETED_MICRO_MICRO_ACTIVE ? `COMPLETED_BELOW_${MIN_COMPLETED_MICRO_MICRO_ACTIVE}` : null, minCompletedForMicroMicroActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE, validShortGeometry: Boolean(riskGeometry.validGeometry), shortCurrentR: round(riskGeometry.shortCurrentR ?? row.shortCurrentR ?? row.currentR, 4), currentR: round(riskGeometry.shortCurrentR ?? row.currentR, 4), shortGrossR: round(riskGeometry.shortGrossR ?? row.shortGrossR ?? row.grossR, 4) };
  if (compact) {
    delete base.recentOutcomes;
    delete base.examples;
    delete base.counters;
  }
  return base;
}

function layerCounts(rows = []) { return { child75: 0, microMicro: rows.filter(isMicroMicroAnalyzeRow).length, parent15: 0, unknown: 0 }; }
function tierCounts(rows = []) { return rows.reduce((a, r) => { const t = upper(r.tier || tierFor(r)); if (t === 'MICRO_MICRO') a.MICRO_MICRO += 1; else if (t === 'MICRO_MICRO_SOFT') a.MICRO_MICRO_SOFT += 1; else if (t === 'OBSERVATION') a.OBSERVATION += 1; else a.RAW += 1; return a; }, { MICRO_MICRO: 0, MICRO_MICRO_SOFT: 0, OBSERVATION: 0, RAW: 0 }); }
function statusCounts(rows = []) { return rows.reduce((a, r) => { const s = upper(r.status || learningStatusFor(r)); a[s] = (a[s] || 0) + 1; return a; }, {}); }
function currentFitCounts(rows = []) { return rows.reduce((a, r) => { const k = upper(r.currentFit || 'UNKNOWN') || 'UNKNOWN'; a[k] = (a[k] || 0) + 1; return a; }, { FIT: 0, OK: 0, NEUTRAL: 0, MISFIT: 0, UNKNOWN: 0 }); }
function sideCounts(rows = []) { return rows.reduce((a, r) => { const s = inferTradeSide(r); if (s === OPPOSITE_TRADE_SIDE) a.long += 1; else a.short += 1; if (s === 'UNKNOWN') a.unknown += 1; return a; }, { short: 0, long: 0, unknown: 0 }); }
function compactBestRow(row = null) { return row && isMicroMicroAnalyzeRow(row) ? normalizeRow(row, row.rank || 1, new Set(), new Set(), true) : null; }
function buildParentSummaries(rows = []) { return [...new Set(rows.map((r) => r.parentTrueMicroFamilyId).filter(Boolean))].slice(0, 25).map((id) => ({ parentTrueMicroFamilyId: id, macroFamilyId: id, microMicroCount: rows.filter((r) => r.parentTrueMicroFamilyId === id).length, child75Hidden: true, bestMicroMicro: compactBestRow(rows.filter((r) => r.parentTrueMicroFamilyId === id).sort(compareRowsBase)[0]) })); }
function buildSummary(rows = [], activeSet = new Set()) { const completed = rows.reduce((s, r) => s + num(r.outcomeSample ?? getCompletedSample(r), 0), 0); const totalR = rows.reduce((s, r) => s + getTotalR(r), 0); const totalCostR = rows.reduce((s, r) => s + getTotalCostR(r), 0); const dsl = rows.reduce((s, r) => s + getDirectSLCount(r), 0); return { rows: rows.length, microMicroRows: rows.length, child75Rows: 0, activeRows: rows.filter((r) => activeSet.has(r.trueMicroFamilyId)).length, activeIds: activeSet.size, ...modePayload(), completed: round(completed, 4), observationSample: round(rows.reduce((s, r) => s + getObservationSample(r), 0), 4), completedMicroMicroFamilies: rows.filter((r) => getCompletedSample(r) > 0).length, tierCounts: tierCounts(rows), statusCounts: statusCounts(rows), currentFitCounts: currentFitCounts(rows), layerCounts: layerCounts(rows), totalR: round(totalR, 4), totalCostR: round(totalCostR, 4), avgR: completed > 0 ? round(totalR / completed, 4) : 0, avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0, directSLCount: round(dsl, 4), directSLPct: completed > 0 ? round(dsl / completed, 4) : 0, bestMicroMicro: compactBestRow([...rows].sort(compareRowsBase)[0]), bestAdaptive: compactBestRow([...rows].sort(compareRowsBase)[0]), bestWinratePnl: compactBestRow([...rows].sort(compareRowsBase)[0]), short: { rows: rows.length, layerCounts: layerCounts(rows), bestMicroMicro: compactBestRow([...rows].sort(compareRowsBase)[0]) }, long: { rows: 0 } }; }

async function getActiveRotationSafe() { try { return await withTimeout(getActiveRotation({ tradeSide: TARGET_TRADE_SIDE, side: TARGET_DASHBOARD_SIDE, weekKey: PERSISTENT_LEARNING_KEY, namespace: SHORT_NAMESPACE, keyPrefix: SHORT_KEY_PREFIX, microMicroOnly: true, selectionGranularity: 'EXACT_MICRO_MICRO_ONLY' }), ACTIVE_ROTATION_TIMEOUT_MS, 'GET_ACTIVE_ROTATION_TIMEOUT'); } catch { return null; } }
function getCachedWeekMicros(weekKey) { const c = cache.weekMicros.get(weekKey); return c && now() - c.ts <= CACHE_TTL_MS ? c.micros || {} : null; }
async function getWeekMicrosCached(weekKey, timeoutMs) { const c = getCachedWeekMicros(weekKey); if (c) return { weekKey, micros: c, cacheHit: true, stale: false, warning: null }; try { const micros = await withTimeout(getWeekMicros(weekKey), timeoutMs, `GET_WEEK_MICROS_TIMEOUT_${weekKey}`); const safe = micros && typeof micros === 'object' ? micros : {}; cache.weekMicros.set(weekKey, { ts: now(), micros: safe }); while (cache.weekMicros.size > CACHE_MAX_KEYS) cache.weekMicros.delete(cache.weekMicros.keys().next().value); return { weekKey, micros: safe, cacheHit: false, stale: false, warning: null }; } catch (e) { const stale = cache.weekMicros.get(weekKey); if (stale?.micros) return { weekKey, micros: stale.micros, cacheHit: true, stale: true, warning: e?.message || String(e) }; return { weekKey, micros: {}, cacheHit: false, stale: false, warning: e?.message || String(e) }; } }

function parseFilters(req) { return { side: upper(firstQueryValue(req.query?.side, TARGET_TRADE_SIDE)), q: upper(firstQueryValue(req.query?.q, '')), activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false)), minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0), setup: upper(firstQueryValue(req.query?.setup, '')), regime: upper(firstQueryValue(req.query?.regime, '')), confirmationProfile: upper(firstQueryValue(req.query?.confirmationProfile, '')), currentFit: upper(firstQueryValue(req.query?.currentFit, '')) }; }
function rowMatchesSearch(row = {}, q = '') { if (!q) return true; return JSON.stringify(row).toUpperCase().includes(q); }
function rowPassesFilters(row = {}, filters, activeSet) { const parsed = parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microMicroFamilyId); if (!isMicroMicroAnalyzeRow(row)) return false; if (filters.side && ['LONG', 'BULL', 'BULLISH', 'BUY'].includes(filters.side)) return false; if (filters.activeOnly && !activeSet.has(row.trueMicroFamilyId)) return false; if (filters.minCompleted > 0 && getCompletedSample(row) < filters.minCompleted) return false; if (filters.setup && parsed.setup !== filters.setup) return false; if (filters.regime && parsed.regime !== filters.regime) return false; if (filters.confirmationProfile && parsed.confirmationProfile !== filters.confirmationProfile) return false; if (filters.currentFit && upper(row.currentFit) !== filters.currentFit) return false; return rowMatchesSearch(row, filters.q); }

function methodNotAllowed(res) { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED', allowed: ['GET'], ...modePayload() }); }
function setHeaders(res) { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.setHeader('X-Admin-Micro-Families-Mode', 'short-only-micro-micro-only-selection-v4-stable'); res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE); res.setHeader('X-Short-Only', 'true'); res.setHeader('X-Long-Disabled', 'true'); res.setHeader('X-Real-Orders-Disabled', 'true'); res.setHeader('X-Micro-Micro-Only', 'true'); res.setHeader('X-Micro-Micro-Schema', MICRO_MICRO_SCHEMA); res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID'); res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY'); res.setHeader('X-Learning-Identity-Source', 'ANALYZE_MICRO_MICRO_FAMILY'); res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY); res.setHeader('X-Min-Completed-Micro-Micro-Active', String(MIN_COMPLETED_MICRO_MICRO_ACTIVE)); }

export default async function handler(req, res) {
  const startedAt = now();
  setHeaders(res);
  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const requestedQueryWeekKey = String(firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) || PERSISTENT_LEARNING_KEY).trim();
    const mode = normalizeMode(firstQueryValue(req.query?.mode, DEFAULT_RANK_MODE));
    const limit = toSafeLimit(firstQueryValue(req.query?.limit, DEFAULT_LIMIT), DEFAULT_LIMIT, MAX_LIMIT);
    const bestLimit = toSafeLimit(firstQueryValue(req.query?.bestLimit, DEFAULT_BEST_LIMIT), DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);
    const compact = !isTrue(firstQueryValue(req.query?.details, false));
    const filters = parseFilters(req);

    const [activeRotation, weekResult, marketWeather] = await Promise.all([getActiveRotationSafe(), getWeekMicrosCached(PERSISTENT_LEARNING_KEY, WEEK_MICROS_TIMEOUT_MS), getCurrentMarketWeatherSafe()]);
    const activeMicroMicroFamilyIds = extractActiveMicroMicroIds(activeRotation);
    const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotation);
    const activeParentIds = extractActiveParentIds(activeRotation);
    const activeSet = new Set(activeMicroMicroFamilyIds);
    const activeParentSet = new Set(activeParentIds);

    const sourceRows = sourceRowsFromMicros(weekResult.micros);
    const derived = deriveMicroMicroRowsFromSourceRows(sourceRows, marketWeather);
    const activeFallbackRows = buildRowsFromActiveRotation(activeRotation, marketWeather);
    const mergedRows = mergeRows(derived.rows, activeFallbackRows).map((row) => ({ ...row, active: Boolean(row.active || activeSet.has(row.trueMicroFamilyId)), macroActive: Boolean(row.macroActive || activeParentSet.has(row.parentTrueMicroFamilyId)) })).filter(isMicroMicroAnalyzeRow);
    const filteredRows = mergedRows.filter((row) => rowPassesFilters(row, filters, activeSet));
    const rankedRows = [...filteredRows].sort((a, b) => compareRowsByMode(a, b, mode)).map((row, index) => ({ ...row, rank: index + 1 }));
    const bestRawRows = [...mergedRows].sort((a, b) => compareRowsByMode(a, b, mode)).slice(0, bestLimit).map((row, index) => ({ ...row, rank: index + 1 }));
    const normalizedRows = rankedRows.slice(0, limit).map((row, index) => normalizeRow(row, index, activeSet, activeParentSet, compact));
    const bestMicroMicroFamilies = bestRawRows.map((row, index) => normalizeRow(row, index, activeSet, activeParentSet, compact));

    const weekEntries = sourceEntriesFromMicros(weekResult.micros);
    const rawScannerFingerprintRowsHidden = weekEntries.filter(([key, row]) => isScannerFingerprintId(row?.trueMicroFamilyId || row?.microFamilyId || key)).length;
    const rawExecutionFingerprintRowsHidden = weekEntries.filter(([key, row]) => isExecutionFingerprintId(row?.trueMicroFamilyId || row?.microFamilyId || key)).length;
    const child75RowsHidden = sourceRows.filter((row) => isFixedShortChildMicroId(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId)).length;
    const parentRowsHidden = weekEntries.filter(([key, row]) => isFixedShortParentMicroId(row?.trueMicroFamilyId || row?.microFamilyId || key)).length;
    const layers = layerCounts(mergedRows);
    const fitCounts = currentFitCounts(mergedRows);

    const warnings = uniqueWarnings([
      requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}` : null,
      weekResult.warning,
      marketWeather.available !== true ? `MARKET_WEATHER_UNAVAILABLE:${marketWeather.reason || 'UNKNOWN'}` : null,
      legacyChild75ActiveIdsIgnored.length > 0 ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED_MICRO_MICRO_ONLY:${legacyChild75ActiveIdsIgnored.length}` : null,
      rawScannerFingerprintRowsHidden > 0 ? `SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawScannerFingerprintRowsHidden}` : null,
      rawExecutionFingerprintRowsHidden > 0 ? `EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${rawExecutionFingerprintRowsHidden}` : null,
      child75RowsHidden > 0 ? `CHILD75_ROWS_USED_AS_CONTEXT_ONLY_HIDDEN_FROM_ADMIN:${child75RowsHidden}` : null,
      parentRowsHidden > 0 ? `PARENT15_ROWS_HIDDEN_METADATA_ONLY:${parentRowsHidden}` : null,
      derived.rows.length === 0 ? 'NO_MICRO_MICRO_ROWS_AVAILABLE' : null,
      derived.childProxyRows > 0 ? `MICRO_MICRO_CHILD75_PROXY_ROWS_CREATED:${derived.childProxyRows}` : null,
      derived.outcomeDerivedRows > 0 ? `MICRO_MICRO_ROWS_DERIVED_FROM_RECENT_OUTCOMES:${derived.outcomeDerivedRows}` : null,
      derived.explicitRows > 0 ? `EXPLICIT_MICRO_MICRO_ROWS_FOUND:${derived.explicitRows}` : null
    ]);

    return res.status(200).json({
      ok: true,
      fixed: true,
      ...modePayload(),
      availableTiers: ['MICRO_MICRO', 'MICRO_MICRO_SOFT', 'OBSERVATION', 'RAW'],
      availableStatuses: ['MICRO_MICRO_ACTIVE', 'MICRO_MICRO_EARLY', 'MICRO_MICRO_OBSERVING'],
      availableCurrentFit: ['FIT', 'OK', 'NEUTRAL', 'MISFIT', 'UNKNOWN'],
      availableLayers: ['MICRO_MICRO'],
      manualSelectionPolicy: { maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES, maxManualMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES, maxSelectedMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES, selectionGranularity: 'EXACT_MICRO_MICRO_ONLY', selectableMicroMicroIdsAllowed: true, selectable75ChildIdsAllowed: false, selectableChildIdsAllowed: false, parentIdsAreMetadataOnly: true, child75IdsAreContextOnly: true, parentMatchDoesNotTriggerDiscord: true, macroMatchDoesNotTriggerDiscord: true, child75MatchDoesNotTriggerDiscord: true, scannerFingerprintsUsedAsLearningFamily: false, executionFingerprintsUsedAsLearningFamily: false, executionFingerprintsCanDeriveMicroMicroContextHash: true },
      measurementPolicy: { version: MEASUREMENT_FIX_VERSION, completed: 'closed VIRTUAL + SHADOW outcomes only', scoringRSource: 'netR', winsLossesFlatsSource: 'netR', rawWinrateRankingDisabled: true },
      currentFitPolicy: { version: CURRENT_FIT_VERSION, marketWeatherAvailable: Boolean(marketWeather.available), sourceKey: marketWeather.sourceKey || null, redisSource: marketWeather.redisSource || null, currentRegime: marketWeather.currentRegime, currentTrendSide: marketWeather.currentTrendSide, bullishPct: marketWeather.bullishPct, bearishPct: marketWeather.bearishPct, squeezePct: marketWeather.squeezePct, confidence: marketWeather.confidence, reason: marketWeather.reason || null, softOnly: true, blocksLearning: false, canBlockDiscordOnly: true },
      microMicroPolicy: { version: MICRO_MICRO_VERSION, enabled: true, only: true, schema: MICRO_MICRO_SCHEMA, marker: MICRO_MICRO_MARKER, hashLength: MICRO_MICRO_HASH_LEN, learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY, minCompletedForActive: MIN_COMPLETED_MICRO_MICRO_ACTIVE, format: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}', altFormatAccepted: 'MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_{CONTEXT_TAGS}', base75ChildIsContextOnly: true, parent15StillMetadataOnly: true, microMicroSelectable: true, microMicroActsAsExecutionPreference: true, selectionGranularity: 'EXACT_MICRO_MICRO_ONLY', explicitRowsFound: derived.explicitRows, derivedFromRecentOutcomes: derived.outcomeDerivedRows, child75ProxyRows: derived.childProxyRows, rowsCount: derived.rows.length, activeMicroMicroIds: activeMicroMicroFamilyIds },
      statusRules: { MICRO_MICRO_OBSERVING: 'completed == 0 for micro-micro', MICRO_MICRO_EARLY: `completed > 0 && completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} for micro-micro`, MICRO_MICRO_ACTIVE: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} for micro-micro` },
      taxonomy: { parentCount: 15, child75ContextCount: 75, selectableChildCount: 0, selectableMicroMicroCount: layers.microMicro, setups: SETUP_ORDER, regimes: REGIME_ORDER, confirmationProfiles: CONFIRMATION_PROFILE_ORDER, parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}', childFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}', microMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}', selectableIdsAreMicroMicroOnly: true, child75IdsAreContextOnly: true, parentIdsAreMetadataOnly: true, parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA, childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA, microMicroFamilySchema: MICRO_MICRO_SCHEMA },
      rankingPolicy: { defaultMode: DEFAULT_RANK_MODE, activeMode: mode, defaultSort: 'adaptive/fairWinrate/positivePnl/totalR/avgR/profitFactor/directSL/avgCostR/completed', bestDataFirst: true, completedBeforeRawScore: true, rawWinrateIsNeverDefault: true, pnlSource: 'totalR', winrateSource: 'fairWinrate', scannerFingerprintsExcludedFromRows: true, exactMicroMicroOnly: true, selectableMicroMicroOnly: true, persistentLearningKey: PERSISTENT_LEARNING_KEY, scoringRSource: 'netR', winsLossesFlatsSource: 'netR', winrateDefinition: 'netR > 0', avgCostRSource: 'costR' },
      adaptiveLayerPolicy: { learningRemainsBroad: true, child75RemainsContextLayer: true, child75HiddenFromAdminRows: true, microMicroLayerEnabled: true, microMicroActsAsExecutionPreference: true, microMicroSelectionOnly: true, discordWillBeStrict: true, currentFitSoftOnly: true, currentFitBlocksLearning: false },
      weekKey: PERSISTENT_LEARNING_KEY,
      requestedWeekKey: PERSISTENT_LEARNING_KEY,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY ? requestedQueryWeekKey : null,
      sourceWeekKeyUsed: PERSISTENT_LEARNING_KEY,
      source: 'persistentLearningKey',
      currentWeekKey: PERSISTENT_LEARNING_KEY,
      previousWeekKey: PERSISTENT_LEARNING_KEY,
      primaryWeekKey: PERSISTENT_LEARNING_KEY,
      primaryWeekRows: sourceEntriesFromMicros(weekResult.micros).length,
      previousWeekRows: 0,
      mergedPreviousWeek: false,
      recentWeekLookback: 1,
      recentWeekKeysScanned: [PERSISTENT_LEARNING_KEY],
      recentWeekRows: [{ weekKey: PERSISTENT_LEARNING_KEY, rows: sourceEntriesFromMicros(weekResult.micros).length, cacheHit: Boolean(weekResult.cacheHit), stale: Boolean(weekResult.stale) }],
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
      generatedMicroMicroRows: derived.rows.length,
      explicitMicroMicroRows: derived.explicitRows,
      outcomeDerivedMicroMicroRows: derived.outcomeDerivedRows,
      child75ProxyMicroMicroRows: derived.childProxyRows,
      selectableChildFamiliesTotal: 0,
      selectableMicroMicroFamiliesTotal: layers.microMicro,
      parentFamiliesTotal: 15,
      weekRows: sourceRows.length,
      microMicroRowsCount: derived.rows.length,
      microMicroRowsTotal: derived.rows.length,
      activeFallbackRows: activeFallbackRows.length,
      child75RowsHidden,
      parentRowsHidden,
      rawScannerFingerprintRowsHidden,
      rawExecutionFingerprintRowsHidden,
      rawSideCounts: sideCounts(mergedRows),
      filteredSideCounts: sideCounts(rankedRows),
      responseSideCounts: sideCounts(normalizedRows),
      bestSideCounts: sideCounts(bestMicroMicroFamilies),
      rawLayerCounts: layers,
      filteredLayerCounts: layerCounts(rankedRows),
      responseLayerCounts: layerCounts(normalizedRows),
      bestLayerCounts: layerCounts(bestMicroMicroFamilies),
      tierCounts: tierCounts(rankedRows),
      statusCounts: statusCounts(rankedRows),
      currentFitCounts: fitCounts,
      currentFitUnknownRows: fitCounts.UNKNOWN || 0,
      activeRotationId: activeRotation?.rotationId || null,
      activeRotation: { rotationId: activeRotation?.rotationId || null, activeMicroMicroFamilyIds, microMicroFamilyIds: activeMicroMicroFamilyIds, activeMicroFamilyIds: activeMicroMicroFamilyIds, trueMicroFamilyIds: activeMicroMicroFamilyIds, activeMacroFamilyIds: activeParentIds, legacyChild75ActiveIdsIgnored, ...modePayload() },
      activeMicroFamilyIds: activeMicroMicroFamilyIds,
      activeTrueMicroFamilyIds: activeMicroMicroFamilyIds,
      activeMicroMicroFamilyIds,
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
      perf: { durationMs: now() - startedAt, weekMicrosCacheHit: Boolean(weekResult.cacheHit), weekMicrosCacheStale: Boolean(weekResult.stale), weekMicrosCacheSize: cache.weekMicros.size, marketWeatherCacheHit: Boolean(marketWeather.cacheHit), path: 'shortOnlyMicroMicroOnlyPersistentLearningNetOutcomeObservationFirstCurrentFitV4Stable', bestSource: 'microMicroRowsOnly', compactPayload: compact },
      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, ...modePayload(), error: error?.message || String(error), stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack });
  }
}