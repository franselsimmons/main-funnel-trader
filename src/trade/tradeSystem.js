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
import {
  fetchCandles,
  fetchFunding,
  fetchOrderBook,
  analyzeOrderBook
} from '../market/bitgetClient.js';
import {
  analyzeCandidatesBatch
} from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildRiskAndLiveMetricsForBothSides
} from './riskEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  getOpenPosition,
  saveOpenPosition,
  monitorOpenPositions
} from './positionEngine.js';
import {
  riskFractionForEntry
} from './positionSizing.js';
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

const RUN_SCOPE = 'TRADE_ONLY';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_SHORT_SCANNER_LATEST_ONLY';

const ENTRY_RELAXATION_PROFILE = 'SHORT_SCANNER_WIDE_VIRTUAL_LEARNING_V1';
const QUALITY_MEASUREMENT_PROFILE = 'SHORT_MICRO_FAMILY_TP_SL_LEARNING_V1';

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 12;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 25;
const DEFAULT_DATA_CONCURRENCY = 3;
const DEFAULT_CANDLE_LIMIT = 40;
const DEFAULT_MIN_LIVE_CANDLES_15M = 10;
const DEFAULT_MAX_SNAPSHOT_AGE_SEC = 8 * 60;

const DEFAULT_MIN_RISK_PCT = 0.0035;
const DEFAULT_MAX_RISK_PCT = 0.03;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;
const DEFAULT_RR = 1.5;
const DEFAULT_MIN_RR = 0.5;

const DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES = true;
const DEFAULT_SKIP_LIVE_RISK_FETCH_FOR_LEARNING = true;

const DEFAULT_DISCORD_REQUIRE_CURRENT_FIT = true;
const DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE = 35;
const DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC = 15 * 60;

const DEFAULT_MARKET_CONTEXT_TIMEOUT_MS = 2000;
const DEFAULT_MONITOR_TIMEOUT_MS = 42000;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 7000;
const DEFAULT_ANALYZE_TIMEOUT_MS = 12000;
const DEFAULT_ROTATION_TIMEOUT_MS = 3000;
const DEFAULT_MAX_RUNTIME_MS = 45000;

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

function ratio(part, total) {
  const p = safeNumber(part, 0);
  const t = safeNumber(total, 0);
  if (t <= 0) return 0;
  return p / t;
}

