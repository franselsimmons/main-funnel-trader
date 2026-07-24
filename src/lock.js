// ================= FILE: src/lock.js =================
// COMPLEET distributed lock management
//
// SHORT-only Redis lock management.
//
// Redis-contract:
// - locks worden opgeslagen in volatile Redis
// - lock-keys staan uitsluitend onder SHORT:LOCK:*
// - lock verkrijgen gebeurt atomair via SET NX EX
// - alleen de eigenaar met het juiste lockId mag normaal vrijgeven
// - geen afhankelijkheid van keys.js of utils.js

import { randomUUID } from 'node:crypto';

import {
  getVolatileRedis,
  getJson,
  setNxJson,
  delJson,
  getKeys
} from './redis.js';

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_WAIT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 100;

const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 60 * 60;

const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 5000;

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const LOCK_KEY_PREFIX = `${SHORT_KEY_PREFIX}LOCK:`;

const LOCK_PATTERN = 'LOCK:*';
const MAX_LOCK_LIST_RESULTS = 1000;

function currentTimestamp() {
  return Date.now();
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || 'UNKNOWN_ERROR');
}

function sleep(ms = 0) {
  const delay = Math.max(
    0,
    Math.floor(Number(ms) || 0)
  );

  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

function normalizeResource(resource = '') {
  return String(resource || '').trim();
}

function normalizeLockId(lockId = '') {
  return String(lockId || '').trim();
}

function normalizeResourcePart(resource = '') {
  const cleanResource = normalizeResource(resource);

  if (!cleanResource) {
    return '';
  }

  return cleanResource
    .replace(/^SHORT:LOCK:/i, '')
    .replace(/^LOCK:/i, '')
    .replaceAll(':', '_')
    .replaceAll('|', '_')
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeTimeoutSeconds(
  value,
  fallback = DEFAULT_TIMEOUT_SECONDS
) {
  const parsed = Math.floor(Number(value));

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return fallback;
  }

  return Math.max(
    MIN_TIMEOUT_SECONDS,
    Math.min(
      MAX_TIMEOUT_SECONDS,
      parsed
    )
  );
}

function normalizePositiveInteger(
  value,
  fallback,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
) {
  const parsed = Math.floor(Number(value));

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum
  ) {
    return fallback;
  }

  return Math.max(
    minimum,
    Math.min(
      maximum,
      parsed
    )
  );
}

function normalizeMaxWaitMs(value) {
  const parsed = Math.floor(Number(value));

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return DEFAULT_MAX_WAIT_MS;
  }

  return parsed;
}

function normalizePollIntervalMs(value) {
  return normalizePositiveInteger(
    value,
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS
  );
}

function createLockId() {
  return [
    'lock',
    currentTimestamp(),
    randomUUID()
  ].join('_');
}

function buildLockKey(resource = '') {
  const resourcePart =
    normalizeResourcePart(resource);

  if (!resourcePart) {
    throw new Error(
      'LOCK_RESOURCE_REQUIRED'
    );
  }

  return `${LOCK_KEY_PREFIX}${resourcePart}`;
}

function normalizeStoredLock(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return null;
  }

  const id =
    normalizeLockId(
      value.id ||
      value.lockId ||
      value.ownerToken
    );

  const resource =
    normalizeResource(value.resource);

  const acquiredAt =
    Number(value.acquiredAt || 0);

  const expiresAt =
    Number(value.expiresAt || 0);

  const timeoutSeconds =
    Number(value.timeoutSeconds || 0);

  if (!id || !resource) {
    return null;
  }

  return {
    ...value,

    id,
    lockId: id,
    ownerToken: id,
    resource,

    acquiredAt:
      Number.isFinite(acquiredAt)
        ? acquiredAt
        : 0,

    expiresAt:
      Number.isFinite(expiresAt)
        ? expiresAt
        : 0,

    timeoutSeconds:
      Number.isFinite(timeoutSeconds)
        ? timeoutSeconds
        : 0
  };
}

