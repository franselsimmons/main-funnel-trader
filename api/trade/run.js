// ================= FILE: api/trade/run.js =================
//
// SHORT-only /api/trade/run
//
// Belangrijk:
// - Geen project-imports op top-level.
// - tradeSystem.js, scanner.js, redis.js, config.js worden dynamic geïmporteerd.
// - Daardoor krijg je echte import/runtime errors terug als JSON.
// - Dit voorkomt dat Vercel alleen "500" toont zonder duidelijke oorzaak.
// - SHORT-only, virtual/shadow only, geen real orders.
// - Micro-micro is de selectie/Discord-laag.
// - Parent 15 en Micro 75 blijven rollup/context.
// - XR blijft metadata/hash-source, geen aparte selectable learning family.

export const config = {
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

const DEFAULT_MONITOR_TIMEOUT_MS = 3500;
const DEFAULT_MONITOR_ONLY_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RUNTIME_MS = 26000;
const DEFAULT_MONITOR_ONLY_MAX_RUNTIME_MS = 26000;

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 12;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 25;
const DEFAULT_MONITOR_BATCH_SIZE = 80;
const DEFAULT_OPEN_POSITION_MONITOR_LIMIT = 150;

const DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS = 400;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 3500;
const DEFAULT_ANALYZE_TIMEOUT_MS = 6000;
const DEFAULT_MARKET_CONTEXT_TIMEOUT_MS = 1200;
const DEFAULT_ROTATION_TIMEOUT_MS = 1200;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const RUN_SCOPE = 'TRADE_FAST_STALE_SAFE_LOCK_MONITOR_FIRST_DEBUG_SAFE_IMPORT';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_SHORT_SCANNER_AND_MARKET_WEATHER';

const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const SHORT_MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const SHORT_MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;

const MAX_DEBUG_ROWS = 50;

let CORE = null;
let TRADE_SYSTEM_MODULE = null;
let SCANNER_MODULE = null;

function now() {
  return Date.now();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function safeInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function round(value, decimals = 4) {
  return Number(safeNumber(value, 0).toFixed(decimals));
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

function compactString(value, max = 1800) {
  const text = String(value ?? '');

  return text.length > max
    ? `${text.slice(0, max)}...TRUNCATED`
    : text;
}

function compactError(error) {
  return compactString(error?.message || error || 'UNKNOWN_ERROR', 1800);
}

function compactStack(error) {
  return error?.stack
    ? compactString(error.stack, 8000)
    : null;
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

  if (raw.startsWith('LONG:')) {
    raw = raw.slice('LONG:'.length);
  }

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
      )
    },

    market: {
      universeLatest: MARKET_UNIVERSE_KEY,
      shortUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      weatherLatest: MARKET_WEATHER_KEY,
      shortWeatherLatest: SHORT_MARKET_WEATHER_KEY
    }
  };
}

function getConfig() {
  return CORE?.CONFIG || {};
}

function getKeys() {
  return buildShortKeys(CORE?.KEYS || {});
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

async function loadScannerModule() {
  if (SCANNER_MODULE) return SCANNER_MODULE;

  const mod = await import('../../src/market/scanner.js');

  if (typeof mod.runScanner !== 'function') {
    const error = new Error('RUN_SCANNER_EXPORT_MISSING');
    error.availableExports = Object.keys(mod || {});
    error.expectedExport = 'runScanner';
    throw error;
  }

  SCANNER_MODULE = mod;

  return SCANNER_MODULE;
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

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
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

function shouldRunScannerPreload(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.scannerPreload, false)) ||
    isTrue(firstValue(req.query?.scanner_preload, false)) ||
    isTrue(firstValue(req.query?.preloadScanner, false)) ||
    isTrue(firstValue(req.query?.runScanner, false)) ||
    isTrue(body.scannerPreload) ||
    isTrue(body.scanner_preload) ||
    isTrue(body.preloadScanner) ||
    isTrue(body.runScanner)
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
    ? 'ADMIN_MANUAL_SHORT_TRADE_RUN_DEBUG_SAFE_IMPORT'
    : 'CRON_OR_API_SHORT_TRADE_RUN_DEBUG_SAFE_IMPORT';
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

function isolationFlags() {
  return {
    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,
    scannerPreloadBeforeTrade: false,
    scannerPreloadRequiredForMarketWeather: false,

    readsScannerLatest: true,
    scannerLatestReadOnlyInsideTradeSystem: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    scannerRunAllowed: false,
    scannerRunAllowedByExplicitFlag: true,
    scannerRunBeforeTrade: false,
    scannerRunDisabledInsideTradeSystem: true,
    noInternalScannerRunInsideTradeSystem: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesMarketUniverse: false,
    writesMarketWeather: false,
    writesMarketWeatherInput: false,

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradePositions: true,

    writesAnalyze: true,
    writesAnalyzePartial: true,
    writesMicroFamilies: true,
    microFamiliesAppendOnly: true,
    microFamiliesAntiWipe: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    writesRotation: false,
    writesDiscordSelection: false,
    writesManualSelection: false,

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

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,

    lockMode: 'STALE_SAFE_SHORT_TTL_FORCE_CLEAR_ON_MANUAL_FORCE',
    lockCannotBlockForever: true,
    staleLockAutoBreakEnabled: true,
    forceProcessSnapshotClearsLock: true,
    lockReleasedInFinally: true,

    monitorPreflightSupported: true,
    monitorPreflightDefaultEnabled: false,
    monitorOpenPositionsHardFirst: true,
    monitorOpenPositionsBeforeEntries: true,
    exitSweepBeforeEntryGate: true,
    closeVirtualPositionsBeforeEntries: true,

    snapshotAlreadyProcessedDoesNotBlockMonitor: true,
    sameSnapshotRunsMonitorOnly: true,
    newEntriesBlockedWhenSnapshotAlreadyProcessed: true,

    debugSafeDynamicImports: true,
    topLevelTradeSystemImportDisabled: true,
    topLevelScannerImportDisabled: true,
    importErrorsReturnedAsJson: true,

    compactRunMetaForRedis: true,
    compactLastProcessedSnapshot: true,
    largeMarketWeatherRowsOmitted: true
  };
}

function baseFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    shadowOnly: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    learningOnly: true,
    microFamilyLearning: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      MICRO_MICRO_ACTIVE: 'completed >= 35'
    },

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintOnlyMetadata: false,
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

    parentMicroFamilyCount: 15,
    micro75Count: 75,
    selectionGranularity: 'EXACT_MICRO_MICRO',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO',
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    micro75FamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    microMicroFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{HASH}',

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    positionTimeStopMin: getPositionTimeStopMin(),

    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    parentMacroMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,
    micro75MatchDoesNotTriggerDiscord: true,

    selectionEngineVersion: 'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V1',
    selectionUsesLifetimeStats: true,
    selectionUsesWeeklyWinnerOnly: false,
    selectionUsesLCBAvgR: true,
    selectionUsesCurrentFitHook: true,
    selectionRequiresEligibleGate: true,
    selectionAvoidsWinnerCurse: true,

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    defaultLockTtlSec: DEFAULT_LOCK_TTL_SEC,
    defaultStaleLockAfterSec: DEFAULT_STALE_LOCK_AFTER_SEC,
    defaultMonitorTimeoutMs: DEFAULT_MONITOR_TIMEOUT_MS,
    defaultMonitorOnlyTimeoutMs: DEFAULT_MONITOR_ONLY_TIMEOUT_MS,
    defaultMaxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
    defaultMonitorBatchSize: DEFAULT_MONITOR_BATCH_SIZE,
    defaultOpenPositionMonitorLimit: DEFAULT_OPEN_POSITION_MONITOR_LIMIT,
    maxCandidatesHardCapForVercel: DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT,

    ...isolationFlags()
  };
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
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
  res.setHeader('X-Scanner-Fingerprint-Role', 'METADATA_ONLY');
  res.setHeader('X-Execution-Fingerprint-Role', 'MICRO_MICRO_IDENTITY_HASH_SOURCE');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_PARENT_MICRO_MICRO_LAYERED');
  res.setHeader('X-Selection-Granularity', 'EXACT_MICRO_MICRO');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Micro-Micro-Family-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Micro-Micro-Learning-Granularity', MICRO_MICRO_LEARNING_GRANULARITY);
  res.setHeader('X-Run-Scope', RUN_SCOPE);
  res.setHeader('X-Write-Scope', WRITE_SCOPE);
  res.setHeader('X-Scanner-Write', 'false');
  res.setHeader('X-Scanner-Run-Allowed', 'explicit-only');
  res.setHeader('X-Scanner-Preload-Before-Trade', 'optional');
  res.setHeader('X-Scanner-Preload-Default', 'disabled');
  res.setHeader('X-MicroFamilies-Append-Only', 'true');
  res.setHeader('X-Admin-Page-Isolation', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-Monitor-Preflight-Default', 'disabled');
  res.setHeader('X-Monitor-Open-Positions-First', 'true');
  res.setHeader('X-Exit-Sweep-Before-Entry-Gate', 'true');
  res.setHeader('X-Stale-Safe-Lock', 'true');
  res.setHeader('X-Snapshot-Already-Processed-Monitor-Only', 'true');
  res.setHeader('X-Debug-Safe-Dynamic-Imports', 'true');
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
  if (!redis || !key) return null;

  try {
    if (typeof redis.get === 'function') return await redis.get(key);
  } catch {
    return null;
  }

  return null;
}

