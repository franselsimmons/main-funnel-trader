// ================= FILE: api/trade/run.js =================

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '1mb'
    },
    responseLimit: false
  }
};

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const DEFAULT_LOCK_TTL_SEC = 70;
const DEFAULT_STALE_LOCK_AFTER_SEC = 45;
const DEFAULT_MAX_LOCK_TTL_SEC = 75;

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;

const DEFAULT_MAX_RUNTIME_MS = 26000;
const DEFAULT_MONITOR_ONLY_MAX_RUNTIME_MS = 26000;
const DEFAULT_MONITOR_TIMEOUT_MS = 3500;
const DEFAULT_MONITOR_ONLY_TIMEOUT_MS = 12000;
const DEFAULT_MONITOR_BATCH_SIZE = 80;
const DEFAULT_OPEN_POSITION_MONITOR_LIMIT = 150;
const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 12;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 25;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const CHILD75_LEARNING_GRANULARITY = LEARNING_GRANULARITY;
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V1';
const RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V13_MM_OUTCOME_RUNTIME_GATE';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V5_MM_IDENTITY_RUNTIME_GATE';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MICRO_MICRO_ONLY_V4';
const WEAK_CONTRA_ENTRY_GATE_VERSION = 'SHORT_E_WEAK_CONTRA_STRICT_ENTRY_GATE_V2';

const MICRO_MICRO_RUNTIME_GATE_VERSION = 'SHORT_MICRO_MICRO_RUNTIME_GATE_OBSERVING_PASSED_REJECTED_POLICY_BLOCKED_V1';
const DISCORD_ACTIVATION_GATE_VERSION = 'SHORT_MM_DISCORD_ACTIVATION_NET_EDGE_GATE_V2_TRADE_RUNTIME';
const EXIT_ALERT_RUNTIME_GATE_VERSION = 'SHORT_EXIT_ALERT_RUNTIME_GATE_APPROVED_ONLY_V1';

const TRADE_RUN_ROUTE_VERSION = 'SHORT_API_TRADE_RUN_CRASH_SAFE_MICRO_MICRO_RUNTIME_GATE_V10';

const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const LAST_ERROR_KEY = `${SHORT_KEY_PREFIX}TRADE:RUN:LAST_ERROR`;

const ERROR_HTTP_200_FOR_CAUGHT_RUNTIME_ERRORS = true;
const MAX_DEBUG_ROWS = 50;

let CORE = null;
let TRADE_SYSTEM_MODULE = null;