function lockIsExpired(
  lock,
  timestamp = currentTimestamp()
) {
  const expiresAt =
    Number(lock?.expiresAt || 0);

  return (
    Number.isFinite(expiresAt) &&
    expiresAt > 0 &&
    expiresAt <= timestamp
  );
}

function nxInsertSucceeded(result) {
  return (
    result === 'OK' ||
    result === 'ok' ||
    result === true ||
    result === 1
  );
}

function deletedCount(result) {
  const parsed = Number(result);

  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return result ? 1 : 0;
}

async function readLock(
  redis,
  lockKey
) {
  const value = await getJson(
    redis,
    lockKey,
    null
  );

  return normalizeStoredLock(value);
}

async function removeExpiredLock(
  redis,
  lockKey,
  expectedLockId = ''
) {
  const current = await readLock(
    redis,
    lockKey
  );

  if (!current) {
    return {
      ok: true,
      removed: false,
      reason: 'LOCK_NOT_FOUND'
    };
  }

  if (
    expectedLockId &&
    current.id !== expectedLockId
  ) {
    return {
      ok: false,
      removed: false,
      reason: 'LOCK_OWNER_CHANGED',
      currentLockId: current.id
    };
  }

  if (!lockIsExpired(current)) {
    return {
      ok: true,
      removed: false,
      reason: 'LOCK_NOT_EXPIRED',
      lock: current
    };
  }

  /*
   * Opnieuw lezen vlak vóór verwijderen.
   *
   * Hierdoor wordt voorkomen dat een inmiddels vernieuwde lock
   * op basis van een oude read wordt verwijderd.
   */
  const verification = await readLock(
    redis,
    lockKey
  );

  if (!verification) {
    return {
      ok: true,
      removed: false,
      reason: 'LOCK_ALREADY_REMOVED'
    };
  }

  if (verification.id !== current.id) {
    return {
      ok: false,
      removed: false,
      reason: 'LOCK_OWNER_CHANGED',
      currentLockId: verification.id
    };
  }

  if (!lockIsExpired(verification)) {
    return {
      ok: true,
      removed: false,
      reason: 'LOCK_NOT_EXPIRED',
      lock: verification
    };
  }

  const deleted = await delJson(
    redis,
    lockKey
  );

  return {
    ok: true,
    removed: deletedCount(deleted) > 0,
    reason:
      deletedCount(deleted) > 0
        ? 'EXPIRED_LOCK_REMOVED'
        : 'EXPIRED_LOCK_DELETE_NOOP'
  };
}

export function normalizeShortLockKey(
  resource = ''
) {
  return buildLockKey(resource);
}

