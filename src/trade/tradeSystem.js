// ================= FILE: src/trade/tradeSystem.js =================

import { createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { KEYS, assertKeyAllowedForWriteScope } from '../keys.js';
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
import {
  MARKET_WEATHER_KEY_VERSION as SHORT_MARKET_WEATHER_KEY_VERSION,
  PLAYBOOK_MAX_AGE_MIN,
  UNKNOWN_MARKET_WEATHER_KEY,
  normalizeMarketWeatherRegime,
  normalizeMarketWeatherTrendSide,
  buildEntryMarketWeatherKey,
  buildEntryMarketWeatherSnapshot,
  parseMarketWeatherKey,
  confirmedMarketWeatherFromInput,
  isFreshConfirmedMarketWeather
} from '../market/marketKey.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const LEGACY_SHORT_KEY_PREFIX = 'SHORT_';
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;
const EXECUTION_MICRO_SUFFIX = 'XR';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const SELECTION_PARENT_CONTEXT = 'PARENT_15_CONTEXT_ONLY';
const SELECTION_75_CHILD_CONTEXT = 'MICRO_75_CONTEXT_ONLY';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO_ONLY';

const TRADE_SYSTEM_VERSION = 'SHORT_TRADE_SYSTEM_WEATHER_AWARE_PLAYBOOK_SELECTOR_V2_IMPORT_SAFE';
const ENTRY_RELAXATION_PROFILE = 'SHORT_SCANNER_WIDE_VIRTUAL_LEARNING_WEATHER_CAPTURE_V2';
const QUALITY_MEASUREMENT_PROFILE = 'SHORT_MICRO_MICRO_WEATHER_AWARE_SELECTOR_SAFE_PHASES_V2';

const MICRO_MICRO_VERSION =
  'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V4_WEATHER_AWARE_IMPORT_SAFE';

const SHORT_RISK_PLAN_VERSION =
  'SHORT_ADAPTIVE_RR_TP_SL_V3_WEATHER_AWARE_PLAYBOOK';

const RR_SHADOW_GRID_VERSION =
  'SHORT_RR_SHADOW_GRID_V3_WEATHER_AWARE';

const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_STATUS_GATE_V3_WEATHER_EMPIRICAL_VETO';

const DISCORD_ACTIVATION_GATE_VERSION =
  'SHORT_MM_DISCORD_ACTIVATION_WEATHER_PLAYBOOK_GATE_V1_OBSERVE';

const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V1_OBSERVE';

const MARKET_WEATHER_SIGNAL_DECISION_VERSION =
  'SHORT_MARKET_WEATHER_SIGNAL_DECISION_V2_RISK_AFTER_PROOF';

const MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION =
  'SHORT_MARKET_WEATHER_PLAYBOOK_FRESHNESS_V1_MAX_AGE_240_REFRESH_ON_CHANGE';

const EMPIRICAL_VETO_VERSION =
  'SHORT_EXACT_MM_EMPIRICAL_VETO_LCB95_V1';

const POSITION_SIZING_PROOF_INPUT_VERSION =
  'SHORT_POSITION_SIZING_PROOF_INPUT_V2_WEATHER_PLAYBOOK';

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_MICRO_MICRO_MARKET_PROOF = 'MICRO_MICRO_MARKET_PROOF';
const PROOF_TIER_MICRO_MICRO_LIFETIME_PROOF = 'MICRO_MICRO_LIFETIME_PROOF';
const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';

const MAX_ALLOWED_RISK_BAND_HIGH = 'HIGH';
const MAX_ALLOWED_RISK_BAND_LOW = 'LOW';
const MAX_ALLOWED_RISK_BAND_ZERO = 'ZERO';

const MICRO_MICRO_STATUS_OBSERVING = 'OBSERVING';
const MICRO_MICRO_STATUS_PASSED = 'PASSED';
const MICRO_MICRO_STATUS_REJECTED = 'REJECTED';
const MICRO_MICRO_STATUS_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const MICRO_MICRO_STATUS_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MICRO_MICRO_STATUS_RANK = Object.freeze({
  [MICRO_MICRO_STATUS_PASSED]: 0,
  [MICRO_MICRO_STATUS_OBSERVING]: 1,
  [MICRO_MICRO_STATUS_REJECTED]: 2,
  [MICRO_MICRO_STATUS_EMPIRICAL_VETO]: 3,
  [MICRO_MICRO_STATUS_POLICY_BLOCKED]: 4
});

const WEAK_CONTRA_ENTRY_GATE_VERSION = 'SHORT_E_WEAK_CONTRA_STRICT_ENTRY_GATE_V3_POLICY_ONLY';
const HARD_TIME_STOP_CLEANUP_VERSION = 'SHORT_TRADE_SYSTEM_MONITOR_HARD_TIME_STOP_PRE_PRICE_V1';

const MIN_DISCORD_ACTIVATION_COMPLETED = 35;
const MIN_DISCORD_ACTIVATION_LCB95_AVG_R = 0;
const MIN_DISCORD_ACTIVATION_AVG_R = 0;
const MIN_DISCORD_ACTIVATION_TOTAL_R = 0;
const MIN_DISCORD_ACTIVATION_PROFIT_FACTOR = 1;
const MAX_DISCORD_ACTIVATION_AVG_COST_R = 0.35;
const MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT = 0.25;
const MIN_EMPIRICAL_VETO_COMPLETED = 35;
const BLOCK_E_WEAK_CONTRA_FOR_POLICY_GATE = true;

const DEFAULT_RR_VARIANTS = Object.freeze([1, 1.25, 1.5, 1.75, 2]);
const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 10;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 25;
const DEFAULT_DATA_CONCURRENCY = 2;
const DEFAULT_MAX_SNAPSHOT_AGE_SEC = 8 * 60;

const DEFAULT_MIN_RISK_PCT = 0.0045;
const DEFAULT_MAX_RISK_PCT = 0.035;
const DEFAULT_FALLBACK_RISK_PCT = 0.0065;
const DEFAULT_RR = 1.5;
const DEFAULT_MIN_RR = 1;
const DEFAULT_MAX_RR = 2;
const DEFAULT_MIN_REWARD_PCT = 0.0075;
const DEFAULT_MIN_DISCORD_REWARD_PCT = 0.01;
const DEFAULT_MAX_RISK_TO_REWARD_DISTANCE_RATIO = 1.05;
const DEFAULT_MAX_ESTIMATED_COST_R = 0.35;
const DEFAULT_HARD_MAX_ESTIMATED_COST_R = 0.55;

const DEFAULT_ROUND_TRIP_FEE_PCT = 0.0012;
const DEFAULT_ROUND_TRIP_SLIPPAGE_PCT = 0.0004;
const DEFAULT_FALLBACK_SPREAD_PCT = 0.0008;
const DEFAULT_SPREAD_COST_MULT = 1;

const DEFAULT_MONITOR_TIMEOUT_MS = 9500;
const DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS = 650;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 1600;
const DEFAULT_ANALYZE_TIMEOUT_MS = 3500;
const DEFAULT_ROTATION_TIMEOUT_MS = 900;
const DEFAULT_MARKET_CONTEXT_TIMEOUT_MS = 900;
const DEFAULT_MAX_RUNTIME_MS = 26000;
const DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS = 2500;
const DEFAULT_SAVE_POSITION_TIMEOUT_MS = 1200;
const DEFAULT_MONITOR_BATCH_SIZE = 150;
const DEFAULT_OPEN_POSITION_MONITOR_LIMIT = 250;
const DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS = 3;
const DEFAULT_ENTRY_LOOP_RESERVE_MS = 900;

const DEFAULT_HARD_TIME_STOP_NO_PRICE_EXIT = true;
const DEFAULT_CLOSE_EXPIRED_BEFORE_PRICE_FETCH = true;
const DEFAULT_MONITOR_CANDLE_RANGE_ENABLED = true;

const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const LIVE_PRICE_CACHE_TTL_MS = 2500;

const MARKET_WEATHER_LATEST_KEYS = Object.freeze([
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:CONFIRMED`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:CURRENT`,
  `${SHORT_KEY_PREFIX}MARKET:WEATHER`,
  `${LEGACY_SHORT_KEY_PREFIX}MARKET:WEATHER:CONFIRMED`,
  `${LEGACY_SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
  `${LEGACY_SHORT_KEY_PREFIX}MARKET:WEATHER:CURRENT`,
  `${LEGACY_SHORT_KEY_PREFIX}MARKET:WEATHER`,
  'MARKET:WEATHER:CONFIRMED',
  'MARKET:WEATHER:LATEST',
  'MARKET:WEATHER:CURRENT',
  'MARKET:WEATHER'
]);

const MARKET_UNIVERSE_LATEST_KEYS = Object.freeze([
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE`,
  `${LEGACY_SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
  `${LEGACY_SHORT_KEY_PREFIX}MARKET:UNIVERSE`,
  'MARKET:UNIVERSE:LATEST',
  'MARKET:UNIVERSE'
]);

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

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const livePriceCache = new Map();
let ACTIVE_RUN_OPTIONS = {};

function now() {
  return Date.now();
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function n(value, fallback = 0) {
  const parsed = safeNumber(value, fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function int(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return Math.max(min, Math.min(max, Math.floor(n(value, fallback))));
}

function minRuntimeFloor(value, fallback, minFloor, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = int(value, fallback, min, max);
  return Math.max(minFloor, parsed);
}

function clamp(value, min, max) {
  const x = Number(value);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min;
}

function round(value, decimals = 8) {
  return Number(n(value, 0).toFixed(decimals));
}

function roundPrice(value) {
  const x = n(value, 0);
  if (x >= 1000) return Number(x.toFixed(2));
  if (x >= 1) return Number(x.toFixed(6));
  return Number(x.toFixed(10));
}

function pct(part, total) {
  const t = n(total, 0);
  return t > 0 ? Number(((n(part, 0) / t) * 100).toFixed(2)) : 0;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  const stack = Array.isArray(values) ? [...values] : [values];

  while (stack.length) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

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

function timeoutPayload(label, ms) {
  return new Promise((resolve) => setTimeout(
    () => resolve({ __timeout: true, label, timeoutMs: ms }),
    Math.max(1, int(ms, 1))
  ));
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeoutPayload(label, ms)]);
}

function isTimeoutResult(value) {
  return Boolean(value && typeof value === 'object' && value.__timeout === true);
}

function runtimeExceeded(startedAt, cfg, reserveMs = 1000) {
  return now() - n(startedAt, now()) >= Math.max(
    1000,
    n(cfg.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS) - reserveMs
  );
}

function hashText(value, length = MICRO_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}

function keyFromMaybeFunction(fn, arg, fallback = null) {
  try {
    return typeof fn === 'function' ? fn(arg) : fallback;
  } catch {
    return fallback;
  }
}

function namespacedShortKey(key, fallback = 'UNKNOWN') {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}${fallback}`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith(LEGACY_SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function shortScanSnapshotKey(id) {
  return namespacedShortKey(
    keyFromMaybeFunction(KEYS.short?.scan?.snapshot, id, null) ||
      keyFromMaybeFunction(KEYS.scan?.shortSnapshot, id, null) ||
      keyFromMaybeFunction(KEYS.scan?.snapshot, id, null),
    `SCAN:SNAPSHOT:${id}`
  );
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
      'TRADE:RUN:META'
    ),
    lastProcessedSnapshot: namespacedShortKey(
      KEYS.short?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.shortLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    ),
    lastConfirmedWeatherKey: namespacedShortKey(
      KEYS.short?.trade?.lastConfirmedWeatherKey ||
        KEYS.trade?.shortLastConfirmedWeatherKey,
      'TRADE:LAST_CONFIRMED_MARKET_WEATHER_KEY'
    )
  }
};

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
    signalSide: TARGET_TRADE_SIDE,
    entrySide: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function isolationFlags() {
  return {
    namespace: SHORT_NAMESPACE,
    redisNamespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    scannerRunAllowed: false,
    noScannerRun: true,
    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesMarketUniverse: false,
    writesMarketWeather: false,

    writesTrade: true,
    writesAnalyze: true,
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

    globalMaxOpenPositionsBlockDisabled: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,
    monitorOpenPositionsBeforeEntries: true,
    monitorTimeoutDoesNotBlockEntries: true,

    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
  };
}

function marketWeatherFeatureFlags() {
  return {
    version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
    capture: 'live',
    aggregation: 'live',
    selector: 'observe',
    sizingCap: 'observe',
    fdr: 'observe',
    discordTradeReady: 'validated_only',

    marketWeatherCaptureEnabled: true,
    marketWeatherAggregationEnabled: true,
    marketWeatherSelectorEnabled: true,
    marketWeatherSelectorMode: 'OBSERVE',
    marketWeatherFdrEnabled: true,
    marketWeatherFdrMode: 'OBSERVE',
    marketWeatherSizingCapEnabled: true,
    marketWeatherSizingCapMode: 'OBSERVE',
    marketWeatherDiscordTradeReadyEnabled: false,

    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
    marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,

    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    unknownMarketWeatherNeverTradeReady: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsDerivedOnly: true,
    tradeReadyManualOverrideAllowed: false,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoBlocksParentRescue: true
  };
}

function microPolicyFlags() {
  return {
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: CHILD75_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    microMicroVersion: MICRO_MICRO_VERSION,
    learningHierarchy: 'PARENT_15_TO_MICRO_75_TO_MICRO_MICRO',

    parentSelectionAllowed: false,
    micro75SelectionAllowed: false,
    microMicroSelectionAllowed: true,
    selectionGranularity: SELECTION_EXACT_MICRO_MICRO,

    manualSelectionOnly: true,
    manualSelectionRequired: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,
    scannerMatchTriggersDiscord: false,

    discordActivationRequiresWeatherPlaybook: true,
    discordActivationRequiresNetEdge: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordRuntimeGateRequired: true,
    discordRuntimeGateSource: 'ACTIVE_ROTATION_ROW_PERSISTENT_STATS_RECHECKED_IN_TRADE_SYSTEM'
  };
}

function virtualFlags(row = {}) {
  return {
    virtualOnly: true,
    virtualTracked: true,
    virtualLearning: true,
    source: row.source || 'VIRTUAL',
    outcomeSource: row.outcomeSource || 'VIRTUAL',
    paperTrade: true,
    paperPosition: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    noRealOrders: true,
    noExchangeOrders: true,

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    rrVariants: row.rrVariants || DEFAULT_RR_VARIANTS,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    executionContextHashIncludedInMicroMicroId: true,

    scannerHashesExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: false,
    entryMarketWeatherKeyExcludedFromFamilyId: true,
    weatherExcludedFromFamilyId: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscord: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejectedBlocksVirtualEntry: true,
    weakContraRejectedBlocksLearning: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortRiskShape: true,
    shortRiskShape: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
    hardTimeStopNoPriceExit: DEFAULT_HARD_TIME_STOP_NO_PRICE_EXIT,
    closeExpiredBeforePriceFetch: DEFAULT_CLOSE_EXPIRED_BEFORE_PRICE_FETCH,

    marketWeatherFeatureFlagsVersion: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
    marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95: true,
    empiricalVetoBlocksParentFallbackRescue: true,
    positionSizingProofInputVersion: POSITION_SIZING_PROOF_INPUT_VERSION,

    ...microPolicyFlags()
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
    .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
    .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
    .replaceAll('BLOCK_SHORT', 'LONG')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
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
    text.includes(`:${pattern}`) ||
    text.includes(`|${pattern}|`)
  ));
}

function hasShortSignal(value = '') {
  const raw = normalizedSignalText(value);
  if (!raw) return false;

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

function normalizeTradeSide(side) {
  const raw = cleanSideText(side);
  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);
  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) return normalizeTradeSide(row);

  for (const value of [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.signalSide,
    row.entrySide,
    row.side
  ]) {
    const side = normalizeTradeSide(value);
    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.analyzeMicroFamilyId,
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
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ].map(cleanSideText).filter(Boolean).join('|');

  const shortHit = hasShortSignal(haystack);
  const longHit = hasLongSignal(haystack);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) !== OPPOSITE_TRADE_SIDE;
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

  if (isScannerFingerprintId(value)) {
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

  for (const profile of CONFIRMATION_PROFILES) {
    const suffix = `_${profile}`;
    if (body.endsWith(suffix)) {
      confirmationProfile = profile;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setupType = null;
  let regimeBucket = null;

  for (const candidateRegime of REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;
    if (body.endsWith(suffix)) {
      regimeBucket = candidateRegime;
      setupType = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setupType && regimeBucket
    ? `MICRO_SHORT_${setupType}_${regimeBucket}`
    : null;

  const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;

  const validParent =
    Boolean(parentId) &&
    SETUP_SET.has(setupType) &&
    REGIME_SET.has(regimeBucket);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    CONFIRMATION_SET.has(confirmationProfile);

  if (validChild && microMicroHash) {
    microMicroFamilyId = `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;
  }

  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;

  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isMicroMicro,

    isParent,
    isChild,
    isMicroMicro,
    rawId,
    id: microMicroFamilyId || childId || parentId || value,

    setupType,
    regimeBucket,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    learningLayer: isMicroMicro
      ? LAYER_MICRO_MICRO
      : isChild
        ? LAYER_MICRO_75
        : isParent
          ? LAYER_PARENT_15
          : 'UNKNOWN'
  };
}

function isSelectableTrueMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}

function isSelectableMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isParentTrueMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);
  if (isSelectableMicroMicroId(value)) return false;

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanLearningFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim().toUpperCase();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  const parsed = parseShortTaxonomyMicroId(raw);
  if (parsed.isChild) return parsed.childTrueMicroFamilyId;
  if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
  if (parsed.isParent) return parsed.parentTrueMicroFamilyId;

  const symbolTokens = [row.symbol, row.baseSymbol, row.contractSymbol]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);

  let clean = raw;

  for (const token of symbolTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    clean = clean
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'), '$1ASSET$2');
  }

  clean = clean
    .replace(/_{2,}/g, '_')
    .replace(/\|{2,}/g, '|')
    .replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '');

  if (!clean) return '';
  if (isScannerFingerprintId(clean)) return '';
  if (isExecutionFingerprintId(clean)) return '';

  const reparsed = parseShortTaxonomyMicroId(clean);
  if (reparsed.valid) return reparsed.id;

  return '';
}

function parentIdFromChild(id = '') {
  return parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId || '';
}

function childIdFromAnyLearningId(id = '') {
  return parseShortTaxonomyMicroId(id).childTrueMicroFamilyId || '';
}

function microMicroHashFromId(id = '') {
  return parseShortTaxonomyMicroId(id).microMicroHash || '';
}

function normalizeBucketText(value, fallback = 'NA') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || fallback;
}

function symbolTokensFromAnySymbol(symbol = '') {
  const contract = normalizeContractSymbol(symbol);
  const base = normalizeBaseSymbol(symbol || contract);

  return [
    symbol,
    contract,
    base,
    normalizeSymbolToken(symbol),
    normalizeSymbolToken(contract),
    normalizeSymbolToken(base)
  ].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean);
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
  ].flatMap(symbolTokensFromAnySymbol).map(symbolKey).filter(Boolean);
}

function getTrueMicroFamilyId(row = {}) {
  const candidates = [
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.learningFamilyId,
    row.analyzeMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ].map((id) => cleanLearningFamilyId(id, row));

  for (const candidate of candidates) {
    const parsed = parseShortTaxonomyMicroId(candidate);
    if (parsed.isChild && parsed.childTrueMicroFamilyId) return parsed.childTrueMicroFamilyId;
    if (parsed.isMicroMicro && parsed.childTrueMicroFamilyId) return parsed.childTrueMicroFamilyId;
  }

  return '';
}

function buildExecutionFingerprintParts(row = {}, childTrueMicroFamilyId = '') {
  const parsed = parseShortTaxonomyMicroId(childTrueMicroFamilyId);
  const parentId = parsed.parentTrueMicroFamilyId || row.parentTrueMicroFamilyId || parentIdFromChild(childTrueMicroFamilyId);

  return [
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${childTrueMicroFamilyId || 'NO_TRUE_MICRO'}`,
    `PARENT_TRUE_MICRO=${parentId || 'NO_PARENT_TRUE_MICRO'}`,
    `SETUP=${parsed.setupType || row.setupType || 'NA'}`,
    `REGIME_BUCKET=${parsed.regimeBucket || row.regimeBucket || 'NA'}`,
    `CONFIRMATION_PROFILE=${parsed.confirmationProfile || row.confirmationProfile || 'NA'}`,
    `RSI=${normalizeBucketText(row.rsiZone || row.rsiCoarse || 'NA')}`,
    `FLOW=${normalizeBucketText(row.flowCoarse || row.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(row.btcRelation || 'NA')}`,
    `REGIME=${normalizeBucketText(row.regimeCoarse || row.regime || row.regimeBucket || 'NA')}`,
    `SCANNER=${normalizeBucketText(row.scannerReasonCoarse || row.scannerReason || row.reason || 'NA')}`,
    `SPREAD_BPS=${normalizeBucketText(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${normalizeBucketText(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${normalizeBucketText(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONFLUENCE=${normalizeBucketText(row.confluence ?? row.sniperScore ?? row.scannerScore ?? 'NA')}`,
    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`,
    `ENTRY_DIST=${normalizeBucketText(row.entryDistancePct ?? row.entryDistanceBps ?? 'NA')}`,
    `RISK_PCT=${normalizeBucketText(row.riskPct ?? row.slDistancePct ?? 'NA')}`,
    `REWARD_PCT=${normalizeBucketText(row.rewardPct ?? row.tpDistancePct ?? 'NA')}`,
    `RISK_REWARD_RATIO=${normalizeBucketText(row.riskToRewardDistanceRatio ?? 'NA')}`,
    `FAKE_BREAKOUT=${row.fakeBreakout === true ? 'YES' : 'NO'}`,
    `FAKE_RISK=${row.fakeBreakoutRisk === true ? 'YES' : 'NO'}`,
    `WEAK_CONTRA_GATE=${row.weakContraRejectReason || row.weakContraEntryGate?.reason || 'NA'}`,
    `CURRENT_FIT=${normalizeBucketText(row.currentFit || row.entryCurrentFit || 'NA')}`,
    `RISK_PLAN=${row.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    `HARD_TIME_STOP=${HARD_TIME_STOP_CLEANUP_VERSION}`,
    'ENTRY_MARKET_WEATHER_EXCLUDED_FROM_ID=TRUE',
    'EXECUTION_FINGERPRINT_ROLE=MICRO_MICRO_HASH_SOURCE'
  ];
}

function executionHashFromRow(row = {}, childTrueMicroFamilyId = '') {
  const direct = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  ).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');

  if (direct.length >= 6) return direct.slice(0, MICRO_MICRO_HASH_LEN);

  const executionId = String(
    row.executionMicroFamilyId ||
      row.executionFingerprintMicroFamilyId ||
      row.refinedExecutionMicroFamilyId ||
      ''
  ).trim().toUpperCase();

  const xrMatch = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,24})$/u.exec(executionId);
  if (xrMatch) return xrMatch[2].slice(0, MICRO_MICRO_HASH_LEN);

  return hashText(buildExecutionFingerprintParts(row, childTrueMicroFamilyId).join('|'), MICRO_MICRO_HASH_LEN);
}

function buildMicroMicroFamilyIdFromExecution(childTrueMicroFamilyId, executionFingerprintHash) {
  const childId = childIdFromAnyLearningId(childTrueMicroFamilyId) || (
    isSelectableTrueMicroId(childTrueMicroFamilyId)
      ? upper(childTrueMicroFamilyId)
      : ''
  );

  const hash = String(executionFingerprintHash || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);

  if (!childId || hash.length < 6) return '';

  return `${childId}_${MICRO_MICRO_SUFFIX}_${hash}`;
}

function getMicroMicroFamilyId(row = {}) {
  const direct = [
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key
  ].map((id) => cleanLearningFamilyId(id, row)).find(isSelectableMicroMicroId);

  if (direct) return direct;

  const child = getTrueMicroFamilyId(row);
  if (!child) return '';

  const hash = executionHashFromRow(row, child);
  const id = buildMicroMicroFamilyIdFromExecution(child, hash);

  return isSelectableMicroMicroId(id) ? id : '';
}

function getParentTrueMicroFamilyId(row = {}) {
  const child = getTrueMicroFamilyId(row);
  if (child) return parentIdFromChild(child);

  return [
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId
  ].map((id) => cleanLearningFamilyId(id, row)).find(isParentTrueMicroId) || '';
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

function learningIdentityFields(row = {}) {
  const childTrueMicroFamilyId = getTrueMicroFamilyId(row);
  const microMicroFamilyId = getMicroMicroFamilyId({ ...row, childTrueMicroFamilyId });
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId({ ...row, childTrueMicroFamilyId });

  const parsedChild = parseShortTaxonomyMicroId(childTrueMicroFamilyId);
  const parsedMicroMicro = parseShortTaxonomyMicroId(microMicroFamilyId);

  return {
    learningLayer: microMicroFamilyId ? LAYER_MICRO_MICRO : childTrueMicroFamilyId ? LAYER_MICRO_75 : parentTrueMicroFamilyId ? LAYER_PARENT_15 : 'UNKNOWN',

    parentTrueMicroFamilyId: parentTrueMicroFamilyId || null,
    parentMicroFamilyId: parentTrueMicroFamilyId || null,
    parentMacroFamilyId: parentTrueMicroFamilyId || null,
    macroFamilyId: parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: parentTrueMicroFamilyId || null,
    baseMicroFamilyId: parentTrueMicroFamilyId || null,
    legacyMicroFamilyId: parentTrueMicroFamilyId || null,

    microFamilyId: childTrueMicroFamilyId || null,
    trueMicroFamilyId: childTrueMicroFamilyId || null,
    childTrueMicroFamilyId: childTrueMicroFamilyId || null,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId || null,
    baseTrueMicroFamilyId: childTrueMicroFamilyId || null,
    trueMicro75FamilyId: childTrueMicroFamilyId || null,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: parsedMicroMicro.microMicroHash || row.microMicroHash || null,

    learningFamilyId: microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId || null,
    learningMicroFamilyId: microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId || null,
    analyzeMicroFamilyId: microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId || null,
    familyId: microMicroFamilyId || childTrueMicroFamilyId || parentTrueMicroFamilyId || null,

    setupType: parsedChild.setupType || row.setupType || null,
    regimeBucket: parsedChild.regimeBucket || row.regimeBucket || null,
    confirmationProfile: parsedChild.confirmationProfile || row.confirmationProfile || null,

    exact75ChildTrueMicro: Boolean(childTrueMicroFamilyId),
    exactMicroMicro: Boolean(microMicroFamilyId),
    fixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId || microMicroFamilyId),

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: microMicroFamilyId ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: microMicroFamilyId ? MICRO_MICRO_LEARNING_GRANULARITY : CHILD75_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectable: Boolean(microMicroFamilyId),
    selectableChild: false,
    selectableMicroMicro: Boolean(microMicroFamilyId),
    parentSelectionAllowed: false,
    micro75SelectionAllowed: false,
    microMicroSelectionAllowed: Boolean(microMicroFamilyId),

    selectionGranularity: microMicroFamilyId
      ? SELECTION_EXACT_MICRO_MICRO
      : childTrueMicroFamilyId
        ? SELECTION_75_CHILD_CONTEXT
        : SELECTION_PARENT_CONTEXT,

    sampleDoesNotSplitParent: true,
    sampleDoesNotSplitMicro75: true,
    rollupStatsRequired: true,
    rollupParent15: parentTrueMicroFamilyId || null,
    rollupMicro75: childTrueMicroFamilyId || null,
    rollupMicroMicro: microMicroFamilyId || null
  };
}

function scannerMetadataFrom(...rows) {
  const merged = Object.assign({}, ...rows.filter(Boolean));
  const childTrueMicroFamilyId = getTrueMicroFamilyId(merged);
  const microMicroFamilyId = getMicroMicroFamilyId({ ...merged, childTrueMicroFamilyId });
  const microMicroHash = microMicroHashFromId(microMicroFamilyId) || executionHashFromRow(merged, childTrueMicroFamilyId);
  const learning = learningIdentityFields({
    ...merged,
    childTrueMicroFamilyId,
    microMicroFamilyId,
    microMicroHash
  });

  return {
    ...learning,

    scannerMicroFamilyId: merged.scannerMicroFamilyId || null,
    scannerFamilyId: merged.scannerFamilyId || null,
    scannerDefinition: merged.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(merged.scannerDefinitionParts) ? merged.scannerDefinitionParts : [],

    executionFingerprintHash: microMicroHash || merged.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(merged.executionFingerprintParts)
      ? merged.executionFingerprintParts
      : childTrueMicroFamilyId
        ? buildExecutionFingerprintParts(merged, childTrueMicroFamilyId)
        : [],
    executionMicroFamilyId: childTrueMicroFamilyId && microMicroHash
      ? `${childTrueMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${microMicroHash}`
      : merged.executionMicroFamilyId || null,
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: !microMicroFamilyId,
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,
    executionContextHashIncludedInMicroMicroId: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    learningIdentitySource: microMicroFamilyId
      ? 'ANALYZE_MICRO_MICRO_FAMILY'
      : 'ANALYZE_TRUE_MICRO_FAMILY_CONTEXT_ONLY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    scannerHashesExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: false,
    entryMarketWeatherKeyExcludedFromFamilyId: true
  };
}

function setupFromRow(row = {}) {
  const parsed = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      row.microMicroFamilyId ||
      ''
  );

  if (parsed.setupType && SETUP_SET.has(parsed.setupType)) return parsed.setupType;

  const text = upper([
    row.scannerReason,
    row.reason,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].filter(Boolean).join('|'));

  if (text.includes('BREAKOUT') || text.includes('BREAKDOWN')) return 'BREAKOUT';
  if (text.includes('SWEEP')) return 'SWEEP_REVERSAL';
  if (text.includes('RETEST') || text.includes('PULLBACK')) return 'RETEST';
  if (text.includes('SQUEEZE') || text.includes('COMPRESSION')) return 'COMPRESSION';

  return 'CONTINUATION';
}

function normalizeMarketRegime(value = '') {
  const normalized = normalizeMarketWeatherRegime(value);
  return REGIME_SET.has(normalized) ? normalized : 'UNKNOWN';
}

function normalizeMarketTrendSide(value = '') {
  const normalized = normalizeMarketWeatherTrendSide(value);

  if (normalized === 'BEARISH') return TARGET_TRADE_SIDE;
  if (normalized === 'BULLISH') return OPPOSITE_TRADE_SIDE;
  if (normalized === 'NEUTRAL') return 'NEUTRAL';

  const side = normalizeTradeSide(value);
  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function marketTrendSideForWeather(value = '') {
  const normalized = normalizeMarketWeatherTrendSide(value);

  if (normalized === 'BEARISH' || normalized === 'BULLISH' || normalized === 'NEUTRAL') {
    return normalized;
  }

  const side = normalizeTradeSide(value);
  if (side === TARGET_TRADE_SIDE) return 'BEARISH';
  if (side === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  return 'UNKNOWN';
}

function normalizeTimestampMs(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 9999999999) return Math.round(value * 1000);
    return Math.round(value);
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    if (asNumber > 0 && asNumber < 9999999999) return Math.round(asNumber * 1000);
    return Math.round(asNumber);
  }

  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function buildConfirmedWeatherSnapshot(source = {}, universe = {}, meta = {}) {
  const sourceObj = source && typeof source === 'object' ? source : {};
  const universeObj = universe && typeof universe === 'object' ? universe : {};

  const explicitConfirmed = confirmedMarketWeatherFromInput({
    ...universeObj,
    ...sourceObj,
    confirmedMarketWeather: sourceObj.confirmedMarketWeather || sourceObj.confirmed || null
  });

  let regime = normalizeMarketWeatherRegime(first(
    explicitConfirmed.confirmedMarketWeatherRegime,
    sourceObj.confirmedMarketWeatherRegime,
    sourceObj.currentMarketWeatherRegime,
    sourceObj.marketWeatherRegime,
    sourceObj.currentRegime,
    sourceObj.regime,
    sourceObj.market?.regime,
    universeObj.currentRegime,
    universeObj.regime
  ));

  let trendSide = marketTrendSideForWeather(first(
    explicitConfirmed.confirmedMarketWeatherTrendSide,
    sourceObj.confirmedMarketWeatherTrendSide,
    sourceObj.currentMarketWeatherTrendSide,
    sourceObj.marketWeatherTrendSide,
    sourceObj.currentTrendSide,
    sourceObj.trendSide,
    sourceObj.market?.trendSide,
    sourceObj.marketSide,
    sourceObj.side,
    sourceObj.direction,
    universeObj.currentTrendSide,
    universeObj.trendSide,
    universeObj.marketSide
  ));

  const explicitKey = first(
    sourceObj.confirmedMarketWeatherKey,
    sourceObj.currentMarketWeatherKey,
    sourceObj.marketWeatherKey,
    sourceObj.entryMarketWeatherKey,
    explicitConfirmed.confirmedMarketWeatherKey
  );

  const parsedExplicit = parseMarketWeatherKey(explicitKey);

  if (parsedExplicit.valid) {
    regime = parsedExplicit.regime;
    trendSide = parsedExplicit.trendSide;
  }

  const snapshot = buildEntryMarketWeatherSnapshot({
    ...universeObj,
    ...sourceObj,
    ...meta,
    entryMarketWeatherRegime: regime,
    entryMarketWeatherTrendSide: trendSide,
    marketWeatherRegime: regime,
    marketWeatherTrendSide: trendSide,
    currentRegime: regime,
    currentTrendSide: trendSide,
    bullishPct: first(sourceObj.bullishPct, sourceObj.market?.bullishPct, sourceObj.longPct, sourceObj.upPct, universeObj.bullishPct),
    bearishPct: first(sourceObj.bearishPct, sourceObj.market?.bearishPct, sourceObj.shortPct, sourceObj.downPct, universeObj.bearishPct),
    squeezePct: first(sourceObj.squeezePct, sourceObj.market?.squeezePct, sourceObj.compressionPct, universeObj.squeezePct),
    chopPct: first(sourceObj.chopPct, sourceObj.market?.chopPct, universeObj.chopPct),
    trendPct: first(sourceObj.trendPct, sourceObj.market?.trendPct, universeObj.trendPct),
    confidence: first(sourceObj.confidence, sourceObj.market?.confidence, sourceObj.weatherConfidence, sourceObj.currentTrendConfidence, universeObj.confidence),
    btcState: first(sourceObj.btcState, sourceObj.btc?.state, sourceObj.market?.btcState, universeObj.btcState),
    btcTrendSide: first(sourceObj.btcTrendSide, sourceObj.btc?.trendSide, sourceObj.market?.btcTrendSide, universeObj.btcTrendSide),
    btcChange1h: first(sourceObj.btcChange1h, sourceObj.btc?.change1h, sourceObj.market?.btcChange1h, universeObj.btcChange1h),
    btcChange24h: first(sourceObj.btcChange24h, sourceObj.btc?.change24h, sourceObj.market?.btcChange24h, universeObj.btcChange24h),
    volatilityBucket: first(sourceObj.volatilityBucket, sourceObj.volatilityRegime, sourceObj.market?.volatilityBucket, universeObj.volatilityBucket),
    breadthBucket: first(sourceObj.breadthBucket, sourceObj.breadthRegime, sourceObj.market?.breadthBucket, universeObj.breadthBucket),
    btcGate: first(sourceObj.btcGate, sourceObj.btc?.gate, sourceObj.market?.btcGate, universeObj.btcGate)
  }, now());

  const confirmedAt = normalizeTimestampMs(first(
    sourceObj.confirmedMarketWeatherAt,
    sourceObj.confirmedAt,
    sourceObj.completedAt,
    sourceObj.createdAt,
    sourceObj.updatedAt,
    universeObj.completedAt,
    universeObj.createdAt,
    universeObj.updatedAt,
    now()
  ), now());

  const confirmedKey = parsedExplicit.valid
    ? parsedExplicit.key
    : snapshot.entryMarketWeatherKey;

  const confirmedParsed = parseMarketWeatherKey(confirmedKey);

  return {
    ...snapshot,

    confirmed: confirmedParsed.valid && confirmedParsed.key !== UNKNOWN_MARKET_WEATHER_KEY,
    confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKey: confirmedParsed.key,
    confirmedMarketWeatherRegime: confirmedParsed.regime,
    confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
    confirmedMarketWeatherIsUnknown: confirmedParsed.key === UNKNOWN_MARKET_WEATHER_KEY,
    confirmedMarketWeatherAt: confirmedAt,
    confirmedAt,

    currentMarketWeatherKey: confirmedParsed.key,
    currentMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: confirmedParsed.regime,
    currentMarketWeatherTrendSide: confirmedParsed.trendSide,

    candidateMarketWeatherKey: confirmedParsed.key,
    candidateMarketWeatherRegime: confirmedParsed.regime,
    candidateMarketWeatherTrendSide: confirmedParsed.trendSide,

    reason: confirmedParsed.key === UNKNOWN_MARKET_WEATHER_KEY
      ? 'MARKET_WEATHER_UNKNOWN'
      : 'MARKET_WEATHER_CONFIRMED_FROM_LATEST_CONTEXT'
  };
}

function isUnknownMarketWeatherKey(key = '') {
  const parsed = parseMarketWeatherKey(key);
  return parsed.key === UNKNOWN_MARKET_WEATHER_KEY;
}

function marketWeatherFieldsFromRow(row = {}) {
  const key = row.entryMarketWeatherKey || row.confirmedMarketWeatherKey || row.currentMarketWeatherKey || null;
  const parsed = parseMarketWeatherKey(key);

  return {
    entryMarketWeatherKey: parsed.key,
    entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || SHORT_MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: row.entryMarketWeatherRegime || row.confirmedMarketWeatherRegime || row.currentMarketWeatherRegime || parsed.regime || 'UNKNOWN',
    entryMarketWeatherTrendSide: row.entryMarketWeatherTrendSide || row.confirmedMarketWeatherTrendSide || row.currentMarketWeatherTrendSide || parsed.trendSide || 'UNKNOWN',
    entryMarketWeatherCapturedAt: row.entryMarketWeatherCapturedAt || row.confirmedAt || row.createdAt || null,
    entryMarketWeatherRaw: row.entryMarketWeatherRaw || row.entryMarketWeather || null,
    entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
      ? row.entryMarketWeatherRawAvailableFields
      : [],
    entryMarketWeatherSourceReadFrom: row.entryMarketWeatherSourceReadFrom || row.currentMarketWeatherReadFrom || null,
    entryMarketWeatherSourceKey: row.entryMarketWeatherSourceKey || row.currentMarketWeatherSourceKey || null,
    entryMarketWeatherAgeSec: row.entryMarketWeatherAgeSec ?? row.currentMarketWeatherAgeSec ?? null,
    entryMarketWeatherStale: Boolean(row.entryMarketWeatherStale || row.currentMarketWeatherStale),
    entryMarketWeatherImmutable: row.entryMarketWeatherImmutable !== false,
    entryMarketWeatherNeverRecomputedAtExit: row.entryMarketWeatherNeverRecomputedAtExit !== false,
    entryMarketWeatherIsUnknown: parsed.key === UNKNOWN_MARKET_WEATHER_KEY
  };
}

function attachEntryMarketWeather(row = {}, marketContext = {}) {
  if (row.entryMarketWeatherKey && row.entryMarketWeatherImmutable !== false) {
    return {
      ...row,
      ...marketWeatherFieldsFromRow(row),
      marketWeatherFeatureFlags: marketWeatherFeatureFlags()
    };
  }

  const snapshot = marketContext?.entryMarketWeatherKey
    ? {
        entryMarketWeatherKey: marketContext.entryMarketWeatherKey,
        entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
        entryMarketWeatherRegime: marketContext.entryMarketWeatherRegime || 'UNKNOWN',
        entryMarketWeatherTrendSide: marketContext.entryMarketWeatherTrendSide || 'UNKNOWN',
        entryMarketWeatherCapturedAt: now(),
        entryMarketWeatherRaw: marketContext.entryMarketWeatherRaw || marketContext.source || null,
        entryMarketWeatherRawAvailableFields: marketContext.entryMarketWeatherRawAvailableFields || [],
        entryMarketWeatherSourceReadFrom: marketContext.sourceReadFrom || null,
        entryMarketWeatherSourceKey: marketContext.sourceKey || null,
        entryMarketWeatherAgeSec: marketContext.ageSec ?? null,
        entryMarketWeatherStale: Boolean(marketContext.stale),
        entryMarketWeatherImmutable: true,
        entryMarketWeatherNeverRecomputedAtExit: true,
        entryMarketWeatherIsUnknown: isUnknownMarketWeatherKey(marketContext.entryMarketWeatherKey)
      }
    : buildEntryMarketWeatherSnapshot({
        ...row,
        entryMarketWeatherRegime: first(row.entryMarketWeatherRegime, row.currentRegime, row.regime),
        entryMarketWeatherTrendSide: first(row.entryMarketWeatherTrendSide, row.currentTrendSide, row.trendSide)
      }, now());

  return {
    ...row,
    ...snapshot,
    entryMarketWeather: snapshot.entryMarketWeatherRaw || marketContext.source || null,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };
}

function regimeFromRow(row = {}, marketContext = {}) {
  const parsed = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      row.microMicroFamilyId ||
      ''
  );

  if (parsed.regimeBucket && REGIME_SET.has(parsed.regimeBucket)) return parsed.regimeBucket;

  const direct = normalizeMarketRegime(
    row.regimeBucket ||
      row.currentRegime ||
      row.regime ||
      row.btcRegime ||
      marketContext.regime
  );

  return direct !== 'UNKNOWN' ? direct : 'TREND';
}

function confirmationFromRow(row = {}, marketContext = {}) {
  const parsed = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      row.microMicroFamilyId ||
      ''
  );

  if (parsed.confirmationProfile && CONFIRMATION_SET.has(parsed.confirmationProfile)) {
    return parsed.confirmationProfile;
  }

  const text = upper([
    row.confirmationProfile,
    row.scannerReason,
    row.reason,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ].filter(Boolean).join('|'));

  const fitScore = n(row.currentFitScore ?? row.entryCurrentFitScore, 0);
  const fitConfidence = n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);
  const scannerScore = n(row.scannerScore ?? row.moveScore, 0);
  const volumeExpansion = n(row.volumeExpansion, 0);

  if (
    text.includes('E_WEAK_CONTRA') ||
    text.includes('WEAK_CONTRA') ||
    text.includes('FAKE_RISK') ||
    row.fakeBreakoutRisk === true ||
    row.weakContra === true ||
    row.contraSignal === true ||
    fitScore < -20
  ) {
    return 'E_WEAK_CONTRA';
  }

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