function pct(part, total) {
  return Number((ratio(part, total) * 100).toFixed(2));
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
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true
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
      CONFIG.trade?.discordMinCurrentFitConfidence,
    0,
    100
  ) || DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE;
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
    observationFirstLearning: true,
    observationDedupeRequired: true,
    observationDedupeEnabled: true,
    seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',
    observationDedupeKeySource: 'snapshotId|symbol|trueMicroFamilyId|entry',

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

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
    discordOnlyForExactTrueMicroMatch: true,
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

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
    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL
    },

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
    100
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
      5
    ),

    candleLimit: positiveInt(
      firstDefined(
        options.candleLimit,
        CONFIG.short?.trade?.candleLimit,
        CONFIG.trade?.shortCandleLimit,
        CONFIG.trade?.candleLimit
      ),
      DEFAULT_CANDLE_LIMIT,
      10,
      120
    ),

    minLiveCandles15m: positiveInt(
      firstDefined(
        options.minLiveCandles15m,
        CONFIG.short?.trade?.minLiveCandles15m,
        CONFIG.trade?.shortMinLiveCandles15m,
        CONFIG.trade?.minLiveCandles15m
      ),
      DEFAULT_MIN_LIVE_CANDLES_15M,
      0,
      100
    ),

    maxSpreadPct: cfgNumber(
      firstDefined(
        options.maxSpreadPct,
        CONFIG.short?.trade?.maxSpreadPct,
        CONFIG.trade?.shortMaxSpreadPct,
        CONFIG.trade?.maxSpreadPct
      ),
      0.0015
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

    standardizedLearningRiskRequiresScannerGatePassed: cfgBoolean(
      firstDefined(
        options.standardizedLearningRiskRequiresScannerGatePassed,
        CONFIG.short?.trade?.standardizedLearningRiskRequiresScannerGatePassed,
        CONFIG.trade?.shortStandardizedLearningRiskRequiresScannerGatePassed,
        CONFIG.trade?.standardizedLearningRiskRequiresScannerGatePassed
      ),
      false
    ),

    standardizedLearningRiskRequiresAnalyzeEligible: cfgBoolean(
      firstDefined(
        options.standardizedLearningRiskRequiresAnalyzeEligible,
        CONFIG.short?.trade?.standardizedLearningRiskRequiresAnalyzeEligible,
        CONFIG.trade?.shortStandardizedLearningRiskRequiresAnalyzeEligible,
        CONFIG.trade?.standardizedLearningRiskRequiresAnalyzeEligible
      ),
      false
    ),

    standardizedLearningRiskRequiresSpreadGatePassed: cfgBoolean(
      firstDefined(
        options.standardizedLearningRiskRequiresSpreadGatePassed,
        CONFIG.short?.trade?.standardizedLearningRiskRequiresSpreadGatePassed,
        CONFIG.trade?.shortStandardizedLearningRiskRequiresSpreadGatePassed,
        CONFIG.trade?.standardizedLearningRiskRequiresSpreadGatePassed
      ),
      false
    ),

    marketContextTimeoutMs: positiveInt(
      firstDefined(options.marketContextTimeoutMs, CONFIG.short?.trade?.marketContextTimeoutMs),
      DEFAULT_MARKET_CONTEXT_TIMEOUT_MS,
      250,
      10000
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
      52000
    ),

    candidateTimeoutMs: positiveInt(
      firstDefined(options.candidateTimeoutMs, CONFIG.short?.trade?.candidateTimeoutMs),
      DEFAULT_CANDIDATE_TIMEOUT_MS,
      500,
      20000
    ),

    analyzeTimeoutMs: positiveInt(
      firstDefined(options.analyzeTimeoutMs, CONFIG.short?.trade?.analyzeTimeoutMs),
      DEFAULT_ANALYZE_TIMEOUT_MS,
      500,
      25000
    ),

    rotationTimeoutMs: positiveInt(
      firstDefined(options.rotationTimeoutMs, CONFIG.short?.trade?.rotationTimeoutMs),
      DEFAULT_ROTATION_TIMEOUT_MS,
      250,
      10000
    ),

    maxRuntimeMs: positiveInt(
      firstDefined(options.maxRuntimeMs, CONFIG.short?.trade?.maxRuntimeMs),
      DEFAULT_MAX_RUNTIME_MS,
      5000,
      55000
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

async function loadMarketContext() {
  const redis = getVolatileRedis();

  const [weather, universe] = await Promise.all([
    getJson(redis, MARKET_WEATHER_KEY, null).catch(() => null),
    getJson(redis, MARKET_UNIVERSE_KEY, null).catch(() => null)
  ]);

  return extractMarketWeatherShape(weather || {}, universe || {});
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
    score += 30;
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
    if (marketContext.bearishPct >= 60) score += 15;
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
    entry,
    sl,
    tp,
    rr,
    riskPct,
    rewardPct,

    spreadPct: safeNumber(normalized.spreadPct, CONFIG.short?.cost?.fallbackSpreadPct ?? CONFIG.cost?.shortFallbackSpreadPct ?? CONFIG.cost?.fallbackSpreadPct ?? 0.0008),
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

async function fetchLiveCandidateData(candidate) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  const symbol = normalized.contractSymbol;

  if (!symbol) {
    return {
      symbol,
      ob: {
        fetchFailed: true,
        mid: 0,
        bias: 'NEUTRAL',
        spreadPct: CONFIG.short?.cost?.fallbackSpreadPct || CONFIG.cost?.shortFallbackSpreadPct || CONFIG.cost?.fallbackSpreadPct || 0.0008,
        depthMinUsd1p: 0
      },
      funding: { rate: 0, fetchFailed: true },
      candles15m: [],
      candles1h: []
    };
  }

  const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
    fetchOrderBook(symbol).catch(() => null),
    fetchFunding(symbol).catch(() => ({ rate: 0, fetchFailed: true })),
    fetchCandles(symbol, '15m', cfg.candleLimit).catch(() => []),
    fetchCandles(symbol, '1h', cfg.candleLimit).catch(() => [])
  ]);

  const ob = analyzeOrderBook(rawOrderBook);

  return {
    symbol,
    ob,
    funding,
    candles15m: Array.isArray(candles15m) ? candles15m : [],
    candles1h: Array.isArray(candles1h) ? candles1h : []
  };
}

