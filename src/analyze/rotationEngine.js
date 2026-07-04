// ================= FILE: src/analyze/rotationEngine.js =================
//
// SHORT-only Rotation engine.
//
// Doel:
// - Alleen handmatige SHORT micro-micro selectie mag live Discord triggeren.
// - Parent 15 = metadata/context.
// - 75-child = context/rollup, niet selecteerbaar.
// - Micro-micro = enige selecteerbare laag.
// - Scanner buckets blijven metadata.
// - XR execution fingerprint blijft metadata/hash-bron, niet learning id.
// - Geen auto-activatie.
// - Geen LONG.
// - Geen real orders.
//
// Selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
// - MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_{CONTEXT_TAGS} wordt genormaliseerd naar canonical MM id.
//
// Niet selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - scanner fingerprints
// - raw XR execution fingerprints
// - LONG ids

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

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
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;
const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V1';

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V11';
const RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V3';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MICRO_MICRO_ONLY_V3';

const EXECUTION_MICRO_SUFFIX = 'XR';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_CHILD_75 = 'CHILD_75_CONTEXT';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const SELECTION_EXACT_MICRO_MICRO_ONLY = 'EXACT_MICRO_MICRO_ONLY';
const SELECTION_NOT_SELECTABLE = 'NOT_SELECTABLE';

const DEFAULT_TOP_N_PER_SIDE = 2;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_MICRO_MICRO_COMPLETED = 35;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const DEFAULT_RECENT_MOMENTUM_LOOKBACK = 12;
const DEFAULT_STALE_WINNER_DAYS = 10;

const SETUP_TYPES = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_BUCKETS = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILES = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SETUP_SET = new Set(SETUP_TYPES);
const REGIME_SET = new Set(REGIME_BUCKETS);
const CONFIRMATION_SET = new Set(CONFIRMATION_PROFILES);

const MANUAL_ACTIVE_SOURCES = new Set([
  'ADMIN_MANUAL_SELECTION_SHORT_MICRO_MICRO_ONLY',
  'ADMIN_ACTIVATE_SELECTED_SHORT_MICRO_MICROS',
  'CLI_MANUAL_SELECTION_SHORT_ONLY',
  'CLI_MANUAL_SHORT_MICRO_MICRO_DISCORD_SELECTION'
]);

function now() {
  return Date.now();
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

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function finiteOrNull(value) {
  if (!hasValue(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function namespacedShortKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}MISSING_KEY`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function activeRotationKey() {
  return namespacedShortKey(
    KEYS.short?.analyze?.activeRotation ||
      KEYS.analyze?.shortActiveRotation ||
      KEYS.analyze?.activeRotation,
    'ANALYZE:ACTIVE_ROTATION'
  );
}

function nextRotationKey() {
  return namespacedShortKey(
    KEYS.short?.analyze?.nextRotation ||
      KEYS.analyze?.shortNextRotation ||
      KEYS.analyze?.nextRotation,
    'ANALYZE:NEXT_ROTATION'
  );
}

function rotationValidFromKey() {
  return namespacedShortKey(
    KEYS.short?.analyze?.rotationValidFrom ||
      KEYS.analyze?.shortRotationValidFrom ||
      KEYS.analyze?.rotationValidFrom,
    'ANALYZE:ROTATION_VALID_FROM'
  );
}

function learningDataKey(weekKey = PERSISTENT_LEARNING_KEY) {
  return String(
    CONFIG.short?.analyze?.persistentLearningKey ||
      CONFIG.short?.rotation?.persistentLearningKey ||
      CONFIG.analyze?.shortPersistentLearningKey ||
      weekKey ||
      PERSISTENT_LEARNING_KEY
  ).trim() || PERSISTENT_LEARNING_KEY;
}

function topNPerSide() {
  const preferred =
    CONFIG.short?.rotation?.topNShort ??
    CONFIG.rotation?.topNShort ??
    CONFIG.rotation?.topNPerSide ??
    DEFAULT_TOP_N_PER_SIDE;

  const n = Math.floor(Number(preferred));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N_PER_SIDE;

  return Math.max(DEFAULT_TOP_N_PER_SIDE, Math.min(MAX_TOP_N_PER_SIDE, n));
}

function minMicroMicroCompleted() {
  return Math.max(
    0,
    num(
      CONFIG.short?.rotation?.minMicroMicroCompleted ??
        CONFIG.rotation?.minMicroMicroCompleted,
      DEFAULT_MIN_MICRO_MICRO_COMPLETED
    )
  );
}

function minPrimaryRowsForPreviousMerge() {
  const n = Number(
    CONFIG.short?.rotation?.minPrimaryRowsForPreviousMerge ??
      CONFIG.rotation?.minPrimaryRowsForPreviousMerge ??
      0
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}

function defaultRotationMode() {
  return CONFIG.short?.rotation?.mode || CONFIG.rotation?.mode || 'adaptive';
}

function allowManualUnknownMicroMicroIds() {
  return CONFIG.short?.rotation?.allowManualUnknownMicroMicroIds !== false;
}

function allowSoftRotationFallback() {
  return CONFIG.short?.rotation?.allowSoftRotationFallback !== false;
}

function allowObservationRotationFallback() {
  return CONFIG.short?.rotation?.allowObservationRotationFallback !== false;
}

function allowRawRotationFallback() {
  return CONFIG.short?.rotation?.allowRawRotationFallback !== false;
}

function allowLegacyCompletedFallback() {
  return CONFIG.short?.analyze?.allowLegacyCompletedFallback === true ||
    CONFIG.analyze?.allowLegacyCompletedFallback === true;
}

function recentMomentumLookback() {
  const n = Number(
    CONFIG.short?.rotation?.recentMomentumLookback ??
      CONFIG.rotation?.recentMomentumLookback ??
      DEFAULT_RECENT_MOMENTUM_LOOKBACK
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_RECENT_MOMENTUM_LOOKBACK;
}

function staleWinnerDays() {
  const n = Number(
    CONFIG.short?.rotation?.staleWinnerDays ??
      CONFIG.rotation?.staleWinnerDays ??
      DEFAULT_STALE_WINNER_DAYS
  );

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_STALE_WINNER_DAYS;
}

function schemaMeta() {
  return {
    schema: MICRO_MICRO_SCHEMA,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    strategyVersion: CONFIG.strategyVersion
  };
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
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
    shadowOnly: false,
    outcomeSource: 'VIRTUAL_AND_SHADOW',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    noRealOrders: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,
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

    observationFirst: true,
    observationAlwaysCounted: true,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    costModelVersion: COST_MODEL_VERSION,
    riskPlanVersion: RISK_PLAN_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    statusRules: {
      MICRO_MICRO_OBSERVING: 'completed == 0',
      MICRO_MICRO_EARLY: `completed > 0 && completed < ${DEFAULT_MIN_MICRO_MICRO_COMPLETED}`,
      MICRO_MICRO_ACTIVE: `completed >= ${DEFAULT_MIN_MICRO_MICRO_COMPLETED}`
    },

    defaultRanking: 'cleanMeasurement|adaptiveScore|fairWinrate|totalR|avgR|profitFactor|directSL|avgCostR|completed',
    rankingUsesAdaptiveScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    bareWinrateRankingDisabled: true,
    rawWinrateRankingDisabled: true,

    selectionUsesAdaptiveScore: true,
    selectionGranularity: SELECTION_EXACT_MICRO_MICRO_ONLY,
    selectableMicroMicroOnly: true,
    selectableChild75Allowed: false,
    selectableParentAllowed: false,
    parentSelectionAllowed: false,
    child75SelectionAllowed: false,

    currentFitScoreEnabled: true,
    adaptiveScoreEnabled: true,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscordOnly: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionIsAdaptive: true,
    discordWillBeStrict: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    manualSelectionMustUseExactMicroMicroId: true,
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordSelectionRule: SELECTION_EXACT_MICRO_MICRO_ONLY,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    child75MatchDoesNotTriggerDiscord: true,
    scannerMatchDoesNotTriggerDiscord: true,
    executionFingerprintMatchDoesNotTriggerDiscord: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    scannerSide: TARGET_SCANNER_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    rawExecutionFingerprintsNotSelectable: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesIncludedOnlyInsideMicroMicroId: true,

    fixedTaxonomyPreferred: true,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningEnabled: true,
    parentLearningEnabled: true,
    microMicroLearningEnabled: true,
    layeredLearningEnabled: true,
    sampleProtectionLayeringEnabled: true,
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    autoRotation: false,
    autoRotationDisabled: true,
    activateNextDisabled: true,
    activateCronDisabled: true,
    freezeCronDisabled: true,
    resetCronDisabled: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    learningDataKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,

    rootSide: TARGET_TRADE_SIDE,
    rootIsolated: true,
    longRootTouched: false
  };
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

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
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
    .replace(/[^A-Z0-9=:_|]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizedSignalText(value);
  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`)
  ));
}

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'DOWN',
    'DOWNSIDE',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'MICRO_SHORT',
    'MM_SHORT',
    'FAMILY_SHORT'
  ]);
}

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'UP',
    'UPSIDE',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'MICRO_LONG',
    'MM_LONG',
    'FAMILY_LONG'
  ]);
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
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
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
    selectionLayer: 'UNKNOWN',
    selectionGranularity: SELECTION_NOT_SELECTABLE
  };
}