function rowText(row = {}) {
  return upper([
    row.confirmationProfile,
    row.scannerReason,
    row.reason,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    row.flow,
    row.flowCoarse,
    row.obRelation,
    row.btcRelation,
    row.btcState,
    row.currentFit,
    row.entryCurrentFit,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ].filter(Boolean).join('|'));
}

function getRowConfluence(row = {}) {
  return n(first(row.confluence, row.sniperScore, row.scannerScore, row.moveScore), 0);
}

function getRowRR(row = {}) {
  return n(first(row.rr, row.primaryRr, row.riskReward, row.rewardRisk), 0);
}

function getRowSpreadPct(row = {}) {
  const direct = n(row.spreadPct, NaN);
  if (Number.isFinite(direct)) return direct;

  const bps = n(row.spreadBps, NaN);
  if (Number.isFinite(bps)) return bps / 10000;

  return NaN;
}

function getRowDepthUsd1p(row = {}) {
  return n(first(
    row.depthMinUsd1p,
    row.minDepthUsd1p,
    row.depthUsd1p,
    row.depthUsd,
    row.orderbookDepthUsd,
    row.liquidityDepthUsd
  ), NaN);
}

function getRowCostR(row = {}) {
  return n(first(row.estimatedCostR, row.costR, row.avgCostR), NaN);
}

function weakContraGateConfig() {
  const options = ACTIVE_RUN_OPTIONS || {};

  return {
    enabled: bool(first(
      options.weakContraGateEnabled,
      CONFIG.short?.weakContra?.enabled,
      CONFIG.short?.trade?.weakContraGateEnabled,
      CONFIG.analyze?.weakContra?.enabled,
      CONFIG.trade?.weakContraGateEnabled
    ), true),

    minConfluence: n(first(
      options.weakContraMinConfluence,
      CONFIG.short?.weakContra?.minConfluence,
      CONFIG.short?.trade?.weakContraMinConfluence,
      CONFIG.analyze?.weakContra?.minConfluence,
      CONFIG.trade?.weakContraMinConfluence
    ), 72),

    minRR: n(first(
      options.weakContraMinRR,
      CONFIG.short?.weakContra?.minRR,
      CONFIG.short?.trade?.weakContraMinRR,
      CONFIG.analyze?.weakContra?.minRR,
      CONFIG.trade?.weakContraMinRR
    ), 1.15),

    maxSpreadPct: n(first(
      options.weakContraMaxSpreadPct,
      CONFIG.short?.weakContra?.maxSpreadPct,
      CONFIG.short?.trade?.weakContraMaxSpreadPct,
      CONFIG.analyze?.weakContra?.maxSpreadPct,
      CONFIG.trade?.weakContraMaxSpreadPct
    ), 0.0015),

    minDepthUsd1p: n(first(
      options.weakContraMinDepthUsd1p,
      CONFIG.short?.weakContra?.minDepthUsd1p,
      CONFIG.short?.trade?.weakContraMinDepthUsd1p,
      CONFIG.analyze?.weakContra?.minDepthUsd1p,
      CONFIG.trade?.weakContraMinDepthUsd1p
    ), 100000),

    maxCostR: n(first(
      options.weakContraMaxCostR,
      CONFIG.short?.weakContra?.maxCostR,
      CONFIG.short?.trade?.weakContraMaxCostR,
      CONFIG.analyze?.weakContra?.maxCostR,
      CONFIG.trade?.weakContraMaxCostR
    ), 0.35),

    requireStructure: bool(first(
      options.weakContraRequireStructure,
      CONFIG.short?.weakContra?.requireStructure,
      CONFIG.short?.trade?.weakContraRequireStructure,
      CONFIG.analyze?.weakContra?.requireStructure,
      CONFIG.trade?.weakContraRequireStructure
    ), true),

    requireFlowOrVolume: bool(first(
      options.weakContraRequireFlowOrVolume,
      CONFIG.short?.weakContra?.requireFlowOrVolume,
      CONFIG.short?.trade?.weakContraRequireFlowOrVolume,
      CONFIG.analyze?.weakContra?.requireFlowOrVolume,
      CONFIG.trade?.weakContraRequireFlowOrVolume
    ), true),

    requireDepthData: bool(first(
      options.weakContraRequireDepthData,
      CONFIG.short?.weakContra?.requireDepthData,
      CONFIG.short?.trade?.weakContraRequireDepthData,
      CONFIG.analyze?.weakContra?.requireDepthData,
      CONFIG.trade?.weakContraRequireDepthData
    ), false),

    rejectFakeBreakout: bool(first(
      options.weakContraRejectFakeBreakout,
      CONFIG.short?.weakContra?.rejectFakeBreakout,
      CONFIG.short?.trade?.weakContraRejectFakeBreakout,
      CONFIG.analyze?.weakContra?.rejectFakeBreakout,
      CONFIG.trade?.weakContraRejectFakeBreakout
    ), true)
  };
}

function detectStructureSignal(row = {}) {
  const text = rowText(row);

  return Boolean(
    row.retestConfirmed ||
    row.pullbackConfirmed ||
    row.sweepConfirmed ||
    row.breakoutConfirmed ||
    row.continuationConfirmed ||
    row.compressionConfirmed ||
    row.setupConfirmed ||
    row.structureAlign ||
    row.structureAligned ||
    text.includes('RETEST') ||
    text.includes('PULLBACK') ||
    text.includes('SWEEP') ||
    text.includes('STOP_RUN') ||
    text.includes('BREAKOUT') ||
    text.includes('BREAKDOWN') ||
    text.includes('CONTINUATION') ||
    text.includes('COMPRESSION') ||
    text.includes('SQUEEZE')
  );
}

function detectFlowSignal(row = {}, marketContext = {}) {
  const text = rowText(row);
  const obRelation = upper(row.obRelation);
  const btcRelation = upper(row.btcRelation);
  const currentTrendSide = normalizeMarketTrendSide(row.currentTrendSide || row.entryCurrentTrendSide || marketContext.trendSide);

  return Boolean(
    row.flowAlign ||
    row.flowAligned ||
    row.momentumAlign ||
    row.askFlowAlign ||
    row.bearFlow ||
    row.sellFlow ||
    currentTrendSide === TARGET_TRADE_SIDE ||
    obRelation === 'WITH' ||
    obRelation === 'ASK_HEAVY' ||
    btcRelation === 'BTC_WITH' ||
    text.includes('FLOW_ALIGN') ||
    text.includes('BEAR_FLOW') ||
    text.includes('SELL_FLOW') ||
    text.includes('ASK_FLOW') ||
    text.includes('TREND')
  );
}

function detectVolumeSignal(row = {}) {
  const text = rowText(row);
  const relVol = n(first(row.relativeVolume, row.relVolume, row.volumeExpansion, row.volumeScore, row.volumeStrength), NaN);

  return Boolean(
    row.volumeSpike ||
    row.volumeConfirmed ||
    row.volumeAlign ||
    row.volumeAligned ||
    row.volumeSpikeConfirmed ||
    row.quoteVolumeSpike ||
    row.obVolumeAlign ||
    text.includes('VOLUME_ALIGN') ||
    text.includes('VOL_ALIGN') ||
    text.includes('VOLUME_SPIKE') ||
    text.includes('VOL_EXP') ||
    (Number.isFinite(relVol) && relVol >= 1.4)
  );
}

function weakContraApplies(row = {}, marketContext = {}) {
  const confirmation = confirmationFromRow(row, marketContext);
  const text = rowText(row);
  const obRelation = upper(row.obRelation);
  const btcRelation = upper(row.btcRelation);
  const currentTrendSide = normalizeMarketTrendSide(row.currentTrendSide || row.entryCurrentTrendSide || marketContext.trendSide);

  return Boolean(
    confirmation === 'E_WEAK_CONTRA' ||
    row.weakContra === true ||
    row.contraSignal === true ||
    row.bullishDivergence === true ||
    row.avoidShort === true ||
    row.doNotShort === true ||
    row.fakeBreakout === true ||
    row.fakeBreakoutRisk === true ||
    currentTrendSide === OPPOSITE_TRADE_SIDE ||
    obRelation === 'AGAINST' ||
    btcRelation === 'BTC_AGAINST' ||
    text.includes('E_WEAK_CONTRA') ||
    text.includes('WEAK_CONTRA') ||
    text.includes('CONTRA')
  );
}

function buildWeakContraEntryGate(row = {}, marketContext = {}) {
  const cfg = weakContraGateConfig();
  const confirmationProfile = confirmationFromRow(row, marketContext);
  const applies = weakContraApplies(row, marketContext);
  const structureAligned = detectStructureSignal(row);
  const flowAligned = detectFlowSignal(row, marketContext);
  const volumeAligned = detectVolumeSignal(row);

  const confluence = getRowConfluence(row);
  const rr = getRowRR(row);
  const spreadPct = getRowSpreadPct(row);
  const depthUsd1p = getRowDepthUsd1p(row);
  const costR = getRowCostR(row);

  const failures = [];

  if (!cfg.enabled || !applies) {
    return {
      version: WEAK_CONTRA_ENTRY_GATE_VERSION,
      enabled: Boolean(cfg.enabled),
      applies: Boolean(applies),
      passed: true,
      allowed: true,
      rejected: false,
      reason: !cfg.enabled ? 'E_WEAK_CONTRA_GATE_DISABLED' : 'NOT_E_WEAK_CONTRA',
      failures: [],

      confirmationProfile,
      structureAligned,
      flowAligned,
      volumeAligned,

      confluence,
      minConfluence: cfg.minConfluence,
      rr,
      minRR: cfg.minRR,
      spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
      maxSpreadPct: cfg.maxSpreadPct,
      depthUsd1p: Number.isFinite(depthUsd1p) ? depthUsd1p : null,
      minDepthUsd1p: cfg.minDepthUsd1p,
      costR: Number.isFinite(costR) ? costR : null,
      maxCostR: cfg.maxCostR
    };
  }

  if (confluence < cfg.minConfluence) failures.push('E_WEAK_CONTRA_CONFLUENCE_BELOW_MIN');
  if (rr < cfg.minRR) failures.push('E_WEAK_CONTRA_RR_BELOW_MIN');

  if (!Number.isFinite(spreadPct)) {
    failures.push('E_WEAK_CONTRA_SPREAD_UNKNOWN');
  } else if (spreadPct > cfg.maxSpreadPct) {
    failures.push('E_WEAK_CONTRA_SPREAD_TOO_WIDE');
  }

  if (cfg.requireDepthData && !Number.isFinite(depthUsd1p)) {
    failures.push('E_WEAK_CONTRA_DEPTH_UNKNOWN');
  } else if (Number.isFinite(depthUsd1p) && depthUsd1p < cfg.minDepthUsd1p) {
    failures.push('E_WEAK_CONTRA_DEPTH_TOO_LOW');
  }

  if (Number.isFinite(costR) && costR > cfg.maxCostR) {
    failures.push('E_WEAK_CONTRA_COST_R_TOO_HIGH');
  }

  if (cfg.requireStructure && !structureAligned) {
    failures.push('E_WEAK_CONTRA_STRUCTURE_NOT_CONFIRMED');
  }

  if (cfg.requireFlowOrVolume && !flowAligned && !volumeAligned) {
    failures.push('E_WEAK_CONTRA_NO_FLOW_OR_VOLUME_CONFIRMATION');
  }

  if (cfg.rejectFakeBreakout && (row.fakeBreakout === true || row.fakeBreakoutRisk === true)) {
    failures.push('E_WEAK_CONTRA_FAKE_BREAKOUT_RISK');
  }

  const passed = failures.length === 0;

  return {
    version: WEAK_CONTRA_ENTRY_GATE_VERSION,
    enabled: Boolean(cfg.enabled),
    applies: true,
    passed,
    allowed: passed,
    rejected: !passed,
    reason: passed ? 'E_WEAK_CONTRA_GATE_PASSED' : failures[0],
    failures,

    confirmationProfile,
    structureAligned,
    flowAligned,
    volumeAligned,

    confluence,
    minConfluence: cfg.minConfluence,
    rr,
    minRR: cfg.minRR,
    spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
    maxSpreadPct: cfg.maxSpreadPct,
    depthUsd1p: Number.isFinite(depthUsd1p) ? depthUsd1p : null,
    minDepthUsd1p: cfg.minDepthUsd1p,
    costR: Number.isFinite(costR) ? costR : null,
    maxCostR: cfg.maxCostR,

    requireStructure: Boolean(cfg.requireStructure),
    requireFlowOrVolume: Boolean(cfg.requireFlowOrVolume),
    requireDepthData: Boolean(cfg.requireDepthData),
    rejectFakeBreakout: Boolean(cfg.rejectFakeBreakout)
  };
}

