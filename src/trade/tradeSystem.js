// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import {
  KEYS,
  assertKeyAllowedForWriteScope
} from '../keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { analyzeCandidatesBatch } from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  saveOpenPosition,
  monitorOpenPositions
} from './positionEngine.js';
import { riskFractionForEntry } from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

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
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RUN_SCOPE = 'TRADE_FAST_ENTRY_BUDGET_FIRST';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_SHORT_SCANNER_AND_MARKET_WEATHER';

const ENTRY_RELAXATION_PROFILE = 'SHORT_SCANNER_WIDE_VIRTUAL_LEARNING_V1';
const QUALITY_MEASUREMENT_PROFILE = 'SHORT_MICRO_FAMILY_TP_SL_LEARNING_V1';

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 8;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 10;
const DEFAULT_DATA_CONCURRENCY = 2;
const DEFAULT_MAX_SNAPSHOT_AGE_SEC = 8 * 60;

const DEFAULT_MIN_RISK_PCT = 0.0035;
const DEFAULT_MAX_RISK_PCT = 0.03;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;
const DEFAULT_RR = 2.0;
const DEFAULT_MIN_RR = 1.5;

const DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES = true;
const DEFAULT_SKIP_LIVE_RISK_FETCH_FOR_LEARNING = true;

const DEFAULT_DISCORD_REQUIRE_CURRENT_FIT = true;
const DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE = 35;
const DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC = 15 * 60;

const DEFAULT_MARKET_CONTEXT_TIMEOUT_MS = 800;
const DEFAULT_MONITOR_TIMEOUT_MS = 2500;
const DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS = 800;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 1800;
const DEFAULT_ANALYZE_TIMEOUT_MS = 3500;
const DEFAULT_ROTATION_TIMEOUT_MS = 800;
const DEFAULT_MAX_RUNTIME_MS = 24000;

const DEFAULT_MONITOR_LIVE_PRICE_FETCH_ENABLED = true;
const DEFAULT_MONITOR_BATCH_SIZE = 40;
const DEFAULT_OPEN_POSITION_MONITOR_LIMIT = 80;

const DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS = 3;
const DEFAULT_ENTRY_LOOP_RESERVE_MS = 900;
const DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS = 900;
const DEFAULT_SAVE_POSITION_TIMEOUT_MS = 1200;

const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const LIVE_PRICE_CACHE_TTL_MS = 2500;

const livePriceCache = new Map();

const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

const FREEZE_MEASUREMENT_RECOMMENDED_DAYS = 14;
const MIN_COMPLETED_EARLY_SIGNAL = 20;
const MIN_COMPLETED_REASONABLE_SIGNAL = 50;
const MIN_COMPLETED_STRONG_SIGNAL = 100;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

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

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

let ACTIVE_RUN_OPTIONS = {};

function now() {
  return Date.now();
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

function cfgNumber(value, fallback) {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function cfgBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  if (typeof value === 'boolean') return value;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(cfgNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round(value, decimals = 8) {
  return Number(safeNumber(value, 0).toFixed(decimals));
}

function ratio(part, total) {
  const p = safeNumber(part, 0);
  const t = safeNumber(total, 0);
  if (t <= 0) return 0;
  return p / t;
}

function pct(part, total) {
  return Number((ratio(part, total) * 100).toFixed(2));
}

function elapsedMs(startedAt) {
  return Math.max(0, now() - safeNumber(startedAt, now()));
}

function runtimeExceeded(startedAt, cfg, reserveMs = 1000) {
  return elapsedMs(startedAt) >= Math.max(
    1000,
    safeNumber(cfg.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS) - reserveMs
  );
}

function timeoutPayload(label, timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        __timeout: true,
        label,
        timeoutMs
      });
    }, Math.max(1, Math.floor(Number(timeoutMs) || 1)));
  });
}

async function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    timeoutPayload(label, timeoutMs)
  ]);
}

function isTimeoutResult(value) {
  return Boolean(value && typeof value === 'object' && value.__timeout === true);
}

