// ================= FILE: src/trade/tradeSystem.js =================
// SHORT-only virtual trade system.
//
// Runtime safety:
// - reads an existing scanner snapshot; never runs or overwrites the scanner;
// - processes large snapshots in resumable chunks;
// - respects the deadline supplied by api/trade/run.js;
// - Analyze observations are written through the batched Analyze engine;
// - open-position checks use one loaded symbol set instead of one Redis read
//   per candidate;
// - full scanner rows, candles, market-universe rows and weather rows are not
//   persisted in trade run metadata or positions;
// - real exchange orders remain disabled.

import { CONFIG } from '../config.js';
import * as KeysApi from '../keys.js';

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
  sideToTradeSide,
  parseShortTaxonomyMicroId,
  isSelectableShortTrueMicroFamilyId,
  validLearningId
} from '../utils.js';

import {
  fetchCandles,
  fetchFunding,
  fetchOrderBook,
  analyzeOrderBook
} from '../market/bitgetClient.js';

import { analyzeCandidatesBatch } from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import { buildRiskAndLiveMetricsForBothSides } from './riskEngine.js';

import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  saveOpenPosition,
  monitorOpenPositions
} from './positionEngine.js';

import { riskFractionForEntry } from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

const KEYS = KeysApi.KEYS || KeysApi.keys || null;

if (!KEYS || typeof KEYS !== 'object') {
  throw new Error(
    'TRADE_SYSTEM_KEYS_API_MISSING: keys.js must export KEYS or keys'
  );
}

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 1000;
const DEFAULT_MAX_CANDIDATES_PER_INVOCATION = 60;
const SNAPSHOT_SEARCH_LIMIT = 12;

const DEFAULT_RUNTIME_BUDGET_MS = 50_000;
const DEFAULT_STOP_BEFORE_DEADLINE_MS = 6_000;
const DEFAULT_MIN_REMAINING_FOR_NEW_BATCH_MS = 12_000;
const DEFAULT_MAX_CONTINUATION_AGE_SEC = 30 * 60;
const DEFAULT_RUN_RESPONSE_ACTION_LIMIT = 100;
const DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT = 20;

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

const LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const PARENT_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RUN_SCOPE = 'TRADE_ONLY';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_SHORT_SCANNER_LATEST_ONLY';

const ENTRY_RELAXATION_PROFILE =
  'SHORT_SCANNER_WIDE_VIRTUAL_LEARNING_V1';

const QUALITY_MEASUREMENT_PROFILE =
  'SHORT_MICRO_FAMILY_TP_SL_LEARNING_V1';

const DEFAULT_MIN_LIVE_CANDLES_15M = 25;
const DEFAULT_MIN_RISK_PCT = 0.0035;
const DEFAULT_MAX_RISK_PCT = 0.03;
const DEFAULT_FALLBACK_RISK_PCT = 0.005;

const DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK = true;
const DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES = true;

const DEFAULT_DISCORD_REQUIRE_CURRENT_FIT = true;
const DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE = 35;
const DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC = 15 * 60;

const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

function now() {
  return Date.now();
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flat(Infinity)
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  ];
}

function compactText(value, maxLength = 240) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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