function normalizeExactTrueMicroRow(row = {}, marketContext = {}) {
  const childTrueMicroFamilyId = fallbackExact75Id(row, marketContext);
  const parsed = parseShortTaxonomyMicroId(childTrueMicroFamilyId);

  if (!parsed.isChild) {
    return {
      ...row,
      exact75ChildTrueMicro: false,
      microFamilyId: null,
      trueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      base75ChildTrueMicroFamilyId: null,
      learningFamilyId: null,
      learningMicroFamilyId: null,
      analyzeMicroFamilyId: null,
      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,
      parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
      exactTrueMicroMissingReason: 'EXACT_75_CHILD_TRUE_MICRO_REQUIRED'
    };
  }

  const existingMicroMicroFamilyId = getMicroMicroFamilyId(row);
  const existingMicroMicroHash = microMicroHashFromId(existingMicroMicroFamilyId);

  const baseRow = {
    ...row,
    ...sideFlags(),
    microFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,
    baseTrueMicroFamilyId: childTrueMicroFamilyId,
    trueMicro75FamilyId: childTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    setupType: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
    confirmationProfile: parsed.confirmationProfile
  };

  const weakContraEntryGate = buildWeakContraEntryGate(baseRow, marketContext);

  const executionHash = existingMicroMicroHash || executionHashFromRow(
    {
      ...baseRow,
      weakContraEntryGate,
      weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null
    },
    childTrueMicroFamilyId
  );

  const microMicroFamilyId = existingMicroMicroFamilyId ||
    buildMicroMicroFamilyIdFromExecution(childTrueMicroFamilyId, executionHash);

  const identity = learningIdentityFields({
    ...baseRow,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash: executionHash
  });

  return {
    ...baseRow,
    ...identity,

    weakContraEntryGate,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraEntryAllowed: weakContraEntryGate.allowed,
    weakContraRejected: weakContraEntryGate.rejected,
    weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null,
    blockVirtualEntry: weakContraEntryGate.rejected,
    virtualObservationAllowed: true,
    tradeCandidateAllowed: !weakContraEntryGate.rejected,

    exact75ChildTrueMicro: true,
    exactMicroMicro: Boolean(microMicroFamilyId),
    fallbackExact75: !getTrueMicroFamilyId(row),
    fixedTaxonomyLearningId: true,

    executionFingerprintHash: executionHash || row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : buildExecutionFingerprintParts({
          ...baseRow,
          weakContraEntryGate,
          weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null
        }, childTrueMicroFamilyId),
    executionMicroFamilyId: executionHash
      ? `${childTrueMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`
      : row.executionMicroFamilyId || null,
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    learningIdentitySource: microMicroFamilyId
      ? 'ANALYZE_MICRO_MICRO_FAMILY'
      : 'ANALYZE_TRUE_MICRO_FAMILY_CONTEXT_ONLY',
    entryMarketWeatherKeyExcludedFromFamilyId: true,
    ...microPolicyFlags()
  };
}

function tradeConfig() {
  const options = ACTIVE_RUN_OPTIONS || {};

  const minRiskPct = n(first(
    options.minRiskPct,
    CONFIG.short?.trade?.minRiskPct,
    CONFIG.trade?.shortMinRiskPct,
    CONFIG.trade?.minRiskPct
  ), DEFAULT_MIN_RISK_PCT);

  const maxRiskPct = n(first(
    options.maxRiskPct,
    CONFIG.short?.trade?.maxRiskPct,
    CONFIG.trade?.shortMaxRiskPct,
    CONFIG.trade?.maxRiskPct
  ), DEFAULT_MAX_RISK_PCT);

  const monitorTimeoutMs = minRuntimeFloor(
    first(options.monitorTimeoutMs, CONFIG.short?.trade?.monitorTimeoutMs, CONFIG.trade?.monitorTimeoutMs),
    DEFAULT_MONITOR_TIMEOUT_MS,
    DEFAULT_MONITOR_TIMEOUT_MS,
    1000,
    15000
  );

  const monitorBatchSize = Math.max(
    DEFAULT_MONITOR_BATCH_SIZE,
    int(first(options.monitorBatchSize, CONFIG.short?.trade?.monitorBatchSize, CONFIG.trade?.monitorBatchSize), DEFAULT_MONITOR_BATCH_SIZE, 5, 250)
  );

  const openPositionMonitorLimit = Math.max(
    DEFAULT_OPEN_POSITION_MONITOR_LIMIT,
    int(first(options.openPositionMonitorLimit, CONFIG.short?.trade?.openPositionMonitorLimit, CONFIG.trade?.openPositionMonitorLimit), DEFAULT_OPEN_POSITION_MONITOR_LIMIT, 10, 500)
  );

  return {
    maxCandidatesPerSnapshot: int(
      first(options.maxCandidatesPerSnapshot, CONFIG.short?.trade?.maxCandidatesPerSnapshot, CONFIG.trade?.maxCandidatesPerSnapshot),
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT
    ),
    analyzeMaxCandidatesPerSnapshot: int(
      first(options.analyzeMaxCandidatesPerSnapshot, CONFIG.short?.trade?.analyzeMaxCandidatesPerSnapshot, CONFIG.trade?.analyzeMaxCandidatesPerSnapshot),
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT
    ),
    hardMaxCandidatesPerSnapshot: DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT,
    maxSnapshotAgeSec: n(first(options.maxSnapshotAgeSec, CONFIG.short?.trade?.maxSnapshotAgeSec, CONFIG.trade?.maxSnapshotAgeSec), DEFAULT_MAX_SNAPSHOT_AGE_SEC),
    dataConcurrency: int(first(options.dataConcurrency, CONFIG.short?.trade?.dataConcurrency, CONFIG.trade?.dataConcurrency), DEFAULT_DATA_CONCURRENCY, 1, 3),

    minRiskPct,
    maxRiskPct,
    fallbackRiskPct: n(first(options.fallbackRiskPct, CONFIG.short?.trade?.fallbackRiskPct, CONFIG.trade?.fallbackRiskPct), DEFAULT_FALLBACK_RISK_PCT),
    defaultRR: n(first(options.defaultRR, CONFIG.short?.trade?.defaultRR, CONFIG.trade?.defaultRR), DEFAULT_RR),
    minRR: n(first(options.minRR, CONFIG.short?.trade?.minRR, CONFIG.trade?.minRR), DEFAULT_MIN_RR),
    maxRR: n(first(options.maxRR, CONFIG.short?.trade?.maxRR, CONFIG.trade?.maxRR), DEFAULT_MAX_RR),
    minRewardPct: n(first(options.minRewardPct, CONFIG.short?.trade?.minRewardPct, CONFIG.trade?.minRewardPct), DEFAULT_MIN_REWARD_PCT),
    minDiscordRewardPct: n(first(options.minDiscordRewardPct, CONFIG.short?.trade?.minDiscordRewardPct, CONFIG.trade?.minDiscordRewardPct), DEFAULT_MIN_DISCORD_REWARD_PCT),
    maxRiskToRewardDistanceRatio: n(first(options.maxRiskToRewardDistanceRatio, CONFIG.short?.trade?.maxRiskToRewardDistanceRatio, CONFIG.trade?.maxRiskToRewardDistanceRatio), DEFAULT_MAX_RISK_TO_REWARD_DISTANCE_RATIO),

    maxEstimatedCostR: n(first(options.maxEstimatedCostR, CONFIG.short?.trade?.maxEstimatedCostR, CONFIG.trade?.shortMaxEstimatedCostR, CONFIG.trade?.maxEstimatedCostR), DEFAULT_MAX_ESTIMATED_COST_R),
    hardMaxEstimatedCostR: n(first(options.hardMaxEstimatedCostR, CONFIG.short?.trade?.hardMaxEstimatedCostR, CONFIG.trade?.hardMaxEstimatedCostR), DEFAULT_HARD_MAX_ESTIMATED_COST_R),
    roundTripFeePct: n(first(options.roundTripFeePct, CONFIG.short?.cost?.roundTripFeePct, CONFIG.cost?.roundTripFeePct), DEFAULT_ROUND_TRIP_FEE_PCT),
    roundTripSlippagePct: n(first(options.roundTripSlippagePct, CONFIG.short?.cost?.roundTripSlippagePct, CONFIG.cost?.roundTripSlippagePct), DEFAULT_ROUND_TRIP_SLIPPAGE_PCT),
    fallbackSpreadPct: n(first(options.fallbackSpreadPct, CONFIG.short?.cost?.fallbackSpreadPct, CONFIG.cost?.fallbackSpreadPct), DEFAULT_FALLBACK_SPREAD_PCT),
    spreadCostMult: n(first(options.spreadCostMult, CONFIG.short?.cost?.spreadCostMult, CONFIG.cost?.spreadCostMult), DEFAULT_SPREAD_COST_MULT),
    rrVariants: Array.isArray(options.rrVariants) && options.rrVariants.length
      ? options.rrVariants.map((x) => n(x, 0)).filter((x) => x > 0)
      : DEFAULT_RR_VARIANTS,

    candidateTimeoutMs: int(first(options.candidateTimeoutMs, CONFIG.short?.trade?.candidateTimeoutMs, CONFIG.trade?.candidateTimeoutMs), DEFAULT_CANDIDATE_TIMEOUT_MS, 300, 2500),
    analyzeTimeoutMs: int(first(options.analyzeTimeoutMs, CONFIG.short?.trade?.analyzeTimeoutMs, CONFIG.trade?.analyzeTimeoutMs), DEFAULT_ANALYZE_TIMEOUT_MS, 500, 4500),
    rotationTimeoutMs: int(first(options.rotationTimeoutMs, CONFIG.short?.trade?.rotationTimeoutMs, CONFIG.trade?.rotationTimeoutMs), DEFAULT_ROTATION_TIMEOUT_MS, 150, 1500),
    marketContextTimeoutMs: int(first(options.marketContextTimeoutMs, CONFIG.short?.trade?.marketContextTimeoutMs, CONFIG.trade?.marketContextTimeoutMs), DEFAULT_MARKET_CONTEXT_TIMEOUT_MS, 200, 1500),

    monitorTimeoutMs,
    monitorPriceFetchTimeoutMs: int(first(options.monitorPriceFetchTimeoutMs, CONFIG.short?.trade?.monitorPriceFetchTimeoutMs, CONFIG.trade?.monitorPriceFetchTimeoutMs), DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS, 100, 1200),
    monitorBatchSize,
    openPositionMonitorLimit,
    openPositionLoadTimeoutMs: int(first(options.openPositionLoadTimeoutMs, CONFIG.short?.trade?.openPositionLoadTimeoutMs, CONFIG.trade?.openPositionLoadTimeoutMs), DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS, 250, 4000),
    savePositionTimeoutMs: int(first(options.savePositionTimeoutMs, CONFIG.short?.trade?.savePositionTimeoutMs, CONFIG.trade?.savePositionTimeoutMs), DEFAULT_SAVE_POSITION_TIMEOUT_MS, 250, 2500),
    minEntryLoopAttempts: int(first(options.minEntryLoopAttempts, CONFIG.short?.trade?.minEntryLoopAttempts, CONFIG.trade?.minEntryLoopAttempts), DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS, 1, 8),
    entryLoopReserveMs: int(first(options.entryLoopReserveMs, CONFIG.short?.trade?.entryLoopReserveMs, CONFIG.trade?.entryLoopReserveMs), DEFAULT_ENTRY_LOOP_RESERVE_MS, 250, 2500),
    maxRuntimeMs: int(first(options.maxRuntimeMs, CONFIG.short?.trade?.maxRuntimeMs, CONFIG.trade?.maxRuntimeMs), DEFAULT_MAX_RUNTIME_MS, 8000, 30000),
    positionTimeStopMin: n(first(options.positionTimeStopMin, CONFIG.short?.trade?.positionTimeStopMin, CONFIG.trade?.positionTimeStopMin), 720),
    monitorLivePriceFetchEnabled: bool(first(options.monitorLivePriceFetchEnabled, CONFIG.short?.trade?.monitorLivePriceFetchEnabled, CONFIG.trade?.monitorLivePriceFetchEnabled), true),

    hardTimeStopNoPriceExit: bool(first(options.hardTimeStopNoPriceExit, CONFIG.short?.trade?.hardTimeStopNoPriceExit, CONFIG.trade?.hardTimeStopNoPriceExit), DEFAULT_HARD_TIME_STOP_NO_PRICE_EXIT),
    closeExpiredBeforePriceFetch: bool(first(options.closeExpiredBeforePriceFetch, CONFIG.short?.trade?.closeExpiredBeforePriceFetch, CONFIG.trade?.closeExpiredBeforePriceFetch), DEFAULT_CLOSE_EXPIRED_BEFORE_PRICE_FETCH),
    monitorCandleRangeEnabled: bool(first(options.monitorCandleRangeEnabled, CONFIG.short?.trade?.monitorCandleRangeEnabled, CONFIG.trade?.monitorCandleRangeEnabled), DEFAULT_MONITOR_CANDLE_RANGE_ENABLED)
  };
}

function sizingConfig() {
  const options = ACTIVE_RUN_OPTIONS || {};

  const enabled = bool(first(
    options.sizingEnabled,
    options.positionSizingEnabled,
    options.usePositionSizing,
    CONFIG.short?.sizing?.enabled,
    CONFIG.short?.trade?.sizingEnabled,
    CONFIG.sizing?.shortEnabled,
    CONFIG.sizing?.enabled,
    CONFIG.trade?.sizingEnabled
  ), true);

  const baseRiskPct = clamp(first(
    options.baseRiskPct,
    options.defaultRiskFraction,
    options.riskFraction,
    CONFIG.short?.sizing?.baseRiskPct,
    CONFIG.short?.sizing?.defaultRiskFraction,
    CONFIG.short?.trade?.baseRiskPct,
    CONFIG.sizing?.shortBaseRiskPct,
    CONFIG.sizing?.baseRiskPct,
    CONFIG.trade?.baseRiskPct
  ) ?? 0.0025, 0, 0.05);

  const minRiskPct = clamp(first(
    options.minPositionRiskPct,
    options.minRiskFraction,
    CONFIG.short?.sizing?.minRiskPct,
    CONFIG.short?.sizing?.minRiskFraction,
    CONFIG.sizing?.shortMinRiskPct,
    CONFIG.sizing?.minRiskPct
  ) ?? 0.0005, 0, 0.05);

  const maxRiskPct = clamp(first(
    options.maxPositionRiskPct,
    options.maxRiskFraction,
    CONFIG.short?.sizing?.maxRiskPct,
    CONFIG.short?.sizing?.maxRiskFraction,
    CONFIG.sizing?.shortMaxRiskPct,
    CONFIG.sizing?.maxRiskPct
  ) ?? 0.01, 0, 0.05);

  const fallbackRiskPct = clamp(first(
    options.sizingFallbackRiskPct,
    CONFIG.short?.sizing?.fallbackRiskPct,
    CONFIG.sizing?.shortFallbackRiskPct,
    CONFIG.sizing?.fallbackRiskPct
  ) ?? baseRiskPct, 0, 0.05);

  return {
    enabled,
    baseRiskPct,
    fallbackRiskPct,
    minRiskPct,
    maxRiskPct,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    source: 'LOCAL_TRADE_SYSTEM_SIZING_CONFIG'
  };
}

function aggregateRuntimeRecentOutcomes(row = {}) {
  const recent = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];

  return recent.reduce((acc, outcome) => {
    if (!outcome || typeof outcome !== 'object') return acc;

    const source = upper(outcome.source || outcome.outcomeSource || 'VIRTUAL');
    if (!['VIRTUAL', 'SHADOW', 'PAPER', ''].includes(source)) return acc;

    const r = n(
      outcome.netR ??
        outcome.exitR ??
        outcome.realizedNetR ??
        outcome.realizedR ??
        outcome.r,
      0
    );

    const costR = Math.max(0, n(outcome.costR ?? outcome.avgCostR, 0));

    acc.completed += 1;
    acc.totalR += r;
    acc.totalCostR += costR;
    acc.sumR += r;
    acc.sumSquaredR += r * r;

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
    sumR: 0,
    sumSquaredR: 0,
    grossWinR: 0,
    grossLossR: 0,
    directSLCount: 0
  });
}

function runtimeCompletedSample(row = {}) {
  const recent = aggregateRuntimeRecentOutcomes(row);

  const virtualCompleted = n(row.virtualCompleted, 0);
  const shadowCompleted = n(row.shadowCompleted, 0);
  const virtualShadowCompleted = virtualCompleted + shadowCompleted;

  return Math.max(
    0,
    virtualShadowCompleted,
    n(row.completed, 0),
    n(row.outcomeSample, 0),
    n(row.closed, 0),
    recent.completed
  );
}

function runtimeObservationSample(row = {}) {
  return Math.max(
    0,
    n(row.observationSample, 0),
    n(row.seen, 0),
    n(row.observations, 0),
    runtimeCompletedSample(row)
  );
}

function runtimeTotalR(row = {}) {
  const completed = runtimeCompletedSample(row);
  const recent = aggregateRuntimeRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowTotal = n(row.virtualTotalR, 0) + n(row.shadowTotalR, 0);
  if (virtualShadowTotal !== 0) return virtualShadowTotal;

  if (recent.completed > 0) return recent.totalR;

  return n(
    row.shortNetTotalR ??
      row.netShortTotalR ??
      row.netTotalR ??
      row.totalNetR ??
      row.totalR,
    0
  );
}

function runtimeAvgR(row = {}) {
  const completed = runtimeCompletedSample(row);
  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR)) return n(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return n(row.netAvgR, 0);
  if (hasValue(row.avgR)) return n(row.avgR, 0);

  return runtimeTotalR(row) / completed;
}

function runtimeStdDevR(row = {}) {
  const explicit = n(
    row.stdDevR ??
      row.standardDeviationR ??
      row.rStdDev,
    NaN
  );

  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const recent = aggregateRuntimeRecentOutcomes(row);
  const completed = runtimeCompletedSample(row);

  if (recent.completed > 1) {
    const variance = Math.max(
      0,
      (recent.sumSquaredR - (recent.sumR * recent.sumR) / recent.completed) / (recent.completed - 1)
    );

    return Math.sqrt(variance);
  }

  return completed > 1 ? Math.abs(runtimeAvgR(row)) : 0;
}

function runtimeLcb95AvgR(row = {}) {
  const value = first(
    row.microMicroLcb95AvgR,
    row.microMicroLCB95AvgR,
    row.lcb95AvgR,
    row.lcb95NetAvgR,
    row.avgRLcb95,
    row.avgRLCB95,
    row.netAvgRLCB95,
    row.avgRLower95,
    row.avgRLowerBound95,
    row.avgRLowerConfidenceBound95,
    row.lowerConfidenceBoundAvgR,
    row.sampleAdjustedAvgRLowerBound,
    row.sampleLcb95AvgR,
    row.fairAvgRLowerBound
  );

  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;

  const completed = runtimeCompletedSample(row);
  if (completed <= 1) return 0;

  const avg = runtimeAvgR(row);
  const sd = runtimeStdDevR(row);

  return avg - 1.96 * (sd / Math.sqrt(completed));
}

function runtimeTotalCostR(row = {}) {
  const completed = runtimeCompletedSample(row);
  const recent = aggregateRuntimeRecentOutcomes(row);

  if (completed <= 0) return 0;

  const virtualShadowCost = Math.max(0, n(row.virtualTotalCostR, 0)) + Math.max(0, n(row.shadowTotalCostR, 0));
  if (virtualShadowCost > 0) return virtualShadowCost;

  if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;

  if (hasValue(row.totalCostR)) return Math.max(0, n(row.totalCostR, 0));
  if (hasValue(row.totalNetCostR)) return Math.max(0, n(row.totalNetCostR, 0));

  for (const key of ['avgCostR', 'costR', 'netCostR', 'estimatedCostR']) {
    if (hasValue(row[key]) && n(row[key], 0) > 0) {
      return Math.max(0, n(row[key], 0)) * completed;
    }
  }

  return 0;
}

function runtimeAvgCostR(row = {}) {
  const completed = runtimeCompletedSample(row);
  return completed > 0 ? runtimeTotalCostR(row) / completed : 0;
}

function runtimeDirectSLCount(row = {}) {
  const recent = aggregateRuntimeRecentOutcomes(row);

  return Math.max(
    0,
    n(row.virtualDirectSLCount, 0) + n(row.shadowDirectSLCount, 0),
    n(row.directSLCount, 0),
    recent.directSLCount
  );
}

function runtimeDirectSLPct(row = {}) {
  if (hasValue(row.directSLPct)) {
    const pctValue = n(row.directSLPct, 0);
    return pctValue > 1 ? clamp(pctValue / 100, 0, 1) : clamp(pctValue, 0, 1);
  }

  const completed = runtimeCompletedSample(row);
  return completed > 0 ? clamp(runtimeDirectSLCount(row) / completed, 0, 1) : 0;
}

function runtimeProfitFactor(row = {}) {
  const recent = aggregateRuntimeRecentOutcomes(row);

  const winR = Math.max(
    n(row.virtualWinR, 0) + n(row.shadowWinR, 0),
    n(row.virtualGrossWinR, 0) + n(row.shadowGrossWinR, 0),
    n(row.netWinR, 0),
    n(row.totalWinR, 0),
    n(row.grossWinR, 0),
    recent.grossWinR,
    0
  );

  const lossR = Math.max(
    Math.abs(n(row.virtualLossR, 0) + n(row.shadowLossR, 0)),
    Math.abs(n(row.virtualGrossLossR, 0) + n(row.shadowGrossLossR, 0)),
    Math.abs(n(row.netLossR, 0)),
    Math.abs(n(row.totalLossR, 0)),
    Math.abs(n(row.grossLossR, 0)),
    recent.grossLossR,
    0
  );

  if (winR > 0 || lossR > 0) {
    if (lossR <= 0) return 99;
    return winR / lossR;
  }

  const explicit = n(row.netProfitFactor ?? row.profitFactor ?? row.pf, NaN);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);

  return 0;
}

function runtimeCurrentFitLabel(row = {}) {
  const directLabel = upper(row.currentFit || row.currentFitLabel || row.entryCurrentFit || '');
  if (directLabel) {
    if (directLabel.includes('MISFIT')) return 'MISFIT';
    if (directLabel.includes('MATCH')) return directLabel.includes('WEAK') ? 'WEAK_MATCH' : 'MATCH';
    if (directLabel.includes('FIT')) return directLabel;
    if (directLabel.includes('OK')) return 'OK';
    if (directLabel.includes('NEUTRAL')) return 'NEUTRAL';
  }

  const score = n(row.currentFitScore ?? row.entryCurrentFitScore ?? row.fitScore, 0);
  if (score <= -20) return 'MISFIT';
  if (score >= 45) return 'MATCH';
  if (score >= 18) return 'WEAK_MATCH';
  return directLabel || 'UNKNOWN';
}

function policyBlockedGate(row = {}) {
  const microMicroId = getMicroMicroFamilyId(row);
  const parsed = parseShortTaxonomyMicroId(microMicroId);
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile || confirmationFromRow(row));
  const reasons = [];

  if (!microMicroId || !isSelectableMicroMicroId(microMicroId)) {
    reasons.push('EXACT_MICRO_MICRO_ID_REQUIRED');
  }

  const side = inferRowTradeSide(row);

  if (side === OPPOSITE_TRADE_SIDE) {
    reasons.push('INVALID_SIDE_LONG_DISABLED');
  } else if (side !== TARGET_TRADE_SIDE && side !== 'UNKNOWN') {
    reasons.push('INVALID_SIDE_NON_SHORT');
  }

  if (
    hasValue(row.entry) ||
    hasValue(row.sl) ||
    hasValue(row.tp)
  ) {
    const entry = n(row.entry, 0);
    const sl = n(row.sl ?? row.initialSl, 0);
    const tp = n(row.tp, 0);

    if (!(entry > 0 && sl > 0 && tp > 0 && tp < entry && entry < sl)) {
      reasons.push('INVALID_SHORT_GEOMETRY_TP_LT_ENTRY_LT_SL_REQUIRED');
    }
  }

  if (isScannerFingerprintId(row.microFamilyId || row.trueMicroFamilyId || row.learningFamilyId || row.id)) {
    reasons.push('KNOWN_FORBIDDEN_FAMILY_SCANNER_FINGERPRINT');
  }

  if (isExecutionFingerprintId(row.learningMicroFamilyId || row.microFamilyId || row.id)) {
    reasons.push('KNOWN_FORBIDDEN_FAMILY_EXECUTION_FINGERPRINT');
  }

  if (
    BLOCK_E_WEAK_CONTRA_FOR_POLICY_GATE &&
    confirmationProfile === 'E_WEAK_CONTRA'
  ) {
    reasons.push('E_WEAK_CONTRA_POLICY_BLOCK');
  }

  if (row.policyBlocked === true && row.policyBlockedReason) {
    reasons.push(row.policyBlockedReason);
  }

  return {
    version: 'SHORT_POLICY_BLOCK_GATE_V3_SYSTEM_RULES_ONLY',
    blocked: reasons.length > 0,
    policyBlocked: reasons.length > 0,
    reasons,
    reason: reasons[0] || null,
    systemRules: [
      'E_WEAK_CONTRA',
      'INVALID_SIDE',
      'INVALID_GEOMETRY',
      'NON_SHORT',
      'KNOWN_FORBIDDEN_FAMILY'
    ],
    currentFitPolicyBlockDisabled: true
  };
}