async function fetchMidPrice(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return 0;

  const rawOrderBook = await fetchOrderBook(contractSymbol).catch(() => null);
  const ob = analyzeOrderBook(rawOrderBook);

  return safeNumber(ob?.mid, 0);
}

function normalizeSymbolLookupKeys(value = '') {
  const raw = String(value || '').trim();
  const base = normalizeBaseSymbol(raw);
  const contract = normalizeContractSymbol(raw || base);

  return [...new Set([
    raw.toUpperCase(),
    base,
    contract,
    normalizeBaseSymbol(contract)
  ]
    .map((part) => String(part || '').trim().toUpperCase())
    .filter(Boolean))];
}

function priceHintFromRow(row = {}) {
  return firstFinite(
    row.price,
    row.markPrice,
    row.currentPrice,
    row.lastPrice,
    row.close,
    row.mid,
    row.entry,
    row.entryPrice,
    row.scannerPrice,
    row.referencePrice
  ) || 0;
}

function buildSnapshotPriceHintMap(snapshot = {}) {
  const map = new Map();
  const rows = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];

  for (const row of rows) {
    const price = priceHintFromRow(row);

    if (!(price > 0)) continue;

    const keys = [
      ...normalizeSymbolLookupKeys(row.symbol),
      ...normalizeSymbolLookupKeys(row.baseSymbol),
      ...normalizeSymbolLookupKeys(row.contractSymbol)
    ];

    for (const key of keys) {
      if (!map.has(key)) map.set(key, price);
    }
  }

  return map;
}

function getPriceHintForSymbol(priceHintMap, symbol = '') {
  if (!priceHintMap || !(priceHintMap instanceof Map)) return 0;

  for (const key of normalizeSymbolLookupKeys(symbol)) {
    const price = safeNumber(priceHintMap.get(key), 0);

    if (price > 0) return price;
  }

  return 0;
}

function buildMonitorPriceFetcher(snapshot = {}) {
  const priceHintMap = buildSnapshotPriceHintMap(snapshot);
  const fetchCache = new Map();

  const priceFetcher = async (symbol) => {
    const hinted = getPriceHintForSymbol(priceHintMap, symbol);

    if (hinted > 0) return hinted;

    const key = normalizeContractSymbol(symbol || '');

    if (!key) return 0;
    if (fetchCache.has(key)) return fetchCache.get(key);

    const promise = fetchMidPrice(key).catch(() => 0);

    fetchCache.set(key, promise);

    const fetched = await promise;
    const price = safeNumber(fetched, 0);

    fetchCache.set(key, price);

    return price;
  };

  priceFetcher.meta = {
    priceHintCount: priceHintMap.size,
    usesSnapshotPriceHints: true,
    fallback: 'BITGET_ORDERBOOK_MID'
  };

  return priceFetcher;
}

