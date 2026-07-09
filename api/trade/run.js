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

const TRADE_RUN_ROUTE_VERSION =
  'SHORT_API_TRADE_RUN_V12_HARD_RETURN_28S_NO_UNBOUNDED_ROUTE_IO';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';

const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MARKET_UNIVERSE_KEY =
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

const MARKET_WEATHER_KEY =
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;

const DEFAULT_ROUTE_SOFT_TIMEOUT_MS = 28_000;
const MIN_ROUTE_SOFT_TIMEOUT_MS = 15_000;
const MAX_ROUTE_SOFT_TIMEOUT_MS = 32_000;

const DEFAULT_TRADE_RUNTIME_MS = 20_000;
const DEFAULT_MONITOR_ONLY_RUNTIME_MS = 16_000;

const DEFAULT_LOCK_TTL_SEC = 45;
const DEFAULT_STALE_LOCK_AFTER_SEC = 35;

const DEFAULT_MAX_CANDIDATES = 4;
const DEFAULT_MAX_ENTRIES = 4;

const DEFAULT_MONITOR_TIMEOUT_MS = 1_800;
const DEFAULT_MONITOR_BATCH_SIZE = 15;
const DEFAULT_OPEN_POSITION_LIMIT = 25;

const IMPORT_TIMEOUT_MS = 4_500;
const BODY_TIMEOUT_MS = 1_500;
const REDIS_TIMEOUT_MS = 650;
const LOCK_TIMEOUT_MS = 900;

const MAX_DEBUG_ROWS = 30;

let CORE_PROMISE = null;
let TRADE_SYSTEM_PROMISE = null;

function now() {
  return Date.now();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function int(
  value,
  fallback,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
) {
  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(number(value, fallback))
    )
  );
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function bool(value, fallback = false) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const raw = String(value)
    .trim()
    .toLowerCase();

  if (
    [
      'true',
      '1',
      'yes',
      'y',
      'on',
      'force',
      'forced'
    ].includes(raw)
  ) {
    return true;
  }

  if (
    [
      'false',
      '0',
      'no',
      'n',
      'off',
      'disabled',
      'skip'
    ].includes(raw)
  ) {
    return false;
  }

  return fallback;
}

function first(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ''
  );
}