function exactMicroMicroEmpiricalVeto(row = {}) {
  const microMicroId = getMicroMicroFamilyId(row);
  const lcb95AvgR = runtimeLcb95AvgR(row);
  const completed = runtimeCompletedSample(row);
  const exactMicroMicro =
    Boolean(microMicroId) &&
    isSelectableMicroMicroId(microMicroId) &&
    inferRowTradeSide(row) !== OPPOSITE_TRADE_SIDE;

  const explicitReason = upper(row.empiricalVetoReason);
  const explicitVeto =
    row.empiricalVeto === true &&
    (!explicitReason || explicitReason === 'EXACT_MICRO_MICRO_LCB95_NEGATIVE');

  const triggered =
    exactMicroMicro &&
    completed >= MIN_EMPIRICAL_VETO_COMPLETED &&
    Number.isFinite(Number(lcb95AvgR)) &&
    Number(lcb95AvgR) < 0;

  return {
    version: EMPIRICAL_VETO_VERSION,
    triggered: triggered || explicitVeto,
    empiricalVeto: triggered || explicitVeto,
    empiricalVetoReason: triggered || explicitVeto ? 'EXACT_MICRO_MICRO_LCB95_NEGATIVE' : null,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoBlocksParentFallbackRescue: true,
    shrinkageCannotOverrideVeto: true,
    id: microMicroId || null,
    microMicroFamilyId: microMicroId || null,
    completed,
    minCompleted: MIN_EMPIRICAL_VETO_COMPLETED,
    lcb95AvgR,
    threshold: 0
  };
}

function proofTierFromRuntimeStatus(status, marketResolution = null) {
  if (status === MICRO_MICRO_STATUS_POLICY_BLOCKED) return PROOF_TIER_POLICY_BLOCKED;
  if (status === MICRO_MICRO_STATUS_EMPIRICAL_VETO) return PROOF_TIER_EMPIRICAL_VETO;
  if (status === MICRO_MICRO_STATUS_OBSERVING) return PROOF_TIER_OBSERVATION_ONLY;
  if (status === MICRO_MICRO_STATUS_REJECTED) return PROOF_TIER_OBSERVATION_ONLY;
  if (status === MICRO_MICRO_STATUS_PASSED) {
    return marketResolution && marketResolution !== 'lifetime'
      ? PROOF_TIER_MICRO_MICRO_MARKET_PROOF
      : PROOF_TIER_MICRO_MICRO_LIFETIME_PROOF;
  }

  return PROOF_TIER_OBSERVATION_ONLY;
}

function maxAllowedRiskBandFromProof(proofTier) {
  if (proofTier === PROOF_TIER_MICRO_MICRO_MARKET_PROOF) return MAX_ALLOWED_RISK_BAND_HIGH;
  if (proofTier === PROOF_TIER_MICRO_MICRO_LIFETIME_PROOF) return MAX_ALLOWED_RISK_BAND_LOW;
  return MAX_ALLOWED_RISK_BAND_ZERO;
}

function microMicroRuntimeGate(row = {}) {
  const microMicroId = getMicroMicroFamilyId(row);
  const completed = runtimeCompletedSample(row);
  const observed = runtimeObservationSample(row);
  const avg = runtimeAvgR(row);
  const lcb95AvgR = runtimeLcb95AvgR(row);
  const total = runtimeTotalR(row);
  const pf = runtimeProfitFactor(row);
  const cost = runtimeAvgCostR(row);
  const dsl = runtimeDirectSLPct(row);
  const fit = runtimeCurrentFitLabel(row);

  const policyGate = policyBlockedGate(row);
  const empiricalVetoGate = exactMicroMicroEmpiricalVeto(row);
  const edgeReasons = [];

  if (!(lcb95AvgR > MIN_DISCORD_ACTIVATION_LCB95_AVG_R)) {
    edgeReasons.push('LCB95_AVG_R_NOT_POSITIVE');
  }

  if (!(avg > MIN_DISCORD_ACTIVATION_AVG_R)) {
    edgeReasons.push('AVG_R_NET_NOT_POSITIVE');
  }

  if (!(total > MIN_DISCORD_ACTIVATION_TOTAL_R)) {
    edgeReasons.push('TOTAL_R_NET_NOT_POSITIVE');
  }

  if (!(pf > MIN_DISCORD_ACTIVATION_PROFIT_FACTOR)) {
    edgeReasons.push('PROFIT_FACTOR_NOT_ABOVE_1');
  }

  if (cost > MAX_DISCORD_ACTIVATION_AVG_COST_R) {
    edgeReasons.push('AVG_COST_R_TOO_HIGH');
  }

  if (dsl > MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT) {
    edgeReasons.push('DIRECT_SL_PCT_TOO_HIGH');
  }

  let status = MICRO_MICRO_STATUS_OBSERVING;
  let reasons = [];

  if (policyGate.blocked) {
    status = MICRO_MICRO_STATUS_POLICY_BLOCKED;
    reasons = policyGate.reasons;
  } else if (empiricalVetoGate.triggered) {
    status = MICRO_MICRO_STATUS_EMPIRICAL_VETO;
    reasons = [empiricalVetoGate.empiricalVetoReason];
  } else if (completed < MIN_DISCORD_ACTIVATION_COMPLETED) {
    status = MICRO_MICRO_STATUS_OBSERVING;
    reasons = [`COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`];
  } else if (edgeReasons.length > 0) {
    status = MICRO_MICRO_STATUS_REJECTED;
    reasons = edgeReasons;
  } else {
    status = MICRO_MICRO_STATUS_PASSED;
    reasons = ['MICRO_MICRO_RUNTIME_GATE_PASSED'];
  }

  const passed = status === MICRO_MICRO_STATUS_PASSED;
  const observing = status === MICRO_MICRO_STATUS_OBSERVING;
  const rejected = status === MICRO_MICRO_STATUS_REJECTED;
  const empiricalVeto = status === MICRO_MICRO_STATUS_EMPIRICAL_VETO;
  const policyBlocked = status === MICRO_MICRO_STATUS_POLICY_BLOCKED;

  const proofTier = proofTierFromRuntimeStatus(status, row.marketResolution || null);
  const maxAllowedRiskBand = maxAllowedRiskBandFromProof(proofTier);

  return {
    version: MICRO_MICRO_RUNTIME_GATE_VERSION,
    status,
    passed,
    observing,
    rejected,
    empiricalVeto,
    policyBlocked,

    eligible: passed,
    discordEligible: passed,
    discordActivationEligible: passed,
    discordRuntimeActivationGatePassed: passed,

    virtualLearningAllowed: observing || passed,
    virtualObservationAllowed: observing || passed,
    virtualEntryAllowed: observing || passed,
    blocksNewVirtualEntry: rejected || empiricalVeto || policyBlocked,
    blocksLiveRiskEntry: rejected || empiricalVeto || policyBlocked,
    blocksDiscordTradeReady: !passed,

    reason: passed ? 'MICRO_MICRO_RUNTIME_GATE_PASSED' : reasons[0],
    reasons,
    policyReasons: policyGate.reasons,
    edgeReasons,

    id: microMicroId || null,
    microMicroFamilyId: microMicroId || null,
    learningFamilyId: microMicroId || null,
    completed: round(completed, 4),
    observed: round(observed, 4),
    avgR: round(avg, 4),
    lcb95AvgR: round(lcb95AvgR, 6),
    avgRLCB95: round(lcb95AvgR, 6),
    totalR: round(total, 4),
    profitFactor: round(pf, 4),
    avgCostR: round(cost, 4),
    directSLPct: round(dsl, 4),
    currentFit: fit,
    confirmationProfile: row.confirmationProfile || parseShortTaxonomyMicroId(microMicroId).confirmationProfile || null,
    statusRank: MICRO_MICRO_STATUS_RANK[status] ?? 99,

    policyGate,
    empiricalVetoGate,
    empiricalVetoReason: empiricalVeto ? empiricalVetoGate.empiricalVetoReason : null,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

    proofTier,
    maxAllowedRiskBand,
    thresholds: {
      minCompleted: MIN_DISCORD_ACTIVATION_COMPLETED,
      minLcb95AvgR: MIN_DISCORD_ACTIVATION_LCB95_AVG_R,
      minAvgR: MIN_DISCORD_ACTIVATION_AVG_R,
      minTotalR: MIN_DISCORD_ACTIVATION_TOTAL_R,
      minProfitFactor: MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
      maxAvgCostR: MAX_DISCORD_ACTIVATION_AVG_COST_R,
      maxDirectSLPct: MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,
      empiricalVetoMinCompleted: MIN_EMPIRICAL_VETO_COMPLETED
    }
  };
}

function runtimeDiscordActivationGate(row = {}) {
  const gate = microMicroRuntimeGate(row);

  return {
    ...gate,
    version: DISCORD_ACTIVATION_GATE_VERSION,
    runtimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    eligible: gate.status === MICRO_MICRO_STATUS_PASSED,
    blocked: gate.status !== MICRO_MICRO_STATUS_PASSED,
    reason: gate.status === MICRO_MICRO_STATUS_PASSED
      ? 'DISCORD_RUNTIME_NET_EDGE_GATE_PASSED'
      : gate.reason,
    discordEligible: gate.status === MICRO_MICRO_STATUS_PASSED,
    discordActivationEligible: gate.status === MICRO_MICRO_STATUS_PASSED,
    discordRuntimeActivationGatePassed: gate.status === MICRO_MICRO_STATUS_PASSED
  };
}

function compareBestMicroMicroRows(a = {}, b = {}) {
  const gateA = a?.microMicroRuntimeGate || microMicroRuntimeGate(a);
  const gateB = b?.microMicroRuntimeGate || microMicroRuntimeGate(b);
  const statusRankA = MICRO_MICRO_STATUS_RANK[gateA.status] ?? 99;
  const statusRankB = MICRO_MICRO_STATUS_RANK[gateB.status] ?? 99;
  if (statusRankA !== statusRankB) return statusRankA - statusRankB;

  const lcbDiff = n(gateB.lcb95AvgR, 0) - n(gateA.lcb95AvgR, 0);
  if (lcbDiff !== 0) return lcbDiff;

  const avgDiff = n(gateB.avgR, 0) - n(gateA.avgR, 0);
  if (avgDiff !== 0) return avgDiff;

  const totalDiff = n(gateB.totalR, 0) - n(gateA.totalR, 0);
  if (totalDiff !== 0) return totalDiff;

  const pfDiff = n(gateB.profitFactor, 0) - n(gateA.profitFactor, 0);
  if (pfDiff !== 0) return pfDiff;

  const completedDiff = n(gateB.completed, 0) - n(gateA.completed, 0);
  if (completedDiff !== 0) return completedDiff;

  const observedDiff = n(gateB.observed, 0) - n(gateA.observed, 0);
  if (observedDiff !== 0) return observedDiff;

  return String(gateA.microMicroFamilyId || '').localeCompare(String(gateB.microMicroFamilyId || ''));
}

function validateVirtualEntry(row = {}) {
  const tradeSide = inferRowTradeSide(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(row);
  const microMicroFamilyId = getMicroMicroFamilyId(row);

  if (tradeSide === OPPOSITE_TRADE_SIDE) {
    return { ok: false, reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM', tradeSide };
  }

  if (!trueMicroFamilyId || !isSelectableTrueMicroId(trueMicroFamilyId)) {
    return { ok: false, reason: 'ENTRY_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY' };
  }

  if (!microMicroFamilyId || !isSelectableMicroMicroId(microMicroFamilyId)) {
    return { ok: false, reason: 'ENTRY_REQUIRES_EXACT_MICRO_MICRO_FAMILY_ID' };
  }

  const runtimeGate = microMicroRuntimeGate(row);

  if (runtimeGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED) {
    return {
      ok: false,
      reason: runtimeGate.reason || 'MICRO_MICRO_POLICY_BLOCKED',
      microMicroRuntimeGate: runtimeGate,
      microMicroRuntimeGateStatus: runtimeGate.status,
      policyBlocked: true,
      virtualLearningAllowed: false,
      virtualEntryAllowed: false
    };
  }

  if (runtimeGate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO) {
    return {
      ok: false,
      reason: runtimeGate.reason || 'EXACT_MICRO_MICRO_EMPIRICAL_VETO',
      microMicroRuntimeGate: runtimeGate,
      microMicroRuntimeGateStatus: runtimeGate.status,
      empiricalVeto: true,
      empiricalVetoReason: runtimeGate.empiricalVetoReason || 'EXACT_MICRO_MICRO_LCB95_NEGATIVE',
      empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
      virtualLearningAllowed: false,
      virtualEntryAllowed: false
    };
  }

  if (runtimeGate.status === MICRO_MICRO_STATUS_REJECTED) {
    return {
      ok: false,
      reason: runtimeGate.reason || 'MICRO_MICRO_REJECTED_BAD_NET_EDGE',
      microMicroRuntimeGate: runtimeGate,
      microMicroRuntimeGateStatus: runtimeGate.status,
      virtualLearningAllowed: false,
      virtualEntryAllowed: false
    };
  }

  if (row.weakContraRejected === true || row.blockVirtualEntry === true) {
    return {
      ok: false,
      reason: row.weakContraRejectReason || row.weakContraEntryGate?.reason || 'E_WEAK_CONTRA_ENTRY_GATE_REJECTED',
      weakContraEntryGate: row.weakContraEntryGate || null,
      weakContraEntryGateVersion: row.weakContraEntryGateVersion || WEAK_CONTRA_ENTRY_GATE_VERSION,
      microMicroRuntimeGate: runtimeGate,
      microMicroRuntimeGateStatus: runtimeGate.status
    };
  }

  if (!hasValidRiskShape(row)) {
    return {
      ok: false,
      reason: row.liveEntryBlockedReason || 'SHORT_RISK_INVALID',
      microMicroRuntimeGate: runtimeGate,
      microMicroRuntimeGateStatus: runtimeGate.status
    };
  }

  if (n(row.estimatedCostR, 0) > tradeConfig().hardMaxEstimatedCostR) {
    return {
      ok: false,
      reason: 'SHORT_ESTIMATED_COST_R_TOO_HIGH',
      estimatedCostR: n(row.estimatedCostR, 0),
      hardMaxEstimatedCostR: tradeConfig().hardMaxEstimatedCostR,
      microMicroRuntimeGate: runtimeGate,
      microMicroRuntimeGateStatus: runtimeGate.status
    };
  }

  return {
    ok: true,
    reason: runtimeGate.status === MICRO_MICRO_STATUS_OBSERVING
      ? 'SHORT_VIRTUAL_LEARNING_OBSERVING_MICRO_MICRO'
      : 'SHORT_VIRTUAL_LEARNING_PASSED_MICRO_MICRO',
    rr: n(row.rr, 0),
    riskPct: n(row.riskPct, 0),
    rewardPct: n(row.rewardPct, 0),
    estimatedCostR: n(row.estimatedCostR, 0),
    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    weakContraEntryGate: row.weakContraEntryGate || null,
    weakContraEntryGateVersion: row.weakContraEntryGateVersion || WEAK_CONTRA_ENTRY_GATE_VERSION,
    microMicroRuntimeGate: runtimeGate,
    microMicroRuntimeGateStatus: runtimeGate.status,
    virtualLearningAllowed: true,
    virtualEntryAllowed: true,
    discordEligible: runtimeGate.status === MICRO_MICRO_STATUS_PASSED,
    empiricalVeto: false,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    proofTier: runtimeGate.proofTier,
    maxAllowedRiskBand: runtimeGate.maxAllowedRiskBand
  };
}

function waitAction(candidate, reason, extra = {}) {
  return {
    ...candidate,
    action: 'WAIT',
    reason,
    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,
    discordActivationEligible: false,
    discordRuntimeActivationGatePassed: false,
    signalType: SIGNAL_TYPE_BLOCKED,
    riskFractionForEntry: 0,
    ...sideFlags(),
    ...virtualFlags(candidate),
    ...isolationFlags(),
    ...extra
  };
}

function currentFitMaxWeatherAgeSec() {
  return int(
    first(CONFIG.short?.trade?.currentFitMaxWeatherAgeSec, CONFIG.trade?.currentFitMaxWeatherAgeSec),
    15 * 60,
    30,
    24 * 3600
  );
}

async function readJsonFromAnyRedis(keys = [], fallback = null) {
  const volatileRedis = getVolatileRedis();
  const durableRedis = getDurableRedis();
  const keyList = uniqueStrings(keys).filter(Boolean);

  for (const key of keyList) {
    const value = await getJson(volatileRedis, key, null).catch(() => null);
    if (value) return { value, source: `VOLATILE:${key}`, key };
  }

  for (const key of keyList) {
    const value = await getJson(durableRedis, key, null).catch(() => null);
    if (value) return { value, source: `DURABLE:${key}`, key };
  }

  return { value: fallback, source: null, key: null };
}

async function loadMarketContext() {
  const [weather, universe] = await Promise.all([
    readJsonFromAnyRedis(MARKET_WEATHER_LATEST_KEYS, null),
    readJsonFromAnyRedis(MARKET_UNIVERSE_LATEST_KEYS, null)
  ]);

  const source = weather.value && typeof weather.value === 'object' ? weather.value : {};
  const universeSource = universe.value && typeof universe.value === 'object' ? universe.value : {};

  const confirmed = buildConfirmedWeatherSnapshot(source, universeSource, {
    sourceKey: weather.key,
    sourceReadFrom: weather.source
  });

  const createdAt = normalizeTimestampMs(first(
    confirmed.confirmedMarketWeatherAt,
    source.confirmedAt,
    source.completedAt,
    source.createdAt,
    source.updatedAt,
    universeSource.completedAt,
    universeSource.createdAt,
    universeSource.updatedAt
  ), 0);

  const ageSec = createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null;
  const stale = createdAt > 0 ? ageSec > currentFitMaxWeatherAgeSec() : true;

  const freshConfirmed = isFreshConfirmedMarketWeather({
    ...confirmed,
    createdAt,
    confirmedAt: first(source.confirmedAt, confirmed.confirmedAt, createdAt)
  }, {
    maxAgeMin: PLAYBOOK_MAX_AGE_MIN
  });

  const entryKey = confirmed.entryMarketWeatherKey || buildEntryMarketWeatherKey(
    confirmed.entryMarketWeatherRegime,
    confirmed.entryMarketWeatherTrendSide
  );

  const parsedEntry = parseMarketWeatherKey(entryKey);
  const parsedConfirmed = parseMarketWeatherKey(confirmed.confirmedMarketWeatherKey || entryKey);

  return {
    ok: Boolean(weather.value) && parsedConfirmed.key !== UNKNOWN_MARKET_WEATHER_KEY,
    source,
    universe: universeSource,
    sourceKey: weather.key,
    sourceReadFrom: weather.source,
    universeSourceKey: universe.key,
    universeReadFrom: universe.source,
    createdAt,
    ageSec,
    stale,
    freshConfirmed: freshConfirmed.fresh,
    freshConfirmedReason: freshConfirmed.reason || null,

    confirmedMarketWeatherKey: parsedConfirmed.key,
    confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherRegime: parsedConfirmed.regime,
    confirmedMarketWeatherTrendSide: parsedConfirmed.trendSide,
    confirmedAt: first(source.confirmedAt, confirmed.confirmedAt, createdAt, now()),

    entryMarketWeatherKey: parsedEntry.key,
    entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: parsedEntry.regime,
    entryMarketWeatherTrendSide: parsedEntry.trendSide,
    entryMarketWeatherRaw: confirmed.entryMarketWeatherRaw || null,
    entryMarketWeatherRawAvailableFields: confirmed.entryMarketWeatherRawAvailableFields || [],

    regime: normalizeMarketRegime(parsedConfirmed.regime),
    trendSide: normalizeMarketTrendSide(parsedConfirmed.trendSide),
    weatherTrendSide: parsedConfirmed.trendSide || 'UNKNOWN',
    bullishPct: first(source.bullishPct, source.market?.bullishPct, source.longPct, source.upPct, universeSource.bullishPct, universeSource.longPct, universeSource.upPct) ?? null,
    bearishPct: first(source.bearishPct, source.market?.bearishPct, source.shortPct, source.downPct, universeSource.bearishPct, universeSource.shortPct, universeSource.downPct) ?? null,
    squeezePct: first(source.squeezePct, source.market?.squeezePct, source.compressionPct, universeSource.squeezePct, universeSource.compressionPct) ?? null,
    confidence: clamp(first(source.confidence, source.market?.confidence, source.weatherConfidence, source.currentTrendConfidence, universeSource.confidence) ?? 0, 0, 100),
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };
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
    } else {
      score -= 15;
      reasons.push('FAMILY_REGIME_MISMATCH');
    }
  }

  const bearishPct = n(marketContext.bearishPct, NaN);
  const bullishPct = n(marketContext.bullishPct, NaN);

  if (Number.isFinite(bearishPct)) {
    if (bearishPct >= 70) score += 20;
    else if (bearishPct >= 60) score += 15;
    else if (bearishPct >= 50) score += 8;
    else if (bearishPct < 40) score -= 12;
  }

  if (Number.isFinite(bullishPct) && bullishPct >= 60) score -= 20;
  if (confirmation === 'A_STRONG_ALIGN') score += 8;
  if (confirmation === 'B_FLOW_ALIGN') score += 5;
  if (confirmation === 'C_VOLUME_ALIGN') score += 3;
  if (confirmation === 'E_WEAK_CONTRA') score -= 18;

  const finalScore = clamp(score, -100, 100);
  const confidence = clamp(n(marketContext.confidence, 50) + Math.min(20, Math.abs(finalScore) / 2), 0, 100);

  let currentFit = 'NEUTRAL';
  if (finalScore >= 45) currentFit = 'MATCH';
  else if (finalScore >= 18) currentFit = 'WEAK_MATCH';
  else if (finalScore <= -25) currentFit = 'MISFIT';

  return {
    currentFit,
    currentFitScore: round(finalScore, 4),
    currentFitConfidence: round(confidence, 2),
    currentFitReason: reasons.join('|') || 'NO_CURRENT_FIT_REASON',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
}

function attachCurrentFitContext(row = {}, marketContext = {}) {
  const fit = scoreMarketFit(row, marketContext);
  const withWeather = attachEntryMarketWeather(row, marketContext);

  return {
    ...withWeather,
    currentMarketWeather: marketContext?.source || null,
    currentMarketUniverse: marketContext?.universe || null,
    confirmedMarketWeatherKey: marketContext?.confirmedMarketWeatherKey || withWeather.entryMarketWeatherKey,
    confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherRegime: marketContext?.confirmedMarketWeatherRegime || withWeather.entryMarketWeatherRegime,
    confirmedMarketWeatherTrendSide: marketContext?.confirmedMarketWeatherTrendSide || withWeather.entryMarketWeatherTrendSide,
    currentMarketWeatherReadFrom: marketContext?.sourceReadFrom || null,
    currentMarketWeatherAgeSec: marketContext?.ageSec ?? null,
    currentMarketWeatherStale: Boolean(marketContext?.stale),
    currentRegime: marketContext?.regime || 'UNKNOWN',
    currentTrendSide: marketContext?.trendSide || 'UNKNOWN',
    currentMarketWeatherKey: marketContext?.confirmedMarketWeatherKey || withWeather.entryMarketWeatherKey,
    currentMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    currentBullishPct: marketContext?.bullishPct ?? null,
    currentBearishPct: marketContext?.bearishPct ?? null,
    currentSqueezePct: marketContext?.squeezePct ?? null,
    entryCurrentRegime: marketContext?.regime || 'UNKNOWN',
    entryCurrentTrendSide: marketContext?.weatherTrendSide || withWeather.entryMarketWeatherTrendSide || 'UNKNOWN',
    entryCurrentFit: fit.currentFit,
    entryCurrentFitConfidence: fit.currentFitConfidence,
    entryWeatherFitMatchedFamily: fit.currentFit === 'MATCH' || fit.currentFit === 'WEAK_MATCH',
    ...fit
  };
}

function discordCurrentFitGate(row = {}) {
  const fit = upper(row.currentFit || row.entryCurrentFit);
  const confidence = n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);

  if (!fit || fit === 'UNKNOWN') {
    return {
      ok: false,
      reason: 'DISCORD_BLOCKED_CURRENT_FIT_UNKNOWN',
      currentFit: fit || 'UNKNOWN',
      currentFitConfidence: confidence
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

function estimatedCostRForRiskPct(row = {}, riskPct = 0, cfg = tradeConfig()) {
  const spreadPct = n(row.spreadPct, cfg.fallbackSpreadPct);
  const totalCostPct =
    n(cfg.roundTripFeePct, DEFAULT_ROUND_TRIP_FEE_PCT) +
    n(cfg.roundTripSlippagePct, DEFAULT_ROUND_TRIP_SLIPPAGE_PCT) +
    Math.max(0, spreadPct) * n(cfg.spreadCostMult, DEFAULT_SPREAD_COST_MULT);

  if (riskPct <= 0) return 999;

  return round(totalCostPct / riskPct, 6);
}

function candidateFallbackPrice(row = {}, fallback = 0) {
  return n(
    row.price ??
      row.markPrice ??
      row.currentPrice ??
      row.lastPrice ??
      row.close ??
      row.entry,
    fallback
  );
}

function adaptiveShortRr(row = {}, cfg = tradeConfig()) {
  const setup = setupFromRow(row);
  const regime = regimeFromRow(row);
  const confirmation = confirmationFromRow(row);

  let rr = n(cfg.defaultRR, DEFAULT_RR);

  if (setup === 'BREAKOUT' && regime === 'TREND') rr = 1.75;
  else if (setup === 'CONTINUATION' && regime === 'TREND') rr = 1.75;
  else if (setup === 'RETEST' && regime === 'TREND') rr = 1.5;
  else if (setup === 'SWEEP_REVERSAL') rr = 1.25;
  else if (setup === 'COMPRESSION' && regime === 'SQUEEZE') rr = 1.5;
  else if (regime === 'CHOP') rr = 1.25;

  if (confirmation === 'A_STRONG_ALIGN') rr += 0.25;
  if (confirmation === 'E_WEAK_CONTRA') rr -= 0.25;

  return Number(clamp(rr, n(cfg.minRR, DEFAULT_MIN_RR), n(cfg.maxRR, DEFAULT_MAX_RR)).toFixed(2));
}

function adaptiveShortRiskPct(row = {}, cfg = tradeConfig()) {
  const setup = setupFromRow(row);
  const regime = regimeFromRow(row);
  const confirmation = confirmationFromRow(row);
  const spreadPct = n(row.spreadPct, cfg.fallbackSpreadPct);

  let riskPct = n(cfg.fallbackRiskPct, DEFAULT_FALLBACK_RISK_PCT);

  if (setup === 'BREAKOUT') riskPct += 0.0007;
  if (setup === 'SWEEP_REVERSAL') riskPct += 0.001;
  if (setup === 'COMPRESSION') riskPct += 0.0008;
  if (setup === 'RETEST') riskPct += 0.0004;
  if (regime === 'CHOP') riskPct += 0.0008;
  if (regime === 'SQUEEZE') riskPct += 0.0006;
  if (confirmation === 'E_WEAK_CONTRA') riskPct -= 0.0004;
  if (spreadPct > 0.0012) riskPct += 0.0007;

  let cleanRiskPct = clamp(riskPct, Math.max(0.0005, cfg.minRiskPct), Math.max(cfg.minRiskPct, cfg.maxRiskPct));

  while (
    cleanRiskPct < cfg.maxRiskPct &&
    estimatedCostRForRiskPct(row, cleanRiskPct, cfg) > cfg.maxEstimatedCostR
  ) {
    cleanRiskPct += 0.00025;
  }

  return Number(clamp(cleanRiskPct, Math.max(0.0005, cfg.minRiskPct), Math.max(cfg.minRiskPct, cfg.maxRiskPct)).toFixed(8));
}

function buildShortTpSlPlan({ entry, riskPct, rr, cfg = tradeConfig() } = {}) {
  const entryPrice = n(entry, 0);
  const cleanRR = clamp(rr, Math.max(n(cfg.minRR, DEFAULT_MIN_RR), DEFAULT_MIN_RR), n(cfg.maxRR, DEFAULT_MAX_RR));
  const cleanRiskPct = clamp(
    riskPct,
    Math.max(0.0005, n(cfg.minRiskPct, DEFAULT_MIN_RISK_PCT)),
    Math.max(n(cfg.minRiskPct, DEFAULT_MIN_RISK_PCT), n(cfg.maxRiskPct, DEFAULT_MAX_RISK_PCT))
  );

  const rewardPct = cleanRiskPct * cleanRR;
  const sl = entryPrice * (1 + cleanRiskPct);
  const tp = Math.max(entryPrice * (1 - rewardPct), entryPrice * 0.0001);
  const actualRiskPct = entryPrice > 0 ? (sl - entryPrice) / entryPrice : 0;
  const actualRewardPct = entryPrice > 0 ? (entryPrice - tp) / entryPrice : 0;
  const actualRR = actualRiskPct > 0 ? actualRewardPct / actualRiskPct : 0;

  return {
    entry: roundPrice(entryPrice),
    sl: roundPrice(sl),
    initialSl: roundPrice(sl),
    tp: roundPrice(tp),
    rr: round(actualRR, 4),
    riskPct: round(actualRiskPct, 8),
    rewardPct: round(actualRewardPct, 8),
    riskDistance: sl - entryPrice,
    rewardDistance: entryPrice - tp,
    riskToRewardDistanceRatio: actualRewardPct > 0 ? round(actualRiskPct / actualRewardPct, 6) : 999,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION
  };
}

function buildRrShadowPlans({ entry, riskPct, cfg = tradeConfig() } = {}) {
  return uniqueStrings(cfg.rrVariants || DEFAULT_RR_VARIANTS)
    .map((value) => n(value, 0))
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
    .map((rr) => {
      const plan = buildShortTpSlPlan({ entry, riskPct, rr, cfg });

      return {
        id: `RR_${String(rr).replace('.', '_')}`,
        rr,
        entry: plan.entry,
        sl: plan.sl,
        initialSl: plan.initialSl,
        tp: plan.tp,
        riskPct: plan.riskPct,
        rewardPct: plan.rewardPct,
        riskDistance: plan.riskDistance,
        rewardDistance: plan.rewardDistance,
        riskToRewardDistanceRatio: plan.riskToRewardDistanceRatio,
        version: RR_SHADOW_GRID_VERSION
      };
    });
}

function applyAdaptiveShortRisk(row = {}, reason = 'ADAPTIVE_SHORT_RR_TP_SL') {
  const cfg = tradeConfig();
  const entry = candidateFallbackPrice(row, 0);

  if (entry <= 0) {
    return {
      ...row,
      ...sideFlags(),
      ...virtualFlags(row),
      ...learningIdentityFields(row),
      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,
      riskPct: 0,
      rewardPct: 0,
      liveRiskValid: false,
      liveEntryBlockedReason: 'ADAPTIVE_SHORT_RISK_NO_PRICE'
    };
  }

  const rr = adaptiveShortRr(row, cfg);
  const riskPct = adaptiveShortRiskPct(row, cfg);
  const plan = buildShortTpSlPlan({ entry, riskPct, rr, cfg });
  const rrShadowPlans = buildRrShadowPlans({ entry, riskPct: plan.riskPct, cfg });
  const estimatedCostR = estimatedCostRForRiskPct(row, plan.riskPct, cfg);

  const riskQualityOk =
    plan.entry > 0 &&
    plan.tp > 0 &&
    plan.sl > 0 &&
    plan.tp < plan.entry &&
    plan.entry < plan.sl &&
    plan.rr >= cfg.minRR &&
    plan.rewardPct >= cfg.minRewardPct &&
    plan.riskToRewardDistanceRatio <= cfg.maxRiskToRewardDistanceRatio &&
    estimatedCostR <= cfg.hardMaxEstimatedCostR;

  return {
    ...row,
    ...sideFlags(),
    ...virtualFlags(row),
    ...learningIdentityFields(row),

    price: plan.entry,
    currentPrice: row.currentPrice ?? plan.entry,
    lastPrice: row.lastPrice ?? row.currentPrice ?? plan.entry,
    entry: plan.entry,
    entryPrice: plan.entry,
    sl: plan.sl,
    initialSl: plan.sl,
    stopLoss: plan.sl,
    stop: plan.sl,
    stopPrice: plan.sl,
    tp: plan.tp,
    takeProfit: plan.tp,
    target: plan.tp,
    targetPrice: plan.tp,
    rr: plan.rr,
    riskPct: plan.riskPct,
    rewardPct: plan.rewardPct,
    riskDistance: plan.riskDistance,
    rewardDistance: plan.rewardDistance,
    riskToRewardDistanceRatio: plan.riskToRewardDistanceRatio,

    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    rrShadowPlans,
    rrVariantPlans: rrShadowPlans,
    rrVariants: rrShadowPlans.map((item) => item.rr),
    primaryRr: plan.rr,

    estimatedCostR,
    maxEstimatedCostR: cfg.maxEstimatedCostR,
    hardMaxEstimatedCostR: cfg.hardMaxEstimatedCostR,
    costAwareRisk: true,
    adaptiveShortRisk: true,
    adaptiveShortRiskReason: reason,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    riskSource: row.riskSource || 'COST_AWARE_ADAPTIVE_STANDARDIZED_SHORT_TP_SL',

    rrQualityOk: plan.rr >= cfg.minRR,
    rewardQualityOk: plan.rewardPct >= cfg.minRewardPct,
    discordRewardQualityOk: plan.rewardPct >= cfg.minDiscordRewardPct,
    riskToRewardDistanceQualityOk: plan.riskToRewardDistanceRatio <= cfg.maxRiskToRewardDistanceRatio,
    costQualityOk: estimatedCostR <= cfg.maxEstimatedCostR,
    hardCostQualityOk: estimatedCostR <= cfg.hardMaxEstimatedCostR,

    liveRiskValid: riskQualityOk,
    liveEntryBlockedReason: riskQualityOk ? null : 'ADAPTIVE_SHORT_RISK_QUALITY_FAILED',
    validShortRiskShape: riskQualityOk,
    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
  };
}

function hasValidRiskShape(row = {}) {
  const entry = n(row.entry, 0);
  const sl = n(row.sl ?? row.initialSl, 0);
  const tp = n(row.tp, 0);
  const rr = n(row.rr, 0);

  if (row.learningOnly === true) return false;
  if (row.liveRiskValid === false) return false;
  if (inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;
  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  return tp < entry && entry < sl;
}

function standardizedRiskMetrics(candidate = {}, marketContext = {}) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  const mid = candidateFallbackPrice(normalized, 0);

  if (mid <= 0) {
    const exact = normalizeExactTrueMicroRow(normalized, marketContext);
    return {
      ...normalized,
      ...exact,
      ...scannerMetadataFrom(normalized, exact),
      ...sideFlags(),
      ...virtualFlags(normalized),
      ...attachEntryMarketWeather(normalized, marketContext),
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
      liveEntryBlockedReason: 'STANDARDIZED_SHORT_RISK_NO_PRICE'
    };
  }

  const exactRow = normalizeExactTrueMicroRow(normalized, marketContext);

  const baseRow = {
    ...normalized,
    ...exactRow,
    ...scannerMetadataFrom(normalized, exactRow),
    ...sideFlags(),
    ...virtualFlags(normalized),
    ...attachEntryMarketWeather(normalized, marketContext),
    price: mid,
    currentPrice: mid,
    lastPrice: mid,
    spreadPct: n(normalized.spreadPct, cfg.fallbackSpreadPct),
    depthMinUsd1p: n(normalized.depthMinUsd1p, 0),
    fundingRate: n(normalized.fundingRate, 0),
    confluence: n(normalized.scannerScore ?? normalized.moveScore, 0),
    sniperScore: n(normalized.scannerScore ?? normalized.moveScore, 0),
    scannerScore: n(normalized.scannerScore ?? normalized.moveScore, 0),
    moveScore: n(normalized.moveScore ?? normalized.scannerScore, 0),
    riskSource: 'COST_AWARE_ADAPTIVE_STANDARDIZED_SHORT_TP_SL',
    standardizedLearningRisk: true,
    standardizedLearningRiskReason: 'VERCEL_SAFE_COST_AWARE_RR_GRID_SHORT_LEARNING_TP_SL',
    observationOnly: false,
    analysisInputOnly: false,
    learningOnly: false,
    positionTimeStopMin: cfg.positionTimeStopMin,
    liveDataTs: now()
  };

  const row = applyAdaptiveShortRisk(baseRow, 'VERCEL_SAFE_COST_AWARE_RR_GRID_SHORT_LEARNING_TP_SL');
  const weakContraEntryGate = buildWeakContraEntryGate(row, marketContext);

  return {
    ...row,
    weakContraEntryGate,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraEntryAllowed: weakContraEntryGate.allowed,
    weakContraRejected: weakContraEntryGate.rejected,
    weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null,
    blockVirtualEntry: weakContraEntryGate.rejected,
    virtualObservationAllowed: true,
    tradeCandidateAllowed: !weakContraEntryGate.rejected,
    liveRiskValid: hasValidRiskShape(row) && row.liveRiskValid !== false
  };
}

async function safeProcessCandidate(candidate, marketContext = {}) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);

  try {
    const result = await withTimeout(
      Promise.resolve({
        actions: [],
        metrics: [
          standardizedRiskMetrics(normalized, marketContext)
        ]
      }),
      cfg.candidateTimeoutMs,
      'CANDIDATE_PROCESS_TIMEOUT'
    );

    if (!isTimeoutResult(result)) return result;

    return {
      actions: [],
      metrics: [
        standardizedRiskMetrics({
          ...normalized,
          timedOut: true
        }, marketContext)
      ],
      timedOut: true
    };
  } catch (error) {
    return {
      actions: [
        waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
          error: error?.message || String(error)
        })
      ],
      metrics: [
        standardizedRiskMetrics({
          ...normalized,
          candidateProcessError: error?.message || String(error)
        }, marketContext)
      ]
    };
  }
}

