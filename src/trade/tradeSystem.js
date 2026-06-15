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

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 1000;
const SNAPSHOT_SEARCH_LIMIT = 80;

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

const DEFAULT_MIN_LIVE_CANDLES_15M = 25;
const DEFAULT_MIN_RISK_PCT = 0.0035;
const DEFAULT_MAX_RISK_PCT = 0.03;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;

const DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES = true;

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

const KNOWN_TRADE_SIDES = new Set([
  TARGET_TRADE_SIDE,
  OPPOSITE_TRADE_SIDE
]);

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

function now() {
  return Date.now();
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function namespacedShortKey(key, fallback = 'UNKNOWN') {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}${fallback}`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function keyFromMaybeFunction(fn, arg, fallback) {
  try {
    if (typeof fn === 'function') {
      return fn(arg);
    }
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

function shortScanSnapshotPattern() {
  const fromShort = keyFromMaybeFunction(
    KEYS.short?.scan?.snapshot,
    '*',
    null
  );

  if (fromShort) return namespacedShortKey(fromShort, 'SCAN:SNAPSHOT:*');

  const fromGenericShort = keyFromMaybeFunction(
    KEYS.scan?.shortSnapshot,
    '*',
    null
  );

  if (fromGenericShort) return namespacedShortKey(fromGenericShort, 'SCAN:SNAPSHOT:*');

  const fromGeneric = keyFromMaybeFunction(
    KEYS.scan?.snapshot,
    '*',
    null
  );

  return namespacedShortKey(fromGeneric, 'SCAN:SNAPSHOT:*');
}

const SHORT_KEYS = {
  scan: {
    latest: namespacedShortKey(
      KEYS.short?.scan?.latest ||
        KEYS.scan?.shortLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),
    snapshot: shortScanSnapshotKey,
    snapshotPattern: shortScanSnapshotPattern
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
    maxOneOpenPositionPerSymbol: true,

    longRootTouched: false
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

  if (isScannerFingerprintId(value) || isExecutionFingerprintId(value)) {
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

function virtualFlags(row = {}) {
  return {
    virtualOnly: true,
    paperOnly: true,
    shadowOnly: true,
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
    everyAnalyzeRowCountsSeen: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    oldBucketsMetadataOnly: true,

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

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    defaultRanking: 'dashboardBalancedScore|balancedScore|fairWinrate|totalR|avgR|avgCostR',
    defaultRankingNeverBareWinrate: true,
    noBareWinrateRanking: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    learningStatusRules: {
      observing: 'completed = 0',
      earlyOutcomes: 'completed > 0 && completed < 20',
      activeLearning: 'completed >= 20'
    },

    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL
    },

    ...taxonomyFlags(row)
  };
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

function tradeConfig() {
  const configuredTradeMax = cfgNumber(
    CONFIG.short?.trade?.maxCandidatesPerSnapshot ??
      CONFIG.trade?.shortMaxCandidatesPerSnapshot ??
      CONFIG.trade?.maxCandidatesPerSnapshot,
    0
  );

  const configuredAnalyzeMax = cfgNumber(
    CONFIG.short?.trade?.analyzeMaxCandidatesPerSnapshot ??
      CONFIG.short?.trade?.maxAnalyzeCandidatesPerSnapshot ??
      CONFIG.trade?.shortAnalyzeMaxCandidatesPerSnapshot ??
      CONFIG.trade?.shortMaxAnalyzeCandidatesPerSnapshot ??
      CONFIG.trade?.analyzeMaxCandidatesPerSnapshot ??
      CONFIG.trade?.maxAnalyzeCandidatesPerSnapshot ??
      CONFIG.short?.scanner?.maxCandidates ??
      CONFIG.scanner?.shortMaxCandidates ??
      CONFIG.scanner?.maxCandidates ??
      CONFIG.short?.scanner?.analyzeMaxCandidates ??
      CONFIG.scanner?.shortAnalyzeMaxCandidates ??
      CONFIG.scanner?.analyzeMaxCandidates,
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
  );

  const allowStandardizedLearningRiskFallback = cfgBoolean(
    CONFIG.short?.trade?.allowStandardizedLearningRiskFallback ??
      CONFIG.short?.trade?.allowLearningRiskFallback ??
      CONFIG.short?.trade?.allowSyntheticRiskFallback ??
      CONFIG.trade?.shortAllowStandardizedLearningRiskFallback ??
      CONFIG.trade?.shortAllowLearningRiskFallback ??
      CONFIG.trade?.shortAllowSyntheticRiskFallback ??
      CONFIG.trade?.allowStandardizedLearningRiskFallback ??
      CONFIG.trade?.allowLearningRiskFallback ??
      CONFIG.trade?.allowSyntheticRiskFallback,
    DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK
  );

  const allowStandardizedLearningRiskVirtualEntries = cfgBoolean(
    CONFIG.short?.trade?.allowStandardizedLearningRiskVirtualEntries ??
      CONFIG.short?.trade?.allowLearningRiskVirtualEntries ??
      CONFIG.short?.trade?.allowSyntheticRiskVirtualEntries ??
      CONFIG.trade?.shortAllowStandardizedLearningRiskVirtualEntries ??
      CONFIG.trade?.shortAllowLearningRiskVirtualEntries ??
      CONFIG.trade?.shortAllowSyntheticRiskVirtualEntries ??
      CONFIG.trade?.allowStandardizedLearningRiskVirtualEntries ??
      CONFIG.trade?.allowLearningRiskVirtualEntries ??
      CONFIG.trade?.allowSyntheticRiskVirtualEntries,
    DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES
  );

  return {
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,

    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: cfgBoolean(
      CONFIG.short?.trade?.tradeEveryScannerCandidateVirtual ??
        CONFIG.trade?.shortTradeEveryScannerCandidateVirtual ??
        CONFIG.trade?.tradeEveryScannerCandidateVirtual,
      DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL
    ),

    maxCandidatesPerSnapshot: positiveInt(
      Math.max(
        configuredTradeMax,
        configuredAnalyzeMax,
        cfgNumber(CONFIG.short?.scanner?.maxSymbols ?? CONFIG.scanner?.shortMaxSymbols ?? CONFIG.scanner?.maxSymbols, 0),
        cfgNumber(CONFIG.short?.scanner?.maxCandidates ?? CONFIG.scanner?.shortMaxCandidates ?? CONFIG.scanner?.maxCandidates, 0),
        cfgNumber(CONFIG.short?.scanner?.analyzeMaxCandidates ?? CONFIG.scanner?.shortAnalyzeMaxCandidates ?? CONFIG.scanner?.analyzeMaxCandidates, 0),
        DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
      ),
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      1000
    ),

    maxSnapshotAgeSec: cfgNumber(
      CONFIG.short?.trade?.maxSnapshotAgeSec ??
        CONFIG.trade?.shortMaxSnapshotAgeSec ??
        CONFIG.trade?.maxSnapshotAgeSec,
      8 * 60
    ),

    dataConcurrency: positiveInt(
      CONFIG.short?.trade?.dataConcurrency ??
        CONFIG.trade?.shortDataConcurrency ??
        CONFIG.trade?.dataConcurrency,
      8,
      1,
      20
    ),

    maxSpreadPct: cfgNumber(
      CONFIG.short?.trade?.maxSpreadPct ??
        CONFIG.trade?.shortMaxSpreadPct ??
        CONFIG.trade?.maxSpreadPct,
      0.0015
    ),

    minLiveCandles15m: positiveInt(
      CONFIG.short?.trade?.minLiveCandles15m ??
        CONFIG.short?.trade?.minLiveCandles15M ??
        CONFIG.short?.trade?.minCandles15m ??
        CONFIG.short?.trade?.minCandles15M ??
        CONFIG.trade?.shortMinLiveCandles15m ??
        CONFIG.trade?.shortMinLiveCandles15M ??
        CONFIG.trade?.shortMinCandles15m ??
        CONFIG.trade?.shortMinCandles15M ??
        CONFIG.trade?.minLiveCandles15m ??
        CONFIG.trade?.minLiveCandles15M ??
        CONFIG.trade?.minCandles15m ??
        CONFIG.trade?.minCandles15M,
      DEFAULT_MIN_LIVE_CANDLES_15M,
      0,
      100
    ),

    candleLimit: positiveInt(
      CONFIG.short?.trade?.candleLimit ??
        CONFIG.trade?.shortCandleLimit ??
        CONFIG.trade?.candleLimit,
      100,
      30,
      500
    ),

    allowStandardizedLearningRiskFallback,
    allowStandardizedLearningRiskVirtualEntries,

    allowSyntheticRiskFallback: allowStandardizedLearningRiskFallback,
    allowSyntheticRiskVirtualEntries: allowStandardizedLearningRiskVirtualEntries,

    standardizedLearningRiskRequiresScannerGatePassed: cfgBoolean(
      CONFIG.short?.trade?.standardizedLearningRiskRequiresScannerGatePassed ??
        CONFIG.short?.trade?.syntheticRiskRequiresScannerGatePassed ??
        CONFIG.trade?.shortStandardizedLearningRiskRequiresScannerGatePassed ??
        CONFIG.trade?.shortSyntheticRiskRequiresScannerGatePassed ??
        CONFIG.trade?.standardizedLearningRiskRequiresScannerGatePassed ??
        CONFIG.trade?.syntheticRiskRequiresScannerGatePassed,
      false
    ),

    standardizedLearningRiskRequiresAnalyzeEligible: cfgBoolean(
      CONFIG.short?.trade?.standardizedLearningRiskRequiresAnalyzeEligible ??
        CONFIG.short?.trade?.syntheticRiskRequiresAnalyzeEligible ??
        CONFIG.trade?.shortStandardizedLearningRiskRequiresAnalyzeEligible ??
        CONFIG.trade?.shortSyntheticRiskRequiresAnalyzeEligible ??
        CONFIG.trade?.standardizedLearningRiskRequiresAnalyzeEligible ??
        CONFIG.trade?.syntheticRiskRequiresAnalyzeEligible,
      false
    ),

    standardizedLearningRiskRequiresSpreadGatePassed: cfgBoolean(
      CONFIG.short?.trade?.standardizedLearningRiskRequiresSpreadGatePassed ??
        CONFIG.short?.trade?.syntheticRiskRequiresSpreadGatePassed ??
        CONFIG.trade?.shortStandardizedLearningRiskRequiresSpreadGatePassed ??
        CONFIG.trade?.shortSyntheticRiskRequiresSpreadGatePassed ??
        CONFIG.trade?.standardizedLearningRiskRequiresSpreadGatePassed ??
        CONFIG.trade?.syntheticRiskRequiresSpreadGatePassed,
      false
    ),

    minRiskPct: cfgNumber(
      CONFIG.short?.trade?.minRiskPct ??
        CONFIG.trade?.shortMinRiskPct ??
        CONFIG.trade?.minRiskPct,
      DEFAULT_MIN_RISK_PCT
    ),
    maxRiskPct: cfgNumber(
      CONFIG.short?.trade?.maxRiskPct ??
        CONFIG.trade?.shortMaxRiskPct ??
        CONFIG.trade?.maxRiskPct,
      DEFAULT_MAX_RISK_PCT
    ),
    fallbackRiskPct: cfgNumber(
      CONFIG.short?.trade?.fallbackRiskPct ??
        CONFIG.trade?.shortFallbackRiskPct ??
        CONFIG.trade?.fallbackRiskPct,
      DEFAULT_FALLBACK_RISK_PCT
    ),
    defaultRR: cfgNumber(
      CONFIG.short?.trade?.defaultRR ??
        CONFIG.trade?.shortDefaultRR ??
        CONFIG.trade?.defaultRR,
      1.5
    ),
    minRR: cfgNumber(
      CONFIG.short?.trade?.minRR ??
        CONFIG.trade?.shortMinRR ??
        CONFIG.trade?.minRR,
      0.5
    ),
    positionTimeStopMin: cfgNumber(
      CONFIG.short?.trade?.positionTimeStopMin ??
        CONFIG.trade?.shortPositionTimeStopMin ??
        CONFIG.trade?.positionTimeStopMin,
      720
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

function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function reasonCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.reason || row?.liveEntryBlockedReason || 'UNKNOWN_REASON';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function topReasonCounts(actions = [], limit = 10) {
  return Object.entries(reasonCounts(actions))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({
      reason,
      count
    }));
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

function cleanSideText(value = '') {
  return upper(value, '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', '')
    .replaceAll('LONGDISABLED_SHORT_ONLY', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
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

function isScannerFingerprintId(id = '') {
  const value = upper(id);

  return (
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.includes('LONG_SCANNER_') ||
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('SHORT_SCANNER_') ||
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

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
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

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function symbolTokensFromRow(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
}

function stripSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;
  if (isSelectableTrueMicroId(raw) || isParentTrueMicroId(raw)) {
    return raw.toUpperCase();
  }

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
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
      candidate.symbol
  );

  const symbol =
    normalizeBaseSymbol(candidate.symbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

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
    oldBucketsMetadataOnly: true,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    fixedTaxonomyPreferred: true
  };
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

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferSideFromIds(row = {}) {
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
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,

    row.parentTrueMicroFamilyId,
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

function inferSideFromDefinitions(row = {}) {
  const haystack = [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
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

function inferRowTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

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

    if (KNOWN_TRADE_SIDES.has(direct)) return direct;
  }

  const fromIds = inferSideFromIds(row);

  if (KNOWN_TRADE_SIDES.has(fromIds)) return fromIds;

  const fromDefinitions = inferSideFromDefinitions(row);

  if (KNOWN_TRADE_SIDES.has(fromDefinitions)) return fromDefinitions;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function isMirrorAnalysisRow(row = {}) {
  return Boolean(
    row.isMirrorMicroFamily ||
    row.observationMirror ||
    row.analysisMirror ||
    row.mirrorAnalysisOnly
  );
}

function isLiveScannerRow(row = {}) {
  return !isMirrorAnalysisRow(row);
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

function buildAnalysisVariant(candidate = {}, side, scannerSide) {
  const tradeSide = normalizeTradeSide(side);
  const actualScannerSide = normalizeTradeSide(scannerSide);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (actualScannerSide !== TARGET_TRADE_SIDE) return null;

  return {
    ...candidate,

    ...scannerMetadataFrom(candidate),
    ...sideFlags(),
    ...isolationFlags(),
    ...virtualFlags(candidate),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    analyzeOnly: Boolean(candidate.analyzeOnly),
    discoveryOnly: Boolean(candidate.discoveryOnly),
    tradeDiscoveryOnly: Boolean(candidate.tradeDiscoveryOnly)
  };
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

    ...sideFlags(),
    ...virtualFlags(candidate),
    ...isolationFlags(),

    ...extra
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
    paperOnly: true,
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

    scannerMicroFamilyId: outcome.scannerMicroFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionMicroFamilyId: outcome.executionMicroFamilyId || null,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(outcome.executionMicroFamilyId),
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    exitReason: outcome.exitReason || null,
    exitPrice: outcome.exitPrice ?? null,
    grossR: outcome.grossR ?? outcome.realizedGrossR ?? null,
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
    currentR: outcome.currentR ?? null,
    mfeR: outcome.mfeR ?? null,
    maeR: outcome.maeR ?? null,
    reachedHalfR: Boolean(outcome.reachedHalfR),
    reachedOneR: Boolean(outcome.reachedOneR),
    nearTpSeen: Boolean(outcome.nearTpSeen),

    tpHitNow: Boolean(outcome.tpHitNow || outcome.exitReason === 'TP'),
    slHitNow: Boolean(outcome.slHitNow || outcome.exitReason === 'SL'),
    timeStopHitNow: Boolean(outcome.timeStopHitNow || outcome.exitReason === 'TIME_STOP'),

    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

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
    ...isolationFlags()
  };
}

function buildVirtualExitActions(exits = []) {
  return (Array.isArray(exits) ? exits : [])
    .filter(Boolean)
    .map(buildVirtualExitAction);
}

function buildRunActionCounts(actions = [], virtualExits = []) {
  return actionCounts([
    ...(Array.isArray(actions) ? actions : []),
    ...buildVirtualExitActions(virtualExits)
  ]);
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

function isTrueMicroFamilyRow(row = {}) {
  if (!row) return false;
  if (!isTargetRow(row)) return false;
  if (isScannerFingerprintId(row.trueMicroFamilyId || row.microFamilyId)) return false;
  if (isExecutionFingerprintId(row.trueMicroFamilyId || row.microFamilyId)) return false;

  return Boolean(getTrueMicroFamilyId(row));
}

function buildSelectedAlertContext(activeRotation) {
  const rawRows = Array.isArray(activeRotation?.microFamilies)
    ? activeRotation.microFamilies
    : [];

  const rowByMicroId = new Map();

  for (const row of rawRows) {
    const normalized = normalizeExactTrueMicroRow(row);
    const childId = getTrueMicroFamilyId(normalized);

    if (childId) {
      rowByMicroId.set(childId, normalized);
    }
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

  const microToParentTrueMicroFamilyId = {};

  for (const childId of selectedMicroFamilyIds) {
    microToParentTrueMicroFamilyId[childId] = parentIdFromChild(childId);
  }

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
    microToParentTrueMicroFamilyId,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    empty: !selectedMicroFamilyIds.length,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    selectionPurpose: 'DISCORD_ALERT_ONLY',
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',

    ...taxonomyFlags(),
    ...isolationFlags()
  };
}

function rowMatchesSelectedAlertMicro(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) return false;
  if (!isTrueMicroFamilyRow(row)) return false;

  const exactTrueMicroId = getTrueMicroFamilyId(row);

  if (!exactTrueMicroId) return false;
  if (!isSelectableTrueMicroId(exactTrueMicroId)) return false;

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

function hasValidRiskShape(row = {}) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);
  const tradeSide = inferRowTradeSide(row);

  if (row.learningOnly === true) return false;
  if (tradeSide !== TARGET_TRADE_SIDE) return false;
  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  return tp < entry && entry < sl;
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

  if (isMirrorAnalysisRow(row)) {
    return {
      ok: false,
      reason: 'MIRROR_ANALYSIS_ONLY'
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

  if (!isTrueMicroFamilyRow(row)) {
    return {
      ok: false,
      reason: 'ENTRY_REQUIRES_TRUE_ANALYZE_MICRO_FAMILY'
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

  if (row.syntheticRisk && !cfg.allowSyntheticRiskVirtualEntries) {
    return {
      ok: false,
      reason: 'SYNTHETIC_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING',
      syntheticRisk: true,
      syntheticRiskReason: row.syntheticRiskReason || null
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

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function snapshotPattern() {
  return SHORT_KEYS.scan.snapshotPattern();
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
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function candidateTradeSide(candidate = {}) {
  return inferRowTradeSide(candidate);
}

function countTargetCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows.filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE).length;
}

function countOppositeCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows.filter((candidate) => candidateTradeSide(candidate) === OPPOSITE_TRADE_SIDE).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentTargetSnapshots(redis) {
  const keys = await getKeys(
    redis,
    snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

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

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const targetRows = rows
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags(),
      ...virtualFlags(candidate)
    }));

  const blockedNonShortCandidates = rows
    .filter((candidate) => candidateTradeSide(candidate) !== TARGET_TRADE_SIDE)
    .slice(0, 100)
    .map((candidate) => waitAction(
      normalizeCandidate(candidate),
      'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      {
        skippedBeforeAnalyze: true,
        skippedBeforeLiveFetch: true,
        detectedScannerSide: candidateTradeSide(candidate)
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
    analyzeOnlyCandidatesCount: targetRows.filter((row) => (
      row.tradeDiscoveryOnly ||
      row.discoveryOnly ||
      row.analyzeOnly
    )).length,

    topSymbols: targetRows
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean),

    scannerGateSymbols: targetRows
      .filter((row) => row.scannerGatePassed)
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean)
  };
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();

  const latest = await safeGetSnapshotJson(
    volatileRedis,
    SHORT_KEYS.scan.latest,
    null
  );

  const latestSnapshotId = extractSnapshotId(latest);
  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      source: 'SHORT:SCAN:LATEST_FULL_SNAPSHOT',
      snapshot: latest,
      targetCount: countTargetCandidates(latest),
      oppositeCount: countOppositeCandidates(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (latestSnapshotId) {
    const byId = await safeGetSnapshotJson(
      volatileRedis,
      SHORT_KEYS.scan.snapshot(latestSnapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      candidates.push({
        source: 'SHORT:SCAN:SNAPSHOT_BY_LATEST_ID',
        snapshot: byId,
        targetCount: countTargetCandidates(byId),
        oppositeCount: countOppositeCandidates(byId),
        createdAt: snapshotCreatedAt(byId)
      });
    }
  }

  const recent = await loadRecentTargetSnapshots(volatileRedis);

  for (const item of recent) {
    candidates.push({
      source: `SHORT:SCAN:RECENT_SEARCH:${item.key}`,
      snapshot: item.snapshot,
      targetCount: item.targetCount,
      oppositeCount: item.oppositeCount,
      createdAt: item.createdAt
    });
  }

  const unique = new Map();

  for (const item of candidates) {
    const id = item.snapshot?.snapshotId || item.source;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.targetCount > previous.targetCount ||
      (
        item.targetCount === previous.targetCount &&
        item.createdAt > previous.createdAt
      )
    ) {
      unique.set(id, item);
    }
  }

  const sorted = [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);

  const latestAvailable = sorted[0] || null;

  if (!latestAvailable) return null;

  return normalizeSelectedSnapshot(latestAvailable.snapshot, {
    source: latestAvailable.source,
    reason: latestAvailable.targetCount > 0
      ? 'LATEST_SHORT_SCANNER_SNAPSHOT'
      : 'LATEST_SHORT_SCANNER_SNAPSHOT_WITH_NO_SHORT_CANDIDATES'
  });
}

function enrichMetricsWithScannerAndLiveGates({
  metrics,
  candidate,
  ob
}) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  const scannerMeta = scannerMetadataFrom(candidate, metrics);

  const spreadPct = safeNumber(
    metrics?.spreadPct ??
      ob?.spreadPct,
    CONFIG.short?.cost?.fallbackSpreadPct ||
      CONFIG.cost?.shortFallbackSpreadPct ||
      CONFIG.cost?.fallbackSpreadPct ||
      0.0008
  );

  const enriched = {
    ...metrics,
    ...scannerMeta,
    ...sideFlags(),
    ...isolationFlags(),
    ...virtualFlags(metrics),

    entryRelaxationProfile: cfg.entryRelaxationProfile,
    qualityMeasurementProfile: cfg.qualityMeasurementProfile,
    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: cfg.tradeEveryScannerCandidateVirtual,
    riskEnginePreferredButNotRequiredForLearning: true,
    standardizedLearningRiskFallbackEnabled: cfg.allowStandardizedLearningRiskFallback,

    minLiveCandles15m: cfg.minLiveCandles15m,

    snapshotId: normalized.snapshotId || metrics.snapshotId || null,

    symbol: normalized.symbol || metrics.symbol,
    baseSymbol: normalized.baseSymbol || metrics.baseSymbol,
    contractSymbol: normalized.contractSymbol || metrics.contractSymbol,

    price: safeNumber(normalized.price ?? metrics.price ?? ob?.mid, 0),

    scannerScore: safeNumber(
      normalized.scannerScore ??
        normalized.moveScore ??
        metrics.scannerScore,
      0
    ),

    moveScore: safeNumber(
      normalized.moveScore ??
        normalized.scannerScore ??
        metrics.moveScore,
      0
    ),

    scannerReason: normalized.scannerReason || metrics.scannerReason || null,
    scannerTs: normalized.scannerTs || metrics.scannerTs || null,

    scannerGatePassed: normalized.scannerGatePassed !== false,
    scannerGateReason: normalized.scannerGateReason || null,

    analyzeEligible: normalized.analyzeEligible !== false,
    tradeDiscoveryOnly: Boolean(normalized.tradeDiscoveryOnly),
    discoveryOnly: Boolean(normalized.discoveryOnly),
    analyzeOnly: Boolean(normalized.analyzeOnly),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,
    mirrorOfSide: null,

    passesMoveFilter: normalized.passesMoveFilter !== false,
    passesVolumeFilter: normalized.passesVolumeFilter !== false,
    hasDirectionalSide: normalized.hasDirectionalSide !== false,

    sideConfidence: normalized.sideConfidence || metrics.sideConfidence || null,

    fakeBreakout: Boolean(normalized.fakeBreakout || metrics.fakeBreakout),
    fakeBreakoutRisk: Boolean(normalized.fakeBreakoutRisk || metrics.fakeBreakoutRisk),
    fakeBreakoutReason: normalized.fakeBreakoutReason || metrics.fakeBreakoutReason || null,
    breakoutType: normalized.breakoutType || metrics.breakoutType || null,

    pullbackConfirmed: Boolean(normalized.pullbackConfirmed || metrics.pullbackConfirmed),
    retestConfirmed: Boolean(normalized.retestConfirmed || metrics.retestConfirmed),
    sweepConfirmed: Boolean(normalized.sweepConfirmed || metrics.sweepConfirmed),

    spreadPct,
    liveSpreadPct: spreadPct,
    maxSpreadPct: cfg.maxSpreadPct,
    liveSpreadGatePassed: spreadPct <= cfg.maxSpreadPct,

    learningOnly: Boolean(metrics.learningOnly),

    validShortRiskShape: hasValidRiskShape({
      ...metrics,
      ...sideFlags()
    }),

    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    positionTimeStopMin: cfg.positionTimeStopMin,

    liveDataTs: now()
  };

  return {
    ...enriched,
    liveRiskValid: hasValidRiskShape(enriched)
  };
}

function candidateFallbackPrice(normalized = {}, data = {}) {
  const ob = data.ob || {};

  return safeNumber(
    ob.mid ??
      normalized.price ??
      normalized.markPrice ??
      normalized.currentPrice ??
      normalized.lastPrice ??
      normalized.close ??
      normalized.entry,
    0
  );
}

function buildObservationOnlyMetrics({
  normalized,
  data = {},
  reason = 'SHORT_RISK_INVALID'
}) {
  const ob = data.ob || {};
  const spreadPct = safeNumber(
    ob.spreadPct ??
      normalized.spreadPct ??
      CONFIG.short?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.shortFallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  const mid = candidateFallbackPrice(normalized, data);

  return enrichMetricsWithScannerAndLiveGates({
    metrics: {
      symbol: normalized.symbol,
      baseSymbol: normalized.baseSymbol,
      contractSymbol: normalized.contractSymbol,

      ...scannerMetadataFrom(normalized),
      ...sideFlags(),

      price: mid,

      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,

      riskPct: 0,
      rewardPct: 0,

      confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
      sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),

      spreadPct,
      depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
      fundingRate: safeNumber(data.funding?.rate, 0),

      rsiZone: normalized.rsiZone || null,
      rsiCoarse: normalized.rsiCoarse || null,
      flow: normalized.flow || null,
      flowCoarse: normalized.flowCoarse || null,
      obRelation: normalized.obRelation || null,
      btcRelation: normalized.btcRelation || null,
      btcState: normalized.btcState || null,
      regime: normalized.regime || null,
      regimeCoarse: normalized.regimeCoarse || null,

      observationOnly: true,
      analysisInputOnly: true,
      learningOnly: true,
      liveRiskValid: false,
      liveEntryBlockedReason: reason,

      scannerWideVirtualLearning: true,
      tradeEveryScannerCandidateVirtual: tradeConfig().tradeEveryScannerCandidateVirtual,
      entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
      qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE
    },
    candidate: {
      ...normalized,
      liveEntryBlockedReason: reason
    },
    ob
  });
}

function buildStandardizedShortLearningRiskMetrics({
  normalized,
  data = {},
  reason = 'STANDARDIZED_SHORT_LEARNING_TP_SL'
}) {
  const cfg = tradeConfig();
  const ob = data.ob || {};

  const spreadPct = safeNumber(
    ob.spreadPct ??
      normalized.spreadPct ??
      CONFIG.short?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.shortFallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  const mid = candidateFallbackPrice(normalized, data);

  const scannerGatePassed = normalized.scannerGatePassed !== false;
  const analyzeEligible = normalized.analyzeEligible !== false;
  const spreadGatePassed = spreadPct <= cfg.maxSpreadPct;

  if (!cfg.allowStandardizedLearningRiskFallback) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_LEARNING_RISK_FALLBACK_DISABLED'
    });
  }

  if (cfg.standardizedLearningRiskRequiresScannerGatePassed && !scannerGatePassed) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_SHORT_RISK_BLOCKED_SCANNER_GATE_FAILED'
    });
  }

  if (cfg.standardizedLearningRiskRequiresAnalyzeEligible && !analyzeEligible) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_SHORT_RISK_BLOCKED_ANALYZE_NOT_ELIGIBLE'
    });
  }

  if (cfg.standardizedLearningRiskRequiresSpreadGatePassed && !spreadGatePassed) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_SHORT_RISK_BLOCKED_SPREAD_TOO_WIDE'
    });
  }

  if (mid <= 0) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_SHORT_RISK_NO_PRICE'
    });
  }

  const rr = Math.max(
    cfg.minRR,
    cfg.defaultRR,
    0.5
  );

  const riskPct = clampNumber(
    cfg.fallbackRiskPct,
    Math.max(0.0005, cfg.minRiskPct),
    Math.max(cfg.minRiskPct, cfg.maxRiskPct)
  );

  const entry = mid;
  const sl = entry * (1 + riskPct);
  const tp = Math.max(entry * (1 - riskPct * rr), entry * 0.0001);
  const rewardPct = Math.max(0, (entry - tp) / entry);

  return enrichMetricsWithScannerAndLiveGates({
    metrics: {
      symbol: normalized.symbol,
      baseSymbol: normalized.baseSymbol,
      contractSymbol: normalized.contractSymbol,

      ...scannerMetadataFrom(normalized),
      ...sideFlags(),

      price: mid,

      entry,
      sl,
      tp,
      rr,

      riskPct,
      rewardPct,

      confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
      sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),

      spreadPct,
      depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
      fundingRate: safeNumber(data.funding?.rate, 0),

      rsiZone: normalized.rsiZone || null,
      rsiCoarse: normalized.rsiCoarse || null,
      flow: normalized.flow || null,
      flowCoarse: normalized.flowCoarse || null,
      obRelation: normalized.obRelation || null,
      btcRelation: normalized.btcRelation || null,
      btcState: normalized.btcState || null,
      regime: normalized.regime || null,
      regimeCoarse: normalized.regimeCoarse || null,

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

      scannerWideVirtualLearning: true,
      tradeEveryScannerCandidateVirtual: cfg.tradeEveryScannerCandidateVirtual,
      entryRelaxationProfile: cfg.entryRelaxationProfile,
      qualityMeasurementProfile: cfg.qualityMeasurementProfile
    },
    candidate: {
      ...normalized,
      liveEntryBlockedReason: null
    },
    ob
  });
}

function buildActualRiskWaitIfNeeded({
  normalized,
  scannerSide,
  metricsRows
}) {
  if (scannerSide !== TARGET_TRADE_SIDE) {
    return waitAction(
      {
        ...normalized,
        side: scannerSide,
        tradeSide: scannerSide
      },
      'LONG_DISABLED_SHORT_ONLY_SYSTEM'
    );
  }

  const hasShortMetrics = metricsRows.some((row) => (
    inferRowTradeSide(row) === TARGET_TRADE_SIDE &&
    hasValidRiskShape(row)
  ));

  if (hasShortMetrics) return null;

  return waitAction(
    {
      ...normalized,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    },
    'SHORT_NO_TP_SL_AVAILABLE_FOR_VIRTUAL_LEARNING'
  );
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
      actions: [
        waitAction(
          {
            ...normalized,
            tradeSide: scannerSide,
            side: normalized.side
          },
          'LONG_DISABLED_SHORT_ONLY_SYSTEM',
          {
            skippedBeforeAnalyze: true,
            skippedBeforeLiveFetch: true,
            detectedScannerSide: scannerSide
          }
        )
      ],
      metrics: []
    };
  }

  const data = await fetchLiveCandidateData(normalized)
    .catch((error) => ({ error }));

  if (data.error || data.ob?.fetchFailed) {
    const fallback = buildStandardizedShortLearningRiskMetrics({
      normalized,
      data,
      reason: 'LIVE_DATA_FAILED_STANDARDIZED_LEARNING_TP_SL'
    });

    const riskWait = buildActualRiskWaitIfNeeded({
      normalized,
      scannerSide,
      metricsRows: [fallback]
    });

    return {
      actions: riskWait ? [riskWait] : [],
      metrics: [fallback]
    };
  }

  const hasEnough15mCandles = (
    Array.isArray(data.candles15m) &&
    data.candles15m.length >= cfg.minLiveCandles15m
  );

  if (!hasEnough15mCandles) {
    const fallback = buildStandardizedShortLearningRiskMetrics({
      normalized,
      data,
      reason: 'INSUFFICIENT_LIVE_CANDLES_STANDARDIZED_LEARNING_TP_SL'
    });

    const riskWait = buildActualRiskWaitIfNeeded({
      normalized,
      scannerSide,
      metricsRows: [fallback]
    });

    return {
      actions: riskWait
        ? [
          waitAction(normalized, 'INSUFFICIENT_LIVE_CANDLES_15M_BUT_LEARNING_FALLBACK_FAILED', {
            candleCount: data.candles15m?.length || 0,
            requiredCandleCount: cfg.minLiveCandles15m
          })
        ]
        : [],
      metrics: [fallback]
    };
  }

  const generatedMetrics = buildRiskAndLiveMetricsForBothSides({
    candidate: {
      ...normalized,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
    },
    ob: data.ob,
    funding: data.funding,
    candles15m: data.candles15m,
    candles1h: data.candles1h,
    btcState: normalized.btcState || candidate.btcState,
    regime: normalized.regime || candidate.regime
  });

  const rawMetrics = Array.isArray(generatedMetrics)
    ? generatedMetrics
    : [];

  const metrics = rawMetrics
    .map((row) => {
      const rowSide = inferRowTradeSide(row);

      if (rowSide !== TARGET_TRADE_SIDE) return null;

      const variant = buildAnalysisVariant(
        normalized,
        TARGET_TRADE_SIDE,
        scannerSide
      );

      if (!variant) return null;

      return enrichMetricsWithScannerAndLiveGates({
        metrics: {
          ...row,
          riskSource: row.riskSource || 'RISK_ENGINE',
          riskEngineRisk: true,
          standardizedLearningRisk: false
        },
        candidate: variant,
        ob: data.ob
      });
    })
    .filter(Boolean);

  const hasValidShortRisk = metrics.some(hasValidRiskShape);

  const finalMetrics = hasValidShortRisk
    ? metrics
    : [
      buildStandardizedShortLearningRiskMetrics({
        normalized,
        data,
        reason: 'RISK_ENGINE_EMPTY_STANDARDIZED_SHORT_LEARNING_TP_SL'
      })
    ];

  const riskWait = buildActualRiskWaitIfNeeded({
    normalized,
    scannerSide,
    metricsRows: finalMetrics
  });

  return {
    actions: riskWait ? [riskWait] : [],
    metrics: finalMetrics
  };
}

async function safeProcessCandidate(candidate) {
  try {
    return await processCandidate(candidate);
  } catch (error) {
    const normalized = normalizeCandidate(candidate);

    const fallback = buildStandardizedShortLearningRiskMetrics({
      normalized,
      reason: 'CANDIDATE_PROCESS_ERROR_STANDARDIZED_LEARNING_TP_SL'
    });

    const fallbackValid = hasValidRiskShape(fallback);

    const riskWait = buildActualRiskWaitIfNeeded({
      normalized,
      scannerSide: TARGET_TRADE_SIDE,
      metricsRows: [fallback]
    });

    return {
      actions: fallbackValid && !riskWait
        ? []
        : [
          waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
            error: error?.message || String(error),
            learningFallbackAttempted: true,
            learningFallbackValid: fallbackValid
          }),
          ...(riskWait ? [riskWait] : [])
        ],
      metrics: [fallback]
    };
  }
}

function buildVirtualEntryAction({
  row,
  alertContext,
  selectedWeeklyStats,
  riskFraction,
  virtualGate,
  discordAlertEligible
}) {
  const normalized = normalizeExactTrueMicroRow(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(normalized);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(normalized);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

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
    reason: virtualGate.reason || (
      row.standardizedLearningRisk
        ? 'SHORT_VIRTUAL_LEARNING_STANDARDIZED_TP_SL'
        : 'SHORT_VIRTUAL_RISK_ENGINE_VALID'
    ),

    shadowOnly: false,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,

    selectedMicroFamilyAlert: Boolean(discordAlertEligible),
    discordAlertEligible: Boolean(discordAlertEligible),
    discordAlertReason: discordAlertEligible
      ? 'SELECTED_SHORT_TRUE_MICRO_FAMILY_EXACT_75_CHILD_MATCH'
      : alertContext.empty
        ? 'NO_MANUAL_75_CHILD_TRUE_MICRO_FAMILY_SELECTED'
        : 'TRUE_MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT',

    selectedMacroFamilyId: null,
    activeMacroFamilyId: null,
    selectedParentTrueMicroFamilyId: parentTrueMicroFamilyId,
    activeParentTrueMicroFamilyId: parentTrueMicroFamilyId,

    selectedWeeklyStats,
    weeklyStats: selectedWeeklyStats,

    riskFraction,
    virtualGate,

    btcRelation: row.btcRelation,

    liveEligible: Boolean(discordAlertEligible),

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    exactTrueMicroOnly: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    validShortRiskShape: true,
    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    positionTimeStopMin: tradeConfig().positionTimeStopMin,

    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: true,
    riskSource: row.riskSource || (
      row.standardizedLearningRisk
        ? 'LEARNING_STANDARDIZED_TP_SL'
        : 'RISK_ENGINE'
    ),
    riskEngineRisk: Boolean(row.riskEngineRisk),
    standardizedLearningRisk: Boolean(row.standardizedLearningRisk),

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,

    entryCreatedAt: now()
  };
}

function maybeSendDiscordEntryAlert(entry = {}) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: entry.discordAlertReason || 'TRUE_MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
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

  if (riskValidRows <= 0) {
    return 'NO_TP_SL_AVAILABLE_FOR_SCANNER_WIDE_VIRTUAL_LEARNING';
  }

  if (analyzedRows <= 0) {
    return 'ANALYZE_RETURNED_NO_SHORT_ROWS';
  }

  if (analyzedRiskValidRows <= 0) {
    return 'ANALYZE_DID_NOT_RETURN_RISK_VALID_ROWS';
  }

  if (analyzedExact75Rows <= 0) {
    return 'ANALYZE_DID_NOT_ASSIGN_EXACT_75_CHILD_TRUE_MICRO_FAMILY';
  }

  if (virtualCreatedRows <= 0) {
    return 'VIRTUAL_ENTRY_GATE_OR_SYMBOL_ALREADY_OPEN';
  }

  if (virtualCreatedRows > 0 && virtualExitRows <= 0 && openPositionCountAfterEntries > 0) {
    return 'POSITIONS_OPEN_WAITING_FOR_TP_SL_OR_TIME_STOP';
  }

  if (virtualCreatedRows > 0 && virtualExitRows > 0) {
    return 'HEALTHY_SHORT_75_CHILD_LEARNING_PIPELINE';
  }

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
  openPositionCountAfterEntries
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
    riskEnginePreferredButNotRequiredForLearning: true,
    standardizedLearningRiskFallbackEnabled: true,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',

    completedIsPureClosedVirtualOutcome: true,
    completedComesOnlyFrom: 'TP_SL_OR_TIME_STOP',
    scoringRSource: 'netR',

    recommendedFreezeDays: FREEZE_MEASUREMENT_RECOMMENDED_DAYS,

    completedThresholds: {
      earlySignal: MIN_COMPLETED_EARLY_SIGNAL,
      reasonableSignal: MIN_COMPLETED_REASONABLE_SIGNAL,
      strongSignal: MIN_COMPLETED_STRONG_SIGNAL,
      activeLearning: MIN_COMPLETED_ACTIVE_LEARNING
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
      entryRows,
      virtualCreatedRows,
      virtualExitRows,
      waitRows,
      skippedByExistingSymbol: counts.skippedByExistingSymbol || 0,
      selectedAlertMicroMatches: counts.selectedAlertMicroMatches || 0,
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

    interpretation: {
      healthy: 'Scanner coins worden breed virtueel SHORT getraded, Analyze zet risk-valid rows exact in een 75-child trueMicroFamilyId, completed komt later via TP/SL/TIME_STOP.',
      ifVirtualCreatedLow: 'Meestal symbol-lock, geen exact 75-child trueMicroFamilyId, of geen geldige TP/SL fallback.',
      ifVirtualCreatedHighAndExitLow: 'Posities lopen nog; completed komt later.',
      ifRiskValidLow: 'Er is geen TP/SL beschikbaar, ook fallback kon geen prijs vinden.',
      ifAnalyzedExact75Low: 'Analyze gaf geen exact selecteerbare 75-child trueMicroFamilyId terug.',
      ifSymbolAlreadyOpenHigh: 'Eén open positie per symbol blokkeert extra entries. Dit voorkomt dubbele vervuiling.',
      ifSnapshotAlreadyProcessedHigh: 'Geen nieuwe entries totdat scanner een nieuwe snapshot levert.'
    },

    measurementPrinciple: 'Alles bearish van scanner virtueel laten leren; Discord alleen voor exact geselecteerde bewezen 75-child SHORT trueMicroFamilyIds.'
  };
}

async function scopedSetJson(redis, key, value, options = {}) {
  try {
    assertKeyAllowedForWriteScope(
      KEYS.scopes?.TRADE_RUN || 'TRADE_RUN',
      key
    );
  } catch (error) {
    if (!String(key || '').startsWith(SHORT_KEY_PREFIX)) {
      throw error;
    }
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
      scanSnapshotPattern: SHORT_KEYS.scan.snapshotPattern()
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

  await scopedSetJson(
    durableRedis,
    SHORT_KEYS.trade.runMeta,
    finalResult
  );

  return finalResult;
}

export async function runTradeSystem(options = {}) {
  const cfg = tradeConfig();
  const sizing = sizingConfig();

  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run_short');
  const startedAt = now();

  const forceProcessSnapshot = Boolean(options.forceProcessSnapshot || options.force);
  const monitorOnly = Boolean(options.monitorOnly);

  const priceFetcher = async (symbol) => fetchMidPrice(symbol);

  const realExits = [];

  const virtualExits = await monitorOpenPositions({
    priceFetcher,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    weekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    virtualOnly: true,
    paperOnly: true,
    shadowOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true
  });

  const shadowExits = virtualExits;

  if (monitorOnly) {
    const actions = [];

    return saveRunMeta({
      runId,
      startedAt,
      actions,
      realExits,
      virtualExits,
      shadowExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'MONITOR_ONLY',
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false,
      ...isolationFlags()
    });
  }

  const snapshot = await getLatestSnapshot();

  if (!snapshot?.snapshotId) {
    const actions = [];

    return saveRunMeta({
      runId,
      startedAt,
      actions,
      realExits,
      virtualExits,
      shadowExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'NO_SHORT_SCANNER_SNAPSHOT',
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: true,
      ...isolationFlags()
    });
  }

  const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

  if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
    const actions = Array.isArray(snapshot.blockedNonShortCandidates)
      ? snapshot.blockedNonShortCandidates
      : [];

    return saveRunMeta({
      runId,
      startedAt,
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
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false,
      ...isolationFlags()
    });
  }

  const lastProcessed = await getJson(
    durableRedis,
    SHORT_KEYS.trade.lastProcessedSnapshot,
    null
  );

  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  if (sameSnapshot && !forceProcessSnapshot) {
    const actions = Array.isArray(snapshot.blockedNonShortCandidates)
      ? snapshot.blockedNonShortCandidates
      : [];

    return saveRunMeta({
      runId,
      startedAt,
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
      actionCounts: buildRunActionCounts(actions, virtualExits),
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      processScannerSnapshot: false,
      ...isolationFlags()
    });
  }

  const activeRotation = await getActiveRotation({
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
  }).catch(() => null);

  const alertContext = buildSelectedAlertContext(activeRotation);

  const preAnalyzeBlockedActions = Array.isArray(snapshot.blockedNonShortCandidates)
    ? snapshot.blockedNonShortCandidates
    : [];

  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .slice(0, cfg.maxCandidatesPerSnapshot)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags(),
      ...virtualFlags(candidate),

      btcState: snapshot.btcState,
      regime: snapshot.regime
    }));

  const shortCandidateCount = candidates.length;
  const nonShortCandidateCount = snapshot.blockedNonShortCandidatesCount || 0;

  const processed = await mapConcurrent(
    candidates,
    cfg.dataConcurrency,
    safeProcessCandidate
  );

  const earlyActions = [
    ...preAnalyzeBlockedActions,
    ...processed
      .flatMap((row) => Array.isArray(row?.actions) ? row.actions : [])
      .filter(Boolean)
  ];

  const liveRows = processed
    .flatMap((row) => Array.isArray(row?.metrics) ? row.metrics : [])
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) => ({
      ...row,
      ...sideFlags(),
      ...isolationFlags(),
      ...virtualFlags(row)
    }));

  const actualLiveRows = liveRows.filter(isLiveScannerRow).length;
  const mirrorRows = liveRows.filter(isMirrorAnalysisRow).length;
  const observationOnlyRows = liveRows.filter((row) => row.observationOnly || row.analysisInputOnly).length;
  const standardizedLearningRiskRows = liveRows.filter((row) => row.standardizedLearningRisk).length;
  const syntheticRiskRows = liveRows.filter((row) => row.syntheticRisk).length;
  const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
  const riskValidRows = liveRows.filter(hasValidRiskShape).length;

  let analyzedRowsRaw = [];
  let analyzeError = null;

  try {
    analyzedRowsRaw = await analyzeCandidatesBatch(liveRows, {
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
      paperOnly: true,
      shadowOnly: true,
      virtualLearning: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeCallsDisabled: true,

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

      shortRiskRule: 'tp < entry < sl',
      shortTpExitRule: 'price <= tp',
      shortSlExitRule: 'price >= sl',
      shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
      shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)'
    });
  } catch (error) {
    analyzeError = error?.message || String(error);
    analyzedRowsRaw = [];
  }

  const analyzedRows = analyzedRowsRaw
    .filter(Boolean)
    .filter(isTargetRow)
    .filter((row) => !isMirrorAnalysisRow(row))
    .map((row) => ({
      ...normalizeExactTrueMicroRow(row),
      ...scannerMetadataFrom(row),
      ...sideFlags(),
      ...virtualFlags(row),
      ...isolationFlags()
    }));

  const analyzedActualRows = analyzedRows.filter(isLiveScannerRow).length;
  const analyzedMirrorRows = analyzedRows.filter(isMirrorAnalysisRow).length;
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

  let selectedMicroMatchRows = 0;
  let unselectedMicroEntryRows = 0;

  for (const row of analyzedRows) {
    const trueMicroFamilyId = getTrueMicroFamilyId(row);

    if (!isTargetRow(row)) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        action: 'WAIT',
        reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: false,
        liveEligible: false,
        ...sideFlags(),
        ...isolationFlags()
      });

      continue;
    }

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

    const selectedWeeklyStats = getSelectedWeeklyStats(
      alertContext,
      trueMicroFamilyId,
      row
    );

    const sizingStats = selectedWeeklyStats || row;

    const riskFraction = sizing.enabled
      ? riskFractionForEntry({
        weeklyStats: sizingStats,
        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE
      })
      : sizing.baseRiskPct;

    const discordAlertEligible = rowMatchesSelectedAlertMicro(alertContext, row);

    if (discordAlertEligible) {
      discordAlertEligibleRows += 1;
      selectedMicroMatchRows += 1;
    } else {
      discordAlertsSkippedNoSelectedMicro += 1;
      unselectedMicroEntryRows += 1;
    }

    const entry = buildVirtualEntryAction({
      row,
      alertContext,
      selectedWeeklyStats,
      riskFraction,
      virtualGate,
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
      selectedAlertMicroMatches: selectedMicroMatchRows
    },
    openPositionCountBeforeEntries,
    openPositionCountAfterEntries: openPositions.length
  });

  const lastProcessedRow = {
    snapshotId: snapshot.snapshotId,
    processedAt: now(),
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

    minLiveCandles15m: cfg.minLiveCandles15m,
    allowStandardizedLearningRiskFallback: cfg.allowStandardizedLearningRiskFallback,
    allowStandardizedLearningRiskVirtualEntries: cfg.allowStandardizedLearningRiskVirtualEntries,
    standardizedLearningRiskRequiresScannerGatePassed: cfg.standardizedLearningRiskRequiresScannerGatePassed,
    standardizedLearningRiskRequiresAnalyzeEligible: cfg.standardizedLearningRiskRequiresAnalyzeEligible,
    standardizedLearningRiskRequiresSpreadGatePassed: cfg.standardizedLearningRiskRequiresSpreadGatePassed,
    minRiskPct: cfg.minRiskPct,
    maxRiskPct: cfg.maxRiskPct,
    fallbackRiskPct: cfg.fallbackRiskPct,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    candidates: candidates.length,
    shortCandidateCount,
    longCandidateCount: 0,
    nonShortCandidateCount,

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
    shadowExitRows: shadowExits.length,
    realExitRows: 0,

    discordAlertEligibleRows,
    discordAlertsQueued,
    discordAlertsSent: 0,
    discordAlertsSkippedNoSelectedMicro,

    selectedMicroMatchRows,
    selectedAlertMicroMatches: selectedMicroMatchRows,
    unselectedMicroEntryRows,

    openPositionCountBeforeEntries,
    openPositionCountAfterEntries: openPositions.length,

    actions: actions.length,
    actionCounts: counts,
    qualityAudit,

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

    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot: true
  };

  await scopedSetJson(
    durableRedis,
    SHORT_KEYS.trade.lastProcessedSnapshot,
    lastProcessedRow
  );

  return saveRunMeta({
    runId,
    startedAt,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec: Math.round(snapshotAgeSec),

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

    minLiveCandles15m: cfg.minLiveCandles15m,
    allowStandardizedLearningRiskFallback: cfg.allowStandardizedLearningRiskFallback,
    allowStandardizedLearningRiskVirtualEntries: cfg.allowStandardizedLearningRiskVirtualEntries,
    standardizedLearningRiskRequiresScannerGatePassed: cfg.standardizedLearningRiskRequiresScannerGatePassed,
    standardizedLearningRiskRequiresAnalyzeEligible: cfg.standardizedLearningRiskRequiresAnalyzeEligible,
    standardizedLearningRiskRequiresSpreadGatePassed: cfg.standardizedLearningRiskRequiresSpreadGatePassed,
    minRiskPct: cfg.minRiskPct,
    maxRiskPct: cfg.maxRiskPct,
    fallbackRiskPct: cfg.fallbackRiskPct,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),

    candidates: candidates.length,
    shortCandidateCount,
    longCandidateCount: 0,
    nonShortCandidateCount,

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
    shadowExitRows: shadowExits.length,
    realExitRows: 0,

    discordAlertEligibleRows,
    discordAlertsQueued,
    discordAlertsSent: 0,
    discordAlertsSkippedNoSelectedMicro,

    selectedMicroMatchRows,
    selectedAlertMicroMatches: selectedMicroMatchRows,
    unselectedMicroEntryRows,

    openPositionCountBeforeEntries,
    openPositionCountAfterEntries: openPositions.length,

    actions,
    actionCounts: counts,
    qualityAudit,

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
  });
}