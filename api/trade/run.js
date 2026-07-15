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
  'SHORT_API_TRADE_RUN_V13_ABSOLUTE_24S_RETURN_LOW_REDIS_FANOUT_NO_DUPLICATE_PERSIST';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';

const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;

const ABSOLUTE_ROUTE_RETURN_MS = 24_000;
const ROUTE_RESPONSE_RESERVE_MS = 1_500;

const DEFAULT_ROUTE_SOFT_TIMEOUT_MS = 20_000; // verhoogd van 19s naar 20s
const MIN_ROUTE_SOFT_TIMEOUT_MS = 12_000;
const MAX_ROUTE_SOFT_TIMEOUT_MS = 21_000;

const DEFAULT_TRADE_RUNTIME_MS = 16_000; // verhoogd van 13s naar 16s
const DEFAULT_MONITOR_ONLY_RUNTIME_MS = 10_000;

// Learning-batch: 15 kandidaten per run
const DEFAULT_MAX_CANDIDATES = 15;
const DEFAULT_CANDIDATE_CHUNK_SIZE = 15;
const DEFAULT_MAX_ENTRIES = 2; // maximaal 2 virtuele entries per run
const DEFAULT_MONITOR_TIMEOUT_MS = 1_500; // iets ruimer
const DEFAULT_MONITOR_BATCH_SIZE = 6;
const DEFAULT_OPEN_POSITION_LIMIT = 6;

const DEFAULT_LOCK_TTL_SEC = 50;
const DEFAULT_STALE_LOCK_AFTER_SEC = 45;

// ===== NIEUW: Snapshot leeftijdsgrenzen =====
const MAX_SNAPSHOT_AGE_MS = 12 * 60 * 1000; // 12 minuten
const SNAPSHOT_WARN_AGE_MS = 8 * 60 * 1000; // 8 minuten

const IMPORT_TIMEOUT_MS = 3_500;
const BODY_TIMEOUT_MS = 1_200;
const REDIS_TIMEOUT_MS = 500;
const LOCK_STAGE_TIMEOUT_MS = 1_800;
const LOCK_RELEASE_TIMEOUT_MS = 750;

const MAX_DEBUG_ROWS = 20;

let CORE_PROMISE = null;
let TRADE_SYSTEM_PROMISE = null;

function now() {
  return Date.now();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function int(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(
        number(value, fallback)
      )
    )
  );
}