function playbookFreshness(row = {}, currentMarketWeatherKey = UNKNOWN_MARKET_WEATHER_KEY) {
  const selectedKey =
    row.currentMarketWeatherKey ||
    row.confirmedMarketWeatherKey ||
    row.entryMarketWeatherKey ||
    row.playbookMarketWeatherKey ||
    row.marketWeatherKey ||
    null;

  const selectedParsed = parseMarketWeatherKey(selectedKey);
  const currentParsed = parseMarketWeatherKey(currentMarketWeatherKey);

  const createdAt = normalizeTimestampMs(
    row.playbookCreatedAt ||
      row.playbookUpdatedAt ||
      row.rotationCreatedAt ||
      row.createdAt ||
      row.updatedAt ||
      row.selectedAt,
    0
  );

  const ageMin = createdAt > 0 ? (now() - createdAt) / 60000 : null;

  const keyMatches =
    selectedParsed.key !== UNKNOWN_MARKET_WEATHER_KEY &&
    currentParsed.key !== UNKNOWN_MARKET_WEATHER_KEY &&
    selectedParsed.key === currentParsed.key;

  const fresh = Boolean(
    keyMatches &&
      createdAt > 0 &&
      ageMin <= PLAYBOOK_MAX_AGE_MIN
  );

  return {
    version: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,
    fresh,
    maxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    ageMin: ageMin === null ? null : round(ageMin, 2),
    selectedKey: selectedParsed.key,
    currentMarketWeatherKey: currentParsed.key,
    keyMatches,
    reason: fresh
      ? 'PLAYBOOK_FRESH_FOR_CONFIRMED_WEATHER'
      : !keyMatches
        ? 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER'
        : createdAt <= 0
          ? 'PLAYBOOK_MISSING_TIMESTAMP'
          : 'PLAYBOOK_STALE_FOR_CONFIRMED_WEATHER'
  };
}

function selectedRowMarketResolution(row = {}, currentMarketWeatherKey = UNKNOWN_MARKET_WEATHER_KEY) {
  const currentParsed = parseMarketWeatherKey(currentMarketWeatherKey);
  const rowParsed = parseMarketWeatherKey(row.entryMarketWeatherKey || row.currentMarketWeatherKey || row.playbookMarketWeatherKey || '');
  const rowRegime = normalizeMarketWeatherRegime(row.entryMarketWeatherRegime || row.currentMarketWeatherRegime || row.marketWeatherRegime || rowParsed.regime || '');
  const currentRegime = currentParsed.regime;

  if (
    rowParsed.key !== UNKNOWN_MARKET_WEATHER_KEY &&
    currentParsed.key !== UNKNOWN_MARKET_WEATHER_KEY &&
    rowParsed.key === currentParsed.key
  ) {
    return 'regimeTrend';
  }

  if (
    rowRegime &&
    currentRegime &&
    rowRegime !== 'UNKNOWN' &&
    currentRegime !== 'UNKNOWN' &&
    rowRegime === currentRegime
  ) {
    return 'regime';
  }

  return 'lifetime';
}

function safeRiskFractionForEntry(input = {}, sizing = sizingConfig()) {
  const policyBlocked = input.policyBlocked === true || input.microMicroPolicyBlocked === true;
  const empiricalVeto = input.empiricalVeto === true || input.microMicroEmpiricalVeto === true;
  const proofTier = input.proofTier || PROOF_TIER_OBSERVATION_ONLY;
  const shrunkLCB95AvgR = n(input.shrunkLCB95AvgR ?? input.lcb95AvgR, 0);

  if (
    policyBlocked ||
    empiricalVeto ||
    proofTier === PROOF_TIER_POLICY_BLOCKED ||
    proofTier === PROOF_TIER_EMPIRICAL_VETO ||
    proofTier === PROOF_TIER_OBSERVATION_ONLY
  ) {
    return 0;
  }

  if (!(shrunkLCB95AvgR > 0)) {
    return 0;
  }

  if (!sizing.enabled) return 0;

  try {
    const value = riskFractionForEntry({
      ...input,
      positionSizingProofInputVersion: POSITION_SIZING_PROOF_INPUT_VERSION,
      empiricalVeto,
      policyBlocked,
      riskSourceOfTruth: 'riskFractionForEntry'
    });

    const clean = n(value, 0);
    return clean > 0 ? clamp(clean, sizing.minRiskPct, sizing.maxRiskPct) : 0;
  } catch {
    return 0;
  }
}

function deriveSignalAfterRisk({
  runtimeStatusGate,
  currentMarketWeatherKey,
  playbookFresh,
  playbookReason,
  selectedAlertMatch,
  currentFitGate,
  riskFraction,
  shrunkLCB95AvgR,
  fdrPass = true
} = {}) {
  const reasons = [];

  if (!runtimeStatusGate || runtimeStatusGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED) {
    return { signalType: SIGNAL_TYPE_BLOCKED, reason: 'POLICY_BLOCKED', reasons: ['POLICY_BLOCKED'] };
  }

  if (runtimeStatusGate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO) {
    return { signalType: SIGNAL_TYPE_BLOCKED, reason: 'EMPIRICAL_VETO', reasons: ['EMPIRICAL_VETO'] };
  }

  if (runtimeStatusGate.status === MICRO_MICRO_STATUS_REJECTED) {
    return { signalType: SIGNAL_TYPE_BLOCKED, reason: runtimeStatusGate.reason || 'REJECTED_BAD_EDGE', reasons: runtimeStatusGate.reasons || [] };
  }

  if (isUnknownMarketWeatherKey(currentMarketWeatherKey)) {
    return { signalType: SIGNAL_TYPE_OBSERVE_ONLY, reason: 'MARKET_WEATHER_UNKNOWN', reasons: ['MARKET_WEATHER_UNKNOWN'] };
  }

  if (runtimeStatusGate.status === MICRO_MICRO_STATUS_OBSERVING) {
    return { signalType: SIGNAL_TYPE_OBSERVE_ONLY, reason: runtimeStatusGate.reason || 'OBSERVING', reasons: runtimeStatusGate.reasons || [] };
  }

  if (!selectedAlertMatch?.ok) reasons.push(selectedAlertMatch?.reason || 'NOT_SELECTED_FOR_CURRENT_PLAYBOOK');
  if (!currentFitGate?.ok) reasons.push(currentFitGate?.reason || 'CURRENT_FIT_NOT_OK');
  if (!playbookFresh) reasons.push(playbookReason || 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER');
  if (!(shrunkLCB95AvgR > 0)) reasons.push('SHRUNK_LCB95_NOT_POSITIVE_FOR_CONFIRMED_WEATHER');
  if (!(riskFraction > 0)) reasons.push('RISK_FRACTION_ZERO');
  if (!fdrPass) reasons.push('FDR_NOT_PASSED');

  if (reasons.length === 0) {
    return {
      signalType: SIGNAL_TYPE_TRADE_READY,
      reason: 'TRADE_READY_WEATHER_PLAYBOOK_CONFIRMED',
      reasons: ['TRADE_READY_WEATHER_PLAYBOOK_CONFIRMED']
    };
  }

  return {
    signalType: SIGNAL_TYPE_WATCH_ONLY,
    reason: reasons[0],
    reasons
  };
}

function extractRotationRows(activeRotation = {}) {
  return [
    ...(Array.isArray(activeRotation?.microFamilies) ? activeRotation.microFamilies : []),
    ...(Array.isArray(activeRotation?.rows) ? activeRotation.rows : []),
    ...(Array.isArray(activeRotation?.activeRows) ? activeRotation.activeRows : []),
    ...(Array.isArray(activeRotation?.selectedRows) ? activeRotation.selectedRows : []),
    ...(Array.isArray(activeRotation?.candidates) ? activeRotation.candidates : [])
  ];
}

function buildSelectedAlertContext(activeRotation, marketContext = {}) {
  const rawRows = extractRotationRows(activeRotation);
  const currentMarketWeatherKey = marketContext?.confirmedMarketWeatherKey || marketContext?.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY;
  const allRowsByLearningId = new Map();

  for (const row of rawRows) {
    const microMicroId = getMicroMicroFamilyId(row);
    if (!microMicroId || !isSelectableMicroMicroId(microMicroId)) continue;

    const normalized = normalizeExactTrueMicroRow({
      ...row,
      id: microMicroId,
      key: microMicroId,
      microFamilyId: microMicroId,
      trueMicroFamilyId: microMicroId,
      microMicroFamilyId: microMicroId,
      trueMicroMicroFamilyId: microMicroId,
      exactMicroMicroFamilyId: microMicroId
    }, marketContext);

    const marketResolution = selectedRowMarketResolution(row, currentMarketWeatherKey);
    const freshness = playbookFreshness(row, currentMarketWeatherKey);

    allRowsByLearningId.set(microMicroId, {
      ...row,
      ...normalized,
      ...attachEntryMarketWeather(row, marketContext),
      id: microMicroId,
      key: microMicroId,
      microFamilyId: microMicroId,
      trueMicroFamilyId: microMicroId,
      learningFamilyId: microMicroId,
      learningMicroFamilyId: microMicroId,
      analyzeMicroFamilyId: microMicroId,
      microMicroFamilyId: microMicroId,
      trueMicroMicroFamilyId: microMicroId,
      exactMicroMicroFamilyId: microMicroId,
      familyResolution: LAYER_MICRO_MICRO,
      marketResolution,
      proofSource: marketResolution === 'regimeTrend'
        ? 'MICRO_MICRO_REGIME_TREND'
        : marketResolution === 'regime'
          ? 'MICRO_MICRO_REGIME'
          : 'MICRO_MICRO_LIFETIME',
      playbookFreshness: freshness,
      playbookFresh: freshness.fresh
    });
  }

  const configuredMicroMicroFamilyIds = uniqueStrings([
    activeRotation?.microMicroFamilyIds || [],
    activeRotation?.activeMicroMicroFamilyIds || [],
    activeRotation?.trueMicroMicroFamilyIds || [],
    activeRotation?.activeTrueMicroMicroFamilyIds || [],
    activeRotation?.exactMicroMicroFamilyIds || [],
    activeRotation?.activeExactMicroMicroFamilyIds || [],
    activeRotation?.selectedMicroMicroFamilyIds || [],
    activeRotation?.selectedTrueMicroMicroFamilyIds || [],
    activeRotation?.selectedExactMicroMicroFamilyIds || [],
    activeRotation?.microFamilyIds || [],
    activeRotation?.activeMicroFamilyIds || [],
    activeRotation?.trueMicroFamilyIds || [],
    activeRotation?.ids || [],
    rawRows.map(getMicroMicroFamilyId)
  ])
    .map((id) => cleanLearningFamilyId(id, {}))
    .filter(isSelectableMicroMicroId);

  const eligibleMicroMicroFamilyIds = [];
  const rejectedSelectedMicroMicroRows = [];
  const rowByLearningId = new Map();
  const runtimeGateByLearningId = new Map();

  for (const id of configuredMicroMicroFamilyIds) {
    const statsRow = allRowsByLearningId.get(id) || {
      id,
      key: id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      microMicroFamilyId: id,
      trueMicroMicroFamilyId: id,
      exactMicroMicroFamilyId: id,
      manualOnly: true,
      noPersistentStats: true
    };

    const runtimeStatusGate = microMicroRuntimeGate(statsRow);
    const gate = runtimeDiscordActivationGate({
      ...statsRow,
      microMicroRuntimeGate: runtimeStatusGate
    });

    runtimeGateByLearningId.set(id, gate);

    if (runtimeStatusGate.status === MICRO_MICRO_STATUS_PASSED) {
      eligibleMicroMicroFamilyIds.push(id);
      rowByLearningId.set(id, {
        ...statsRow,
        microMicroRuntimeGate: runtimeStatusGate,
        microMicroRuntimeGateStatus: runtimeStatusGate.status,
        discordActivationEligible: true,
        discordRuntimeActivationGatePassed: true,
        discordRuntimeActivationGate: gate,
        discordActivationGate: gate
      });
    } else {
      rejectedSelectedMicroMicroRows.push({
        id,
        status: runtimeStatusGate.status,
        reason: runtimeStatusGate.reason,
        reasons: runtimeStatusGate.reasons,
        microMicroRuntimeGate: runtimeStatusGate,
        discordRuntimeActivationGate: gate,
        row: statsRow
      });
    }
  }

  const selectedMicroMicroFamilyIds = uniqueStrings(eligibleMicroMicroFamilyIds)
    .sort((a, b) => compareBestMicroMicroRows(
      rowByLearningId.get(a) || allRowsByLearningId.get(a) || { id: a },
      rowByLearningId.get(b) || allRowsByLearningId.get(b) || { id: b }
    ));

  return {
    rotationId: activeRotation?.rotationId || activeRotation?.id || null,
    selectedRotation: activeRotation || null,

    currentMarketWeatherKey,
    currentMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    selectorMode: 'OBSERVE',

    configuredMicroMicroFamilyIds,
    configuredSelectedMicroMicroFamilyIds: configuredMicroMicroFamilyIds,

    selectedMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    selectedMicroMicroSet: new Set(selectedMicroMicroFamilyIds),
    selectedParentTrueMicroFamilyIds: uniqueStrings(selectedMicroMicroFamilyIds.map(parentIdFromChild)),

    rejectedSelectedMicroMicroFamilyIds: rejectedSelectedMicroMicroRows.map((row) => row.id),
    rejectedSelectedMicroMicroRows,
    rejectedSelectedMicroMicroCount: rejectedSelectedMicroMicroRows.length,
    activeSelectionRuntimeFiltered: rejectedSelectedMicroMicroRows.length > 0,
    activeSelectionRuntimeFilteredReason: rejectedSelectedMicroMicroRows.length > 0
      ? 'ACTIVE_SELECTION_CONTAINED_MICRO_MICROS_BLOCKED_BY_RUNTIME_NET_EDGE_GATE'
      : null,

    rowByLearningId,
    allRowsByLearningId,
    runtimeGateByLearningId,

    empty: selectedMicroMicroFamilyIds.length === 0,
    emptyReason: selectedMicroMicroFamilyIds.length === 0
      ? configuredMicroMicroFamilyIds.length > 0
        ? 'NO_SELECTED_MICRO_MICRO_PASSED_RUNTIME_NET_EDGE_GATE'
        : 'NO_MANUAL_MICRO_MICRO_SELECTED'
      : null,

    selectionPurpose: 'DISCORD_ALERT_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordActivationRequiresWeatherPlaybook: true,
    discordActivationRequiresNetEdge: true,
    discordRuntimeGateRequired: true,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags()
  };
}

function selectedAlertMatchInfo(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) {
    return {
      ok: false,
      reason: alertContext?.emptyReason || 'NO_MANUAL_MICRO_MICRO_SELECTED',
      granularity: null,
      matchType: null,
      selectedId: null,
      discordRuntimeActivationGatePassed: false,
      discordRuntimeActivationGate: null,
      playbookFreshness: null
    };
  }

  const microMicroId = getMicroMicroFamilyId(row);
  const exactTrueMicroId = getTrueMicroFamilyId(row);

  if (
    microMicroId &&
    isSelectableMicroMicroId(microMicroId) &&
    alertContext.selectedMicroMicroSet.has(microMicroId)
  ) {
    const selectedRow = alertContext.rowByLearningId?.get(microMicroId) ||
      alertContext.allRowsByLearningId?.get(microMicroId) ||
      row;

    const gate = alertContext.runtimeGateByLearningId?.get(microMicroId) ||
      runtimeDiscordActivationGate(selectedRow);

    const freshness = selectedRow.playbookFreshness ||
      playbookFreshness(selectedRow, alertContext.currentMarketWeatherKey);

    if (!gate.eligible) {
      return {
        ok: false,
        reason: gate.reason || 'SELECTED_MICRO_MICRO_BLOCKED_BY_RUNTIME_NET_EDGE_GATE',
        granularity: LAYER_MICRO_MICRO,
        matchType: SELECTION_EXACT_MICRO_MICRO,
        selectedId: microMicroId,
        selectedMicroMicroFamilyId: microMicroId,
        selectedMicroFamilyId: exactTrueMicroId || childIdFromAnyLearningId(microMicroId),
        discordRuntimeActivationGatePassed: false,
        discordRuntimeActivationGate: gate,
        playbookFreshness: freshness
      };
    }

    return {
      ok: true,
      reason: 'SELECTED_SHORT_MICRO_MICRO_EXACT_MATCH_RUNTIME_NET_EDGE_CONFIRMED',
      granularity: LAYER_MICRO_MICRO,
      matchType: SELECTION_EXACT_MICRO_MICRO,
      selectedId: microMicroId,
      selectedMicroMicroFamilyId: microMicroId,
      selectedMicroFamilyId: exactTrueMicroId || childIdFromAnyLearningId(microMicroId),
      discordRuntimeActivationGatePassed: true,
      discordRuntimeActivationGate: gate,
      playbookFreshness: freshness
    };
  }

  return {
    ok: false,
    reason: microMicroId
      ? 'MICRO_MICRO_NOT_SELECTED_FOR_DISCORD_ALERT'
      : 'NO_MICRO_MICRO_ON_ROW_FOR_DISCORD_ALERT',
    granularity: null,
    matchType: null,
    selectedId: null,
    selectedMicroMicroFamilyId: microMicroId || null,
    selectedMicroFamilyId: exactTrueMicroId || null,
    discordRuntimeActivationGatePassed: false,
    discordRuntimeActivationGate: null,
    playbookFreshness: null
  };
}