function namespacedShortKey(key, fallback = 'UNKNOWN') {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}${fallback}`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function keyFromMaybeFunction(fn, arg, fallback) {
  try {
    if (typeof fn === 'function') return fn(arg);
  } catch {
    return fallback;
  }

  return fallback;
}

function shortScanSnapshotKey(snapshotId) {
  const fromShort = keyFromMaybeFunction(
    KEYS.short?.scan?.snapshot,
    snapshotId,
    null
  );

  if (fromShort) return namespacedShortKey(fromShort, `SCAN:SNAPSHOT:${snapshotId}`);

  const fromGenericShort = keyFromMaybeFunction(
    KEYS.scan?.shortSnapshot,
    snapshotId,
    null
  );

  if (fromGenericShort) return namespacedShortKey(fromGenericShort, `SCAN:SNAPSHOT:${snapshotId}`);

  const fromGeneric = keyFromMaybeFunction(
    KEYS.scan?.snapshot,
    snapshotId,
    null
  );

  return namespacedShortKey(fromGeneric, `SCAN:SNAPSHOT:${snapshotId}`);
}

const SHORT_KEYS = {
  scan: {
    latest: namespacedShortKey(
      KEYS.short?.scan?.latest ||
        KEYS.scan?.shortLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),
    snapshot: shortScanSnapshotKey
  },

  trade: {
    runMeta: namespacedShortKey(
      KEYS.short?.trade?.runMeta ||
        KEYS.trade?.shortRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN_META'
    ),
    lastProcessedSnapshot: namespacedShortKey(
      KEYS.short?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.shortLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  }
};

function isolationFlags() {
  return {
    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    namespace: SHORT_NAMESPACE,
    redisNamespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    readsScannerLatest: true,
    scannerLatestReadOnly: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    scannerRunAllowed: false,
    scannerRunDisabledInsideTradeRun: true,
    noScannerRun: true,
    noScannerRefresh: true,
    noScannerLatestWrite: true,
    noScannerSnapshotWrite: true,
    noScannerHistoryWrite: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesLiveCache: false,
    liveCacheReadOnly: true,

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradeLastProcessedSnapshot: true,
    writesTradePositions: true,

    writesAnalyze: true,
    writesAnalyzePartial: true,
    writesMicroFamilies: true,
    microFamiliesAppendOnly: true,
    microFamiliesAntiWipe: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    writesRotation: false,
    writesManualSelection: false,
    writesDiscordSelection: false,

    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    noResetCron: true,
    resetCronDisabled: true,
    noActivateCron: true,
    activateCronDisabled: true,
    noFreezeCron: true,
    freezeCronDisabled: true,
    autoRotationActivationDisabled: true,
    manualSelectionPreserved: true,

    realOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    monitorOpenPositionsHardFirst: true,
    monitorOpenPositionsBeforeEntries: true,
    exitSweepBeforeEntryGate: true,
    closeVirtualPositionsBeforeEntries: true,
    newEntriesBlockedUntilMonitorAttempted: false,

    entryLoopBudgetProtected: true,
    entryLoopMinimumAttempts: DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS,
    monitorTimeoutDoesNotBlockEntries: true,
    analyzeTimeoutFallbackExact75Enabled: true,
    compactRunMetaForRedis: true,
    compactLastProcessedSnapshot: true,
    largeMarketWeatherRowsOmitted: true
  };
}

function sideFlags() {
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
    shortDisabled: false
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const value = upper(id);

  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId: String(id || '').trim()
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
    rawId: String(id || '').trim(),
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

function isSelectableTrueMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return Boolean(parsed.selectable && parsed.childTrueMicroFamilyId);
}

function isParentTrueMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return Boolean(parsed.isParent && !parsed.selectable);
}

function parentIdFromChild(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.parentTrueMicroFamilyId || '';
}

function taxonomyFlags(row = {}) {
  const taxonomy = parseShortTaxonomyMicroId(
    row.childTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      ''
  );

  return {
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    schema: TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    setupType: taxonomy.setup || row.setupType || null,
    regimeBucket: taxonomy.regime || row.regimeBucket || null,
    confirmationProfile: taxonomy.confirmationProfile || row.confirmationProfile || null,

    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId || row.parentTrueMicroFamilyId || null,
    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId || row.childTrueMicroFamilyId || null,
    coarseMicroFamilyId: taxonomy.parentTrueMicroFamilyId || row.coarseMicroFamilyId || null,

    parent15MetadataOnly: true,
    parentTrueMicroSelectable: false,
    child75Selectable: Boolean(taxonomy.selectable)
  };
}

function discordRequiresCurrentFit() {
  return cfgBoolean(
    CONFIG.short?.trade?.discordRequiresCurrentFit ??
      CONFIG.trade?.shortDiscordRequiresCurrentFit ??
      CONFIG.trade?.discordRequiresCurrentFit,
    DEFAULT_DISCORD_REQUIRE_CURRENT_FIT
  );
}

function discordMinCurrentFitConfidence() {
  return clampNumber(
    CONFIG.short?.trade?.discordMinCurrentFitConfidence ??
      CONFIG.trade?.shortDiscordMinCurrentFitConfidence ??
      CONFIG.trade?.discordMinCurrentFitConfidence ??
      DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE,
    0,
    100
  );
}

function currentFitMaxWeatherAgeSec() {
  return positiveInt(
    CONFIG.short?.trade?.currentFitMaxWeatherAgeSec ??
      CONFIG.trade?.shortCurrentFitMaxWeatherAgeSec ??
      CONFIG.trade?.currentFitMaxWeatherAgeSec,
    DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC,
    30,
    24 * 3600
  );
}

function virtualFlags(row = {}) {
  return {
    virtualOnly: true,
    virtualTracked: true,
    virtualLearning: true,
    virtualLearningForced: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: false,
    microFamilyLearning: true,

    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL,
    riskEnginePreferredButNotRequiredForLearning: true,
    standardizedLearningRiskFallbackEnabled: DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK,

    observationFirst: true,
    observationFirstAnalyze: true,
    observationFirstLearning: true,
    observationDedupeRequired: true,
    observationDedupeEnabled: true,
    seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',
    observationDedupeKeySource: 'snapshotId|symbol|trueMicroFamilyId|entry',

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,
    scannerBucketsAreNotSelectable: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    noSyntheticShadowLayer: true,
    disciplinedMeasurement: true,
    recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionIsAdaptive: true,
    discordWillBeStrict: true,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },
    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL
    },

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortRiskShape: true,
    shortRiskShape: 'tp < entry < sl',
    shortRiskFormula: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    netOutcomesOnly: true,
    timeStopEnabled: true,

    selectableChildMicroFamilyCount: 75,
    selectableFamilyCount: 75,
    parentFamilyCount: 15,
    parentSelectable: false,
    childSelectable: true,
    parentFamilyFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableChildFamilyFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    exampleParentTrueMicroFamilyId: 'MICRO_SHORT_BREAKOUT_TREND',
    exampleSelectableTrueMicroFamilyId: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',
    parentIdsAreMetadataOnly: true,
    selectableIdsAre75ChildOnly: true,
    discordSelectionGranularity: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID',
    learningMode: 'MICRO_FAMILY_SHORT_ONLY_VIRTUAL_75_CHILD',
    manualSelectionOnly: true,
    manualSelectionMustUseSelectable75ChildId: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',

    weekResetDisabled: true,
    isoWeekLearningDisabled: true,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    ...taxonomyFlags(row)
  };
}

function tradeConfig() {
  const options = ACTIVE_RUN_OPTIONS || {};

  const hardMaxCandidates = positiveInt(
    firstDefined(
      options.hardMaxCandidatesPerSnapshot,
      CONFIG.short?.trade?.hardMaxCandidatesPerSnapshot,
      CONFIG.trade?.shortHardMaxCandidatesPerSnapshot,
      CONFIG.trade?.hardMaxCandidatesPerSnapshot,
      DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT
    ),
    DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT,
    1,
    12
  );

  const requestedMaxCandidates = cfgNumber(
    firstDefined(
      options.maxCandidatesPerSnapshot,
      options.maxCandidates,
      CONFIG.short?.trade?.maxCandidatesPerSnapshot,
      CONFIG.trade?.shortMaxCandidatesPerSnapshot,
      CONFIG.trade?.maxCandidatesPerSnapshot,
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
    ),
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
  );

  const allowStandardizedLearningRiskFallback = cfgBoolean(
    firstDefined(
      options.allowStandardizedLearningRiskFallback,
      options.allowLearningRiskFallback,
      CONFIG.short?.trade?.allowStandardizedLearningRiskFallback,
      CONFIG.short?.trade?.allowLearningRiskFallback,
      CONFIG.trade?.shortAllowStandardizedLearningRiskFallback,
      CONFIG.trade?.shortAllowLearningRiskFallback,
      CONFIG.trade?.allowStandardizedLearningRiskFallback,
      CONFIG.trade?.allowLearningRiskFallback
    ),
    DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK
  );

  const allowStandardizedLearningRiskVirtualEntries = cfgBoolean(
    firstDefined(
      options.allowStandardizedLearningRiskVirtualEntries,
      options.allowLearningRiskVirtualEntries,
      CONFIG.short?.trade?.allowStandardizedLearningRiskVirtualEntries,
      CONFIG.short?.trade?.allowLearningRiskVirtualEntries,
      CONFIG.trade?.shortAllowStandardizedLearningRiskVirtualEntries,
      CONFIG.trade?.shortAllowLearningRiskVirtualEntries,
      CONFIG.trade?.allowStandardizedLearningRiskVirtualEntries,
      CONFIG.trade?.allowLearningRiskVirtualEntries
    ),
    DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES
  );

  const monitorLivePriceFetchEnabled = cfgBoolean(
    firstDefined(
      options.monitorLivePriceFetchEnabled,
      options.allowMonitorLivePriceFetch,
      CONFIG.short?.trade?.monitorLivePriceFetchEnabled,
      CONFIG.short?.trade?.allowMonitorLivePriceFetch,
      CONFIG.trade?.shortMonitorLivePriceFetchEnabled,
      CONFIG.trade?.monitorLivePriceFetchEnabled,
      CONFIG.trade?.allowMonitorLivePriceFetch
    ),
    DEFAULT_MONITOR_LIVE_PRICE_FETCH_ENABLED
  );

  return {
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    scannerWideVirtualLearning: true,

    tradeEveryScannerCandidateVirtual: cfgBoolean(
      firstDefined(
        options.tradeEveryScannerCandidateVirtual,
        CONFIG.short?.trade?.tradeEveryScannerCandidateVirtual,
        CONFIG.trade?.shortTradeEveryScannerCandidateVirtual,
        CONFIG.trade?.tradeEveryScannerCandidateVirtual
      ),
      DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL
    ),

    maxCandidatesPerSnapshot: positiveInt(
      requestedMaxCandidates,
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      hardMaxCandidates
    ),

    analyzeMaxCandidatesPerSnapshot: positiveInt(
      firstDefined(
        options.analyzeMaxCandidatesPerSnapshot,
        options.maxAnalyzeCandidatesPerSnapshot,
        CONFIG.short?.trade?.analyzeMaxCandidatesPerSnapshot,
        CONFIG.short?.trade?.maxAnalyzeCandidatesPerSnapshot,
        CONFIG.trade?.shortAnalyzeMaxCandidatesPerSnapshot,
        CONFIG.trade?.analyzeMaxCandidatesPerSnapshot,
        requestedMaxCandidates
      ),
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      hardMaxCandidates
    ),

    hardMaxCandidatesPerSnapshot: hardMaxCandidates,

    maxSnapshotAgeSec: cfgNumber(
      firstDefined(
        options.maxSnapshotAgeSec,
        CONFIG.short?.trade?.maxSnapshotAgeSec,
        CONFIG.trade?.shortMaxSnapshotAgeSec,
        CONFIG.trade?.maxSnapshotAgeSec
      ),
      DEFAULT_MAX_SNAPSHOT_AGE_SEC
    ),

    dataConcurrency: positiveInt(
      firstDefined(
        options.dataConcurrency,
        options.tradeDataConcurrency,
        CONFIG.short?.trade?.dataConcurrency,
        CONFIG.trade?.shortDataConcurrency,
        CONFIG.trade?.dataConcurrency
      ),
      DEFAULT_DATA_CONCURRENCY,
      1,
      3
    ),

    minRiskPct: cfgNumber(
      firstDefined(
        options.minRiskPct,
        CONFIG.short?.trade?.minRiskPct,
        CONFIG.trade?.shortMinRiskPct,
        CONFIG.trade?.minRiskPct
      ),
      DEFAULT_MIN_RISK_PCT
    ),

    maxRiskPct: cfgNumber(
      firstDefined(
        options.maxRiskPct,
        CONFIG.short?.trade?.maxRiskPct,
        CONFIG.trade?.shortMaxRiskPct,
        CONFIG.trade?.maxRiskPct
      ),
      DEFAULT_MAX_RISK_PCT
    ),

    fallbackRiskPct: cfgNumber(
      firstDefined(
        options.fallbackRiskPct,
        CONFIG.short?.trade?.fallbackRiskPct,
        CONFIG.trade?.shortFallbackRiskPct,
        CONFIG.trade?.fallbackRiskPct
      ),
      DEFAULT_FALLBACK_RISK_PCT
    ),

    defaultRR: cfgNumber(
      firstDefined(
        options.defaultRR,
        CONFIG.short?.trade?.defaultRR,
        CONFIG.trade?.shortDefaultRR,
        CONFIG.trade?.defaultRR
      ),
      DEFAULT_RR
    ),

    minRR: cfgNumber(
      firstDefined(
        options.minRR,
        CONFIG.short?.trade?.minRR,
        CONFIG.trade?.shortMinRR,
        CONFIG.trade?.minRR
      ),
      DEFAULT_MIN_RR
    ),

    positionTimeStopMin: cfgNumber(
      firstDefined(
        options.positionTimeStopMin,
        CONFIG.short?.trade?.positionTimeStopMin,
        CONFIG.trade?.shortPositionTimeStopMin,
        CONFIG.trade?.positionTimeStopMin
      ),
      720
    ),

    skipLiveRiskFetchForLearning: cfgBoolean(
      firstDefined(
        options.skipLiveRiskFetchForLearning,
        options.skipLiveFetchForLearning,
        options.vercelSafeMode,
        CONFIG.short?.trade?.skipLiveRiskFetchForLearning,
        CONFIG.short?.trade?.skipLiveFetchForLearning,
        CONFIG.trade?.shortSkipLiveRiskFetchForLearning,
        CONFIG.trade?.skipLiveRiskFetchForLearning,
        CONFIG.trade?.vercelSafeMode
      ),
      DEFAULT_SKIP_LIVE_RISK_FETCH_FOR_LEARNING
    ),

    allowStandardizedLearningRiskFallback,
    allowStandardizedLearningRiskVirtualEntries,
    allowSyntheticRiskFallback: allowStandardizedLearningRiskFallback,
    allowSyntheticRiskVirtualEntries: allowStandardizedLearningRiskVirtualEntries,

    marketContextTimeoutMs: positiveInt(
      firstDefined(
        options.marketContextTimeoutMs,
        CONFIG.short?.trade?.marketContextTimeoutMs,
        CONFIG.trade?.shortMarketContextTimeoutMs,
        CONFIG.trade?.marketContextTimeoutMs
      ),
      DEFAULT_MARKET_CONTEXT_TIMEOUT_MS,
      200,
      1500
    ),

    monitorTimeoutMs: positiveInt(
      firstDefined(
        options.monitorTimeoutMs,
        CONFIG.short?.trade?.monitorTimeoutMs,
        CONFIG.trade?.shortMonitorTimeoutMs,
        CONFIG.trade?.monitorTimeoutMs
      ),
      DEFAULT_MONITOR_TIMEOUT_MS,
      500,
      3500
    ),

    monitorPriceFetchTimeoutMs: positiveInt(
      firstDefined(
        options.monitorPriceFetchTimeoutMs,
        CONFIG.short?.trade?.monitorPriceFetchTimeoutMs,
        CONFIG.trade?.shortMonitorPriceFetchTimeoutMs,
        CONFIG.trade?.monitorPriceFetchTimeoutMs
      ),
      DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS,
      100,
      1200
    ),

    monitorLivePriceFetchEnabled,

    monitorBatchSize: positiveInt(
      firstDefined(
        options.monitorBatchSize,
        CONFIG.short?.trade?.monitorBatchSize,
        CONFIG.trade?.shortMonitorBatchSize,
        CONFIG.trade?.monitorBatchSize
      ),
      DEFAULT_MONITOR_BATCH_SIZE,
      5,
      80
    ),

    openPositionMonitorLimit: positiveInt(
      firstDefined(
        options.openPositionMonitorLimit,
        options.maxOpenPositionsToMonitor,
        CONFIG.short?.trade?.openPositionMonitorLimit,
        CONFIG.trade?.shortOpenPositionMonitorLimit,
        CONFIG.trade?.openPositionMonitorLimit
      ),
      DEFAULT_OPEN_POSITION_MONITOR_LIMIT,
      10,
      150
    ),

    candidateTimeoutMs: positiveInt(
      firstDefined(
        options.candidateTimeoutMs,
        CONFIG.short?.trade?.candidateTimeoutMs,
        CONFIG.trade?.shortCandidateTimeoutMs,
        CONFIG.trade?.candidateTimeoutMs
      ),
      DEFAULT_CANDIDATE_TIMEOUT_MS,
      300,
      2500
    ),

    analyzeTimeoutMs: positiveInt(
      firstDefined(
        options.analyzeTimeoutMs,
        CONFIG.short?.trade?.analyzeTimeoutMs,
        CONFIG.trade?.shortAnalyzeTimeoutMs,
        CONFIG.trade?.analyzeTimeoutMs
      ),
      DEFAULT_ANALYZE_TIMEOUT_MS,
      500,
      4500
    ),

    rotationTimeoutMs: positiveInt(
      firstDefined(
        options.rotationTimeoutMs,
        CONFIG.short?.trade?.rotationTimeoutMs,
        CONFIG.trade?.shortRotationTimeoutMs,
        CONFIG.trade?.rotationTimeoutMs
      ),
      DEFAULT_ROTATION_TIMEOUT_MS,
      150,
      1200
    ),

    maxRuntimeMs: positiveInt(
      firstDefined(
        options.maxRuntimeMs,
        CONFIG.short?.trade?.maxRuntimeMs,
        CONFIG.trade?.shortMaxRuntimeMs,
        CONFIG.trade?.maxRuntimeMs
      ),
      DEFAULT_MAX_RUNTIME_MS,
      8000,
      26000
    ),

    minEntryLoopAttempts: positiveInt(
      firstDefined(
        options.minEntryLoopAttempts,
        CONFIG.short?.trade?.minEntryLoopAttempts,
        CONFIG.trade?.shortMinEntryLoopAttempts,
        CONFIG.trade?.minEntryLoopAttempts
      ),
      DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS,
      1,
      8
    ),

    entryLoopReserveMs: positiveInt(
      firstDefined(
        options.entryLoopReserveMs,
        CONFIG.short?.trade?.entryLoopReserveMs,
        CONFIG.trade?.shortEntryLoopReserveMs,
        CONFIG.trade?.entryLoopReserveMs
      ),
      DEFAULT_ENTRY_LOOP_RESERVE_MS,
      250,
      2500
    ),

    openPositionLoadTimeoutMs: positiveInt(
      firstDefined(
        options.openPositionLoadTimeoutMs,
        CONFIG.short?.trade?.openPositionLoadTimeoutMs,
        CONFIG.trade?.shortOpenPositionLoadTimeoutMs,
        CONFIG.trade?.openPositionLoadTimeoutMs
      ),
      DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS,
      250,
      1500
    ),

    savePositionTimeoutMs: positiveInt(
      firstDefined(
        options.savePositionTimeoutMs,
        CONFIG.short?.trade?.savePositionTimeoutMs,
        CONFIG.trade?.shortSavePositionTimeoutMs,
        CONFIG.trade?.savePositionTimeoutMs
      ),
      DEFAULT_SAVE_POSITION_TIMEOUT_MS,
      250,
      2500
    )
  };
}

function sizingConfig() {
  return {
    enabled: CONFIG.short?.sizing?.enabled ?? CONFIG.sizing?.shortEnabled ?? CONFIG.sizing?.enabled ?? true,
    baseRiskPct: cfgNumber(
      CONFIG.short?.sizing?.baseRiskPct ??
        CONFIG.sizing?.shortBaseRiskPct ??
        CONFIG.sizing?.baseRiskPct,
      0.0025
    )
  };
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
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`)
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
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function normalizeTradeSide(side) {
  const raw = cleanSideText(side);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (SHORT_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADESIDE=SHORT') || raw.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADESIDE=LONG') || raw.includes('TRADE_SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) return normalizeTradeSide(row);

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.signalSide,
    row.entrySide,
    row.side
  ];

  for (const value of directSources) {
    const direct = normalizeTradeSide(value);
    if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) return direct;
  }

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.executionMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.parentTrueMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.id,
    row.key,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  const shortHit = hasShortSignal(haystack);
  const longHit = hasLongSignal(haystack);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && longHit) {
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function symbolTokensFromRow(row = {}) {
  return [row.symbol, row.baseSymbol, row.contractSymbol]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
}

function symbolTokensFromAnySymbol(symbol = '') {
  const contractSymbol = normalizeContractSymbol(symbol);
  const baseSymbol = normalizeBaseSymbol(symbol || contractSymbol);

  return [
    symbol,
    contractSymbol,
    baseSymbol,
    normalizeSymbolToken(symbol),
    normalizeSymbolToken(contractSymbol),
    normalizeSymbolToken(baseSymbol)
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
}

function stripSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;
  if (isSelectableTrueMicroId(raw) || isParentTrueMicroId(raw)) return raw.toUpperCase();

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

function cleanLearningFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  const clean = stripSymbolTokensFromFamilyId(raw, row);

  if (!clean) return '';
  if (isScannerFingerprintId(clean)) return '';
  if (isExecutionFingerprintId(clean)) return '';

  return clean.toUpperCase();
}

function getTrueMicroFamilyId(row = {}) {
  const direct = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId
  ]
    .map((id) => cleanLearningFamilyId(id, row))
    .find((id) => isSelectableTrueMicroId(id));

  return direct || '';
}

function getParentTrueMicroFamilyId(row = {}) {
  const child = getTrueMicroFamilyId(row);
  if (child) return parentIdFromChild(child);

  const parent = [
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId
  ]
    .map((id) => cleanLearningFamilyId(id, row))
    .find((id) => isParentTrueMicroId(id));

  return parent || '';
}

function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(candidate.contractSymbol || candidate.symbol);
  const symbol = normalizeBaseSymbol(candidate.symbol || contractSymbol) || normalizeBaseSymbol(contractSymbol);

  return {
    ...candidate,
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}

function scannerMicroFamilyIdFrom(row = {}) {
  return (
    row.scannerMicroFamilyId ||
    (isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isScannerFingerprintId(row.id) ? row.id : null) ||
    (isScannerFingerprintId(row.key) ? row.key : null) ||
    null
  );
}

function scannerFamilyIdFrom(row = {}) {
  return (
    row.scannerFamilyId ||
    (isScannerFingerprintId(row.familyId) ? row.familyId : null) ||
    (isScannerFingerprintId(row.baseFamilyId) ? row.baseFamilyId : null) ||
    null
  );
}

function executionMicroFamilyIdFrom(row = {}) {
  return (
    row.executionMicroFamilyId ||
    (isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId : null) ||
    null
  );
}

function scannerMetadataFrom(...rows) {
  const merged = Object.assign({}, ...rows.filter(Boolean));
  const scannerMicroFamilyId = rows.map(scannerMicroFamilyIdFrom).find(Boolean) || null;
  const scannerFamilyId = rows.map(scannerFamilyIdFrom).find(Boolean) || null;
  const executionMicroFamilyId = rows.map(executionMicroFamilyIdFrom).find(Boolean) || null;

  return {
    scannerMicroFamilyId,
    scannerFamilyId,
    scannerDefinition: merged.scannerDefinition || (
      scannerMicroFamilyId
        ? merged.definition || merged.microDefinition || null
        : null
    ),
    scannerDefinitionParts: Array.isArray(merged.scannerDefinitionParts)
      ? merged.scannerDefinitionParts
      : scannerMicroFamilyId && Array.isArray(merged.definitionParts)
        ? merged.definitionParts
        : [],

    executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(executionMicroFamilyId),
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    fixedTaxonomyPreferred: true
  };
}