export async function acquireLock(
  resource = '',
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
) {
  try {
    const cleanResource =
      normalizeResource(resource);

    if (!cleanResource) {
      return {
        ok: false,
        acquired: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis =
      getVolatileRedis();

    const lockKey =
      buildLockKey(cleanResource);

    const cleanTimeoutSeconds =
      normalizeTimeoutSeconds(
        timeoutSeconds
      );

    const lockId =
      createLockId();

    const acquiredAt =
      currentTimestamp();

    const expiresAt =
      acquiredAt +
      cleanTimeoutSeconds * 1000;

    const lockData = {
      id: lockId,
      lockId,
      ownerToken: lockId,

      resource: cleanResource,
      lockKey,

      acquiredAt,
      expiresAt,

      timeoutSeconds:
        cleanTimeoutSeconds,

      status: 'HELD',

      namespace:
        SHORT_NAMESPACE,

      keyPrefix:
        SHORT_KEY_PREFIX,

      lockKeyPrefix:
        LOCK_KEY_PREFIX
    };

    /*
     * setNxJson voegt nx: true toe.
     *
     * De uiteindelijke Redis-operatie is:
     *
     * SET key payload NX EX timeout
     */
    let insertResult =
      await setNxJson(
        redis,
        lockKey,
        lockData,
        {
          ex: cleanTimeoutSeconds
        }
      );

    let acquired =
      nxInsertSucceeded(
        insertResult
      );

    if (!acquired) {
      const existingLock =
        await readLock(
          redis,
          lockKey
        );

      /*
       * Redis EX verwijdert een verlopen key normaal automatisch.
       * Deze controle ondersteunt ook oudere of afwijkende lockdata.
       */
      if (
        existingLock &&
        lockIsExpired(existingLock)
      ) {
        await removeExpiredLock(
          redis,
          lockKey,
          existingLock.id
        );

        insertResult =
          await setNxJson(
            redis,
            lockKey,
            lockData,
            {
              ex:
                cleanTimeoutSeconds
            }
          );

        acquired =
          nxInsertSucceeded(
            insertResult
          );
      }
    }

    if (!acquired) {
      const currentLock =
        await readLock(
          redis,
          lockKey
        );

      return {
        ok: false,
        acquired: false,

        reason:
          'LOCK_HELD',

        resource:
          cleanResource,

        lockKey,

        lock:
          currentLock
      };
    }

    return {
      ok: true,
      acquired: true,

      resource:
        cleanResource,

      lockKey,
      lockId,

      ownerToken:
        lockId,

      acquiredAt,

      expirationTime:
        expiresAt,

      expiresAt,

      timeoutSeconds:
        cleanTimeoutSeconds,

      lock:
        lockData
    };
  } catch (error) {
    console.error(
      'acquireLock error:',
      error
    );

    return {
      ok: false,
      acquired: false,

      reason:
        'LOCK_ACQUIRE_ERROR',

      error:
        errorMessage(error)
    };
  }
}

export async function releaseLock(
  resource = '',
  lockId = ''
) {
  try {
    const cleanResource =
      normalizeResource(resource);

    const cleanLockId =
      normalizeLockId(lockId);

    if (!cleanResource) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    if (!cleanLockId) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_ID_REQUIRED',
        resource: cleanResource
      };
    }

    const redis =
      getVolatileRedis();

    const lockKey =
      buildLockKey(cleanResource);

    const currentLock =
      await readLock(
        redis,
        lockKey
      );

    if (!currentLock) {
      return {
        ok: true,
        released: false,

        reason:
          'LOCK_NOT_FOUND',

        resource:
          cleanResource,

        lockKey
      };
    }

    if (
      currentLock.id !==
      cleanLockId
    ) {
      return {
        ok: false,
        released: false,

        reason:
          'LOCK_ID_MISMATCH',

        message:
          'Cannot release lock owned by another process',

        resource:
          cleanResource,

        lockKey,

        expectedLockId:
          cleanLockId,

        currentLockId:
          currentLock.id
      };
    }

    /*
     * De eigenaar wordt vlak vóór verwijderen nogmaals gecontroleerd.
     */
    const verification =
      await readLock(
        redis,
        lockKey
      );

    if (!verification) {
      return {
        ok: true,
        released: false,

        reason:
          'LOCK_ALREADY_REMOVED',

        resource:
          cleanResource,

        lockKey
      };
    }

    if (
      verification.id !==
      cleanLockId
    ) {
      return {
        ok: false,
        released: false,

        reason:
          'LOCK_OWNER_CHANGED',

        resource:
          cleanResource,

        lockKey,

        currentLockId:
          verification.id
      };
    }

    const deleted =
      await delJson(
        redis,
        lockKey
      );

    const released =
      deletedCount(deleted) > 0;

    return {
      ok: released,
      released,

      reason:
        released
          ? 'LOCK_RELEASED'
          : 'LOCK_DELETE_NOOP',

      resource:
        cleanResource,

      lockKey,

      lockId:
        cleanLockId
    };
  } catch (error) {
    console.error(
      'releaseLock error:',
      error
    );

    return {
      ok: false,
      released: false,

      reason:
        'LOCK_RELEASE_ERROR',

      error:
        errorMessage(error)
    };
  }
}