function getSelectedWeeklyStats(alertContext, microMicroFamilyId) {
  if (!alertContext || !microMicroFamilyId) return null;
  return alertContext.rowByLearningId.get(microMicroFamilyId) ||
    alertContext.allRowsByLearningId.get(microMicroFamilyId) ||
    null;
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

function buildRiskAndSignalDecision({
  row,
  selectedWeeklyStats,
  selectedAlertMatch,
  runtimeStatusGate,
  currentFitGate,
  alertContext,
  sizing
} = {}) {
  const currentMarketWeatherKey = alertContext?.currentMarketWeatherKey || row.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY;
  const marketResolution = selectedRowMarketResolution(selectedWeeklyStats || row, currentMarketWeatherKey);
  const proofTier = proofTierFromRuntimeStatus(runtimeStatusGate.status, marketResolution);
  const maxAllowedRiskBand = maxAllowedRiskBandFromProof(proofTier);
  const shrunkAvgR = n(row.shrunkAvgR ?? selectedWeeklyStats?.shrunkAvgR ?? runtimeAvgR(selectedWeeklyStats || row), 0);
  const shrunkLCB95AvgR = n(row.shrunkLCB95AvgR ?? selectedWeeklyStats?.shrunkLCB95AvgR ?? runtimeLcb95AvgR(selectedWeeklyStats || row), 0);
  const freshness = selectedAlertMatch?.playbookFreshness ||
    playbookFreshness(selectedWeeklyStats || row, currentMarketWeatherKey);

  const riskFraction = safeRiskFractionForEntry({
    weeklyStats: selectedWeeklyStats || row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSizingProofInputVersion: POSITION_SIZING_PROOF_INPUT_VERSION,
    proofTier,
    maxAllowedRiskBand,
    shrunkAvgR,
    shrunkLCB95AvgR,
    empiricalVeto: runtimeStatusGate.empiricalVeto,
    empiricalVetoReason: runtimeStatusGate.empiricalVetoReason || null,
    policyBlocked: runtimeStatusGate.policyBlocked,
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKey: row.entryMarketWeatherKey || null,
    entryMarketWeatherRegime: row.entryMarketWeatherRegime || null,
    entryMarketWeatherTrendSide: row.entryMarketWeatherTrendSide || null,
    riskSourceOfTruth: 'riskFractionForEntry'
  }, sizing);

  const derivedSignal = deriveSignalAfterRisk({
    runtimeStatusGate,
    currentMarketWeatherKey,
    playbookFresh: freshness.fresh,
    playbookReason: freshness.reason,
    selectedAlertMatch,
    currentFitGate,
    riskFraction,
    shrunkLCB95AvgR,
    fdrPass: true
  });

  return {
    currentMarketWeatherKey,
    selectedFamilyId: getMicroMicroFamilyId(row) || null,
    familyResolution: LAYER_MICRO_MICRO,
    marketResolution,
    proofSource: marketResolution === 'regimeTrend'
      ? 'MICRO_MICRO_REGIME_TREND'
      : marketResolution === 'regime'
        ? 'MICRO_MICRO_REGIME'
        : 'MICRO_MICRO_LIFETIME',
    proofTier,
    signalType: derivedSignal.signalType,
    shrunkAvgR,
    shrunkLCB95AvgR,
    empiricalVeto: runtimeStatusGate.empiricalVeto,
    empiricalVetoReason: runtimeStatusGate.empiricalVetoReason || null,
    policyBlocked: runtimeStatusGate.policyBlocked,
    riskFractionForEntry: derivedSignal.signalType === SIGNAL_TYPE_TRADE_READY ? riskFraction : 0,
    rawRiskFractionForEntry: riskFraction,
    maxAllowedRiskBand,
    playbookFreshness: freshness,
    fdrPass: true,
    fdrMode: 'OBSERVE',
    sizingCapMode: 'OBSERVE',
    selectorMode: 'OBSERVE',
    reason: derivedSignal.reason,
    reasons: derivedSignal.reasons,
    riskSourceOfTruth: 'riskFractionForEntry',
    signalTypeDerivedAfterRisk: true,
    tradeReadyManualOverrideAllowed: false,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION
  };
}

function buildVirtualEntryAction({
  row,
  alertContext,
  selectedWeeklyStats,
  virtualGate,
  selectedAlertMatch,
  riskAndSignal,
  currentFitGate
}) {
  const normalized = normalizeExactTrueMicroRow(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(normalized);
  const microMicroFamilyId = getMicroMicroFamilyId(normalized);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);
  const runtimeStatusGate = virtualGate.microMicroRuntimeGate || microMicroRuntimeGate(selectedWeeklyStats || row);
  const runtimeGate = selectedAlertMatch?.discordRuntimeActivationGate ||
    runtimeDiscordActivationGate({
      ...(selectedWeeklyStats || row),
      microMicroRuntimeGate: runtimeStatusGate
    });

  const identity = learningIdentityFields({
    ...normalized,
    childTrueMicroFamilyId: trueMicroFamilyId,
    microMicroFamilyId
  });

  const finalDiscordAlertEligible = Boolean(
    riskAndSignal.signalType === SIGNAL_TYPE_TRADE_READY &&
      selectedAlertMatch?.ok &&
      currentFitGate.ok &&
      runtimeStatusGate.status === MICRO_MICRO_STATUS_PASSED &&
      runtimeGate.eligible === true &&
      selectedAlertMatch?.granularity === LAYER_MICRO_MICRO &&
      microMicroFamilyId &&
      selectedAlertMatch?.selectedMicroMicroFamilyId === microMicroFamilyId
  );

  const discordAlertReason = finalDiscordAlertEligible
    ? 'TRADE_READY_WEATHER_PLAYBOOK_CONFIRMED'
    : riskAndSignal.reason || 'NOT_TRADE_READY';

  return {
    ...normalized,
    ...scannerMetadataFrom(row, normalized),
    ...identity,
    ...sideFlags(),
    ...virtualFlags({ ...row, trueMicroFamilyId, microMicroFamilyId }),
    ...isolationFlags(),
    ...marketWeatherFieldsFromRow(row),

    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
    marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,
    positionSizingProofInputVersion: POSITION_SIZING_PROOF_INPUT_VERSION,

    ...riskAndSignal,

    action: 'VIRTUAL_ENTRY',
    reason: virtualGate.reason || 'SHORT_VIRTUAL_LEARNING_COST_AWARE_RR_GRID',
    shadowOnly: false,

    setupType: parsed.setupType,
    regimeBucket: parsed.regimeBucket,
    confirmationProfile: parsed.confirmationProfile,

    weakContraEntryGate: row.weakContraEntryGate || normalized.weakContraEntryGate || null,
    weakContraEntryGateVersion: row.weakContraEntryGateVersion || normalized.weakContraEntryGateVersion || WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraEntryAllowed: row.weakContraEntryAllowed ?? normalized.weakContraEntryAllowed ?? true,
    weakContraRejected: row.weakContraRejected ?? normalized.weakContraRejected ?? false,
    weakContraRejectReason: row.weakContraRejectReason || normalized.weakContraRejectReason || null,
    blockVirtualEntry: row.blockVirtualEntry ?? normalized.blockVirtualEntry ?? false,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,
    selectedMicroFamilyAlert: Boolean(finalDiscordAlertEligible),
    selectedExactMicroMatch: false,
    selectedExact75ChildMatch: false,
    selectedExactMicroMicroMatch: Boolean(finalDiscordAlertEligible),
    rotationMatchType: finalDiscordAlertEligible ? SELECTION_EXACT_MICRO_MICRO : null,
    matchType: finalDiscordAlertEligible ? SELECTION_EXACT_MICRO_MICRO : null,
    selectedLearningFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedLearningGranularity: finalDiscordAlertEligible ? SELECTION_EXACT_MICRO_MICRO : null,

    discordAlertEligible: Boolean(finalDiscordAlertEligible),
    discordActivationEligible: Boolean(finalDiscordAlertEligible),
    discordRuntimeActivationGatePassed: Boolean(finalDiscordAlertEligible),
    discordRuntimeActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationRequiresWeatherPlaybook: true,
    discordRuntimeActivationGate: runtimeGate,
    discordActivationGate: runtimeGate,
    discordCurrentFitGate: currentFitGate,
    discordAlertReason,

    selectedMicroFamilyId: finalDiscordAlertEligible ? trueMicroFamilyId : null,
    selectedTrueMicroFamilyId: finalDiscordAlertEligible ? trueMicroFamilyId : null,
    selectedChildTrueMicroFamilyId: finalDiscordAlertEligible ? trueMicroFamilyId : null,
    selectedMicroMicroFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedTrueMicroMicroFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedExactMicroMicroFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedMicroMicroFamilyIds: alertContext.selectedMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: alertContext.selectedTrueMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: alertContext.selectedExactMicroMicroFamilyIds,
    configuredSelectedMicroMicroFamilyIds: alertContext.configuredMicroMicroFamilyIds || [],
    rejectedSelectedMicroMicroFamilyIds: alertContext.rejectedSelectedMicroMicroFamilyIds || [],
    selectedWeeklyStats,
    weeklyStats: selectedWeeklyStats,

    riskFraction: riskAndSignal.riskFractionForEntry,
    virtualGate,
    liveEligible: Boolean(finalDiscordAlertEligible),

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    entryMarketWeather: row.entryMarketWeather || row.currentMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide || null,
    entryCurrentFit: row.entryCurrentFit || row.currentFit || null,
    entryCurrentFitConfidence: row.entryCurrentFitConfidence ?? row.currentFitConfidence ?? null,
    entryCreatedAt: now(),

    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,

    microMicroRuntimeGate: runtimeStatusGate,
    microMicroRuntimeGateStatus: runtimeStatusGate.status,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroStatus: runtimeStatusGate.status,
    microMicroObserving: runtimeStatusGate.status === MICRO_MICRO_STATUS_OBSERVING,
    microMicroPassed: runtimeStatusGate.status === MICRO_MICRO_STATUS_PASSED,
    microMicroRejected: runtimeStatusGate.status === MICRO_MICRO_STATUS_REJECTED,
    microMicroEmpiricalVeto: runtimeStatusGate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO,
    microMicroPolicyBlocked: runtimeStatusGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED,
    virtualLearningAllowedByMicroMicroGate: runtimeStatusGate.virtualLearningAllowed,
    virtualEntryAllowedByMicroMicroGate: runtimeStatusGate.virtualEntryAllowed
  };
}

function buildDiscordEntryAlertPayload(entry = {}) {
  const microId = upper(
    getTrueMicroFamilyId(entry) ||
      entry.trueMicroFamilyId ||
      entry.childTrueMicroFamilyId ||
      entry.microFamilyId ||
      entry.analyzeMicroFamilyId ||
      entry.learningMicroFamilyId
  );

  const microMicroId = upper(
    getMicroMicroFamilyId(entry) ||
      entry.microMicroFamilyId ||
      entry.trueMicroMicroFamilyId ||
      entry.exactMicroMicroFamilyId
  );

  const rotationId =
    entry.activeRotationId ||
    entry.rotationId ||
    entry.selectedRotationId ||
    `manual_${PERSISTENT_LEARNING_KEY}`;

  return {
    ...entry,
    ...marketWeatherFieldsFromRow(entry),
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
    signalType: SIGNAL_TYPE_TRADE_READY,
    empiricalVeto: false,

    action: 'ENTRY',
    source: 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    positionSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    paperTrade: true,
    paperPosition: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    liveOrder: false,
    orderPlaced: false,
    ...sideFlags(),
    ...isolationFlags(),

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

    microFamilyId: microId,
    trueMicroFamilyId: microId,
    childTrueMicroFamilyId: microId,
    base75ChildTrueMicroFamilyId: microId,

    learningFamilyId: microMicroId,
    learningMicroFamilyId: microMicroId,
    analyzeMicroFamilyId: microMicroId,

    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: microMicroHashFromId(microMicroId) || entry.microMicroHash || null,

    rotationId,
    activeRotationId: rotationId,
    selectedRotationId: rotationId,
    rotationMatchType: SELECTION_EXACT_MICRO_MICRO,
    matchType: SELECTION_EXACT_MICRO_MICRO,
    discordAlertEligible: true,
    discordActivationEligible: true,
    discordRuntimeActivationGatePassed: true,
    discordRuntimeActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationRequiresWeatherPlaybook: true,
    discordRuntimeActivationGate: entry.discordRuntimeActivationGate || null,
    discordActivationGate: entry.discordActivationGate || entry.discordRuntimeActivationGate || null,
    selectedForDiscord: true,
    liveEligible: true,

    selectedTrueMicroFamilyId: microId,
    selectedMicroFamilyId: microId,
    selectedChildTrueMicroFamilyId: microId,
    selectedMicroMicroFamilyId: microMicroId,
    selectedTrueMicroMicroFamilyId: microMicroId,
    selectedExactMicroMicroFamilyId: microMicroId,

    selectedTrueMicroFamilyIds: [microId],
    selectedMicroFamilyIds: [microId],
    selectedChildTrueMicroFamilyIds: [microId],
    trueMicroFamilyIds: [microId],
    childTrueMicroFamilyIds: [microId],
    microFamilyIds: [microId],

    selectedMicroMicroFamilyIds: [microMicroId],
    selectedTrueMicroMicroFamilyIds: [microMicroId],
    selectedExactMicroMicroFamilyIds: [microMicroId],
    activeMicroMicroFamilyIds: [microMicroId],
    activeTrueMicroMicroFamilyIds: [microMicroId],
    activeExactMicroMicroFamilyIds: [microMicroId],

    ...microPolicyFlags(),

    riskPlanVersion: entry.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: entry.rr,
    riskPct: entry.riskPct,
    rewardPct: entry.rewardPct,
    estimatedCostR: entry.estimatedCostR,
    riskToRewardDistanceRatio: entry.riskToRewardDistanceRatio,
    rrShadowGridEnabled: Boolean(entry.rrShadowGridEnabled),
    rrShadowGridVersion: entry.rrShadowGridVersion || RR_SHADOW_GRID_VERSION,
    rrShadowPlans: Array.isArray(entry.rrShadowPlans) ? entry.rrShadowPlans : [],
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
    discordPayloadSanitizedForEntryAlert: true
  };
}

async function maybeSendDiscordEntryAlert(entry = {}, cfg = tradeConfig()) {
  if (!entry.discordAlertEligible || entry.signalType !== SIGNAL_TYPE_TRADE_READY) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: entry.discordAlertReason || entry.reason || 'NOT_TRADE_READY'
    };
  }

  const microMicroId = getMicroMicroFamilyId(entry);

  if (!microMicroId || !isSelectableMicroMicroId(microMicroId)) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: 'DISCORD_REQUIRES_EXACT_MICRO_MICRO_ID'
    };
  }

  if (isUnknownMarketWeatherKey(entry.entryMarketWeatherKey)) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: 'DISCORD_BLOCKED_MARKET_WEATHER_UNKNOWN'
    };
  }

  if (entry.empiricalVeto === true || entry.policyBlocked === true) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: entry.empiricalVeto ? 'DISCORD_BLOCKED_EMPIRICAL_VETO' : 'DISCORD_BLOCKED_POLICY'
    };
  }

  const runtimeGate = entry.discordRuntimeActivationGate || entry.discordActivationGate || runtimeDiscordActivationGate(
    entry.selectedWeeklyStats ||
      entry.weeklyStats ||
      entry
  );

  if (runtimeGate.eligible !== true) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: runtimeGate.reason || 'DISCORD_RUNTIME_NET_EDGE_GATE_BLOCKED',
      discordRuntimeActivationGate: runtimeGate
    };
  }

  const result = await withTimeout(
    sendEntryAlert(buildDiscordEntryAlertPayload({
      ...entry,
      discordRuntimeActivationGate: runtimeGate,
      discordActivationGate: runtimeGate,
      discordRuntimeActivationGatePassed: true,
      discordActivationEligible: true
    })),
    Math.min(Math.max(cfg.savePositionTimeoutMs || DEFAULT_SAVE_POSITION_TIMEOUT_MS, 500), 2500),
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
  const microMicroFamilyId = getMicroMicroFamilyId(outcome);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(outcome);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

  return {
    action: 'VIRTUAL_EXIT',
    reason: outcome.exitReason || outcome.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    ...marketWeatherFieldsFromRow(outcome),

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    symbol: outcome.symbol || null,
    contractSymbol: outcome.contractSymbol || null,

    microFamilyId: trueMicroFamilyId || null,
    trueMicroFamilyId: trueMicroFamilyId || null,
    childTrueMicroFamilyId: trueMicroFamilyId || null,
    base75ChildTrueMicroFamilyId: trueMicroFamilyId || null,

    learningFamilyId: microMicroFamilyId || trueMicroFamilyId || null,
    learningMicroFamilyId: microMicroFamilyId || trueMicroFamilyId || null,
    analyzeMicroFamilyId: microMicroFamilyId || trueMicroFamilyId || null,

    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: microMicroHashFromId(microMicroFamilyId) || outcome.microMicroHash || null,

    parentTrueMicroFamilyId: parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: parentTrueMicroFamilyId || null,

    setupType: parsed.setupType || outcome.setupType || null,
    regimeBucket: parsed.regimeBucket || outcome.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || outcome.confirmationProfile || null,

    exact75ChildTrueMicro: Boolean(trueMicroFamilyId),
    exactMicroMicro: Boolean(microMicroFamilyId),

    ...microPolicyFlags(),

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

    hardTimeStop: Boolean(outcome.hardTimeStop),
    hardTimeStopCleanupVersion: outcome.hardTimeStopCleanupVersion || HARD_TIME_STOP_CLEANUP_VERSION,

    riskPlanVersion: outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    discordExitAlertSent: Boolean(outcome.discordExitAlertSent),

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    ...sideFlags(),
    ...virtualFlags(outcome),
    ...isolationFlags(),

    marketWeatherKeyVersion: outcome.entryMarketWeatherKeyVersion || SHORT_MARKET_WEATHER_KEY_VERSION,
    empiricalVetoVersion: outcome.empiricalVetoVersion || EMPIRICAL_VETO_VERSION,
    proofTier: outcome.proofTier || null,
    signalType: outcome.signalType || null,
    proofSource: outcome.proofSource || null,
    familyResolution: outcome.familyResolution || null,
    marketResolution: outcome.marketResolution || null,
    shrunkAvgR: outcome.shrunkAvgR ?? null,
    shrunkLCB95AvgR: outcome.shrunkLCB95AvgR ?? null
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
  analyzedMicroMicroRows,
  virtualCreatedRows,
  virtualExitRows,
  waitRows,
  skippedByExistingSymbol,
  weakContraRejectedRows,
  openPositionCountBeforeEntries,
  openPositionCountAfterEntries,
  monitorTimeout,
  activeRuntimeBlockedSelectionRows,
  discordRuntimeGateBlockedRows,
  marketWeatherUnknownRows,
  playbookMissingRows,
  tradeReadyRows,
  watchRows,
  observeRows
}) {
  if (candidates <= 0) return 'NO_SHORT_CANDIDATES';
  if (marketWeatherUnknownRows > 0 && tradeReadyRows <= 0) return 'MARKET_WEATHER_UNKNOWN_NO_TRADE_READY';
  if (playbookMissingRows > 0 && tradeReadyRows <= 0) return 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER';
  if (activeRuntimeBlockedSelectionRows > 0 && discordRuntimeGateBlockedRows > 0) return 'ACTIVE_DISCORD_SELECTION_BLOCKED_BY_RUNTIME_NET_EDGE_GATE';
  if (monitorTimeout && openPositionCountBeforeEntries > 0 && virtualExitRows <= 0) return 'MONITOR_TIMEOUT_OPEN_POSITIONS_NOT_FULLY_CLEANED';
  if (openPositionCountBeforeEntries >= 80 && virtualExitRows <= 0) return 'MANY_OPEN_POSITIONS_WAITING_FOR_TP_SL_OR_TIME_STOP';
  if (virtualExitRows > 0) return 'VIRTUAL_EXITS_RECORDED_LEARNING_UPDATED';
  if (processed <= 0) return 'NO_CANDIDATES_PROCESSED';
  if (liveRows <= 0) return 'NO_LIVE_ROWS_OR_NO_FALLBACK_PRICE';
  if (riskValidRows <= 0) return 'NO_COST_AWARE_TP_SL_AVAILABLE';
  if (analyzedRows <= 0) return 'ANALYZE_RETURNED_NO_SHORT_ROWS';
  if (analyzedRiskValidRows <= 0) return 'ANALYZE_DID_NOT_RETURN_RISK_VALID_ROWS';
  if (analyzedExact75Rows <= 0) return 'ANALYZE_DID_NOT_ASSIGN_EXACT_75_CHILD_TRUE_MICRO_FAMILY';
  if (analyzedMicroMicroRows <= 0) return 'ANALYZE_DID_NOT_ASSIGN_EXACT_MICRO_MICRO_FAMILY';
  if (virtualCreatedRows <= 0 && weakContraRejectedRows > 0) return 'E_WEAK_CONTRA_ENTRY_GATE_REJECTED';
  if (virtualCreatedRows <= 0 && skippedByExistingSymbol > 0) return 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION';
  if (virtualCreatedRows <= 0 && waitRows > 0) return 'VIRTUAL_ENTRY_GATE_WAIT_REASONS';
  if (tradeReadyRows > 0) return 'TRADE_READY_ROWS_FOUND_FOR_CONFIRMED_WEATHER';
  if (watchRows > 0) return 'BEST_WATCH_ONLY_FOR_CONFIRMED_WEATHER';
  if (observeRows > 0) return 'BEST_OBSERVE_ONLY_FOR_CONFIRMED_WEATHER';
  if (virtualCreatedRows > 0 && virtualExitRows <= 0 && openPositionCountAfterEntries > 0) return 'POSITIONS_OPEN_WAITING_FOR_TP_SL_OR_TIME_STOP';

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
  const monitorTimeout = runtimeWarnings.includes('MONITOR_OPEN_POSITIONS_TIMEOUT_CONTINUING_TO_ENTRY_LOOP');

  const primaryBottleneck = inferPrimaryBottleneck({
    candidates: candidateCount,
    processed: processedCount,
    liveRows: liveRowsCount,
    riskValidRows: counts.riskValidRows,
    analyzedRows: analyzedRowsCount,
    analyzedRiskValidRows: counts.analyzedRiskValidRows,
    analyzedExact75Rows: counts.analyzedExact75Rows,
    analyzedMicroMicroRows: counts.analyzedMicroMicroRows,
    virtualCreatedRows: counts.virtualCreatedRows,
    virtualExitRows,
    waitRows: counts.waitRows,
    skippedByExistingSymbol: counts.skippedByExistingSymbol,
    weakContraRejectedRows: counts.weakContraRejectedRows || 0,
    openPositionCountBeforeEntries,
    openPositionCountAfterEntries,
    monitorTimeout,
    activeRuntimeBlockedSelectionRows: counts.activeRuntimeBlockedSelectionRows || 0,
    discordRuntimeGateBlockedRows: counts.discordRuntimeGateBlockedRows || 0,
    marketWeatherUnknownRows: counts.marketWeatherUnknownRows || 0,
    playbookMissingRows: counts.playbookMissingRows || 0,
    tradeReadyRows: counts.tradeReadyRows || 0,
    watchRows: counts.watchRows || 0,
    observeRows: counts.observeRows || 0
  });

  return {
    profile: QUALITY_MEASUREMENT_PROFILE,
    tradeSystemVersion: TRADE_SYSTEM_VERSION,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroSchema: TRUE_MICRO_SCHEMA,
    childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroSchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroSchema: TRUE_MICRO_MICRO_SCHEMA,

    microMicroRequiredForVirtualEntry: true,
    entryMarketWeatherKeyExcludedFromFamilyId: true,
    unknownMarketWeatherNeverTradeReady: true,

    policyBlockedRules: [
      'E_WEAK_CONTRA',
      'INVALID_SIDE',
      'INVALID_GEOMETRY',
      'NON_SHORT',
      'KNOWN_FORBIDDEN_FAMILY'
    ],

    empiricalVetoRule: {
      status: MICRO_MICRO_STATUS_EMPIRICAL_VETO,
      criterion: 'exact micro-micro completed >= 35 && standalone lifetime LCB95(avgR) < 0',
      usesRawAvgR: false,
      usesLcb95: true,
      blocksDiscord: true,
      blocksVirtualEntry: true,
      blocksParentFallbackRescue: true
    },

    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
    marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    positionSizingProofInputVersion: POSITION_SIZING_PROOF_INPUT_VERSION,

    completedIsPureClosedVirtualOutcome: true,
    completedComesOnlyFrom: 'TP_SL_OR_TIME_STOP',
    scoringRSource: 'netR',

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    marketWeather: {
      available: Boolean(marketContext?.ok),
      confirmedMarketWeatherKey: marketContext?.confirmedMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY,
      keyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
      readFrom: marketContext?.sourceReadFrom || null,
      ageSec: marketContext?.ageSec ?? null,
      stale: Boolean(marketContext?.stale),
      freshConfirmed: Boolean(marketContext?.freshConfirmed),
      freshConfirmedReason: marketContext?.freshConfirmedReason || null,
      regime: marketContext?.confirmedMarketWeatherRegime || 'UNKNOWN',
      trendSide: marketContext?.confirmedMarketWeatherTrendSide || 'UNKNOWN',
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
      riskValidRows: counts.riskValidRows,
      analyzedRowsRaw: analyzedRowsRawCount,
      analyzedRows: analyzedRowsCount,
      analyzedRiskValidRows: counts.analyzedRiskValidRows,
      analyzedExact75Rows: counts.analyzedExact75Rows,
      analyzedMicroMicroRows: counts.analyzedMicroMicroRows,
      fallbackExact75Rows: counts.fallbackExact75Rows || 0,
      weakContraRejectedRows: counts.weakContraRejectedRows || 0,
      weakContraAllowedRows: counts.weakContraAllowedRows || 0,
      entryRows: counts.entryRows,
      virtualCreatedRows: counts.virtualCreatedRows,
      virtualExitRows,
      waitRows: counts.waitRows,
      skippedByExistingSymbol: counts.skippedByExistingSymbol || 0,
      selectedAlertMicroMicroMatches: counts.selectedAlertMicroMicroMatches || 0,
      discordCurrentFitBlockedRows: counts.discordCurrentFitBlockedRows || 0,
      discordRuntimeGateBlockedRows: counts.discordRuntimeGateBlockedRows || 0,
      activeRuntimeBlockedSelectionRows: counts.activeRuntimeBlockedSelectionRows || 0,
      empiricalVetoRows: counts.empiricalVetoRows || 0,
      policyBlockedRows: counts.policyBlockedRows || 0,
      marketWeatherUnknownRows: counts.marketWeatherUnknownRows || 0,
      playbookMissingRows: counts.playbookMissingRows || 0,
      tradeReadyRows: counts.tradeReadyRows || 0,
      watchRows: counts.watchRows || 0,
      observeRows: counts.observeRows || 0,
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries
    },

    conversionRatesPct: {
      processedPerCandidate: pct(processedCount, candidateCount),
      liveRowsPerCandidate: pct(liveRowsCount, candidateCount),
      riskValidPerLiveRow: pct(counts.riskValidRows, liveRowsCount),
      analyzedPerLiveRow: pct(analyzedRowsCount, liveRowsCount),
      analyzedRiskValidPerAnalyzed: pct(counts.analyzedRiskValidRows, analyzedRowsCount),
      analyzedExact75PerAnalyzedRiskValid: pct(counts.analyzedExact75Rows, counts.analyzedRiskValidRows),
      analyzedMicroMicroPerAnalyzedExact75: pct(counts.analyzedMicroMicroRows, counts.analyzedExact75Rows),
      weakContraRejectedPerAnalyzed: pct(counts.weakContraRejectedRows || 0, analyzedRowsCount),
      virtualCreatedPerMicroMicro: pct(counts.virtualCreatedRows, counts.analyzedMicroMicroRows),
      virtualExitPerCreatedThisRun: pct(virtualExitRows, counts.virtualCreatedRows)
    },

    runtimeWarnings,
    primaryBottleneck,
    topWaitReasons: topReasonCounts(actions, 12),
    measurementPrinciple: 'Weather capture live; selector/sizing/FDR observe; Discord trade-ready only when validated.'
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
    universeOmittedForRedis: Boolean(universe),
    symbolsOmittedForRedis: Array.isArray(symbols),
    tickersOmittedForRedis: Array.isArray(tickers),
    candidatesOmittedForRedis: Array.isArray(candidates),
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

function shouldMarkSnapshotProcessed(result = {}) {
  if (!result.snapshotId) return false;
  if (result.monitorOnly === true) return false;
  if (result.reason === 'MONITOR_ONLY') return false;
  if (result.reason === 'NO_SHORT_SCANNER_SNAPSHOT') return false;
  if (result.reason === 'SNAPSHOT_TOO_STALE') return false;
  if (result.reason === 'SNAPSHOT_ALREADY_PROCESSED') return false;

  return Boolean(
    n(result.analyzedMicroMicroRows, 0) > 0 ||
      n(result.virtualCreatedRows, 0) > 0 ||
      n(result.entryRows, 0) > 0 ||
      n(result.virtualExitRows, 0) > 0
  );
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
    tradeSystemVersion: TRADE_SYSTEM_VERSION,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationRequiresWeatherPlaybook: true,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    virtualExits,
    shadowExits: Array.isArray(result.shadowExits) ? result.shadowExits : virtualExits,
    realExits: [],
    virtualExitRows: virtualExits.length,
    shadowExitRows: virtualExits.length,
    realExitRows: 0,
    skipReason: result.skipReason || result.reason || null,
    completedAt,
    durationMs: completedAt - n(result.startedAt, completedAt),
    actionCounts: result.actionCounts || buildRunActionCounts(result.actions || [], virtualExits),
    rawResultOk: true,
    persistedAt: completedAt,
    persistedBy: 'src/trade/tradeSystem.js',
    persistedNamespace: SHORT_NAMESPACE,
    shouldMarkSnapshotProcessed: shouldMarkSnapshotProcessed(result)
  };

  await scopedSetJson(durableRedis, SHORT_KEYS.trade.runMeta, compactRunForRedis(finalResult)).catch(() => null);

  if (finalResult.currentEntryMarketWeatherKey) {
    await scopedSetJson(durableRedis, SHORT_KEYS.trade.lastConfirmedWeatherKey, {
      currentEntryMarketWeatherKey: finalResult.currentEntryMarketWeatherKey,
      confirmedMarketWeatherKey: finalResult.confirmedMarketWeatherKey || finalResult.currentEntryMarketWeatherKey,
      currentEntryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
      updatedAt: completedAt,
      runId: finalResult.runId || null,
      playbookRefreshRule: 'REFRESH_IMMEDIATELY_ON_CONFIRMED_MARKET_WEATHER_CHANGE',
      playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
      marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION
    }).catch(() => null);
  }

  if (finalResult.snapshotId && finalResult.shouldMarkSnapshotProcessed) {
    await scopedSetJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, {
      snapshotId: finalResult.snapshotId,
      runId: finalResult.runId || null,
      processedAt: completedAt,
      snapshotCreatedAt: finalResult.snapshotCreatedAt || null,
      selectedSnapshotSource: finalResult.selectedSnapshotSource || null,
      selectedTargetCandidateCount: finalResult.selectedTargetCandidateCount || 0,
      entryRows: finalResult.entryRows || 0,
      waitRows: finalResult.waitRows || 0,
      analyzedRows: finalResult.analyzedRows || 0,
      analyzedMicroMicroRows: finalResult.analyzedMicroMicroRows || 0,
      weakContraRejectedRows: finalResult.weakContraRejectedRows || 0,
      virtualCreatedRows: finalResult.virtualCreatedRows || 0,
      virtualExitRows: finalResult.virtualExitRows || 0,
      discordAlertsSent: finalResult.discordAlertsSent || 0,
      discordAlertsFailed: finalResult.discordAlertsFailed || 0,
      selectedMicroMicroMatchRows: finalResult.selectedMicroMicroMatchRows || 0,
      discordRuntimeGateBlockedRows: finalResult.discordRuntimeGateBlockedRows || 0,
      activeRuntimeBlockedSelectionRows: finalResult.activeRuntimeBlockedSelectionRows || 0,
      currentEntryMarketWeatherKey: finalResult.currentEntryMarketWeatherKey || null,
      confirmedMarketWeatherKey: finalResult.confirmedMarketWeatherKey || null,
      reason: finalResult.reason || null,
      runtimeWarnings: Array.isArray(finalResult.runtimeWarnings) ? finalResult.runtimeWarnings : [],
      compactedForRedis: true,
      tradeSystemVersion: TRADE_SYSTEM_VERSION,
      riskPlanVersion: SHORT_RISK_PLAN_VERSION,
      rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
      microMicroVersion: MICRO_MICRO_VERSION,
      weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
      hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
      discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
      discordActivationRequiresNetEdge: true,
      discordActivationRequiresWeatherPlaybook: true,
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
    snapshotCreatedAt: snapshot?.createdAt || null,
    selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
    selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
    selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0,
    selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount || 0,
    selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0,
    blockedNonShortCandidatesCount: snapshot?.blockedNonShortCandidatesCount || 0,

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
    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
    marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
    marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,
    currentEntryMarketWeatherKey: marketContext?.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY,
    currentEntryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
    currentEntryMarketWeatherRegime: marketContext?.entryMarketWeatherRegime || 'UNKNOWN',
    currentEntryMarketWeatherTrendSide: marketContext?.entryMarketWeatherTrendSide || 'UNKNOWN',
    confirmedMarketWeatherKey: marketContext?.confirmedMarketWeatherKey || marketContext?.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY,

    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot,
    monitorOnly: reason === 'MONITOR_ONLY',
    monitorPriceHintCount: priceHints.size,
    monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
    monitorTimeoutMs: cfg.monitorTimeoutMs,
    monitorBatchSize: cfg.monitorBatchSize,
    openPositionMonitorLimit: cfg.openPositionMonitorLimit,
    hardTimeStopNoPriceExit: cfg.hardTimeStopNoPriceExit,
    closeExpiredBeforePriceFetch: cfg.closeExpiredBeforePriceFetch,
    monitorPriceSource: cfg.monitorLivePriceFetchEnabled
      ? 'LIVE_BITGET_TICKER_FIRST_THEN_SCANNER_SNAPSHOT_HINTS'
      : 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationRequiresWeatherPlaybook: true,

    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    ...extra
  };
}

function hasFullSnapshotShape(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.candidates));
}