async function processCandidate(candidate) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);

  if (!normalized.symbol || !normalized.contractSymbol) {
    return {
      actions: [waitAction(normalized, 'INVALID_SYMBOL')],
      metrics: []
    };
  }

  const scannerSide = inferRowTradeSide(normalized);

  if (scannerSide !== TARGET_TRADE_SIDE) {
    return {
      actions: [waitAction(normalized, 'LONG_DISABLED_SHORT_ONLY_SYSTEM', {
        skippedBeforeAnalyze: true,
        skippedBeforeLiveFetch: true,
        detectedScannerSide: scannerSide
      })],
      metrics: []
    };
  }

  if (cfg.skipLiveRiskFetchForLearning) {
    return {
      actions: [],
      metrics: [standardizedRiskMetrics(normalized, 'VERCEL_SAFE_STANDARDIZED_SHORT_LEARNING_TP_SL')]
    };
  }

  const dataResult = await withTimeout(
    fetchLiveCandidateData(normalized).catch((error) => ({ error })),
    cfg.candidateTimeoutMs,
    'LIVE_CANDIDATE_DATA_TIMEOUT'
  );

  if (isTimeoutResult(dataResult) || dataResult?.error || dataResult?.ob?.fetchFailed) {
    return {
      actions: [],
      metrics: [standardizedRiskMetrics(normalized, isTimeoutResult(dataResult)
        ? 'LIVE_DATA_TIMEOUT_STANDARDIZED_LEARNING_TP_SL'
        : 'LIVE_DATA_FAILED_STANDARDIZED_LEARNING_TP_SL')]
    };
  }

  const hasEnough15mCandles = Array.isArray(dataResult.candles15m) && dataResult.candles15m.length >= cfg.minLiveCandles15m;

  if (!hasEnough15mCandles) {
    return {
      actions: [],
      metrics: [standardizedRiskMetrics(normalized, 'INSUFFICIENT_LIVE_CANDLES_STANDARDIZED_LEARNING_TP_SL')]
    };
  }

  const generatedMetrics = buildRiskAndLiveMetricsForBothSides({
    candidate: {
      ...normalized,
      ...sideFlags()
    },
    ob: dataResult.ob,
    funding: dataResult.funding,
    candles15m: dataResult.candles15m,
    candles1h: dataResult.candles1h,
    btcState: normalized.btcState || candidate.btcState,
    regime: normalized.regime || candidate.regime
  });

  const metrics = (Array.isArray(generatedMetrics) ? generatedMetrics : [])
    .filter(isTargetRow)
    .map((row) => ({
      ...normalized,
      ...row,
      ...scannerMetadataFrom(normalized, row),
      ...sideFlags(),
      ...virtualFlags(row),
      riskSource: row.riskSource || 'RISK_ENGINE',
      riskEngineRisk: true,
      standardizedLearningRisk: false,
      validShortRiskShape: hasValidRiskShape(row)
    }));

  return {
    actions: [],
    metrics: metrics.some(hasValidRiskShape)
      ? metrics
      : [standardizedRiskMetrics(normalized, 'RISK_ENGINE_EMPTY_STANDARDIZED_SHORT_LEARNING_TP_SL')]
  };
}

async function safeProcessCandidate(candidate) {
  const cfg = tradeConfig();

  try {
    const result = await withTimeout(
      processCandidate(candidate),
      cfg.candidateTimeoutMs,
      'CANDIDATE_PROCESS_TIMEOUT'
    );

    if (!isTimeoutResult(result)) return result;

    const normalized = normalizeCandidate(candidate);

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

    scannerGateCandidatesCount: targetRows.filter((row) => row.scannerGatePassed).length,
    analyzeOnlyCandidatesCount: targetRows.filter((row) => row.tradeDiscoveryOnly || row.discoveryOnly || row.analyzeOnly).length,

    topSymbols: targetRows.slice(0, 20).map((row) => row.symbol).filter(Boolean),
    scannerGateSymbols: targetRows.filter((row) => row.scannerGatePassed).slice(0, 20).map((row) => row.symbol).filter(Boolean)
  };
}