function normalizeExactTrueMicroRow(row = {}) {
  const trueMicroFamilyId = getTrueMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  if (!trueMicroFamilyId || !parsed.selectable) {
    return {
      ...row,
      exact75ChildTrueMicro: false,
      trueMicroFamilyId: null,
      microFamilyId: null,
      childTrueMicroFamilyId: null,
      parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
      exactTrueMicroMissingReason: 'EXACT_75_CHILD_TRUE_MICRO_REQUIRED'
    };
  }

  return {
    ...row,

    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: trueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    exact75ChildTrueMicro: true,
    fixedTaxonomyLearningId: true,

    ...taxonomyFlags({
      ...row,
      trueMicroFamilyId
    })
  };
}

function normalizeMarketRegime(value = '') {
  const text = upper(value);

  if (!text) return 'UNKNOWN';
  if (text.includes('SQUEEZE') || text.includes('COMPRESS')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('DIRECTION')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketTrendSide(value = '') {
  const side = normalizeTradeSide(value);

  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const text = upper(value);

  if (!text) return 'UNKNOWN';
  if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT')) return 'NEUTRAL';
  if (text.includes('BEAR')) return TARGET_TRADE_SIDE;
  if (text.includes('BULL')) return OPPOSITE_TRADE_SIDE;
  if (text.includes('RISK_OFF')) return TARGET_TRADE_SIDE;
  if (text.includes('RISK_ON')) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function extractMarketWeatherShape(weather = {}, universe = {}) {
  const source = weather && typeof weather === 'object' ? weather : {};
  const universeSource = universe && typeof universe === 'object' ? universe : {};

  const createdAt = safeNumber(
    source.createdAt ??
      source.completedAt ??
      source.updatedAt ??
      source.ts ??
      universeSource.createdAt ??
      universeSource.completedAt ??
      universeSource.updatedAt ??
      universeSource.ts,
    0
  );

  const regime = normalizeMarketRegime(
    source.currentRegime ??
      source.regime ??
      source.marketRegime ??
      source.breadthRegime ??
      source.volatilityRegime ??
      universeSource.currentRegime ??
      universeSource.regime
  );

  const trendSide = normalizeMarketTrendSide(
    source.currentTrendSide ??
      source.trendSide ??
      source.marketSide ??
      source.side ??
      source.direction ??
      source.breadthSide ??
      source.btcTrendSide ??
      universeSource.currentTrendSide ??
      universeSource.trendSide ??
      universeSource.marketSide
  );

  const bullishPct = firstFinite(
    source.bullishPct,
    source.longPct,
    source.upPct,
    source.breadthBullishPct,
    source.universeBullishPct,
    universeSource.bullishPct,
    universeSource.longPct,
    universeSource.upPct
  );

  const bearishPct = firstFinite(
    source.bearishPct,
    source.shortPct,
    source.downPct,
    source.breadthBearishPct,
    source.universeBearishPct,
    universeSource.bearishPct,
    universeSource.shortPct,
    universeSource.downPct
  );

  const squeezePct = firstFinite(
    source.squeezePct,
    source.compressionPct,
    source.breadthSqueezePct,
    universeSource.squeezePct,
    universeSource.compressionPct
  );

  const confidence = clampNumber(
    firstFinite(
      source.confidence,
      source.weatherConfidence,
      source.currentTrendConfidence,
      source.breadthConfidence,
      universeSource.confidence
    ) ?? 50,
    0,
    100
  );

  const stale = createdAt > 0
    ? (now() - createdAt) / 1000 > currentFitMaxWeatherAgeSec()
    : true;

  return {
    ok: Boolean(source && Object.keys(source).length),
    source,
    universe: universeSource,
    createdAt,
    ageSec: createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null,
    stale,
    regime,
    trendSide,
    bullishPct,
    bearishPct,
    squeezePct,
    confidence,
    key: MARKET_WEATHER_KEY,
    universeKey: MARKET_UNIVERSE_KEY
  };
}

async function readJsonFromAnyRedis(key, fallback = null) {
  const volatileRedis = getVolatileRedis();
  const durableRedis = getDurableRedis();

  const fromVolatile = await getJson(volatileRedis, key, null).catch(() => null);
  if (fromVolatile) return { value: fromVolatile, source: `VOLATILE:${key}` };

  const fromDurable = await getJson(durableRedis, key, null).catch(() => null);
  if (fromDurable) return { value: fromDurable, source: `DURABLE:${key}` };

  return { value: fallback, source: null };
}

async function loadMarketContext() {
  const [weather, universe] = await Promise.all([
    readJsonFromAnyRedis(MARKET_WEATHER_KEY, null),
    readJsonFromAnyRedis(MARKET_UNIVERSE_KEY, null)
  ]);

  return extractMarketWeatherShape(weather.value || {}, universe.value || {});
}

function scoreMarketFit(row = {}, marketContext = {}) {
  if (!marketContext?.ok || marketContext.stale) {
    return {
      currentFit: 'UNKNOWN',
      currentFitScore: 0,
      currentFitConfidence: 0,
      currentFitReason: !marketContext?.ok ? 'MARKET_WEATHER_UNAVAILABLE' : 'MARKET_WEATHER_STALE',
      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      currentFitBlocksVirtualLearning: false,
      currentFitBlocksShadowLearning: false,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
    };
  }

  const familyRegime = normalizeMarketRegime(row.regimeBucket || row.regime || row.regimeCoarse);
  const confirmation = upper(row.confirmationProfile);
  const marketRegime = marketContext.regime;
  const trendSide = marketContext.trendSide;

  let score = 0;
  const reasons = [];

  if (trendSide === TARGET_TRADE_SIDE) {
    score += 35;
    reasons.push('MARKET_TREND_SHORT');
  } else if (trendSide === 'NEUTRAL' || trendSide === 'UNKNOWN') {
    score += 4;
    reasons.push('MARKET_TREND_NEUTRAL_OR_UNKNOWN');
  } else {
    score -= 45;
    reasons.push('MARKET_TREND_AGAINST_SHORT');
  }

  if (familyRegime !== 'UNKNOWN' && marketRegime !== 'UNKNOWN') {
    if (familyRegime === marketRegime) {
      score += 25;
      reasons.push('FAMILY_REGIME_MATCH');
    } else if (
      (familyRegime === 'TREND' && marketRegime === 'SQUEEZE') ||
      (familyRegime === 'SQUEEZE' && marketRegime === 'TREND')
    ) {
      score += 8;
      reasons.push('FAMILY_REGIME_ADJACENT');
    } else {
      score -= 15;
      reasons.push('FAMILY_REGIME_MISMATCH');
    }
  }

  if (Number.isFinite(marketContext.bearishPct)) {
    if (marketContext.bearishPct >= 70) score += 20;
    else if (marketContext.bearishPct >= 60) score += 15;
    else if (marketContext.bearishPct >= 50) score += 8;
    else if (marketContext.bearishPct < 40) score -= 12;
  }

  if (Number.isFinite(marketContext.bullishPct) && marketContext.bullishPct >= 60) score -= 20;
  if (familyRegime === 'SQUEEZE' && Number.isFinite(marketContext.squeezePct) && marketContext.squeezePct >= 40) score += 10;

  if (confirmation === 'A_STRONG_ALIGN') score += 8;
  if (confirmation === 'B_FLOW_ALIGN') score += 5;
  if (confirmation === 'C_VOLUME_ALIGN') score += 3;
  if (confirmation === 'E_WEAK_CONTRA') score -= 18;

  const finalScore = clampNumber(score, -100, 100);
  const confidence = clampNumber(marketContext.confidence + Math.min(20, Math.abs(finalScore) / 2), 0, 100);

  let currentFit = 'NEUTRAL';
  if (finalScore >= 45) currentFit = 'MATCH';
  else if (finalScore >= 18) currentFit = 'WEAK_MATCH';
  else if (finalScore <= -25) currentFit = 'MISFIT';

  return {
    currentFit,
    currentFitScore: Number(finalScore.toFixed(4)),
    currentFitConfidence: Number(confidence.toFixed(2)),
    currentFitReason: reasons.join('|') || 'NO_CURRENT_FIT_REASON',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
}

function attachCurrentFitContext(row = {}, marketContext = {}) {
  const fit = scoreMarketFit(row, marketContext);

  return {
    ...row,

    currentMarketWeather: marketContext?.source || null,
    currentMarketUniverse: marketContext?.universe || null,
    currentMarketWeatherKey: MARKET_WEATHER_KEY,
    currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
    currentMarketWeatherAgeSec: marketContext?.ageSec ?? null,
    currentMarketWeatherStale: Boolean(marketContext?.stale),

    currentRegime: marketContext?.regime || 'UNKNOWN',
    currentTrendSide: marketContext?.trendSide || 'UNKNOWN',
    currentBullishPct: marketContext?.bullishPct ?? null,
    currentBearishPct: marketContext?.bearishPct ?? null,
    currentSqueezePct: marketContext?.squeezePct ?? null,

    entryMarketWeather: marketContext?.source || null,
    entryCurrentRegime: marketContext?.regime || 'UNKNOWN',
    entryCurrentTrendSide: marketContext?.trendSide || 'UNKNOWN',
    entryCurrentFit: fit.currentFit,
    entryCurrentFitConfidence: fit.currentFitConfidence,
    entryWeatherFitMatchedFamily: fit.currentFit === 'MATCH' || fit.currentFit === 'WEAK_MATCH',

    ...fit
  };
}

function discordCurrentFitGate(row = {}) {
  if (!discordRequiresCurrentFit()) {
    return {
      ok: true,
      reason: 'CURRENT_FIT_NOT_REQUIRED_BY_CONFIG',
      currentFit: row.currentFit || row.entryCurrentFit || 'NOT_REQUIRED',
      currentFitConfidence: safeNumber(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0)
    };
  }

  const fit = upper(row.currentFit || row.entryCurrentFit);
  const confidence = safeNumber(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);

  if (!fit || fit === 'UNKNOWN') {
    return {
      ok: false,
      reason: 'DISCORD_BLOCKED_CURRENT_FIT_UNKNOWN',
      currentFit: fit || 'UNKNOWN',
      currentFitConfidence: confidence
    };
  }

  if (confidence < discordMinCurrentFitConfidence()) {
    return {
      ok: false,
      reason: 'DISCORD_BLOCKED_CURRENT_FIT_CONFIDENCE_TOO_LOW',
      currentFit: fit,
      currentFitConfidence: confidence,
      minCurrentFitConfidence: discordMinCurrentFitConfidence()
    };
  }

  if (fit === 'MATCH' || fit === 'WEAK_MATCH') {
    return {
      ok: true,
      reason: 'DISCORD_CURRENT_FIT_OK',
      currentFit: fit,
      currentFitConfidence: confidence
    };
  }

  return {
    ok: false,
    reason: `DISCORD_BLOCKED_CURRENT_FIT_${fit}`,
    currentFit: fit,
    currentFitConfidence: confidence
  };
}

function hasValidRiskShape(row = {}) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);

  if (row.learningOnly === true) return false;
  if (inferRowTradeSide(row) !== TARGET_TRADE_SIDE) return false;
  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  return tp < entry && entry < sl;
}

function candidateFallbackPrice(row = {}, fallback = 0) {
  return safeNumber(
    row.price ??
      row.markPrice ??
      row.currentPrice ??
      row.lastPrice ??
      row.close ??
      row.entry,
    fallback
  );
}

function standardizedRiskMetrics(candidate = {}, reason = 'STANDARDIZED_SHORT_LEARNING_TP_SL') {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  const mid = candidateFallbackPrice(normalized, 0);

  if (mid <= 0 || !cfg.allowStandardizedLearningRiskFallback) {
    return {
      ...normalized,
      ...scannerMetadataFrom(normalized),
      ...sideFlags(),
      ...virtualFlags(normalized),
      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,
      riskPct: 0,
      rewardPct: 0,
      observationOnly: true,
      analysisInputOnly: true,
      learningOnly: true,
      liveRiskValid: false,
      liveEntryBlockedReason: mid <= 0 ? 'STANDARDIZED_SHORT_RISK_NO_PRICE' : 'STANDARDIZED_LEARNING_RISK_FALLBACK_DISABLED'
    };
  }

  const rr = Math.max(cfg.minRR, cfg.defaultRR, 0.5);
  const riskPct = clampNumber(
    cfg.fallbackRiskPct,
    Math.max(0.0005, cfg.minRiskPct),
    Math.max(cfg.minRiskPct, cfg.maxRiskPct)
  );

  const entry = mid;
  const sl = entry * (1 + riskPct);
  const tp = Math.max(entry * (1 - riskPct * rr), entry * 0.0001);
  const rewardPct = Math.max(0, (entry - tp) / entry);

  const row = {
    ...normalized,
    ...scannerMetadataFrom(normalized),
    ...sideFlags(),
    ...virtualFlags(normalized),

    price: mid,
    currentPrice: mid,
    lastPrice: mid,
    entry,
    sl,
    tp,
    rr,
    riskPct,
    rewardPct,

    spreadPct: safeNumber(
      normalized.spreadPct,
      CONFIG.short?.cost?.fallbackSpreadPct ??
        CONFIG.cost?.shortFallbackSpreadPct ??
        CONFIG.cost?.fallbackSpreadPct ??
        0.0008
    ),
    depthMinUsd1p: safeNumber(normalized.depthMinUsd1p, 0),
    fundingRate: safeNumber(normalized.fundingRate, 0),

    confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
    sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
    scannerScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
    moveScore: safeNumber(normalized.moveScore ?? normalized.scannerScore, 0),

    riskSource: 'LEARNING_STANDARDIZED_TP_SL',
    riskEngineRisk: false,
    standardizedLearningRisk: true,
    standardizedLearningRiskReason: reason,
    standardizedLearningRiskEntry: true,
    standardizedLearningRiskVirtualEntryAllowed: cfg.allowStandardizedLearningRiskVirtualEntries,

    syntheticRisk: false,
    syntheticRiskReason: null,

    observationOnly: false,
    analysisInputOnly: false,
    learningOnly: false,
    liveRiskValid: true,
    liveEntryBlockedReason: null,

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

    positionTimeStopMin: cfg.positionTimeStopMin,
    liveDataTs: now()
  };

  return {
    ...row,
    liveRiskValid: hasValidRiskShape(row)
  };
}

async function safeProcessCandidate(candidate) {
  const cfg = tradeConfig();

  try {
    const normalized = normalizeCandidate(candidate);

    const result = await withTimeout(
      Promise.resolve({
        actions: [],
        metrics: [standardizedRiskMetrics(normalized, 'VERCEL_SAFE_STANDARDIZED_SHORT_LEARNING_TP_SL')]
      }),
      cfg.candidateTimeoutMs,
      'CANDIDATE_PROCESS_TIMEOUT'
    );

    if (!isTimeoutResult(result)) return result;

    return {
      actions: [],
      metrics: [standardizedRiskMetrics(normalized, 'CANDIDATE_PROCESS_TIMEOUT_STANDARDIZED_LEARNING_TP_SL')],
      timedOut: true
    };
  } catch (error) {
    const normalized = normalizeCandidate(candidate);

    return {
      actions: [waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
        error: error?.message || String(error),
        learningFallbackAttempted: true
      })],
      metrics: [standardizedRiskMetrics(normalized, 'CANDIDATE_PROCESS_ERROR_STANDARDIZED_LEARNING_TP_SL')]
    };
  }
}