export async function isLocked(
  resource = ''
) {
  try {
    const cleanResource =
      normalizeResource(resource);

    if (!cleanResource) {
      return {
        ok: false,
        locked: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis =
      getVolatileRedis();

    const lockKey =
      buildLockKey(cleanResource);

    const lock =
      await readLock(
        redis,
        lockKey
      );

    if (!lock) {
      return {
        ok: true,
        locked: false,

        resource:
          cleanResource,

        lockKey
      };
    }

    if (lockIsExpired(lock)) {
      const cleanup =
        await removeExpiredLock(
          redis,
          lockKey,
          lock.id
        );

      return {
        ok: true,
        locked: false,

        expired:
          true,

        expiredLockRemoved:
          cleanup.removed === true,

        cleanupReason:
          cleanup.reason || null,

        resource:
          cleanResource,

        lockKey
      };
    }

    return {
      ok: true,
      locked: true,

      resource:
        cleanResource,

      lockKey,

      lock
    };
  } catch (error) {
    console.error(
      'isLocked error:',
      error
    );

    return {
      ok: false,
      locked: false,

      reason:
        'LOCK_CHECK_ERROR',

      error:
        errorMessage(error)
    };
  }
}

export async function waitForLock(
  resource = '',
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
) {
  try {
    const cleanResource =
      normalizeResource(resource);

    if (!cleanResource) {
      return {
        ok: false,
        available: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const cleanMaxWaitMs =
      normalizeMaxWaitMs(
        maxWaitMs
      );

    const cleanPollIntervalMs =
      normalizePollIntervalMs(
        pollIntervalMs
      );

    const startedAt =
      currentTimestamp();

    const deadlineAt =
      startedAt +
      cleanMaxWaitMs;

    while (
      currentTimestamp() <=
      deadlineAt
    ) {
      const lockCheck =
        await isLocked(
          cleanResource
        );

      if (
        lockCheck.ok &&
        !lockCheck.locked
      ) {
        return {
          ok: true,
          available: true,

          resource:
            cleanResource,

          waitedMs:
            currentTimestamp() -
            startedAt
        };
      }

      if (!lockCheck.ok) {
        return {
          ok: false,
          available: false,

          reason:
            lockCheck.reason ||
            'LOCK_CHECK_FAILED',

          error:
            lockCheck.error || null,

          resource:
            cleanResource,

          waitedMs:
            currentTimestamp() -
            startedAt
        };
      }

      const remainingMs =
        deadlineAt -
        currentTimestamp();

      if (remainingMs <= 0) {
        break;
      }

      await sleep(
        Math.min(
          cleanPollIntervalMs,
          remainingMs
        )
      );
    }

    return {
      ok: false,
      available: false,

      reason:
        'TIMEOUT',

      resource:
        cleanResource,

      waitedMs:
        currentTimestamp() -
        startedAt
    };
  } catch (error) {
    console.error(
      'waitForLock error:',
      error
    );

    return {
      ok: false,
      available: false,

      reason:
        'LOCK_WAIT_ERROR',

      error:
        errorMessage(error)
    };
  }
}

export async function withLock(
  resource = '',
  fn = null,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
) {
  let acquiredLock = null;
  let callbackError = null;
  let callbackResult;
  let releaseResult = null;

  if (typeof fn !== 'function') {
    return {
      ok: false,
      executed: false,
      reason: 'LOCK_CALLBACK_REQUIRED'
    };
  }

  try {
    acquiredLock =
      await acquireLock(
        resource,
        timeoutSeconds
      );

    if (
      !acquiredLock.ok ||
      !acquiredLock.acquired
    ) {
      return {
        ok: false,
        executed: false,

        reason:
          acquiredLock.reason ||
          'COULD_NOT_ACQUIRE_LOCK',

        resource:
          normalizeResource(resource),

        lock:
          acquiredLock.lock || null
      };
    }

    try {
      callbackResult =
        await fn({
          resource:
            acquiredLock.resource,

          lockKey:
            acquiredLock.lockKey,

          lockId:
            acquiredLock.lockId,

          ownerToken:
            acquiredLock.ownerToken,

          acquiredAt:
            acquiredLock.acquiredAt,

          expiresAt:
            acquiredLock.expiresAt,

          timeoutSeconds:
            acquiredLock.timeoutSeconds
        });
    } catch (error) {
      callbackError = error;
    }

    releaseResult =
      await releaseLock(
        acquiredLock.resource,
        acquiredLock.lockId
      );

    if (callbackError) {
      return {
        ok: false,
        executed: true,

        reason:
          'LOCKED_CALLBACK_ERROR',

        error:
          errorMessage(
            callbackError
          ),

        resource:
          acquiredLock.resource,

        lockKey:
          acquiredLock.lockKey,

        lockId:
          acquiredLock.lockId,

        lockReleased:
          Boolean(
            releaseResult?.released
          ),

        lockReleaseReason:
          releaseResult?.reason || null
      };
    }

    return {
      ok: true,
      executed: true,

      resource:
        acquiredLock.resource,

      result:
        callbackResult,

      lockKey:
        acquiredLock.lockKey,

      lockId:
        acquiredLock.lockId,

      ownerToken:
        acquiredLock.ownerToken,

      lockReleased:
        Boolean(
          releaseResult?.released
        ),

      lockReleaseReason:
        releaseResult?.reason || null
    };
  } catch (error) {
    console.error(
      'withLock error:',
      error
    );

    if (
      acquiredLock?.acquired &&
      acquiredLock?.lockId &&
      !releaseResult
    ) {
      try {
        releaseResult =
          await releaseLock(
            acquiredLock.resource,
            acquiredLock.lockId
          );
      } catch (releaseError) {
        console.error(
          'withLock emergency release error:',
          releaseError
        );
      }
    }

    return {
      ok: false,
      executed:
        Boolean(acquiredLock?.acquired),

      reason:
        'LOCK_EXECUTION_ERROR',

      error:
        errorMessage(error),

      resource:
        normalizeResource(resource),

      lockId:
        acquiredLock?.lockId || null,

      lockReleased:
        Boolean(
          releaseResult?.released
        ),

      lockReleaseReason:
        releaseResult?.reason || null
    };
  }
}

export async function withLockRetry(
  resource = '',
  fn = null,
  maxRetries = DEFAULT_MAX_RETRIES,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
) {
  try {
    if (typeof fn !== 'function') {
      return {
        ok: false,
        executed: false,
        reason: 'LOCK_CALLBACK_REQUIRED'
      };
    }

    const cleanMaxRetries =
      normalizePositiveInteger(
        maxRetries,
        DEFAULT_MAX_RETRIES,
        1,
        100
      );

    const cleanInitialBackoffMs =
      normalizePositiveInteger(
        initialBackoffMs,
        DEFAULT_INITIAL_BACKOFF_MS,
        25,
        60000
      );

    let attempt = 0;
    let lastError = null;
    let lastReason = null;

    while (
      attempt <
      cleanMaxRetries
    ) {
      attempt += 1;

      const result =
        await withLock(
          resource,
          fn,
          timeoutSeconds
        );

      if (
        result.ok &&
        result.executed
      ) {
        return {
          ok: true,
          executed: true,

          result:
            result.result,

          lockId:
            result.lockId,

          ownerToken:
            result.ownerToken,

          lockReleased:
            result.lockReleased,

          lockReleaseReason:
            result.lockReleaseReason,

          attempts:
            attempt
        };
      }

      /*
       * Een callbackfout wordt niet opnieuw uitgevoerd.
       * Alleen het niet verkrijgen van een lock hoort opnieuw geprobeerd te worden.
       */
      if (
        result.executed ||
        result.reason ===
          'LOCKED_CALLBACK_ERROR' ||
        result.reason ===
          'LOCK_EXECUTION_ERROR'
      ) {
        return {
          ...result,
          attempts: attempt
        };
      }

      lastReason =
        result.reason ||
        'COULD_NOT_ACQUIRE_LOCK';

      lastError =
        result.error ||
        result.reason ||
        null;

      if (
        attempt >=
        cleanMaxRetries
      ) {
        break;
      }

      const backoffMs =
        cleanInitialBackoffMs *
        Math.pow(
          2,
          attempt - 1
        );

      await sleep(
        Math.min(
          backoffMs,
          60000
        )
      );
    }

    return {
      ok: false,
      executed: false,

      reason:
        'MAX_RETRIES_EXCEEDED',

      lastReason,
      lastError,

      attempts:
        attempt
    };
  } catch (error) {
    console.error(
      'withLockRetry error:',
      error
    );

    return {
      ok: false,
      executed: false,

      reason:
        'LOCK_RETRY_ERROR',

      error:
        errorMessage(error)
    };
  }
}

export async function forceReleaseLock(
  resource = ''
) {
  try {
    const cleanResource =
      normalizeResource(resource);

    if (!cleanResource) {
      return {
        ok: false,
        released: false,
        forced: true,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis =
      getVolatileRedis();

    const lockKey =
      buildLockKey(cleanResource);

    const currentLock =
      await readLock(
        redis,
        lockKey
      );

    const deleted =
      await delJson(
        redis,
        lockKey
      );

    const released =
      deletedCount(deleted) > 0;

    return {
      ok: true,
      released,
      forced: true,

      reason:
        released
          ? 'LOCK_FORCE_RELEASED'
          : 'LOCK_NOT_FOUND',

      resource:
        cleanResource,

      lockKey,

      previousLock:
        currentLock || null
    };
  } catch (error) {
    console.error(
      'forceReleaseLock error:',
      error
    );

    return {
      ok: false,
      released: false,
      forced: true,

      reason:
        'FORCE_LOCK_RELEASE_ERROR',

      error:
        errorMessage(error)
    };
  }
}

export async function getAllLocks() {
  try {
    const redis =
      getVolatileRedis();

    /*
     * redis.js normaliseert LOCK:* automatisch naar SHORT:LOCK:*.
     */
    const lockKeys =
      await getKeys(
        redis,
        LOCK_PATTERN,
        MAX_LOCK_LIST_RESULTS
      );

    const locks = [];
    let expiredRemoved = 0;

    for (
      const lockKey
      of lockKeys
    ) {
      const lock =
        await readLock(
          redis,
          lockKey
        );

      if (!lock) {
        continue;
      }

      if (lockIsExpired(lock)) {
        const cleanup =
          await removeExpiredLock(
            redis,
            lockKey,
            lock.id
          );

        if (cleanup.removed) {
          expiredRemoved += 1;
        }

        continue;
      }

      locks.push({
        key: lockKey,
        ...lock
      });
    }

    locks.sort(
      (left, right) => (
        Number(
          left.expiresAt || 0
        ) -
        Number(
          right.expiresAt || 0
        )
      )
    );

    return {
      ok: true,

      locks,

      count:
        locks.length,

      expiredRemoved,

      namespace:
        SHORT_NAMESPACE,

      lockKeyPrefix:
        LOCK_KEY_PREFIX
    };
  } catch (error) {
    console.error(
      'getAllLocks error:',
      error
    );

    return {
      ok: false,

      reason:
        'GET_ALL_LOCKS_ERROR',

      error:
        errorMessage(error),

      locks: [],
      count: 0,
      expiredRemoved: 0
    };
  }
}

export default {
  normalizeShortLockKey,
  acquireLock,
  releaseLock,
  isLocked,
  waitForLock,
  withLock,
  withLockRetry,
  forceReleaseLock,
  getAllLocks
};