async function loadRecentTargetSnapshots(redis, limit = 8) {
  const pattern = namespacedShortKey(
    keyFromMaybeFunction(KEYS.short?.scan?.snapshot || KEYS.scan?.shortSnapshot || KEYS.scan?.snapshot, '*', 'SCAN:SNAPSHOT:*'),
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

  const latest = await safeGetSnapshotJson(volatileRedis, SHORT_KEYS.scan.latest, null);
  const latestSnapshotId = extractSnapshotId(latest);

  if (hasFullSnapshotShape(latest) && countTargetCandidates(latest) > 0) {
    return normalizeSelectedSnapshot(latest, {
      source: 'SHORT:SCAN:LATEST_FULL_SNAPSHOT',
      reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
    });
  }

  if (latestSnapshotId) {
    const byId = await safeGetSnapshotJson(volatileRedis, SHORT_KEYS.scan.snapshot(latestSnapshotId), null);

    if (hasFullSnapshotShape(byId) && countTargetCandidates(byId) > 0) {
      return normalizeSelectedSnapshot(byId, {
        source: 'SHORT:SCAN:SNAPSHOT_BY_LATEST_ID',
        reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
      });
    }
  }

  const recent = await loadRecentTargetSnapshots(volatileRedis, 8);
  const best = recent.find((row) => row.targetCount > 0) || recent[0] || null;

  if (!best?.snapshot) return null;

  return normalizeSelectedSnapshot(best.snapshot, {
    source: `SHORT:SCAN:RECENT_SEARCH:${best.key}`,
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

function maybeSendDiscordEntryAlert(entry = {}) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: entry.discordAlertReason || 'TRUE_MICRO_FAMILY_NOT_SELECTED_OR_CURRENT_FIT_BLOCKED'
    };
  }

  sendEntryAlert(entry).catch(() => null);

  return {
    sent: false,
    skipped: false,
    queued: true,
    fireAndForget: true,
    reason: 'DISCORD_ENTRY_ALERT_QUEUED_FIRE_AND_FORGET'
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
  openPositionCountAfterEntries
}) {
  if (candidates <= 0) return 'NO_SHORT_CANDIDATES';
  if (processed <= 0) return 'NO_CANDIDATES_PROCESSED';
  if (liveRows <= 0) return 'NO_LIVE_ROWS_OR_NO_FALLBACK_PRICE';
  if (riskValidRows <= 0) return 'NO_TP_SL_AVAILABLE_FOR_SCANNER_WIDE_VIRTUAL_LEARNING';
  if (analyzedRows <= 0) return 'ANALYZE_RETURNED_NO_SHORT_ROWS';
  if (analyzedRiskValidRows <= 0) return 'ANALYZE_DID_NOT_RETURN_RISK_VALID_ROWS';
  if (analyzedExact75Rows <= 0) return 'ANALYZE_DID_NOT_ASSIGN_EXACT_75_CHILD_TRUE_MICRO_FAMILY';
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
  monitorDiagnostics
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
    monitor: monitorDiagnostics || null,
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
      entryRows,
      virtualCreatedRows,
      virtualExitRows,
      waitRows,
      skippedByExistingSymbol: counts.skippedByExistingSymbol || 0,
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

async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();
  const completedAt = now();

  const virtualExits = Array.isArray(result.virtualExits)
    ? result.virtualExits
    : Array.isArray(result.shadowExits)
      ? result.shadowExits
      : [];

  const virtualExitActions = buildVirtualExitActions(virtualExits);

  const finalResult = {
    ok: true,
    ...result,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    shortKeys: {
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
    virtualExitActions,
    skipReason: result.skipReason || result.reason || null,
    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts: result.actionCounts || buildRunActionCounts(result.actions || [], virtualExits),
    qualityAudit: result.qualityAudit || null
  };

  await scopedSetJson(durableRedis, SHORT_KEYS.trade.runMeta, finalResult);

  return finalResult;
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
    const monitorPriceFetcher = buildMonitorPriceFetcher(snapshot || {});

    const monitorResult = await withTimeout(
      monitorOpenPositions({
        priceFetcher: monitorPriceFetcher,
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
        useSnapshotPriceHints: true,
        monitorPriceHintCount: monitorPriceFetcher.meta.priceHintCount
      }).catch((error) => ({
        __monitorError: true,
        error: error?.message || String(error)
      })),
      cfg.monitorTimeoutMs,
      'MONITOR_OPEN_POSITIONS_TIMEOUT'
    );

    const virtualExits = Array.isArray(monitorResult) ? monitorResult : [];

    const monitorDiagnostics = {
      monitorPreflightEnabled: true,
      monitorPreflightOk: Array.isArray(monitorResult),
      monitorPreflightTimedOut: isTimeoutResult(monitorResult),
      monitorPreflightError: monitorResult?.__monitorError ? monitorResult.error : null,
      monitorPreflightVirtualExitRows: virtualExits.length,
      monitorPriceHintCount: monitorPriceFetcher.meta.priceHintCount,
      monitorUsesSnapshotPriceHints: true,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      monitorSnapshotAvailable: Boolean(snapshot?.snapshotId),
      monitorSnapshotId: snapshot?.snapshotId || null
    };

    if (isTimeoutResult(monitorResult)) runtimeWarnings.push('MONITOR_OPEN_POSITIONS_TIMEOUT_SKIPPED_FOR_THIS_RUN');
    else if (monitorResult?.__monitorError) runtimeWarnings.push(`MONITOR_OPEN_POSITIONS_ERROR:${monitorResult.error}`);

    const shadowExits = virtualExits;
    const realExits = [];

    if (monitorOnly) {
      const actions = [];

      return saveRunMeta({
        runId,
        startedAt,
        ...monitorDiagnostics,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        entryRows: 0,
        waitRows: 0,
        virtualCreatedRows: 0,
        skippedNewEntries: true,
        reason: 'MONITOR_ONLY',
        runtimeWarnings,
        actionCounts: buildRunActionCounts(actions, virtualExits),
        marketContext,
        monitorOpenPositions: true,
        monitorOpenPositionsFirst: true,
        processScannerSnapshot: false,
        ...isolationFlags()
      });
    }

    if (!snapshot?.snapshotId) {
      const actions = [];

      return saveRunMeta({
        runId,
        startedAt,
        ...monitorDiagnostics,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        entryRows: 0,
        waitRows: 0,
        virtualCreatedRows: 0,
        skippedNewEntries: true,
        reason: 'NO_SHORT_SCANNER_SNAPSHOT',
        runtimeWarnings,
        actionCounts: buildRunActionCounts(actions, virtualExits),
        marketContext,
        monitorOpenPositions: true,
        monitorOpenPositionsFirst: true,
        processScannerSnapshot: true,
        ...isolationFlags()
      });
    }

    const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

    if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates) ? snapshot.blockedNonShortCandidates : [];

      return saveRunMeta({
        runId,
        startedAt,
        ...monitorDiagnostics,
        snapshotId: snapshot.snapshotId,
        snapshotAgeSec: Math.round(snapshotAgeSec),
        selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
        selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
        selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
        selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
        selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
        selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
        blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
        blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        entryRows: 0,
        waitRows: actions.length,
        virtualCreatedRows: 0,
        skippedNewEntries: true,
        reason: 'SNAPSHOT_TOO_STALE',
        runtimeWarnings,
        actionCounts: buildRunActionCounts(actions, virtualExits),
        marketContext,
        monitorOpenPositions: true,
        monitorOpenPositionsFirst: true,
        processScannerSnapshot: false,
        ...isolationFlags()
      });
    }

    const lastProcessed = await getJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, null);
    const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

    if (sameSnapshot && !forceProcessSnapshot) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates) ? snapshot.blockedNonShortCandidates : [];

      return saveRunMeta({
        runId,
        startedAt,
        ...monitorDiagnostics,
        snapshotId: snapshot.snapshotId,
        selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
        selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
        selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
        selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
        selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
        selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
        blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
        blockedNonLongCandidatesCount: snapshot.blockedNonLongCandidatesCount || 0,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        entryRows: 0,
        waitRows: actions.length,
        virtualCreatedRows: 0,
        skippedNewEntries: true,
        reason: 'SNAPSHOT_ALREADY_PROCESSED',
        runtimeWarnings,
        actionCounts: buildRunActionCounts(actions, virtualExits),
        marketContext,
        monitorOpenPositions: true,
        monitorOpenPositionsFirst: true,
        processScannerSnapshot: false,
        ...isolationFlags()
      });
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
    if (cappedCandidateCount > 0) runtimeWarnings.push(`SHORT_CANDIDATES_CAPPED_FOR_VERCEL:${cappedCandidateCount}`);

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
          childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
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
        runtimeWarnings.push('ANALYZE_CANDIDATES_TIMEOUT_USING_PRE_ANALYZE_ROWS');
        analyzedRowsRaw = liveRows;
      } else {
        analyzedRowsRaw = Array.isArray(analyzeResult) ? analyzeResult : [];
      }
    } catch (error) {
      analyzeError = error?.message || String(error);
      runtimeWarnings.push(`ANALYZE_CANDIDATES_ERROR_USING_PRE_ANALYZE_ROWS:${analyzeError}`);
      analyzedRowsRaw = liveRows;
    }

    const analyzedRows = analyzedRowsRaw
      .filter(Boolean)
      .filter(isTargetRow)
      .map((row) => attachCurrentFitContext({
        ...normalizeExactTrueMicroRow(row),
        ...scannerMetadataFrom(row),
        ...sideFlags(),
        ...virtualFlags(row),
        ...isolationFlags()
      }, marketContext));

    const analyzedActualRows = analyzedRows.length;
    const analyzedMirrorRows = 0;
    const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
    const analyzedExact75Rows = analyzedRows.filter((row) => Boolean(getTrueMicroFamilyId(row))).length;
    const analyzedStandardizedLearningRiskRows = analyzedRows.filter((row) => row.standardizedLearningRisk).length;
    const analyzedSyntheticRiskRows = analyzedRows.filter((row) => row.syntheticRisk).length;

    const openPositions = await getOpenPositions({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      virtualOnly: true
    });

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
    let discordAlertsSkippedNoSelectedMicro = 0;
    let discordAlertsSkippedCurrentFit = 0;
    let selectedMicroMatchRows = 0;
    let unselectedMicroEntryRows = 0;

    for (const row of analyzedRows) {
      if (now() - startedAt >= cfg.maxRuntimeMs) {
        runtimeWarnings.push('MAX_RUNTIME_REACHED_ENTRY_LOOP_STOPPED');
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

      const alreadyOpen = await getOpenPosition(row.symbol || row.baseSymbol || row.contractSymbol);

      if (alreadyOpen) {
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
        const position = buildOpenPositionFromEntry(entry);
        await saveOpenPosition({
          ...position,
          ...isolationFlags()
        });

        openPositions.push(position);
        entryRows += 1;
        virtualCreatedRows += 1;

        const discordResult = maybeSendDiscordEntryAlert(entry);
        if (discordResult.queued) discordAlertsQueued += 1;

        actions.push({
          ...entry,
          discordAlertResult: discordResult,
          discordAlertQueued: Boolean(discordResult.queued),
          discordAlertSent: false,
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
      monitorDiagnostics
    });

    const baseResult = {
      runId,
      startedAt,
      ...monitorDiagnostics,
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
      minLiveCandles15m: cfg.minLiveCandles15m,
      maxCandidatesPerSnapshot: cfg.maxCandidatesPerSnapshot,
      analyzeMaxCandidatesPerSnapshot: cfg.analyzeMaxCandidatesPerSnapshot,
      hardMaxCandidatesPerSnapshot: cfg.hardMaxCandidatesPerSnapshot,
      dataConcurrency: cfg.dataConcurrency,
      candidateTimeoutMs: cfg.candidateTimeoutMs,
      analyzeTimeoutMs: cfg.analyzeTimeoutMs,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      marketContextTimeoutMs: cfg.marketContextTimeoutMs,
      maxRuntimeMs: cfg.maxRuntimeMs,

      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags(),

      currentMarketWeather: marketContext.source || null,
      currentMarketUniverse: marketContext.universe || null,
      currentMarketWeatherKey: MARKET_WEATHER_KEY,
      currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
      currentMarketWeatherAgeSec: marketContext.ageSec,
      currentMarketWeatherStale: marketContext.stale,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      currentBullishPct: marketContext.bullishPct,
      currentBearishPct: marketContext.bearishPct,
      currentSqueezePct: marketContext.squeezePct,

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
      analyzedStandardizedLearningRiskRows,
      analyzedSyntheticRiskRows,
      analyzeError,
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
      discordAlertsSent: 0,
      discordAlertsSkippedNoSelectedMicro,
      discordAlertsSkippedCurrentFit,

      selectedMicroMatchRows,
      selectedAlertMicroMatches: selectedMicroMatchRows,
      unselectedMicroEntryRows,

      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,
      actions,
      actionCounts: counts,
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
      activeTrueMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      activeChildTrueMicroFamilies: alertContext.selectedMicroFamilyIds.length,
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
      processScannerSnapshot: true,
      skippedNewEntries: false
    };

    await scopedSetJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, {
      ...baseResult,
      actions: actions.length
    });

    return saveRunMeta(baseResult);
  } finally {
    ACTIVE_RUN_OPTIONS = previousOptions;
  }
}