function now() {
  return Date.now();
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function isTrue(value) {
  if (value === true || value === 1) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function isFalse(value) {
  if (value === false || value === 0) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return ['false', '0', 'no', 'n', 'off', 'disabled', 'skip'].includes(raw);
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
      .flatMap((value) => typeof value === 'string' ? value.split(/[\s,;\n\r]+/g) : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function compactString(value, max = 1400) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...TRUNCATED` : text;
}

function compactError(error) {
  return compactString(error?.message || error || 'UNKNOWN_ERROR', 1400);
}

function compactStack(error) {
  return error?.stack ? compactString(error.stack, 9000) : null;
}

function cleanShortArray(values = [], max = 100) {
  return uniqueStrings(values)
    .map(upper)
    .filter((value) => value.startsWith('MICRO_SHORT_'))
    .filter((value) => !value.includes('MICRO_LONG_'))
    .filter((value) => !value.includes('_XR_'))
    .filter((value) => !value.includes('SCANNER'))
    .slice(0, max);
}

function cleanMicroMicroArray(values = [], max = 100) {
  return cleanShortArray(values, max)
    .filter((value) => value.includes('_MM_'))
    .slice(0, max);
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

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

function callMaybeKey(value, fallback = null) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function namespacedShortKey(key, fallback = null) {
  let raw = String(callMaybeKey(key, fallback) || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;

  if (raw.startsWith('LONG:')) raw = raw.slice('LONG:'.length);

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function buildShortKeys(KEYS = {}) {
  return {
    scan: {
      latest: namespacedShortKey(
        KEYS.short?.scan?.latest ||
          KEYS.scan?.shortLatest ||
          KEYS.scan?.latest,
        'SCAN:LATEST'
      )
    },

    trade: {
      lock: namespacedShortKey(
        KEYS.short?.trade?.lock ||
          KEYS.trade?.shortLock ||
          KEYS.trade?.lock,
        'TRADE:LOCK'
      ),

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

      lastError: LAST_ERROR_KEY
    },

    market: {
      universeLatest: MARKET_UNIVERSE_KEY,
      weatherLatest: MARKET_WEATHER_KEY
    }
  };
}

async function loadCoreModules() {
  if (CORE) return CORE;

  const [configMod, keysMod, redisMod] = await Promise.all([
    import('../../src/config.js'),
    import('../../src/keys.js'),
    import('../../src/redis.js')
  ]);

  CORE = {
    CONFIG: configMod.CONFIG || {},
    KEYS: keysMod.KEYS || {},
    redis: redisMod
  };

  return CORE;
}

async function loadTradeSystemModule() {
  if (TRADE_SYSTEM_MODULE) return TRADE_SYSTEM_MODULE;

  const mod = await import('../../src/trade/tradeSystem.js');

  if (typeof mod.runTradeSystem !== 'function') {
    const error = new Error('RUN_TRADE_SYSTEM_EXPORT_MISSING');
    error.availableExports = Object.keys(mod || {});
    error.expectedExport = 'runTradeSystem';
    throw error;
  }

  TRADE_SYSTEM_MODULE = mod;
  return TRADE_SYSTEM_MODULE;
}

function getConfig() {
  return CORE?.CONFIG || {};
}

function getKeys() {
  return buildShortKeys(CORE?.KEYS || {});
}

function shouldDebug(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.debug, false)) ||
    isTrue(firstValue(req.query?.details, false)) ||
    isTrue(firstValue(req.query?.full, false)) ||
    isTrue(body.debug) ||
    isTrue(body.details) ||
    isTrue(body.full)
  );
}

function shouldForceProcessSnapshot(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );
}

function shouldForceUnlock(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.forceUnlock, false)) ||
    isTrue(firstValue(req.query?.force_unlock, false)) ||
    isTrue(firstValue(req.query?.clearLock, false)) ||
    isTrue(firstValue(req.query?.clear_lock, false)) ||
    isTrue(firstValue(req.query?.unlock, false)) ||
    isTrue(body.forceUnlock) ||
    isTrue(body.force_unlock) ||
    isTrue(body.clearLock) ||
    isTrue(body.clear_lock) ||
    isTrue(body.unlock) ||
    shouldForceProcessSnapshot(req, body)
  );
}

function shouldUnlockOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.unlockOnly, false)) ||
    isTrue(firstValue(req.query?.unlock_only, false)) ||
    isTrue(body.unlockOnly) ||
    isTrue(body.unlock_only)
  );
}

function shouldMonitorOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.monitorOnly, false)) ||
    isTrue(firstValue(req.query?.monitor_only, false)) ||
    isTrue(body.monitorOnly) ||
    isTrue(body.monitor_only)
  );
}

function shouldRunMonitorPreflight(req, body = {}) {
  if (
    isFalse(firstValue(req.query?.monitorPreflight, null)) ||
    isFalse(firstValue(req.query?.monitor_preflight, null)) ||
    isFalse(body.monitorPreflight) ||
    isFalse(body.monitor_preflight)
  ) {
    return false;
  }

  return (
    isTrue(firstValue(req.query?.monitorPreflight, false)) ||
    isTrue(firstValue(req.query?.monitor_preflight, false)) ||
    isTrue(body.monitorPreflight) ||
    isTrue(body.monitor_preflight)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    shouldForceProcessSnapshot(req, body) ||
    shouldForceUnlock(req, body) ||
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(body.manual)
  );

  return manual
    ? 'ADMIN_MANUAL_SHORT_TRADE_RUN_CRASH_SAFE'
    : 'CRON_OR_API_SHORT_TRADE_RUN_CRASH_SAFE';
}

function getPositionTimeStopMin() {
  const CONFIG = getConfig();

  const value = Number(
    CONFIG.short?.trade?.positionTimeStopMin ??
      CONFIG.trade?.shortPositionTimeStopMin ??
      CONFIG.trade?.positionTimeStopMin ??
      DEFAULT_POSITION_TIME_STOP_MIN
  );

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POSITION_TIME_STOP_MIN;
  return Math.floor(value);
}

function getLockTtlSec(req, body = {}) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.lockTtlSec ??
      req.query?.lock_ttl_sec ??
      body.lockTtlSec ??
      body.lock_ttl_sec,
    null
  );

  const ttl = Number(
    requested ??
      CONFIG.short?.trade?.lockTtlSec ??
      CONFIG.trade?.shortLockTtlSec ??
      CONFIG.trade?.lockTtlSec ??
      DEFAULT_LOCK_TTL_SEC
  );

  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_LOCK_TTL_SEC;
  return safeInt(ttl, DEFAULT_LOCK_TTL_SEC, 15, DEFAULT_MAX_LOCK_TTL_SEC);
}

function getStaleLockAfterSec(req, body = {}) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.staleLockAfterSec ??
      req.query?.stale_lock_after_sec ??
      body.staleLockAfterSec ??
      body.stale_lock_after_sec,
    null
  );

  const sec = Number(
    requested ??
      CONFIG.short?.trade?.staleLockAfterSec ??
      CONFIG.trade?.shortStaleLockAfterSec ??
      CONFIG.trade?.staleLockAfterSec ??
      DEFAULT_STALE_LOCK_AFTER_SEC
  );

  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_STALE_LOCK_AFTER_SEC;
  return safeInt(sec, DEFAULT_STALE_LOCK_AFTER_SEC, 10, DEFAULT_MAX_LOCK_TTL_SEC);
}

function getMonitorTimeoutMs(req, body = {}, monitorOnly = false) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.monitorTimeoutMs ??
      req.query?.monitor_timeout_ms ??
      body.monitorTimeoutMs ??
      body.monitor_timeout_ms,
    null
  );

  return safeInt(
    requested ??
      CONFIG.short?.trade?.monitorTimeoutMs ??
      CONFIG.trade?.shortMonitorTimeoutMs ??
      CONFIG.trade?.monitorTimeoutMs ??
      (monitorOnly ? DEFAULT_MONITOR_ONLY_TIMEOUT_MS : DEFAULT_MONITOR_TIMEOUT_MS),
    monitorOnly ? DEFAULT_MONITOR_ONLY_TIMEOUT_MS : DEFAULT_MONITOR_TIMEOUT_MS,
    1000,
    20000
  );
}

function getMaxRuntimeMs(req, body = {}, monitorOnly = false) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.maxRuntimeMs ??
      req.query?.max_runtime_ms ??
      body.maxRuntimeMs ??
      body.max_runtime_ms,
    null
  );

  return safeInt(
    requested ??
      CONFIG.short?.trade?.maxRuntimeMs ??
      CONFIG.trade?.shortMaxRuntimeMs ??
      CONFIG.trade?.maxRuntimeMs ??
      (monitorOnly ? DEFAULT_MONITOR_ONLY_MAX_RUNTIME_MS : DEFAULT_MAX_RUNTIME_MS),
    monitorOnly ? DEFAULT_MONITOR_ONLY_MAX_RUNTIME_MS : DEFAULT_MAX_RUNTIME_MS,
    8000,
    35000
  );
}

function getMaxCandidatesPerSnapshot(req, body = {}) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.maxCandidates ??
      req.query?.max_candidates ??
      req.query?.maxCandidatesPerSnapshot ??
      req.query?.max_candidates_per_snapshot ??
      body.maxCandidates ??
      body.max_candidates ??
      body.maxCandidatesPerSnapshot ??
      body.max_candidates_per_snapshot,
    null
  );

  return safeInt(
    requested ??
      CONFIG.short?.trade?.maxCandidatesPerSnapshot ??
      CONFIG.trade?.shortMaxCandidatesPerSnapshot ??
      CONFIG.trade?.maxCandidatesPerSnapshot ??
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
    1,
    DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT
  );
}

function getMonitorBatchSize(req, body = {}) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.monitorBatchSize ??
      req.query?.monitor_batch_size ??
      body.monitorBatchSize ??
      body.monitor_batch_size,
    null
  );

  return safeInt(
    requested ??
      CONFIG.short?.trade?.monitorBatchSize ??
      CONFIG.trade?.shortMonitorBatchSize ??
      CONFIG.trade?.monitorBatchSize ??
      DEFAULT_MONITOR_BATCH_SIZE,
    DEFAULT_MONITOR_BATCH_SIZE,
    10,
    150
  );
}

function getOpenPositionMonitorLimit(req, body = {}) {
  const CONFIG = getConfig();

  const requested = firstValue(
    req.query?.openPositionMonitorLimit ??
      req.query?.open_position_monitor_limit ??
      body.openPositionMonitorLimit ??
      body.open_position_monitor_limit,
    null
  );

  return safeInt(
    requested ??
      CONFIG.short?.trade?.openPositionMonitorLimit ??
      CONFIG.trade?.shortOpenPositionMonitorLimit ??
      CONFIG.trade?.openPositionMonitorLimit ??
      DEFAULT_OPEN_POSITION_MONITOR_LIMIT,
    DEFAULT_OPEN_POSITION_MONITOR_LIMIT,
    10,
    300
  );
}

function runtimeGateFlags() {
  return {
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroRuntimeGateEmbeddedInExistingFiles: true,

    microMicroRuntimeStates: ['OBSERVING', 'PASSED', 'REJECTED', 'POLICY_BLOCKED'],

    microMicroObservingRule: `completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`,
    microMicroPassedRule:
      `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} && avgR > 0 && totalR > 0 && profitFactor > 1`,
    microMicroRejectedRule:
      `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} && netEdgeNotPositive`,
    microMicroPolicyBlockedRule: 'confirmationProfile == E_WEAK_CONTRA || currentFit == MISFIT',

    observingCanVirtualLearn: true,
    observingCanDiscord: false,

    passedCanVirtualLearn: true,
    passedCanDiscord: true,
    passedSelectableForDiscord: true,

    rejectedCanVirtualLearn: false,
    rejectedCanDiscord: false,
    rejectedSelectableForDiscord: false,

    policyBlockedCanVirtualLearn: false,
    policyBlockedCanDiscord: false,
    policyBlockedSelectableForDiscord: false,

    dashboardSortRule: 'PASSED_FIRST_THEN_OBSERVING_THEN_REJECTED_THEN_POLICY_BLOCKED',
    tradeRuntimeTrustsActiveSelectionBlindly: false,
    tradeRuntimeRequiresExactMicroMicro: true,
    tradeRuntimeRequiresPassedNetEdgeGate: true,

    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordActivationRequiresRuntimeGatePassed: true,
    discordOnlyForExactMicroMicroMatch: true,

    exitAlertRuntimeGateRequired: true,
    exitAlertRuntimeGateVersion: EXIT_ALERT_RUNTIME_GATE_VERSION,
    exitAlertRequiresRuntimeGateApproved: true
  };
}

function baseFlags() {
  return {
    tradeRunRouteVersion: TRADE_RUN_ROUTE_VERSION,

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
    virtualLearningForced: true,
    virtualTracked: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: `completed < ${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`,
      PASSED: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} && positive net-edge`,
      REJECTED: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE} && bad net-edge`,
      POLICY_BLOCKED: 'E_WEAK_CONTRA || MISFIT',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      MICRO_MICRO_ACTIVE: `completed >= ${MIN_COMPLETED_MICRO_MICRO_ACTIVE}`
    },

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

    parentMicroFamilyCount: 15,
    micro75Count: 75,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    riskPlanVersion: RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejectedBlocksVirtualEntry: true,
    weakContraRejectedBlocksLearning: false,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    positionTimeStopMin: getPositionTimeStopMin(),

    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscord: true,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    scannerMatchTriggersDiscord: false,
    macroMatchDoesNotTriggerDiscord: true,
    parentMacroMatchDoesNotTriggerDiscord: true,
    micro75MatchDoesNotTriggerDiscord: true,

    ...runtimeGateFlags(),

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    scannerRunDisabledInsideTradeRun: true,
    scannerLatestReadOnlyInsideTradeRun: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    writesScanner: false,
    writesMarketUniverse: false,
    writesMarketWeather: false,
    writesTrade: true,
    writesAnalyze: true,
    writesRotation: false,
    writesDiscordSelection: false,
    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    monitorOpenPositionsFirst: true,
    exitSweepBeforeEntryGate: true,
    snapshotAlreadyProcessedDoesNotBlockMonitor: true,

    debugSafeDynamicImports: true,
    topLevelTradeSystemImportDisabled: true,
    importErrorsReturnedAsJson: true,
    caughtRuntimeErrorsReturnJson: true,
    caughtRuntimeErrorsReturnHttp200: ERROR_HTTP_200_FOR_CAUGHT_RUNTIME_ERRORS,
    lastErrorKey: LAST_ERROR_KEY
  };
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Run-Route-Version', TRADE_RUN_ROUTE_VERSION);
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Exchange-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-No-Real-Orders', 'true');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_MICRO_MICRO_FAMILY');
  res.setHeader('X-Selection-Granularity', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Version', MICRO_MICRO_VERSION);
  res.setHeader('X-Micro-Micro-Runtime-Gate-Version', MICRO_MICRO_RUNTIME_GATE_VERSION);
  res.setHeader('X-Discord-Activation-Gate-Version', DISCORD_ACTIVATION_GATE_VERSION);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Risk-Plan-Version', RISK_PLAN_VERSION);
  res.setHeader('X-Cost-Model-Version', COST_MODEL_VERSION);
  res.setHeader('X-Measurement-Fix-Version', MEASUREMENT_FIX_VERSION);
  res.setHeader('X-Observation-Dedupe-Version', OBSERVATION_DEDUPE_VERSION);
  res.setHeader('X-Outcome-Dedupe-Version', OUTCOME_DEDUPE_VERSION);
  res.setHeader('X-Weak-Contra-Entry-Gate-Version', WEAK_CONTRA_ENTRY_GATE_VERSION);
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-Debug-Safe-Dynamic-Imports', 'true');
  res.setHeader('X-Last-Error-Key', LAST_ERROR_KEY);
  res.setHeader('X-Caught-Runtime-Errors-Return-Http-200', String(ERROR_HTTP_200_FOR_CAUGHT_RUNTIME_ERRORS));
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...baseFlags()
  });
}

async function redisGetRaw(redis, key) {
  if (!redis || !key || typeof redis.get !== 'function') return null;

  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

async function redisDel(redis, key) {
  if (!redis || !key || typeof redis.del !== 'function') return false;

  try {
    await redis.del(key);
    return true;
  } catch {
    return false;
  }
}

async function redisTtl(redis, key) {
  if (!redis || !key || typeof redis.ttl !== 'function') return null;

  try {
    const ttl = await redis.ttl(key);
    return Number.isFinite(Number(ttl)) ? Number(ttl) : null;
  } catch {
    return null;
  }
}

async function redisSetNxEx(redis, key, value, ttlSec) {
  if (!redis || !key || typeof redis.set !== 'function') return false;

  const serialized = typeof value === 'string' ? value : JSON.stringify(value);

  try {
    const result = await redis.set(key, serialized, {
      nx: true,
      ex: ttlSec
    });

    if (result === 'OK' || result === true || result?.ok === true) return true;
  } catch {
    // Fallback hieronder.
  }

  try {
    const result = await redis.set(key, serialized, 'EX', ttlSec, 'NX');
    return result === 'OK' || result === true || result?.ok === true;
  } catch {
    return false;
  }
}

async function readLockState(redis, lockKey) {
  const ttlSec = await redisTtl(redis, lockKey);
  const raw = await redisGetRaw(redis, lockKey);

  if (!raw) {
    return {
      exists: false,
      raw: null,
      ttlSec
    };
  }

  if (typeof raw === 'object') {
    const createdAt = safeNumber(raw.createdAt, 0);
    const ageSec = createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null;

    return {
      exists: true,
      raw,
      parsed: raw,
      ttlSec,
      ageSec,
      token: raw.token || null,
      runId: raw.runId || null,
      createdAt,
      expiresAt: raw.expiresAt || null
    };
  }

  const text = String(raw);

  try {
    const parsed = JSON.parse(text);
    const createdAt = safeNumber(parsed.createdAt, 0);
    const ageSec = createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null;

    return {
      exists: true,
      raw: text,
      parsed,
      ttlSec,
      ageSec,
      token: parsed.token || null,
      runId: parsed.runId || null,
      createdAt,
      expiresAt: parsed.expiresAt || null
    };
  } catch {
    return {
      exists: true,
      raw: text,
      parsed: null,
      ttlSec,
      ageSec: null,
      token: text,
      runId: null,
      createdAt: null,
      expiresAt: null
    };
  }
}

function isStaleLock(lockState, staleAfterSec) {
  if (!lockState?.exists) return false;

  if (Number.isFinite(lockState.ageSec) && lockState.ageSec >= staleAfterSec) return true;
  if (Number.isFinite(lockState.ttlSec) && lockState.ttlSec <= 0) return true;

  const expiresAt = safeNumber(lockState.expiresAt, NaN);
  if (Number.isFinite(expiresAt) && expiresAt <= now()) return true;

  return false;
}

async function releaseOwnLock(redis, lockKey, lockValue, force = false) {
  const state = await readLockState(redis, lockKey);

  if (!state.exists) {
    return {
      released: false,
      reason: 'LOCK_ALREADY_GONE'
    };
  }

  const ownsLock =
    force ||
    state.token === lockValue.token ||
    state.runId === lockValue.runId ||
    state.raw === lockValue.token;

  if (!ownsLock) {
    return {
      released: false,
      reason: 'LOCK_NOT_OWNED',
      currentRunId: state.runId || null,
      currentAgeSec: state.ageSec
    };
  }

  await redisDel(redis, lockKey);

  return {
    released: true,
    reason: force ? 'LOCK_FORCE_RELEASED' : 'LOCK_RELEASED_BY_OWNER'
  };
}

async function acquireTradeLock({
  redis,
  lockKey,
  lockTtlSec,
  staleLockAfterSec,
  forceUnlock,
  runSource
}) {
  const runId = `short_trade_${now()}_${Math.random().toString(16).slice(2, 10)}`;
  const token = `${runId}_${Math.random().toString(16).slice(2, 12)}`;
  const createdAt = now();

  const lockValue = {
    token,
    runId,
    createdAt,
    expiresAt: createdAt + lockTtlSec * 1000,
    ttlSec: lockTtlSec,
    staleAfterSec: staleLockAfterSec,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    runSource,
    routeVersion: TRADE_RUN_ROUTE_VERSION,
    staleSafeLock: true
  };

  const initialState = await readLockState(redis, lockKey);

  let forceClearedBeforeAcquire = false;
  let staleClearedBeforeAcquire = false;

  if (initialState.exists && forceUnlock) {
    await redisDel(redis, lockKey);
    forceClearedBeforeAcquire = true;
  } else if (initialState.exists && isStaleLock(initialState, staleLockAfterSec)) {
    await redisDel(redis, lockKey);
    staleClearedBeforeAcquire = true;
  }

  let acquired = await redisSetNxEx(redis, lockKey, lockValue, lockTtlSec);

  if (!acquired) {
    const failedState = await readLockState(redis, lockKey);

    if (failedState.exists && isStaleLock(failedState, staleLockAfterSec)) {
      await redisDel(redis, lockKey);
      staleClearedBeforeAcquire = true;
      acquired = await redisSetNxEx(redis, lockKey, lockValue, lockTtlSec);
    }

    if (!acquired) {
      return {
        acquired: false,
        lockValue,
        state: failedState,
        forceClearedBeforeAcquire,
        staleClearedBeforeAcquire,
        reason: 'TRADE_RUN_LOCK_ACTIVE'
      };
    }
  }

  return {
    acquired: true,
    lockValue,
    state: await readLockState(redis, lockKey),
    forceClearedBeforeAcquire,
    staleClearedBeforeAcquire,
    reason: 'LOCK_ACQUIRED'
  };
}

async function runWithTradeLock({
  redis,
  lockKey,
  lockTtlSec,
  staleLockAfterSec,
  forceUnlock,
  runSource,
  fn
}) {
  const lock = await acquireTradeLock({
    redis,
    lockKey,
    lockTtlSec,
    staleLockAfterSec,
    forceUnlock,
    runSource
  });

  if (!lock.acquired) {
    return {
      ok: true,
      skipped: true,
      skippedNewEntries: true,
      reason: 'TRADE_RUN_LOCK_ACTIVE',
      skipReason: 'TRADE_RUN_LOCK_ACTIVE',
      lock
    };
  }

  let result;
  let caughtError = null;
  let released = null;

  try {
    result = await fn(lock);
  } catch (error) {
    caughtError = error;
  }

  try {
    released = await releaseOwnLock(redis, lockKey, lock.lockValue, false);
    if (released?.released !== true) {
      released = await releaseOwnLock(redis, lockKey, lock.lockValue, true);
    }
  } catch (error) {
    released = {
      released: false,
      reason: `LOCK_RELEASE_FAILED:${compactError(error)}`
    };
  }

  if (caughtError) {
    caughtError.lock = lock;
    caughtError.lockRelease = released;
    throw caughtError;
  }

  return {
    ok: result?.ok !== false,
    skipped: Boolean(result?.skipped || result?.skippedNewEntries),
    reason: result?.reason || result?.skipReason || null,
    result,
    lock,
    lockRelease: released
  };
}

function unwrapRunResult(value) {
  if (!value) return null;
  if (value.result?.result?.result) return value.result.result.result;
  if (value.result?.result) return value.result.result;
  if (value.result) return value.result;
  return value;
}

function selectRawActions(payload = {}) {
  return Array.isArray(payload.actions) ? payload.actions : [];
}

function selectRawEntryRows(payload = {}, actions = []) {
  if (Array.isArray(payload.entryRows)) return payload.entryRows;
  if (Array.isArray(payload.entries)) return payload.entries;
  if (Array.isArray(payload.virtualCreatedRows)) return payload.virtualCreatedRows;
  if (Array.isArray(payload.shadowCreatedRows)) return payload.shadowCreatedRows;

  return actions.filter((row) => row?.action === 'VIRTUAL_ENTRY' || row?.action === 'ENTRY');
}

function selectRawWaitRows(payload = {}, actions = []) {
  if (Array.isArray(payload.waitRows)) return payload.waitRows;
  if (Array.isArray(payload.waits)) return payload.waits;

  return actions.filter((row) => row?.action === 'WAIT');
}

function selectRawExitRows(payload = {}) {
  if (Array.isArray(payload.virtualExits)) return payload.virtualExits;
  if (Array.isArray(payload.shadowExits)) return payload.shadowExits;
  if (Array.isArray(payload.exits)) return payload.exits;
  if (Array.isArray(payload.closedPositions)) return payload.closedPositions;
  if (Array.isArray(payload.outcomes)) return payload.outcomes;

  return [];
}

function countActionsByType(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = safeNumber(acc[key], 0) + 1;
    return acc;
  }, {});
}

function compactRows(rows = [], limit = MAX_DEBUG_ROWS) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((row) => {
      if (!row || typeof row !== 'object') return row;

      return {
        symbol: row.symbol || row.baseSymbol || null,
        contractSymbol: row.contractSymbol || null,
        action: row.action || row.type || null,
        reason: row.reason || row.skipReason || row.liveEntryBlockedReason || null,

        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        positionSide: TARGET_TRADE_SIDE,
        direction: TARGET_TRADE_SIDE,

        microMicroRuntimeState:
          row.microMicroRuntimeState ||
          row.runtimeGateState ||
          row.runtimeGateStatus ||
          row.discordRuntimeActivationGate?.state ||
          null,

        microMicroRuntimeGate:
          row.microMicroRuntimeGate ||
          row.runtimeGate ||
          row.discordRuntimeActivationGate ||
          row.discordActivationGate ||
          null,

        discordRuntimeGateBlocked:
          Boolean(row.discordRuntimeGateBlocked || row.discordRuntimeActivationGate?.blocked),

        trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId || null,
        childTrueMicroFamilyId: row.childTrueMicroFamilyId || row.base75ChildTrueMicroFamilyId || null,
        parentTrueMicroFamilyId: row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || null,

        microMicroFamilyId: row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId || null,
        trueMicroMicroFamilyId: row.trueMicroMicroFamilyId || row.microMicroFamilyId || row.exactMicroMicroFamilyId || null,
        exactMicroMicroFamilyId: row.exactMicroMicroFamilyId || row.microMicroFamilyId || row.trueMicroMicroFamilyId || null,

        confirmationProfile: row.confirmationProfile || null,
        weakContraRejected: Boolean(row.weakContraRejected || row.blockVirtualEntry),
        weakContraRejectReason: row.weakContraRejectReason || row.weakContraEntryGate?.reason || null,

        entry: row.entry ?? row.entryPrice ?? null,
        sl: row.sl ?? row.stopLoss ?? row.initialSl ?? null,
        tp: row.tp ?? row.takeProfit ?? null,
        exitPrice: row.exitPrice ?? null,
        currentPrice: row.currentPrice ?? row.lastPrice ?? null,

        rr: row.rr ?? null,
        grossR: row.grossR ?? row.shortGrossR ?? null,
        netR: row.netR ?? row.r ?? row.realizedR ?? null,
        costR: row.costR ?? null,

        completed: row.completed ?? row.outcomeSample ?? null,
        avgR: row.avgR ?? row.avgNetR ?? null,
        totalR: row.totalR ?? row.netTotalR ?? null,
        profitFactor: row.profitFactor ?? row.pf ?? row.netProfitFactor ?? null,
        avgCostR: row.avgCostR ?? null,
        directSLPct: row.directSLPct ?? null,

        currentFit: row.currentFit || row.currentFitLabel || row.entryCurrentFit || null,
        currentFitScore: row.currentFitScore ?? row.shortCurrentFit ?? row.bearCurrentFit ?? null,

        virtualOnly: true,
        realOrder: false,
        exchangeOrder: false,
        bitgetOrderPlaced: false
      };
    });
}

function compactMarketWeather(value = {}) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: value.ok ?? value.available ?? null,
    available: value.available ?? value.ok ?? null,
    version: value.version || null,
    snapshotId: value.snapshotId || null,
    generatedAt: value.generatedAt || null,
    createdAt: value.createdAt || null,
    completedAt: value.completedAt || null,
    updatedAt: value.updatedAt || null,

    currentRegime: value.currentRegime || value.regime || null,
    regime: value.regime || value.currentRegime || null,
    currentTrendSide: value.currentTrendSide || value.trendSide || null,
    trendSide: value.trendSide || value.currentTrendSide || null,

    confidence: value.confidence ?? value.weatherConfidence ?? null,
    bullishCount: value.bullishCount ?? null,
    bearishCount: value.bearishCount ?? null,
    neutralCount: value.neutralCount ?? null,
    squeezeCount: value.squeezeCount ?? null,
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    neutralPct: value.neutralPct ?? null,
    squeezePct: value.squeezePct ?? null,
    count: value.count ?? value.universeCount ?? null,
    universeCount: value.universeCount ?? value.count ?? null,

    rowsOmittedForRedis: Array.isArray(value.rows),
    symbolsOmittedForRedis: Array.isArray(value.symbols),
    compactedForRedis: true
  };
}

function compactMarketContext(value = {}) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: Boolean(value.ok),
    createdAt: value.createdAt || null,
    ageSec: value.ageSec ?? null,
    stale: Boolean(value.stale),
    regime: value.regime || 'UNKNOWN',
    trendSide: value.trendSide || 'UNKNOWN',
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    squeezePct: value.squeezePct ?? null,
    confidence: value.confidence ?? null,
    key: value.key || MARKET_WEATHER_KEY,
    universeKey: value.universeKey || MARKET_UNIVERSE_KEY,
    source: compactMarketWeather(value.source),
    universe: null,
    compactedForRedis: true
  };
}

function compactRunPayload(payload, { debug = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'NO_PAYLOAD_FROM_TRADE_SYSTEM'
    };
  }

  const actions = selectRawActions(payload);
  const rawEntryRows = selectRawEntryRows(payload, actions);
  const rawWaitRows = selectRawWaitRows(payload, actions);
  const rawExitRows = selectRawExitRows(payload);

  const entryCount = Array.isArray(payload.entryRows)
    ? payload.entryRows.length
    : safeNumber(payload.entryRows, rawEntryRows.length);

  const waitCount = Array.isArray(payload.waitRows)
    ? payload.waitRows.length
    : safeNumber(payload.waitRows, rawWaitRows.length);

  const virtualCreatedCount = Array.isArray(payload.virtualCreatedRows)
    ? payload.virtualCreatedRows.length
    : safeNumber(payload.virtualCreatedRows ?? payload.shadowCreatedRows, entryCount);

  const virtualExitCount = safeNumber(
    payload.virtualExitRows ??
      payload.shadowExitRows ??
      rawExitRows.length,
    rawExitRows.length
  );

  return {
    ok: payload.ok !== false,
    skipped: Boolean(payload.skipped),
    skippedNewEntries: Boolean(payload.skippedNewEntries),
    reason: payload.reason || payload.skipReason || null,
    skipReason: payload.skipReason || payload.reason || null,

    runId: payload.runId || null,
    runPhase: payload.runPhase || payload.tradeRunPhase || null,
    startedAt: payload.startedAt || null,
    completedAt: payload.completedAt || null,
    durationMs: payload.durationMs ?? null,

    snapshotId: payload.snapshotId || null,
    snapshotCreatedAt: payload.snapshotCreatedAt || payload.createdAt || null,
    snapshotAgeSec: payload.snapshotAgeSec ?? null,
    forceProcessSnapshot: Boolean(payload.forceProcessSnapshot),
    shouldMarkSnapshotProcessed: Boolean(payload.shouldMarkSnapshotProcessed),

    selectedSnapshotSource: payload.selectedSnapshotSource || null,
    selectedSnapshotReason: payload.selectedSnapshotReason || null,
    selectedTargetCandidateCount: safeNumber(payload.selectedTargetCandidateCount, 0),
    selectedShortCandidateCount: safeNumber(payload.selectedShortCandidateCount, 0),
    selectedOppositeCandidateCount: safeNumber(payload.selectedOppositeCandidateCount, 0),
    selectedLongCandidateCount: safeNumber(payload.selectedLongCandidateCount, 0),

    candidates: safeNumber(payload.candidates || payload.candidatesCount, 0),
    shortCandidateCount: safeNumber(payload.shortCandidateCount || payload.shortCandidatesCount, 0),
    nonShortCandidateCount: safeNumber(payload.nonShortCandidateCount, 0),

    processed: safeNumber(payload.processed, 0),
    earlyActions: safeNumber(payload.earlyActions, 0),
    liveRows: safeNumber(payload.liveRows, 0),
    analyzeInputRows: safeNumber(payload.analyzeInputRows, 0),
    actualLiveRows: safeNumber(payload.actualLiveRows, 0),
    observationOnlyRows: safeNumber(payload.observationOnlyRows, 0),
    learningOnlyRows: safeNumber(payload.learningOnlyRows, 0),
    riskValidRows: safeNumber(payload.riskValidRows, 0),

    analyzedRows: safeNumber(payload.analyzedRows, 0),
    analyzedRowsRaw: safeNumber(payload.analyzedRowsRaw, 0),
    analyzedActualRows: safeNumber(payload.analyzedActualRows, 0),
    analyzedRiskValidRows: safeNumber(payload.analyzedRiskValidRows, 0),
    analyzedExact75Rows: safeNumber(payload.analyzedExact75Rows, 0),
    analyzedMicroMicroRows: safeNumber(payload.analyzedMicroMicroRows, 0),
    fallbackExact75Rows: safeNumber(payload.fallbackExact75Rows, 0),

    weakContraRejectedRows: safeNumber(payload.weakContraRejectedRows, 0),
    weakContraAllowedRows: safeNumber(payload.weakContraAllowedRows, 0),

    entryRows: entryCount,
    waitRows: waitCount,

    virtualCreatedRows: virtualCreatedCount,
    virtualSkippedRows: safeNumber(payload.virtualSkippedRows ?? payload.shadowSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows ?? payload.shadowFailedRows, 0),
    skippedByExistingSymbol: safeNumber(payload.skippedByExistingSymbol, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows ?? virtualCreatedCount, virtualCreatedCount),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows ?? payload.virtualSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows ?? payload.virtualFailedRows, 0),

    virtualExitRows: virtualExitCount,
    shadowExitRows: virtualExitCount,
    realExitRows: 0,

    discordAlertEligibleRows: safeNumber(payload.discordAlertEligibleRows, 0),
    discordAlertsQueued: safeNumber(payload.discordAlertsQueued, 0),
    discordAlertsSent: safeNumber(payload.discordAlertsSent, 0),
    discordAlertsFailed: safeNumber(payload.discordAlertsFailed, 0),
    discordAlertsSkippedNoSelectedMicro: safeNumber(payload.discordAlertsSkippedNoSelectedMicro, 0),
    discordAlertsSkippedCurrentFit: safeNumber(payload.discordAlertsSkippedCurrentFit, 0),
    discordAlertsSkippedRuntimeGate: safeNumber(payload.discordAlertsSkippedRuntimeGate, 0),
    discordRuntimeGateBlockedRows: safeNumber(payload.discordRuntimeGateBlockedRows, 0),

    selectedMicroMatchRows: safeNumber(payload.selectedMicroMatchRows, 0),
    selectedMicroMicroMatchRows: safeNumber(payload.selectedMicroMicroMatchRows, 0),
    selectedAlertMicroMicroMatches: safeNumber(payload.selectedAlertMicroMicroMatches, 0),

    activeSelectionRuntimeFiltered: Boolean(payload.activeSelectionRuntimeFiltered),
    activeSelectionRuntimeFilteredReason: payload.activeSelectionRuntimeFilteredReason || null,
    rejectedSelectedMicroMicroFamilyIds: cleanMicroMicroArray(payload.rejectedSelectedMicroMicroFamilyIds || []),
    rejectedSelectedMicroMicroRows: debug && Array.isArray(payload.rejectedSelectedMicroMicroRows)
      ? payload.rejectedSelectedMicroMicroRows.slice(0, MAX_DEBUG_ROWS)
      : [],
    rejectedSelectedMicroMicroCount: safeNumber(payload.rejectedSelectedMicroMicroCount, 0),
    activeRuntimeBlockedSelectionRows: safeNumber(payload.activeRuntimeBlockedSelectionRows, 0),

    openPositionCountBeforeEntries: payload.openPositionCountBeforeEntries ?? null,
    openPositionCountAfterEntries: payload.openPositionCountAfterEntries ?? null,

    actionCounts: {
      ...(payload.actionCounts || {}),
      ...countActionsByType(actions)
    },

    actionsCount: safeNumber(payload.actionsCount, actions.length),
    rawActionsCount: actions.length,
    rawExitRowsCount: rawExitRows.length,

    activeRotationId: payload.activeRotationId || null,
    selectedRotationId: payload.selectedRotationId || payload.activeRotationId || null,

    activeMicroFamilyIds: cleanShortArray(
      payload.activeMicroFamilyIds ||
        payload.selectedMicroFamilyIds ||
        payload.trueMicroFamilyIds ||
        payload.microFamilyIds ||
        []
    ),

    selectedMicroFamilyIds: cleanShortArray(
      payload.selectedMicroFamilyIds ||
        payload.activeMicroFamilyIds ||
        payload.trueMicroFamilyIds ||
        payload.microFamilyIds ||
        []
    ),

    activeMicroMicroFamilyIds: cleanMicroMicroArray(
      payload.activeMicroMicroFamilyIds ||
        payload.selectedMicroMicroFamilyIds ||
        payload.trueMicroMicroFamilyIds ||
        payload.microMicroFamilyIds ||
        []
    ),

    selectedMicroMicroFamilyIds: cleanMicroMicroArray(
      payload.selectedMicroMicroFamilyIds ||
        payload.activeMicroMicroFamilyIds ||
        payload.trueMicroMicroFamilyIds ||
        payload.microMicroFamilyIds ||
        []
    ),

    configuredSelectedMicroMicroFamilyIds: cleanMicroMicroArray(payload.configuredSelectedMicroMicroFamilyIds || []),

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
    activeMicroMicroFamilies: safeNumber(payload.activeMicroMicroFamilies, 0),

    marketContext: compactMarketContext(payload.marketContext),
    currentMarketWeather: compactMarketWeather(payload.currentMarketWeather),
    currentMarketUniverse: null,

    qualityAudit: payload.qualityAudit
      ? {
          profile: payload.qualityAudit.profile || null,
          primaryBottleneck: payload.qualityAudit.primaryBottleneck || null,
          pipelineCounts: payload.qualityAudit.pipelineCounts || null,
          conversionRatesPct: payload.qualityAudit.conversionRatesPct || null,
          topWaitReasons: Array.isArray(payload.qualityAudit.topWaitReasons)
            ? payload.qualityAudit.topWaitReasons.slice(0, 20)
            : [],
          weakContraEntryGateVersion:
            payload.qualityAudit.weakContraEntryGateVersion ||
            payload.weakContraEntryGateVersion ||
            WEAK_CONTRA_ENTRY_GATE_VERSION,
          microMicroRuntimeGateVersion:
            payload.qualityAudit.microMicroRuntimeGateVersion ||
            payload.microMicroRuntimeGateVersion ||
            MICRO_MICRO_RUNTIME_GATE_VERSION,
          discordActivationGateVersion:
            payload.qualityAudit.discordActivationGateVersion ||
            payload.discordActivationGateVersion ||
            DISCORD_ACTIVATION_GATE_VERSION
        }
      : null,

    runtimeWarnings: Array.isArray(payload.runtimeWarnings)
      ? payload.runtimeWarnings.slice(0, 50)
      : [],

    monitorOpenPositions: payload.monitorOpenPositions ?? true,
    monitorOpenPositionsFirst: payload.monitorOpenPositionsFirst ?? true,
    processScannerSnapshot: payload.processScannerSnapshot ?? true,

    monitorTimeoutMs: payload.monitorTimeoutMs || null,
    maxRuntimeMs: payload.maxRuntimeMs || null,

    entryRowsList: debug ? compactRows(rawEntryRows) : [],
    waitRowsList: debug ? compactRows(rawWaitRows) : [],
    virtualCreatedRowsList: debug ? compactRows(rawEntryRows) : [],
    virtualExits: debug ? compactRows(rawExitRows) : [],
    shadowExits: debug ? compactRows(rawExitRows) : [],
    exits: debug ? compactRows(rawExitRows) : [],

    ...baseFlags(),

    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };
}

function responseCountsFromPayload(payload = {}) {
  return {
    candidates: safeNumber(payload.candidates || payload.candidatesCount, 0),
    shortCandidateCount: safeNumber(payload.shortCandidateCount || payload.shortCandidatesCount, 0),
    nonShortCandidateCount: safeNumber(payload.nonShortCandidateCount, 0),

    processed: safeNumber(payload.processed, 0),
    earlyActions: safeNumber(payload.earlyActions, 0),

    liveRows: safeNumber(payload.liveRows, 0),
    analyzeInputRows: safeNumber(payload.analyzeInputRows, 0),
    actualLiveRows: safeNumber(payload.actualLiveRows, 0),

    observationOnlyRows: safeNumber(payload.observationOnlyRows, 0),
    learningOnlyRows: safeNumber(payload.learningOnlyRows, 0),

    riskValidRows: safeNumber(payload.riskValidRows || payload.analyzedRiskValidRows, 0),
    analyzedRowsRaw: safeNumber(payload.analyzedRowsRaw, 0),
    analyzedRows: safeNumber(payload.analyzedRows, 0),
    analyzedRiskValidRows: safeNumber(payload.analyzedRiskValidRows, 0),
    analyzedExact75Rows: safeNumber(payload.analyzedExact75Rows, 0),
    analyzedMicroMicroRows: safeNumber(payload.analyzedMicroMicroRows, 0),
    fallbackExact75Rows: safeNumber(payload.fallbackExact75Rows, 0),

    weakContraRejectedRows: safeNumber(payload.weakContraRejectedRows, 0),
    weakContraAllowedRows: safeNumber(payload.weakContraAllowedRows, 0),

    entryRows: safeNumber(payload.entryRows, 0),
    waitRows: safeNumber(payload.waitRows, 0),

    virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualOpenedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(payload.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows, 0),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows, 0),

    virtualExits: safeNumber(payload.virtualExitRows, 0),
    virtualExitRows: safeNumber(payload.virtualExitRows, 0),
    shadowExits: safeNumber(payload.shadowExitRows, 0),
    shadowExitRows: safeNumber(payload.shadowExitRows, 0),
    realExits: 0,
    realExitRows: 0,

    actions: safeNumber(payload.actionsCount, 0),
    shortActions: safeNumber(payload.actionsCount, 0),

    entries: safeNumber(payload.entryRows, 0),
    waits: safeNumber(payload.waitRows, 0),
    observations: safeNumber(payload.observationOnlyRows, 0),

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
    activeMicroMicroFamilies: safeNumber(payload.activeMicroMicroFamilies, 0),

    discordEligibleEntries: safeNumber(payload.discordAlertEligibleRows, 0),
    discordSkippedNotSelected: safeNumber(payload.discordAlertsSkippedNoSelectedMicro, 0),
    discordSkippedCurrentFit: safeNumber(payload.discordAlertsSkippedCurrentFit, 0),
    discordSkippedRuntimeGate: safeNumber(payload.discordAlertsSkippedRuntimeGate, 0),
    discordRuntimeGateBlockedRows: safeNumber(payload.discordRuntimeGateBlockedRows, 0),

    activeSelectionRuntimeFiltered: Boolean(payload.activeSelectionRuntimeFiltered),
    activeRuntimeBlockedSelectionRows: safeNumber(payload.activeRuntimeBlockedSelectionRows, 0),
    rejectedSelectedMicroMicroCount: safeNumber(payload.rejectedSelectedMicroMicroCount, 0),

    scannerSnapshotPreserved: true,
    microFamiliesAppendOnly: true
  };
}

async function readLatestSnapshotInfo() {
  if (!CORE?.redis) {
    return {
      snapshotId: null,
      source: null,
      createdAt: null,
      selectedTargetCandidateCount: 0
    };
  }

  const { getDurableRedis, getVolatileRedis, getJson } = CORE.redis;
  const shortKeys = getKeys();

  let volatileRedis = null;
  let durableRedis = null;

  try {
    volatileRedis = getVolatileRedis();
  } catch {
    volatileRedis = null;
  }

  try {
    durableRedis = getDurableRedis();
  } catch {
    durableRedis = null;
  }

  const latest =
    await getJson(volatileRedis, shortKeys.scan.latest, null).catch(() => null) ||
    await getJson(durableRedis, shortKeys.scan.latest, null).catch(() => null);

  if (!latest) {
    return {
      snapshotId: null,
      source: null,
      createdAt: null,
      selectedTargetCandidateCount: 0
    };
  }

  if (typeof latest === 'string') {
    return {
      snapshotId: latest,
      source: 'SHORT:SCAN:LATEST_ID',
      createdAt: null,
      selectedTargetCandidateCount: 0
    };
  }

  return {
    snapshotId: latest.snapshotId || latest.id || latest.latestSnapshotId || latest.scanId || null,
    source: Array.isArray(latest.candidates)
      ? 'SHORT:SCAN:LATEST_FULL_SNAPSHOT'
      : 'SHORT:SCAN:LATEST_POINTER',
    createdAt: latest.createdAt || latest.completedAt || latest.ts || null,
    selectedTargetCandidateCount: Array.isArray(latest.candidates)
      ? latest.candidates.length
      : safeNumber(latest.candidatesCount, 0)
  };
}

async function readLastProcessedSnapshotInfo() {
  if (!CORE?.redis) return null;

  const { getDurableRedis, getJson } = CORE.redis;
  const shortKeys = getKeys();

  let durableRedis = null;

  try {
    durableRedis = getDurableRedis();
  } catch {
    durableRedis = null;
  }

  const value = await getJson(durableRedis, shortKeys.trade.lastProcessedSnapshot, null).catch(() => null);

  if (!value) return null;

  if (typeof value === 'string') {
    return {
      snapshotId: value
    };
  }

  return {
    snapshotId: value.snapshotId || value.id || value.latestSnapshotId || null,
    runId: value.runId || null,
    processedAt: value.processedAt || null,
    analyzedRows: safeNumber(value.analyzedRows, 0),
    analyzedMicroMicroRows: safeNumber(value.analyzedMicroMicroRows, 0),
    weakContraRejectedRows: safeNumber(value.weakContraRejectedRows, 0),
    virtualCreatedRows: safeNumber(value.virtualCreatedRows, 0),
    waitRows: safeNumber(value.waitRows, 0),
    reason: value.reason || null
  };
}

async function determineSnapshotInfo(req, body = {}) {
  const latest = await readLatestSnapshotInfo();
  const lastProcessed = await readLastProcessedSnapshotInfo();

  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const requestedMonitorOnly = shouldMonitorOnly(req, body);

  const snapshotAlreadyProcessed =
    Boolean(latest.snapshotId) &&
    Boolean(lastProcessed?.snapshotId) &&
    latest.snapshotId === lastProcessed.snapshotId;

  return {
    latestSnapshotId: latest.snapshotId,
    latestSnapshotSource: latest.source,
    latestSnapshotCreatedAt: latest.createdAt,
    latestSelectedTargetCandidateCount: latest.selectedTargetCandidateCount,
    lastProcessedSnapshotId: lastProcessed?.snapshotId || null,
    lastProcessed,
    forceProcessSnapshot,
    requestedMonitorOnly,
    snapshotAlreadyProcessed,

    routeForcesMonitorOnlyBecauseSameSnapshot: false,
    effectiveMonitorOnly: requestedMonitorOnly,
    effectiveProcessScannerSnapshot: !requestedMonitorOnly,

    reason: snapshotAlreadyProcessed && !forceProcessSnapshot
      ? 'SAME_SNAPSHOT_SEEN_ROUTE_DOES_NOT_FORCE_MONITOR_ONLY_TRADE_SYSTEM_DECIDES'
      : null
  };
}

function buildRunOptions(req, body = {}, overrides = {}) {
  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const monitorOnly = Boolean(overrides.monitorOnly ?? shouldMonitorOnly(req, body));
  const processScannerSnapshot = overrides.processScannerSnapshot ?? !monitorOnly;
  const phase = overrides.phase || (monitorOnly ? 'MONITOR_ONLY' : 'TRADE_MAIN');

  const monitorTimeoutMs = getMonitorTimeoutMs(req, body, monitorOnly);
  const maxRuntimeMs = getMaxRuntimeMs(req, body, monitorOnly);
  const monitorBatchSize = getMonitorBatchSize(req, body);
  const openPositionMonitorLimit = getOpenPositionMonitorLimit(req, body);

  const maxCandidatesPerSnapshot = monitorOnly
    ? 0
    : getMaxCandidatesPerSnapshot(req, body);

  const shortKeys = getKeys();

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    runPhase: phase,
    tradeRunPhase: phase,

    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,
    processOpenPositions: true,
    closeVirtualPositions: true,
    closeShadowPositions: true,
    closeOpenPositions: true,

    monitorOpenPositionsHardFirst: true,
    monitorOpenPositionsBeforeEntries: true,
    forceMonitorOpenPositions: true,
    exitSweepBeforeEntryGate: true,
    closeVirtualPositionsBeforeEntries: true,
    closeShadowPositionsBeforeEntries: true,
    newEntriesBlockedUntilMonitorAttempted: true,

    processScannerSnapshot,

    monitorOnlyDoesNotProcessScannerSnapshot: monitorOnly,
    skipScannerSnapshotWhenMonitorOnly: monitorOnly,
    allowExitProcessingWithoutScannerSnapshot: true,
    allowTimeStopExitWithoutScannerSnapshot: true,
    allowTpSlExitWithoutScannerSnapshot: true,

    snapshotAlreadyProcessedDoesNotBlockMonitor: true,
    sameSnapshotRunsMonitorOnly: false,
    routeDoesNotForceMonitorOnlyOnSameSnapshot: true,
    sameSnapshotReprocessDecisionIsInsideTradeSystem: true,

    monitorTimeoutMs,
    openPositionMonitorTimeoutMs: monitorTimeoutMs,
    closeVirtualPositionsTimeoutMs: monitorTimeoutMs,
    closeShadowPositionsTimeoutMs: monitorTimeoutMs,
    positionMonitorTimeoutMs: monitorTimeoutMs,
    monitorPriceFetchTimeoutMs: 400,
    monitorLivePriceFetchEnabled: false,
    monitorPriceSource: 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',

    candidateTimeoutMs: 3500,
    analyzeTimeoutMs: 6000,
    marketContextTimeoutMs: 1200,
    rotationTimeoutMs: 1200,
    maxRuntimeMs,

    monitorBatchSize,
    openPositionMonitorLimit,
    maxOpenPositionsToMonitor: openPositionMonitorLimit,

    maxCandidatesPerSnapshot,
    analyzeMaxCandidatesPerSnapshot: maxCandidatesPerSnapshot,
    hardMaxCandidatesPerSnapshot: maxCandidatesPerSnapshot,

    compactForVercelRuntime: true,
    compactRedisPayloads: true,
    compactRunMeta: true,
    compactLastProcessedSnapshot: true,
    persistCompactLastProcessedSnapshot: true,
    skipFullLastProcessedSnapshotPayload: true,
    omitLargeMarketWeatherRows: true,
    omitMarketContextRows: true,
    omitMarketUniverseRows: true,
    omitActionMarketContext: true,
    omitCurrentMarketWeatherRows: true,
    responseCompaction: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    shadowOnly: false,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: true,
    microFamilyLearning: true,
    observationFirst: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintOnlyMetadata: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',

    exactTrueMicroFamilyRequired: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroRuntimeGateEmbeddedInExistingFiles: true,
    microMicroRuntimeGateRequired: true,
    microMicroRuntimeGateStates: ['OBSERVING', 'PASSED', 'REJECTED', 'POLICY_BLOCKED'],
    microMicroRuntimeGateRule:
      'OBSERVING may learn virtual; PASSED can Discord; REJECTED/POLICY_BLOCKED no new virtual entry and no Discord',
    observingCanVirtualLearn: true,
    observingCanDiscord: false,
    passedCanVirtualLearn: true,
    passedCanDiscord: true,
    rejectedCanVirtualLearn: false,
    rejectedCanDiscord: false,
    policyBlockedCanVirtualLearn: false,
    policyBlockedCanDiscord: false,

    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordRuntimeGateRequired: true,
    discordRuntimeNeverTrustsActiveSelectionBlindly: true,
    discordRequiresPassedMicroMicroRuntimeGate: true,

    exitAlertRuntimeGateRequired: true,
    exitAlertRuntimeGateVersion: EXIT_ALERT_RUNTIME_GATE_VERSION,
    exitAlertRequiresRuntimeGateApproved: true,

    riskPlanVersion: RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejectedBlocksVirtualEntry: true,
    weakContraRejectedBlocksLearning: false,

    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    ignoreGlobalMaxOpenPositions: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMin: getPositionTimeStopMin(),

    shortRiskShape: {
      entryPositive: true,
      tpBelowEntry: true,
      slAboveEntry: true,
      expression: 'tp < entry < sl'
    },

    shortExitRules: {
      validRiskShape: 'entry > 0 && tp < entry && sl > entry',
      tp: 'currentPrice <= tp',
      sl: 'currentPrice >= sl',
      timeStop: `age >= ${getPositionTimeStopMin()} minutes`,
      tpSlIndependentFromTimeStop: true,
      grossR: '(entry - exitPrice) / (initialSl - entry)',
      currentR: '(entry - currentPrice) / (initialSl - entry)',
      outcomeSource: 'VIRTUAL'
    },

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscord: true,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    macroMatchDoesNotTriggerDiscord: true,
    parentMacroMatchDoesNotTriggerDiscord: true,
    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,
    scannerMatchTriggersDiscord: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekKey: PERSISTENT_LEARNING_KEY,

    keys: {
      scannerLatest: shortKeys.scan.latest,
      tradeLock: shortKeys.trade.lock,
      tradeRunMeta: shortKeys.trade.runMeta,
      tradeLastProcessedSnapshot: shortKeys.trade.lastProcessedSnapshot,
      tradeLastError: shortKeys.trade.lastError,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: MARKET_WEATHER_KEY
    },

    scannerPreloadBeforeTrade: false,
    marketWeatherPreloadBeforeTrade: false,

    scannerRunAllowed: false,
    scannerRunDisabledInsideTradeSystem: true,
    preventScannerRun: true,
    doNotRunScanner: true,
    noInternalScannerRun: true,
    scannerLatestReadOnly: true,
    readScannerLatestOnly: true,

    allowTradeWrite: true,
    allowAnalyzePartialWrite: true,
    allowScannerWrite: false,
    allowRotationWrite: false,
    allowDiscordSelectionWrite: false,

    analyzePartialOnly: true,
    microFamiliesAppendOnly: true,
    analyzeFullOverwriteDisabled: true,
    microFamiliesAntiWipe: true,

    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    debugSafeDynamicImports: true,
    importErrorsReturnedAsJson: true,
    caughtRuntimeErrorsReturnHttp200: ERROR_HTTP_200_FOR_CAUGHT_RUNTIME_ERRORS,

    ...overrides
  };
}

function buildMonitorPreflightOptions(req, body = {}) {
  return buildRunOptions(req, body, {
    monitorOnly: true,
    processScannerSnapshot: false,
    phase: 'MONITOR_PREFLIGHT'
  });
}

function buildMainTradeOptions(req, body = {}) {
  const requestedMonitorOnly = shouldMonitorOnly(req, body);

  return buildRunOptions(req, body, {
    monitorOnly: requestedMonitorOnly,
    processScannerSnapshot: !requestedMonitorOnly,
    phase: requestedMonitorOnly ? 'MONITOR_ONLY_REQUEST' : 'TRADE_MAIN'
  });
}

async function persistShortRunMeta(redis, payload = {}, snapshotInfo = null) {
  if (!CORE?.redis?.setJson || !redis) {
    return {
      persistedShortRunMeta: false,
      persistedShortLastProcessedSnapshot: false,
      reason: 'CORE_OR_REDIS_NOT_AVAILABLE'
    };
  }

  const { setJson } = CORE.redis;
  const shortKeys = getKeys();

  const runMeta = {
    ...payload,

    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    exits: [],
    realExits: [],

    marketContext: compactMarketContext(payload.marketContext),
    currentMarketWeather: compactMarketWeather(payload.currentMarketWeather),
    currentMarketUniverse: null,

    ...baseFlags(),

    snapshotInfo,

    persistedAt: now(),
    persistedBy: 'api/trade/run.js',
    persistedNamespace: SHORT_NAMESPACE,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      tradeRunMeta: shortKeys.trade.runMeta,
      tradeLastProcessedSnapshot: shortKeys.trade.lastProcessedSnapshot,
      tradeLastError: shortKeys.trade.lastError,
      scannerLatest: shortKeys.scan.latest,
      tradeLock: shortKeys.trade.lock,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY
    },

    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };

  const persistence = {
    persistedShortRunMeta: false,
    persistedShortLastProcessedSnapshot: false,
    tradeRunMeta: shortKeys.trade.runMeta,
    tradeLastProcessedSnapshot: shortKeys.trade.lastProcessedSnapshot,
    tradeLastError: shortKeys.trade.lastError,
    compactedForVercelRuntime: true,
    warnings: []
  };

  await setJson(redis, shortKeys.trade.runMeta, runMeta)
    .then(() => {
      persistence.persistedShortRunMeta = true;
    })
    .catch((error) => {
      persistence.warnings.push(`RUN_META_PERSIST_FAILED:${compactError(error)}`);
    });

  if (payload.shouldMarkSnapshotProcessed && payload.snapshotId) {
    await setJson(
      redis,
      shortKeys.trade.lastProcessedSnapshot,
      {
        snapshotId: payload.snapshotId,
        runId: payload.runId || null,
        processedAt: now(),
        processScannerSnapshot: true,
        analyzedRows: safeNumber(payload.analyzedRows, 0),
        analyzedMicroMicroRows: safeNumber(payload.analyzedMicroMicroRows, 0),
        weakContraRejectedRows: safeNumber(payload.weakContraRejectedRows, 0),
        weakContraAllowedRows: safeNumber(payload.weakContraAllowedRows, 0),
        virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),
        waitRows: safeNumber(payload.waitRows, 0),
        reason: payload.reason || null,
        routePersistedBecauseTradeSystemMarkedProcessed: true,
        snapshotInfo,
        ...baseFlags(),
        compactedForVercelRuntime: true
      }
    )
      .then(() => {
        persistence.persistedShortLastProcessedSnapshot = true;
      })
      .catch((error) => {
        persistence.warnings.push(`LAST_PROCESSED_PERSIST_FAILED:${compactError(error)}`);
      });
  }

  return persistence;
}

function errorPayload(error, extra = {}) {
  return {
    ok: false,
    reason: 'TRADE_SYSTEM_ERROR_LOCK_RELEASED',
    error: compactError(error),
    errorName: error?.name || 'Error',
    errorCode: error?.code || null,
    errorReason: error?.reason || null,
    availableExports: error?.availableExports || null,
    expectedExport: error?.expectedExport || null,
    stack: compactStack(error),
    cause: error?.cause
      ? {
          name: error.cause?.name || 'Error',
          message: compactError(error.cause),
          stack: compactStack(error.cause)
        }
      : null,
    lock: error?.lock || null,
    lockRelease: error?.lockRelease || null,
    ...baseFlags(),
    ...extra
  };
}

async function writeFailureRunMeta(redis, error, extra = {}) {
  if (!CORE?.redis?.setJson || !redis) {
    return {
      persisted: false,
      reason: 'CORE_OR_REDIS_NOT_AVAILABLE'
    };
  }

  const { setJson } = CORE.redis;
  const shortKeys = getKeys();

  const payload = {
    ...errorPayload(error, extra),
    compactedForVercelRuntime: true,
    persistedAt: now(),
    persistedBy: 'api/trade/run.js'
  };

  const compactRunMeta = {
    ...payload,
    stack: null,
    cause: payload.cause
      ? {
          name: payload.cause.name,
          message: payload.cause.message,
          stack: null
        }
      : null
  };

  await setJson(redis, shortKeys.trade.runMeta, compactRunMeta).catch(() => null);
  await setJson(redis, shortKeys.trade.lastError, payload).catch(() => null);

  return {
    ...compactRunMeta,
    lastErrorKey: shortKeys.trade.lastError,
    fullErrorPersistedToLastErrorKey: true
  };
}

function buildLockSkippedResponse({
  req,
  body = {},
  startedAt,
  lockKey,
  lockTtlSec,
  staleLockAfterSec,
  rawResult = null,
  debug = false
}) {
  const reason = 'TRADE_RUN_LOCK_ACTIVE';

  return {
    ok: true,
    tradeOk: true,

    skipped: true,
    skippedNewEntries: true,
    reason,
    skipReason: reason,
    message:
      'Trade run overgeslagen: vorige SHORT trade-run is nog actief. Gebruik forceProcessSnapshot=true of forceUnlock=true om handmatig te forceren.',

    statusWas409Before: true,
    httpStatusPolicy: 'LOCK_CONFLICT_RETURNS_200_SKIPPED',

    ...baseFlags(),

    runSource: getRunSource(req, body),

    lock: {
      key: lockKey,
      ttlSec: lockTtlSec,
      staleLockAfterSec,
      active: true,
      reason,
      state: debug ? rawResult?.lock?.state || rawResult?.state || null : undefined
    },

    runId: null,
    snapshotId: null,

    entryRows: 0,
    waitRows: 0,
    virtualCreatedRows: 0,
    virtualExitRows: 0,
    shadowExitRows: 0,

    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    realExits: [],

    actionCounts: {},
    counts: {
      candidates: 0,
      processed: 0,
      entries: 0,
      waits: 0,
      observations: 0,
      virtualExits: 0,
      virtualExitRows: 0,
      shadowExits: 0,
      shadowExitRows: 0,
      realExits: 0,
      realExitRows: 0
    },

    activeMicroFamilyIds: [],
    activeMicroMicroFamilyIds: [],
    selectedMicroFamilyIds: [],
    selectedMicroMicroFamilyIds: [],

    scannerLatestPreserved: true,
    scannerSnapshotPreserved: true,
    scannerHistoryPreserved: true,

    rotationPreserved: true,
    manualSelectionPreserved: true,
    discordSelectionPreserved: true,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      scanLatest: getKeys().scan.latest,
      tradeLock: getKeys().trade.lock,
      tradeRunMeta: getKeys().trade.runMeta,
      tradeLastProcessedSnapshot: getKeys().trade.lastProcessedSnapshot,
      tradeLastError: getKeys().trade.lastError,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY
    },

    warnings: [
      'TRADE_RUN_SKIPPED_BECAUSE_LOCK_ACTIVE',
      'NO_ERROR_FOR_CRON',
      'LOCK_HAS_SHORT_TTL_AND_CAN_BE_FORCE_CLEARED'
    ],

    rawLockResult: debug ? rawResult || undefined : undefined,

    durationMs: now() - startedAt,
    completedAt: now()
  };
}

function responseStatusForError(error) {
  const statusCode = Number(error?.statusCode);

  if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }

  return ERROR_HTTP_200_FOR_CAUGHT_RUNTIME_ERRORS ? 200 : 500;
}

function errorResponse({
  error,
  phase,
  startedAt,
  debug,
  lockKey = null,
  lockReleasedAfterError = false,
  failureMeta = null,
  httpStatus = 200
}) {
  return {
    ok: false,
    tradeOk: false,

    phase,
    reason: 'TRADE_RUN_FAILED_CRASH_SAFE',
    skipReason: null,

    errorName: error?.name || 'Error',
    errorMessage: compactError(error),
    errorCode: error?.code || null,
    errorReason: error?.reason || null,
    expectedExport: error?.expectedExport || null,
    availableExports: error?.availableExports || null,

    errorStack: debug ? compactStack(error) : null,
    debugHint: debug
      ? 'errorStack is zichtbaar omdat debug=true is gebruikt.'
      : 'Gebruik /api/trade/run?debug=true&force=true om errorStack te zien.',

    ...baseFlags(),

    httpStatus,
    httpStatusPolicy: ERROR_HTTP_200_FOR_CAUGHT_RUNTIME_ERRORS
      ? 'CAUGHT_RUNTIME_ERRORS_RETURN_HTTP_200_WITH_OK_FALSE_TO_KEEP_CRON_ALIVE'
      : 'CAUGHT_RUNTIME_ERRORS_RETURN_HTTP_500',

    lastErrorKey: LAST_ERROR_KEY,
    fullErrorPersistedToLastErrorKey: Boolean(failureMeta?.fullErrorPersistedToLastErrorKey),

    lock: lockKey
      ? {
          key: lockKey,
          releasedAfterError: lockReleasedAfterError,
          mode: lockReleasedAfterError
            ? 'EMERGENCY_UNLOCK_ON_ERROR'
            : 'NO_LOCK_RELEASE_NEEDED'
        }
      : null,

    shortPersistence: failureMeta
      ? {
          persistedShortRunMeta: true,
          lastErrorKey: failureMeta.lastErrorKey || LAST_ERROR_KEY,
          failureMeta: debug
            ? failureMeta
            : {
                ok: failureMeta.ok,
                reason: failureMeta.reason,
                error: failureMeta.error,
                phase: failureMeta.phase || phase,
                lastErrorKey: failureMeta.lastErrorKey || LAST_ERROR_KEY
              }
        }
      : null,

    durationMs: now() - startedAt,
    completedAt: now(),
    debug
  };
}

async function runTradeSystemSafe(req, body, debug) {
  const { runTradeSystem } = await loadTradeSystemModule();

  const requestedMonitorOnly = shouldMonitorOnly(req, body);
  const monitorPreflightEnabled = !requestedMonitorOnly && shouldRunMonitorPreflight(req, body);

  let rawMonitorPreflight = null;

  if (monitorPreflightEnabled) {
    try {
      rawMonitorPreflight = await runTradeSystem({
        ...buildMonitorPreflightOptions(req, body),
        monitorPreflight: true,
        preflightRun: true
      });
    } catch (error) {
      rawMonitorPreflight = {
        ok: false,
        runPhase: 'MONITOR_PREFLIGHT',
        monitorOnly: true,
        processScannerSnapshot: false,
        error: compactError(error),
        errorName: error?.name || 'Error',
        errorStack: debug ? compactStack(error) : null,
        durationMs: null,
        virtualExitRows: 0,
        shadowExitRows: 0,
        runtimeWarnings: [
          'MONITOR_PREFLIGHT_FAILED',
          compactError(error)
        ]
      };
    }
  }

  const mainRunOptions = buildMainTradeOptions(req, body);

  const rawMain = await runTradeSystem({
    ...mainRunOptions,
    scannerPreloadBeforeTrade: false,
    marketWeatherPreloadBeforeTrade: false,
    scannerPreloadOk: true,
    marketWeatherMirroredToDurable: false,
    marketUniverseMirroredToDurable: false,
    monitorPreflightEnabled,
    monitorPreflightCompleted: Boolean(rawMonitorPreflight),
    monitorPreflightOk: rawMonitorPreflight
      ? unwrapRunResult(rawMonitorPreflight)?.ok !== false
      : null,
    monitorPreflightVirtualExitRows: safeNumber(unwrapRunResult(rawMonitorPreflight)?.virtualExitRows, 0),
    monitorPreflightShadowExitRows: safeNumber(unwrapRunResult(rawMonitorPreflight)?.shadowExitRows, 0),
    routeDoesNotForceMonitorOnlyOnSameSnapshot: true,

    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroVersion: MICRO_MICRO_VERSION,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroRuntimeGateRequired: true,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,

    discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
    discordActivationRequiresNetEdge: true,
    discordRuntimeGateRequired: true,
    discordRuntimeNeverTrustsActiveSelectionBlindly: true,

    exitAlertRuntimeGateRequired: true,
    exitAlertRuntimeGateVersion: EXIT_ALERT_RUNTIME_GATE_VERSION
  });

  return {
    rawMain,
    rawMonitorPreflight,
    mainRunOptions,
    monitorPreflightEnabled
  };
}

export default async function handler(req, res) {
  setHeaders(res);

  const startedAt = now();

  let body = {};
  let debug = false;
  let phase = 'START';

  let durableRedis = null;
  let shortKeys = buildShortKeys({});
  let lockKey = null;

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    phase = 'READ_BODY';
    body = await readBody(req);
    debug = shouldDebug(req, body);

    phase = 'LOAD_CORE_MODULES';
    await loadCoreModules();

    const { getDurableRedis } = CORE.redis;

    phase = 'GET_DURABLE_REDIS';
    durableRedis = getDurableRedis();

    shortKeys = getKeys();
    lockKey = shortKeys.trade.lock;

    const forceUnlock = shouldForceUnlock(req, body);
    const lockTtlSec = getLockTtlSec(req, body);
    const staleLockAfterSec = getStaleLockAfterSec(req, body);
    const runSource = getRunSource(req, body);

    if (shouldUnlockOnly(req, body)) {
      phase = 'UNLOCK_ONLY';

      const stateBefore = await readLockState(durableRedis, lockKey);
      const released = await redisDel(durableRedis, lockKey);

      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'UNLOCK_ONLY',
        skipReason: 'UNLOCK_ONLY',
        message: 'SHORT trade lock handmatig vrijgegeven.',
        ...baseFlags(),
        lock: {
          key: lockKey,
          released,
          stateBefore: debug ? stateBefore : undefined
        },
        durationMs: now() - startedAt,
        completedAt: now()
      });
    }

    phase = 'READ_SNAPSHOT_INFO';
    const snapshotInfo = await determineSnapshotInfo(req, body);

    phase = 'ACQUIRE_TRADE_LOCK_AND_RUN';
    const rawResult = await runWithTradeLock({
      redis: durableRedis,
      lockKey,
      lockTtlSec,
      staleLockAfterSec,
      forceUnlock,
      runSource,
      fn: async () => {
        phase = 'DYNAMIC_IMPORT_AND_RUN_TRADE_SYSTEM';
        const result = await runTradeSystemSafe(req, body, debug);

        return {
          ok: unwrapRunResult(result.rawMain)?.ok !== false,
          result
        };
      }
    });

    if (rawResult?.skipped && rawResult?.reason === 'TRADE_RUN_LOCK_ACTIVE') {
      return res.status(200).json(buildLockSkippedResponse({
        req,
        body,
        startedAt,
        lockKey,
        lockTtlSec,
        staleLockAfterSec,
        rawResult,
        debug
      }));
    }

    phase = 'SANITIZE_RESPONSE';

    const wrapper = unwrapRunResult(rawResult);
    const rawMain = wrapper?.rawMain || rawResult?.result?.rawMain || null;
    const rawMonitorPreflight = wrapper?.rawMonitorPreflight || rawResult?.result?.rawMonitorPreflight || null;
    const mainRunOptions = wrapper?.mainRunOptions || rawResult?.result?.mainRunOptions || buildMainTradeOptions(req, body);
    const monitorPreflightEnabled = Boolean(wrapper?.monitorPreflightEnabled || rawResult?.result?.monitorPreflightEnabled);

    const payload = compactRunPayload(unwrapRunResult(rawMain), { debug });
    const monitorPreflightPayload = rawMonitorPreflight
      ? compactRunPayload(unwrapRunResult(rawMonitorPreflight), { debug })
      : null;

    phase = 'PERSIST_SHORT_RUN_META';

    const persistence = await persistShortRunMeta(
      durableRedis,
      payload,
      snapshotInfo
    );

    const counts = responseCountsFromPayload(payload);
    const tradeOk = payload.ok !== false;

    const monitorPreflightOk = monitorPreflightPayload
      ? monitorPreflightPayload.ok !== false
      : null;

    const effectiveReason =
      monitorPreflightOk === false
        ? 'MONITOR_PREFLIGHT_FAILED'
        : payload.reason || payload.skipReason || null;

    phase = 'SEND_SUCCESS_RESPONSE';

    return res.status(200).json({
      ok: tradeOk && monitorPreflightOk !== false,
      tradeOk,

      scannerPreloadOk: true,
      scannerPreloadSkipped: true,
      scannerPreloadEnabled: false,

      monitorPreflightEnabled,
      monitorPreflightOk,
      monitorPreflight: monitorPreflightPayload
        ? {
            ok: monitorPreflightPayload.ok,
            runId: monitorPreflightPayload.runId,
            runPhase: monitorPreflightPayload.runPhase,
            monitorOnly: true,
            processScannerSnapshot: false,
            virtualExitRows: safeNumber(monitorPreflightPayload.virtualExitRows, 0),
            shadowExitRows: safeNumber(monitorPreflightPayload.shadowExitRows, 0),
            reason: monitorPreflightPayload.reason || monitorPreflightPayload.skipReason || null,
            durationMs: monitorPreflightPayload.durationMs || null
          }
        : null,

      skipped: Boolean(payload.skipped),
      skippedNewEntries: Boolean(payload.skippedNewEntries),
      reason: effectiveReason,
      skipReason: payload.skipReason || effectiveReason,

      ...baseFlags(),

      runSource,
      forceUnlock,
      lockTtlSec,
      staleLockAfterSec,

      lock: {
        key: lockKey,
        ttlSec: lockTtlSec,
        staleLockAfterSec,
        forceUnlock,
        acquired: rawResult?.lock?.acquired === true,
        forceClearedBeforeAcquire: Boolean(rawResult?.lock?.forceClearedBeforeAcquire),
        staleClearedBeforeAcquire: Boolean(rawResult?.lock?.staleClearedBeforeAcquire),
        released: rawResult?.lockRelease?.released === true,
        releaseReason: rawResult?.lockRelease?.reason || null,
        mode: 'STALE_SAFE_LOCK_RELEASED_IN_FINALLY'
      },

      snapshotInfo: {
        ...snapshotInfo,
        routeDoesNotForceMonitorOnlyOnSameSnapshot: true,
        tradeSystemControlsSameSnapshotReprocess: true
      },

      force: mainRunOptions?.force ?? shouldForceProcessSnapshot(req, body),
      forceProcessSnapshot: mainRunOptions?.forceProcessSnapshot ?? shouldForceProcessSnapshot(req, body),
      monitorOnly: mainRunOptions?.monitorOnly ?? shouldMonitorOnly(req, body),
      monitorOpenPositionsFirst: mainRunOptions?.monitorOpenPositionsFirst ?? true,
      monitorOpenPositions: mainRunOptions?.monitorOpenPositions ?? true,
      processScannerSnapshot: mainRunOptions?.processScannerSnapshot ?? !shouldMonitorOnly(req, body),

      monitorTimeoutMs: mainRunOptions?.monitorTimeoutMs ?? getMonitorTimeoutMs(req, body, shouldMonitorOnly(req, body)),
      openPositionMonitorTimeoutMs: mainRunOptions?.openPositionMonitorTimeoutMs ?? getMonitorTimeoutMs(req, body, shouldMonitorOnly(req, body)),
      monitorBatchSize: mainRunOptions?.monitorBatchSize ?? getMonitorBatchSize(req, body),
      openPositionMonitorLimit: mainRunOptions?.openPositionMonitorLimit ?? getOpenPositionMonitorLimit(req, body),
      maxRuntimeMs: mainRunOptions?.maxRuntimeMs ?? getMaxRuntimeMs(req, body, shouldMonitorOnly(req, body)),
      maxCandidatesPerSnapshot: mainRunOptions?.maxCandidatesPerSnapshot ?? getMaxCandidatesPerSnapshot(req, body),
      hardMaxCandidatesPerSnapshot: mainRunOptions?.hardMaxCandidatesPerSnapshot ?? getMaxCandidatesPerSnapshot(req, body),

      scannerPreload: {
        ok: true,
        skipped: true,
        reason: 'SCANNER_PRELOAD_DISABLED_FOR_CRASH_SAFE_TRADE_RUN',
        durationMs: null,
        scanner: null,
        mirror: null
      },

      marketWeatherAvailableAfterRun: false,
      marketUniverseAvailableAfterRun: false,

      runId: payload.runId || null,
      snapshotId: payload.snapshotId || null,

      entryRows: safeNumber(payload.entryRows, 0),
      waitRows: safeNumber(payload.waitRows, 0),
      virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),

      weakContraRejectedRows: safeNumber(payload.weakContraRejectedRows, 0),
      weakContraAllowedRows: safeNumber(payload.weakContraAllowedRows, 0),
      weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,

      microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
      discordActivationGateVersion: DISCORD_ACTIVATION_GATE_VERSION,
      discordRuntimeGateRequired: true,
      discordRuntimeNeverTrustsActiveSelectionBlindly: true,

      discordAlertsSkippedRuntimeGate: safeNumber(payload.discordAlertsSkippedRuntimeGate, 0),
      discordRuntimeGateBlockedRows: safeNumber(payload.discordRuntimeGateBlockedRows, 0),

      activeSelectionRuntimeFiltered: Boolean(payload.activeSelectionRuntimeFiltered),
      activeSelectionRuntimeFilteredReason: payload.activeSelectionRuntimeFilteredReason || null,
      rejectedSelectedMicroMicroFamilyIds: payload.rejectedSelectedMicroMicroFamilyIds || [],
      rejectedSelectedMicroMicroCount: safeNumber(payload.rejectedSelectedMicroMicroCount, 0),
      activeRuntimeBlockedSelectionRows: safeNumber(payload.activeRuntimeBlockedSelectionRows, 0),
      configuredSelectedMicroMicroFamilyIds: payload.configuredSelectedMicroMicroFamilyIds || [],

      entryRowsList: debug && Array.isArray(payload.entryRowsList)
        ? payload.entryRowsList
        : [],

      waitRowsList: debug && Array.isArray(payload.waitRowsList)
        ? payload.waitRowsList
        : [],

      virtualCreatedRowsList: debug && Array.isArray(payload.virtualCreatedRowsList)
        ? payload.virtualCreatedRowsList
        : [],

      virtualExitRows: safeNumber(payload.virtualExitRows, 0),
      shadowExitRows: safeNumber(payload.shadowExitRows, 0),

      virtualExits: debug && Array.isArray(payload.virtualExits)
        ? payload.virtualExits
        : [],

      shadowExits: debug && Array.isArray(payload.shadowExits)
        ? payload.shadowExits
        : [],

      realExits: [],

      actionCounts: payload.actionCounts || {},
      counts,

      activeRotationId: payload.activeRotationId || null,
      selectedRotationId: payload.selectedRotationId || payload.activeRotationId || null,

      activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
      activeMicroMicroFamilies: safeNumber(payload.activeMicroMicroFamilies, 0),

      activeMicroFamilyIds: Array.isArray(payload.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds
        : [],

      selectedMicroFamilyIds: Array.isArray(payload.selectedMicroFamilyIds)
        ? payload.selectedMicroFamilyIds
        : [],

      activeMicroMicroFamilyIds: Array.isArray(payload.activeMicroMicroFamilyIds)
        ? payload.activeMicroMicroFamilyIds
        : [],

      selectedMicroMicroFamilyIds: Array.isArray(payload.selectedMicroMicroFamilyIds)
        ? payload.selectedMicroMicroFamilyIds
        : [],

      selectedSnapshotSource: payload.selectedSnapshotSource || snapshotInfo?.latestSnapshotSource || null,
      selectedSnapshotReason: payload.selectedSnapshotReason || null,
      selectedTargetCandidateCount: safeNumber(
        payload.selectedTargetCandidateCount,
        snapshotInfo?.latestSelectedTargetCandidateCount || 0
      ),
      selectedOppositeCandidateCount: 0,

      scannerPreloadBeforeTrade: false,
      scannerLatestPreserved: true,
      scannerSnapshotPreserved: true,
      scannerHistoryPreserved: true,
      scannerRunBlockedInsideTradeRun: true,
      scannerRunDisabledInsideTradeSystem: true,

      microFamiliesAppendOnly: true,
      analyzePartialOnly: true,
      analyzeFullOverwriteDisabled: true,

      rotationPreserved: true,
      manualSelectionPreserved: true,
      discordSelectionPreserved: true,

      shortPersistence: persistence,

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLatest: shortKeys.scan.latest,
        tradeLock: shortKeys.trade.lock,
        tradeRunMeta: shortKeys.trade.runMeta,
        tradeLastProcessedSnapshot: shortKeys.trade.lastProcessedSnapshot,
        tradeLastError: shortKeys.trade.lastError,
        marketUniverseLatest: MARKET_UNIVERSE_KEY,
        marketWeatherLatest: MARKET_WEATHER_KEY
      },

      warnings: [
        forceUnlock
          ? 'FORCE_UNLOCK_ENABLED_FOR_THIS_REQUEST'
          : null,
        snapshotInfo?.snapshotAlreadyProcessed
          ? 'SAME_SNAPSHOT_SEEN_BUT_ROUTE_DID_NOT_FORCE_MONITOR_ONLY'
          : null,
        monitorPreflightEnabled
          ? 'MONITOR_PREFLIGHT_ENABLED_EXPLICITLY'
          : 'MONITOR_PREFLIGHT_DISABLED_DEFAULT_TO_AVOID_VERCEL_TIMEOUT',
        monitorPreflightOk === false
          ? 'MONITOR_PREFLIGHT_FAILED_ENTRIES_MAY_STILL_BLOCK_ON_EXISTING_SYMBOLS'
          : null,
        'SCANNER_PRELOAD_DISABLED_FAST_TRADE_RUN_USE_API_SCANNER_RUN_SEPARATELY',
        payload?.weakContraRejectedRows > 0
          ? `E_WEAK_CONTRA_ENTRY_GATE_REJECTED:${payload.weakContraRejectedRows}`
          : null,
        payload?.skippedByExistingSymbol > 0
          ? `SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION:${payload.skippedByExistingSymbol}`
          : null,
        payload?.activeSelectionRuntimeFiltered
          ? `ACTIVE_SELECTION_RUNTIME_NET_EDGE_FILTERED:${payload.rejectedSelectedMicroMicroCount || 0}`
          : null,
        persistence?.warnings?.length
          ? `PERSISTENCE_WARNINGS:${persistence.warnings.length}`
          : null
      ].filter(Boolean),

      durationMs: now() - startedAt,

      debug,
      debugSafeDynamicImports: true,
      phase,

      run: debug ? payload : undefined,
      monitorPreflightRun: debug ? monitorPreflightPayload : undefined,
      result: debug
        ? {
            ok: rawResult?.ok !== false,
            skipped: Boolean(rawResult?.skipped),
            reason: rawResult?.reason || null,
            lock: rawResult?.lock || null,
            lockRelease: rawResult?.lockRelease || null
          }
        : undefined
    });
  } catch (error) {
    debug = debug || shouldDebug(req, body);

    let lockReleasedAfterError = false;
    let failureMeta = null;

    try {
      console.error('[api/trade/run] caught error', {
        phase,
        name: error?.name || 'Error',
        message: compactError(error),
        stack: compactStack(error)
      });
    } catch {
      // Logging mag route nooit opnieuw laten crashen.
    }

    try {
      if (durableRedis && lockKey) {
        await redisDel(durableRedis, lockKey);
        lockReleasedAfterError = true;
      }
    } catch {
      lockReleasedAfterError = false;
    }

    try {
      if (durableRedis && CORE?.redis?.setJson) {
        failureMeta = await writeFailureRunMeta(durableRedis, error, {
          durationMs: now() - startedAt,
          phase,
          lockReleasedAfterError
        });
      }
    } catch {
      failureMeta = null;
    }

    const httpStatus = responseStatusForError(error);

    return res.status(httpStatus).json(errorResponse({
      error,
      phase,
      startedAt,
      debug,
      lockKey,
      lockReleasedAfterError,
      failureMeta,
      httpStatus
    }));
  }
}