function parseBodySetupRegimeConfirmation(body = '') {
  const cleanBody = upper(body).replace(/^_+|_+$/g, '');

  for (const setup of SETUP_TYPES) {
    if (cleanBody !== setup && !cleanBody.startsWith(`${setup}_`)) continue;

    const afterSetup = cleanBody === setup
      ? ''
      : cleanBody.slice(setup.length + 1);

    if (!afterSetup) {
      return {
        ok: false,
        setupType: setup,
        regimeBucket: null,
        confirmationProfile: null,
        rest: ''
      };
    }

    for (const regime of REGIME_BUCKETS) {
      if (afterSetup !== regime && !afterSetup.startsWith(`${regime}_`)) continue;

      const afterRegime = afterSetup === regime
        ? ''
        : afterSetup.slice(regime.length + 1);

      if (!afterRegime) {
        return {
          ok: true,
          setupType: setup,
          regimeBucket: regime,
          confirmationProfile: null,
          rest: ''
        };
      }

      for (const profile of CONFIRMATION_PROFILES) {
        if (afterRegime === profile) {
          return {
            ok: true,
            setupType: setup,
            regimeBucket: regime,
            confirmationProfile: profile,
            rest: ''
          };
        }

        if (afterRegime.startsWith(`${profile}_`)) {
          return {
            ok: true,
            setupType: setup,
            regimeBucket: regime,
            confirmationProfile: profile,
            rest: afterRegime.slice(profile.length + 1)
          };
        }
      }
    }
  }

  return {
    ok: false,
    setupType: null,
    regimeBucket: null,
    confirmationProfile: null,
    rest: ''
  };
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

  const validParent =
    SETUP_SET.has(parsed.setupType) &&
    REGIME_SET.has(parsed.regimeBucket);

  const validChild =
    validParent &&
    Boolean(parsed.confirmationProfile) &&
    CONFIRMATION_SET.has(parsed.confirmationProfile);

  if (!validParent) return invalidParsed(rawId);

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setupType}_${parsed.regimeBucket}`;
  const childTrueMicroFamilyId = validChild
    ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}`
    : null;

  const isParent = validParent && !validChild;
  const isChild = validChild && !explicitMicroMicro && !parsed.rest;
  const isMicroMicro = validChild && (explicitMicroMicro || Boolean(parsed.rest));

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
    setupType: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
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
    trueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? CHILD_TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? CHILD_TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningLayer: isMicroMicro
      ? LAYER_MICRO_MICRO
      : isChild
        ? LAYER_CHILD_75
        : LAYER_PARENT_15,
    selectionLayer: isMicroMicro ? LAYER_MICRO_MICRO : SELECTION_NOT_SELECTABLE,
    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isChild
        ? CHILD75_LEARNING_GRANULARITY
        : PARENT_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: isMicroMicro ? SELECTION_EXACT_MICRO_MICRO_ONLY : SELECTION_NOT_SELECTABLE
  };
}

function cleanLearningMicroId(id = '') {
  const raw = String(id || '').trim();
  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  const parsed = parseShortTaxonomyMicroId(raw);
  return parsed.valid ? parsed.trueMicroFamilyId : upper(raw);
}

function isFixedTaxonomyParentOnlyId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isFixedTaxonomyChildId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isFixedTaxonomyMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isSelectableMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).selectable === true;
}

function schemaForId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return MICRO_MICRO_SCHEMA;
  if (parsed.isChild) return CHILD_TRUE_MICRO_SCHEMA;
  if (parsed.isParent) return PARENT_TRUE_MICRO_SCHEMA;

  return MICRO_MICRO_SCHEMA;
}

function granularityForId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  if (parsed.isMicroMicro) return MICRO_MICRO_LEARNING_GRANULARITY;
  if (parsed.isChild) return CHILD75_LEARNING_GRANULARITY;
  if (parsed.isParent) return PARENT_LEARNING_GRANULARITY;

  return MICRO_MICRO_LEARNING_GRANULARITY;
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
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ])
    .map(upper)
    .filter(Boolean)
    .filter((part) => !part.includes('FIRST_MOVE'))
    .filter((part) => !part.includes('AFTER_OPEN'));
}

function firstParsed(values = [], predicate = () => true) {
  for (const value of flattenValues(values)) {
    const parsed = parseShortTaxonomyMicroId(value);
    if (parsed.valid && predicate(parsed)) return parsed;
  }

  return null;
}

function explicitMicroMicroIdFrom(row = {}) {
  if (typeof row === 'string') {
    return firstParsed([row], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || '';
  }

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
  ], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || '';
}

function child75IdFrom(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback], (parsed) => parsed.isBaseChild)?.base75ChildTrueMicroFamilyId || '';
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
  ], (parsed) => parsed.isBaseChild)?.base75ChildTrueMicroFamilyId || '';
}

function parentIdFrom(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback])?.parentTrueMicroFamilyId || '';
  }

  return firstParsed([
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.macroFamilyId,
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
  ])?.parentTrueMicroFamilyId || '';
}

function buildMicroMicroIdFromChild(childId = '', row = {}, { allowProxy = true } = {}) {
  const child = parseShortTaxonomyMicroId(childId);
  if (!child.isBaseChild) return '';

  const explicit = explicitMicroMicroIdFrom(row);
  if (explicit) {
    const parsed = parseShortTaxonomyMicroId(explicit);
    if (parsed.isMicroMicro && parsed.base75ChildTrueMicroFamilyId === child.base75ChildTrueMicroFamilyId) {
      return parsed.trueMicroFamilyId;
    }
  }

  const explicitHash = normalizeMicroMicroHash(
    row.microMicroHash ||
      row.microMicroContextHash ||
      row.executionContextHash ||
      row.executionFingerprintHash ||
      ''
  );

  if (explicitHash) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${explicitHash}`;
  }

  const parts = microMicroContextParts(row);

  if (parts.length > 0) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(parts.join('|'))}`;
  }

  if (allowProxy) {
    return `${child.base75ChildTrueMicroFamilyId}${MICRO_MICRO_MARKER}${stableHash10(`${child.base75ChildTrueMicroFamilyId}|DEFAULT_ENTRY_CONTEXT_PENDING`)}`;
  }

  return '';
}

function microMicroIdFromRow(row = {}, { allowProxy = true } = {}) {
  const explicit = explicitMicroMicroIdFrom(row);
  if (explicit) return explicit;

  const child = child75IdFrom(row);
  return buildMicroMicroIdFromChild(child, row, { allowProxy });
}

function rowId(row = {}, { allowProxy = true } = {}) {
  if (typeof row === 'string') {
    const parsed = parseShortTaxonomyMicroId(row);
    return parsed.valid ? parsed.trueMicroFamilyId : cleanLearningMicroId(row);
  }

  return microMicroIdFromRow(row, { allowProxy });
}

function definitionText(row = {}) {
  return [
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
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);
  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_') || raw.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_') || raw.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function microSide(row = {}) {
  if (typeof row === 'string') {
    const value = cleanSideText(row);

    if (parseShortTaxonomyMicroId(value).valid) return TARGET_TRADE_SIDE;
    if (hasLongSignal(value) && !hasShortSignal(value)) return OPPOSITE_TRADE_SIDE;
    if (hasShortSignal(value)) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  for (const source of [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ]) {
    const side = normalizeDirectSide(source);
    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const idText = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.microFamilyId,
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.id,
    row.key
  ].filter(Boolean).join('|');

  if (parseShortTaxonomyMicroId(idText).valid || hasShortSignal(idText)) return TARGET_TRADE_SIDE;
  if (hasLongSignal(idText) && !hasShortSignal(idText)) return OPPOSITE_TRADE_SIDE;

  const def = definitionText(row);
  if (hasShortSignal(def) && !hasLongSignal(def)) return TARGET_TRADE_SIDE;
  if (hasLongSignal(def) && !hasShortSignal(def)) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  return microSide(row) === TARGET_TRADE_SIDE ? TARGET_DASHBOARD_SIDE : 'unknown';
}

function isShortRotationRow(row = {}) {
  return microSide(row) !== OPPOSITE_TRADE_SIDE;
}

export function isTrueMicroFamily(row = {}) {
  const id = rowId(row, { allowProxy: true });
  if (!id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isShortRotationRow(row)) return false;

  return isSelectableMicroMicroId(id);
}

export function isLegacyMacroFamily(row = {}) {
  const id = cleanLearningMicroId(
    row?.parentTrueMicroFamilyId ||
      row?.coarseMicroFamilyId ||
      row?.macroFamilyId ||
      row?.familyId ||
      row?.trueMicroFamilyId ||
      row?.microFamilyId ||
      row?.id ||
      row?.key ||
      ''
  );

  if (!id) return false;
  if (isScannerFingerprintId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isShortRotationRow(row)) return false;

  return isFixedTaxonomyParentOnlyId(id);
}

function recentClosedVirtualOutcomeCount(row = {}) {
  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  return recent.filter((outcome) => {
    const source = upper(outcome?.source || outcome?.outcomeSource || 'VIRTUAL');
    const hasR = Number.isFinite(Number(
      outcome?.netR ??
        outcome?.exitR ??
        outcome?.realizedNetR ??
        outcome?.realizedR ??
        outcome?.r
    ));

    return hasR && ['VIRTUAL', 'SHADOW', 'PAPER', ''].includes(source);
  }).length;
}

function completedCount(row = {}) {
  const virtualCompleted = num(row.virtualCompleted, 0);
  const shadowCompleted = num(row.shadowCompleted, 0);
  const closed = virtualCompleted + shadowCompleted;

  if (closed > 0) return closed;

  const recentClosed = recentClosedVirtualOutcomeCount(row);
  if (recentClosed > 0) return recentClosed;

  if (allowLegacyCompletedFallback()) {
    return Math.max(0, num(row.completed ?? row.outcomeSample, 0));
  }

  return Math.max(0, num(row.outcomeSample, 0));
}

function observationSample(row = {}) {
  return Math.max(
    num(row.observationSample, 0),
    num(row.seen, 0),
    num(row.observations, 0),
    completedCount(row),
    0
  );
}

function learningStatus(row = {}) {
  const completed = completedCount(row);

  if (completed >= minMicroMicroCompleted()) return 'MICRO_MICRO_ACTIVE';
  if (completed > 0) return 'MICRO_MICRO_EARLY';

  return 'MICRO_MICRO_OBSERVING';
}

function aggregateRecentOutcomes(row = {}) {
  const recent = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];

  return recent.reduce((acc, outcome) => {
    if (!outcome || typeof outcome !== 'object') return acc;

    const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');
    if (!['VIRTUAL', 'SHADOW', 'PAPER', ''].includes(source)) return acc;
    if (microSide({ ...row, ...outcome }) === OPPOSITE_TRADE_SIDE) return acc;

    const netR = num(
      outcome.netR ??
        outcome.exitR ??
        outcome.realizedNetR ??
        outcome.realizedR ??
        outcome.r,
      0
    );

    const costR = Math.max(0, num(outcome.costR ?? outcome.avgCostR, 0));

    acc.completed += 1;
    acc.totalR += netR;
    acc.totalCostR += costR;

    if (netR > 0) acc.wins += 1;
    else if (netR < 0) acc.losses += 1;
    else acc.flats += 1;

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

  const total = Math.max(
    wins + losses + flats,
    completedCount(row),
    recent.completed,
    0
  );

  if (wins + losses + flats <= 0 && recent.completed > 0) {
    return {
      wins: recent.wins,
      losses: recent.losses,
      flats: recent.flats,
      total: recent.completed
    };
  }

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, total - wins - losses)),
    total
  };
}