function waitAction(candidate, reason, extra = {}) {
  const tradeSide = inferRowTradeSide(candidate);

  return {
    action: 'WAIT',
    reason,
    symbol: candidate?.symbol || null,
    contractSymbol: candidate?.contractSymbol || null,
    side: tradeSide === TARGET_TRADE_SIDE ? TARGET_DASHBOARD_SIDE : candidate?.side || null,
    tradeSide,
    snapshotId: candidate?.snapshotId || null,
    scannerScore: candidate?.scannerScore ?? candidate?.moveScore ?? null,

    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,

    currentFit: candidate?.currentFit || candidate?.entryCurrentFit || null,
    currentFitScore: candidate?.currentFitScore ?? null,
    currentFitConfidence: candidate?.currentFitConfidence ?? candidate?.entryCurrentFitConfidence ?? null,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    ...sideFlags(),
    ...virtualFlags(candidate),
    ...isolationFlags(),

    ...extra
  };
}

function hasFullSnapshotShape(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.candidates));
}

function snapshotCreatedAt(snapshot = {}) {
  return safeNumber(
    snapshot.createdAt ||
      snapshot.completedAt ||
      snapshot.ts ||
      snapshot.scannerTs,
    0
  );
}

function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return latest.snapshotId || latest.id || latest.latestSnapshotId || latest.scanId || null;
  }

  return null;
}

function countTargetCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return rows.filter((candidate) => inferRowTradeSide(candidate) === TARGET_TRADE_SIDE).length;
}

function countOppositeCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return rows.filter((candidate) => inferRowTradeSide(candidate) === OPPOSITE_TRADE_SIDE).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];

  const targetRows = rows
    .filter((candidate) => inferRowTradeSide(candidate) === TARGET_TRADE_SIDE)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags(),
      ...virtualFlags(candidate)
    }));

  const blockedNonShortCandidates = rows
    .filter((candidate) => inferRowTradeSide(candidate) !== TARGET_TRADE_SIDE)
    .slice(0, 50)
    .map((candidate) => waitAction(
      normalizeCandidate(candidate),
      'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      {
        skippedBeforeAnalyze: true,
        skippedBeforeLiveFetch: true,
        detectedScannerSide: inferRowTradeSide(candidate)
      }
    ));

  return {
    ...snapshot,

    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: targetRows.length,
    selectedShortCandidateCount: targetRows.length,
    selectedOppositeCandidateCount: countOppositeCandidates(snapshot),
    selectedLongCandidateCount: countOppositeCandidates(snapshot),

    blockedNonShortCandidates,
    blockedNonShortCandidatesCount: rows.length - targetRows.length,

    blockedNonLongCandidates: blockedNonShortCandidates,
    blockedNonLongCandidatesCount: rows.length - targetRows.length,

    ...sideFlags(),
    ...isolationFlags(),
    ...virtualFlags(),

    candidates: targetRows,
    candidatesCount: targetRows.length,
    shortCandidatesCount: targetRows.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: targetRows.filter((row) => row.scannerGatePassed !== false).length,
    analyzeOnlyCandidatesCount: targetRows.filter((row) => row.tradeDiscoveryOnly || row.discoveryOnly || row.analyzeOnly).length,

    topSymbols: targetRows.slice(0, 20).map((row) => row.symbol).filter(Boolean),
    scannerGateSymbols: targetRows.filter((row) => row.scannerGatePassed !== false).slice(0, 20).map((row) => row.symbol).filter(Boolean)
  };
}

async function loadRecentTargetSnapshotsFromRedis(redis, label, limit = 8) {
  const pattern = namespacedShortKey(
    keyFromMaybeFunction(
      KEYS.short?.scan?.snapshot || KEYS.scan?.shortSnapshot || KEYS.scan?.snapshot,
      '*',
      'SCAN:SNAPSHOT:*'
    ),
    'SCAN:SNAPSHOT:*'
  );

  const keys = await getKeys(redis, pattern, limit).catch(() => []);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);
      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        key,
        label,
        snapshot,
        targetCount: countTargetCandidates(snapshot),
        oppositeCount: countOppositeCandidates(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return rows.filter(Boolean).sort((a, b) => {
    if (b.targetCount !== a.targetCount) return b.targetCount - a.targetCount;
    return b.createdAt - a.createdAt;
  });
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();
  const durableRedis = getDurableRedis();

  const stores = [
    { redis: volatileRedis, label: 'VOLATILE' },
    { redis: durableRedis, label: 'DURABLE' }
  ];

  for (const store of stores) {
    const latest = await safeGetSnapshotJson(store.redis, SHORT_KEYS.scan.latest, null);
    const latestSnapshotId = extractSnapshotId(latest);

    if (hasFullSnapshotShape(latest) && countTargetCandidates(latest) > 0) {
      return normalizeSelectedSnapshot(latest, {
        source: `${store.label}:SHORT:SCAN:LATEST_FULL_SNAPSHOT`,
        reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
      });
    }

    if (latestSnapshotId) {
      const byId = await safeGetSnapshotJson(store.redis, SHORT_KEYS.scan.snapshot(latestSnapshotId), null);

      if (hasFullSnapshotShape(byId) && countTargetCandidates(byId) > 0) {
        return normalizeSelectedSnapshot(byId, {
          source: `${store.label}:SHORT:SCAN:SNAPSHOT_BY_LATEST_ID`,
          reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
        });
      }
    }
  }

  const recentRows = [
    ...(await loadRecentTargetSnapshotsFromRedis(volatileRedis, 'VOLATILE', 8)),
    ...(await loadRecentTargetSnapshotsFromRedis(durableRedis, 'DURABLE', 8))
  ].sort((a, b) => {
    if (b.targetCount !== a.targetCount) return b.targetCount - a.targetCount;
    return b.createdAt - a.createdAt;
  });

  const best = recentRows.find((row) => row.targetCount > 0) || recentRows[0] || null;

  if (!best?.snapshot) return null;

  return normalizeSelectedSnapshot(best.snapshot, {
    source: `${best.label}:SHORT:SCAN:RECENT_SEARCH:${best.key}`,
    reason: best.targetCount > 0
      ? 'LATEST_SHORT_SCANNER_SNAPSHOT'
      : 'LATEST_SHORT_SCANNER_SNAPSHOT_WITH_NO_SHORT_CANDIDATES'
  });
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
          return value.split(/[\s,;\n\r]+/g).map((part) => part.trim());
        }

        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function parentContextIds(row = {}) {
  return uniqueStrings([
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    parentIdFromChild(getTrueMicroFamilyId(row))
  ])
    .map((id) => cleanLearningFamilyId(id, row))
    .filter((id) => isParentTrueMicroId(id));
}

function buildSelectedAlertContext(activeRotation) {
  const rawRows = Array.isArray(activeRotation?.microFamilies) ? activeRotation.microFamilies : [];
  const rowByMicroId = new Map();

  for (const row of rawRows) {
    const normalized = normalizeExactTrueMicroRow(row);
    const childId = getTrueMicroFamilyId(normalized);

    if (childId) rowByMicroId.set(childId, normalized);
  }

  const configuredIds = uniqueStrings([
    activeRotation?.microFamilyIds || [],
    activeRotation?.activeMicroFamilyIds || [],
    activeRotation?.trueMicroFamilyIds || [],
    activeRotation?.childTrueMicroFamilyIds || [],
    activeRotation?.ids || [],
    rawRows.map(getTrueMicroFamilyId)
  ]);

  const selectedMicroFamilyIds = uniqueStrings(
    configuredIds
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter((id) => isSelectableTrueMicroId(id))
  );

  const selectedMicroSet = new Set(selectedMicroFamilyIds);

  const selectedParentTrueMicroFamilyIds = uniqueStrings([
    activeRotation?.parentTrueMicroFamilyIds || [],
    activeRotation?.parentMicroFamilyIds || [],
    activeRotation?.macroFamilyIds || [],
    activeRotation?.activeMacroFamilyIds || [],
    selectedMicroFamilyIds.map(parentIdFromChild),
    rawRows.flatMap(parentContextIds)
  ])
    .map((id) => cleanLearningFamilyId(id, {}))
    .filter((id) => isParentTrueMicroId(id));

  return {
    rotationId: activeRotation?.rotationId || null,
    selectedRotation: activeRotation || null,
    selectedMicroFamilyIds,
    selectedTrueMicroFamilyIds: selectedMicroFamilyIds,
    selectedChildTrueMicroFamilyIds: selectedMicroFamilyIds,
    selectedMicroSet,
    selectedParentTrueMicroFamilyIds,
    selectedMacroFamilyIds: [],
    rowByMicroId,
    empty: !selectedMicroFamilyIds.length,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,
    selectionPurpose: 'DISCORD_ALERT_ONLY',
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    ...sideFlags(),
    ...taxonomyFlags(),
    ...isolationFlags()
  };
}

function rowMatchesSelectedAlertMicro(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) return false;
  const exactTrueMicroId = getTrueMicroFamilyId(row);
  if (!exactTrueMicroId || !isSelectableTrueMicroId(exactTrueMicroId)) return false;
  return alertContext.selectedMicroSet.has(exactTrueMicroId);
}

function getSelectedWeeklyStats(alertContext, microFamilyId, row = {}) {
  if (!alertContext) return null;

  const exactId = getTrueMicroFamilyId({
    ...row,
    trueMicroFamilyId: microFamilyId || row.trueMicroFamilyId
  });

  if (!exactId) return null;

  return alertContext.rowByMicroId.get(exactId) || null;
}

function setupFromRow(row = {}) {
  const existing = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      ''
  );

  if (existing.setup && SHORT_FIXED_SETUP_TYPES.has(existing.setup)) return existing.setup;

  const text = upper([
    row.scannerReason,
    row.reason,
    row.scannerFamilyId,
    row.scannerMicroFamilyId,
    row.scannerDefinition,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(row.scannerDefinitionParts) ? row.scannerDefinitionParts : []),
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].filter(Boolean).join('|'));

  if (text.includes('BREAKOUT') || text.includes('BREAKDOWN') || text.includes('VALID_BREAKDOWN')) return 'BREAKOUT';
  if (text.includes('SWEEP')) return 'SWEEP_REVERSAL';
  if (text.includes('RETEST') || text.includes('PULLBACK')) return 'RETEST';
  if (text.includes('SQUEEZE') || text.includes('COMPRESSION') || text.includes('COMPRESS')) return 'COMPRESSION';
  if (text.includes('CONTINUATION') || text.includes('MOMENTUM') || text.includes('EXPANSION')) return 'CONTINUATION';

  return 'CONTINUATION';
}

function regimeFromRow(row = {}, marketContext = {}) {
  const existing = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      ''
  );

  if (existing.regime && SHORT_FIXED_REGIME_BUCKETS.has(existing.regime)) return existing.regime;

  const direct = normalizeMarketRegime(
    row.regimeBucket ||
      row.currentRegime ||
      row.regime ||
      row.btcRegime ||
      marketContext.regime
  );

  if (direct !== 'UNKNOWN') return direct;

  return 'TREND';
}

function confirmationFromRow(row = {}, marketContext = {}) {
  const existing = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      ''
  );

  if (existing.confirmationProfile && SHORT_CONFIRMATION_PROFILES.has(existing.confirmationProfile)) {
    return existing.confirmationProfile;
  }

  const text = upper([
    row.scannerReason,
    row.reason,
    row.scannerDefinition,
    row.definition,
    row.microDefinition,
    ...(Array.isArray(row.scannerDefinitionParts) ? row.scannerDefinitionParts : []),
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].filter(Boolean).join('|'));

  const fitScore = safeNumber(row.currentFitScore ?? row.entryCurrentFitScore, 0);
  const fitConfidence = safeNumber(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);
  const scannerScore = safeNumber(row.scannerScore ?? row.moveScore, 0);
  const volumeExpansion = safeNumber(row.volumeExpansion, 0);

  if (text.includes('FAKE_RISK') || row.fakeBreakoutRisk === true || fitScore < -20) return 'E_WEAK_CONTRA';
  if (fitScore >= 45 && fitConfidence >= 50 && scannerScore >= 70) return 'A_STRONG_ALIGN';
  if (fitScore >= 20 || marketContext?.trendSide === TARGET_TRADE_SIDE) return 'B_FLOW_ALIGN';
  if (volumeExpansion >= 1.4 || text.includes('VOL_EXP')) return 'C_VOLUME_ALIGN';
  if (text.includes('WEAK') || text.includes('CONTRA')) return 'E_WEAK_CONTRA';

  return 'D_MIXED_OK';
}

function fallbackExact75Id(row = {}, marketContext = {}) {
  const existing = getTrueMicroFamilyId(row);
  if (existing) return existing;

  const setup = setupFromRow(row);
  const regime = regimeFromRow(row, marketContext);
  const confirmation = confirmationFromRow(row, marketContext);

  return `MICRO_SHORT_${setup}_${regime}_${confirmation}`;
}