async function redisDel(redis, key) {
  if (!redis || !key) return false;

  try {
    if (typeof redis.del === 'function') {
      await redis.del(key);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function redisTtl(redis, key) {
  if (!redis || !key) return null;

  try {
    if (typeof redis.ttl === 'function') {
      const ttl = await redis.ttl(key);
      return Number.isFinite(Number(ttl)) ? Number(ttl) : null;
    }
  } catch {
    return null;
  }

  return null;
}

async function redisSetNxEx(redis, key, value, ttlSec) {
  if (!redis || !key) return false;

  const serialized = typeof value === 'string'
    ? value
    : JSON.stringify(value);

  try {
    if (typeof redis.set === 'function') {
      const result = await redis.set(key, serialized, {
        nx: true,
        ex: ttlSec
      });

      if (result === 'OK' || result === true || result?.ok === true) return true;
    }
  } catch {
    // fallback below
  }

  try {
    if (typeof redis.set === 'function') {
      const result = await redis.set(key, serialized, 'EX', ttlSec, 'NX');

      if (result === 'OK' || result === true || result?.ok === true) return true;
    }
  } catch {
    return false;
  }

  return false;
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
    const ageSec = createdAt > 0
      ? Math.round((now() - createdAt) / 1000)
      : null;

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
    const ageSec = createdAt > 0
      ? Math.round((now() - createdAt) / 1000)
      : null;

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
  if (
    Number.isFinite(safeNumber(lockState.expiresAt, NaN)) &&
    safeNumber(lockState.expiresAt, 0) <= now()
  ) {
    return true;
  }

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
  const runId = `trade_lock_${now()}_${Math.random().toString(16).slice(2, 10)}`;
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
    runScope: RUN_SCOPE,
    runSource,
    staleSafeLock: true,
    forceUnlockAllowed: true
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
    const stateAfterFailedAcquire = await readLockState(redis, lockKey);

    if (stateAfterFailedAcquire.exists && isStaleLock(stateAfterFailedAcquire, staleLockAfterSec)) {
      await redisDel(redis, lockKey);
      staleClearedBeforeAcquire = true;
      acquired = await redisSetNxEx(redis, lockKey, lockValue, lockTtlSec);
    }

    if (!acquired) {
      return {
        acquired: false,
        lockValue,
        state: stateAfterFailedAcquire,
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
  let caughtError;
  let released = null;

  try {
    result = await fn(lock);
  } catch (error) {
    caughtError = error;
  }

  released = await releaseOwnLock(redis, lockKey, lock.lockValue, false);

  if (released?.released !== true) {
    released = await releaseOwnLock(redis, lockKey, lock.lockValue, true);
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

function responseOk(value) {
  const payload = unwrapRunResult(value);

  return value?.ok !== false && payload?.ok !== false;
}

function responseSkipped(value) {
  const payload = unwrapRunResult(value);

  return Boolean(value?.skipped || payload?.skipped || payload?.skippedNewEntries);
}

function responseReason(value) {
  const payload = unwrapRunResult(value);

  return value?.reason || payload?.reason || payload?.skipReason || null;
}

function responseRunId(value) {
  return unwrapRunResult(value)?.runId || null;
}

function responseSnapshotId(value) {
  return unwrapRunResult(value)?.snapshotId || null;
}

function compactMarketWeather(value = {}) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: value.ok ?? value.available ?? null,
    available: value.available ?? value.ok ?? null,
    version: value.version || null,
    source: value.source && typeof value.source !== 'object' ? value.source : 'VIRTUAL',
    snapshotId: value.snapshotId || null,
    generatedAt: value.generatedAt || null,
    createdAt: value.createdAt || null,
    completedAt: value.completedAt || null,
    updatedAt: value.updatedAt || null,

    currentRegime: value.currentRegime || value.regime || null,
    regime: value.regime || value.currentRegime || null,
    currentTrendSide: value.currentTrendSide || value.trendSide || null,
    trendSide: value.trendSide || value.currentTrendSide || null,
    currentFlow: value.currentFlow || value.flow || null,
    currentVolatilityState: value.currentVolatilityState || value.volatilityState || null,

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

    btcState: value.btcState || null,
    btcChange1h: value.btcChange1h ?? null,
    btcChange24h: value.btcChange24h ?? null,
    btcRegime: value.btcRegime || null,

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

function cleanShortArray(values = [], max = 100) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean)
      .filter((value) => value.startsWith('MICRO_SHORT_'))
      .filter((value) => !value.includes('_XR_'))
      .filter((value) => !value.includes('SCANNER'))
  )].slice(0, max);
}

function compactRows(rows = [], limit = MAX_DEBUG_ROWS) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((row) => {
      if (!row || typeof row !== 'object') return row;

      return {
        symbol: row.symbol || row.baseSymbol || null,
        action: row.action || row.type || null,
        reason: row.reason || row.skipReason || row.liveEntryBlockedReason || null,

        side: TARGET_DASHBOARD_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        positionSide: TARGET_TRADE_SIDE,
        direction: TARGET_TRADE_SIDE,

        trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId || null,
        childTrueMicroFamilyId: row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId || null,
        parentTrueMicroFamilyId: row.parentTrueMicroFamilyId || row.coarseMicroFamilyId || null,

        microMicroFamilyId: row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId || null,
        trueMicroMicroFamilyId: row.trueMicroMicroFamilyId || row.microMicroFamilyId || row.exactMicroMicroFamilyId || null,
        exactMicroMicroFamilyId: row.exactMicroMicroFamilyId || row.microMicroFamilyId || row.trueMicroMicroFamilyId || null,

        entry: row.entry ?? row.entryPrice ?? null,
        sl: row.sl ?? row.stopLoss ?? null,
        tp: row.tp ?? row.takeProfit ?? null,
        exitPrice: row.exitPrice ?? null,
        currentPrice: row.currentPrice ?? row.lastPrice ?? null,

        rr: row.rr ?? null,
        grossR: row.grossR ?? row.shortGrossR ?? null,
        netR: row.netR ?? row.r ?? row.realizedR ?? null,
        costR: row.costR ?? null,

        currentFit: row.currentFit || row.currentFitLabel || null,
        currentFitScore: row.currentFitScore ?? row.shortCurrentFit ?? row.bearCurrentFit ?? null,

        virtualOnly: true,
        shadowOnly: true,
        realOrder: false,
        exchangeOrder: false,
        bitgetOrderPlaced: false
      };
    });
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

function mergeActionCounts(...counts) {
  return counts.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row || {})) {
      acc[key] = safeNumber(acc[key], 0) + safeNumber(value, 0);
    }

    return acc;
  }, {});
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

    selectedSnapshotSource: payload.selectedSnapshotSource || null,
    selectedSnapshotReason: payload.selectedSnapshotReason || null,

    selectedTargetCandidateCount: safeNumber(payload.selectedTargetCandidateCount, 0),
    selectedShortCandidateCount: safeNumber(payload.selectedShortCandidateCount, 0),
    selectedOppositeCandidateCount: 0,
    selectedLongCandidateCount: 0,

    candidates: safeNumber(payload.candidates || payload.candidatesCount, 0),
    allShortCandidatesBeforeCap: safeNumber(payload.allShortCandidatesBeforeCap, 0),
    cappedCandidateCount: safeNumber(payload.cappedCandidateCount, 0),
    shortCandidateCount: safeNumber(payload.shortCandidateCount || payload.shortCandidatesCount, 0),
    longCandidateCount: 0,
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
    discordAlertsSent: 0,
    discordAlertsSkippedNoSelectedMicro: safeNumber(payload.discordAlertsSkippedNoSelectedMicro, 0),
    discordAlertsSkippedCurrentFit: safeNumber(payload.discordAlertsSkippedCurrentFit, 0),
    selectedMicroMatchRows: safeNumber(payload.selectedMicroMatchRows, 0),
    selectedMicroMicroMatchRows: safeNumber(payload.selectedMicroMicroMatchRows, 0),
    selectedAlertMicroMatches: safeNumber(payload.selectedAlertMicroMatches, 0),
    selectedAlertMicroMicroMatches: safeNumber(payload.selectedAlertMicroMicroMatches, 0),

    openPositionCountBeforeEntries: payload.openPositionCountBeforeEntries ?? null,
    openPositionCountAfterEntries: payload.openPositionCountAfterEntries ?? null,

    actionCounts: mergeActionCounts(
      payload.actionCounts || {},
      countActionsByType(actions)
    ),

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

    activeMicroMicroFamilyIds: cleanShortArray(
      payload.activeMicroMicroFamilyIds ||
        payload.selectedMicroMicroFamilyIds ||
        payload.trueMicroMicroFamilyIds ||
        payload.microMicroFamilyIds ||
        []
    ),

    selectedMicroMicroFamilyIds: cleanShortArray(
      payload.selectedMicroMicroFamilyIds ||
        payload.activeMicroMicroFamilyIds ||
        payload.trueMicroMicroFamilyIds ||
        payload.microMicroFamilyIds ||
        []
    ),

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
            : []
        }
      : null,

    runtimeWarnings: Array.isArray(payload.runtimeWarnings)
      ? payload.runtimeWarnings.slice(0, 50)
      : [],

    monitorOpenPositions: payload.monitorOpenPositions ?? true,
    monitorOpenPositionsFirst: payload.monitorOpenPositionsFirst ?? true,
    processScannerSnapshot: payload.processScannerSnapshot ?? true,

    monitorTimeoutMs: payload.monitorTimeoutMs || null,
    monitorPriceFetchTimeoutMs: payload.monitorPriceFetchTimeoutMs || null,
    maxRuntimeMs: payload.maxRuntimeMs || null,

    scannerSnapshotStats: payload.scannerSnapshotStats
      ? {
          candidatesCount: payload.scannerSnapshotStats.candidatesCount || null,
          scannerGateCandidatesCount: payload.scannerSnapshotStats.scannerGateCandidatesCount || null,
          analyzeOnlyCandidatesCount: payload.scannerSnapshotStats.analyzeOnlyCandidatesCount || null,
          filteredUniverse: payload.scannerSnapshotStats.filteredUniverse || null,
          rawCount: payload.scannerSnapshotStats.rawCount || null
        }
      : null,

    entryRowsList: debug ? compactRows(rawEntryRows) : [],
    waitRowsList: debug ? compactRows(rawWaitRows) : [],
    virtualCreatedRowsList: debug ? compactRows(rawEntryRows) : [],
    virtualExits: debug ? compactRows(rawExitRows) : [],
    shadowExits: debug ? compactRows(rawExitRows) : [],
    exits: debug ? compactRows(rawExitRows) : [],
    realExits: [],

    ...baseFlags(),

    realTradesOnly: false,
    virtualLearningOnly: true,
    shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED',

    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };
}

function compactMonitorPreflightPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;

  return {
    ok: payload.ok !== false,
    runId: payload.runId || null,
    runPhase: payload.runPhase || payload.tradeRunPhase || 'MONITOR_PREFLIGHT',

    monitorOnly: true,
    processScannerSnapshot: false,

    openPositionCountBeforeEntries: payload.openPositionCountBeforeEntries ?? null,
    openPositionCountAfterEntries: payload.openPositionCountAfterEntries ?? null,

    virtualExitRows: safeNumber(payload.virtualExitRows, 0),
    shadowExitRows: safeNumber(payload.shadowExitRows, 0),
    realExitRows: 0,

    actionsCount: safeNumber(payload.actionsCount, 0),
    actionCounts: payload.actionCounts || {},

    runtimeWarnings: Array.isArray(payload.runtimeWarnings)
      ? payload.runtimeWarnings.slice(0, 30)
      : [],

    reason: payload.reason || payload.skipReason || null,
    durationMs: safeNumber(payload.durationMs, 0),

    monitorTimeoutMs: payload.monitorTimeoutMs || null,
    maxRuntimeMs: payload.maxRuntimeMs || null
  };
}

function responseCountsFromPayload(payload = {}, monitorPreflightPayload = null) {
  const actionsCount = safeNumber(payload.actionsCount, 0) +
    safeNumber(monitorPreflightPayload?.actionsCount, 0);

  const virtualExitRows = safeNumber(payload.virtualExitRows, 0) +
    safeNumber(monitorPreflightPayload?.virtualExitRows, 0);

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

    entryRows: safeNumber(payload.entryRows, 0),
    waitRows: safeNumber(payload.waitRows, 0),

    virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualOpenedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(payload.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows, 0),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows, 0),

    actions: actionsCount,
    shortActions: actionsCount,

    entries: safeNumber(payload.entryRows, 0),
    waits: safeNumber(payload.waitRows, 0),
    observations: safeNumber(payload.observationOnlyRows, 0),

    realExits: 0,
    realExitRows: 0,

    shadowExits: virtualExitRows,
    shadowExitRows: virtualExitRows,

    virtualExits: virtualExitRows,
    virtualExitRows,

    monitorPreflightVirtualExits: safeNumber(monitorPreflightPayload?.virtualExitRows, 0),
    monitorPreflightShadowExits: safeNumber(monitorPreflightPayload?.shadowExitRows, 0),

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
    activeMicroMicroFamilies: safeNumber(payload.activeMicroMicroFamilies, 0),

    selectedTargetCandidateCount: safeNumber(payload.selectedTargetCandidateCount, 0),
    selectedOppositeCandidateCount: 0,

    discordEligibleEntries: safeNumber(payload.discordAlertEligibleRows, 0),
    discordSkippedNotSelected: safeNumber(payload.discordAlertsSkippedNoSelectedMicro, 0),

    scannerPreloadBeforeTrade: Boolean(payload.scannerPreloadBeforeTrade),
    scannerSnapshotPreserved: true,
    microFamiliesAppendOnly: true
  };
}