function upper(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
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
  const text = String(value ?? '');

  return text.length <= max
    ? text
    : `${text.slice(0, max)}...TRUNCATED`;
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

  const timeoutPromise =
    new Promise((resolve) => {
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
          int(
            timeoutMs,
            1,
            1,
            60_000
          )
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

function makeTimeoutError(
  stage,
  timeoutMs
) {
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
    () =>
      timeoutMarker(
        stage,
        timeoutMs
      )
  );

  if (isTimeoutMarker(result)) {
    throw makeTimeoutError(
      stage,
      timeoutMs
    );
  }

  return result;
}

function remainingRouteMs(
  startedAt,
  reserveMs = 0
) {
  return Math.max(
    0,
    ABSOLUTE_ROUTE_RETURN_MS -
      (now() - startedAt) -
      reserveMs
  );
}

function boundedByRoute(
  startedAt,
  requestedMs,
  reserveMs = ROUTE_RESPONSE_RESERVE_MS
) {
  return Math.max(
    1,
    Math.min(
      int(
        requestedMs,
        1,
        1,
        60_000
      ),
      remainingRouteMs(
        startedAt,
        reserveMs
      )
    )
  );
}

function parseJson(value) {
  const raw = String(value || '')
    .trim();

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

function getCorePromise() {
  if (!CORE_PROMISE) {
    CORE_PROMISE = Promise
      .all([
        import('../../src/config.js'),
        import('../../src/keys.js'),
        import('../../src/redis.js')
      ])
      .then(
        ([
          configModule,
          keysModule,
          redisModule
        ]) => ({
          CONFIG:
            configModule.CONFIG ||
            {},

          KEYS:
            keysModule.KEYS ||
            {},

          redis:
            redisModule
        })
      )
      .catch((error) => {
        CORE_PROMISE = null;
        throw error;
      });
  }

  return CORE_PROMISE;
}

async function loadCoreModules(startedAt) {
  return boundedRequired(
    getCorePromise(),
    boundedByRoute(
      startedAt,
      IMPORT_TIMEOUT_MS
    ),
    'LOAD_CORE_MODULES'
  );
}

function getTradeSystemPromise() {
  if (!TRADE_SYSTEM_PROMISE) {
    TRADE_SYSTEM_PROMISE =
      import(
        '../../src/trade/tradeSystem.js'
      )
        .then((module) => {
          if (
            typeof module.runTradeSystem !==
            'function'
          ) {
            const error = new Error(
              'RUN_TRADE_SYSTEM_EXPORT_MISSING'
            );

            error.availableExports =
              Object.keys(module || {});

            throw error;
          }

          return module;
        })
        .catch((error) => {
          TRADE_SYSTEM_PROMISE = null;
          throw error;
        });
  }

  return TRADE_SYSTEM_PROMISE;
}

async function loadTradeSystemModule(
  startedAt
) {
  return boundedRequired(
    getTradeSystemPromise(),
    boundedByRoute(
      startedAt,
      IMPORT_TIMEOUT_MS
    ),
    'LOAD_TRADE_SYSTEM_MODULE'
  );
}

function queryValue(
  req,
  ...keys
) {
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
  const fromQuery =
    queryValue(
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

function shouldDebug(
  req,
  body
) {
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

/*
 * force=true betekent alleen:
 * - run ondanks normale cooldown of reeds-verwerkt-controle;
 * - geen cursor-reset;
 * - geen automatische lock-delete.
 */
function shouldForce(
  req,
  body
) {
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

/*
 * Cursor resetten is een afzonderlijke, expliciete actie.
 * force=true mag deze optie nooit impliciet activeren.
 */
function shouldResetSnapshotCursor(
  req,
  body
) {
  return bool(
    requestValue(
      req,
      body,
      [
        'resetSnapshotCursor',
        'reset_snapshot_cursor',
        'resetCursor',
        'reset_cursor'
      ],
      [
        'resetSnapshotCursor',
        'reset_snapshot_cursor',
        'resetCursor',
        'reset_cursor'
      ]
    ),
    false
  );
}

function shouldMonitorOnly(
  req,
  body
) {
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

function shouldUnlockOnly(
  req,
  body
) {
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

/*
 * force=true verwijdert geen geldige actieve lock.
 * Alleen een expliciete unlockparameter mag dat doen.
 */
function shouldForceUnlock(
  req,
  body
) {
  return bool(
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

      CONFIG
        .short
        ?.trade
        ?.routeSoftTimeoutMs,

      DEFAULT_ROUTE_SOFT_TIMEOUT_MS
    ),
    DEFAULT_ROUTE_SOFT_TIMEOUT_MS,
    MIN_ROUTE_SOFT_TIMEOUT_MS,
    MAX_ROUTE_SOFT_TIMEOUT_MS
  );
}

function callMaybeKey(
  value,
  fallback = null
) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function shortKey(
  value,
  fallback
) {
  let raw = String(
    callMaybeKey(
      value,
      fallback
    ) ||
      ''
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
    raw.startsWith('LONG:')
  ) {
    raw = raw.slice(
      'LONG:'.length
    );
  }

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function buildKeys(KEYS = {}) {
  return {
    tradeLock:
      shortKey(
        first(
          KEYS
            .short
            ?.trade
            ?.lock,

          KEYS
            .trade
            ?.shortLock,

          KEYS
            .trade
            ?.lock
        ),
        'TRADE:LOCK'
      ),

    tradeRunMeta:
      shortKey(
        first(
          KEYS
            .short
            ?.trade
            ?.runMeta,

          KEYS
            .trade
            ?.shortRunMeta,

          KEYS
            .trade
            ?.runMeta
        ),
        'TRADE:RUN:META'
      ),

    lastProcessedSnapshot:
      shortKey(
        first(
          KEYS
            .short
            ?.trade
            ?.lastProcessedSnapshot,

          KEYS
            .trade
            ?.shortLastProcessedSnapshot,

          KEYS
            .trade
            ?.lastProcessedSnapshot
        ),
        'TRADE:LAST_PROCESSED_SNAPSHOT'
      )
  };
}

function getDurableRedis(core) {
  try {
    if (
      typeof core
        .redis
        ?.getDurableRedis !==
      'function'
    ) {
      return null;
    }

    return core
      .redis
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
    redis
      .get(key)
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
    redis
      .ttl(key)
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

  return bounded(
    redis
      .del(key)
      .then(() => true)
      .catch(() => false),
    REDIS_TIMEOUT_MS,
    false
  );
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
        .catch(() => null),
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
        .catch(() => null),
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

  if (typeof raw === 'object') {
    return raw;
  }

  try {
    return JSON.parse(
      String(raw)
    );
  } catch {
    return {
      token: String(raw)
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
            (now() - createdAt) /
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

function isStaleLock(state) {
  if (!state?.exists) {
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

  return Boolean(
    state.expiresAt > 0 &&
      state.expiresAt <= now()
  );
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

  const createdAt = now();

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

    staleAfterSec:
      DEFAULT_STALE_LOCK_AFTER_SEC,

    namespace:
      SHORT_NAMESPACE,

    routeVersion:
      TRADE_RUN_ROUTE_VERSION
  };

  if (forceUnlock) {
    await redisDelete(
      redis,
      key
    );
  }

  let acquired =
    await redisSetNx(
      redis,
      key,
      lockValue,
      DEFAULT_LOCK_TTL_SEC
    );

  if (acquired) {
    return {
      acquired: true,

      reason:
        forceUnlock
          ? 'TRADE_RUN_LOCK_FORCE_CLEARED_AND_ACQUIRED'
          : 'TRADE_RUN_LOCK_ACQUIRED',

      lockValue,

      forceClearedBeforeAcquire:
        forceUnlock,

      staleClearedBeforeAcquire:
        false,

      state: null
    };
  }

  const state =
    await readLock(
      redis,
      key
    );

  if (
    state.exists &&
    isStaleLock(state)
  ) {
    await redisDelete(
      redis,
      key
    );

    acquired =
      await redisSetNx(
        redis,
        key,
        lockValue,
        DEFAULT_LOCK_TTL_SEC
      );

    if (acquired) {
      return {
        acquired: true,

        reason:
          'STALE_TRADE_RUN_LOCK_CLEARED_AND_ACQUIRED',

        lockValue,

        forceClearedBeforeAcquire:
          forceUnlock,

        staleClearedBeforeAcquire:
          true,

        state
      };
    }
  }

  return {
    acquired: false,

    reason:
      'TRADE_RUN_LOCK_ACTIVE',

    state,

    lockValue,

    forceClearedBeforeAcquire:
      forceUnlock,

    staleClearedBeforeAcquire:
      false
  };
}

async function releaseOwnLock(
  redis,
  key,
  lockValue
) {
  if (
    !redis ||
    !key ||
    !lockValue?.token
  ) {
    return {
      released: false,
      reason:
        'LOCK_RELEASE_INPUT_MISSING'
    };
  }

  const state =
    await readLock(
      redis,
      key
    );

  if (!state?.exists) {
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
    released: deleted,

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

    shortOnly: true,
    longDisabled: true,

    virtualOnly: true,
    virtualLearning: true,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true,

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

    routeAbsoluteReturnMs:
      ABSOLUTE_ROUTE_RETURN_MS,

    routeResponseReserveMs:
      ROUTE_RESPONSE_RESERVE_MS,

    routeSoftTimeoutPreventsVercel504:
      true,

    routeHasNoUnboundedRedisWait:
      true,

    duplicateRoutePersistenceDisabled:
      true,

    tradeSystemOwnsRunMetaPersistence:
      true,

    forceDoesNotResetSnapshotCursor:
      true,

    resetSnapshotCursorRequiresExplicitFlag:
      true,

    forceDoesNotForceUnlock:
      true,

    maxCandidatesEmergencyCap:
      DEFAULT_MAX_CANDIDATES,

    candidateChunkEmergencyCap:
      DEFAULT_CANDIDATE_CHUNK_SIZE,

    openPositionMonitorEmergencyCap:
      DEFAULT_OPEN_POSITION_LIMIT,

    monitorBatchEmergencyCap:
      DEFAULT_MONITOR_BATCH_SIZE,

    scannerRunDisabledInsideTradeRun:
      true,

    scannerLatestReadOnlyInsideTradeRun:
      true,

    preserveScannerLatest:
      true,

    preserveScannerSnapshot:
      true,

    preserveScannerHistory:
      true,

    preserveRotation:
      true,

    preserveManualSelection:
      true,

    preserveDiscordSelection:
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

  res.setHeader(
    'X-Route-Absolute-Return-Ms',
    String(
      ABSOLUTE_ROUTE_RETURN_MS
    )
  );

  res.setHeader(
    'X-Max-Candidates-Emergency-Cap',
    String(
      DEFAULT_MAX_CANDIDATES
    )
  );

  res.setHeader(
    'X-Candidate-Chunk-Emergency-Cap',
    String(
      DEFAULT_CANDIDATE_CHUNK_SIZE
    )
  );

  res.setHeader(
    'X-Open-Position-Monitor-Emergency-Cap',
    String(
      DEFAULT_OPEN_POSITION_LIMIT
    )
  );
}

// ===== AANGEPASTE buildRunOptions =====
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

  const resetSnapshotCursor =
    shouldResetSnapshotCursor(
      req,
      body
    );

  const monitorOnly =
    shouldMonitorOnly(
      req,
      body
    );

  // Voor monitor-only gebruiken we een kleinere batch (1), anders de normale 15
  const maxCandidatesPerSnapshot =
    monitorOnly
      ? 1
      : DEFAULT_MAX_CANDIDATES;

  const candidateChunkSize =
    monitorOnly
      ? 1
      : Math.min(
          DEFAULT_CANDIDATE_CHUNK_SIZE,
          maxCandidatesPerSnapshot
        );

  return {
    /*
     * force mag cooldowns of normale overslagchecks omzeilen,
     * maar reset de cursor niet.
     */
    force,

    forceProcessSnapshot:
      force,

    resetSnapshotCursor,

    resetCursor:
      resetSnapshotCursor,

    forceResetSnapshotCursor:
      false,

    forceDoesNotResetSnapshotCursor:
      true,

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
      2_500,

    maxCandidatesPerSnapshot,

    candidateChunkSize,

    snapshotCandidateChunkSize:
      candidateChunkSize,

    analyzeMaxCandidatesPerSnapshot:
      maxCandidatesPerSnapshot,

    hardMaxCandidatesPerSnapshot:
      DEFAULT_MAX_CANDIDATES,

    maxEntriesPerRun:
      monitorOnly
        ? 0
        : DEFAULT_MAX_ENTRIES,

    dataConcurrency: 1,

    monitorOpenPositions: true,

    monitorOpenPositionsEnabled:
      true,

    monitorOpenPositionsFirst:
      true,

    monitorOpenPositionsBeforeEntries:
      true,

    monitorTimeoutMs:
      DEFAULT_MONITOR_TIMEOUT_MS,

    monitorPriceFetchTimeoutMs:
      180,

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

    maxOpenPositionsToRead:
      DEFAULT_OPEN_POSITION_LIMIT,

    openPositionHydrateLimit:
      DEFAULT_OPEN_POSITION_LIMIT,

    hydrateLimit:
      DEFAULT_OPEN_POSITION_LIMIT,

    openPositionLoadTimeoutMs:
      650,

    candidateTimeoutMs:
      550,

    analyzeTimeoutMs:
      1_500,

    marketContextTimeoutMs:
      450,

    snapshotTimeoutMs:
      550,

    rotationTimeoutMs:
      400,

    savePositionTimeoutMs:
      450,

    redisWriteTimeoutMs:
      450,

    discordTimeoutMs:
      550,

    minEntryLoopAttempts:
      1,

    entryLoopReserveMs:
      2_200,

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

    persistNoPriceFailures:
      false,

    // ===== NIEUW: Snapshot leeftijdsgrenzen =====
    maxSnapshotAgeMs: MAX_SNAPSHOT_AGE_MS,
    maxSnapshotWarnAgeMs: SNAPSHOT_WARN_AGE_MS,
    snapshotDebug: true, // zal tradeSystem vragen om gedetailleerde snapshot-info in response

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

    shortOnly: true,
    longDisabled: true,

    virtualOnly: true,
    virtualLearning: true,

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    noRealOrders: true,
    noExchangeOrders: true,

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

    compactForVercelRuntime:
      true,

    compactRedisPayloads:
      true,

    compactRunMeta:
      true,

    responseCompaction:
      true,

    routePersistsRunMeta:
      false,

    tradeSystemOwnsRunMetaPersistence:
      true,

    details:
      debug,

    debug,

    full: false
  };
}

function compactIds(
  values,
  requireMicroMicro = false
) {
  const rows =
    Array.isArray(values)
      ? values
      : [];

  return [
    ...new Set(
      rows
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
            value.includes('_MM_')
        )
    )
  ].slice(0, 100);
}

function compactAction(row) {
  if (
    !row ||
    typeof row !== 'object'
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

    riskFractionForEntry:
      row.riskFractionForEntry ??
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

    entryMarketWeatherKey:
      row.entryMarketWeatherKey ||
      null,

    currentMarketWeatherKey:
      row.currentMarketWeatherKey ||
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
    typeof payload === 'object'
      ? payload
      : {};

  const actions =
    Array.isArray(row.actions)
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

  const snapshotChunkStart =
    number(
      first(
        row.snapshotChunkStart,
        row.chunkStart,
        row.cursorStart
      ),
      0
    );

  const snapshotChunkNextIndex =
    number(
      first(
        row.snapshotChunkNextIndex,
        row.chunkNextIndex,
        row.cursorNextIndex
      ),
      snapshotChunkStart
    );

  const snapshotChunkTotalCandidates =
    number(
      first(
        row.snapshotChunkTotalCandidates,
        row.snapshotTotalCandidates,
        row.chunkTotalCandidates,
        row.totalCandidates
      ),
      0
    );

  const snapshotChunkComplete =
    Boolean(
      row.snapshotChunkComplete === true ||
      (
        snapshotChunkTotalCandidates > 0 &&
        snapshotChunkNextIndex >=
          snapshotChunkTotalCandidates
      )
    );

  const snapshotRemainingCandidates =
    Math.max(
      0,
      snapshotChunkTotalCandidates -
        snapshotChunkNextIndex
    );

  const snapshotProgressPct =
    snapshotChunkTotalCandidates > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Number(
              (
                snapshotChunkNextIndex /
                snapshotChunkTotalCandidates *
                100
              ).toFixed(2)
            )
          )
        )
      : 0;

  return {
    ok:
      row.ok !== false,

    degraded:
      Boolean(row.degraded),

    partial:
      Boolean(row.partial),

    timedOut:
      Boolean(row.timedOut),

    skipped:
      Boolean(row.skipped),

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

    // ===== Snapshot details (vanuit tradeSystem) =====
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

    snapshotChunkStart,

    snapshotChunkNextIndex,

    snapshotChunkTotalCandidates,

    snapshotChunkComplete,

    snapshotProgressPct,

    snapshotRemainingCandidates,

    snapshotCursorReset:
      Boolean(
        row.snapshotCursorReset
      ),

    snapshotCursorAdvanced:
      Boolean(
        row.snapshotCursorAdvanced
      ),

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

    attempted:
      number(
        row.attempted,
        0
      ),

    successfulCandidates:
      number(
        row.successfulCandidates,
        0
      ),

    failedCandidates:
      number(
        row.failedCandidates,
        0
      ),

    timedOutCandidates:
      number(
        row.timedOutCandidates,
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
                ? row
                    .qualityAudit
                    .topWaitReasons
                    .slice(0, 15)
                : []
          }
        : null,

    runtimeWarnings:
      Array.isArray(
        row.runtimeWarnings
      )
        ? row.runtimeWarnings.slice(
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
            .map(compactAction)
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
            .map(compactAction)
        : [],

    virtualExits:
      debug
        ? exits
            .slice(
              0,
              MAX_DEBUG_ROWS
            )
            .map(compactAction)
        : [],

    ...baseFlags()
  };
}

function routeTimeoutResponse({
  startedAt,
  routeSoftTimeoutMs,
  effectiveTradeWaitMs,
  lockKey,
  lock
}) {
  return {
    ok: false,
    tradeOk: false,

    skipped: true,
    partial: true,
    timedOut: true,

    routeSoftTimeout: true,

    routeSoftTimeoutBeforeVercel504:
      true,

    reason:
      'ROUTE_SOFT_TIMEOUT_BEFORE_VERCEL_504',

    skipReason:
      'ROUTE_SOFT_TIMEOUT_BEFORE_VERCEL_504',

    message:
      'De route heeft vóór de Vercel-limiet geantwoord. De lopende TradeSystem-taak krijgt geen extra route-persistence. De eigen SHORT-lock wordt in de taak-finally vrijgegeven of verloopt via TTL.',

    routeSoftTimeoutMs,

    effectiveTradeWaitMs,

    absoluteRouteReturnMs:
      ABSOLUTE_ROUTE_RETURN_MS,

    durationMs:
      now() - startedAt,

    completedAt:
      now(),

    lock: {
      key: lockKey,

      acquired:
        lock?.acquired === true,

      released: false,

      releaseMode:
        'TRADE_TASK_FINALLY_OR_TTL',

      ttlSec:
        DEFAULT_LOCK_TTL_SEC
    },

    warnings: [
      'VERCEL_504_PREVENTED_BY_ABSOLUTE_ROUTE_DEADLINE',
      'NO_REDIS_WRITE_WAIT_AFTER_ROUTE_TIMEOUT',
      'NO_DUPLICATE_ROUTE_PERSISTENCE',
      'TRADE_TASK_OWNS_FINAL_LOCK_RELEASE',
      'OPEN_POSITION_MONITOR_LIMIT_REDUCED_TO_6',
      'MAX_CANDIDATES_REDUCED_TO_15',
      'SNAPSHOT_CURSOR_NOT_RESET_BY_FORCE'
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
    ok: true,
    tradeOk: true,

    skipped: true,

    skippedNewEntries:
      true,

    reason:
      'TRADE_RUN_LOCK_ACTIVE',

    skipReason:
      'TRADE_RUN_LOCK_ACTIVE',

    message:
      'Een vorige SHORT trade-run is nog actief. Deze cron-run is veilig overgeslagen.',

    lock: {
      key: lockKey,
      active: true,

      ttlSec:
        lock?.state?.ttlSec ??
        null,

      ageSec:
        lock?.state?.ageSec ??
        null,

      state:
        debug
          ? lock?.state
          : undefined
    },

    durationMs:
      now() - startedAt,

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
  const requestedStatus =
    number(
      error?.statusCode,
      200
    );

  const status =
    requestedStatus >= 400 &&
    requestedStatus < 500
      ? requestedStatus
      : 200;

  return {
    status,

    payload: {
      ok: false,
      tradeOk: false,

      reason:
        'TRADE_RUN_CAUGHT_ERROR',

      error:
        errorMessage(error),

      errorName:
        error?.name ||
        'Error',

      errorCode:
        error?.code ||
        null,

      errorStage:
        error?.stage ||
        null,

      phase,

      availableExports:
        error?.availableExports ||
        null,

      stack:
        debug
          ? compactText(
              error?.stack,
              8_000
            )
          : null,

      durationMs:
        now() - startedAt,

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

  const startedAt = now();

  let phase = 'START';
  let body = {};
  let debug = false;
  let redis = null;
  let keys = buildKeys({});
  let lock = null;

  try {
    if (
      req.method !== 'GET' &&
      req.method !== 'POST'
    ) {
      res.setHeader(
        'Allow',
        'GET, POST'
      );

      return res
        .status(405)
        .json({
          ok: false,

          reason:
            'METHOD_NOT_ALLOWED',

          ...baseFlags()
        });
    }

    phase = 'READ_BODY';

    body =
      await boundedRequired(
        readBody(req),
        boundedByRoute(
          startedAt,
          BODY_TIMEOUT_MS
        ),
        'READ_BODY'
      );

    debug =
      shouldDebug(
        req,
        body
      );

    phase = 'LOAD_CORE';

    const core =
      await loadCoreModules(
        startedAt
      );

    keys =
      buildKeys(
        core.KEYS
      );

    phase = 'GET_REDIS';

    redis =
      getDurableRedis(core);

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
      phase = 'UNLOCK_ONLY';

      const stateBefore =
        await bounded(
          readLock(
            redis,
            keys.tradeLock
          ),
          boundedByRoute(
            startedAt,
            LOCK_STAGE_TIMEOUT_MS
          ),
          null
        );

      const released =
        await bounded(
          redisDelete(
            redis,
            keys.tradeLock
          ),
          boundedByRoute(
            startedAt,
            REDIS_TIMEOUT_MS
          ),
          false
        );

      return res
        .status(200)
        .json({
          ok: true,
          skipped: true,

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
            now() - startedAt,

          completedAt:
            now(),

          ...baseFlags()
        });
    }

    phase = 'ACQUIRE_LOCK';

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
        boundedByRoute(
          startedAt,
          LOCK_STAGE_TIMEOUT_MS
        ),
        'ACQUIRE_TRADE_LOCK'
      );

    if (!lock.acquired) {
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
      await loadTradeSystemModule(
        startedAt
      );

    const routeSoftTimeoutMs =
      getRouteSoftTimeoutMs(
        req,
        body,
        core.CONFIG || {}
      );

    const effectiveTradeWaitMs =
      boundedByRoute(
        startedAt,
        routeSoftTimeoutMs,
        ROUTE_RESPONSE_RESERVE_MS
      );

    if (
      effectiveTradeWaitMs <
      1_000
    ) {
      throw makeTimeoutError(
        'ROUTE_BUDGET_EXHAUSTED_BEFORE_TRADE_SYSTEM',
        effectiveTradeWaitMs
      );
    }

    const runOptions =
      buildRunOptions(
        req,
        body,
        debug
      );

    phase =
      'RUN_TRADE_SYSTEM';

    /*
     * De lock hoort bij de volledige TradeSystem-taak.
     * Bij een route-soft-timeout blijft de taak zelfstandig afronden.
     * De taak-finally verwijdert alleen de lock die zij zelf bezit.
     */
    const tradeTask =
      (async () => {
        try {
          return await runTradeSystem(
            runOptions
          );
        } finally {
          await bounded(
            releaseOwnLock(
              redis,
              keys.tradeLock,
              lock.lockValue
            ),
            LOCK_RELEASE_TIMEOUT_MS,
            null
          );
        }
      })();

    const result =
      await bounded(
        tradeTask,
        effectiveTradeWaitMs,
        () =>
          timeoutMarker(
            'RUN_TRADE_SYSTEM',
            effectiveTradeWaitMs
          )
      );

    if (
      isTimeoutMarker(result)
    ) {
      phase =
        'ROUTE_SOFT_TIMEOUT';

      tradeTask.catch(
        () => null
      );

      return res
        .status(200)
        .json(
          routeTimeoutResponse({
            startedAt,
            routeSoftTimeoutMs,
            effectiveTradeWaitMs,

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
          payload.ok !== false,

        tradeOk:
          payload.ok !== false,

        routeSoftTimeout:
          false,

        routeSoftTimeoutBeforeVercel504:
          false,

        routeSoftTimeoutMs,

        effectiveTradeWaitMs,

        absoluteRouteReturnMs:
          ABSOLUTE_ROUTE_RETURN_MS,

        maxTradeRuntimeMs:
          runOptions.maxRuntimeMs,

        monitorTimeoutMs:
          runOptions.monitorTimeoutMs,

        monitorBatchSize:
          runOptions.monitorBatchSize,

        openPositionMonitorLimit:
          runOptions.openPositionMonitorLimit,

        maxCandidatesPerSnapshot:
          runOptions.maxCandidatesPerSnapshot,

        candidateChunkSize:
          runOptions.candidateChunkSize,

        maxEntriesPerRun:
          runOptions.maxEntriesPerRun,

        force:
          runOptions.force,

        resetSnapshotCursor:
          runOptions.resetSnapshotCursor,

        // ===== NIEUW: Snapshot leeftijdsgrenzen in response =====
        maxSnapshotAgeMs: runOptions.maxSnapshotAgeMs,
        maxSnapshotWarnAgeMs: runOptions.maxSnapshotWarnAgeMs,

        lock: {
          key:
            keys.tradeLock,

          acquired: true,

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
          debug
            ? payload
            : undefined,

        ...payload,

        durationMs:
          now() - startedAt,

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
          Math.min(
            LOCK_RELEASE_TIMEOUT_MS,
            Math.max(
              1,
              remainingRouteMs(
                startedAt,
                200
              )
            )
          ),
          null
        );
      }
    } catch {
      // Lock-release mag de foutresponse nooit blokkeren.
    }

    const response =
      errorResponse(
        error,
        startedAt,
        phase,
        debug
      );

    return res
      .status(response.status)
      .json(response.payload);
  }
}