function totalR(row = {}) {
  const completed = completedCount(row);
  const recent = aggregateRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;

  if (recent.completed > 0) return recent.totalR;

  return num(
    row.shortNetTotalR ??
      row.netShortTotalR ??
      row.netTotalR ??
      row.totalNetR ??
      row.totalR,
    0
  );
}

function avgR(row = {}) {
  const completed = completedCount(row);
  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);
  if (hasValue(row.avgR)) return num(row.avgR, 0);

  return totalR(row) / completed;
}

function totalCostR(row = {}) {
  const completed = completedCount(row);
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
  const completed = completedCount(row);
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
  const completed = completedCount(row);
  if (completed <= 0) return 0;

  if (hasValue(row.directSLPct)) {
    const pct = num(row.directSLPct, 0);
    return pct > 1 ? clamp(pct / 100, 0, 1) : clamp(pct, 0, 1);
  }

  return clamp(directSLCount(row) / completed, 0, 1);
}

function profitFactor(row = {}) {
  if (hasValue(row.netProfitFactor)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor)) return num(row.profitFactor, 0);

  const recent = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];
  let wins = 0;
  let losses = 0;

  for (const outcome of recent) {
    const r = num(outcome?.netR ?? outcome?.exitR ?? outcome?.realizedR ?? outcome?.r, 0);
    if (r > 0) wins += r;
    if (r < 0) losses += Math.abs(r);
  }

  if (wins <= 0 && losses <= 0) return 0;
  if (losses <= 0) return wins > 0 ? 99 : 0;

  return wins / losses;
}