function snapshotCreatedAt(snapshot = {}) {
  return normalizeTimestampMs(snapshot.createdAt || snapshot.completedAt || snapshot.ts || snapshot.scannerTs, 0);
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
  return rows.filter((candidate) => inferRowTradeSide(candidate) !== OPPOSITE_TRADE_SIDE).length;
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
    .filter((candidate) => inferRowTradeSide(candidate) !== OPPOSITE_TRADE_SIDE)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags(),
      ...virtualFlags(candidate)
    }));

  const blockedNonShortCandidates = rows
    .filter((candidate) => inferRowTradeSide(candidate) === OPPOSITE_TRADE_SIDE)
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
    snapshotId: extractSnapshotId(snapshot),
    createdAt: snapshotCreatedAt(snapshot),
    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: targetRows.length,
    selectedShortCandidateCount: targetRows.length,
    selectedOppositeCandidateCount: countOppositeCandidates(snapshot),
    selectedLongCandidateCount: countOppositeCandidates(snapshot),
    blockedNonShortCandidates,
    blockedNonShortCandidatesCount: blockedNonShortCandidates.length,
    ...sideFlags(),
    ...isolationFlags(),
    ...virtualFlags(),
    candidates: targetRows,
    candidatesCount: targetRows.length,
    shortCandidatesCount: targetRows.length,
    longCandidatesCount: 0,
    topSymbols: targetRows.slice(0, 20).map((row) => row.symbol).filter(Boolean)
  };
}

function latestScanKeys() {
  return uniqueStrings([
    SHORT_KEYS.scan.latest,
    `${SHORT_KEY_PREFIX}SCAN:LATEST`,
    `${SHORT_KEY_PREFIX}SCAN:LATEST_FULL_SNAPSHOT`,
    `${SHORT_KEY_PREFIX}SCAN:FULL:LATEST`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:LATEST`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:LATEST_FULL_SNAPSHOT`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:FULL:LATEST`,
    'SCAN:LATEST',
    'SCAN:LATEST_FULL_SNAPSHOT'
  ]);
}

function snapshotKeysForId(id) {
  if (!id) return [];

  return uniqueStrings([
    SHORT_KEYS.scan.snapshot(id),
    `${SHORT_KEY_PREFIX}SCAN:SNAPSHOT:${id}`,
    `${SHORT_KEY_PREFIX}SCAN:FULL:${id}`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:SNAPSHOT:${id}`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:FULL:${id}`,
    `SCAN:SNAPSHOT:${id}`
  ]);
}

async function readSnapshotCandidate(redis, key, label) {
  const value = await safeGetSnapshotJson(redis, key, null);

  if (!value) return null;

  if (hasFullSnapshotShape(value)) {
    return {
      key,
      label,
      snapshot: value,
      snapshotId: extractSnapshotId(value),
      targetCount: countTargetCandidates(value),
      oppositeCount: countOppositeCandidates(value),
      createdAt: snapshotCreatedAt(value),
      source: `${label}:${key}`,
      reason: 'LATEST_SHORT_SCANNER_SNAPSHOT_FULL_OBJECT'
    };
  }

  const snapshotId = extractSnapshotId(value);
  if (!snapshotId) return null;

  for (const snapshotKey of snapshotKeysForId(snapshotId)) {
    const byId = await safeGetSnapshotJson(redis, snapshotKey, null);

    if (!hasFullSnapshotShape(byId)) continue;

    return {
      key: snapshotKey,
      latestPointerKey: key,
      label,
      snapshot: byId,
      snapshotId: extractSnapshotId(byId) || snapshotId,
      targetCount: countTargetCandidates(byId),
      oppositeCount: countOppositeCandidates(byId),
      createdAt: snapshotCreatedAt(byId),
      source: `${label}:${snapshotKey}`,
      reason: 'LATEST_SHORT_SCANNER_SNAPSHOT_BY_POINTER'
    };
  }

  return null;
}

async function loadRecentTargetSnapshotsFromRedis(redis, label, limit = 12) {
  const patterns = uniqueStrings([
    `${SHORT_KEY_PREFIX}SCAN:SNAPSHOT:*`,
    `${SHORT_KEY_PREFIX}SCAN:FULL:*`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:SNAPSHOT:*`,
    `${LEGACY_SHORT_KEY_PREFIX}SCAN:FULL:*`,
    'SCAN:SNAPSHOT:*'
  ]);

  const keys = uniqueStrings(
    (await Promise.all(patterns.map((pattern) => getKeys(redis, pattern, limit).catch(() => [])))).flat()
  ).slice(0, Math.max(1, limit * patterns.length));

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);
      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        key,
        label,
        snapshot,
        snapshotId: extractSnapshotId(snapshot),
        targetCount: countTargetCandidates(snapshot),
        oppositeCount: countOppositeCandidates(snapshot),
        createdAt: snapshotCreatedAt(snapshot),
        source: `${label}:${key}`,
        reason: 'RECENT_SHORT_SCANNER_SNAPSHOT_SEARCH'
      };
    })
  );

  return rows
    .filter(Boolean)
    .filter((row) => row.targetCount > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function getLatestSnapshot() {
  const stores = [
    { redis: getVolatileRedis(), label: 'VOLATILE' },
    { redis: getDurableRedis(), label: 'DURABLE' }
  ];

  const candidates = [];

  for (const store of stores) {
    for (const key of latestScanKeys()) {
      const candidate = await readSnapshotCandidate(store.redis, key, store.label);
      if (candidate?.snapshot && candidate.targetCount > 0) candidates.push(candidate);
    }
  }

  for (const store of stores) {
    candidates.push(...await loadRecentTargetSnapshotsFromRedis(store.redis, store.label, 12));
  }

  const uniqueBySnapshot = new Map();

  for (const candidate of candidates) {
    const id = candidate.snapshotId || extractSnapshotId(candidate.snapshot) || candidate.key;
    const current = uniqueBySnapshot.get(id);

    if (!current || candidate.createdAt > current.createdAt) {
      uniqueBySnapshot.set(id, candidate);
    }
  }

  const best = [...uniqueBySnapshot.values()]
    .filter((row) => row.targetCount > 0)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;

  if (!best?.snapshot) return null;

  return normalizeSelectedSnapshot(best.snapshot, {
    source: best.source,
    reason: best.reason || 'NEWEST_SHORT_SCANNER_SNAPSHOT_WITH_CANDIDATES'
  });
}

function priceFromSnapshotRow(row = {}) {
  return n(row.currentPrice ?? row.markPrice ?? row.lastPrice ?? row.price ?? row.close ?? row.entry, 0);
}

function buildSnapshotPriceHints(snapshot = {}) {
  const hints = new Map();
  const rows = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];

  for (const row of rows) {
    const price = priceFromSnapshotRow(row);
    if (price <= 0) continue;

    for (const key of [
      ...symbolTokensFromAnySymbol(row.symbol),
      ...symbolTokensFromAnySymbol(row.baseSymbol),
      ...symbolTokensFromAnySymbol(row.contractSymbol)
    ]) {
      if (key && !hints.has(key)) hints.set(key, price);
    }
  }

  return hints;
}

function priceHintForSymbol(symbol, priceHints = new Map()) {
  for (const key of symbolTokensFromAnySymbol(symbol)) {
    const value = n(priceHints.get(key), 0);
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

  if (now() - n(cached.ts, 0) > LIVE_PRICE_CACHE_TTL_MS) {
    livePriceCache.delete(key);
    return 0;
  }

  return n(cached.price, 0);
}

function setCachedLivePrice(symbol = '', price = 0) {
  const key = livePriceCacheKey(symbol);
  const value = n(price, 0);

  if (!key || value <= 0) return;

  livePriceCache.set(key, { price: value, ts: now() });
}

async function fetchBitgetTickerPrice(symbol = '') {
  const bitgetSymbol = normalizeBitgetSymbol(symbol);
  if (!bitgetSymbol) return 0;

  const cached = getCachedLivePrice(bitgetSymbol);
  if (cached > 0) return cached;

  const url = `${BITGET_BASE_URL}/api/v2/mix/market/ticker?symbol=${encodeURIComponent(bitgetSymbol)}&productType=${encodeURIComponent(BITGET_PRODUCT_TYPE)}`;
  const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });

  if (!response.ok) return 0;

  const json = await response.json().catch(() => null);
  const data = Array.isArray(json?.data) ? json.data[0] : json?.data;
  const price = n(data?.lastPr ?? data?.last ?? data?.markPrice ?? data?.indexPrice ?? data?.bidPr ?? data?.askPr, 0);

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
      const livePrice = n(liveResult, 0);
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

  const raw = Array.isArray(analyzedRowsRaw) && analyzedRowsRaw.length ? analyzedRowsRaw : liveRows;

  return raw.map((row) => {
    const key = symbolKey(row.symbol || row.baseSymbol || row.contractSymbol);
    const live = liveBySymbol.get(key) || {};
    return { ...live, ...row };
  });
}

function normalizeAnalyzedRows({ analyzedRowsRaw, liveRows, marketContext }) {
  return mergeAnalyzeRowsWithLiveRows(analyzedRowsRaw, liveRows)
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) => {
      const withWeather = attachEntryMarketWeather(row, marketContext);
      const exactRow = normalizeExactTrueMicroRow(withWeather, marketContext);
      const contextualRow = attachCurrentFitContext({
        ...exactRow,
        ...scannerMetadataFrom(row, exactRow),
        ...sideFlags(),
        ...virtualFlags(row),
        ...isolationFlags()
      }, marketContext);

      const riskRow = applyAdaptiveShortRisk(
        normalizeExactTrueMicroRow(contextualRow, marketContext),
        'ADAPTIVE_SHORT_RR_AFTER_ANALYZE_OR_FALLBACK_EXACT_75'
      );

      const weakContraEntryGate = buildWeakContraEntryGate(riskRow, marketContext);

      return {
        ...riskRow,
        ...learningIdentityFields(riskRow),
        ...marketWeatherFieldsFromRow(contextualRow),
        weakContraEntryGate,
        weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
        weakContraEntryAllowed: weakContraEntryGate.allowed,
        weakContraRejected: weakContraEntryGate.rejected,
        weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null,
        blockVirtualEntry: weakContraEntryGate.rejected,
        virtualObservationAllowed: true,
        tradeCandidateAllowed: !weakContraEntryGate.rejected
      };
    })
    .filter((row) => Boolean(getTrueMicroFamilyId(row)))
    .filter((row) => Boolean(getMicroMicroFamilyId(row)));
}

async function loadOpenPositionsFast(cfg, runtimeWarnings) {
  const result = await withTimeout(
    getOpenPositions({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      virtualOnly: true,
      requireFullRows: true,
      includeKeyOnly: false,
      monitorMode: true,
      limit: cfg.openPositionMonitorLimit,
      hydrateLimit: cfg.openPositionMonitorLimit,
      openPositionLimit: cfg.openPositionMonitorLimit,
      maxOpenPositionsToRead: cfg.openPositionMonitorLimit,
      openPositionHydrateLimit: cfg.openPositionMonitorLimit,
      openPositionReadTimeoutMs: cfg.openPositionLoadTimeoutMs,
      openPositionKeysTimeoutMs: cfg.openPositionLoadTimeoutMs
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
      ...entry,
      ...learningIdentityFields(entry),
      ...marketWeatherFieldsFromRow(entry),
      ...isolationFlags(),
      ...sideFlags(),
      ...virtualFlags(entry)
    }).then((saved) => ({ ok: true, position: saved || { ...position, ...entry } })),
    cfg.savePositionTimeoutMs,
    'SAVE_OPEN_POSITION_TIMEOUT'
  );

  if (isTimeoutResult(result)) {
    return { ok: false, reason: 'SAVE_OPEN_POSITION_TIMEOUT' };
  }

  return result?.ok ? result : { ok: false, reason: 'SAVE_OPEN_POSITION_FAILED' };
}

function snapshotAlreadyProcessedEnough(lastProcessed = {}) {
  if (!lastProcessed || typeof lastProcessed !== 'object') return false;

  return Boolean(
    n(lastProcessed.analyzedMicroMicroRows, 0) > 0 ||
      n(lastProcessed.virtualCreatedRows, 0) > 0 ||
      n(lastProcessed.entryRows, 0) > 0 ||
      n(lastProcessed.virtualExitRows, 0) > 0
  );
}