function assignFallbackExact75(row = {}, marketContext = {}, reason = 'FALLBACK_EXACT_75_ASSIGNED') {
  const trueMicroFamilyId = fallbackExact75Id(row, marketContext);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  if (!parsed.selectable) {
    return normalizeExactTrueMicroRow(row);
  }

  return normalizeExactTrueMicroRow({
    ...row,
    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    fallbackExact75: true,
    fallbackExact75Reason: reason,
    exact75FallbackSource: 'TRADE_SYSTEM_RUNTIME_BUDGET_SAFE_FALLBACK'
  });
}

function symbolKey(value = '') {
  const base = normalizeBaseSymbol(value);
  const contract = normalizeContractSymbol(value);
  const token = normalizeSymbolToken(value);

  return normalizeSymbolToken(base || contract || token);
}

function rowSymbolKeys(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .flatMap((value) => symbolTokensFromAnySymbol(value))
    .map(symbolKey)
    .filter(Boolean);
}

function buildOpenSymbolSet(openPositions = []) {
  const set = new Set();

  for (const position of Array.isArray(openPositions) ? openPositions : []) {
    for (const key of rowSymbolKeys(position)) {
      if (key) set.add(key);
    }
  }

  return set;
}

function hasOpenSymbol(openSymbolSet, row = {}) {
  for (const key of rowSymbolKeys(row)) {
    if (openSymbolSet.has(key)) return true;
  }

  return false;
}

function rememberOpenSymbol(openSymbolSet, row = {}) {
  for (const key of rowSymbolKeys(row)) {
    if (key) openSymbolSet.add(key);
  }
}

function validateVirtualEntry(row = {}) {
  const cfg = tradeConfig();
  const tradeSide = inferRowTradeSide(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(row);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      tradeSide
    };
  }

  if (!trueMicroFamilyId) {
    return {
      ok: false,
      reason: 'ANALYZE_EXACT_75_CHILD_TRUE_MICRO_FAMILY_REQUIRED'
    };
  }

  if (!isSelectableTrueMicroId(trueMicroFamilyId)) {
    return {
      ok: false,
      reason: 'ENTRY_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY'
    };
  }

  if (isScannerFingerprintId(trueMicroFamilyId)) {
    return {
      ok: false,
      reason: 'SCANNER_FINGERPRINT_METADATA_ONLY'
    };
  }

  if (isExecutionFingerprintId(trueMicroFamilyId)) {
    return {
      ok: false,
      reason: 'EXECUTION_FINGERPRINT_METADATA_ONLY'
    };
  }

  if (row.standardizedLearningRisk && !cfg.allowStandardizedLearningRiskVirtualEntries) {
    return {
      ok: false,
      reason: 'STANDARDIZED_LEARNING_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING',
      standardizedLearningRisk: true,
      riskSource: row.riskSource || null
    };
  }

  if (!hasValidRiskShape(row)) {
    return {
      ok: false,
      reason: row.liveEntryBlockedReason || 'SHORT_RISK_INVALID'
    };
  }

  return {
    ok: true,
    reason: row.standardizedLearningRisk
      ? 'SHORT_VIRTUAL_LEARNING_STANDARDIZED_TP_SL'
      : row.syntheticRisk
        ? 'SHORT_VIRTUAL_RISK_VALID_SYNTHETIC_EXPLICITLY_ENABLED'
        : 'SHORT_VIRTUAL_RISK_ENGINE_VALID'
  };
}

function buildVirtualEntryAction({
  row,
  alertContext,
  selectedWeeklyStats,
  riskFraction,
  virtualGate,
  selectedExactMicroMatch,
  discordAlertEligible
}) {
  const normalized = normalizeExactTrueMicroRow(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(normalized);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(normalized);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);
  const currentFitGate = discordCurrentFitGate(row);
  const finalDiscordAlertEligible = Boolean(discordAlertEligible && currentFitGate.ok);

  return {
    ...normalized,

    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,

    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    familyId: trueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    ...scannerMetadataFrom(row),
    ...sideFlags(),
    ...virtualFlags({
      ...row,
      trueMicroFamilyId
    }),
    ...isolationFlags(),

    action: 'VIRTUAL_ENTRY',
    reason: virtualGate.reason || 'SHORT_VIRTUAL_LEARNING_STANDARDIZED_TP_SL',
    shadowOnly: false,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,

    selectedMicroFamilyAlert: Boolean(finalDiscordAlertEligible),
    selectedExactMicroMatch: Boolean(selectedExactMicroMatch),
    discordAlertEligible: Boolean(finalDiscordAlertEligible),
    discordCurrentFitGate: currentFitGate,
    discordAlertReason: finalDiscordAlertEligible
      ? 'SELECTED_SHORT_TRUE_MICRO_FAMILY_EXACT_75_CHILD_MATCH_AND_CURRENT_FIT_OK'
      : !selectedExactMicroMatch
        ? alertContext.empty
          ? 'NO_MANUAL_75_CHILD_TRUE_MICRO_FAMILY_SELECTED'
          : 'TRUE_MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
        : currentFitGate.reason || 'CURRENT_FIT_BLOCKED_DISCORD_ALERT',

    selectedMacroFamilyId: null,
    activeMacroFamilyId: null,
    selectedParentTrueMicroFamilyId: parentTrueMicroFamilyId,
    activeParentTrueMicroFamilyId: parentTrueMicroFamilyId,

    selectedWeeklyStats,
    weeklyStats: selectedWeeklyStats,
    riskFraction,
    virtualGate,

    liveEligible: Boolean(finalDiscordAlertEligible),
    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

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
    positionTimeStopMin: tradeConfig().positionTimeStopMin,

    entryMarketWeather: row.entryMarketWeather || row.currentMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide || null,
    entryCurrentFit: row.entryCurrentFit || row.currentFit || null,
    entryCurrentFitConfidence: row.entryCurrentFitConfidence ?? row.currentFitConfidence ?? null,
    entryWeatherFitMatchedFamily: row.entryWeatherFitMatchedFamily ?? (row.currentFit === 'MATCH' || row.currentFit === 'WEAK_MATCH'),

    currentMarketWeather: row.currentMarketWeather || null,
    currentMarketWeatherAgeSec: row.currentMarketWeatherAgeSec ?? null,
    currentMarketWeatherStale: Boolean(row.currentMarketWeatherStale),
    currentFit: row.currentFit || row.entryCurrentFit || null,
    currentFitScore: row.currentFitScore ?? null,
    currentFitConfidence: row.currentFitConfidence ?? row.entryCurrentFitConfidence ?? null,
    currentFitReason: row.currentFitReason || null,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    entryCreatedAt: now()
  };
}

function buildDiscordEntryAlertPayload(entry = {}) {
  const microId = upper(
    entry.trueMicroFamilyId ||
      entry.childTrueMicroFamilyId ||
      entry.microFamilyId ||
      entry.analyzeMicroFamilyId ||
      entry.learningMicroFamilyId
  );

  const rotationId =
    entry.activeRotationId ||
    entry.rotationId ||
    entry.selectedRotationId ||
    `manual_${PERSISTENT_LEARNING_KEY}`;

  return {
    ...entry,

    action: 'ENTRY',

    source: 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    positionSource: 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    paperTrade: true,
    paperPosition: true,

    observationOnly: false,
    analysisInputOnly: false,
    learningOnly: false,
    analyzeOnly: false,
    discoveryOnly: false,
    tradeDiscoveryOnly: false,
    scannerOnly: false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    liveOrder: false,
    orderPlaced: false,

    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    signalSide: TARGET_TRADE_SIDE,
    entrySide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    entry: entry.entry,
    entryPrice: entry.entry,

    tp: entry.tp,
    takeProfit: entry.tp,
    target: entry.tp,
    targetPrice: entry.tp,

    sl: entry.sl ?? entry.initialSl,
    initialSl: entry.sl ?? entry.initialSl,
    stopLoss: entry.sl ?? entry.initialSl,
    stop: entry.sl ?? entry.initialSl,
    stopPrice: entry.sl ?? entry.initialSl,

    trueMicroFamilyId: microId,
    childTrueMicroFamilyId: microId,
    microFamilyId: microId,
    analyzeMicroFamilyId: microId,
    learningMicroFamilyId: microId,

    rotationId,
    activeRotationId: rotationId,
    selectedRotationId: rotationId,

    rotationMatchType: 'EXACT_75_CHILD_TRUE_MICRO',
    matchType: 'EXACT_75_CHILD_TRUE_MICRO',

    discordAlertEligible: true,
    selectedForDiscord: true,
    liveEligible: true,

    selectedTrueMicroFamilyId: microId,
    selectedMicroFamilyId: microId,
    activeTrueMicroFamilyId: microId,
    activeMicroFamilyId: microId,

    selectedTrueMicroFamilyIds: [microId],
    selectedMicroFamilyIds: [microId],
    activeTrueMicroFamilyIds: [microId],
    activeMicroFamilyIds: [microId],
    trueMicroFamilyIds: [microId],
    childTrueMicroFamilyIds: [microId],
    microFamilyIds: [microId],

    discordPayloadSanitizedForEntryAlert: true
  };
}

async function maybeSendDiscordEntryAlert(entry = {}, cfg = tradeConfig()) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: entry.discordAlertReason || 'TRUE_MICRO_FAMILY_NOT_SELECTED_OR_CURRENT_FIT_BLOCKED'
    };
  }

  const discordPayload = buildDiscordEntryAlertPayload(entry);

  const timeoutMs = Math.min(
    Math.max(cfg.savePositionTimeoutMs || DEFAULT_SAVE_POSITION_TIMEOUT_MS, 500),
    2500
  );

  const result = await withTimeout(
    sendEntryAlert(discordPayload),
    timeoutMs,
    'DISCORD_ENTRY_ALERT_TIMEOUT'
  );

  if (isTimeoutResult(result)) {
    return {
      sent: false,
      skipped: false,
      failed: true,
      queued: false,
      awaited: true,
      fireAndForget: false,
      reason: 'DISCORD_ENTRY_ALERT_TIMEOUT',
      result
    };
  }

  if (result?.skipped) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: true,
      fireAndForget: false,
      reason: result.reason || 'DISCORD_ENTRY_ALERT_SKIPPED_BY_DISCORD_FILTER',
      result
    };
  }

  if (result?.ok) {
    return {
      sent: true,
      skipped: false,
      queued: false,
      awaited: true,
      fireAndForget: false,
      reason: 'DISCORD_ENTRY_ALERT_SENT',
      result
    };
  }

  return {
    sent: false,
    skipped: false,
    failed: true,
    queued: false,
    awaited: true,
    fireAndForget: false,
    reason: result?.error || result?.reason || 'DISCORD_ENTRY_ALERT_FAILED',
    result
  };
}

function buildVirtualExitAction(outcome = {}) {
  const trueMicroFamilyId = getTrueMicroFamilyId(outcome);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(outcome);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  return {
    action: 'VIRTUAL_EXIT',
    reason: outcome.exitReason || outcome.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    symbol: outcome.symbol || null,
    contractSymbol: outcome.contractSymbol || null,

    microFamilyId: trueMicroFamilyId || null,
    trueMicroFamilyId: trueMicroFamilyId || null,
    childTrueMicroFamilyId: trueMicroFamilyId || null,
    parentTrueMicroFamilyId: parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: parentTrueMicroFamilyId || null,

    setupType: parsed.setup || outcome.setupType || null,
    regimeBucket: parsed.regime || outcome.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || outcome.confirmationProfile || null,

    exact75ChildTrueMicro: Boolean(trueMicroFamilyId),
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    exitReason: outcome.exitReason || null,
    exitPrice: outcome.exitPrice ?? null,
    grossR: outcome.grossR ?? outcome.realizedGrossR ?? outcome.shortGrossR ?? null,
    netR: outcome.netR ?? outcome.realizedR ?? outcome.r ?? null,
    realizedR: outcome.realizedR ?? outcome.netR ?? outcome.r ?? null,
    costR: outcome.costR ?? null,
    avgCostR: outcome.avgCostR ?? outcome.costR ?? null,

    currentPrice: outcome.currentPrice ?? outcome.lastPrice ?? outcome.exitPrice ?? null,
    lastPrice: outcome.lastPrice ?? outcome.currentPrice ?? outcome.exitPrice ?? null,
    entry: outcome.entry ?? null,
    sl: outcome.sl ?? null,
    tp: outcome.tp ?? null,
    ageSec: outcome.ageSec ?? null,
    currentR: outcome.currentR ?? outcome.shortCurrentR ?? null,

    tpHitNow: Boolean(outcome.tpHitNow || outcome.shortTpHit || outcome.exitReason === 'TP'),
    slHitNow: Boolean(outcome.slHitNow || outcome.shortSlHit || outcome.exitReason === 'SL'),
    timeStopHitNow: Boolean(outcome.timeStopHitNow || outcome.exitReason === 'TIME_STOP'),

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    discordExitAlertSent: Boolean(outcome.discordExitAlertSent),

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,

    ...sideFlags(),
    ...virtualFlags(outcome),
    ...isolationFlags()
  };
}

function buildVirtualExitActions(exits = []) {
  return (Array.isArray(exits) ? exits : []).filter(Boolean).map(buildVirtualExitAction);
}

function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildRunActionCounts(actions = [], virtualExits = []) {
  return actionCounts([
    ...(Array.isArray(actions) ? actions : []),
    ...buildVirtualExitActions(virtualExits)
  ]);
}

function reasonCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.reason || row?.liveEntryBlockedReason || 'UNKNOWN_REASON';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function topReasonCounts(actions = [], limit = 12) {
  return Object.entries(reasonCounts(actions))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function inferPrimaryBottleneck({
  candidates,
  processed,
  liveRows,
  riskValidRows,
  analyzedRows,
  analyzedRiskValidRows,
  analyzedExact75Rows,
  virtualCreatedRows,
  virtualExitRows,
  waitRows,
  skippedByExistingSymbol,
  openPositionCountAfterEntries
}) {
  if (candidates <= 0) return 'NO_SHORT_CANDIDATES';
  if (processed <= 0) return 'NO_CANDIDATES_PROCESSED';
  if (liveRows <= 0) return 'NO_LIVE_ROWS_OR_NO_FALLBACK_PRICE';
  if (riskValidRows <= 0) return 'NO_TP_SL_AVAILABLE_FOR_SCANNER_WIDE_VIRTUAL_LEARNING';
  if (analyzedRows <= 0) return 'ANALYZE_RETURNED_NO_SHORT_ROWS';
  if (analyzedRiskValidRows <= 0) return 'ANALYZE_DID_NOT_RETURN_RISK_VALID_ROWS';
  if (analyzedExact75Rows <= 0) return 'ANALYZE_DID_NOT_ASSIGN_EXACT_75_CHILD_TRUE_MICRO_FAMILY';
  if (virtualCreatedRows <= 0 && skippedByExistingSymbol > 0) return 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION';
  if (virtualCreatedRows <= 0 && waitRows > 0) return 'VIRTUAL_ENTRY_GATE_WAIT_REASONS';
  if (virtualCreatedRows <= 0) return 'VIRTUAL_ENTRY_GATE_OR_SYMBOL_ALREADY_OPEN';
  if (virtualCreatedRows > 0 && virtualExitRows <= 0 && openPositionCountAfterEntries > 0) return 'POSITIONS_OPEN_WAITING_FOR_TP_SL_OR_TIME_STOP';
  if (virtualCreatedRows > 0 && virtualExitRows > 0) return 'HEALTHY_SHORT_75_CHILD_LEARNING_PIPELINE';
  return 'PIPELINE_ACTIVE_MONITOR_REQUIRED';
}

function buildQualityAudit({
  snapshot,
  candidates,
  processed,
  liveRows,
  analyzedRowsRaw,
  analyzedRows,
  actions,
  virtualExits,
  counts,
  openPositionCountBeforeEntries,
  openPositionCountAfterEntries,
  marketContext,
  runtimeWarnings = []
}) {
  const candidateCount = candidates.length;
  const processedCount = processed.length;
  const liveRowsCount = liveRows.length;
  const analyzedRowsRawCount = analyzedRowsRaw.length;
  const analyzedRowsCount = analyzedRows.length;

  const virtualExitRows = virtualExits.length;
  const riskValidRows = counts.riskValidRows;
  const analyzedRiskValidRows = counts.analyzedRiskValidRows;
  const analyzedExact75Rows = counts.analyzedExact75Rows;
  const entryRows = counts.entryRows;
  const virtualCreatedRows = counts.virtualCreatedRows;
  const waitRows = counts.waitRows;
  const skippedByExistingSymbol = counts.skippedByExistingSymbol || 0;

  const primaryBottleneck = inferPrimaryBottleneck({
    candidates: candidateCount,
    processed: processedCount,
    liveRows: liveRowsCount,
    riskValidRows,
    analyzedRows: analyzedRowsCount,
    analyzedRiskValidRows,
    analyzedExact75Rows,
    virtualCreatedRows,
    virtualExitRows,
    waitRows,
    skippedByExistingSymbol,
    openPositionCountAfterEntries
  });

  return {
    profile: QUALITY_MEASUREMENT_PROFILE,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    trueMicroSchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: true,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    discordMinCurrentFitConfidence: discordMinCurrentFitConfidence(),
    completedIsPureClosedVirtualOutcome: true,
    completedComesOnlyFrom: 'TP_SL_OR_TIME_STOP',
    scoringRSource: 'netR',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,
    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL,
      activeLearning: MIN_COMPLETED_ACTIVE_LEARNING
    },
    marketWeather: {
      available: Boolean(marketContext?.ok),
      key: MARKET_WEATHER_KEY,
      universeKey: MARKET_UNIVERSE_KEY,
      ageSec: marketContext?.ageSec ?? null,
      stale: Boolean(marketContext?.stale),
      regime: marketContext?.regime || 'UNKNOWN',
      trendSide: marketContext?.trendSide || 'UNKNOWN',
      bullishPct: marketContext?.bullishPct ?? null,
      bearishPct: marketContext?.bearishPct ?? null,
      squeezePct: marketContext?.squeezePct ?? null,
      confidence: marketContext?.confidence ?? null
    },
    snapshot: {
      snapshotId: snapshot?.snapshotId || null,
      selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
      selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount || 0,
      selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0
    },
    pipelineCounts: {
      candidates: candidateCount,
      processed: processedCount,
      liveRows: liveRowsCount,
      riskValidRows,
      analyzedRowsRaw: analyzedRowsRawCount,
      analyzedRows: analyzedRowsCount,
      analyzedRiskValidRows,
      analyzedExact75Rows,
      fallbackExact75Rows: counts.fallbackExact75Rows || 0,
      entryRows,
      virtualCreatedRows,
      virtualExitRows,
      waitRows,
      skippedByExistingSymbol,
      selectedAlertMicroMatches: counts.selectedAlertMicroMatches || 0,
      discordCurrentFitBlockedRows: counts.discordCurrentFitBlockedRows || 0,
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries
    },
    conversionRatesPct: {
      processedPerCandidate: pct(processedCount, candidateCount),
      liveRowsPerCandidate: pct(liveRowsCount, candidateCount),
      riskValidPerLiveRow: pct(riskValidRows, liveRowsCount),
      analyzedPerLiveRow: pct(analyzedRowsCount, liveRowsCount),
      analyzedRiskValidPerAnalyzed: pct(analyzedRiskValidRows, analyzedRowsCount),
      analyzedExact75PerAnalyzedRiskValid: pct(analyzedExact75Rows, analyzedRiskValidRows),
      virtualCreatedPerExact75: pct(virtualCreatedRows, analyzedExact75Rows),
      virtualExitPerCreatedThisRun: pct(virtualExitRows, virtualCreatedRows)
    },
    runtimeWarnings,
    primaryBottleneck,
    topWaitReasons: topReasonCounts(actions, 12),
    measurementPrinciple: 'Alles bearish van scanner virtueel laten leren; Discord alleen voor exact geselecteerde bewezen 75-child trueMicroFamilyIds met geldige CurrentFit.'
  };
}

async function scopedSetJson(redis, key, value, options = {}) {
  try {
    assertKeyAllowedForWriteScope(KEYS.scopes?.TRADE_RUN || 'TRADE_RUN', key);
  } catch (error) {
    if (!String(key || '').startsWith(SHORT_KEY_PREFIX)) throw error;
  }

  return setJson(redis, key, value, options);
}

function compactMarketWeather(value) {
  if (!value || typeof value !== 'object') return value;

  const {
    rows,
    universe,
    symbols,
    tickers,
    candidates,
    ...rest
  } = value;

  return {
    ...rest,
    rowsOmittedForRedis: Array.isArray(rows),
    symbolsOmittedForRedis: Array.isArray(symbols),
    compactedForRedis: true
  };
}

function compactRunForRedis(result = {}) {
  if (!result || typeof result !== 'object') return result;

  const {
    actions,
    virtualActions,
    entryRowsList,
    waitRowsList,
    virtualCreatedRowsList,
    virtualExits,
    shadowExits,
    exits,
    realExits,
    currentMarketUniverse,
    currentMarketWeather,
    marketContext,
    ...rest
  } = result;

  return {
    ...rest,
    actions: [],
    virtualActions: [],
    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    exits: [],
    realExits: [],
    currentMarketUniverse: null,
    currentMarketWeather: compactMarketWeather(currentMarketWeather),
    marketContext: marketContext
      ? {
          ...marketContext,
          source: compactMarketWeather(marketContext.source),
          universe: null,
          compactedForRedis: true
        }
      : null,
    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };
}

async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();
  const completedAt = now();

  const virtualExits = Array.isArray(result.virtualExits)
    ? result.virtualExits
    : Array.isArray(result.shadowExits)
      ? result.shadowExits
      : [];

  const finalResult = {
    ok: true,
    ...result,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      scanLatest: SHORT_KEYS.scan.latest,
      tradeRunMeta: SHORT_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
      marketWeather: MARKET_WEATHER_KEY,
      marketUniverse: MARKET_UNIVERSE_KEY
    },
    virtualExits,
    shadowExits: Array.isArray(result.shadowExits) ? result.shadowExits : virtualExits,
    realExits: [],
    virtualExitRows: virtualExits.length,
    shadowExitRows: virtualExits.length,
    realExitRows: 0,
    skipReason: result.skipReason || result.reason || null,
    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts: result.actionCounts || buildRunActionCounts(result.actions || [], virtualExits),
    rawResultOk: true,
    persistedAt: completedAt,
    persistedBy: 'src/trade/tradeSystem.js',
    persistedNamespace: SHORT_NAMESPACE
  };

  await scopedSetJson(durableRedis, SHORT_KEYS.trade.runMeta, compactRunForRedis(finalResult)).catch(() => null);

  if (finalResult.snapshotId) {
    await scopedSetJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, {
      snapshotId: finalResult.snapshotId,
      runId: finalResult.runId || null,
      processedAt: completedAt,
      snapshotCreatedAt: finalResult.snapshotCreatedAt || null,
      selectedSnapshotSource: finalResult.selectedSnapshotSource || null,
      selectedTargetCandidateCount: finalResult.selectedTargetCandidateCount || 0,
      entryRows: finalResult.entryRows || 0,
      waitRows: finalResult.waitRows || 0,
      virtualCreatedRows: finalResult.virtualCreatedRows || 0,
      virtualExitRows: finalResult.virtualExitRows || 0,
      discordAlertsSent: finalResult.discordAlertsSent || 0,
      discordAlertsFailed: finalResult.discordAlertsFailed || 0,
      reason: finalResult.reason || null,
      runtimeWarnings: Array.isArray(finalResult.runtimeWarnings) ? finalResult.runtimeWarnings : [],
      compactedForRedis: true,
      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags()
    }).catch(() => null);
  }

  return finalResult;
}

function baseEarlyReturnPayload({
  runId,
  startedAt,
  snapshot,
  actions = [],
  realExits = [],
  virtualExits = [],
  shadowExits = [],
  reason,
  runtimeWarnings = [],
  marketContext = {},
  processScannerSnapshot = false,
  priceHints = new Map(),
  extra = {}
}) {
  const cfg = tradeConfig();

  return {
    runId,
    startedAt,
    snapshotId: snapshot?.snapshotId || null,
    selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
    selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
    selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0,
    selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount || 0,
    selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0,
    blockedNonShortCandidatesCount: snapshot?.blockedNonShortCandidatesCount || 0,
    blockedNonLongCandidatesCount: snapshot?.blockedNonLongCandidatesCount || 0,
    actions,
    virtualActions: actions,
    realExits,
    virtualExits,
    shadowExits,
    entryRows: 0,
    waitRows: actions.length,
    virtualCreatedRows: 0,
    skippedNewEntries: true,
    reason,
    runtimeWarnings,
    actionCounts: buildRunActionCounts(actions, virtualExits),
    marketContext,
    currentMarketWeather: marketContext?.source || null,
    currentMarketUniverse: null,
    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot,
    monitorPriceHintCount: priceHints.size,
    monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
    monitorPriceSource: cfg.monitorLivePriceFetchEnabled
      ? 'LIVE_BITGET_TICKER_FIRST_THEN_SCANNER_SNAPSHOT_HINTS'
      : 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    ...extra
  };
}

function priceFromSnapshotRow(row = {}) {
  return safeNumber(
    row.currentPrice ??
      row.markPrice ??
      row.lastPrice ??
      row.price ??
      row.close ??
      row.entry,
    0
  );
}

function buildSnapshotPriceHints(snapshot = {}) {
  const hints = new Map();
  const rows = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];

  for (const row of rows) {
    const price = priceFromSnapshotRow(row);
    if (price <= 0) continue;

    const keys = [
      ...symbolTokensFromAnySymbol(row.symbol),
      ...symbolTokensFromAnySymbol(row.baseSymbol),
      ...symbolTokensFromAnySymbol(row.contractSymbol)
    ];

    for (const key of keys) {
      if (key && !hints.has(key)) hints.set(key, price);
    }
  }

  return hints;
}

function priceHintForSymbol(symbol, priceHints = new Map()) {
  for (const key of symbolTokensFromAnySymbol(symbol)) {
    const value = safeNumber(priceHints.get(key), 0);
    if (value > 0) return value;
  }

  return 0;
}

function normalizeBitgetSymbol(symbol = '') {
  const contract = normalizeContractSymbol(symbol);
  const base = normalizeBaseSymbol(symbol || contract);
  const raw = String(contract || symbol || base || '').trim().toUpperCase();

  if (!raw) return '';

  const cleaned = raw
    .replace(/[^A-Z0-9]/g, '')
    .replace(/USDTM$/u, 'USDT')
    .replace(/PERP$/u, '')
    .replace(/SWAP$/u, '');

  if (cleaned.endsWith('USDT')) return cleaned;

  return `${base || cleaned}USDT`;
}

function livePriceCacheKey(symbol = '') {
  return normalizeBitgetSymbol(symbol);
}

function getCachedLivePrice(symbol = '') {
  const key = livePriceCacheKey(symbol);
  if (!key) return 0;

  const cached = livePriceCache.get(key);
  if (!cached) return 0;

  if (now() - safeNumber(cached.ts, 0) > LIVE_PRICE_CACHE_TTL_MS) {
    livePriceCache.delete(key);
    return 0;
  }

  return safeNumber(cached.price, 0);
}

function setCachedLivePrice(symbol = '', price = 0) {
  const key = livePriceCacheKey(symbol);
  const value = safeNumber(price, 0);

  if (!key || value <= 0) return;

  livePriceCache.set(key, {
    price: value,
    ts: now()
  });
}