function compactText(value, max = 1800) {
  const text = String(value || '');

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}...TRUNCATED`;
}

function errorMessage(error) {
  return compactText(
    error?.message ||
      error ||
      'UNKNOWN_ERROR'
  );
}

function timeoutMarker(stage, timeoutMs) {
  return {
    __routeTimeout: true,
    stage,
    timeoutMs
  };
}

function isTimeoutMarker(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.__routeTimeout === true
  );
}

async function bounded(
  promise,
  timeoutMs,
  fallback
) {
  let timer = null;

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        resolve(
          typeof fallback === 'function'
            ? fallback()
            : fallback
        );
      },
      Math.max(
        1,
        int(timeoutMs, 1, 1, 60_000)
      )
    );
  });

  try {
    return await Promise.race([
      Promise.resolve(promise),
      timeoutPromise
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function makeTimeoutError(stage, timeoutMs) {
  const error = new Error(
    `${stage}_TIMEOUT_AFTER_${timeoutMs}MS`
  );

  error.code = 'ROUTE_STAGE_TIMEOUT';
  error.stage = stage;
  error.timeoutMs = timeoutMs;

  return error;
}

async function boundedRequired(
  promise,
  timeoutMs,
  stage
) {
  const result = await bounded(
    promise,
    timeoutMs,
    () => timeoutMarker(stage, timeoutMs)
  );

  if (isTimeoutMarker(result)) {
    throw makeTimeoutError(
      stage,
      timeoutMs
    );
  }

  return result;
}

function parseJson(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error(
      'INVALID_JSON_BODY'
    );

    error.statusCode = 400;

    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') {
    return {};
  }

  if (
    req.body !== undefined &&
    req.body !== null
  ) {
    if (typeof req.body === 'string') {
      return parseJson(req.body);
    }

    if (Buffer.isBuffer(req.body)) {
      return parseJson(
        req.body.toString('utf8')
      );
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return parseJson(
    Buffer
      .concat(chunks)
      .toString('utf8')
  );
}

async function loadCoreModules() {
  if (!CORE_PROMISE) {
    CORE_PROMISE = Promise.all([
      import('../../src/config.js'),
      import('../../src/keys.js'),
      import('../../src/redis.js')
    ]).then(
      ([
        configModule,
        keysModule,
        redisModule
      ]) => ({
        CONFIG:
          configModule.CONFIG || {},

        KEYS:
          keysModule.KEYS || {},

        redis:
          redisModule
      })
    );
  }

  return boundedRequired(
    CORE_PROMISE,
    IMPORT_TIMEOUT_MS,
    'LOAD_CORE_MODULES'
  );
}

async function loadTradeSystemModule() {
  if (!TRADE_SYSTEM_PROMISE) {
    TRADE_SYSTEM_PROMISE =
      import(
        '../../src/trade/tradeSystem.js'
      ).then((module) => {
        if (
          typeof module.runTradeSystem !==
          'function'
        ) {
          const error = new Error(
            'RUN_TRADE_SYSTEM_EXPORT_MISSING'
          );

          error.availableExports =
            Object.keys(
              module || {}
            );

          throw error;
        }

        return module;
      });
  }

  return boundedRequired(
    TRADE_SYSTEM_PROMISE,
    IMPORT_TIMEOUT_MS,
    'LOAD_TRADE_SYSTEM_MODULE'
  );
}

function queryValue(req, ...keys) {
  for (const key of keys) {
    const value = req.query?.[key];

    if (Array.isArray(value)) {
      if (
        value[0] !== undefined &&
        value[0] !== null &&
        value[0] !== ''
      ) {
        return value[0];
      }
    } else if (
      value !== undefined &&
      value !== null &&
      value !== ''
    ) {
      return value;
    }
  }

  return undefined;
}

function requestValue(
  req,
  body,
  queryKeys,
  bodyKeys
) {
  const fromQuery = queryValue(
    req,
    ...queryKeys
  );

  if (
    fromQuery !== undefined &&
    fromQuery !== null &&
    fromQuery !== ''
  ) {
    return fromQuery;
  }

  for (const key of bodyKeys) {
    const value = body?.[key];

    if (
      value !== undefined &&
      value !== null &&
      value !== ''
    ) {
      return value;
    }
  }

  return undefined;
}

function shouldDebug(req, body) {
  return bool(
    requestValue(
      req,
      body,
      [
        'debug',
        'details',
        'full'
      ],
      [
        'debug',
        'details',
        'full'
      ]
    ),
    false
  );
}

function shouldForce(req, body) {
  return bool(
    requestValue(
      req,
      body,
      [
        'force',
        'forced',
        'forceProcessSnapshot',
        'force_process_snapshot'
      ],
      [
        'force',
        'forced',
        'forceProcessSnapshot',
        'force_process_snapshot'
      ]
    ),
    false
  );
}

function shouldMonitorOnly(req, body) {
  return bool(
    requestValue(
      req,
      body,
      [
        'monitorOnly',
        'monitor_only'
      ],
      [
        'monitorOnly',
        'monitor_only'
      ]
    ),
    false
  );
}

function shouldUnlockOnly(req, body) {
  return bool(
    requestValue(
      req,
      body,
      [
        'unlockOnly',
        'unlock_only'
      ],
      [
        'unlockOnly',
        'unlock_only'
      ]
    ),
    false
  );
}

function shouldForceUnlock(req, body) {
  return Boolean(
    shouldForce(req, body) ||
    bool(
      requestValue(
        req,
        body,
        [
          'forceUnlock',
          'force_unlock',
          'clearLock',
          'clear_lock',
          'unlock'
        ],
        [
          'forceUnlock',
          'force_unlock',
          'clearLock',
          'clear_lock',
          'unlock'
        ]
      ),
      false
    )
  );
}

function getRouteSoftTimeoutMs(
  req,
  body,
  CONFIG
) {
  return int(
    first(
      requestValue(
        req,
        body,
        [
          'routeSoftTimeoutMs',
          'route_soft_timeout_ms',
          'softTimeoutMs',
          'soft_timeout_ms'
        ],
        [
          'routeSoftTimeoutMs',
          'route_soft_timeout_ms',
          'softTimeoutMs',
          'soft_timeout_ms'
        ]
      ),

      CONFIG.short
        ?.trade
        ?.routeSoftTimeoutMs,

      DEFAULT_ROUTE_SOFT_TIMEOUT_MS
    ),

    DEFAULT_ROUTE_SOFT_TIMEOUT_MS,

    MIN_ROUTE_SOFT_TIMEOUT_MS,

    MAX_ROUTE_SOFT_TIMEOUT_MS
  );
}

function shortKey(
  value,
  fallback
) {
  let raw = String(
    value || fallback || ''
  ).trim();

  if (!raw) {
    return `${SHORT_KEY_PREFIX}${fallback}`;
  }

  if (
    raw.startsWith(
      SHORT_KEY_PREFIX
    )
  ) {
    return raw;
  }

  if (
    raw.startsWith(
      'LONG:'
    )
  ) {
    raw = raw.slice(
      'LONG:'.length
    );
  }

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function buildKeys(KEYS = {}) {
  return {
    tradeLock: shortKey(
      first(
        KEYS.short
          ?.trade
          ?.lock,

        KEYS.trade
          ?.shortLock,

        KEYS.trade
          ?.lock
      ),

      'TRADE:LOCK'
    ),

    tradeRunMeta: shortKey(
      first(
        KEYS.short
          ?.trade
          ?.runMeta,

        KEYS.trade
          ?.shortRunMeta,

        KEYS.trade
          ?.runMeta
      ),

      'TRADE:RUN:META'
    ),

    lastProcessedSnapshot:
      shortKey(
        first(
          KEYS.short
            ?.trade
            ?.lastProcessedSnapshot,

          KEYS.trade
            ?.shortLastProcessedSnapshot,

          KEYS.trade
            ?.lastProcessedSnapshot
        ),

        'TRADE:LAST_PROCESSED_SNAPSHOT'
      )
  };
}

function getDurableRedis(core) {
  try {
    if (
      typeof
      core.redis
        ?.getDurableRedis !==
      'function'
    ) {
      return null;
    }

    return core.redis
      .getDurableRedis();
  } catch {
    return null;
  }
}

async function redisGet(
  redis,
  key
) {
  if (
    !redis ||
    !key ||
    typeof redis.get !== 'function'
  ) {
    return null;
  }

  return bounded(
    redis.get(key)
      .catch(() => null),

    REDIS_TIMEOUT_MS,

    null
  );
}

async function redisTtl(
  redis,
  key
) {
  if (
    !redis ||
    !key ||
    typeof redis.ttl !== 'function'
  ) {
    return null;
  }

  return bounded(
    redis.ttl(key)
      .catch(() => null),

    REDIS_TIMEOUT_MS,

    null
  );
}

async function redisDelete(
  redis,
  key
) {
  if (
    !redis ||
    !key ||
    typeof redis.del !== 'function'
  ) {
    return false;
  }

  const result = await bounded(
    redis.del(key)
      .then(() => true)
      .catch(() => false),

    REDIS_TIMEOUT_MS,

    false
  );

  return result === true;
}

async function redisSetNx(
  redis,
  key,
  value,
  ttlSec
) {
  if (
    !redis ||
    !key ||
    typeof redis.set !== 'function'
  ) {
    return false;
  }

  const serialized =
    typeof value === 'string'
      ? value
      : JSON.stringify(value);

  const modernResult =
    await bounded(
      redis
        .set(
          key,
          serialized,
          {
            nx: true,
            ex: ttlSec
          }
        )
        .catch(
          () => null
        ),

      REDIS_TIMEOUT_MS,

      null
    );

  if (
    modernResult === 'OK' ||
    modernResult === true ||
    modernResult?.ok === true
  ) {
    return true;
  }

  const legacyResult =
    await bounded(
      redis
        .set(
          key,
          serialized,
          'EX',
          ttlSec,
          'NX'
        )
        .catch(
          () => null
        ),

      REDIS_TIMEOUT_MS,

      null
    );

  return Boolean(
    legacyResult === 'OK' ||
    legacyResult === true ||
    legacyResult?.ok === true
  );
}

function parseLock(raw) {
  if (!raw) {
    return null;
  }

  if (
    typeof raw ===
    'object'
  ) {
    return raw;
  }

  try {
    return JSON.parse(
      String(raw)
    );
  } catch {
    return {
      token:
        String(raw)
    };
  }
}

async function readLock(
  redis,
  key
) {
  const [
    raw,
    ttl
  ] = await Promise.all([
    redisGet(
      redis,
      key
    ),

    redisTtl(
      redis,
      key
    )
  ]);

  const parsed =
    parseLock(raw);

  if (!parsed) {
    return {
      exists: false,
      ttlSec:
        Number.isFinite(
          Number(ttl)
        )
          ? Number(ttl)
          : null
    };
  }

  const createdAt =
    number(
      parsed.createdAt,
      0
    );

  return {
    exists: true,

    token:
      parsed.token ||
      null,

    runId:
      parsed.runId ||
      null,

    createdAt,

    ageSec:
      createdAt > 0
        ? Math.floor(
            (
              now() -
              createdAt
            ) /
            1000
          )
        : null,

    expiresAt:
      number(
        parsed.expiresAt,
        0
      ),

    ttlSec:
      Number.isFinite(
        Number(ttl)
      )
        ? Number(ttl)
        : null
  };
}

function staleLock(
  state
) {
  if (
    !state?.exists
  ) {
    return false;
  }

  if (
    Number.isFinite(
      state.ageSec
    ) &&
    state.ageSec >=
      DEFAULT_STALE_LOCK_AFTER_SEC
  ) {
    return true;
  }

  if (
    Number.isFinite(
      state.ttlSec
    ) &&
    state.ttlSec <= 0
  ) {
    return true;
  }

  if (
    state.expiresAt > 0 &&
    state.expiresAt <= now()
  ) {
    return true;
  }

  return false;
}

async function acquireLock(
  redis,
  key,
  forceUnlock
) {
  const runId =
    `short_trade_${now()}_${Math.random()
      .toString(16)
      .slice(2, 10)}`;

  const token =
    `${runId}_${Math.random()
      .toString(16)
      .slice(2, 12)}`;

  const createdAt =
    now();

  const lockValue = {
    token,
    runId,
    createdAt,

    expiresAt:
      createdAt +
      DEFAULT_LOCK_TTL_SEC *
        1000,

    ttlSec:
      DEFAULT_LOCK_TTL_SEC,

    namespace:
      SHORT_NAMESPACE,

    routeVersion:
      TRADE_RUN_ROUTE_VERSION
  };

  let state =
    await bounded(
      readLock(
        redis,
        key
      ),

      LOCK_TIMEOUT_MS,

      {
        exists: false,
        readTimedOut: true
      }
    );

  if (
    state.exists &&
    (
      forceUnlock ||
      staleLock(state)
    )
  ) {
    await redisDelete(
      redis,
      key
    );

    state = {
      exists: false
    };
  }

  let acquired =
    await bounded(
      redisSetNx(
        redis,
        key,
        lockValue,
        DEFAULT_LOCK_TTL_SEC
      ),

      LOCK_TIMEOUT_MS,

      false
    );

  if (!acquired) {
    const after =
      await bounded(
        readLock(
          redis,
          key
        ),

        LOCK_TIMEOUT_MS,

        {
          exists: true,
          readTimedOut: true
        }
      );

    if (
      after.token === token
    ) {
      acquired = true;
    } else {
      return {
        acquired: false,
        reason:
          'TRADE_RUN_LOCK_ACTIVE',

        state:
          after,

        lockValue
      };
    }
  }

  return {
    acquired: true,

    reason:
      'TRADE_RUN_LOCK_ACQUIRED',

    lockValue,

    state:
      await bounded(
        readLock(
          redis,
          key
        ),

        LOCK_TIMEOUT_MS,

        null
      )
  };
}

async function releaseOwnLock(
  redis,
  key,
  lockValue
) {
  const state =
    await bounded(
      readLock(
        redis,
        key
      ),

      LOCK_TIMEOUT_MS,

      null
    );

  if (
    !state ||
    !state.exists
  ) {
    return {
      released: false,
      reason:
        'LOCK_ALREADY_GONE'
    };
  }

  if (
    state.token !==
    lockValue.token
  ) {
    return {
      released: false,
      reason:
        'LOCK_NOT_OWNED'
    };
  }

  const deleted =
    await redisDelete(
      redis,
      key
    );

  return {
    released:
      deleted,

    reason:
      deleted
        ? 'LOCK_RELEASED'
        : 'LOCK_RELEASE_TIMEOUT_OR_FAILED'
  };
}

function baseFlags() {
  return {
    tradeRunRouteVersion:
      TRADE_RUN_ROUTE_VERSION,

    targetTradeSide:
      TARGET_TRADE_SIDE,

    targetScannerSide:
      TARGET_SCANNER_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    oppositeTradeSide:
      OPPOSITE_TRADE_SIDE,

    side:
      TARGET_DASHBOARD_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    shortOnly:
      true,

    longDisabled:
      true,

    virtualOnly:
      true,

    virtualLearning:
      true,

    realOrdersDisabled:
      true,

    exchangeOrdersDisabled:
      true,

    bitgetOrdersDisabled:
      true,

    noRealOrders:
      true,

    namespace:
      SHORT_NAMESPACE,

    redisNamespace:
      SHORT_NAMESPACE,

    redisKeyPrefix:
      SHORT_KEY_PREFIX,

    persistentLearningKey:
      PERSISTENT_LEARNING_KEY,

    learningIdentitySource:
      'ANALYZE_MICRO_MICRO_FAMILY',

    selectionGranularity:
      'EXACT_MICRO_MICRO_ONLY',

    trueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    microMicroFamilySchema:
      MICRO_MICRO_SCHEMA,

    microMicroLearningGranularity:
      MICRO_MICRO_LEARNING_GRANULARITY,

    routeSoftTimeoutPreventsVercel504:
      true,

    routeHasNoUnboundedRedisWait:
      true,

    duplicateRoutePersistenceDisabled:
      true,

    tradeSystemOwnsRunMetaPersistence:
      true
  };
}

function setHeaders(res) {
  res.setHeader(
    'Cache-Control',
    'no-store, max-age=0'
  );

  res.setHeader(
    'X-Trade-Run-Route-Version',
    TRADE_RUN_ROUTE_VERSION
  );

  res.setHeader(
    'X-Trade-Target-Side',
    TARGET_TRADE_SIDE
  );

  res.setHeader(
    'X-Short-Only',
    'true'
  );

  res.setHeader(
    'X-Virtual-Only',
    'true'
  );

  res.setHeader(
    'X-No-Real-Orders',
    'true'
  );

  res.setHeader(
    'X-Route-Soft-Timeout-Ms',
    String(
      DEFAULT_ROUTE_SOFT_TIMEOUT_MS
    )
  );
}

function buildRunOptions(
  req,
  body,
  debug
) {
  const force =
    shouldForce(
      req,
      body
    );

  const monitorOnly =
    shouldMonitorOnly(
      req,
      body
    );

  return {
    force,
    forceProcessSnapshot:
      force,

    monitorOnly,

    runPhase:
      monitorOnly
        ? 'MONITOR_ONLY'
        : 'TRADE_MAIN',

    tradeRunPhase:
      monitorOnly
        ? 'MONITOR_ONLY'
        : 'TRADE_MAIN',

    maxRuntimeMs:
      monitorOnly
        ? DEFAULT_MONITOR_ONLY_RUNTIME_MS
        : DEFAULT_TRADE_RUNTIME_MS,

    hardReturnReserveMs:
      2_800,

    maxCandidatesPerSnapshot:
      monitorOnly
        ? 1
        : DEFAULT_MAX_CANDIDATES,

    analyzeMaxCandidatesPerSnapshot:
      monitorOnly
        ? 1
        : DEFAULT_MAX_CANDIDATES,

    hardMaxCandidatesPerSnapshot:
      DEFAULT_MAX_CANDIDATES,

    maxEntriesPerRun:
      monitorOnly
        ? 0
        : DEFAULT_MAX_ENTRIES,

    dataConcurrency:
      1,

    monitorOpenPositions:
      true,

    monitorOpenPositionsEnabled:
      true,

    monitorOpenPositionsFirst:
      true,

    monitorTimeoutMs:
      DEFAULT_MONITOR_TIMEOUT_MS,

    monitorPriceFetchTimeoutMs:
      220,

    monitorLivePriceFetchEnabled:
      false,

    monitorCandleRangeEnabled:
      true,

    monitorBatchSize:
      DEFAULT_MONITOR_BATCH_SIZE,

    openPositionMonitorLimit:
      DEFAULT_OPEN_POSITION_LIMIT,

    maxOpenPositionsToMonitor:
      DEFAULT_OPEN_POSITION_LIMIT,

    openPositionLoadTimeoutMs:
      800,

    candidateTimeoutMs:
      700,

    analyzeTimeoutMs:
      1_800,

    marketContextTimeoutMs:
      500,

    snapshotTimeoutMs:
      700,

    rotationTimeoutMs:
      500,

    savePositionTimeoutMs:
      550,

    redisWriteTimeoutMs:
      550,

    discordTimeoutMs:
      700,

    minEntryLoopAttempts:
      1,

    entryLoopReserveMs:
      2_800,

    skipMonitorWhenSameSnapshotProcessed:
      false,

    allowDeepSnapshotSearch:
      false,

    scannerPreloadBeforeTrade:
      false,

    marketWeatherPreloadBeforeTrade:
      false,

    processScannerSnapshot:
      !monitorOnly,

    hardTimeStopNoPriceExit:
      true,

    closeExpiredBeforePriceFetch:
      true,

    targetTradeSide:
      TARGET_TRADE_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    side:
      TARGET_DASHBOARD_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    scannerSide:
      TARGET_SCANNER_SIDE,

    actualScannerSide:
      TARGET_SCANNER_SIDE,

    shortOnly:
      true,

    longDisabled:
      true,

    virtualOnly:
      true,

    virtualLearning:
      true,

    realOrdersDisabled:
      true,

    exchangeOrdersDisabled:
      true,

    bitgetOrdersDisabled:
      true,

    exchangeCallsDisabled:
      true,

    noRealOrders:
      true,

    noExchangeOrders:
      true,

    namespace:
      SHORT_NAMESPACE,

    keyPrefix:
      SHORT_KEY_PREFIX,

    redisNamespace:
      SHORT_NAMESPACE,

    redisKeyPrefix:
      SHORT_KEY_PREFIX,

    persistentLearningKey:
      PERSISTENT_LEARNING_KEY,

    weekKey:
      PERSISTENT_LEARNING_KEY,

    trueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    childTrueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    microMicroFamilySchema:
      MICRO_MICRO_SCHEMA,

    trueMicroMicroFamilySchema:
      MICRO_MICRO_SCHEMA,

    microMicroLearningGranularity:
      MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity:
      'EXACT_MICRO_MICRO_ONLY',

    microMicroSelectionGranularity:
      'EXACT_MICRO_MICRO_ONLY',

    learningIdentitySource:
      'ANALYZE_MICRO_MICRO_FAMILY',

    exactTrueMicroFamilyRequired:
      true,

    exactTrueMicroOnly:
      true,

    microMicroSelectionEnabled:
      true,

    scannerFingerprintsMetadataOnly:
      true,

    scannerFingerprintsUsedAsLearningFamily:
      false,

    executionFingerprintRole:
      'MICRO_MICRO_IDENTITY_HASH_SOURCE',

    executionFingerprintsUsedAsLearningFamily:
      false,

    symbolExcludedFromFamilyId:
      true,

    coinNameExcludedFromFamilyId:
      true,

    oneOpenPositionPerSymbol:
      true,

    maxOneOpenPositionPerSymbol:
      true,

    ignoreGlobalMaxOpenPositions:
      true,

    discordOnlyForSelectedMicroMicroFamilies:
      true,

    discordOnlyForExactMicroMicroMatch:
      true,

    manualSelectionMatchMode:
      'EXACT_MICRO_MICRO_ID',

    discordSelectionRule:
      'EXACT_MICRO_MICRO_ONLY',

    details:
      debug,

    debug:
      debug,

    full:
      false
  };
}

function compactIds(
  values,
  requireMicroMicro = false
) {
  return [
    ...new Set(
      (
        Array.isArray(values)
          ? values
          : []
      )
        .map(upper)
        .filter(
          (value) =>
            value.startsWith(
              'MICRO_SHORT_'
            )
        )
        .filter(
          (value) =>
            !value.includes(
              'MICRO_LONG_'
            )
        )
        .filter(
          (value) =>
            !value.includes(
              '_XR_'
            )
        )
        .filter(
          (value) =>
            !value.includes(
              'SCANNER'
            )
        )
        .filter(
          (value) =>
            !requireMicroMicro ||
            value.includes(
              '_MM_'
            )
        )
    )
  ].slice(
    0,
    100
  );
}

function compactAction(row) {
  if (
    !row ||
    typeof row !==
      'object'
  ) {
    return row;
  }

  return {
    action:
      row.action ||
      row.type ||
      null,

    reason:
      row.reason ||
      row.liveEntryBlockedReason ||
      null,

    symbol:
      row.symbol ||
      row.baseSymbol ||
      null,

    contractSymbol:
      row.contractSymbol ||
      null,

    microFamilyId:
      row.microFamilyId ||
      row.trueMicroFamilyId ||
      null,

    microMicroFamilyId:
      row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      null,

    entry:
      row.entry ??
      row.entryPrice ??
      null,

    sl:
      row.sl ??
      row.initialSl ??
      row.stopLoss ??
      null,

    tp:
      row.tp ??
      row.takeProfit ??
      null,

    rr:
      row.rr ??
      null,

    signalType:
      row.signalType ||
      null,

    netR:
      row.netR ??
      row.realizedR ??
      row.r ??
      null,

    exitReason:
      row.exitReason ||
      null,

    currentFit:
      row.currentFit ||
      row.entryCurrentFit ||
      null,

    discordAlertEligible:
      Boolean(
        row.discordAlertEligible
      )
  };
}

function compactPayload(
  payload,
  debug
) {
  const row =
    payload &&
    typeof payload ===
      'object'
      ? payload
      : {};

  const actions =
    Array.isArray(
      row.actions
    )
      ? row.actions
      : [];

  const exits =
    Array.isArray(
      row.virtualExits
    )
      ? row.virtualExits
      : Array.isArray(
          row.shadowExits
        )
        ? row.shadowExits
        : [];

  return {
    ok:
      row.ok !== false,

    degraded:
      Boolean(
        row.degraded
      ),

    skipped:
      Boolean(
        row.skipped
      ),

    skippedNewEntries:
      Boolean(
        row.skippedNewEntries
      ),

    reason:
      row.reason ||
      row.skipReason ||
      null,

    skipReason:
      row.skipReason ||
      row.reason ||
      null,

    error:
      row.error ||
      null,

    runId:
      row.runId ||
      null,

    startedAt:
      row.startedAt ||
      null,

    completedAt:
      row.completedAt ||
      null,

    durationMs:
      row.durationMs ??
      null,

    snapshotId:
      row.snapshotId ||
      null,

    snapshotCreatedAt:
      row.snapshotCreatedAt ||
      null,

    snapshotAgeSec:
      row.snapshotAgeSec ??
      null,

    selectedSnapshotSource:
      row.selectedSnapshotSource ||
      null,

    selectedSnapshotReason:
      row.selectedSnapshotReason ||
      null,

    candidates:
      number(
        row.candidates,
        0
      ),

    allShortCandidatesBeforeCap:
      number(
        row.allShortCandidatesBeforeCap,
        0
      ),

    processed:
      number(
        row.processed,
        0
      ),

    liveRows:
      number(
        row.liveRows,
        0
      ),

    riskValidRows:
      number(
        row.riskValidRows,
        0
      ),

    analyzedRows:
      number(
        row.analyzedRows,
        0
      ),

    analyzedMicroMicroRows:
      number(
        row.analyzedMicroMicroRows,
        0
      ),

    entryRows:
      number(
        row.entryRows,
        0
      ),

    waitRows:
      number(
        row.waitRows,
        0
      ),

    virtualCreatedRows:
      number(
        row.virtualCreatedRows,
        0
      ),

    virtualSkippedRows:
      number(
        row.virtualSkippedRows,
        0
      ),

    virtualFailedRows:
      number(
        row.virtualFailedRows,
        0
      ),

    virtualExitRows:
      number(
        row.virtualExitRows,
        exits.length
      ),

    shadowExitRows:
      number(
        row.shadowExitRows,
        exits.length
      ),

    openPositionCountBeforeEntries:
      row.openPositionCountBeforeEntries ??
      null,

    openPositionCountAfterEntries:
      row.openPositionCountAfterEntries ??
      null,

    weakContraRejectedRows:
      number(
        row.weakContraRejectedRows,
        0
      ),

    microMicroObservingRows:
      number(
        row.microMicroObservingRows,
        0
      ),

    microMicroPassedRows:
      number(
        row.microMicroPassedRows,
        0
      ),

    microMicroRejectedRows:
      number(
        row.microMicroRejectedRows,
        0
      ),

    microMicroEmpiricalVetoRows:
      number(
        row.microMicroEmpiricalVetoRows,
        0
      ),

    microMicroPolicyBlockedRows:
      number(
        row.microMicroPolicyBlockedRows,
        0
      ),

    tradeReadyRows:
      number(
        row.tradeReadyRows,
        0
      ),

    watchRows:
      number(
        row.watchRows,
        0
      ),

    observeRows:
      number(
        row.observeRows,
        0
      ),

    discordAlertsSent:
      number(
        row.discordAlertsSent,
        0
      ),

    discordAlertsFailed:
      number(
        row.discordAlertsFailed,
        0
      ),

    activeRotationId:
      row.activeRotationId ||
      null,

    selectedRotationId:
      row.selectedRotationId ||
      null,

    selectedMicroMicroFamilyIds:
      compactIds(
        row.selectedMicroMicroFamilyIds,
        true
      ),

    configuredSelectedMicroMicroFamilyIds:
      compactIds(
        row.configuredSelectedMicroMicroFamilyIds,
        true
      ),

    confirmedMarketWeatherKey:
      row.confirmedMarketWeatherKey ||
      null,

    currentEntryMarketWeatherKey:
      row.currentEntryMarketWeatherKey ||
      null,

    currentRegime:
      row.currentRegime ||
      null,

    currentTrendSide:
      row.currentTrendSide ||
      null,

    actionCounts:
      row.actionCounts ||
      {},

    qualityAudit:
      row.qualityAudit
        ? {
            profile:
              row.qualityAudit
                .profile ||
              null,

            primaryBottleneck:
              row.qualityAudit
                .primaryBottleneck ||
              null,

            pipelineCounts:
              row.qualityAudit
                .pipelineCounts ||
              null,

            conversionRatesPct:
              row.qualityAudit
                .conversionRatesPct ||
              null,

            topWaitReasons:
              Array.isArray(
                row.qualityAudit
                  .topWaitReasons
              )
                ? row.qualityAudit
                    .topWaitReasons
                    .slice(
                      0,
                      15
                    )
                : []
          }
        : null,

    runtimeWarnings:
      Array.isArray(
        row.runtimeWarnings
      )
        ? row.runtimeWarnings
            .slice(
              0,
              40
            )
        : [],

    entryRowsList:
      debug
        ? actions
            .filter(
              (action) =>
                action?.action ===
                'VIRTUAL_ENTRY'
            )
            .slice(
              0,
              MAX_DEBUG_ROWS
            )
            .map(
              compactAction
            )
        : [],

    waitRowsList:
      debug
        ? actions
            .filter(
              (action) =>
                action?.action ===
                'WAIT'
            )
            .slice(
              0,
              MAX_DEBUG_ROWS
            )
            .map(
              compactAction
            )
        : [],

    virtualExits:
      debug
        ? exits
            .slice(
              0,
              MAX_DEBUG_ROWS
            )
            .map(
              compactAction
            )
        : [],

    ...baseFlags()
  };
}

function routeTimeoutResponse({
  startedAt,
  routeSoftTimeoutMs,
  lockKey,
  lock
}) {
  return {
    ok: false,

    tradeOk:
      false,

    skipped:
      true,

    partial:
      true,

    routeSoftTimeout:
      true,

    routeSoftTimeoutBeforeVercel504:
      true,

    reason:
      'ROUTE_SOFT_TIMEOUT_BEFORE_VERCEL_504',

    skipReason:
      'ROUTE_SOFT_TIMEOUT_BEFORE_VERCEL_504',

    message:
      'De route heeft op tijd geantwoord. De lopende TradeSystem-taak krijgt geen extra route-persistence en de SHORT-lock verloopt automatisch via TTL.',

    routeSoftTimeoutMs,

    durationMs:
      now() -
      startedAt,

    completedAt:
      now(),

    lock: {
      key:
        lockKey,

      acquired:
        lock?.acquired ===
        true,

      released:
        false,

      releaseMode:
        'TASK_FINALLY_OR_TTL',

      ttlSec:
        DEFAULT_LOCK_TTL_SEC
    },

    warnings: [
      'VERCEL_504_PREVENTED',
      'NO_REDIS_WRITE_WAIT_AFTER_ROUTE_TIMEOUT',
      'NO_DUPLICATE_ROUTE_PERSISTENCE',
      'NEXT_CRON_RUN_CONTINUES_PROCESSING'
    ],

    ...baseFlags()
  };
}

function lockActiveResponse(
  startedAt,
  lockKey,
  lock,
  debug
) {
  return {
    ok:
      true,

    tradeOk:
      true,

    skipped:
      true,

    skippedNewEntries:
      true,

    reason:
      'TRADE_RUN_LOCK_ACTIVE',

    skipReason:
      'TRADE_RUN_LOCK_ACTIVE',

    message:
      'Een vorige SHORT trade-run is nog bezig. Deze cron-run is veilig overgeslagen.',

    lock: {
      key:
        lockKey,

      active:
        true,

      ttlSec:
        lock?.state
          ?.ttlSec ??
        null,

      ageSec:
        lock?.state
          ?.ageSec ??
        null,

      state:
        debug
          ? lock?.state
          : undefined
    },

    durationMs:
      now() -
      startedAt,

    completedAt:
      now(),

    ...baseFlags()
  };
}

function errorResponse(
  error,
  startedAt,
  phase,
  debug
) {
  const statusCode =
    number(
      error?.statusCode,
      200
    );

  return {
    status:
      statusCode >= 400 &&
      statusCode < 500
        ? statusCode
        : 200,

    payload: {
      ok:
        false,

      tradeOk:
        false,

      reason:
        'TRADE_RUN_CAUGHT_ERROR',

      error:
        errorMessage(
          error
        ),

      errorName:
        error?.name ||
        'Error',

      errorCode:
        error?.code ||
        null,

      phase,

      stack:
        debug
          ? compactText(
              error?.stack,
              8_000
            )
          : null,

      durationMs:
        now() -
        startedAt,

      completedAt:
        now(),

      ...baseFlags()
    }
  };
}

export default async function handler(
  req,
  res
) {
  setHeaders(res);

  const startedAt =
    now();

  let phase =
    'START';

  let body =
    {};

  let debug =
    false;

  let redis =
    null;

  let keys =
    buildKeys({});

  let lock =
    null;

  try {
    if (
      req.method !==
        'GET' &&
      req.method !==
        'POST'
    ) {
      res.setHeader(
        'Allow',
        'GET, POST'
      );

      return res
        .status(405)
        .json({
          ok:
            false,

          reason:
            'METHOD_NOT_ALLOWED',

          ...baseFlags()
        });
    }

    phase =
      'READ_BODY';

    body =
      await boundedRequired(
        readBody(req),

        BODY_TIMEOUT_MS,

        'READ_BODY'
      );

    debug =
      shouldDebug(
        req,
        body
      );

    phase =
      'LOAD_CORE';

    const core =
      await loadCoreModules();

    keys =
      buildKeys(
        core.KEYS
      );

    phase =
      'GET_REDIS';

    redis =
      getDurableRedis(
        core
      );

    if (!redis) {
      throw new Error(
        'DURABLE_REDIS_UNAVAILABLE'
      );
    }

    if (
      shouldUnlockOnly(
        req,
        body
      )
    ) {
      phase =
        'UNLOCK_ONLY';

      const stateBefore =
        await bounded(
          readLock(
            redis,
            keys.tradeLock
          ),

          LOCK_TIMEOUT_MS,

          null
        );

      const released =
        await redisDelete(
          redis,
          keys.tradeLock
        );

      return res
        .status(200)
        .json({
          ok:
            true,

          skipped:
            true,

          reason:
            'UNLOCK_ONLY',

          lock: {
            key:
              keys.tradeLock,

            released,

            stateBefore:
              debug
                ? stateBefore
                : undefined
          },

          durationMs:
            now() -
            startedAt,

          completedAt:
            now(),

          ...baseFlags()
        });
    }

    phase =
      'ACQUIRE_LOCK';

    lock =
      await boundedRequired(
        acquireLock(
          redis,

          keys.tradeLock,

          shouldForceUnlock(
            req,
            body
          )
        ),

        2_800,

        'ACQUIRE_TRADE_LOCK'
      );

    if (
      !lock.acquired
    ) {
      return res
        .status(200)
        .json(
          lockActiveResponse(
            startedAt,

            keys.tradeLock,

            lock,

            debug
          )
        );
    }

    phase =
      'LOAD_TRADE_SYSTEM';

    const {
      runTradeSystem
    } =
      await loadTradeSystemModule();

    const CONFIG =
      core.CONFIG || {};

    const routeSoftTimeoutMs =
      getRouteSoftTimeoutMs(
        req,
        body,
        CONFIG
      );

    const runOptions =
      buildRunOptions(
        req,
        body,
        debug
      );

    phase =
      'RUN_TRADE_SYSTEM';

    const tradeTask =
      (
        async () => {
          try {
            return await runTradeSystem(
              runOptions
            );
          } finally {
            await releaseOwnLock(
              redis,

              keys.tradeLock,

              lock.lockValue
            );
          }
        }
      )();

    const result =
      await bounded(
        tradeTask,

        routeSoftTimeoutMs,

        () =>
          timeoutMarker(
            'RUN_TRADE_SYSTEM',

            routeSoftTimeoutMs
          )
      );

    if (
      isTimeoutMarker(
        result
      )
    ) {
      phase =
        'ROUTE_SOFT_TIMEOUT';

      void tradeTask
        .catch(
          () => null
        );

      return res
        .status(200)
        .json(
          routeTimeoutResponse({
            startedAt,

            routeSoftTimeoutMs,

            lockKey:
              keys.tradeLock,

            lock
          })
        );
    }

    phase =
      'COMPACT_RESPONSE';

    const payload =
      compactPayload(
        result,

        debug
      );

    phase =
      'SEND_RESPONSE';

    return res
      .status(200)
      .json({
        ok:
          payload.ok !==
          false,

        tradeOk:
          payload.ok !==
          false,

        routeSoftTimeout:
          false,

        routeSoftTimeoutBeforeVercel504:
          false,

        routeSoftTimeoutMs,

        maxTradeRuntimeMs:
          runOptions
            .maxRuntimeMs,

        monitorTimeoutMs:
          runOptions
            .monitorTimeoutMs,

        monitorBatchSize:
          runOptions
            .monitorBatchSize,

        openPositionMonitorLimit:
          runOptions
            .openPositionMonitorLimit,

        maxCandidatesPerSnapshot:
          runOptions
            .maxCandidatesPerSnapshot,

        lock: {
          key:
            keys.tradeLock,

          acquired:
            true,

          releaseMode:
            'TRADE_TASK_FINALLY',

          ttlFallbackSec:
            DEFAULT_LOCK_TTL_SEC
        },

        keys: {
          tradeLock:
            keys.tradeLock,

          tradeRunMeta:
            keys.tradeRunMeta,

          lastProcessedSnapshot:
            keys.lastProcessedSnapshot,

          marketUniverse:
            MARKET_UNIVERSE_KEY,

          marketWeather:
            MARKET_WEATHER_KEY
        },

        run:
          payload,

        ...payload,

        durationMs:
          now() -
          startedAt,

        routeCompletedAt:
          now(),

        ...baseFlags()
      });
  } catch (error) {
    phase =
      `${phase}_CAUGHT`;

    try {
      if (
        redis &&
        lock?.acquired &&
        lock?.lockValue
      ) {
        await bounded(
          releaseOwnLock(
            redis,

            keys.tradeLock,

            lock.lockValue
          ),

          LOCK_TIMEOUT_MS,

          null
        );
      }
    } catch {
      // De foutresponse mag nooit worden geblokkeerd
      // door een lock-release.
    }

    const response =
      errorResponse(
        error,

        startedAt,

        phase,

        debug
      );

    return res
      .status(
        response.status
      )
      .json(
        response.payload
      );
  }
}