function wilsonLowerBound(successes, trials, z = 1.96) {
  const n = num(trials, 0);
  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

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
  const reliability = sampleReliability(completed);
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

function dashboardBalancedScore(row = {}) {
  const wr = sampleAdjustedWinrate(row);

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

function marketBiasText(row = {}) {
  return [
    row.currentFit,
    row.entryCurrentFit,
    row.currentMarketFit,
    row.currentRegime,
    row.entryCurrentRegime,
    row.currentTrendSide,
    row.entryCurrentTrendSide,
    row.currentMarketNote,
    row.currentFitReason,
    row.marketBias,
    row.bias,
    row.side,
    row.tradeSide,
    row.positionSide,
    row.direction,
    ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasBearishBias(row = {}) {
  const text = marketBiasText(row);

  return (
    text.includes('BEAR') ||
    text.includes('BEARISH') ||
    text.includes('SHORT') ||
    text.includes('SELL') ||
    text.includes('DOWNSIDE') ||
    text.includes('DOWN')
  );
}

function hasBullishBias(row = {}) {
  const text = marketBiasText(row);

  return (
    text.includes('BULL') ||
    text.includes('BULLISH') ||
    text.includes('LONG') ||
    text.includes('BUY') ||
    text.includes('UPSIDE') ||
    text.includes('UP')
  );
}

function currentFitScore(row = {}) {
  const explicitShort = finiteOrNull(
    row.shortCurrentFitScore ??
      row.bearCurrentFitScore ??
      row.bearishCurrentFitScore ??
      row.shortCurrentFit ??
      row.bearCurrentFit
  );

  if (explicitShort !== null) return Math.max(-100, Math.min(100, explicitShort));

  const explicitLong = finiteOrNull(
    row.longCurrentFitScore ??
      row.bullCurrentFitScore ??
      row.bullishCurrentFitScore ??
      row.longCurrentFit ??
      row.bullCurrentFit
  );

  if (explicitLong !== null) return Math.max(-100, Math.min(100, -Math.abs(explicitLong)));

  const generic = finiteOrNull(
    row.currentFitScore ??
      row.entryCurrentFitScore ??
      row.marketFitScore ??
      row.currentMarketFitScore ??
      row.fitScore
  );

  if (generic !== null) {
    if (hasBearishBias(row)) return Math.max(-100, Math.min(100, Math.abs(generic)));
    if (hasBullishBias(row)) return Math.max(-100, Math.min(100, -Math.abs(generic)));

    return Math.max(-100, Math.min(100, generic));
  }

  return 0;
}

function currentFitLabel(score = 0) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'UNKNOWN';
  if (n >= 45) return 'FIT';
  if (n >= 20) return 'OK';
  if (n <= -20) return 'MISFIT';
  return 'NEUTRAL';
}

function currentContraPenalty(row = {}) {
  const explicit = finiteOrNull(row.currentContraPenalty);
  if (explicit !== null) return Math.max(0, explicit);

  const text = marketBiasText(row);

  if (
    text.includes('CONTRA') ||
    text.includes('AGAINST') ||
    text.includes('MISFIT') ||
    text.includes('BULL') ||
    text.includes('LONG') ||
    text.includes('BUY')
  ) {
    return 12;
  }

  return 0;
}

function recentMomentumScore(row = {}) {
  const explicit = finiteOrNull(row.recentMomentumScore);
  if (explicit !== null) return Math.max(-100, Math.min(100, explicit));

  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  if (!recent.length) return 0;

  const rows = recent
    .filter((outcome) => {
      const source = upper(outcome?.source || outcome?.outcomeSource || 'VIRTUAL');
      return source === 'VIRTUAL' || source === 'SHADOW' || source === 'PAPER' || source === '';
    })
    .slice(-recentMomentumLookback());

  if (!rows.length) return 0;

  const total = rows.reduce((sum, outcome) => {
    return sum + num(
      outcome.netR ??
        outcome.exitR ??
        outcome.realizedNetR ??
        outcome.realizedR ??
        outcome.r,
      0
    );
  }, 0);

  const avg = total / rows.length;
  const hitRate = rows.filter((outcome) => {
    const r = num(outcome.netR ?? outcome.exitR ?? outcome.realizedNetR ?? outcome.realizedR ?? outcome.r, 0);
    return r > 0;
  }).length / rows.length;

  return Math.max(-35, Math.min(35, avg * 18 + (hitRate - 0.5) * 24));
}

function staleWinnerPenalty(row = {}) {
  const explicit = finiteOrNull(row.staleWinnerPenalty);
  if (explicit !== null) return Math.max(0, explicit);

  const completed = completedCount(row);
  const observations = observationSample(row);
  const pnl = totalR(row);
  const updatedAt = num(row.updatedAt || row.lastOutcomeAt || row.lastSeenAt, 0);

  if (completed <= 0 || pnl <= 0) return 0;
  if (observations > completed) return 0;
  if (updatedAt <= 0) return 0;

  const ageMs = now() - updatedAt;
  const maxAgeMs = staleWinnerDays() * 24 * 60 * 60 * 1000;

  if (ageMs <= maxAgeMs) return 0;

  return Math.min(25, ((ageMs - maxAgeMs) / maxAgeMs) * 10);
}

function avgCostPenalty(row = {}) {
  return Math.min(30, Math.max(0, avgCostR(row)) * 8);
}

function directSLPenalty(row = {}) {
  return Math.min(25, Math.max(0, directSLPct(row)) * 25);
}

function cleanMeasurementScore(row = {}) {
  const fix = row.measurementFixVersion || row.measurementVersion || row.positionMeasurementFixVersion || '';
  const cost = row.costModelVersion || row.positionCostModelVersion || '';
  const obs = row.observationDedupeVersion || row.obsDedupeVersion || '';
  const out = row.outcomeDedupeVersion || row.outcomeDeduplicationVersion || '';

  if (row.measurementClean === true || row.cleanMeasurement === true || row.cleanLearningRow === true) return 1;

  const fixOk = !fix || fix === MEASUREMENT_FIX_VERSION || String(fix).includes('CANDLE_FIRST_TOUCH');
  const costOk = !cost || cost === COST_MODEL_VERSION;
  const obsOk = !obs || obs === OBSERVATION_DEDUPE_VERSION || String(obs).includes('OBS_DEDUPE');
  const outOk = !out || out === OUTCOME_DEDUPE_VERSION || String(out).includes('OUTCOME_DEDUPE');

  return fixOk && costOk && obsOk && outOk ? 1 : 0;
}

function adaptiveSelectionScore(row = {}) {
  const explicit = finiteOrNull(row.adaptiveScore);
  if (explicit !== null) return explicit;

  const wr = sampleAdjustedWinrate(row);
  const completed = completedCount(row);
  const observations = observationSample(row);

  const qualityBonus =
    completed >= minMicroMicroCompleted()
      ? 25
      : completed > 0
        ? 10
        : observations > 0
          ? 2
          : 0;

  const observationBonus =
    completed <= 0 && observations > 0
      ? Math.min(8, Math.log1p(observations) * 2)
      : 0;

  return (
    dashboardBalancedScore(row) +
    wr.score * 30 +
    Math.log1p(Math.max(0, totalR(row))) * 10 +
    Math.log1p(Math.max(0, avgR(row))) * 8 +
    recentMomentumScore(row) +
    currentFitScore(row) * 0.25 +
    qualityBonus +
    observationBonus -
    staleWinnerPenalty(row) -
    currentContraPenalty(row) -
    avgCostPenalty(row) -
    directSLPenalty(row)
  );
}

function rotationEligibilityTier(row = {}) {
  const completed = completedCount(row);
  const observed = observationSample(row);

  if (completed >= minMicroMicroCompleted()) return 'MICRO_MICRO';
  if (completed > 0 && allowSoftRotationFallback()) return 'MICRO_MICRO_SOFT';
  if (observed > 0 && allowObservationRotationFallback()) return 'OBSERVATION';
  if (allowRawRotationFallback()) return 'RAW';

  return 'NONE';
}

function isEligibleForCandidate(row = {}) {
  if (!isTrueMicroFamily(row)) return false;
  return rotationEligibilityTier(row) !== 'NONE';
}

function compareAdaptiveRows(a = {}, b = {}) {
  return (
    cleanMeasurementScore(b) - cleanMeasurementScore(a) ||
    adaptiveSelectionScore(b) - adaptiveSelectionScore(a) ||
    sampleAdjustedWinrate(b).score - sampleAdjustedWinrate(a).score ||
    totalR(b) - totalR(a) ||
    avgR(b) - avgR(a) ||
    profitFactor(b) - profitFactor(a) ||
    directSLPct(a) - directSLPct(b) ||
    avgCostR(a) - avgCostR(b) ||
    completedCount(b) - completedCount(a) ||
    observationSample(b) - observationSample(a) ||
    String(rowId(a)).localeCompare(String(rowId(b)))
  );
}

function sortAdaptiveRows(rows = []) {
  return [...rows].sort(compareAdaptiveRows);
}

function shortRiskGeometry(row = {}) {
  const entry = finiteOrNull(row.entryPrice ?? row.entry ?? row.avgEntryPrice ?? row.openPrice);
  const initialSl = finiteOrNull(row.initialSl ?? row.initialSL ?? row.initialStopLoss ?? row.stopLoss ?? row.sl);
  const tp = finiteOrNull(row.tp ?? row.takeProfit ?? row.targetPrice);
  const currentPrice = finiteOrNull(row.currentPrice ?? row.markPrice ?? row.lastPrice ?? row.price);
  const exitPrice = finiteOrNull(row.exitPrice ?? row.closePrice ?? row.outcomePrice ?? row.exit);

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

  return {
    entry,
    initialSl,
    tp,
    exitPrice,
    currentPrice,
    validGeometry,
    shortGrossR,
    shortCurrentR,
    shortTpHit: Boolean(validGeometry && ((Number.isFinite(exitPrice) && exitPrice <= tp) || row.tpHit === true || row.shortTpHit === true)),
    shortSlHit: Boolean(validGeometry && ((Number.isFinite(exitPrice) && exitPrice >= initialSl) || row.slHit === true || row.shortSlHit === true))
  };
}

function compactRotationRow(row = {}, rank = 0) {
  const id = rowId(row, { allowProxy: true });
  const parsed = parseShortTaxonomyMicroId(id);

  if (!parsed.isMicroMicro) return null;

  const wr = sampleAdjustedWinrate(row);
  const completed = completedCount(row);
  const observed = observationSample(row);
  const status = learningStatus(row);
  const tier = rotationEligibilityTier(row);
  const fitScore = currentFitScore(row);
  const risk = shortRiskGeometry(row);
  const schema = schemaForId(id);

  return {
    rank,

    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    microMicroHash: parsed.microMicroHash,

    familyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMicroFamilyId: parsed.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    ...modeFlags(),

    schema,
    microFamilySchema: schema,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    version: row.version || 'short-exact-micro-micro-rotation-v1',

    isTrueMicro: true,
    isChildTrueMicro: false,
    isMicroMicro: true,
    isLegacyMacro: false,
    isParentTrueMicro: false,
    selectable: true,
    selectableMicroMicro: true,
    selectable75Child: false,
    selectableParent: false,

    selectionGranularity: SELECTION_EXACT_MICRO_MICRO_ONLY,
    learningLayer: LAYER_MICRO_MICRO,
    layer: LAYER_MICRO_MICRO,

    setupType: parsed.setupType,
    taxonomySetup: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
    taxonomyRegime: parsed.regimeBucket,
    confirmationProfile: parsed.confirmationProfile,
    fixedTaxonomyLearningId: true,

    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    rotationEligibilityTier: tier,
    rotationEligible: tier !== 'NONE',
    hardEligible: tier === 'MICRO_MICRO',
    softEligible: tier === 'MICRO_MICRO_SOFT',
    observationEligible: tier === 'OBSERVATION',
    rawEligible: tier === 'RAW',

    learningStatus: status,
    status,
    minCompletedForMicroMicroActive: minMicroMicroCompleted(),
    minCompletedForActiveLearning: minMicroMicroCompleted(),
    tooEarly: completed < minMicroMicroCompleted(),
    tooEarlyReason: completed < minMicroMicroCompleted()
      ? `completed ${completed}/${minMicroMicroCompleted()}`
      : null,

    seen: num(row.seen, 0),
    observations: num(row.observations ?? row.seen, 0),
    observationSample: observed,
    observationAlwaysCounted: true,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    completed,
    outcomeSample: completed,
    realCompleted: 0,
    virtualCompleted: num(row.virtualCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    wins: round(wr.wins, 4),
    losses: round(wr.losses, 4),
    flats: round(wr.flats, 4),

    winrateSample: wr.sample,
    winrate: round(wr.rawWinrate, 4),
    bayesianWinrate: round(wr.bayesianWinrate, 4),
    wilsonLowerBound: round(wr.wilsonLowerBound, 4),
    sampleWilsonLowerBound: round(wr.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? wr.score, 4),
    sampleReliability: round(row.sampleReliability ?? wr.reliability, 4),

    avgR: round(avgR(row), 4),
    totalR: round(totalR(row), 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),
    profitFactor: round(profitFactor(row), 4),

    directSLCount: round(directSLCount(row), 4),
    directSLPct: round(directSLPct(row), 4),

    totalCostR: round(totalCostR(row), 4),
    avgCostR: round(avgCostR(row), 4),

    balancedScore: round(row.balancedScore ?? dashboardBalancedScore(row), 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? dashboardBalancedScore(row), 4),
    recentMomentumScore: round(recentMomentumScore(row), 4),
    currentFitScore: round(fitScore, 4),
    fitScore: round(fitScore, 4),
    currentFit: currentFitLabel(fitScore),
    currentFitLabel: currentFitLabel(fitScore),
    shortCurrentFitScore: round(fitScore, 4),
    bearCurrentFitScore: round(fitScore, 4),
    longCurrentFitScore: round(-Math.abs(fitScore), 4),
    bullCurrentFitScore: round(-Math.abs(fitScore), 4),
    currentContraPenalty: round(currentContraPenalty(row), 4),
    avgCostPenalty: round(avgCostPenalty(row), 4),
    staleWinnerPenalty: round(staleWinnerPenalty(row), 4),
    directSLPenalty: round(directSLPenalty(row), 4),
    adaptiveScore: round(adaptiveSelectionScore(row), 4),

    adaptiveScoreFormula:
      'cleanMeasurement + adaptiveScore + fairWinrate + totalR + avgR + profitFactor + currentFit - directSL - avgCostR',

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitBlocksDiscord: currentFitLabel(fitScore) === 'MISFIT',
    discordCurrentFitAllowed: currentFitLabel(fitScore) !== 'MISFIT',
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

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

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
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE_OR_METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    microMicroDefinitionParts: Array.isArray(row.microMicroDefinitionParts)
      ? row.microMicroDefinitionParts
      : microMicroContextParts(row),
    microMicroDefinition: row.microMicroDefinition || '',

    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesIncludedOnlyInsideMicroMicroId: true,

    definitionParts: Array.isArray(row.definitionParts) ? row.definitionParts : [],
    definition: row.definition || '',
    parentDefinitionParts: Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [],
    parentDefinition: row.parentDefinition || '',

    counters: row.counters || {},
    examples: Array.isArray(row.examples) ? row.examples.slice(0, 20) : [],
    recentOutcomes: Array.isArray(row.recentOutcomes) ? row.recentOutcomes.slice(-20) : [],

    costModelVersion: row.costModelVersion || COST_MODEL_VERSION,
    measurementFixVersion: row.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: row.observationDedupeVersion || OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: row.outcomeDedupeVersion || OUTCOME_DEDUPE_VERSION,
    riskPlanVersion: row.riskPlanVersion || RISK_PLAN_VERSION,
    adaptiveUiVersion: row.adaptiveUiVersion || ADAPTIVE_UI_VERSION,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    sourceWeekKey: row.sourceWeekKey || PERSISTENT_LEARNING_KEY,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
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

function normalizeSourceRowsToMicroMicro(micros = {}) {
  const rows = [];
  const seen = new Set();

  for (const [key, row] of sourceEntries(micros)) {
    if (!row || typeof row !== 'object') continue;

    const id = rowId({ ...row, key }, { allowProxy: true });
    if (!id || !isSelectableMicroMicroId(id)) continue;
    if (seen.has(id)) continue;
    if (microSide({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id }) === OPPOSITE_TRADE_SIDE) continue;

    const compact = compactRotationRow({
      ...row,
      key,
      id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningMicroFamilyId: id,
      microMicroFamilyId: id,
      trueMicroMicroFamilyId: id,
      exactMicroMicroFamilyId: id,
      generatedMicroMicroFromChild75: !explicitMicroMicroIdFrom(row),
      microMicroContextFallback: microMicroContextParts(row).length === 0,
      microMicroStatsSource: explicitMicroMicroIdFrom(row)
        ? 'EXPLICIT_MICRO_MICRO_ROW'
        : 'CHILD75_CONTEXT_PROXY_FOR_CANDIDATE_DISPLAY'
    }, rows.length + 1);

    if (!compact) continue;

    rows.push(compact);
    seen.add(id);
  }

  return sortAdaptiveRows(rows);
}

function buildSelectionIndexes(microFamilies = []) {
  const rows = microFamilies
    .filter(Boolean)
    .filter((row) => isSelectableMicroMicroId(row.trueMicroFamilyId || row.microMicroFamilyId));

  const microMicroFamilyIds = uniqueStrings(
    rows.map((row) => row.trueMicroFamilyId || row.microMicroFamilyId)
  )
    .map(cleanLearningMicroId)
    .filter(isSelectableMicroMicroId);

  const childTrueMicroFamilyIds = uniqueStrings(
    microMicroFamilyIds
      .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
      .filter(Boolean)
  );

  const parentTrueMicroFamilyIds = uniqueStrings(
    microMicroFamilyIds
      .map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
      .filter(Boolean)
  );

  const microToParentTrueMicroFamilyId = {};
  const microToChildTrueMicroFamilyId = {};
  const microToMicroMicroFamilyId = {};
  const childTrueMicroFamilyToMicroMicroFamilyIds = {};
  const parentTrueMicroFamilyToMicroFamilyIds = {};

  for (const id of microMicroFamilyIds) {
    const parsed = parseShortTaxonomyMicroId(id);
    const childId = parsed.childTrueMicroFamilyId;
    const parentId = parsed.parentTrueMicroFamilyId;

    microToParentTrueMicroFamilyId[id] = parentId;
    microToChildTrueMicroFamilyId[id] = childId;
    microToMicroMicroFamilyId[id] = id;

    if (childId) {
      childTrueMicroFamilyToMicroMicroFamilyIds[childId] ||= [];
      childTrueMicroFamilyToMicroMicroFamilyIds[childId].push(id);
    }

    if (parentId) {
      parentTrueMicroFamilyToMicroFamilyIds[parentId] ||= [];
      parentTrueMicroFamilyToMicroFamilyIds[parentId].push(id);
    }
  }

  for (const key of Object.keys(childTrueMicroFamilyToMicroMicroFamilyIds)) {
    childTrueMicroFamilyToMicroMicroFamilyIds[key] = uniqueStrings(childTrueMicroFamilyToMicroMicroFamilyIds[key]);
  }

  for (const key of Object.keys(parentTrueMicroFamilyToMicroFamilyIds)) {
    parentTrueMicroFamilyToMicroFamilyIds[key] = uniqueStrings(parentTrueMicroFamilyToMicroFamilyIds[key]);
  }

  return {
    microFamilyIds: microMicroFamilyIds,
    activeMicroFamilyIds: microMicroFamilyIds,
    trueMicroFamilyIds: microMicroFamilyIds,

    childTrueMicroFamilyIds,
    activeChildTrueMicroFamilyIds: [],

    microMicroFamilyIds,
    activeMicroMicroFamilyIds: microMicroFamilyIds,
    trueMicroMicroFamilyIds: microMicroFamilyIds,
    exactMicroMicroFamilyIds: microMicroFamilyIds,
    selectedMicroMicroFamilyIds: microMicroFamilyIds,
    activeTrueMicroMicroFamilyIds: microMicroFamilyIds,

    parentTrueMicroFamilyIds,
    macroFamilyIds: parentTrueMicroFamilyIds,
    activeMacroFamilyIds: parentTrueMicroFamilyIds,
    activeParentTrueMicroFamilyIds: parentTrueMicroFamilyIds,

    microToMacroFamilyId: microToParentTrueMicroFamilyId,
    microToParentTrueMicroFamilyId,
    microToChildTrueMicroFamilyId,
    microToMicroMicroFamilyId,
    macroToMicroFamilyIds: parentTrueMicroFamilyToMicroFamilyIds,
    parentTrueMicroFamilyToMicroFamilyIds,
    childTrueMicroFamilyToMicroMicroFamilyIds
  };
}

function bestShortRow(rows = []) {
  return sortAdaptiveRows(rows).find((row) => microSide(row) === TARGET_TRADE_SIDE) || null;
}

function missingSides(rows = []) {
  return rows.some((row) => microSide(row) === TARGET_TRADE_SIDE)
    ? []
    : [TARGET_TRADE_SIDE];
}

function buildRankingsFromRows(rows = []) {
  const base = sortAdaptiveRows(rows).slice(0, MAX_TOP_N_PER_SIDE);

  const compacted = base
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter(Boolean);

  return {
    adaptive: compacted,
    balanced: compacted,
    winrate: [...compacted].sort((a, b) => (
      num(b.fairWinrate, 0) - num(a.fairWinrate, 0) ||
      compareAdaptiveRows(a, b)
    )),
    totalR: [...compacted].sort((a, b) => (
      num(b.totalR, 0) - num(a.totalR, 0) ||
      compareAdaptiveRows(a, b)
    )),
    avgR: [...compacted].sort((a, b) => (
      num(b.avgR, 0) - num(a.avgR, 0) ||
      compareAdaptiveRows(a, b)
    )),
    directSL: [...compacted].sort((a, b) => (
      num(a.directSLPct, 0) - num(b.directSLPct, 0) ||
      compareAdaptiveRows(a, b)
    )),
    observed: [...compacted].sort((a, b) => (
      num(b.observationSample, 0) - num(a.observationSample, 0) ||
      compareAdaptiveRows(a, b)
    )),
    cost: [...compacted].sort((a, b) => (
      num(a.avgCostR, 0) - num(b.avgCostR, 0) ||
      compareAdaptiveRows(a, b)
    )),
    currentFit: [...compacted].sort((a, b) => (
      num(b.currentFitScore, 0) - num(a.currentFitScore, 0) ||
      compareAdaptiveRows(a, b)
    ))
  };
}

async function getRotationMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const dataWeekKey = learningDataKey(weekKey);
  const primary = await getWeekMicros(dataWeekKey).catch(() => ({}));
  const primaryRows = Object.keys(primary || {}).length;

  const previousWeekKey = getPreviousIsoWeekKey();
  const shouldMergePrevious =
    dataWeekKey !== PERSISTENT_LEARNING_KEY &&
    dataWeekKey !== previousWeekKey &&
    primaryRows < minPrimaryRowsForPreviousMerge();

  if (!shouldMergePrevious) {
    return {
      micros: primary || {},
      primaryWeekKey: dataWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false,
      usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
  }

  const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
  const previousRows = Object.keys(previous || {}).length;

  if (previousRows <= 0) {
    return {
      micros: primary || {},
      primaryWeekKey: dataWeekKey,
      dataWeekKey,
      learningDataKey: dataWeekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false,
      usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
    };
  }

  return {
    micros: {
      ...(previous || {}),
      ...(primary || {})
    },
    primaryWeekKey: dataWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    previousWeekKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge: true,
    usedPersistentLearningKey: dataWeekKey === PERSISTENT_LEARNING_KEY
  };
}

function selectRotationCandidates(rows = []) {
  const candidates = sortAdaptiveRows(rows.filter(isEligibleForCandidate));
  const targetCount = topNPerSide();
  const selected = candidates.slice(0, targetCount);

  return {
    selected,
    eligible: candidates.filter((row) => rotationEligibilityTier(row) === 'MICRO_MICRO'),
    softEligible: candidates.filter((row) => rotationEligibilityTier(row) === 'MICRO_MICRO_SOFT'),
    observationEligible: candidates.filter((row) => rotationEligibilityTier(row) === 'OBSERVATION'),
    rawFallback: candidates.filter((row) => rotationEligibilityTier(row) === 'RAW'),
    usedSoftFallback: selected.some((row) => rotationEligibilityTier(row) === 'MICRO_MICRO_SOFT'),
    usedObservationFallback: selected.some((row) => rotationEligibilityTier(row) === 'OBSERVATION'),
    usedRawFallback: selected.some((row) => rotationEligibilityTier(row) === 'RAW'),
    missingSides: missingSides(selected)
  };
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  rows,
  eligible,
  softEligible = [],
  observationEligible = [],
  rawFallback = [],
  usedPreviousWeekMerge = false,
  usedPersistentLearningKey = false,
  primaryRows = 0,
  previousRows = 0,
  emptyReason = 'NO_SHORT_SELECTABLE_MICRO_MICRO_AVAILABLE_FOR_ROTATION'
}) {
  const indexes = buildSelectionIndexes([]);
  const meta = schemaMeta();
  const rankings = buildRankingsFromRows(rows);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_micro_micro_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_SHORT_MICRO_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,
    dataWeekKey: weekKey,
    learningDataKey: weekKey,
    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    ...meta,
    ...modeFlags(),

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,
    usedRawFallback: false,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    minMicroMicroCompleted: minMicroMicroCompleted(),
    topNPerSide: topNPerSide(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    rankedCount: rows.length,
    microCount: Object.keys(micros || {}).length,
    microMicroCount: rows.length,
    child75ContextRows: rows.filter((row) => Boolean(row.generatedMicroMicroFromChild75)).length,
    parentTrueMicroCount: 0,

    primaryRows,
    previousRows,

    missingSides: [TARGET_TRADE_SIDE],
    empty: true,
    emptyReason,

    bestShort: null,
    bestLong: null,

    candidateMicroFamilyIds: [],
    candidateTrueMicroFamilyIds: [],
    candidateChildTrueMicroFamilyIds: [],
    candidateMicroMicroFamilyIds: [],
    candidateParentTrueMicroFamilyIds: [],
    candidateMacroFamilyIds: [],

    ...indexes,

    microFamilies: [],

    rankings,
    microMicroRankings: rankings,
    childRankings: {},
    parentRankings: {},
    macroRankings: {},
    allRankings: rankings
  };
}

export async function buildRotationFromWeek({
  weekKey = PERSISTENT_LEARNING_KEY,
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const {
    micros,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge,
    usedPersistentLearningKey
  } = await getRotationMicros(weekKey);

  const rows = normalizeSourceRowsToMicroMicro(micros);

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    rawFallback,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    missingSides: selectedMissingSides
  } = selectRotationCandidates(rows);

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey: dataWeekKey,
      activeWeekKey,
      mode,
      micros,
      rows,
      eligible,
      softEligible,
      observationEligible,
      rawFallback,
      usedPreviousWeekMerge,
      usedPersistentLearningKey,
      primaryRows,
      previousRows,
      emptyReason: rows.length === 0
        ? 'NO_SHORT_SELECTABLE_MICRO_MICRO_FOUND'
        : 'NO_SHORT_SELECTABLE_MICRO_MICRO_AVAILABLE_FOR_CANDIDATE_SNAPSHOT'
    });
  }

  const microFamilies = sortAdaptiveRows(selected)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter(Boolean);

  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();
  const rankings = buildRankingsFromRows(rows);

  return {
    rotationId: randomId(`ROT_${dataWeekKey}_${mode}_short_micro_micro_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_SHORT_MICRO_MICRO_ONLY',
    mode,

    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: resolvedLearningDataKey,
    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    ...meta,
    ...modeFlags(),

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    minMicroMicroCompleted: minMicroMicroCompleted(),
    topNPerSide: topNPerSide(),

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    rankedCount: rows.length,
    microCount: Object.keys(micros || {}).length,
    microMicroCount: rows.length,
    child75ContextRows: rows.filter((row) => Boolean(row.generatedMicroMicroFromChild75)).length,
    parentTrueMicroCount: 0,

    primaryRows,
    previousRows,

    missingSides: selectedMissingSides,
    empty: false,
    emptyReason: null,

    bestShort: bestShortRow(microFamilies),
    bestLong: null,

    candidateMicroFamilyIds: indexes.microFamilyIds,
    candidateTrueMicroFamilyIds: indexes.trueMicroFamilyIds,
    candidateChildTrueMicroFamilyIds: indexes.childTrueMicroFamilyIds,
    candidateMicroMicroFamilyIds: indexes.microMicroFamilyIds,
    candidateParentTrueMicroFamilyIds: indexes.parentTrueMicroFamilyIds,
    candidateMacroFamilyIds: indexes.macroFamilyIds,

    ...indexes,

    microFamilies,

    rankings,
    microMicroRankings: rankings,
    childRankings: {},
    parentRankings: {},
    macroRankings: {},
    allRankings: rankings
  };
}

export async function freezeWeeklyRotation({
  weekKey = PERSISTENT_LEARNING_KEY,
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();
  const dataWeekKey = learningDataKey(weekKey);
  const micros = await getWeekMicros(dataWeekKey).catch(() => ({}));

  await saveWeekMicros(dataWeekKey, micros);

  const rotation = await buildRotationFromWeek({
    weekKey: dataWeekKey,
    activeWeekKey,
    mode
  });

  await setJson(redis, nextRotationKey(), rotation);

  await setJson(redis, rotationValidFromKey(), {
    validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
    ts: now(),
    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    rotationId: rotation.rotationId,

    ...modeFlags(),

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    selectedMicroFamilies: 0,
    selectedTrueMicroFamilies: 0,
    selectedChildTrueMicroFamilies: 0,
    selectedMicroMicroFamilies: 0,
    selectedParentTrueMicroFamilies: 0,

    candidateMicroFamilies: rotation.microFamilyIds.length,
    candidateTrueMicroFamilies: rotation.trueMicroFamilyIds.length,
    candidateChildTrueMicroFamilies: rotation.childTrueMicroFamilyIds.length,
    candidateMicroMicroFamilies: rotation.microMicroFamilyIds.length,
    candidateParentTrueMicroFamilies: rotation.parentTrueMicroFamilyIds.length,

    missingSides: rotation.missingSides || [],
    bestShort: rotation.bestShort?.microFamilyId || null,
    bestLong: null
  });

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_CANDIDATES_READY_MANUAL_EXACT_MICRO_MICRO_SELECTION_REQUIRED'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_CANDIDATES_READY_MANUAL_EXACT_MICRO_MICRO_SELECTION_REQUIRED',
    weekKey: dataWeekKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,

    ...modeFlags(),

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    selectedMicroFamilies: 0,
    selectedTrueMicroFamilies: 0,
    selectedChildTrueMicroFamilies: 0,
    selectedMicroMicroFamilies: 0,
    selectedParentTrueMicroFamilies: 0,

    candidateMicroFamilies: rotation.microFamilyIds.length,
    candidateTrueMicroFamilies: rotation.trueMicroFamilyIds.length,
    candidateChildTrueMicroFamilies: rotation.childTrueMicroFamilyIds.length,
    candidateMicroMicroFamilies: rotation.microMicroFamilyIds.length,
    candidateParentTrueMicroFamilies: rotation.parentTrueMicroFamilyIds.length,

    missingSides: rotation.missingSides || [],
    bestShort: rotation.bestShort,
    bestLong: null,

    rotation
  };
}

function isManualActiveRotation(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') return false;

  const source = upper(rotation.source);
  const mode = upper(rotation.mode);

  if (rotation.manualOnly === true) return true;
  if (rotation.adminSelected === true) return true;
  if (mode === 'MANUAL' || mode === 'SELECTED') return true;
  if (source.includes('MANUAL')) return true;
  if (source.includes('SELECTED')) return true;
  if (source.startsWith('ADMIN_')) return true;
  if (source.startsWith('CLI_MANUAL')) return true;
  if (MANUAL_ACTIVE_SOURCES.has(source)) return true;

  return false;
}

function sanitizeActiveRotation(rotation = {}, { requireManual = false } = {}) {
  if (!rotation || typeof rotation !== 'object') return null;

  if (requireManual && !isManualActiveRotation(rotation)) return null;

  const rawRows = Array.isArray(rotation.microFamilies) ? rotation.microFamilies : [];
  const rawIds = uniqueStrings([
    rotation.microMicroFamilyIds || [],
    rotation.trueMicroMicroFamilyIds || [],
    rotation.exactMicroMicroFamilyIds || [],
    rotation.activeMicroMicroFamilyIds || [],
    rotation.selectedMicroMicroFamilyIds || [],
    rotation.microFamilyIds || [],
    rotation.activeMicroFamilyIds || [],
    rotation.trueMicroFamilyIds || [],
    rotation.ids || [],
    rawRows.map((row) => rowId(row, { allowProxy: false }))
  ])
    .map(cleanLearningMicroId)
    .filter(isSelectableMicroMicroId);

  const activeIds = uniqueStrings(rawIds).slice(0, topNPerSide());
  const activeSet = new Set(activeIds);

  const rows = [];
  const existing = new Set();

  for (const row of rawRows) {
    const id = rowId(row, { allowProxy: false });
    if (!id || !activeSet.has(id) || existing.has(id)) continue;

    const compact = compactRotationRow({
      ...row,
      id,
      key: id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      microMicroFamilyId: id,
      active: true
    }, rows.length + 1);

    if (!compact) continue;

    rows.push(compact);
    existing.add(id);
  }

  for (const id of activeIds) {
    if (existing.has(id)) continue;

    const compact = compactRotationRow(buildManualOnlyRow(id, rows.length + 1), rows.length + 1);
    if (!compact) continue;

    rows.push(compact);
    existing.add(id);
  }

  const sortedRows = sortAdaptiveRows(rows);
  const indexes = buildSelectionIndexes(sortedRows);
  const manual = isManualActiveRotation(rotation);

  return {
    ...rotation,

    ...modeFlags(),

    manualOnly: manual,
    adminSelected: manual,
    autoRotation: false,
    liveSelectable: manual && sortedRows.length > 0,

    usedLegacyFallback: false,

    microFamilies: sortedRows.map((row, index) => ({ ...row, rank: index + 1 })),

    ...indexes,

    bestShort: bestShortRow(sortedRows),
    bestLong: null,
    missingSides: missingSides(sortedRows),

    empty: sortedRows.length === 0,
    emptyReason: sortedRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_MANUAL_SHORT_EXACT_MICRO_MICRO_SELECTIONS'
      : null
  };
}

export async function activateNextRotation() {
  return {
    ok: false,
    skipped: true,
    changed: false,
    reason: 'AUTO_ROTATION_ACTIVATION_DISABLED_MANUAL_EXACT_MICRO_MICRO_ONLY',
    ...modeFlags(),
    manualOnly: true,
    activationDisabled: true
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  const raw = await getJson(redis, activeRotationKey(), null);
  const sanitized = sanitizeActiveRotation(raw, { requireManual: true });

  if (!sanitized || sanitized.empty || !sanitized.microMicroFamilyIds?.length) {
    return null;
  }

  const needsHeal =
    raw?.longOnly === true ||
    raw?.shortDisabled === true ||
    raw?.targetTradeSide === OPPOSITE_TRADE_SIDE ||
    raw?.dashboardSide === 'bull' ||
    raw?.manualOnly !== true ||
    raw?.liveSelectable !== true ||
    raw?.autoRotation === true ||
    raw?.selectionGranularity !== SELECTION_EXACT_MICRO_MICRO_ONLY ||
    raw?.microMicroFamilySchema !== MICRO_MICRO_SCHEMA ||
    raw?.discordSelectionRule !== SELECTION_EXACT_MICRO_MICRO_ONLY ||
    raw?.manualSelectionMatchMode !== 'EXACT_MICRO_MICRO_ID';

  if (needsHeal) {
    await setJson(redis, activeRotationKey(), sanitized).catch(() => null);
  }

  return sanitized;
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeMicroMicroFamilyIds || [],
    active?.microMicroFamilyIds || [],
    active?.trueMicroMicroFamilyIds || [],
    active?.exactMicroMicroFamilyIds || [],
    active?.selectedMicroMicroFamilyIds || [],
    active?.microFamilyIds || [],
    active?.trueMicroFamilyIds || []
  ])
    .map(cleanLearningMicroId)
    .filter(isSelectableMicroMicroId);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  // Bewust leeg: parent/macro matches mogen Discord nooit triggeren.
  return new Set();
}

function manualSideFromId(id = '') {
  const value = upper(id);

  if (isScannerFingerprintId(value)) return 'UNKNOWN';
  if (isExecutionFingerprintId(value)) return 'UNKNOWN';
  if (hasLongSignal(value) && !hasShortSignal(value)) return OPPOSITE_TRADE_SIDE;
  if (hasShortSignal(value) || parseShortTaxonomyMicroId(value).valid) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank = 1) {
  const cleanId = cleanLearningMicroId(id);
  const parsed = parseShortTaxonomyMicroId(cleanId);

  if (!parsed.isMicroMicro) return null;

  return {
    rank,

    id: parsed.trueMicroFamilyId,
    key: parsed.trueMicroFamilyId,
    microFamilyId: parsed.trueMicroFamilyId,
    trueMicroFamilyId: parsed.trueMicroFamilyId,
    analyzeMicroFamilyId: parsed.trueMicroFamilyId,
    learningMicroFamilyId: parsed.trueMicroFamilyId,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.base75ChildTrueMicroFamilyId,
    microMicroFamilyId: parsed.trueMicroFamilyId,
    trueMicroMicroFamilyId: parsed.trueMicroFamilyId,
    exactMicroMicroFamilyId: parsed.trueMicroFamilyId,
    microMicroHash: parsed.microMicroHash,

    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMicroFamilyId: parsed.parentTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,

    setupType: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
    confirmationProfile: parsed.confirmationProfile,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    ...modeFlags(),

    schema: MICRO_MICRO_SCHEMA,
    microFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    version: 'manual_short_exact_micro_micro',
    microMicroVersion: MICRO_MICRO_VERSION,

    fixedTaxonomyLearningId: true,
    learningLayer: LAYER_MICRO_MICRO,
    layer: LAYER_MICRO_MICRO,
    selectionGranularity: SELECTION_EXACT_MICRO_MICRO_ONLY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    isTrueMicro: true,
    isChildTrueMicro: false,
    isMicroMicro: true,
    isLegacyMacro: false,
    selectable: true,
    selectableMicroMicro: true,
    manualOnly: true,
    unverifiedManualId: true,

    rotationEligibilityTier: 'MANUAL',
    rotationEligible: true,
    learningStatus: 'MICRO_MICRO_OBSERVING',
    status: 'MICRO_MICRO_OBSERVING',

    seen: 0,
    observations: 0,
    observationSample: 0,
    completed: 0,
    outcomeSample: 0,
    realCompleted: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,

    wins: 0,
    losses: 0,
    flats: 0,
    winrate: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,
    sampleReliability: 0,

    avgR: 0,
    totalR: 0,
    profitFactor: 0,
    directSLPct: 0,
    directSLCount: 0,
    totalCostR: 0,
    avgCostR: 0,
    adaptiveScore: 0,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `MANUAL_SELECTED_ID=${parsed.trueMicroFamilyId}`,
      `CHILD_TRUE_MICRO=${parsed.childTrueMicroFamilyId}`,
      `PARENT_TRUE_MICRO=${parsed.parentTrueMicroFamilyId}`,
      `MICRO_MICRO=${parsed.trueMicroFamilyId}`,
      `SCHEMA=${MICRO_MICRO_SCHEMA}`,
      `LAYER=${LAYER_MICRO_MICRO}`,
      'SOURCE=MANUAL_SELECTION'
    ],

    definition: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `MANUAL_SELECTED_ID=${parsed.trueMicroFamilyId}`,
      `CHILD_TRUE_MICRO=${parsed.childTrueMicroFamilyId}`,
      `PARENT_TRUE_MICRO=${parsed.parentTrueMicroFamilyId}`,
      `MICRO_MICRO=${parsed.trueMicroFamilyId}`,
      `SCHEMA=${MICRO_MICRO_SCHEMA}`,
      `LAYER=${LAYER_MICRO_MICRO}`,
      'SOURCE=MANUAL_SELECTION'
    ].join(' | ')
  };
}

function requestedManualIdsFromOptions(options = {}) {
  return uniqueStrings([
    options.microMicroFamilyIds || [],
    options.trueMicroMicroFamilyIds || [],
    options.exactMicroMicroFamilyIds || [],
    options.activeMicroMicroFamilyIds || [],
    options.selectedMicroMicroFamilyIds || [],
    options.microFamilyIds || [],
    options.activeMicroFamilyIds || [],
    options.trueMicroFamilyIds || [],
    options.ids || [],
    options.id || []
  ]);
}

function resolveManualSelection({ requestedIds = [], micros = {} }) {
  const selectedRows = [];
  const ignoredIds = [];
  const seen = new Set();

  const microsByUpperId = Object.fromEntries(
    sourceEntries(micros)
      .map(([key, row]) => {
        const id = rowId({ ...(row || {}), key }, { allowProxy: true });
        return [upper(id), row];
      })
      .filter(([id]) => Boolean(id))
  );

  for (const requestedId of requestedIds) {
    const parsed = parseShortTaxonomyMicroId(requestedId);
    const normalizedId = parsed.trueMicroFamilyId || cleanLearningMicroId(requestedId);
    const side = manualSideFromId(requestedId);

    if (side !== TARGET_TRADE_SIDE) {
      ignoredIds.push({
        id: requestedId,
        normalizedId,
        side,
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'LONG_DISABLED_SHORT_ONLY'
          : 'UNKNOWN_OR_NON_SHORT_ID_REJECTED'
      });
      continue;
    }

    if (parsed.isParent) {
      ignoredIds.push({
        id: requestedId,
        normalizedId,
        side,
        reason: 'PARENT_15_CONTEXT_ONLY_NOT_SELECTABLE_SELECT_EXACT_MICRO_MICRO'
      });
      continue;
    }

    if (parsed.isChild) {
      ignoredIds.push({
        id: requestedId,
        normalizedId,
        side,
        reason: 'CHILD75_CONTEXT_ONLY_NOT_SELECTABLE_SELECT_EXACT_MICRO_MICRO'
      });
      continue;
    }

    if (!parsed.isMicroMicro) {
      ignoredIds.push({
        id: requestedId,
        normalizedId,
        side,
        reason: isScannerFingerprintId(requestedId)
          ? 'SCANNER_FINGERPRINT_METADATA_ONLY_NOT_SELECTABLE'
          : isExecutionFingerprintId(requestedId)
            ? 'XR_EXECUTION_FINGERPRINT_METADATA_ONLY_USE_MM_ID_INSTEAD'
            : 'ONLY_EXACT_SHORT_MICRO_MICRO_IDS_ALLOWED'
      });
      continue;
    }

    if (seen.has(parsed.trueMicroFamilyId)) continue;

    const sourceRow = micros[parsed.trueMicroFamilyId] || microsByUpperId[upper(parsed.trueMicroFamilyId)];
    const row = sourceRow
      ? {
        ...sourceRow,
        id: parsed.trueMicroFamilyId,
        key: parsed.trueMicroFamilyId,
        microFamilyId: parsed.trueMicroFamilyId,
        trueMicroFamilyId: parsed.trueMicroFamilyId,
        microMicroFamilyId: parsed.trueMicroFamilyId,
        trueMicroMicroFamilyId: parsed.trueMicroFamilyId,
        exactMicroMicroFamilyId: parsed.trueMicroFamilyId
      }
      : allowManualUnknownMicroMicroIds()
        ? buildManualOnlyRow(parsed.trueMicroFamilyId, selectedRows.length + 1)
        : null;

    if (!row) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: parsed.trueMicroFamilyId,
        side,
        reason: 'UNKNOWN_SHORT_MICRO_MICRO_ID'
      });
      continue;
    }

    const compact = compactRotationRow(row, selectedRows.length + 1);

    if (!compact) {
      ignoredIds.push({
        id: requestedId,
        normalizedId: parsed.trueMicroFamilyId,
        side,
        reason: 'ROW_COULD_NOT_NORMALIZE_TO_EXACT_MICRO_MICRO'
      });
      continue;
    }

    selectedRows.push(compact);
    seen.add(parsed.trueMicroFamilyId);
  }

  return {
    selectedRows,
    ignoredIds,
    expandedFromMacro: {}
  };
}

function buildPreservedActiveResponse({
  existingActive,
  requestedIds,
  ignoredIds,
  weekKey,
  mode
}) {
  if (existingActive) {
    return {
      ...existingActive,
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: true,
      reason: 'NO_VALID_SHORT_EXACT_MICRO_MICRO_IDS_SELECTED_ACTIVE_ROTATION_PRESERVED',
      requestedMicroFamilyIds: requestedIds,
      ignoredRequestedIds: ignoredIds
    };
  }

  return {
    ok: false,
    skipped: true,
    changed: false,
    activePreserved: false,
    rotationId: null,
    source: 'ADMIN_MANUAL_SELECTION_SHORT_EXACT_MICRO_MICRO_ONLY',
    mode,
    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),
    dataWeekKey: weekKey,
    learningDataKey: weekKey,
    generatedAt: now(),
    activatedAt: null,
    ...modeFlags(),
    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: false,
    empty: true,
    emptyReason: 'NO_VALID_SHORT_EXACT_MICRO_MICRO_IDS_SELECTED',
    reason: 'NO_VALID_SHORT_EXACT_MICRO_MICRO_IDS_SELECTED',
    microFamilies: [],
    microFamilyIds: [],
    activeMicroFamilyIds: [],
    trueMicroFamilyIds: [],
    childTrueMicroFamilyIds: [],
    activeChildTrueMicroFamilyIds: [],
    microMicroFamilyIds: [],
    activeMicroMicroFamilyIds: [],
    trueMicroMicroFamilyIds: [],
    activeTrueMicroMicroFamilyIds: [],
    exactMicroMicroFamilyIds: [],
    selectedMicroMicroFamilyIds: [],
    macroFamilyIds: [],
    activeMacroFamilyIds: [],
    parentTrueMicroFamilyIds: [],
    activeParentTrueMicroFamilyIds: [],
    microToMacroFamilyId: {},
    microToParentTrueMicroFamilyId: {},
    microToChildTrueMicroFamilyId: {},
    microToMicroMicroFamilyId: {},
    macroToMicroFamilyIds: {},
    parentTrueMicroFamilyToMicroFamilyIds: {},
    childTrueMicroFamilyToMicroMicroFamilyIds: {},
    bestShort: null,
    bestLong: null,
    missingSides: [TARGET_TRADE_SIDE],
    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds
  };
}

export async function activateSelectedMicroFamilies(options = {}) {
  const {
    weekKey = PERSISTENT_LEARNING_KEY,
    activeWeekKey = getIsoWeekKey(),
    mode = 'manual'
  } = options || {};

  const redis = getDurableRedis();
  const dataWeekKey = learningDataKey(weekKey);

  const [rotationMicros, existingRawActive] = await Promise.all([
    getRotationMicros(dataWeekKey),
    getJson(redis, activeRotationKey(), null).catch(() => null)
  ]);

  const {
    micros,
    usedPreviousWeekMerge,
    usedPersistentLearningKey,
    primaryRows,
    previousRows
  } = rotationMicros;

  const requestedIds = requestedManualIdsFromOptions(options);

  const {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  } = resolveManualSelection({ requestedIds, micros });

  const microFamilies = sortAdaptiveRows(selectedRows)
    .slice(0, topNPerSide())
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter(Boolean);

  if (microFamilies.length === 0) {
    const existingActive = sanitizeActiveRotation(existingRawActive, { requireManual: true });

    return buildPreservedActiveResponse({
      existingActive,
      requestedIds,
      ignoredIds,
      weekKey: dataWeekKey,
      mode
    });
  }

  const indexes = buildSelectionIndexes(microFamilies);
  const meta = schemaMeta();

  const active = sanitizeActiveRotation({
    rotationId: randomId(`ROT_${dataWeekKey}_manual_short_exact_micro_micro`),
    source: 'ADMIN_MANUAL_SELECTION_SHORT_MICRO_MICRO_ONLY',
    mode,

    sourceWeekKey: dataWeekKey,
    activeWeekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    ...meta,
    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: indexes.microMicroFamilyIds.length > 0,

    usedLegacyFallback: false,
    usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'MICRO_MICRO_SOFT'),
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),
    usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'RAW'),
    usedPreviousWeekMerge,
    usedPersistentLearningKey,

    minMicroMicroCompleted: minMicroMicroCompleted(),
    topNPerSide: topNPerSide(),

    primaryRows,
    previousRows,

    empty: indexes.microMicroFamilyIds.length === 0,
    emptyReason: indexes.microMicroFamilyIds.length === 0
      ? 'NO_SHORT_EXACT_MICRO_MICRO_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    requestedTrueMicroFamilyIds: requestedIds,
    requestedMicroMicroFamilyIds: indexes.microMicroFamilyIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

    bestShort: bestShortRow(microFamilies),
    bestLong: null,
    missingSides: missingSides(microFamilies),

    ...indexes,

    microFamilies
  }, { requireManual: true });

  const finalActive = {
    ...active,
    ok: true,
    skipped: false,
    changed: true,
    activePreserved: false
  };

  await setJson(redis, activeRotationKey(), finalActive);

  return finalActive;
}

function sanitizeDashboardRotation(rotation) {
  const sanitized = sanitizeActiveRotation(rotation, { requireManual: false });

  if (!sanitized) return null;

  return {
    ...sanitized,
    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    candidateMicroFamilyIds: sanitized.microFamilyIds || [],
    candidateTrueMicroFamilyIds: sanitized.trueMicroFamilyIds || [],
    candidateChildTrueMicroFamilyIds: sanitized.childTrueMicroFamilyIds || [],
    candidateMicroMicroFamilyIds: sanitized.microMicroFamilyIds || [],
    candidateParentTrueMicroFamilyIds: sanitized.parentTrueMicroFamilyIds || [],
    candidateMacroFamilyIds: sanitized.macroFamilyIds || []
  };
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getActiveRotation(),
    getJson(redis, nextRotationKey(), null),
    getJson(redis, rotationValidFromKey(), null)
  ]);

  const active = sanitizeActiveRotation(activeRaw, { requireManual: true });
  const next = sanitizeDashboardRotation(nextRaw);

  const activeRows = Array.isArray(active?.microFamilies) ? active.microFamilies : [];
  const nextRows = Array.isArray(next?.microFamilies) ? next.microFamilies : [];

  return {
    active,
    next,
    validFrom,

    activeRows,
    nextRows,

    activeCount: active?.microMicroFamilyIds?.length || 0,
    nextCount: next?.microMicroFamilyIds?.length || 0,

    activeTrueMicroCount: active?.trueMicroFamilyIds?.length || 0,
    nextTrueMicroCount: next?.trueMicroFamilyIds?.length || 0,

    activeChildTrueMicroCount: 0,
    nextChildTrueMicroCount: 0,

    activeMicroMicroCount: active?.microMicroFamilyIds?.length || 0,
    nextMicroMicroCount: next?.microMicroFamilyIds?.length || 0,

    activeParentTrueMicroCount: active?.parentTrueMicroFamilyIds?.length || 0,
    nextParentTrueMicroCount: next?.parentTrueMicroFamilyIds?.length || 0,

    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeTrueMicroFamilyIds: active?.trueMicroFamilyIds || [],
    nextTrueMicroFamilyIds: next?.trueMicroFamilyIds || [],

    activeChildTrueMicroFamilyIds: [],
    nextChildTrueMicroFamilyIds: [],

    activeMicroMicroFamilyIds: active?.microMicroFamilyIds || active?.activeMicroMicroFamilyIds || [],
    nextMicroMicroFamilyIds: next?.microMicroFamilyIds || next?.activeMicroMicroFamilyIds || [],

    activeTrueMicroMicroFamilyIds: active?.trueMicroMicroFamilyIds || active?.activeTrueMicroMicroFamilyIds || [],
    nextTrueMicroMicroFamilyIds: next?.trueMicroMicroFamilyIds || next?.activeTrueMicroMicroFamilyIds || [],

    activeExactMicroMicroFamilyIds: active?.exactMicroMicroFamilyIds || [],
    nextExactMicroMicroFamilyIds: next?.exactMicroMicroFamilyIds || [],

    activeParentTrueMicroFamilyIds: active?.parentTrueMicroFamilyIds || active?.activeParentTrueMicroFamilyIds || [],
    nextParentTrueMicroFamilyIds: next?.parentTrueMicroFamilyIds || next?.activeParentTrueMicroFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},

    activeMicroToParentTrueMicroFamilyId: active?.microToParentTrueMicroFamilyId || {},
    nextMicroToParentTrueMicroFamilyId: next?.microToParentTrueMicroFamilyId || {},

    activeMicroToChildTrueMicroFamilyId: active?.microToChildTrueMicroFamilyId || {},
    nextMicroToChildTrueMicroFamilyId: next?.microToChildTrueMicroFamilyId || {},

    activeMicroToMicroMicroFamilyId: active?.microToMicroMicroFamilyId || {},
    nextMicroToMicroMicroFamilyId: next?.microToMicroMicroFamilyId || {},

    activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},

    activeParentTrueMicroFamilyToMicroFamilyIds: active?.parentTrueMicroFamilyToMicroFamilyIds || {},
    nextParentTrueMicroFamilyToMicroFamilyIds: next?.parentTrueMicroFamilyToMicroFamilyIds || {},

    activeChildTrueMicroFamilyToMicroMicroFamilyIds: active?.childTrueMicroFamilyToMicroMicroFamilyIds || {},
    nextChildTrueMicroFamilyToMicroMicroFamilyIds: next?.childTrueMicroFamilyToMicroMicroFamilyIds || {},

    bestShort: active?.bestShort || null,
    bestLong: null,
    nextBestShort: next?.bestShort || null,
    nextBestLong: null,

    missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
    nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],

    usedSoftFallback: Boolean(active?.usedSoftFallback),
    nextUsedSoftFallback: Boolean(next?.usedSoftFallback),

    usedObservationFallback: Boolean(active?.usedObservationFallback),
    nextUsedObservationFallback: Boolean(next?.usedObservationFallback),

    usedRawFallback: Boolean(active?.usedRawFallback),
    nextUsedRawFallback: Boolean(next?.usedRawFallback),

    usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
    nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),

    usedPersistentLearningKey: Boolean(active?.usedPersistentLearningKey),
    nextUsedPersistentLearningKey: Boolean(next?.usedPersistentLearningKey),

    dataWeekKey: active?.dataWeekKey || PERSISTENT_LEARNING_KEY,
    learningDataKey: active?.learningDataKey || PERSISTENT_LEARNING_KEY,

    manualOnly: true,
    autoRotationActivationDisabled: true,
    activeLiveSelectable: Boolean(active?.liveSelectable),

    ...modeFlags()
  };
}