async function fetchBitgetTickerPrice(symbol = '') {
  const bitgetSymbol = normalizeBitgetSymbol(symbol);
  if (!bitgetSymbol) return 0;

  const cached = getCachedLivePrice(bitgetSymbol);
  if (cached > 0) return cached;

  const url = `${BITGET_BASE_URL}/api/v2/mix/market/ticker?symbol=${encodeURIComponent(bitgetSymbol)}&productType=${encodeURIComponent(BITGET_PRODUCT_TYPE)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) return 0;

  const json = await response.json().catch(() => null);
  const data = Array.isArray(json?.data) ? json.data[0] : json?.data;

  const price = safeNumber(
    data?.lastPr ??
      data?.last ??
      data?.markPrice ??
      data?.indexPrice ??
      data?.bidPr ??
      data?.askPr,
    0
  );

  if (price > 0) {
    setCachedLivePrice(bitgetSymbol, price);
    return price;
  }

  return 0;
}

async function fetchMidPriceFast(symbol, priceHints = new Map()) {
  const cfg = tradeConfig();

  if (cfg.monitorLivePriceFetchEnabled) {
    const liveResult = await withTimeout(
      fetchBitgetTickerPrice(symbol).catch(() => 0),
      cfg.monitorPriceFetchTimeoutMs,
      'LIVE_PRICE_FETCH_TIMEOUT'
    );

    if (!isTimeoutResult(liveResult)) {
      const livePrice = safeNumber(liveResult, 0);
      if (livePrice > 0) return livePrice;
    }
  }

  const hinted = priceHintForSymbol(symbol, priceHints);
  if (hinted > 0) return hinted;

  return 0;
}

function mergeAnalyzeRowsWithLiveRows(analyzedRowsRaw = [], liveRows = []) {
  const liveBySymbol = new Map();

  for (const row of liveRows) {
    const key = symbolKey(row.symbol || row.baseSymbol || row.contractSymbol);
    if (key && !liveBySymbol.has(key)) liveBySymbol.set(key, row);
  }

  const raw = Array.isArray(analyzedRowsRaw) && analyzedRowsRaw.length
    ? analyzedRowsRaw
    : liveRows;

  return raw.map((row) => {
    const key = symbolKey(row.symbol || row.baseSymbol || row.contractSymbol);
    const live = liveBySymbol.get(key) || {};

    return {
      ...live,
      ...row
    };
  });
}

function normalizeAnalyzedRows({
  analyzedRowsRaw,
  liveRows,
  marketContext,
  fallbackReason
}) {
  return mergeAnalyzeRowsWithLiveRows(analyzedRowsRaw, liveRows)
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) => attachCurrentFitContext({
      ...assignFallbackExact75(row, marketContext, fallbackReason),
      ...scannerMetadataFrom(row),
      ...sideFlags(),
      ...virtualFlags(row),
      ...isolationFlags()
    }, marketContext))
    .filter((row) => Boolean(getTrueMicroFamilyId(row)));
}

async function loadOpenPositionsFast(cfg, runtimeWarnings) {
  const result = await withTimeout(
    getOpenPositions({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      virtualOnly: true
    }).catch((error) => ({
      __openPositionError: true,
      error: error?.message || String(error)
    })),
    cfg.openPositionLoadTimeoutMs,
    'GET_OPEN_POSITIONS_TIMEOUT'
  );

  if (isTimeoutResult(result)) {
    runtimeWarnings.push('GET_OPEN_POSITIONS_TIMEOUT_USING_EMPTY_SET_FOR_ENTRY_BUDGET');
    return [];
  }

  if (result?.__openPositionError) {
    runtimeWarnings.push(`GET_OPEN_POSITIONS_ERROR_USING_EMPTY_SET:${result.error}`);
    return [];
  }

  return Array.isArray(result) ? result : [];
}

async function saveVirtualPositionFast(entry, cfg) {
  const position = buildOpenPositionFromEntry(entry);

  const result = await withTimeout(
    saveOpenPosition({
      ...position,
      ...isolationFlags()
    }).then(() => ({ ok: true, position })),
    cfg.savePositionTimeoutMs,
    'SAVE_OPEN_POSITION_TIMEOUT'
  );

  if (isTimeoutResult(result)) {
    return {
      ok: false,
      reason: 'SAVE_OPEN_POSITION_TIMEOUT'
    };
  }

  return result?.ok
    ? result
    : {
        ok: false,
        reason: 'SAVE_OPEN_POSITION_FAILED'
      };
}

export async function runTradeSystem(options = {}) {
  const previousOptions = ACTIVE_RUN_OPTIONS;
  ACTIVE_RUN_OPTIONS = options || {};

  try {
    const cfg = tradeConfig();
    const sizing = sizingConfig();
    const durableRedis = getDurableRedis();

    const runId = randomId('trade_run_short');
    const startedAt = now();
    const runtimeWarnings = [];

    const forceProcessSnapshot = Boolean(options.forceProcessSnapshot || options.force);
    const monitorOnly = Boolean(options.monitorOnly);

    const marketContextResult = await withTimeout(
      loadMarketContext().catch(() => extractMarketWeatherShape({}, {})),
      cfg.marketContextTimeoutMs,
      'MARKET_CONTEXT_TIMEOUT'
    );

    const marketContext = isTimeoutResult(marketContextResult)
      ? extractMarketWeatherShape({}, {})
      : marketContextResult;

    if (isTimeoutResult(marketContextResult)) runtimeWarnings.push('MARKET_CONTEXT_TIMEOUT_USING_EMPTY_CONTEXT');

    const snapshot = await getLatestSnapshot();
    const priceHints = buildSnapshotPriceHints(snapshot);

    const monitorResult = await withTimeout(
      monitorOpenPositions({
        priceFetcher: async (symbol) => fetchMidPriceFast(symbol, priceHints),
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        weekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        virtualOnly: true,
        realOrdersDisabled: true,
        bitgetOrdersDisabled: true,
        exchangeCallsDisabled: true,
        monitorTimeoutMs: cfg.monitorTimeoutMs,
        timeoutMs: cfg.monitorTimeoutMs,
        monitorBatchSize: cfg.monitorBatchSize,
        openPositionMonitorLimit: cfg.openPositionMonitorLimit,
        maxOpenPositionsToMonitor: cfg.openPositionMonitorLimit,
        monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled
      }).catch((error) => ({
        __monitorError: true,
        error: error?.message || String(error)
      })),
      cfg.monitorTimeoutMs,
      'MONITOR_OPEN_POSITIONS_TIMEOUT'
    );

    const virtualExits = Array.isArray(monitorResult) ? monitorResult : [];

    if (isTimeoutResult(monitorResult)) {
      runtimeWarnings.push('MONITOR_OPEN_POSITIONS_TIMEOUT_CONTINUING_TO_ENTRY_LOOP');
    } else if (monitorResult?.__monitorError) {
      runtimeWarnings.push(`MONITOR_OPEN_POSITIONS_ERROR_CONTINUING_TO_ENTRY_LOOP:${monitorResult.error}`);
    }

    const shadowExits = virtualExits;
    const realExits = [];

    if (monitorOnly) {
      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions: [],
        realExits,
        virtualExits,
        shadowExits,
        reason: 'MONITOR_ONLY',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: false,
        priceHints
      }));
    }

    if (!snapshot?.snapshotId) {
      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions: [],
        realExits,
        virtualExits,
        shadowExits,
        reason: 'NO_SHORT_SCANNER_SNAPSHOT',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: true,
        priceHints
      }));
    }

    const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

    if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates) ? snapshot.blockedNonShortCandidates : [];

      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        reason: 'SNAPSHOT_TOO_STALE',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: false,
        priceHints,
        extra: {
          snapshotAgeSec: Math.round(snapshotAgeSec)
        }
      }));
    }

    const lastProcessed = await getJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, null).catch(() => null);
    const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

    if (sameSnapshot && !forceProcessSnapshot) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates) ? snapshot.blockedNonShortCandidates : [];

      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        reason: 'SNAPSHOT_ALREADY_PROCESSED',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: false,
        priceHints
      }));
    }

    const activeRotationResult = await withTimeout(
      getActiveRotation({
        weekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        targetTradeSide: TARGET_TRADE_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX,
        shortOnly: true,
        longDisabled: true,
        exactTrueMicroOnly: true,
        selectionGranularity: 'EXACT_75_CHILD',
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
      }).catch(() => null),
      cfg.rotationTimeoutMs,
      'ACTIVE_ROTATION_TIMEOUT'
    );

    const activeRotation = isTimeoutResult(activeRotationResult) ? null : activeRotationResult;
    if (isTimeoutResult(activeRotationResult)) runtimeWarnings.push('ACTIVE_ROTATION_TIMEOUT_DISCORD_SELECTION_EMPTY');

    const alertContext = buildSelectedAlertContext(activeRotation);

    const preAnalyzeBlockedActions = Array.isArray(snapshot.blockedNonShortCandidates) ? snapshot.blockedNonShortCandidates : [];

    const allTargetCandidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
      .filter((candidate) => inferRowTradeSide(candidate) === TARGET_TRADE_SIDE);

    const candidates = allTargetCandidates
      .slice(0, cfg.maxCandidatesPerSnapshot)
      .map((candidate) => attachCurrentFitContext({
        ...candidate,
        ...scannerMetadataFrom(candidate),
        ...sideFlags(),
        ...isolationFlags(),
        ...virtualFlags(candidate),
        btcState: snapshot.btcState,
        regime: snapshot.regime
      }, marketContext));

    const cappedCandidateCount = Math.max(0, allTargetCandidates.length - candidates.length);
    if (cappedCandidateCount > 0) runtimeWarnings.push(`SHORT_CANDIDATES_CAPPED_FOR_ENTRY_BUDGET:${cappedCandidateCount}`);

    const processed = await mapConcurrent(candidates, cfg.dataConcurrency, safeProcessCandidate);
    const candidateTimeoutRows = processed.filter((row) => row?.timedOut).length;
    if (candidateTimeoutRows > 0) runtimeWarnings.push(`CANDIDATE_TIMEOUT_ROWS:${candidateTimeoutRows}`);

    const earlyActions = [
      ...preAnalyzeBlockedActions,
      ...processed.flatMap((row) => Array.isArray(row?.actions) ? row.actions : []).filter(Boolean)
    ];

    const liveRows = processed
      .flatMap((row) => Array.isArray(row?.metrics) ? row.metrics : [])
      .filter(Boolean)
      .filter(isTargetRow)
      .map((row) => attachCurrentFitContext({
        ...row,
        ...sideFlags(),
        ...isolationFlags(),
        ...virtualFlags(row)
      }, marketContext))
      .slice(0, cfg.analyzeMaxCandidatesPerSnapshot);

    const actualLiveRows = liveRows.length;
    const mirrorRows = 0;
    const observationOnlyRows = liveRows.filter((row) => row.observationOnly || row.analysisInputOnly).length;
    const standardizedLearningRiskRows = liveRows.filter((row) => row.standardizedLearningRisk).length;
    const syntheticRiskRows = liveRows.filter((row) => row.syntheticRisk).length;
    const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
    const riskValidRows = liveRows.filter(hasValidRiskShape).length;

    let analyzedRowsRaw = [];
    let analyzeError = null;
    let analyzeFallbackUsed = false;

    try {
      const analyzeResult = await withTimeout(
        analyzeCandidatesBatch(liveRows, {
          weekKey: PERSISTENT_LEARNING_KEY,
          persistentLearningKey: PERSISTENT_LEARNING_KEY,
          targetTradeSide: TARGET_TRADE_SIDE,
          tradeSide: TARGET_TRADE_SIDE,
          positionSide: TARGET_TRADE_SIDE,
          direction: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          scannerSide: TARGET_SCANNER_SIDE,
          actualScannerSide: TARGET_SCANNER_SIDE,
          dashboardSide: TARGET_DASHBOARD_SIDE,
          shortOnly: true,
          longDisabled: true,
          longOnly: false,
          shortDisabled: false,
          virtualOnly: true,
          virtualLearning: true,
          realOrdersDisabled: true,
          bitgetOrdersDisabled: true,
          exchangeCallsDisabled: true,
          observationAlwaysCounted: false,
          observationDedupeRequired: true,
          observationDedupeEnabled: true,
          seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',
          scannerFingerprintsMetadataOnly: true,
          scannerFingerprintsUsedAsLearningFamily: false,
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
          exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          learningGranularity: LEARNING_GRANULARITY,
          parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
          parentLearningEnabled: true,
          childLearningEnabled: true,
          selectionGranularity: 'EXACT_75_CHILD',
          fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
          currentMarketWeather: marketContext.source || null,
          currentMarketUniverse: marketContext.universe || null,
          currentMarketWeatherKey: MARKET_WEATHER_KEY,
          currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
          currentRegime: marketContext.regime,
          currentTrendSide: marketContext.trendSide,
          currentFitSoftOnly: true,
          currentFitBlocksLearning: false,
          currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
          currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
          riskGeometryRule: 'SHORT: tp < entry < sl',
          tpHitRule: 'SHORT: price <= tp',
          slHitRule: 'SHORT: price >= sl',
          grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
          currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
        }),
        cfg.analyzeTimeoutMs,
        'ANALYZE_CANDIDATES_TIMEOUT'
      );

      if (isTimeoutResult(analyzeResult)) {
        analyzeError = 'ANALYZE_CANDIDATES_TIMEOUT';
        analyzeFallbackUsed = true;
        runtimeWarnings.push('ANALYZE_CANDIDATES_TIMEOUT_USING_FALLBACK_EXACT_75_ROWS');
        runtimeWarnings.push('ANALYZE_FALLBACK_ALLOWED_VIRTUAL_LEARNING_TO_CONTINUE');
        analyzedRowsRaw = liveRows;
      } else {
        analyzedRowsRaw = Array.isArray(analyzeResult) ? analyzeResult : [];
        if (!analyzedRowsRaw.length) {
          analyzeFallbackUsed = true;
          runtimeWarnings.push('ANALYZE_RETURNED_EMPTY_USING_FALLBACK_EXACT_75_ROWS');
          analyzedRowsRaw = liveRows;
        }
      }
    } catch (error) {
      analyzeError = error?.message || String(error);
      analyzeFallbackUsed = true;
      runtimeWarnings.push(`ANALYZE_CANDIDATES_ERROR_USING_FALLBACK_EXACT_75_ROWS:${analyzeError}`);
      runtimeWarnings.push('ANALYZE_FALLBACK_ALLOWED_VIRTUAL_LEARNING_TO_CONTINUE');
      analyzedRowsRaw = liveRows;
    }

    const analyzedRows = normalizeAnalyzedRows({
      analyzedRowsRaw,
      liveRows,
      marketContext,
      fallbackReason: analyzeFallbackUsed
        ? 'ANALYZE_TIMEOUT_OR_ERROR_FALLBACK_EXACT_75'
        : 'ANALYZE_MISSING_EXACT_75_RUNTIME_FALLBACK'
    });

    const analyzedActualRows = analyzedRows.length;
    const analyzedMirrorRows = 0;
    const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
    const analyzedExact75Rows = analyzedRows.filter((row) => Boolean(getTrueMicroFamilyId(row))).length;
    const fallbackExact75Rows = analyzedRows.filter((row) => row.fallbackExact75).length;
    const analyzedStandardizedLearningRiskRows = analyzedRows.filter((row) => row.standardizedLearningRisk).length;
    const analyzedSyntheticRiskRows = analyzedRows.filter((row) => row.syntheticRisk).length;

    const openPositions = await loadOpenPositionsFast(cfg, runtimeWarnings);
    const openSymbolSet = buildOpenSymbolSet(openPositions);
    const openPositionCountBeforeEntries = openPositions.length;

    const actions = [...earlyActions];

    let entryRows = 0;
    let waitRows = earlyActions.length;
    let virtualCreatedRows = 0;
    let virtualSkippedRows = 0;
    let virtualFailedRows = 0;
    let skippedByExistingSymbol = 0;
    let discordAlertEligibleRows = 0;
    let discordAlertsQueued = 0;
    let discordAlertsSent = 0;
    let discordAlertsFailed = 0;
    let discordAlertsSkippedNoSelectedMicro = 0;
    let discordAlertsSkippedCurrentFit = 0;
    let selectedMicroMatchRows = 0;
    let unselectedMicroEntryRows = 0;
    let entryLoopAttempts = 0;
    let entryLoopRuntimeBreak = false;

    for (const row of analyzedRows) {
      entryLoopAttempts += 1;

      const minimumAttemptsStillRequired = entryLoopAttempts <= cfg.minEntryLoopAttempts;

      if (!minimumAttemptsStillRequired && runtimeExceeded(startedAt, cfg, cfg.entryLoopReserveMs)) {
        runtimeWarnings.push(`MAX_RUNTIME_REACHED_ENTRY_LOOP_STOPPED_AFTER_MIN_ATTEMPTS:${entryLoopAttempts - 1}`);
        entryLoopRuntimeBreak = true;
        break;
      }

      const trueMicroFamilyId = getTrueMicroFamilyId(row);
      const virtualGate = validateVirtualEntry(row);

      if (!virtualGate.ok) {
        waitRows += 1;
        virtualSkippedRows += 1;
        actions.push({
          ...row,
          action: 'WAIT',
          reason: virtualGate.reason,
          selectedRotationId: alertContext.rotationId,
          activeRotationId: alertContext.rotationId,
          activeParentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
          virtualGate,
          virtualTracked: false,
          liveEligible: false,
          ...sideFlags(),
          ...isolationFlags()
        });
        continue;
      }

      if (hasOpenSymbol(openSymbolSet, row)) {
        waitRows += 1;
        virtualSkippedRows += 1;
        skippedByExistingSymbol += 1;
        actions.push({
          ...row,
          action: 'WAIT',
          reason: 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION',
          selectedRotationId: alertContext.rotationId,
          activeRotationId: alertContext.rotationId,
          virtualTracked: true,
          liveEligible: false,
          oneOpenPositionPerSymbol: true,
          globalMaxOpenPositionsBlockDisabled: true,
          existingSymbolCheckedFromMemorySet: true,
          ...sideFlags(),
          ...isolationFlags()
        });
        continue;
      }

      const selectedWeeklyStats = getSelectedWeeklyStats(alertContext, trueMicroFamilyId, row);
      const sizingStats = selectedWeeklyStats || row;
      const riskFraction = sizing.enabled
        ? riskFractionForEntry({
            weeklyStats: sizingStats,
            side: TARGET_DASHBOARD_SIDE,
            tradeSide: TARGET_TRADE_SIDE
          })
        : sizing.baseRiskPct;

      const selectedExactMicroMatch = rowMatchesSelectedAlertMicro(alertContext, row);
      const currentFitGate = discordCurrentFitGate(row);
      const discordAlertEligible = selectedExactMicroMatch && currentFitGate.ok;

      if (selectedExactMicroMatch) selectedMicroMatchRows += 1;
      else {
        discordAlertsSkippedNoSelectedMicro += 1;
        unselectedMicroEntryRows += 1;
      }

      if (selectedExactMicroMatch && !currentFitGate.ok) discordAlertsSkippedCurrentFit += 1;
      if (discordAlertEligible) discordAlertEligibleRows += 1;

      const entry = buildVirtualEntryAction({
        row,
        alertContext,
        selectedWeeklyStats,
        riskFraction,
        virtualGate,
        selectedExactMicroMatch,
        discordAlertEligible
      });

      try {
        const saveResult = await saveVirtualPositionFast(entry, cfg);

        if (!saveResult.ok) {
          throw new Error(saveResult.reason || 'SAVE_OPEN_POSITION_FAILED');
        }

        rememberOpenSymbol(openSymbolSet, entry);
        openPositions.push(saveResult.position || entry);

        entryRows += 1;
        virtualCreatedRows += 1;

        const discordResult = await maybeSendDiscordEntryAlert(entry, cfg);

        if (discordResult.queued) discordAlertsQueued += 1;
        if (discordResult.sent) discordAlertsSent += 1;
        if (discordResult.failed) discordAlertsFailed += 1;

        actions.push({
          ...entry,
          discordAlertResult: discordResult,
          discordAlertQueued: Boolean(discordResult.queued),
          discordAlertSent: Boolean(discordResult.sent),
          discordAlertFailed: Boolean(discordResult.failed),
          ...isolationFlags()
        });
      } catch (error) {
        waitRows += 1;
        virtualFailedRows += 1;
        actions.push({
          ...row,
          action: 'WAIT',
          reason: 'VIRTUAL_POSITION_CREATE_FAILED',
          error: error?.message || String(error),
          selectedRotationId: alertContext.rotationId,
          activeRotationId: alertContext.rotationId,
          virtualTracked: false,
          liveEligible: false,
          ...sideFlags(),
          ...isolationFlags()
        });
      }
    }

    if (entryLoopAttempts > 0 && !entryLoopRuntimeBreak) {
      runtimeWarnings.push(`ENTRY_LOOP_COMPLETED_ATTEMPTS:${entryLoopAttempts}`);
    }

    const counts = buildRunActionCounts(actions, virtualExits);

    const qualityAudit = buildQualityAudit({
      snapshot,
      candidates,
      processed,
      liveRows,
      analyzedRowsRaw,
      analyzedRows,
      actions,
      virtualExits,
      counts: {
        riskValidRows,
        analyzedRiskValidRows,
        analyzedExact75Rows,
        fallbackExact75Rows,
        entryRows,
        virtualCreatedRows,
        waitRows,
        skippedByExistingSymbol,
        selectedAlertMicroMatches: selectedMicroMatchRows,
        discordCurrentFitBlockedRows: discordAlertsSkippedCurrentFit
      },
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,
      marketContext,
      runtimeWarnings
    });

    const baseResult = {
      runId,
      runPhase: options.runPhase || options.tradeRunPhase || null,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotCreatedAt: snapshot.createdAt,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      forceProcessSnapshot,

      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
      blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,

      entryRelaxationProfile: cfg.entryRelaxationProfile,
      qualityMeasurementProfile: cfg.qualityMeasurementProfile,
      scannerWideVirtualLearning: cfg.scannerWideVirtualLearning,
      tradeEveryScannerCandidateVirtual: cfg.tradeEveryScannerCandidateVirtual,
      skipLiveRiskFetchForLearning: cfg.skipLiveRiskFetchForLearning,
      maxCandidatesPerSnapshot: cfg.maxCandidatesPerSnapshot,
      analyzeMaxCandidatesPerSnapshot: cfg.analyzeMaxCandidatesPerSnapshot,
      hardMaxCandidatesPerSnapshot: cfg.hardMaxCandidatesPerSnapshot,
      dataConcurrency: cfg.dataConcurrency,
      candidateTimeoutMs: cfg.candidateTimeoutMs,
      analyzeTimeoutMs: cfg.analyzeTimeoutMs,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      monitorPriceFetchTimeoutMs: cfg.monitorPriceFetchTimeoutMs,
      monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
      monitorBatchSize: cfg.monitorBatchSize,
      openPositionMonitorLimit: cfg.openPositionMonitorLimit,
      minEntryLoopAttempts: cfg.minEntryLoopAttempts,
      entryLoopReserveMs: cfg.entryLoopReserveMs,
      marketContextTimeoutMs: cfg.marketContextTimeoutMs,
      maxRuntimeMs: cfg.maxRuntimeMs,

      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags(),

      currentMarketWeather: compactMarketWeather(marketContext.source || null),
      currentMarketUniverse: null,
      currentMarketWeatherKey: MARKET_WEATHER_KEY,
      currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
      currentMarketWeatherAgeSec: marketContext.ageSec,
      currentMarketWeatherStale: marketContext.stale,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      currentBullishPct: marketContext.bullishPct,
      currentBearishPct: marketContext.bearishPct,
      currentSqueezePct: marketContext.squeezePct,

      marketContext: {
        ...marketContext,
        source: compactMarketWeather(marketContext.source || null),
        universe: null,
        compactedForRedis: true
      },

      candidates: candidates.length,
      allShortCandidatesBeforeCap: allTargetCandidates.length,
      cappedCandidateCount: Math.max(0, allTargetCandidates.length - candidates.length),
      shortCandidateCount: candidates.length,
      longCandidateCount: 0,
      nonShortCandidateCount: snapshot.blockedNonShortCandidatesCount || 0,

      processed: processed.length,
      earlyActions: earlyActions.length,
      liveRows: liveRows.length,
      analyzeInputRows: liveRows.length,
      actualLiveRows,
      mirrorRows,
      observationOnlyRows,
      standardizedLearningRiskRows,
      syntheticRiskRows,
      learningOnlyRows,
      riskValidRows,

      analyzedRows: analyzedRows.length,
      analyzedRowsRaw: analyzedRowsRaw.length,
      analyzedActualRows,
      analyzedMirrorRows,
      analyzedRiskValidRows,
      analyzedExact75Rows,
      fallbackExact75Rows,
      analyzedStandardizedLearningRiskRows,
      analyzedSyntheticRiskRows,
      analyzeError,
      analyzeFallbackUsed,
      analyzeWeekKey: PERSISTENT_LEARNING_KEY,

      entryRows,
      waitRows,
      virtualCreatedRows,
      virtualSkippedRows,
      virtualFailedRows,
      skippedByExistingSymbol,
      shadowCreatedRows: virtualCreatedRows,
      shadowSkippedRows: virtualSkippedRows,
      shadowFailedRows: virtualFailedRows,
      shadowDisabled: false,

      virtualExits,
      shadowExits,
      realExits: [],
      virtualExitRows: virtualExits.length,
      shadowExitRows: virtualExits.length,
      realExitRows: 0,

      discordRequiresCurrentFit: discordRequiresCurrentFit(),
      discordMinCurrentFitConfidence: discordMinCurrentFitConfidence(),
      discordAlertEligibleRows,
      discordAlertsQueued,
      discordAlertsSent,
      discordAlertsFailed,
      discordAlertsSkippedNoSelectedMicro,
      discordAlertsSkippedCurrentFit,

      selectedMicroMatchRows,
      selectedAlertMicroMatches: selectedMicroMatchRows,
      unselectedMicroEntryRows,

      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,

      entryLoopAttempts,
      entryLoopRuntimeBreak,

      actions,
      virtualActions: actions,
      actionCounts: counts,
      actionsCount: actions.length,
      rawActionsCount: actions.length,
      rawExitRowsCount: virtualExits.length,

      qualityAudit,
      runtimeWarnings,

      selectedRotationId: alertContext.rotationId,
      activeRotationId: alertContext.rotationId,
      selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      selectedTrueMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      selectedChildTrueMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      selectedParentTrueMicroFamilies: alertContext.selectedParentTrueMicroFamilyIds.length,
      selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
      selectedTrueMicroFamilyIds: alertContext.selectedTrueMicroFamilyIds,
      selectedChildTrueMicroFamilyIds: alertContext.selectedChildTrueMicroFamilyIds,
      selectedParentTrueMicroFamilyIds: alertContext.selectedParentTrueMicroFamilyIds,
      selectedMacroFamilyIds: [],
      activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      activeTrueMicroFamilies: alertContext.selectedTrueMicroFamilyIds.length,
      activeChildTrueMicroFamilies: alertContext.selectedChildTrueMicroFamilyIds.length,
      activeParentTrueMicroFamilies: alertContext.selectedParentTrueMicroFamilyIds.length,
      activeMicroFamilyIds: alertContext.selectedMicroFamilyIds,
      activeTrueMicroFamilyIds: alertContext.selectedTrueMicroFamilyIds,
      activeChildTrueMicroFamilyIds: alertContext.selectedChildTrueMicroFamilyIds,
      activeParentTrueMicroFamilyIds: alertContext.selectedParentTrueMicroFamilyIds,
      activeMacroFamilyIds: [],
      trueMicroOnly: alertContext.trueMicroOnly,
      exactTrueMicroOnly: true,
      exactTrueMicroFamilyRequired: true,
      allowCoarseMicroAliasLiveEntries: false,
      allowCoarseMicroAliasForDiscord: false,
      selectionPurpose: 'DISCORD_ALERT_ONLY',
      scannerSnapshotStats: {
        candidatesCount: snapshot.candidatesCount || candidates.length,
        scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount || null,
        analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount || null,
        filteredUniverse: snapshot.filteredUniverse || null,
        rawCount: snapshot.rawCount || null,
        blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
        blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0
      },
      scannerLatestPreserved: true,
      scannerSnapshotPreserved: true,
      scannerHistoryPreserved: true,
      microFamiliesAppendOnly: true,
      analyzePartialOnly: true,
      analyzeFullOverwriteDisabled: true,
      rotationPreserved: true,
      manualSelectionPreserved: true,
      discordSelectionPreserved: true,
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      monitorPriceHintCount: priceHints.size,
      monitorPriceSource: cfg.monitorLivePriceFetchEnabled
        ? 'LIVE_BITGET_TICKER_FIRST_THEN_SCANNER_SNAPSHOT_HINTS'
        : 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',
      processScannerSnapshot: true,
      skipped: false,
      skippedNewEntries: false,
      reason: null,
      skipReason: null
    };

    return saveRunMeta(baseResult);
  } finally {
    ACTIVE_RUN_OPTIONS = previousOptions;
  }
}