function playbookChangeWarning(previous = {}, marketContext = {}) {
  const previousKey = previous?.confirmedMarketWeatherKey || previous?.currentEntryMarketWeatherKey || null;
  const currentKey = marketContext?.confirmedMarketWeatherKey || marketContext?.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY;

  const previousParsed = parseMarketWeatherKey(previousKey);
  const currentParsed = parseMarketWeatherKey(currentKey);

  if (!previousKey || previousParsed.key === currentParsed.key) {
    return {
      changed: false,
      previousKey: previousParsed.key,
      currentKey: currentParsed.key,
      reason: 'CONFIRMED_MARKET_WEATHER_UNCHANGED'
    };
  }

  if (previousParsed.key === UNKNOWN_MARKET_WEATHER_KEY || currentParsed.key === UNKNOWN_MARKET_WEATHER_KEY) {
    return {
      changed: false,
      previousKey: previousParsed.key,
      currentKey: currentParsed.key,
      reason: 'CONFIRMED_MARKET_WEATHER_UNKNOWN_CHANGE_IGNORED'
    };
  }

  return {
    changed: true,
    previousKey: previousParsed.key,
    currentKey: currentParsed.key,
    reason: 'CONFIRMED_MARKET_WEATHER_CHANGED_REFRESH_PLAYBOOK_NOW'
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
      loadMarketContext().catch(() => ({
        ok: false,
        source: {},
        universe: {},
        entryMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
        confirmedMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
        entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
        confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
        entryMarketWeatherRegime: 'UNKNOWN',
        entryMarketWeatherTrendSide: 'UNKNOWN',
        confirmedMarketWeatherRegime: 'UNKNOWN',
        confirmedMarketWeatherTrendSide: 'UNKNOWN',
        regime: 'UNKNOWN',
        trendSide: 'UNKNOWN',
        weatherTrendSide: 'UNKNOWN',
        ageSec: null,
        stale: true,
        freshConfirmed: false,
        freshConfirmedReason: 'MARKET_CONTEXT_LOAD_FAILED'
      })),
      cfg.marketContextTimeoutMs,
      'MARKET_CONTEXT_TIMEOUT'
    );

    const marketContext = isTimeoutResult(marketContextResult)
      ? {
          ok: false,
          source: {},
          universe: {},
          entryMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
          confirmedMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
          entryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
          confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
          entryMarketWeatherRegime: 'UNKNOWN',
          entryMarketWeatherTrendSide: 'UNKNOWN',
          confirmedMarketWeatherRegime: 'UNKNOWN',
          confirmedMarketWeatherTrendSide: 'UNKNOWN',
          regime: 'UNKNOWN',
          trendSide: 'UNKNOWN',
          weatherTrendSide: 'UNKNOWN',
          ageSec: null,
          stale: true,
          freshConfirmed: false,
          freshConfirmedReason: 'MARKET_CONTEXT_TIMEOUT'
        }
      : marketContextResult;

    if (isTimeoutResult(marketContextResult)) {
      runtimeWarnings.push('MARKET_CONTEXT_TIMEOUT_USING_UNKNOWN_CONTEXT');
    }

    if (isUnknownMarketWeatherKey(marketContext.confirmedMarketWeatherKey)) {
      runtimeWarnings.push('CONFIRMED_MARKET_WEATHER_UNKNOWN_TRADE_READY_DISABLED');
    }

    const previousWeather = await getJson(durableRedis, SHORT_KEYS.trade.lastConfirmedWeatherKey, null).catch(() => null);
    const weatherChange = playbookChangeWarning(previousWeather, marketContext);

    if (weatherChange.changed) {
      runtimeWarnings.push(`CONFIRMED_MARKET_WEATHER_CHANGED:${weatherChange.previousKey}->${weatherChange.currentKey}`);
      runtimeWarnings.push('PLAYBOOK_REFRESH_REQUIRED_FOR_CONFIRMED_WEATHER');
    }

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
        maxRuntimeMs: cfg.monitorTimeoutMs,
        monitorBatchSize: cfg.monitorBatchSize,
        openPositionMonitorLimit: cfg.openPositionMonitorLimit,
        maxOpenPositionsToMonitor: cfg.openPositionMonitorLimit,
        openPositionLimit: cfg.openPositionMonitorLimit,
        maxOpenPositionsToRead: cfg.openPositionMonitorLimit,
        hydrateLimit: cfg.openPositionMonitorLimit,
        openPositionHydrateLimit: cfg.openPositionMonitorLimit,

        monitorPriceFetchTimeoutMs: cfg.monitorPriceFetchTimeoutMs,
        priceFetchTimeoutMs: cfg.monitorPriceFetchTimeoutMs,
        monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
        monitorCandleRangeEnabled: cfg.monitorCandleRangeEnabled,

        positionTimeStopMin: cfg.positionTimeStopMin,
        hardTimeStopNoPriceExit: cfg.hardTimeStopNoPriceExit,
        closeExpiredBeforePriceFetch: cfg.closeExpiredBeforePriceFetch,
        persistNoPriceFailures: false,

        hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
      }).catch((error) => ({
        __monitorError: true,
        error: error?.message || String(error)
      })),
      cfg.monitorTimeoutMs,
      'MONITOR_OPEN_POSITIONS_TIMEOUT'
    );

    const virtualExits = Array.isArray(monitorResult)
      ? monitorResult
      : Array.isArray(monitorResult?.exits)
        ? monitorResult.exits
        : Array.isArray(monitorResult?.closed)
          ? monitorResult.closed
          : [];

    if (isTimeoutResult(monitorResult)) {
      runtimeWarnings.push('MONITOR_OPEN_POSITIONS_TIMEOUT_CONTINUING_TO_ENTRY_LOOP');
    } else if (monitorResult?.__monitorError) {
      runtimeWarnings.push(`MONITOR_OPEN_POSITIONS_ERROR_CONTINUING_TO_ENTRY_LOOP:${monitorResult.error}`);
    }

    if (virtualExits.length > 0) {
      runtimeWarnings.push(`VIRTUAL_EXITS_RECORDED_THIS_RUN:${virtualExits.length}`);
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
        priceHints,
        extra: {
          hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
          virtualExitRows: virtualExits.length,
          shadowExitRows: shadowExits.length,
          monitorTimeoutMs: cfg.monitorTimeoutMs,
          monitorBatchSize: cfg.monitorBatchSize,
          openPositionMonitorLimit: cfg.openPositionMonitorLimit
        }
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
        processScannerSnapshot: false,
        priceHints,
        extra: {
          virtualExitRows: virtualExits.length,
          shadowExitRows: shadowExits.length
        }
      }));
    }

    const snapshotAgeSec = (now() - n(snapshot.createdAt, 0)) / 1000;

    if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates)
        ? snapshot.blockedNonShortCandidates
        : [];

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
          snapshotAgeSec: Math.round(snapshotAgeSec),
          virtualExitRows: virtualExits.length,
          shadowExitRows: shadowExits.length
        }
      }));
    }

    const lastProcessed = await getJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, null).catch(() => null);
    const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;
    const sameSnapshotCompletedEnough = sameSnapshot && snapshotAlreadyProcessedEnough(lastProcessed);

    if (sameSnapshot && sameSnapshotCompletedEnough && !forceProcessSnapshot && !weatherChange.changed) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates)
        ? snapshot.blockedNonShortCandidates
        : [];

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
        priceHints,
        extra: {
          lastProcessedSnapshotId: lastProcessed?.snapshotId || null,
          lastProcessedAnalyzedMicroMicroRows: lastProcessed?.analyzedMicroMicroRows || 0,
          virtualExitRows: virtualExits.length,
          shadowExitRows: shadowExits.length
        }
      }));
    }

    if (sameSnapshot && !sameSnapshotCompletedEnough && !forceProcessSnapshot) {
      runtimeWarnings.push('SAME_SNAPSHOT_REPROCESSED_BECAUSE_PREVIOUS_RUN_HAD_NO_MICRO_MICRO_OUTPUT');
    }

    if (sameSnapshot && weatherChange.changed && !forceProcessSnapshot) {
      runtimeWarnings.push('SAME_SNAPSHOT_REPROCESSED_BECAUSE_CONFIRMED_MARKET_WEATHER_CHANGED');
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
        selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA,
        trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
        learningGranularity: CHILD75_LEARNING_GRANULARITY,
        child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
        parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
        microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        microMicroVersion: MICRO_MICRO_VERSION,
        discordActivationRequiresNetEdge: true,
        discordActivationRequiresWeatherPlaybook: true,
        discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
        currentMarketWeatherKey: marketContext.confirmedMarketWeatherKey,
        confirmedMarketWeatherKey: marketContext.confirmedMarketWeatherKey,
        marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION
      }).catch(() => null),
      cfg.rotationTimeoutMs,
      'ACTIVE_ROTATION_TIMEOUT'
    );

    const activeRotation = isTimeoutResult(activeRotationResult) ? null : activeRotationResult;

    if (isTimeoutResult(activeRotationResult)) {
      runtimeWarnings.push('ACTIVE_ROTATION_TIMEOUT_DISCORD_SELECTION_EMPTY');
    }

    const alertContext = buildSelectedAlertContext(activeRotation, marketContext);

    if (alertContext.activeSelectionRuntimeFiltered) {
      runtimeWarnings.push(`ACTIVE_SELECTION_RUNTIME_NET_EDGE_FILTERED:${alertContext.rejectedSelectedMicroMicroCount}`);
    }

    const preAnalyzeBlockedActions = Array.isArray(snapshot.blockedNonShortCandidates)
      ? snapshot.blockedNonShortCandidates
      : [];

    const allTargetCandidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
      .filter((candidate) => inferRowTradeSide(candidate) !== OPPOSITE_TRADE_SIDE);

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

    if (cappedCandidateCount > 0) {
      runtimeWarnings.push(`SHORT_CANDIDATES_CAPPED_FOR_ENTRY_BUDGET:${cappedCandidateCount}`);
    }

    const processed = await mapConcurrent(
      candidates,
      cfg.dataConcurrency,
      (candidate) => safeProcessCandidate(candidate, marketContext)
    );

    const candidateTimeoutRows = processed.filter((row) => row?.timedOut).length;

    if (candidateTimeoutRows > 0) {
      runtimeWarnings.push(`CANDIDATE_TIMEOUT_ROWS:${candidateTimeoutRows}`);
    }

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
        ...virtualFlags(row),
        ...learningIdentityFields(row)
      }, marketContext))
      .slice(0, cfg.analyzeMaxCandidatesPerSnapshot);

    const actualLiveRows = liveRows.length;
    const observationOnlyRows = liveRows.filter((row) => row.observationOnly || row.analysisInputOnly).length;
    const standardizedLearningRiskRows = liveRows.filter((row) => row.standardizedLearningRisk).length;
    const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
    const riskValidRows = liveRows.filter(hasValidRiskShape).length;

    let analyzedRowsRaw = [];
    let analyzeError = null;
    let analyzeFallbackUsed = false;

    const weatherCapture = buildEntryMarketWeatherSnapshot({
      entryMarketWeatherKey: marketContext.entryMarketWeatherKey,
      entryMarketWeatherRegime: marketContext.entryMarketWeatherRegime,
      entryMarketWeatherTrendSide: marketContext.entryMarketWeatherTrendSide,
      entryMarketWeatherRaw: marketContext.entryMarketWeatherRaw
    }, now());

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

          observationAlwaysCounted: true,
          observationDedupeRequired: true,
          observationDedupeEnabled: true,
          seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_MICRO_MICRO_ENTRY_OBSERVATION_ONLY',

          scannerFingerprintsMetadataOnly: true,
          scannerFingerprintsUsedAsLearningFamily: false,
          executionFingerprintsMetadataOnly: false,
          executionFingerprintsUsedAsLearningFamily: false,
          executionFingerprintsCanDeriveMicroMicroContextHash: true,
          executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',

          analyzeMicroFamiliesOnly: true,
          learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
          symbolExcludedFromFamilyId: true,
          coinNameExcludedFromFamilyId: true,
          scannerHashesExcludedFromFamilyId: true,
          hashesExcludedFromFamilyId: false,
          entryMarketWeatherKeyExcludedFromFamilyId: true,

          trueMicroOnly: true,
          exactTrueMicroOnly: true,
          exactTrueMicroFamilyRequired: true,
          fixedTaxonomyPreferred: true,

          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
          childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          microMicroFamilySchema: MICRO_MICRO_SCHEMA,
          trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

          learningGranularity: CHILD75_LEARNING_GRANULARITY,
          child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
          parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
          microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

          parentLearningEnabled: true,
          childLearningEnabled: true,
          microMicroLearningEnabled: true,
          layeredLearningEnabled: true,

          selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
          parentSelectionAllowed: false,
          micro75SelectionAllowed: false,
          microMicroSelectionAllowed: true,
          fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

          currentMarketWeather: marketContext.source || null,
          currentMarketUniverse: marketContext.universe || null,
          confirmedMarketWeatherKey: marketContext.confirmedMarketWeatherKey,
          confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
          confirmedMarketWeatherRegime: marketContext.confirmedMarketWeatherRegime,
          confirmedMarketWeatherTrendSide: marketContext.confirmedMarketWeatherTrendSide,
          marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
          marketWeatherFeatureFlagsVersion: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
          marketWeatherCaptureEnabled: true,

          ...weatherCapture,

          currentRegime: marketContext.regime,
          currentTrendSide: marketContext.trendSide,

          currentFitSoftOnly: true,
          currentFitBlocksLearning: false,
          currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
          currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

          weakContraEntryGateEnabled: true,
          weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
          weakContraRejectedBlocksVirtualEntry: true,
          weakContraRejectedBlocksLearning: false,

          riskPlanVersion: SHORT_RISK_PLAN_VERSION,
          rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
          riskGeometryRule: 'SHORT: tp < entry < sl',
          tpHitRule: 'SHORT: candle.low <= tp',
          slHitRule: 'SHORT: candle.high >= sl',
          grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
          currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
          microMicroVersion: MICRO_MICRO_VERSION,
          hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
          discordActivationRequiresNetEdge: true,
          discordActivationRequiresWeatherPlaybook: true,
          discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION
        }),
        cfg.analyzeTimeoutMs,
        'ANALYZE_CANDIDATES_TIMEOUT'
      );

      if (isTimeoutResult(analyzeResult)) {
        analyzeError = 'ANALYZE_CANDIDATES_TIMEOUT';
        analyzeFallbackUsed = true;
        runtimeWarnings.push('ANALYZE_CANDIDATES_TIMEOUT_USING_FALLBACK_EXACT_75_AND_MICRO_MICRO_ROWS');
        analyzedRowsRaw = liveRows;
      } else {
        analyzedRowsRaw = Array.isArray(analyzeResult) ? analyzeResult : [];

        if (!analyzedRowsRaw.length) {
          analyzeFallbackUsed = true;
          runtimeWarnings.push('ANALYZE_RETURNED_EMPTY_USING_FALLBACK_EXACT_75_AND_MICRO_MICRO_ROWS');
          analyzedRowsRaw = liveRows;
        }
      }
    } catch (error) {
      analyzeError = error?.message || String(error);
      analyzeFallbackUsed = true;
      runtimeWarnings.push(`ANALYZE_CANDIDATES_ERROR_USING_FALLBACK_EXACT_75_AND_MICRO_MICRO_ROWS:${analyzeError}`);
      analyzedRowsRaw = liveRows;
    }

    const analyzedRows = normalizeAnalyzedRows({ analyzedRowsRaw, liveRows, marketContext });
    const analyzedActualRows = analyzedRows.length;
    const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
    const analyzedExact75Rows = analyzedRows.filter((row) => Boolean(getTrueMicroFamilyId(row))).length;
    const analyzedMicroMicroRows = analyzedRows.filter((row) => Boolean(getMicroMicroFamilyId(row))).length;
    const fallbackExact75Rows = analyzedRows.filter((row) => row.fallbackExact75).length;
    const analyzedStandardizedLearningRiskRows = analyzedRows.filter((row) => row.standardizedLearningRisk).length;
    const weakContraRejectedRows = analyzedRows.filter((row) => row.weakContraRejected === true || row.blockVirtualEntry === true).length;
    const weakContraAllowedRows = analyzedRows.filter((row) => row.weakContraEntryGate?.applies === true && row.weakContraRejected !== true).length;

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
    let discordAlertsSkippedRuntimeGate = 0;
    let selectedMicroMicroMatchRows = 0;
    let unselectedMicroEntryRows = 0;
    let entryLoopAttempts = 0;
    let entryLoopRuntimeBreak = false;
    let tradeReadyRows = 0;
    let watchRows = 0;
    let observeRows = 0;
    let playbookMissingRows = 0;
    let marketWeatherUnknownRows = 0;

    for (const rawRow of analyzedRows) {
      entryLoopAttempts += 1;

      const minimumAttemptsStillRequired = entryLoopAttempts <= cfg.minEntryLoopAttempts;

      if (!minimumAttemptsStillRequired && runtimeExceeded(startedAt, cfg, cfg.entryLoopReserveMs)) {
        runtimeWarnings.push(`MAX_RUNTIME_REACHED_ENTRY_LOOP_STOPPED_AFTER_MIN_ATTEMPTS:${entryLoopAttempts - 1}`);
        entryLoopRuntimeBreak = true;
        break;
      }

      const row = attachEntryMarketWeather({
        ...rawRow,
        ...learningIdentityFields(rawRow),
        ...sideFlags(),
        ...virtualFlags(rawRow),
        ...isolationFlags()
      }, marketContext);

      const microMicroFamilyId = getMicroMicroFamilyId(row);
      const virtualGate = validateVirtualEntry(row);
      const runtimeStatusGate = virtualGate.microMicroRuntimeGate || microMicroRuntimeGate(row);

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
          microMicroFamilyId: microMicroFamilyId || null,
          trueMicroMicroFamilyId: microMicroFamilyId || null,
          exactMicroMicroFamilyId: microMicroFamilyId || null,
          virtualGate,
          weakContraEntryGate: row.weakContraEntryGate || virtualGate.weakContraEntryGate || null,
          weakContraEntryGateVersion: row.weakContraEntryGateVersion || WEAK_CONTRA_ENTRY_GATE_VERSION,
          weakContraRejected: row.weakContraRejected || row.blockVirtualEntry || false,
          weakContraRejectReason: row.weakContraRejectReason || virtualGate.reason || null,
          virtualTracked: false,
          liveEligible: false,
          discordActivationEligible: false,
          discordRuntimeActivationGatePassed: false,
          hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
          microMicroRuntimeGate: runtimeStatusGate,
          microMicroRuntimeGateStatus: runtimeStatusGate.status,
          microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
          microMicroStatus: runtimeStatusGate.status,
          empiricalVeto: virtualGate.empiricalVeto === true || runtimeStatusGate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO,
          empiricalVetoReason: virtualGate.empiricalVetoReason || runtimeStatusGate.empiricalVetoReason || null,
          empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
          policyBlocked: virtualGate.policyBlocked === true || runtimeStatusGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED,
          policyBlockedReason: runtimeStatusGate.policyGate?.reason || null,
          proofTier: proofTierFromRuntimeStatus(runtimeStatusGate.status),
          signalType: SIGNAL_TYPE_BLOCKED,
          riskFractionForEntry: 0,
          maxAllowedRiskBand: MAX_ALLOWED_RISK_BAND_ZERO,
          ...marketWeatherFieldsFromRow(row),
          ...sideFlags(),
          ...virtualFlags(row),
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
          microMicroFamilyId: microMicroFamilyId || null,
          trueMicroMicroFamilyId: microMicroFamilyId || null,
          exactMicroMicroFamilyId: microMicroFamilyId || null,
          discordActivationEligible: false,
          discordRuntimeActivationGatePassed: false,
          signalType: SIGNAL_TYPE_OBSERVE_ONLY,
          riskFractionForEntry: 0,
          hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
          ...marketWeatherFieldsFromRow(row),
          ...sideFlags(),
          ...virtualFlags(row),
          ...isolationFlags()
        });

        continue;
      }

      const selectedAlertMatch = selectedAlertMatchInfo(alertContext, row);
      const selectedWeeklyStats = getSelectedWeeklyStats(alertContext, selectedAlertMatch.selectedMicroMicroFamilyId || microMicroFamilyId);
      const selectedRuntimeStatusGate = microMicroRuntimeGate(selectedWeeklyStats || row);
      const runtimeGate = selectedAlertMatch.discordRuntimeActivationGate ||
        runtimeDiscordActivationGate({
          ...(selectedWeeklyStats || row),
          microMicroRuntimeGate: selectedRuntimeStatusGate
        });
      const currentFitGate = discordCurrentFitGate(row);

      const riskAndSignal = buildRiskAndSignalDecision({
        row,
        selectedWeeklyStats,
        selectedAlertMatch: {
          ...selectedAlertMatch,
          discordRuntimeActivationGate: runtimeGate
        },
        runtimeStatusGate: selectedRuntimeStatusGate,
        currentFitGate,
        alertContext,
        sizing
      });

      if (riskAndSignal.signalType === SIGNAL_TYPE_TRADE_READY) tradeReadyRows += 1;
      if (riskAndSignal.signalType === SIGNAL_TYPE_WATCH_ONLY) watchRows += 1;
      if (riskAndSignal.signalType === SIGNAL_TYPE_OBSERVE_ONLY) observeRows += 1;
      if (riskAndSignal.reason === 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER') playbookMissingRows += 1;
      if (riskAndSignal.reason === 'MARKET_WEATHER_UNKNOWN') marketWeatherUnknownRows += 1;

      if (selectedAlertMatch.ok && selectedAlertMatch.granularity === LAYER_MICRO_MICRO) {
        selectedMicroMicroMatchRows += 1;
      } else {
        discordAlertsSkippedNoSelectedMicro += 1;
        unselectedMicroEntryRows += 1;
      }

      if (selectedAlertMatch.ok && runtimeGate.eligible !== true) {
        discordAlertsSkippedRuntimeGate += 1;
      }

      if (selectedAlertMatch.ok && runtimeGate.eligible === true && !currentFitGate.ok) {
        discordAlertsSkippedCurrentFit += 1;
      }

      const discordAlertEligible = riskAndSignal.signalType === SIGNAL_TYPE_TRADE_READY;

      if (discordAlertEligible) {
        discordAlertEligibleRows += 1;
      }

      const entry = buildVirtualEntryAction({
        row,
        alertContext,
        selectedWeeklyStats,
        virtualGate,
        selectedAlertMatch: {
          ...selectedAlertMatch,
          microMicroRuntimeGate: selectedRuntimeStatusGate,
          microMicroRuntimeGateStatus: selectedRuntimeStatusGate.status,
          discordRuntimeActivationGate: runtimeGate,
          discordRuntimeActivationGatePassed: runtimeGate.eligible === true
        },
        riskAndSignal,
        currentFitGate
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
          hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
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
          microMicroFamilyId: microMicroFamilyId || null,
          trueMicroMicroFamilyId: microMicroFamilyId || null,
          exactMicroMicroFamilyId: microMicroFamilyId || null,
          discordActivationEligible: false,
          discordRuntimeActivationGatePassed: false,
          signalType: SIGNAL_TYPE_BLOCKED,
          riskFractionForEntry: 0,
          hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
          ...marketWeatherFieldsFromRow(row),
          ...sideFlags(),
          ...virtualFlags(row),
          ...isolationFlags()
        });
      }
    }

    if (entryLoopAttempts > 0 && !entryLoopRuntimeBreak) {
      runtimeWarnings.push(`ENTRY_LOOP_COMPLETED_ATTEMPTS:${entryLoopAttempts}`);
    }

    const actionCountMap = buildRunActionCounts(actions, virtualExits);

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
        analyzedMicroMicroRows,
        fallbackExact75Rows,
        weakContraRejectedRows,
        weakContraAllowedRows,
        entryRows,
        virtualCreatedRows,
        waitRows,
        skippedByExistingSymbol,
        selectedAlertMicroMicroMatches: selectedMicroMicroMatchRows,
        discordCurrentFitBlockedRows: discordAlertsSkippedCurrentFit,
        discordRuntimeGateBlockedRows: discordAlertsSkippedRuntimeGate,
        activeRuntimeBlockedSelectionRows: alertContext.rejectedSelectedMicroMicroCount || 0,
        empiricalVetoRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_EMPIRICAL_VETO).length,
        policyBlockedRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_POLICY_BLOCKED).length,
        marketWeatherUnknownRows,
        playbookMissingRows,
        tradeReadyRows,
        watchRows,
        observeRows
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

      entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
      qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
      scannerWideVirtualLearning: true,
      tradeEveryScannerCandidateVirtual: true,

      riskPlanVersion: SHORT_RISK_PLAN_VERSION,
      rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
      microMicroVersion: MICRO_MICRO_VERSION,
      weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
      weakContraRejectedRows,
      weakContraAllowedRows,

      hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
      hardTimeStopNoPriceExit: cfg.hardTimeStopNoPriceExit,
      closeExpiredBeforePriceFetch: cfg.closeExpiredBeforePriceFetch,

      discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
      discordActivationRequiresNetEdge: true,
      discordActivationRequiresWeatherPlaybook: true,
      discordRuntimeGateRequired: true,
      discordRuntimeNeverTrustsActiveSelectionBlindly: true,

      maxCandidatesPerSnapshot: cfg.maxCandidatesPerSnapshot,
      analyzeMaxCandidatesPerSnapshot: cfg.analyzeMaxCandidatesPerSnapshot,
      hardMaxCandidatesPerSnapshot: cfg.hardMaxCandidatesPerSnapshot,
      dataConcurrency: cfg.dataConcurrency,
      candidateTimeoutMs: cfg.candidateTimeoutMs,
      analyzeTimeoutMs: cfg.analyzeTimeoutMs,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      monitorPriceFetchTimeoutMs: cfg.monitorPriceFetchTimeoutMs,
      monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
      monitorCandleRangeEnabled: cfg.monitorCandleRangeEnabled,
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
      marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
      marketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
      marketWeatherSignalDecisionVersion: MARKET_WEATHER_SIGNAL_DECISION_VERSION,
      marketWeatherPlaybookFreshnessVersion: MARKET_WEATHER_PLAYBOOK_FRESHNESS_VERSION,
      empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
      positionSizingProofInputVersion: POSITION_SIZING_PROOF_INPUT_VERSION,

      confirmedMarketWeatherKey: marketContext.confirmedMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY,
      confirmedMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
      confirmedMarketWeatherRegime: marketContext.confirmedMarketWeatherRegime || 'UNKNOWN',
      confirmedMarketWeatherTrendSide: marketContext.confirmedMarketWeatherTrendSide || 'UNKNOWN',
      confirmedMarketWeatherChanged: weatherChange.changed,
      confirmedMarketWeatherPreviousKey: weatherChange.previousKey || null,
      confirmedMarketWeatherChangeReason: weatherChange.reason,

      currentEntryMarketWeatherKey: marketContext.entryMarketWeatherKey || UNKNOWN_MARKET_WEATHER_KEY,
      currentEntryMarketWeatherKeyVersion: SHORT_MARKET_WEATHER_KEY_VERSION,
      currentEntryMarketWeatherRegime: marketContext.entryMarketWeatherRegime || 'UNKNOWN',
      currentEntryMarketWeatherTrendSide: marketContext.entryMarketWeatherTrendSide || 'UNKNOWN',
      currentEntryMarketWeatherRaw: marketContext.entryMarketWeatherRaw || null,
      currentEntryMarketWeatherRawAvailableFields: marketContext.entryMarketWeatherRawAvailableFields || [],
      currentMarketWeatherReadFrom: marketContext.sourceReadFrom || null,
      currentMarketWeatherAgeSec: marketContext.ageSec,
      currentMarketWeatherStale: marketContext.stale,
      currentMarketWeatherFreshConfirmed: marketContext.freshConfirmed,
      currentMarketWeatherFreshConfirmedReason: marketContext.freshConfirmedReason,
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
      cappedCandidateCount,
      shortCandidateCount: candidates.length,
      longCandidateCount: 0,
      nonShortCandidateCount: snapshot.blockedNonShortCandidatesCount || 0,

      processed: processed.length,
      earlyActions: earlyActions.length,
      liveRows: liveRows.length,
      analyzeInputRows: liveRows.length,
      actualLiveRows,
      observationOnlyRows,
      standardizedLearningRiskRows,
      learningOnlyRows,
      riskValidRows,

      analyzedRows: analyzedRows.length,
      analyzedRowsRaw: analyzedRowsRaw.length,
      analyzedActualRows,
      analyzedRiskValidRows,
      analyzedExact75Rows,
      analyzedMicroMicroRows,
      fallbackExact75Rows,
      analyzedStandardizedLearningRiskRows,
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

      discordAlertEligibleRows,
      discordAlertsQueued,
      discordAlertsSent,
      discordAlertsFailed,
      discordAlertsSkippedNoSelectedMicro,
      discordAlertsSkippedCurrentFit,
      discordAlertsSkippedRuntimeGate,
      discordRuntimeGateBlockedRows: discordAlertsSkippedRuntimeGate,

      selectedMicroMatchRows: selectedMicroMicroMatchRows,
      selectedAlertMicroMatches: selectedMicroMicroMatchRows,
      selectedMicroMicroMatchRows,
      selectedAlertMicroMicroMatches: selectedMicroMicroMatchRows,
      selected75ChildMatchRows: 0,
      selectedAlert75ChildMatches: 0,
      unselectedMicroEntryRows,

      tradeReadyRows,
      watchRows,
      observeRows,
      marketWeatherUnknownRows,
      playbookMissingRows,

      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,
      entryLoopAttempts,
      entryLoopRuntimeBreak,

      actions,
      virtualActions: actions,
      actionCounts: actionCountMap,
      actionsCount: actions.length,
      rawActionsCount: actions.length,
      rawExitRowsCount: virtualExits.length,

      qualityAudit,
      runtimeWarnings,

      selectedRotationId: alertContext.rotationId,
      activeRotationId: alertContext.rotationId,

      activeSelectionRuntimeFiltered: alertContext.activeSelectionRuntimeFiltered,
      activeSelectionRuntimeFilteredReason: alertContext.activeSelectionRuntimeFilteredReason,
      rejectedSelectedMicroMicroFamilyIds: alertContext.rejectedSelectedMicroMicroFamilyIds,
      rejectedSelectedMicroMicroRows: alertContext.rejectedSelectedMicroMicroRows,
      rejectedSelectedMicroMicroCount: alertContext.rejectedSelectedMicroMicroCount,
      activeRuntimeBlockedSelectionRows: alertContext.rejectedSelectedMicroMicroCount || 0,
      configuredSelectedMicroMicroFamilyIds: alertContext.configuredMicroMicroFamilyIds || [],

      selectedMicroFamilies: 0,
      selectedTrueMicroFamilies: 0,
      selectedChildTrueMicroFamilies: 0,
      selectedMicroFamilyIds: [],
      selectedTrueMicroFamilyIds: [],
      selectedChildTrueMicroFamilyIds: [],

      selectedMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      selectedTrueMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      selectedExactMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      selectedMicroMicroFamilyIds: alertContext.selectedMicroMicroFamilyIds,
      selectedTrueMicroMicroFamilyIds: alertContext.selectedTrueMicroMicroFamilyIds,
      selectedExactMicroMicroFamilyIds: alertContext.selectedExactMicroMicroFamilyIds,

      activeMicroFamilies: 0,
      activeTrueMicroFamilies: 0,
      activeChildTrueMicroFamilies: 0,
      activeMicroFamilyIds: [],
      activeTrueMicroFamilyIds: [],
      activeChildTrueMicroFamilyIds: [],

      activeMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      activeTrueMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      activeExactMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      activeMicroMicroFamilyIds: alertContext.selectedMicroMicroFamilyIds,
      activeTrueMicroMicroFamilyIds: alertContext.selectedTrueMicroMicroFamilyIds,
      activeExactMicroMicroFamilyIds: alertContext.selectedExactMicroMicroFamilyIds,

      activeMacroFamilyIds: [],
      selectedMacroFamilyIds: [],

      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      exactTrueMicroFamilyRequired: true,
      microMicroSelectionEnabled: true,
      microMicroRequiredForVirtualEntry: true,
      allowCoarseMicroAliasLiveEntries: false,
      allowCoarseMicroAliasForDiscord: false,
      selectionPurpose: 'DISCORD_ALERT_ONLY',
      manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

      scannerSnapshotStats: {
        candidatesCount: snapshot.candidatesCount || candidates.length,
        scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount || null,
        analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount || null,
        filteredUniverse: snapshot.filteredUniverse || null,
        rawCount: snapshot.rawCount || null,
        blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0
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
      skipReason: null,

      microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
      microMicroRuntimeGateEnabled: true,
      microMicroRuntimeGateStatuses: {
        observing: MICRO_MICRO_STATUS_OBSERVING,
        passed: MICRO_MICRO_STATUS_PASSED,
        rejected: MICRO_MICRO_STATUS_REJECTED,
        empiricalVeto: MICRO_MICRO_STATUS_EMPIRICAL_VETO,
        policyBlocked: MICRO_MICRO_STATUS_POLICY_BLOCKED
      },
      microMicroObservingRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_OBSERVING).length,
      microMicroPassedRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_PASSED).length,
      microMicroRejectedRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_REJECTED).length,
      microMicroEmpiricalVetoRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_EMPIRICAL_VETO).length,
      microMicroPolicyBlockedRows: analyzedRows.filter((row) => microMicroRuntimeGate(row).status === MICRO_MICRO_STATUS_POLICY_BLOCKED).length
    };

    return saveRunMeta(baseResult);
  } finally {
    ACTIVE_RUN_OPTIONS = previousOptions;
  }
}