async function readLatestSnapshotId() {
  const { getDurableRedis, getVolatileRedis, getJson } = CORE.redis;
  const shortKeys = getKeys();

  const volatileRedis = getVolatileRedis();
  const durableRedis = getDurableRedis();

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

async function readLastProcessedSnapshotId() {
  const { getDurableRedis, getJson } = CORE.redis;
  const shortKeys = getKeys();

  const durableRedis = getDurableRedis();
  const value = await getJson(durableRedis, shortKeys.trade.lastProcessedSnapshot, null).catch(() => null);

  if (!value) return null;
  if (typeof value === 'string') return value;

  return value.snapshotId || value.id || value.latestSnapshotId || null;
}

async function determineSnapshotMode(req, body = {}) {
  const latest = await readLatestSnapshotId();
  const lastProcessedSnapshotId = await readLastProcessedSnapshotId();

  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const requestedMonitorOnly = shouldMonitorOnly(req, body);

  const snapshotAlreadyProcessed =
    Boolean(latest.snapshotId) &&
    Boolean(lastProcessedSnapshotId) &&
    latest.snapshotId === lastProcessedSnapshotId;

  const effectiveMonitorOnly =
    requestedMonitorOnly ||
    (snapshotAlreadyProcessed && !forceProcessSnapshot);

  return {
    latestSnapshotId: latest.snapshotId,
    latestSnapshotSource: latest.source,
    latestSnapshotCreatedAt: latest.createdAt,
    latestSelectedTargetCandidateCount: latest.selectedTargetCandidateCount,
    lastProcessedSnapshotId,

    forceProcessSnapshot,
    requestedMonitorOnly,
    snapshotAlreadyProcessed,

    effectiveMonitorOnly,
    effectiveProcessScannerSnapshot: !effectiveMonitorOnly,

    entriesBlockedBecauseSnapshotAlreadyProcessed:
      snapshotAlreadyProcessed && !forceProcessSnapshot && !requestedMonitorOnly,

    reason: snapshotAlreadyProcessed && !forceProcessSnapshot && !requestedMonitorOnly
      ? 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY'
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
    sameSnapshotRunsMonitorOnly: true,

    monitorTimeoutMs,
    openPositionMonitorTimeoutMs: monitorTimeoutMs,
    closeVirtualPositionsTimeoutMs: monitorTimeoutMs,
    closeShadowPositionsTimeoutMs: monitorTimeoutMs,
    positionMonitorTimeoutMs: monitorTimeoutMs,
    monitorPriceFetchTimeoutMs: DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS,
    monitorLivePriceFetchEnabled: false,
    monitorPriceSource: 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',

    candidateTimeoutMs: DEFAULT_CANDIDATE_TIMEOUT_MS,
    analyzeTimeoutMs: DEFAULT_ANALYZE_TIMEOUT_MS,
    marketContextTimeoutMs: DEFAULT_MARKET_CONTEXT_TIMEOUT_MS,
    rotationTimeoutMs: DEFAULT_ROTATION_TIMEOUT_MS,
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
    shadowOnly: true,
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
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintOnlyMetadata: false,
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',

    exactTrueMicroFamilyRequired: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroDoesNotReplaceMicro75Learning: true,
    microMicroRollsUpToMicro75: true,
    microMicroRollsUpToParent15: true,

    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,

    selectionGranularity: 'EXACT_MICRO_MICRO',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO',

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
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    macroMatchDoesNotTriggerDiscord: true,
    parentMacroMatchDoesNotTriggerDiscord: true,
    micro75MatchDoesNotTriggerDiscord: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

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
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
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

    ...overrides
  };
}

function buildScannerPreloadOptions(req, body = {}) {
  const shortKeys = getKeys();

  return {
    force: true,
    forced: true,

    source: 'TRADE_RUN_SCANNER_PRELOAD_EXPLICIT',
    trigger: 'api/trade/run.js',
    runSource: getRunSource(req, body),

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    disableLong: true,

    keys: {
      scanLatest: shortKeys.scan.latest,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
    },

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    scannerPreloadBeforeTrade: true,
    marketWeatherPreloadBeforeTrade: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,

    microMicroEnabled: true,
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO'
  };
}

function summarizeScannerPreload(scannerResult = null) {
  if (!scannerResult || typeof scannerResult !== 'object') {
    return {
      ok: false,
      reason: 'NO_SCANNER_RESULT'
    };
  }

  return {
    ok: scannerResult.ok !== false,
    snapshotId: scannerResult.snapshotId || null,
    createdAt: scannerResult.createdAt || null,
    completedAt: scannerResult.completedAt || null,
    durationMs: scannerResult.durationMs || null,

    rawCount: safeNumber(scannerResult.rawCount, 0),
    filteredUniverse: safeNumber(scannerResult.filteredUniverse, 0),

    candidatesCount: safeNumber(scannerResult.candidatesCount, 0),
    scannerGateCandidatesCount: safeNumber(scannerResult.scannerGateCandidatesCount, 0),
    analyzeOnlyCandidatesCount: safeNumber(scannerResult.analyzeOnlyCandidatesCount, 0),

    marketUniverseCount: safeNumber(scannerResult.marketUniverseCount, 0),
    marketUniverseSaved: Boolean(scannerResult.marketUniverseSaved),
    marketUniverseKeys: Array.isArray(scannerResult.marketUniverseKeys)
      ? scannerResult.marketUniverseKeys
      : [],

    marketWeatherCount: safeNumber(scannerResult.marketWeatherCount, scannerResult.marketUniverseCount || 0),
    marketWeatherSaved: Boolean(scannerResult.marketWeatherSaved),
    marketWeatherKeys: Array.isArray(scannerResult.marketWeatherKeys)
      ? scannerResult.marketWeatherKeys
      : [],

    btcState: scannerResult.btcState || null,
    regime: scannerResult.regime || null,

    topSymbols: Array.isArray(scannerResult.topSymbols)
      ? scannerResult.topSymbols.slice(0, 20)
      : [],

    scannerPreloadBeforeTrade: true
  };
}

async function mirrorOneMarketKey({
  volatileRedis,
  durableRedis,
  key
}) {
  const { getJson, setJson } = CORE.redis;

  const payload = await getJson(volatileRedis, key, null).catch(() => null);

  if (!payload) {
    return {
      key,
      ok: false,
      reason: 'SOURCE_KEY_EMPTY'
    };
  }

  await setJson(
    durableRedis,
    key,
    {
      ...payload,
      rows: Array.isArray(payload.rows) ? payload.rows.slice(0, 5) : payload.rows,
      symbols: Array.isArray(payload.symbols) ? payload.symbols.slice(0, 60) : payload.symbols,
      universe: undefined,
      tickers: undefined,

      mirroredFromVolatile: true,
      mirroredToDurable: true,
      mirroredAt: now(),
      mirrorSourceKey: key,
      scannerPreloadBeforeTrade: true,
      marketWeatherPreloadBeforeTrade: true,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      microMicroEnabled: true,
      microMicroSelectionGranularity: 'EXACT_MICRO_MICRO',
      ...baseFlags()
    }
  );

  return {
    key,
    ok: true
  };
}

async function mirrorMarketCacheFromVolatileToDurable({
  volatileRedis,
  durableRedis
}) {
  const keys = [
    MARKET_UNIVERSE_KEY,
    SHORT_MARKET_UNIVERSE_KEY,
    MARKET_WEATHER_KEY,
    SHORT_MARKET_WEATHER_KEY
  ];

  const uniqueKeys = [...new Set(keys)];
  const results = [];

  for (const key of uniqueKeys) {
    results.push(await mirrorOneMarketKey({
      volatileRedis,
      durableRedis,
      key
    }));
  }

  const okKeys = results
    .filter((row) => row.ok)
    .map((row) => row.key);

  return {
    ok: okKeys.length > 0,
    okKeys,
    results,
    marketWeatherMirrored: okKeys.includes(MARKET_WEATHER_KEY) || okKeys.includes(SHORT_MARKET_WEATHER_KEY),
    marketUniverseMirrored: okKeys.includes(MARKET_UNIVERSE_KEY) || okKeys.includes(SHORT_MARKET_UNIVERSE_KEY)
  };
}

async function runScannerPreload({
  req,
  body,
  volatileRedis,
  durableRedis
}) {
  const startedAt = now();

  try {
    const { runScanner } = await loadScannerModule();

    const scannerResult = await runScanner(buildScannerPreloadOptions(req, body));

    const mirror = await mirrorMarketCacheFromVolatileToDurable({
      volatileRedis,
      durableRedis
    });

    return {
      ok: scannerResult?.ok !== false,
      skipped: false,
      scanner: summarizeScannerPreload(scannerResult),
      mirror,
      durationMs: now() - startedAt,
      scannerPreloadBeforeTrade: true
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: compactError(error),
      errorName: error?.name || 'Error',
      errorStack: compactStack(error),
      availableExports: error?.availableExports || null,
      durationMs: now() - startedAt,
      scannerPreloadBeforeTrade: true
    };
  }
}

function skippedScannerPreload() {
  return {
    ok: true,
    skipped: true,
    reason: 'SCANNER_PRELOAD_DISABLED_FOR_FAST_TRADE_RUN',
    scannerPreloadBeforeTrade: false,
    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,
    mirror: {
      ok: false,
      skipped: true,
      marketWeatherMirrored: false,
      marketUniverseMirrored: false
    }
  };
}

function buildMonitorPreflightOptions(req, body = {}) {
  return buildRunOptions(req, body, {
    monitorOnly: true,
    processScannerSnapshot: false,
    phase: 'MONITOR_PREFLIGHT'
  });
}

function buildMainTradeOptions(req, body = {}, snapshotMode = null) {
  const requestedMonitorOnly = shouldMonitorOnly(req, body);
  const effectiveMonitorOnly = snapshotMode?.effectiveMonitorOnly ?? requestedMonitorOnly;

  return buildRunOptions(req, body, {
    monitorOnly: effectiveMonitorOnly,
    processScannerSnapshot: !effectiveMonitorOnly,
    phase: effectiveMonitorOnly
      ? snapshotMode?.snapshotAlreadyProcessed && !snapshotMode?.forceProcessSnapshot
        ? 'MONITOR_ONLY_SNAPSHOT_ALREADY_PROCESSED'
        : 'MONITOR_ONLY_REQUEST'
      : 'TRADE_MAIN',
    snapshotAlreadyProcessed: Boolean(snapshotMode?.snapshotAlreadyProcessed),
    entriesBlockedBecauseSnapshotAlreadyProcessed: Boolean(snapshotMode?.entriesBlockedBecauseSnapshotAlreadyProcessed)
  });
}

function isSnapshotAlreadyProcessedReason(reason = '') {
  return String(reason || '').toUpperCase() === 'SNAPSHOT_ALREADY_PROCESSED';
}

async function persistShortRunMeta(
  redis,
  payload = {},
  rawResult = {},
  scannerPreload = null,
  monitorPreflight = null,
  snapshotMode = null
) {
  const { setJson } = CORE.redis;
  const shortKeys = getKeys();

  if (!payload || typeof payload !== 'object') {
    return {
      persistedShortRunMeta: false,
      persistedShortLastProcessedSnapshot: false,
      reason: 'NO_PAYLOAD'
    };
  }

  const runMeta = {
    ...payload,

    actions: [],
    virtualActions: [],
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

    qualityAudit: payload.qualityAudit
      ? {
          profile: payload.qualityAudit.profile || null,
          primaryBottleneck: payload.qualityAudit.primaryBottleneck || null,
          pipelineCounts: payload.qualityAudit.pipelineCounts || null,
          conversionRatesPct: payload.qualityAudit.conversionRatesPct || null,
          topWaitReasons: payload.qualityAudit.topWaitReasons || []
        }
      : null,

    ...baseFlags(),

    scannerPreload,
    monitorPreflight,
    snapshotMode,

    monitorPreflightEnabled: Boolean(monitorPreflight),
    monitorPreflightVirtualExitRows: safeNumber(monitorPreflight?.virtualExitRows, 0),
    monitorPreflightShadowExitRows: safeNumber(monitorPreflight?.shadowExitRows, 0),

    persistedAt: now(),
    persistedBy: 'api/trade/run.js',
    persistedNamespace: SHORT_NAMESPACE,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      tradeRunMeta: shortKeys.trade.runMeta,
      tradeLastProcessedSnapshot: shortKeys.trade.lastProcessedSnapshot,
      scannerLatest: shortKeys.scan.latest,
      tradeLock: shortKeys.trade.lock,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
    },

    rawResultOk: rawResult?.ok !== false,
    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };

  const persistence = {
    persistedShortRunMeta: false,
    persistedShortLastProcessedSnapshot: false,
    tradeRunMeta: shortKeys.trade.runMeta,
    tradeLastProcessedSnapshot: shortKeys.trade.lastProcessedSnapshot,
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

  const shouldPersistLastProcessed =
    Boolean(payload.snapshotId) &&
    payload.processScannerSnapshot !== false &&
    payload.reason !== 'MONITOR_ONLY' &&
    payload.reason !== 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY' &&
    snapshotMode?.effectiveMonitorOnly !== true;

  if (shouldPersistLastProcessed) {
    await setJson(
      redis,
      shortKeys.trade.lastProcessedSnapshot,
      {
        snapshotId: payload.snapshotId,
        runId: payload.runId || null,
        processedAt: now(),
        processScannerSnapshot: true,
        snapshotMode: {
          latestSnapshotId: snapshotMode?.latestSnapshotId || payload.snapshotId,
          lastProcessedSnapshotId: snapshotMode?.lastProcessedSnapshotId || null,
          snapshotAlreadyProcessed: Boolean(snapshotMode?.snapshotAlreadyProcessed),
          effectiveMonitorOnly: false
        },
        scannerPreload: scannerPreload
          ? {
              ok: scannerPreload.ok !== false,
              skipped: Boolean(scannerPreload.skipped),
              reason: scannerPreload.reason || null,
              snapshotId: scannerPreload.scanner?.snapshotId || null
            }
          : null,
        monitorPreflight,
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
    ok: false,
    reason: 'TRADE_SYSTEM_ERROR_LOCK_RELEASED',
    error: compactError(error),
    errorName: error?.name || 'Error',
    errorStack: compactStack(error),
    errorCode: error?.code || null,
    errorReason: error?.reason || null,
    availableExports: error?.availableExports || null,
    expectedExport: error?.expectedExport || null,
    compactedForVercelRuntime: true,
    persistedAt: now(),
    persistedBy: 'api/trade/run.js',
    ...baseFlags(),
    ...extra
  };

  await setJson(redis, shortKeys.trade.runMeta, payload).catch(() => null);

  return payload;
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
    scannerPreloadOk: null,

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
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
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

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  return 500;
}

function errorResponse({
  error,
  phase,
  startedAt,
  debug,
  lockKey = null,
  lockReleasedAfterError = false,
  failureMeta = null
}) {
  return {
    ok: false,
    tradeOk: false,
    scannerPreloadOk: null,

    phase,
    reason: 'TRADE_RUN_FAILED_DEBUG_SAFE_IMPORT',
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
          failureMeta
        }
      : null,

    durationMs: now() - startedAt,
    completedAt: now(),
    debug
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
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    phase = 'READ_BODY';
    body = await readBody(req);
    debug = shouldDebug(req, body);

    phase = 'LOAD_CORE_MODULES';
    await loadCoreModules();

    const {
      getDurableRedis,
      getVolatileRedis
    } = CORE.redis;

    durableRedis = getDurableRedis();
    shortKeys = getKeys();
    lockKey = shortKeys.trade.lock;

    const requestedMonitorOnly = shouldMonitorOnly(req, body);
    const monitorPreflightEnabled = !requestedMonitorOnly && shouldRunMonitorPreflight(req, body);
    const scannerPreloadEnabled = shouldRunScannerPreload(req, body);
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

    let scannerPreload = null;
    let rawMonitorPreflight = null;
    let snapshotMode = null;
    let mainRunOptions = null;
    let fallbackMonitorAfterSnapshotSkip = null;
    let rawMainBeforeFallback = null;

    phase = 'ACQUIRE_TRADE_LOCK_AND_RUN';

    const rawResult = await runWithTradeLock({
      redis: durableRedis,
      lockKey,
      lockTtlSec,
      staleLockAfterSec,
      forceUnlock,
      runSource,
      fn: async () => {
        if (scannerPreloadEnabled && !requestedMonitorOnly) {
          phase = 'SCANNER_PRELOAD_DYNAMIC_IMPORT_AND_RUN';

          const volatileRedis = getVolatileRedis();

          scannerPreload = await runScannerPreload({
            req,
            body,
            volatileRedis,
            durableRedis
          });
        } else {
          scannerPreload = skippedScannerPreload();
        }

        phase = 'DETERMINE_SNAPSHOT_MODE';
        snapshotMode = await determineSnapshotMode(req, body);

        phase = 'BUILD_MAIN_TRADE_OPTIONS';
        mainRunOptions = buildMainTradeOptions(req, body, snapshotMode);

        phase = 'DYNAMIC_IMPORT_TRADE_SYSTEM';
        const { runTradeSystem } = await loadTradeSystemModule();

        if (monitorPreflightEnabled && !mainRunOptions.monitorOnly) {
          phase = 'RUN_MONITOR_PREFLIGHT';

          try {
            rawMonitorPreflight = await runTradeSystem({
              ...buildMonitorPreflightOptions(req, body),
              scannerPreloadBeforeTrade: false,
              marketWeatherPreloadBeforeTrade: false,
              scannerPreloadOk: scannerPreload?.ok !== false,
              marketWeatherMirroredToDurable: scannerPreload?.mirror?.marketWeatherMirrored === true,
              marketUniverseMirroredToDurable: scannerPreload?.mirror?.marketUniverseMirrored === true,
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
              errorStack: compactStack(error),
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

        phase = 'RUN_MAIN_TRADE_SYSTEM';

        const mainResult = await runTradeSystem({
          ...mainRunOptions,
          scannerPreloadBeforeTrade: scannerPreloadEnabled,
          marketWeatherPreloadBeforeTrade: scannerPreloadEnabled,
          scannerPreloadOk: scannerPreload?.ok !== false,
          marketWeatherMirroredToDurable: scannerPreload?.mirror?.marketWeatherMirrored === true,
          marketUniverseMirroredToDurable: scannerPreload?.mirror?.marketUniverseMirrored === true,
          monitorPreflightEnabled,
          monitorPreflightCompleted: Boolean(rawMonitorPreflight),
          monitorPreflightOk: rawMonitorPreflight
            ? unwrapRunResult(rawMonitorPreflight)?.ok !== false
            : null,
          monitorPreflightVirtualExitRows: safeNumber(unwrapRunResult(rawMonitorPreflight)?.virtualExitRows, 0),
          monitorPreflightShadowExitRows: safeNumber(unwrapRunResult(rawMonitorPreflight)?.shadowExitRows, 0)
        });

        const mainPayload = unwrapRunResult(mainResult);

        if (
          isSnapshotAlreadyProcessedReason(mainPayload?.reason || mainPayload?.skipReason) &&
          !requestedMonitorOnly
        ) {
          phase = 'RUN_MONITOR_FALLBACK_AFTER_SNAPSHOT_ALREADY_PROCESSED';

          rawMainBeforeFallback = mainResult;
          fallbackMonitorAfterSnapshotSkip = true;

          const monitorResult = await runTradeSystem({
            ...buildRunOptions(req, body, {
              monitorOnly: true,
              processScannerSnapshot: false,
              phase: 'MONITOR_ONLY_AFTER_SNAPSHOT_ALREADY_PROCESSED',
              force: false,
              forceProcessSnapshot: false,
              snapshotAlreadyProcessed: true,
              entriesBlockedBecauseSnapshotAlreadyProcessed: true
            }),
            scannerPreloadBeforeTrade: false,
            marketWeatherPreloadBeforeTrade: false,
            scannerPreloadOk: scannerPreload?.ok !== false,
            fallbackMonitorAfterSnapshotAlreadyProcessed: true
          });

          return {
            ok: monitorResult?.ok !== false,
            skipped: true,
            skippedNewEntries: true,
            reason: 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY',
            skipReason: 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY',
            fallbackMonitorAfterSnapshotAlreadyProcessed: true,
            rawMainBeforeFallback: mainResult,
            result: {
              ...unwrapRunResult(monitorResult),
              reason: 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY',
              skipReason: 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY',
              skipped: true,
              skippedNewEntries: true,
              processScannerSnapshot: false,
              snapshotAlreadyProcessed: true,
              entriesBlockedBecauseSnapshotAlreadyProcessed: true
            }
          };
        }

        return mainResult;
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

    const rawMonitorPayload = rawMonitorPreflight
      ? unwrapRunResult(rawMonitorPreflight)
      : null;

    const monitorPreflightPayload = rawMonitorPayload
      ? compactRunPayload(rawMonitorPayload, { debug })
      : null;

    const monitorPreflight = compactMonitorPreflightPayload(monitorPreflightPayload);

    const payload = compactRunPayload(unwrapRunResult(rawResult), { debug });

    phase = 'PERSIST_SHORT_RUN_META';

    const persistence = await persistShortRunMeta(
      durableRedis,
      payload,
      rawResult,
      scannerPreload,
      monitorPreflight,
      snapshotMode
    );

    const actionCounts = mergeActionCounts(
      payload?.actionCounts || {},
      monitorPreflightPayload?.actionCounts || {}
    );

    const counts = responseCountsFromPayload(payload, monitorPreflightPayload);

    const scannerOk = scannerPreload?.ok !== false;
    const scannerSkipped = scannerPreload?.skipped === true;
    const tradeOk = responseOk(rawResult);

    const monitorPreflightOk = monitorPreflight
      ? monitorPreflight.ok !== false
      : null;

    const totalVirtualExitRows =
      safeNumber(payload?.virtualExitRows, 0) +
      safeNumber(monitorPreflightPayload?.virtualExitRows, 0);

    const totalShadowExitRows =
      safeNumber(payload?.shadowExitRows, 0) +
      safeNumber(monitorPreflightPayload?.shadowExitRows, 0);

    const effectiveReason =
      snapshotMode?.entriesBlockedBecauseSnapshotAlreadyProcessed
        ? 'SNAPSHOT_ALREADY_PROCESSED_MONITOR_ONLY'
        : !scannerOk
          ? 'SCANNER_PRELOAD_FAILED'
          : monitorPreflightOk === false
            ? 'MONITOR_PREFLIGHT_FAILED'
            : responseReason(rawResult);

    phase = 'SEND_SUCCESS_RESPONSE';

    return res.status(200).json({
      ok: tradeOk && scannerOk && monitorPreflightOk !== false,
      tradeOk,
      scannerPreloadOk: scannerOk,
      scannerPreloadSkipped: scannerSkipped,
      scannerPreloadEnabled,

      monitorPreflightEnabled,
      monitorPreflightOk,
      monitorPreflight,
      monitorPreflightVirtualExitRows: safeNumber(monitorPreflightPayload?.virtualExitRows, 0),
      monitorPreflightShadowExitRows: safeNumber(monitorPreflightPayload?.shadowExitRows, 0),
      totalVirtualExitRowsThisRequest: totalVirtualExitRows,
      totalShadowExitRowsThisRequest: totalShadowExitRows,

      skipped: responseSkipped(rawResult) || Boolean(snapshotMode?.entriesBlockedBecauseSnapshotAlreadyProcessed),
      skippedNewEntries: Boolean(snapshotMode?.entriesBlockedBecauseSnapshotAlreadyProcessed || payload?.skippedNewEntries),
      reason: effectiveReason,
      skipReason: payload?.skipReason || effectiveReason,

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

      snapshotMode: {
        ...snapshotMode,
        rawMainBeforeFallbackReason: rawMainBeforeFallback
          ? unwrapRunResult(rawMainBeforeFallback)?.reason ||
            unwrapRunResult(rawMainBeforeFallback)?.skipReason ||
            null
          : null,
        fallbackMonitorAfterSnapshotSkip: Boolean(fallbackMonitorAfterSnapshotSkip)
      },

      force: mainRunOptions?.force ?? shouldForceProcessSnapshot(req, body),
      forceProcessSnapshot: mainRunOptions?.forceProcessSnapshot ?? shouldForceProcessSnapshot(req, body),
      monitorOnly: mainRunOptions?.monitorOnly ?? requestedMonitorOnly,
      monitorOpenPositionsFirst: mainRunOptions?.monitorOpenPositionsFirst ?? true,
      monitorOpenPositions: mainRunOptions?.monitorOpenPositions ?? true,
      processScannerSnapshot: mainRunOptions?.processScannerSnapshot ?? true,

      monitorTimeoutMs: mainRunOptions?.monitorTimeoutMs ?? getMonitorTimeoutMs(req, body, requestedMonitorOnly),
      openPositionMonitorTimeoutMs: mainRunOptions?.openPositionMonitorTimeoutMs ?? getMonitorTimeoutMs(req, body, requestedMonitorOnly),
      monitorBatchSize: mainRunOptions?.monitorBatchSize ?? getMonitorBatchSize(req, body),
      openPositionMonitorLimit: mainRunOptions?.openPositionMonitorLimit ?? getOpenPositionMonitorLimit(req, body),
      maxRuntimeMs: mainRunOptions?.maxRuntimeMs ?? getMaxRuntimeMs(req, body, requestedMonitorOnly),
      maxCandidatesPerSnapshot: mainRunOptions?.maxCandidatesPerSnapshot ?? getMaxCandidatesPerSnapshot(req, body),
      hardMaxCandidatesPerSnapshot: mainRunOptions?.hardMaxCandidatesPerSnapshot ?? getMaxCandidatesPerSnapshot(req, body),

      scannerPreload: debug
        ? scannerPreload
        : {
            ok: scannerPreload?.ok !== false,
            skipped: scannerSkipped,
            reason: scannerPreload?.reason || null,
            durationMs: scannerPreload?.durationMs || null,
            scanner: scannerPreload?.scanner || null,
            mirror: scannerPreload?.mirror
              ? {
                  ok: scannerPreload.mirror.ok,
                  marketWeatherMirrored: scannerPreload.mirror.marketWeatherMirrored,
                  marketUniverseMirrored: scannerPreload.mirror.marketUniverseMirrored
                }
              : null
          },

      marketWeatherAvailableAfterRun: scannerPreload?.mirror?.marketWeatherMirrored === true,
      marketUniverseAvailableAfterRun: scannerPreload?.mirror?.marketUniverseMirrored === true,

      runId: responseRunId(rawResult),
      snapshotId: responseSnapshotId(rawResult),

      entryRows: safeNumber(payload?.entryRows, 0),
      waitRows: safeNumber(payload?.waitRows, 0),
      virtualCreatedRows: safeNumber(payload?.virtualCreatedRows, 0),

      entryRowsList: debug && Array.isArray(payload?.entryRowsList)
        ? payload.entryRowsList
        : [],

      waitRowsList: debug && Array.isArray(payload?.waitRowsList)
        ? payload.waitRowsList
        : [],

      virtualCreatedRowsList: debug && Array.isArray(payload?.virtualCreatedRowsList)
        ? payload.virtualCreatedRowsList
        : [],

      virtualExitRows: safeNumber(payload?.virtualExitRows, 0),
      shadowExitRows: safeNumber(payload?.shadowExitRows, 0),

      virtualExits: debug && Array.isArray(payload?.virtualExits)
        ? payload.virtualExits
        : [],

      shadowExits: debug && Array.isArray(payload?.shadowExits)
        ? payload.shadowExits
        : [],

      realExits: [],

      actionCounts,
      counts,

      activeRotationId: payload?.activeRotationId || null,
      selectedRotationId: payload?.selectedRotationId || payload?.activeRotationId || null,

      activeMicroFamilies: safeNumber(payload?.activeMicroFamilies, 0),
      activeMicroMicroFamilies: safeNumber(payload?.activeMicroMicroFamilies, 0),

      activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds
        : [],

      selectedMicroFamilyIds: Array.isArray(payload?.selectedMicroFamilyIds)
        ? payload.selectedMicroFamilyIds
        : [],

      activeMicroMicroFamilyIds: Array.isArray(payload?.activeMicroMicroFamilyIds)
        ? payload.activeMicroMicroFamilyIds
        : [],

      selectedMicroMicroFamilyIds: Array.isArray(payload?.selectedMicroMicroFamilyIds)
        ? payload.selectedMicroMicroFamilyIds
        : [],

      selectedSnapshotSource: payload?.selectedSnapshotSource || snapshotMode?.latestSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: safeNumber(
        payload?.selectedTargetCandidateCount,
        snapshotMode?.latestSelectedTargetCandidateCount || 0
      ),
      selectedOppositeCandidateCount: 0,

      scannerPreloadBeforeTrade: scannerPreloadEnabled,
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
        marketUniverseLatest: MARKET_UNIVERSE_KEY,
        shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
        marketWeatherLatest: MARKET_WEATHER_KEY,
        shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
      },

      warnings: [
        forceUnlock
          ? 'FORCE_UNLOCK_ENABLED_FOR_THIS_REQUEST'
          : null,
        snapshotMode?.entriesBlockedBecauseSnapshotAlreadyProcessed
          ? 'SNAPSHOT_ALREADY_PROCESSED_ENTRIES_BLOCKED_MONITOR_STILL_RAN'
          : null,
        fallbackMonitorAfterSnapshotSkip
          ? 'TRADE_SYSTEM_RETURNED_SNAPSHOT_ALREADY_PROCESSED_FALLBACK_MONITOR_RAN'
          : null,
        monitorPreflightEnabled
          ? 'MONITOR_PREFLIGHT_ENABLED_EXPLICITLY'
          : 'MONITOR_PREFLIGHT_DISABLED_DEFAULT_TO_AVOID_VERCEL_TIMEOUT',
        monitorPreflightOk === false
          ? 'MONITOR_PREFLIGHT_FAILED_ENTRIES_MAY_STILL_BLOCK_ON_EXISTING_SYMBOLS'
          : null,
        !scannerPreloadEnabled
          ? 'SCANNER_PRELOAD_DISABLED_FAST_TRADE_RUN_USE_API_SCANNER_RUN_SEPARATELY_OR_QUERY_SCANNERPRELOAD_TRUE'
          : null,
        scannerPreload?.ok === false
          ? `SCANNER_PRELOAD_FAILED:${scannerPreload.error || 'UNKNOWN'}`
          : null,
        scannerPreloadEnabled && scannerPreload?.mirror?.marketWeatherMirrored !== true
          ? 'MARKET_WEATHER_NOT_MIRRORED_TO_DURABLE'
          : null,
        payload?.skippedByExistingSymbol > 0
          ? `SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION:${payload.skippedByExistingSymbol}`
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
      rawMainBeforeFallback: debug && rawMainBeforeFallback
        ? compactRunPayload(unwrapRunResult(rawMainBeforeFallback), { debug: false })
        : undefined,
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

    return res.status(resolveStatus(error)).json(errorResponse({
      error,
      phase,
      startedAt,
      debug,
      lockKey,
      lockReleasedAfterError,
      failureMeta
    }));
  }
}