function positiveInt(
  value,
  fallback,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
) {
  const n = Math.floor(cfgNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function namespacedShortKey(key, fallback = 'UNKNOWN') {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}${fallback}`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) {
    return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;
  }

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

  if (fromShort) {
    return namespacedShortKey(fromShort, `SCAN:SNAPSHOT:${snapshotId}`);
  }

  const fromGenericShort = keyFromMaybeFunction(
    KEYS.scan?.shortSnapshot,
    snapshotId,
    null
  );

  if (fromGenericShort) {
    return namespacedShortKey(
      fromGenericShort,
      `SCAN:SNAPSHOT:${snapshotId}`
    );
  }

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

  if (fromGenericShort) {
    return namespacedShortKey(fromGenericShort, 'SCAN:SNAPSHOT:*');
  }

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
    ),

    snapshotProgress: namespacedShortKey(
      KEYS.short?.trade?.snapshotProgress ||
        KEYS.trade?.shortSnapshotProgress ||
        KEYS.trade?.snapshotProgress,
      'TRADE:SNAPSHOT_PROGRESS'
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

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradeLastProcessedSnapshot: true,
    writesTradeSnapshotProgress: true,
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

function taxonomyFlags(row = {}) {
  const childId = getTrueMicroFamilyId(row);
  const taxonomy = childId ? parseShortTaxonomyMicroId(childId) : null;

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

    setupType: taxonomy?.setup || row.setupType || null,
    regimeBucket: taxonomy?.regime || row.regimeBucket || null,
    confirmationProfile:
      taxonomy?.confirmationProfile || row.confirmationProfile || null,

    parentTrueMicroFamilyId:
      taxonomy?.parentTrueMicroFamilyId ||
      row.parentTrueMicroFamilyId ||
      null,
    childTrueMicroFamilyId:
      taxonomy?.childTrueMicroFamilyId || row.childTrueMicroFamilyId || null,
    coarseMicroFamilyId:
      taxonomy?.parentTrueMicroFamilyId || row.coarseMicroFamilyId || null,

    parent15MetadataOnly: true,
    parentTrueMicroSelectable: false,
    child75Selectable: Boolean(taxonomy?.selectable)
  };
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

    learningOnly: Boolean(row.learningOnly),
    microFamilyLearning: true,

    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual:
      DEFAULT_TRADE_EVERY_SCANNER_CANDIDATE_VIRTUAL,
    riskEnginePreferredButNotRequiredForLearning: true,
    standardizedLearningRiskFallbackEnabled:
      DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK,

    observationFirst: true,
    observationFirstLearning: true,
    everyAnalyzeRowCountsSeen: false,
    observationAlwaysCounted: false,
    observationDedupeRequired: true,
    observationDedupeEnabled: true,
    seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',
    observationDedupeKeySource: 'snapshotId|symbol|trueMicroFamilyId|entry',

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

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

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortRiskShape: 'tp < entry < sl',
    shortRiskShape: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    ...taxonomyFlags(row)
  };
}

function tradeConfig() {
  const maxCandidatesPerSnapshot = positiveInt(
    CONFIG.short?.trade?.maxCandidatesPerSnapshot ??
      CONFIG.trade?.shortMaxCandidatesPerSnapshot ??
      CONFIG.trade?.maxCandidatesPerSnapshot,
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
    1,
    1000
  );

  return {
    maxCandidatesPerSnapshot,

    maxCandidatesPerInvocation: positiveInt(
      CONFIG.short?.trade?.maxCandidatesPerInvocation ??
        CONFIG.short?.trade?.candidateBatchSize ??
        CONFIG.trade?.shortMaxCandidatesPerInvocation ??
        CONFIG.trade?.shortCandidateBatchSize ??
        CONFIG.trade?.maxCandidatesPerInvocation ??
        CONFIG.trade?.candidateBatchSize,
      DEFAULT_MAX_CANDIDATES_PER_INVOCATION,
      10,
      250
    ),

    maxSnapshotAgeSec: cfgNumber(
      CONFIG.short?.trade?.maxSnapshotAgeSec ??
        CONFIG.trade?.shortMaxSnapshotAgeSec ??
        CONFIG.trade?.maxSnapshotAgeSec,
      8 * 60
    ),

    maxContinuationAgeSec: cfgNumber(
      CONFIG.short?.trade?.maxContinuationAgeSec ??
        CONFIG.trade?.shortMaxContinuationAgeSec ??
        CONFIG.trade?.maxContinuationAgeSec,
      DEFAULT_MAX_CONTINUATION_AGE_SEC
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
        CONFIG.trade?.shortMinLiveCandles15m ??
        CONFIG.trade?.minLiveCandles15m,
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

    allowStandardizedLearningRiskFallback: cfgBoolean(
      CONFIG.short?.trade?.allowStandardizedLearningRiskFallback ??
        CONFIG.trade?.shortAllowStandardizedLearningRiskFallback ??
        CONFIG.trade?.allowStandardizedLearningRiskFallback,
      DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_FALLBACK
    ),

    allowStandardizedLearningRiskVirtualEntries: cfgBoolean(
      CONFIG.short?.trade?.allowStandardizedLearningRiskVirtualEntries ??
        CONFIG.trade?.shortAllowStandardizedLearningRiskVirtualEntries ??
        CONFIG.trade?.allowStandardizedLearningRiskVirtualEntries,
      DEFAULT_ALLOW_STANDARDIZED_LEARNING_RISK_VIRTUAL_ENTRIES
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
    ),

    runResponseActionLimit: positiveInt(
      CONFIG.short?.trade?.runResponseActionLimit ??
        CONFIG.trade?.runResponseActionLimit,
      DEFAULT_RUN_RESPONSE_ACTION_LIMIT,
      20,
      500
    )
  };
}

function sizingConfig() {
  return {
    enabled:
      CONFIG.short?.sizing?.enabled ??
      CONFIG.sizing?.shortEnabled ??
      CONFIG.sizing?.enabled ??
      true,

    baseRiskPct: cfgNumber(
      CONFIG.short?.sizing?.baseRiskPct ??
        CONFIG.sizing?.shortBaseRiskPct ??
        CONFIG.sizing?.baseRiskPct,
      0.0025
    )
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
  return (
    clampNumber(
      CONFIG.short?.trade?.discordMinCurrentFitConfidence ??
        CONFIG.trade?.shortDiscordMinCurrentFitConfidence ??
        CONFIG.trade?.discordMinCurrentFitConfidence,
      0,
      100
    ) || DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE
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

function runtimeState(options = {}, startedAt = now()) {
  const runtimeBudgetMs = Math.max(
    5_000,
    Math.min(
      55_000,
      Math.floor(
        safeNumber(options.runtimeBudgetMs, DEFAULT_RUNTIME_BUDGET_MS)
      )
    )
  );

  const deadlineAt = safeNumber(
    options.deadlineAt,
    startedAt + runtimeBudgetMs
  );

  const stopBeforeDeadlineMs = Math.max(
    2_000,
    Math.min(
      15_000,
      Math.floor(
        safeNumber(
          options.stopBeforeDeadlineMs,
          DEFAULT_STOP_BEFORE_DEADLINE_MS
        )
      )
    )
  );

  return {
    runtimeBudgetMs,
    deadlineAt,
    stopBeforeDeadlineMs,
    remainingMs() {
      return Math.max(0, deadlineAt - now());
    },
    shouldStop(extraBufferMs = 0) {
      return (
        deadlineAt - now() <=
        stopBeforeDeadlineMs + Math.max(0, extraBufferMs)
      );
    }
  };
}

function normalizeTradeSide(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const raw = upper(value);

  if (
    ['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (raw.includes('MICRO_SHORT_') || raw.includes('SHORT_SCANNER_')) {
    return TARGET_TRADE_SIDE;
  }

  if (raw.includes('MICRO_LONG_') || raw.includes('LONG_SCANNER_')) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (!row || typeof row !== 'object') return normalizeTradeSide(row);

  const directValues = [
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

  for (const value of directValues) {
    const side = normalizeTradeSide(value);
    if (side !== 'UNKNOWN') return side;
  }

  const haystack = [
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.executionMicroFamilyId,
    row.familyId,
    row.id,
    row.key,
    row.definition,
    row.microDefinition,
    row.parentDefinition
  ]
    .filter(Boolean)
    .join('|');

  const inferred = normalizeTradeSide(haystack);
  if (inferred !== 'UNKNOWN') return inferred;

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

function getTrueMicroFamilyId(row = {}) {
  const candidates = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId
  ];

  for (const candidate of candidates) {
    const id = upper(candidate);

    if (
      id &&
      validLearningId(id) &&
      isSelectableShortTrueMicroFamilyId(id)
    ) {
      return id;
    }
  }

  return '';
}

function getParentTrueMicroFamilyId(row = {}) {
  const childId = getTrueMicroFamilyId(row);

  if (childId) {
    return parseShortTaxonomyMicroId(childId)?.parentTrueMicroFamilyId || '';
  }

  const candidates = [
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId
  ];

  for (const candidate of candidates) {
    const parsed = parseShortTaxonomyMicroId(upper(candidate));
    if (parsed?.isParent) return parsed.parentTrueMicroFamilyId;
  }

  return '';
}

function normalizeExactTrueMicroRow(row = {}) {
  const childId = getTrueMicroFamilyId(row);
  const parsed = childId ? parseShortTaxonomyMicroId(childId) : null;

  if (!childId || !parsed?.selectable) {
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
    trueMicroFamilyId: childId,
    microFamilyId: childId,
    analyzeMicroFamilyId: childId,
    learningMicroFamilyId: childId,
    childTrueMicroFamilyId: childId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: childId,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    exact75ChildTrueMicro: true,
    fixedTaxonomyLearningId: true,
    ...taxonomyFlags({
      ...row,
      trueMicroFamilyId: childId
    })
  };
}

function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol || candidate.symbol
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

function compactMarketWeather(value = null) {
  const source = asObject(value);

  if (!Object.keys(source).length) return null;

  return {
    ok: source.ok !== false,
    available: source.available !== false,
    version: compactText(source.version, 100),
    source: compactText(source.source, 40),
    snapshotId: compactText(source.snapshotId, 120),
    createdAt: safeNumber(
      source.createdAt ?? source.completedAt ?? source.updatedAt ?? source.ts,
      0
    ) || null,
    completedAt: safeNumber(source.completedAt, 0) || null,
    updatedAt: safeNumber(source.updatedAt, 0) || null,
    currentRegime: compactText(
      source.currentRegime || source.regime,
      40
    ),
    currentTrendSide: compactText(
      source.currentTrendSide || source.trendSide,
      40
    ),
    currentFlow: compactText(source.currentFlow || source.flow, 60),
    currentVolatilityState: compactText(
      source.currentVolatilityState || source.volatilityState,
      60
    ),
    confidence: safeNumber(
      source.confidence ?? source.weatherConfidence,
      0
    ),
    bullishPct: safeNumber(source.bullishPct, 0),
    bearishPct: safeNumber(source.bearishPct, 0),
    neutralPct: safeNumber(source.neutralPct, 0),
    squeezePct: safeNumber(source.squeezePct, 0),
    avgAtrPct: safeNumber(source.avgAtrPct, 0),
    avgRangePct: safeNumber(source.avgRangePct, 0),
    avgRealizedVolPct: safeNumber(source.avgRealizedVolPct, 0),
    avgVolumeExpansion: safeNumber(source.avgVolumeExpansion, 0),
    count: safeNumber(source.count ?? source.universeCount, 0),
    rowsExcluded: true,
    symbolsExcluded: true
  };
}

function normalizeMarketRegime(value = '') {
  const text = upper(value);

  if (!text) return 'UNKNOWN';
  if (text.includes('SQUEEZE') || text.includes('COMPRESS')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY')) {
    return 'CHOP';
  }
  if (text.includes('TREND') || text.includes('MOMENTUM')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketTrendSide(value = '') {
  const side = normalizeTradeSide(value);

  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const text = upper(value);

  if (!text) return 'UNKNOWN';
  if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT')) {
    return 'NEUTRAL';
  }

  return 'UNKNOWN';
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function extractMarketContext(weather = {}, universe = {}) {
  const source = asObject(weather);
  const fallback = asObject(universe);
  const compactWeather = compactMarketWeather(source);
  const compactUniverse = compactMarketWeather(fallback);

  const createdAt = safeNumber(
    compactWeather?.createdAt ?? compactUniverse?.createdAt,
    0
  );

  return {
    ok: Boolean(compactWeather || compactUniverse),
    weather: compactWeather,
    universe: compactUniverse,
    createdAt,
    ageSec: createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null,
    stale:
      createdAt > 0
        ? (now() - createdAt) / 1000 > currentFitMaxWeatherAgeSec()
        : true,
    regime: normalizeMarketRegime(
      compactWeather?.currentRegime || compactUniverse?.currentRegime
    ),
    trendSide: normalizeMarketTrendSide(
      compactWeather?.currentTrendSide || compactUniverse?.currentTrendSide
    ),
    bullishPct: firstFinite(
      compactWeather?.bullishPct,
      compactUniverse?.bullishPct
    ),
    bearishPct: firstFinite(
      compactWeather?.bearishPct,
      compactUniverse?.bearishPct
    ),
    squeezePct: firstFinite(
      compactWeather?.squeezePct,
      compactUniverse?.squeezePct
    ),
    confidence: clampNumber(
      firstFinite(compactWeather?.confidence, compactUniverse?.confidence) ?? 50,
      0,
      100
    ),
    key: MARKET_WEATHER_KEY,
    universeKey: MARKET_UNIVERSE_KEY
  };
}

async function loadMarketContext() {
  const redis = getVolatileRedis();

  const weather = await getJson(redis, MARKET_WEATHER_KEY, null).catch(
    () => null
  );

  if (weather && typeof weather === 'object') {
    return extractMarketContext(weather, {});
  }

  const universe = await getJson(redis, MARKET_UNIVERSE_KEY, null).catch(
    () => null
  );

  return extractMarketContext({}, universe || {});
}

function scoreMarketFit(row = {}, marketContext = {}) {
  if (!marketContext?.ok) {
    return {
      currentFit: 'UNKNOWN',
      currentFitScore: 0,
      currentFitConfidence: 0,
      currentFitReason: 'MARKET_WEATHER_UNAVAILABLE'
    };
  }

  if (marketContext.stale) {
    return {
      currentFit: 'UNKNOWN',
      currentFitScore: 0,
      currentFitConfidence: 0,
      currentFitReason: 'MARKET_WEATHER_STALE'
    };
  }

  const familyRegime = normalizeMarketRegime(
    row.regimeBucket || row.regime || row.regimeCoarse
  );
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

  if (
    Number.isFinite(marketContext.bullishPct) &&
    marketContext.bullishPct >= 60
  ) {
    score -= 20;
  }

  if (
    familyRegime === 'SQUEEZE' &&
    Number.isFinite(marketContext.squeezePct) &&
    marketContext.squeezePct >= 40
  ) {
    score += 10;
  }

  if (confirmation === 'A_STRONG_ALIGN') score += 8;
  if (confirmation === 'B_FLOW_ALIGN') score += 5;
  if (confirmation === 'C_VOLUME_ALIGN') score += 3;
  if (confirmation === 'E_WEAK_CONTRA') score -= 18;

  const finalScore = clampNumber(score, -100, 100);
  const confidence = clampNumber(
    marketContext.confidence + Math.min(20, Math.abs(score) / 2),
    0,
    100
  );

  let currentFit = 'NEUTRAL';
  if (finalScore >= 45) currentFit = 'MATCH';
  else if (finalScore >= 18) currentFit = 'WEAK_MATCH';
  else if (finalScore <= -25) currentFit = 'MISFIT';

  return {
    currentFit,
    currentFitScore: Number(finalScore.toFixed(4)),
    currentFitConfidence: Number(confidence.toFixed(2)),
    currentFitReason: reasons.join('|') || 'NO_CURRENT_FIT_REASON'
  };
}

function attachCurrentFitContext(row = {}, marketContext = {}) {
  const fit = scoreMarketFit(row, marketContext);

  return {
    ...row,

    currentMarketWeather: marketContext.weather || null,
    currentMarketUniverse: marketContext.universe || null,
    currentMarketWeatherKey: MARKET_WEATHER_KEY,
    currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
    currentMarketWeatherAgeSec: marketContext.ageSec ?? null,
    currentMarketWeatherStale: Boolean(marketContext.stale),

    currentRegime: marketContext.regime || 'UNKNOWN',
    currentTrendSide: marketContext.trendSide || 'UNKNOWN',
    currentBullishPct: marketContext.bullishPct ?? null,
    currentBearishPct: marketContext.bearishPct ?? null,
    currentSqueezePct: marketContext.squeezePct ?? null,

    entryMarketWeather: marketContext.weather || null,
    entryCurrentRegime: marketContext.regime || 'UNKNOWN',
    entryCurrentTrendSide: marketContext.trendSide || 'UNKNOWN',
    entryCurrentFit: fit.currentFit,
    entryCurrentFitConfidence: fit.currentFitConfidence,
    entryWeatherFitMatchedFamily:
      fit.currentFit === 'MATCH' || fit.currentFit === 'WEAK_MATCH',

    ...fit,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    marketWeatherRowsExcluded: true,
    marketUniverseRowsExcluded: true
  };
}

function discordCurrentFitGate(row = {}) {
  if (!discordRequiresCurrentFit()) {
    return {
      ok: true,
      reason: 'CURRENT_FIT_NOT_REQUIRED_BY_CONFIG',
      currentFit: row.currentFit || row.entryCurrentFit || 'NOT_REQUIRED',
      currentFitConfidence: safeNumber(
        row.currentFitConfidence ?? row.entryCurrentFitConfidence,
        0
      )
    };
  }

  const fit = upper(row.currentFit || row.entryCurrentFit);
  const confidence = safeNumber(
    row.currentFitConfidence ?? row.entryCurrentFitConfidence,
    0
  );

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

function actionCounts(actions = []) {
  return (Array.isArray(actions) ? actions : []).reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = safeNumber(acc[key], 0) + 1;
    return acc;
  }, {});
}

function waitAction(candidate = {}, reason, extra = {}) {
  return {
    action: 'WAIT',
    reason,
    symbol: candidate.symbol || null,
    contractSymbol: candidate.contractSymbol || null,
    snapshotId: candidate.snapshotId || null,
    scannerScore: candidate.scannerScore ?? candidate.moveScore ?? null,
    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,
    currentFit: candidate.currentFit || candidate.entryCurrentFit || null,
    currentFitScore: candidate.currentFitScore ?? null,
    currentFitConfidence:
      candidate.currentFitConfidence ??
      candidate.entryCurrentFitConfidence ??
      null,
    ...sideFlags(),
    ...virtualFlags(candidate),
    ...isolationFlags(),
    ...extra
  };
}

function hasValidRiskShape(row = {}) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);

  if (row.learningOnly === true) return false;
  if (!isTargetRow(row)) return false;
  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  return tp < entry && entry < sl;
}

function validateVirtualEntry(row = {}) {
  const cfg = tradeConfig();
  const trueMicroFamilyId = getTrueMicroFamilyId(row);

  if (!isTargetRow(row)) {
    return {
      ok: false,
      reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM'
    };
  }

  if (!trueMicroFamilyId) {
    return {
      ok: false,
      reason: 'ANALYZE_EXACT_75_CHILD_TRUE_MICRO_FAMILY_REQUIRED'
    };
  }

  if (
    row.standardizedLearningRisk &&
    !cfg.allowStandardizedLearningRiskVirtualEntries
  ) {
    return {
      ok: false,
      reason: 'STANDARDIZED_LEARNING_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING'
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
        spreadPct: 0.0008,
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

  return {
    symbol,
    ob: analyzeOrderBook(rawOrderBook),
    funding,
    candles15m: Array.isArray(candles15m) ? candles15m : [],
    candles1h: Array.isArray(candles1h) ? candles1h : []
  };
}

async function fetchMidPrice(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);
  if (!contractSymbol) return 0;

  const rawOrderBook = await fetchOrderBook(contractSymbol).catch(() => null);
  return safeNumber(analyzeOrderBook(rawOrderBook)?.mid, 0);
}

function candidateFallbackPrice(normalized = {}, data = {}) {
  return safeNumber(
    data.ob?.mid ??
      normalized.price ??
      normalized.markPrice ??
      normalized.currentPrice ??
      normalized.lastPrice ??
      normalized.close ??
      normalized.entry,
    0
  );
}

function baseMetricFields(normalized = {}, data = {}) {
  const spreadPct = safeNumber(
    data.ob?.spreadPct ??
      normalized.spreadPct ??
      CONFIG.short?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.shortFallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  return {
    symbol: normalized.symbol,
    baseSymbol: normalized.baseSymbol,
    contractSymbol: normalized.contractSymbol,
    snapshotId: normalized.snapshotId || null,
    scannerScore: safeNumber(
      normalized.scannerScore ?? normalized.moveScore,
      0
    ),
    moveScore: safeNumber(
      normalized.moveScore ?? normalized.scannerScore,
      0
    ),
    scannerReason: normalized.scannerReason || null,
    scannerTs: normalized.scannerTs || null,
    scannerGatePassed: normalized.scannerGatePassed !== false,
    analyzeEligible: normalized.analyzeEligible !== false,
    spreadPct,
    liveSpreadPct: spreadPct,
    depthMinUsd1p: safeNumber(data.ob?.depthMinUsd1p, 0),
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
    change1h: safeNumber(normalized.change1h, 0),
    change24h: safeNumber(normalized.change24h, 0),
    volume24h: safeNumber(
      normalized.volume24h ??
        normalized.quoteVolume24h ??
        normalized.quoteVolume,
      0
    ),
    volumeExpansion: safeNumber(normalized.volumeExpansion, 0),
    atrPct: safeNumber(normalized.atrPct, 0),
    ...sideFlags(),
    ...virtualFlags(normalized),
    ...isolationFlags()
  };
}

function buildObservationOnlyMetrics({
  normalized,
  data = {},
  reason = 'SHORT_RISK_INVALID'
}) {
  return {
    ...baseMetricFields(normalized, data),
    price: candidateFallbackPrice(normalized, data),
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
    liveEntryBlockedReason: reason
  };
}

function buildStandardizedShortLearningRiskMetrics({
  normalized,
  data = {},
  reason = 'STANDARDIZED_SHORT_LEARNING_TP_SL'
}) {
  const cfg = tradeConfig();
  const mid = candidateFallbackPrice(normalized, data);

  if (!cfg.allowStandardizedLearningRiskFallback) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_LEARNING_RISK_FALLBACK_DISABLED'
    });
  }

  if (mid <= 0) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'STANDARDIZED_SHORT_RISK_NO_PRICE'
    });
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

  return {
    ...baseMetricFields(normalized, data),
    price: mid,
    entry,
    sl,
    tp,
    rr,
    riskPct,
    rewardPct: Math.max(0, (entry - tp) / entry),
    confluence: safeNumber(
      normalized.scannerScore ?? normalized.moveScore,
      0
    ),
    sniperScore: safeNumber(
      normalized.scannerScore ?? normalized.moveScore,
      0
    ),
    riskSource: 'LEARNING_STANDARDIZED_TP_SL',
    riskEngineRisk: false,
    standardizedLearningRisk: true,
    standardizedLearningRiskReason: reason,
    standardizedLearningRiskEntry: true,
    standardizedLearningRiskVirtualEntryAllowed:
      cfg.allowStandardizedLearningRiskVirtualEntries,
    observationOnly: false,
    analysisInputOnly: false,
    learningOnly: false,
    liveRiskValid: true,
    liveEntryBlockedReason: null
  };
}

function enrichRiskMetric(metric = {}, normalized = {}, data = {}) {
  const cfg = tradeConfig();
  const base = baseMetricFields(normalized, data);
  const row = {
    ...base,
    ...metric,
    ...sideFlags(),
    ...virtualFlags(metric),
    ...isolationFlags(),
    maxSpreadPct: cfg.maxSpreadPct,
    liveSpreadGatePassed:
      safeNumber(metric.spreadPct ?? base.spreadPct, 0) <= cfg.maxSpreadPct,
    minLiveCandles15m: cfg.minLiveCandles15m,
    riskSource: metric.riskSource || 'RISK_ENGINE',
    riskEngineRisk: true,
    standardizedLearningRisk: false,
    positionTimeStopMin: cfg.positionTimeStopMin,
    liveDataTs: now()
  };

  return {
    ...row,
    liveRiskValid: hasValidRiskShape(row)
  };
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

  if (!isTargetRow(normalized)) {
    return {
      actions: [
        waitAction(normalized, 'LONG_DISABLED_SHORT_ONLY_SYSTEM', {
          skippedBeforeAnalyze: true,
          skippedBeforeLiveFetch: true
        })
      ],
      metrics: []
    };
  }

  const data = await fetchLiveCandidateData(normalized).catch((error) => ({
    error,
    ob: { fetchFailed: true },
    funding: { rate: 0, fetchFailed: true },
    candles15m: [],
    candles1h: []
  }));

  if (data.error || data.ob?.fetchFailed) {
    const fallback = buildStandardizedShortLearningRiskMetrics({
      normalized,
      data,
      reason: 'LIVE_DATA_FAILED_STANDARDIZED_LEARNING_TP_SL'
    });

    return {
      actions: hasValidRiskShape(fallback)
        ? []
        : [waitAction(normalized, fallback.liveEntryBlockedReason)],
      metrics: [fallback]
    };
  }

  if (
    !Array.isArray(data.candles15m) ||
    data.candles15m.length < cfg.minLiveCandles15m
  ) {
    const fallback = buildStandardizedShortLearningRiskMetrics({
      normalized,
      data,
      reason: 'INSUFFICIENT_LIVE_CANDLES_STANDARDIZED_LEARNING_TP_SL'
    });

    return {
      actions: hasValidRiskShape(fallback)
        ? []
        : [
            waitAction(
              normalized,
              'INSUFFICIENT_LIVE_CANDLES_15M_AND_NO_FALLBACK_RISK',
              {
                candleCount: data.candles15m?.length || 0,
                requiredCandleCount: cfg.minLiveCandles15m
              }
            )
          ],
      metrics: [fallback]
    };
  }

  const generated = buildRiskAndLiveMetricsForBothSides({
    candidate: {
      ...normalized,
      ...sideFlags()
    },
    ob: data.ob,
    funding: data.funding,
    candles15m: data.candles15m,
    candles1h: data.candles1h,
    btcState: normalized.btcState,
    regime: normalized.regime
  });

  const metrics = (Array.isArray(generated) ? generated : [])
    .filter(isTargetRow)
    .map((row) => enrichRiskMetric(row, normalized, data));

  if (metrics.some(hasValidRiskShape)) {
    return {
      actions: [],
      metrics
    };
  }

  const fallback = buildStandardizedShortLearningRiskMetrics({
    normalized,
    data,
    reason: 'RISK_ENGINE_EMPTY_STANDARDIZED_SHORT_LEARNING_TP_SL'
  });

  return {
    actions: hasValidRiskShape(fallback)
      ? []
      : [waitAction(normalized, fallback.liveEntryBlockedReason)],
    metrics: [fallback]
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

    return {
      actions: hasValidRiskShape(fallback)
        ? []
        : [
            waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
              error: error?.message || String(error)
            })
          ],
      metrics: [fallback]
    };
  }
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value && typeof value === 'object' && Array.isArray(value.candidates)
  );
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

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];

  const targetRows = rows
    .filter(isTargetRow)
    .map((candidate) => ({
      ...candidate,
      ...sideFlags(),
      ...virtualFlags(candidate),
      ...isolationFlags()
    }));

  const blockedRows = rows
    .filter((candidate) => !isTargetRow(candidate))
    .slice(0, 100)
    .map((candidate) =>
      waitAction(normalizeCandidate(candidate), 'LONG_DISABLED_SHORT_ONLY_SYSTEM', {
        skippedBeforeAnalyze: true,
        skippedBeforeLiveFetch: true,
        detectedScannerSide: inferRowTradeSide(candidate)
      })
    );

  return {
    ...snapshot,
    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: targetRows.length,
    selectedShortCandidateCount: targetRows.length,
    selectedOppositeCandidateCount: rows.length - targetRows.length,
    selectedLongCandidateCount: rows.length - targetRows.length,
    blockedNonShortCandidates: blockedRows,
    blockedNonShortCandidatesCount: rows.length - targetRows.length,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    candidates: targetRows,
    candidatesCount: targetRows.length,
    shortCandidatesCount: targetRows.length,
    longCandidatesCount: 0
  };
}

async function loadRecentTargetSnapshots(redis) {
  const keys = await getKeys(
    redis,
    SHORT_KEYS.scan.snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);
      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        key,
        snapshot,
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();

  const latest = await safeGetSnapshotJson(
    volatileRedis,
    SHORT_KEYS.scan.latest,
    null
  );

  if (hasFullSnapshotShape(latest)) {
    return normalizeSelectedSnapshot(latest, {
      source: 'SHORT:SCAN:LATEST_FULL_SNAPSHOT',
      reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
    });
  }

  const latestSnapshotId = extractSnapshotId(latest);

  if (latestSnapshotId) {
    const byId = await safeGetSnapshotJson(
      volatileRedis,
      SHORT_KEYS.scan.snapshot(latestSnapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      return normalizeSelectedSnapshot(byId, {
        source: 'SHORT:SCAN:SNAPSHOT_BY_LATEST_ID',
        reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
      });
    }
  }

  const recent = await loadRecentTargetSnapshots(volatileRedis);
  const fallback = recent[0];

  if (!fallback) return null;

  return normalizeSelectedSnapshot(fallback.snapshot, {
    source: `SHORT:SCAN:RECENT_SEARCH:${fallback.key}`,
    reason: 'RECENT_SHORT_SCANNER_SNAPSHOT_FALLBACK'
  });
}

function buildSelectedAlertContext(activeRotation) {
  const rawRows = Array.isArray(activeRotation?.microFamilies)
    ? activeRotation.microFamilies
    : [];

  const rowByMicroId = new Map();

  for (const row of rawRows) {
    const normalized = normalizeExactTrueMicroRow(row);
    const childId = getTrueMicroFamilyId(normalized);
    if (childId) rowByMicroId.set(childId, normalized);
  }

  const selectedMicroFamilyIds = uniqueStrings([
    activeRotation?.microFamilyIds || [],
    activeRotation?.activeMicroFamilyIds || [],
    activeRotation?.trueMicroFamilyIds || [],
    activeRotation?.childTrueMicroFamilyIds || [],
    rawRows.map(getTrueMicroFamilyId)
  ])
    .map(upper)
    .filter((id) => isSelectableShortTrueMicroFamilyId(id));

  return {
    rotationId: activeRotation?.rotationId || null,
    selectedRotation: activeRotation || null,
    selectedMicroFamilyIds,
    selectedMicroSet: new Set(selectedMicroFamilyIds),
    rowByMicroId,
    empty: selectedMicroFamilyIds.length === 0,
    trueMicroOnly: true,
    exactTrueMicroOnly: true
  };
}

function selectedWeeklyStats(alertContext, row = {}) {
  const id = getTrueMicroFamilyId(row);
  return id ? alertContext.rowByMicroId.get(id) || null : null;
}

function buildVirtualEntryAction({
  row,
  alertContext,
  weeklyStats,
  riskFraction,
  virtualGate
}) {
  const normalized = normalizeExactTrueMicroRow(row);
  const childId = getTrueMicroFamilyId(normalized);
  const parsed = parseShortTaxonomyMicroId(childId);
  const currentFitGate = discordCurrentFitGate(normalized);
  const selectedExactMicroMatch = alertContext.selectedMicroSet.has(childId);
  const discordAlertEligible =
    selectedExactMicroMatch && currentFitGate.ok;

  return {
    ...normalized,
    ...sideFlags(),
    ...virtualFlags(normalized),
    ...isolationFlags(),

    action: 'VIRTUAL_ENTRY',
    reason: virtualGate.reason,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    shadowOnly: false,

    trueMicroFamilyId: childId,
    microFamilyId: childId,
    analyzeMicroFamilyId: childId,
    learningMicroFamilyId: childId,
    childTrueMicroFamilyId: childId,
    parentTrueMicroFamilyId: parsed?.parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: parsed?.parentTrueMicroFamilyId || null,
    setupType: parsed?.setup || normalized.setupType || null,
    regimeBucket: parsed?.regime || normalized.regimeBucket || null,
    confirmationProfile:
      parsed?.confirmationProfile || normalized.confirmationProfile || null,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,
    selectedMicroFamilyAlert: discordAlertEligible,
    selectedExactMicroMatch,
    discordAlertEligible,
    discordCurrentFitGate: currentFitGate,
    discordAlertReason: discordAlertEligible
      ? 'SELECTED_SHORT_TRUE_MICRO_FAMILY_EXACT_75_CHILD_MATCH_AND_CURRENT_FIT_OK'
      : !selectedExactMicroMatch
        ? 'TRUE_MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
        : currentFitGate.reason,

    selectedWeeklyStats: weeklyStats,
    weeklyStats,
    riskFraction,
    virtualGate,

    liveEligible: discordAlertEligible,
    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

    validShortRiskShape: true,
    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    positionTimeStopMin: tradeConfig().positionTimeStopMin,

    entryMarketWeather: normalized.currentMarketWeather || null,
    currentMarketWeather: normalized.currentMarketWeather || null,
    currentMarketUniverse: null,
    marketWeatherRowsExcluded: true,
    marketUniverseRowsExcluded: true,
    candleDataExcluded: true,

    entryCreatedAt: now()
  };
}

function maybeSendDiscordEntryAlert(entry = {}) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason:
        entry.discordAlertReason ||
        'TRUE_MICRO_FAMILY_NOT_SELECTED_OR_CURRENT_FIT_BLOCKED'
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

function compactVirtualExit(outcome = {}) {
  const childId = getTrueMicroFamilyId(outcome);
  const parsed = childId ? parseShortTaxonomyMicroId(childId) : null;

  return {
    action: 'VIRTUAL_EXIT',
    reason: outcome.exitReason || outcome.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    symbol: outcome.symbol || null,
    contractSymbol: outcome.contractSymbol || null,
    trueMicroFamilyId: childId || null,
    childTrueMicroFamilyId: childId || null,
    parentTrueMicroFamilyId:
      parsed?.parentTrueMicroFamilyId ||
      outcome.parentTrueMicroFamilyId ||
      null,
    setupType: parsed?.setup || outcome.setupType || null,
    regimeBucket: parsed?.regime || outcome.regimeBucket || null,
    confirmationProfile:
      parsed?.confirmationProfile || outcome.confirmationProfile || null,
    exitReason: outcome.exitReason || null,
    exitPrice: outcome.exitPrice ?? null,
    grossR:
      outcome.grossR ?? outcome.realizedGrossR ?? outcome.shortGrossR ?? null,
    netR: outcome.netR ?? outcome.realizedR ?? outcome.r ?? null,
    realizedR: outcome.realizedR ?? outcome.netR ?? outcome.r ?? null,
    costR: outcome.costR ?? null,
    entry: outcome.entry ?? null,
    initialSl: outcome.initialSl ?? outcome.sl ?? null,
    sl: outcome.sl ?? null,
    tp: outcome.tp ?? null,
    currentPrice:
      outcome.currentPrice ?? outcome.lastPrice ?? outcome.exitPrice ?? null,
    ageSec: outcome.ageSec ?? null,
    currentR: outcome.currentR ?? outcome.shortCurrentR ?? null,
    directToSL: Boolean(outcome.directToSL || outcome.directSL),
    directSL: Boolean(outcome.directSL || outcome.directToSL),
    entryMarketWeather: compactMarketWeather(outcome.entryMarketWeather),
    entryCurrentFit: outcome.entryCurrentFit || outcome.currentFit || null,
    entryCurrentFitConfidence:
      outcome.entryCurrentFitConfidence ?? outcome.currentFitConfidence ?? null,
    ...sideFlags(),
    ...virtualFlags(outcome),
    ...isolationFlags()
  };
}

function positionSymbolKey(row = {}) {
  return (
    normalizeBaseSymbol(
      row.symbol || row.baseSymbol || row.contractSymbol
    ) || ''
  );
}

function compactActionForMeta(row = {}) {
  return {
    action: row.action || row.type || 'UNKNOWN',
    reason: row.reason || row.liveEntryBlockedReason || null,
    symbol: row.symbol || null,
    contractSymbol: row.contractSymbol || null,
    trueMicroFamilyId: getTrueMicroFamilyId(row) || null,
    parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
    entry: safeNumber(row.entry, 0) || null,
    sl: safeNumber(row.sl, 0) || null,
    tp: safeNumber(row.tp, 0) || null,
    rr: safeNumber(row.rr, 0) || null,
    currentFit: row.currentFit || row.entryCurrentFit || null,
    discordAlertEligible: Boolean(row.discordAlertEligible)
  };
}

function compactRunMeta(result = {}) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const exits = Array.isArray(result.virtualExits) ? result.virtualExits : [];

  return {
    ok: result.ok !== false,
    runId: result.runId || null,
    startedAt: result.startedAt || null,
    completedAt: result.completedAt || now(),
    durationMs: safeNumber(result.durationMs, 0),

    skippedNewEntries: Boolean(result.skippedNewEntries),
    reason: result.reason || result.skipReason || null,
    skipReason: result.skipReason || result.reason || null,

    snapshotId: result.snapshotId || null,
    snapshotCreatedAt: result.snapshotCreatedAt || null,
    snapshotAgeSec: safeNumber(result.snapshotAgeSec, 0),

    candidateStartIndex: safeNumber(result.candidateStartIndex, 0),
    candidateEndExclusive: safeNumber(result.candidateEndExclusive, 0),
    nextCandidateIndex: safeNumber(result.nextCandidateIndex, 0),
    snapshotCandidateCount: safeNumber(result.snapshotCandidateCount, 0),
    snapshotProcessingComplete: Boolean(result.snapshotProcessingComplete),
    batchProcessingComplete: Boolean(result.batchProcessingComplete),
    batchNumber: safeNumber(result.batchNumber, 0),

    candidates: safeNumber(result.candidates, 0),
    processed: safeNumber(result.processed, 0),
    liveRows: safeNumber(result.liveRows, 0),
    analyzedRows: safeNumber(result.analyzedRows, 0),
    entryRows: safeNumber(result.entryRows, 0),
    waitRows: safeNumber(result.waitRows, 0),
    virtualCreatedRows: safeNumber(result.virtualCreatedRows, 0),
    virtualExitRows: exits.length,
    skippedByExistingSymbol: safeNumber(result.skippedByExistingSymbol, 0),

    analyzeError: result.analyzeError || null,
    analyzeBatchMeta: result.analyzeBatchMeta || null,
    actionCounts: result.actionCounts || actionCounts(actions),
    actionSample: actions
      .slice(0, DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT)
      .map(compactActionForMeta),
    virtualExitSample: exits
      .slice(0, DEFAULT_RUN_META_ACTION_SAMPLE_LIMIT)
      .map(compactVirtualExit),

    selectedRotationId: result.selectedRotationId || null,
    selectedMicroFamilyIds: Array.isArray(result.selectedMicroFamilyIds)
      ? result.selectedMicroFamilyIds.slice(0, 75)
      : [],

    currentMarketWeather: compactMarketWeather(result.currentMarketWeather),
    currentRegime: result.currentRegime || null,
    currentTrendSide: result.currentTrendSide || null,
    currentBullishPct: result.currentBullishPct ?? null,
    currentBearishPct: result.currentBearishPct ?? null,
    currentSqueezePct: result.currentSqueezePct ?? null,

    runtimeBudgetMs: safeNumber(result.runtimeBudgetMs, 0),
    remainingRuntimeMs: safeNumber(result.remainingRuntimeMs, 0),

    compactPersistence: true,
    fullPayloadPersisted: false,
    actionsPersisted: false,
    scannerRowsPersisted: false,
    marketWeatherRowsPersisted: false,
    marketUniverseRowsPersisted: false,
    candidateRowsPersisted: false,
    candleDataPersisted: false,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags()
  };
}

async function scopedSetJson(redis, key, value, options = {}) {
  if (typeof KeysApi.assertKeyAllowedForWriteScope === 'function') {
    try {
      KeysApi.assertKeyAllowedForWriteScope(
        KEYS.scopes?.TRADE_RUN || 'TRADE_RUN',
        key
      );
    } catch (error) {
      if (!String(key || '').startsWith(SHORT_KEY_PREFIX)) throw error;
    }
  } else if (!String(key || '').startsWith(SHORT_KEY_PREFIX)) {
    throw new Error('TRADE_WRITE_SCOPE_VIOLATION_SHORT_ONLY');
  }

  return setJson(redis, key, value, options);
}

async function saveRunMeta(result = {}) {
  const durableRedis = getDurableRedis();
  const completedAt = now();

  const finalResult = {
    ok: result.ok !== false,
    ...result,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts:
      result.actionCounts || actionCounts(result.actions || []),
    virtualExits: (Array.isArray(result.virtualExits)
      ? result.virtualExits
      : []
    ).map(compactVirtualExit),
    shadowExits: (Array.isArray(result.virtualExits)
      ? result.virtualExits
      : []
    ).map(compactVirtualExit),
    realExits: [],
    shortKeys: {
      scanLatest: SHORT_KEYS.scan.latest,
      tradeRunMeta: SHORT_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
      tradeSnapshotProgress: SHORT_KEYS.trade.snapshotProgress,
      scanSnapshotPattern: SHORT_KEYS.scan.snapshotPattern(),
      marketWeather: MARKET_WEATHER_KEY,
      marketUniverse: MARKET_UNIVERSE_KEY
    }
  };

  await scopedSetJson(
    durableRedis,
    SHORT_KEYS.trade.runMeta,
    compactRunMeta(finalResult)
  );

  return finalResult;
}

async function saveProgress(redis, progress) {
  await scopedSetJson(
    redis,
    SHORT_KEYS.trade.snapshotProgress,
    {
      ...progress,
      ...sideFlags(),
      ...isolationFlags(),
      currentMarketWeather: compactMarketWeather(progress.currentMarketWeather),
      currentMarketUniverse: null,
      fullPayloadPersisted: false,
      candidateRowsPersisted: false,
      marketWeatherRowsPersisted: false,
      marketUniverseRowsPersisted: false,
      candleDataPersisted: false
    }
  );
}

function buildQualityAudit({
  totalCandidates,
  batchCandidates,
  processed,
  liveRows,
  analyzedRows,
  entryRows,
  waitRows,
  virtualCreatedRows,
  virtualExitRows,
  skippedByExistingSymbol,
  analyzeError,
  batchStart,
  batchEnd,
  nextCandidateIndex,
  snapshotComplete,
  marketContext
}) {
  return {
    profile: QUALITY_MEASUREMENT_PROFILE,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    runtimeMode: 'RESUMABLE_SNAPSHOT_BATCH',
    analyzeWriteMode: 'BATCHED_PER_WEEK_KEY',
    targetTradeSide: TARGET_TRADE_SIDE,
    trueMicroSchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    pipelineCounts: {
      totalCandidates,
      batchCandidates,
      processed,
      liveRows,
      analyzedRows,
      entryRows,
      waitRows,
      virtualCreatedRows,
      virtualExitRows,
      skippedByExistingSymbol
    },
    progress: {
      batchStart,
      batchEnd,
      nextCandidateIndex,
      snapshotComplete
    },
    analyzeError,
    marketWeather: {
      available: Boolean(marketContext?.ok),
      ageSec: marketContext?.ageSec ?? null,
      stale: Boolean(marketContext?.stale),
      regime: marketContext?.regime || 'UNKNOWN',
      trendSide: marketContext?.trendSide || 'UNKNOWN',
      bullishPct: marketContext?.bullishPct ?? null,
      bearishPct: marketContext?.bearishPct ?? null,
      squeezePct: marketContext?.squeezePct ?? null,
      confidence: marketContext?.confidence ?? null
    },
    storageSafety: {
      compactTradeRunMeta: true,
      fullScannerRowsPersisted: false,
      fullMarketWeatherRowsPersisted: false,
      fullMarketUniverseRowsPersisted: false,
      candlesPersisted: false
    }
  };
}

export async function runTradeSystem(options = {}) {
  const cfg = tradeConfig();
  const sizing = sizingConfig();
  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run_short');
  const startedAt = now();
  const runtime = runtimeState(options, startedAt);

  const forceProcessSnapshot = Boolean(
    options.forceProcessSnapshot || options.force
  );
  const monitorOnly = Boolean(options.monitorOnly);

  const marketContext = await loadMarketContext().catch(() =>
    extractMarketContext({}, {})
  );

  const rawVirtualExits = await monitorOpenPositions({
    priceFetcher: async (symbol) => fetchMidPrice(symbol),
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    weekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true
  });

  const virtualExits = (Array.isArray(rawVirtualExits)
    ? rawVirtualExits
    : []
  ).map(compactVirtualExit);

  if (monitorOnly) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      virtualExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'MONITOR_ONLY',
      processScannerSnapshot: false,
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      runtimeBudgetMs: runtime.runtimeBudgetMs,
      remainingRuntimeMs: runtime.remainingMs()
    });
  }

  if (
    runtime.remainingMs() < DEFAULT_MIN_REMAINING_FOR_NEW_BATCH_MS ||
    runtime.shouldStop(4_000)
  ) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      virtualExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'RUNTIME_BUDGET_USED_BY_POSITION_MONITORING',
      processScannerSnapshot: false,
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      runtimeBudgetMs: runtime.runtimeBudgetMs,
      remainingRuntimeMs: runtime.remainingMs()
    });
  }

  const snapshot = await getLatestSnapshot();

  if (!snapshot?.snapshotId) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      virtualExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'NO_SHORT_SCANNER_SNAPSHOT',
      processScannerSnapshot: true,
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      runtimeBudgetMs: runtime.runtimeBudgetMs,
      remainingRuntimeMs: runtime.remainingMs()
    });
  }

  const allCandidates = (Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : []
  )
    .filter(isTargetRow)
    .slice(0, cfg.maxCandidatesPerSnapshot);

  const snapshotAgeSec =
    (now() - safeNumber(snapshot.createdAt, snapshotCreatedAt(snapshot))) /
    1000;

  /*
   * Resumable progress has its own key. api/trade/run.js may write the legacy
   * LAST_PROCESSED_SNAPSHOT key after this function returns, so that key must
   * never be used as the batch cursor.
   */
  const progressState = await getJson(
    durableRedis,
    SHORT_KEYS.trade.snapshotProgress,
    null
  ).catch(() => null);

  const sameSnapshot = progressState?.snapshotId === snapshot.snapshotId;
  const previousComplete = sameSnapshot && progressState?.completed === true;
  const previousNextIndex = sameSnapshot
    ? Math.max(0, Math.floor(safeNumber(progressState?.nextCandidateIndex, 0)))
    : 0;

  if (sameSnapshot && previousComplete && !forceProcessSnapshot) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotCreatedAt: snapshot.createdAt,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      actions: snapshot.blockedNonShortCandidates || [],
      virtualExits,
      entryRows: 0,
      waitRows: snapshot.blockedNonShortCandidates?.length || 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED',
      candidateStartIndex: allCandidates.length,
      candidateEndExclusive: allCandidates.length,
      nextCandidateIndex: allCandidates.length,
      snapshotCandidateCount: allCandidates.length,
      snapshotProcessingComplete: true,
      batchProcessingComplete: true,
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      runtimeBudgetMs: runtime.runtimeBudgetMs,
      remainingRuntimeMs: runtime.remainingMs()
    });
  }

  const continuation = sameSnapshot && !previousComplete && !forceProcessSnapshot;
  const maxAllowedAge = continuation
    ? cfg.maxContinuationAgeSec
    : cfg.maxSnapshotAgeSec;

  if (snapshotAgeSec > maxAllowedAge) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotCreatedAt: snapshot.createdAt,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      actions: snapshot.blockedNonShortCandidates || [],
      virtualExits,
      entryRows: 0,
      waitRows: snapshot.blockedNonShortCandidates?.length || 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: continuation
        ? 'INCOMPLETE_SNAPSHOT_CONTINUATION_TOO_STALE'
        : 'SNAPSHOT_TOO_STALE',
      candidateStartIndex: continuation ? previousNextIndex : 0,
      candidateEndExclusive: continuation ? previousNextIndex : 0,
      nextCandidateIndex: continuation ? previousNextIndex : 0,
      snapshotCandidateCount: allCandidates.length,
      snapshotProcessingComplete: false,
      batchProcessingComplete: false,
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      runtimeBudgetMs: runtime.runtimeBudgetMs,
      remainingRuntimeMs: runtime.remainingMs()
    });
  }

  const candidateStartIndex = forceProcessSnapshot ? 0 : previousNextIndex;
  const candidateEndExclusive = Math.min(
    allCandidates.length,
    candidateStartIndex + cfg.maxCandidatesPerInvocation
  );

  const candidateBatch = allCandidates
    .slice(candidateStartIndex, candidateEndExclusive)
    .map((candidate) =>
      attachCurrentFitContext(
        {
          ...candidate,
          ...sideFlags(),
          ...virtualFlags(candidate),
          ...isolationFlags(),
          btcState: snapshot.btcState,
          regime: snapshot.regime
        },
        marketContext
      )
    );

  if (candidateBatch.length === 0) {
    await saveProgress(durableRedis, {
      snapshotId: snapshot.snapshotId,
      processedAt: now(),
      completed: true,
      nextCandidateIndex: allCandidates.length,
      snapshotCandidateCount: allCandidates.length,
      currentMarketWeather: marketContext.weather
    });

    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotCreatedAt: snapshot.createdAt,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      actions: [],
      virtualExits,
      entryRows: 0,
      waitRows: 0,
      virtualCreatedRows: 0,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_BATCH_CURSOR_AT_END',
      candidateStartIndex,
      candidateEndExclusive,
      nextCandidateIndex: allCandidates.length,
      snapshotCandidateCount: allCandidates.length,
      snapshotProcessingComplete: true,
      batchProcessingComplete: true,
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      runtimeBudgetMs: runtime.runtimeBudgetMs,
      remainingRuntimeMs: runtime.remainingMs()
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
    shortOnly: true,
    longDisabled: true,
    exactTrueMicroOnly: true,
    selectionGranularity: 'EXACT_75_CHILD',
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA
  }).catch(() => null);

  const alertContext = buildSelectedAlertContext(activeRotation);

  const processed = await mapConcurrent(
    candidateBatch,
    cfg.dataConcurrency,
    safeProcessCandidate
  );

  const earlyActions = processed
    .flatMap((row) => (Array.isArray(row?.actions) ? row.actions : []))
    .filter(Boolean);

  const liveRows = processed
    .flatMap((row) => (Array.isArray(row?.metrics) ? row.metrics : []))
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) => attachCurrentFitContext(row, marketContext));

  let analyzedRowsRaw = [];
  let analyzeError = null;
  let analyzeBatchMeta = null;

  try {
    analyzedRowsRaw = await analyzeCandidatesBatch(liveRows, {
      weekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      targetTradeSide: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      virtualOnly: true,
      virtualLearning: true,
      exactTrueMicroOnly: true,
      selectionGranularity: 'EXACT_75_CHILD',
      currentMarketWeather: marketContext.weather,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      deadlineAt: runtime.deadlineAt,
      stopBeforeDeadlineMs: runtime.stopBeforeDeadlineMs
    });

    analyzeBatchMeta = analyzedRowsRaw.batchMeta || null;
  } catch (error) {
    analyzeError = error?.message || String(error);
    analyzedRowsRaw = [];
  }

  const analyzedRows = analyzedRowsRaw
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) =>
      attachCurrentFitContext(normalizeExactTrueMicroRow(row), marketContext)
    );

  const openPositions = await getOpenPositions({
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    virtualOnly: true
  });

  const openSymbolSet = new Set(
    (Array.isArray(openPositions) ? openPositions : [])
      .map(positionSymbolKey)
      .filter(Boolean)
  );

  const actions = [...earlyActions];
  let entryRows = 0;
  let waitRows = earlyActions.length;
  let virtualCreatedRows = 0;
  let virtualSkippedRows = 0;
  let virtualFailedRows = 0;
  let skippedByExistingSymbol = 0;
  let entryProcessingIncomplete = false;
  let discordAlertsQueued = 0;

  for (let index = 0; index < analyzedRows.length; index += 1) {
    const row = analyzedRows[index];

    if (runtime.shouldStop(1_500)) {
      entryProcessingIncomplete = true;
      break;
    }

    const virtualGate = validateVirtualEntry(row);

    if (!virtualGate.ok) {
      waitRows += 1;
      virtualSkippedRows += 1;
      actions.push(waitAction(row, virtualGate.reason, { virtualGate }));
      continue;
    }

    const symbolKey = positionSymbolKey(row);

    if (symbolKey && openSymbolSet.has(symbolKey)) {
      waitRows += 1;
      virtualSkippedRows += 1;
      skippedByExistingSymbol += 1;
      actions.push(
        waitAction(row, 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION', {
          virtualTracked: true,
          oneOpenPositionPerSymbol: true
        })
      );
      continue;
    }

    const weeklyStats = selectedWeeklyStats(alertContext, row);

    let riskFraction = sizing.baseRiskPct;

    if (sizing.enabled) {
      try {
        riskFraction = riskFractionForEntry({
          weeklyStats: weeklyStats || row,
          side: TARGET_DASHBOARD_SIDE,
          tradeSide: TARGET_TRADE_SIDE
        });
      } catch {
        riskFraction = sizing.baseRiskPct;
      }
    }

    const entry = buildVirtualEntryAction({
      row,
      alertContext,
      weeklyStats,
      riskFraction,
      virtualGate
    });

    try {
      const position = buildOpenPositionFromEntry(entry);

      await saveOpenPosition({
        ...position,
        currentMarketWeather: compactMarketWeather(
          position.currentMarketWeather || position.entryMarketWeather
        ),
        currentMarketUniverse: null,
        marketWeatherRowsExcluded: true,
        marketUniverseRowsExcluded: true,
        candleDataExcluded: true,
        ...isolationFlags()
      });

      if (symbolKey) openSymbolSet.add(symbolKey);

      entryRows += 1;
      virtualCreatedRows += 1;

      const discordResult = maybeSendDiscordEntryAlert(entry);
      if (discordResult.queued) discordAlertsQueued += 1;

      actions.push({
        ...entry,
        discordAlertResult: discordResult,
        discordAlertQueued: Boolean(discordResult.queued),
        discordAlertSent: false
      });
    } catch (error) {
      waitRows += 1;
      virtualFailedRows += 1;
      actions.push(
        waitAction(row, 'VIRTUAL_POSITION_CREATE_FAILED', {
          error: error?.message || String(error)
        })
      );
    }
  }

  const batchProcessingComplete =
    !analyzeError &&
    !entryProcessingIncomplete &&
    processed.length === candidateBatch.length;

  const nextCandidateIndex = batchProcessingComplete
    ? candidateEndExclusive
    : candidateStartIndex;

  const snapshotProcessingComplete =
    batchProcessingComplete && nextCandidateIndex >= allCandidates.length;

  await saveProgress(durableRedis, {
    snapshotId: snapshot.snapshotId,
    processedAt: now(),
    completed: snapshotProcessingComplete,
    batchProcessingComplete,
    candidateStartIndex,
    candidateEndExclusive,
    nextCandidateIndex,
    snapshotCandidateCount: allCandidates.length,
    batchSize: candidateBatch.length,
    analyzeError,
    entryProcessingIncomplete,
    selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
    currentMarketWeather: marketContext.weather,
    currentRegime: marketContext.regime,
    currentTrendSide: marketContext.trendSide
  });

  const boundedActions = actions.slice(0, cfg.runResponseActionLimit);
  const counts = actionCounts([
    ...actions,
    ...virtualExits
  ]);

  const qualityAudit = buildQualityAudit({
    totalCandidates: allCandidates.length,
    batchCandidates: candidateBatch.length,
    processed: processed.length,
    liveRows: liveRows.length,
    analyzedRows: analyzedRows.length,
    entryRows,
    waitRows,
    virtualCreatedRows,
    virtualExitRows: virtualExits.length,
    skippedByExistingSymbol,
    analyzeError,
    batchStart: candidateStartIndex,
    batchEnd: candidateEndExclusive,
    nextCandidateIndex,
    snapshotComplete: snapshotProcessingComplete,
    marketContext
  });

  return saveRunMeta({
    runId,
    startedAt,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec: Math.round(snapshotAgeSec),
    selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot.selectedSnapshotReason || null,

    candidateStartIndex,
    candidateEndExclusive,
    nextCandidateIndex,
    snapshotCandidateCount: allCandidates.length,
    batchNumber:
      Math.floor(candidateStartIndex / cfg.maxCandidatesPerInvocation) + 1,
    batchSize: candidateBatch.length,
    batchProcessingComplete,
    snapshotProcessingComplete,
    snapshotContinuation: continuation,

    candidates: candidateBatch.length,
    totalSnapshotCandidates: allCandidates.length,
    processed: processed.length,
    liveRows: liveRows.length,
    analyzedRows: analyzedRows.length,
    analyzedRowsRaw: analyzedRowsRaw.length,
    analyzeBatchMeta,
    analyzeError,

    entryRows,
    waitRows,
    virtualCreatedRows,
    virtualSkippedRows,
    virtualFailedRows,
    skippedByExistingSymbol,

    actions: boundedActions,
    responseActionsTruncated: actions.length > boundedActions.length,
    rawActionsCount: actions.length,
    actionCounts: counts,

    virtualExits,
    virtualExitRows: virtualExits.length,
    shadowExits: virtualExits,
    shadowExitRows: virtualExits.length,
    realExits: [],
    realExitRows: 0,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,
    selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    activeMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,

    discordAlertsQueued,
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    discordMinCurrentFitConfidence: discordMinCurrentFitConfidence(),

    currentMarketWeather: marketContext.weather,
    currentMarketUniverse: null,
    currentRegime: marketContext.regime,
    currentTrendSide: marketContext.trendSide,
    currentBullishPct: marketContext.bullishPct,
    currentBearishPct: marketContext.bearishPct,
    currentSqueezePct: marketContext.squeezePct,

    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: true,
    minLiveCandles15m: cfg.minLiveCandles15m,
    allowStandardizedLearningRiskFallback:
      cfg.allowStandardizedLearningRiskFallback,
    allowStandardizedLearningRiskVirtualEntries:
      cfg.allowStandardizedLearningRiskVirtualEntries,
    minRiskPct: cfg.minRiskPct,
    maxRiskPct: cfg.maxRiskPct,
    fallbackRiskPct: cfg.fallbackRiskPct,

    qualityAudit,

    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot: true,
    skippedNewEntries: false,
    reason: snapshotProcessingComplete
      ? 'SNAPSHOT_PROCESSING_COMPLETE'
      : batchProcessingComplete
        ? 'SNAPSHOT_BATCH_COMPLETE_MORE_REMAINING'
        : analyzeError
          ? 'SNAPSHOT_BATCH_RETRY_REQUIRED_ANALYZE_ERROR'
          : 'SNAPSHOT_BATCH_RETRY_REQUIRED_RUNTIME_BUDGET',

    runtimeBudgetMs: runtime.runtimeBudgetMs,
    deadlineAt: runtime.deadlineAt,
    remainingRuntimeMs: runtime.remainingMs(),

    compactPersistence: true,
    fullPayloadPersisted: false,
    marketWeatherRowsPersisted: false,
    marketUniverseRowsPersisted: false,
    candidateRowsPersisted: false,
    candleDataPersisted: false
  });
}
