// ================= FILE: src/lock.js =================
// COMPLEET distributed lock management
//
// SHORT-only Redis lock management.
//
// Redis-contract:
// - locks worden opgeslagen in de volatile Redis
// - keys.lock(resource) levert de logische lock-key
// - redis.js normaliseert deze automatisch naar de SHORT namespace
// - lock verkrijgen gebeurt atomair via SET NX EX
// - alleen de eigenaar met het juiste lockId mag normaal vrijgeven

import {
  getVolatileRedis,
  getJson,
  setNxJson,
  delJson,
  getKeys
} from './redis.js';

import { keys } from './keys.js';
import { now, randomId } from './utils.js';

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_WAIT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 100;

const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 60 * 60;

const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 5000;

const LOCK_PATTERN = 'LOCK:*';
const MAX_LOCK_LIST_RESULTS = 1000;

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || 'UNKNOWN_ERROR');
}

function sleep(ms = 0) {
  const delay = Math.max(0, Math.floor(Number(ms) || 0));

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

function normalizeTimeoutSeconds(
  value,
  fallback = DEFAULT_TIMEOUT_SECONDS
) {
  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(
    MIN_TIMEOUT_SECONDS,
    Math.min(MAX_TIMEOUT_SECONDS, parsed)
  );
}

function normalizePositiveInteger(
  value,
  fallback,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
) {
  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return Math.max(
    minimum,
    Math.min(maximum, parsed)
  );
}

function normalizeMaxWaitMs(value) {
  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed) || parsed < 0) {
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
  return randomId('lock');
}

function buildLockKey(resource = '') {
  const cleanResource = normalizeResource(resource);

  if (!cleanResource) {
    throw new Error('LOCK_RESOURCE_REQUIRED');
  }

  return keys.lock(cleanResource);
}

function normalizeStoredLock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const id = normalizeLockId(value.id);
  const resource = normalizeResource(value.resource);
  const acquiredAt = Number(value.acquiredAt || 0);
  const expiresAt = Number(value.expiresAt || 0);
  const timeoutSeconds = Number(value.timeoutSeconds || 0);

  if (!id || !resource) {
    return null;
  }

  return {
    ...value,
    id,
    resource,
    acquiredAt: Number.isFinite(acquiredAt) ? acquiredAt : 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    timeoutSeconds: Number.isFinite(timeoutSeconds)
      ? timeoutSeconds
      : 0
  };
}

function lockIsExpired(lock, timestamp = now()) {
  const expiresAt = Number(lock?.expiresAt || 0);

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

async function readLock(redis, lockKey) {
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
   * Nogmaals controleren vlak vóór verwijderen.
   * Hiermee wordt voorkomen dat een inmiddels vernieuwde lock
   * op basis van verouderde informatie wordt verwijderd.
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
    reason: 'EXPIRED_LOCK_REMOVED'
  };
}

export async function acquireLock(
  resource = '',
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
) {
  try {
    const cleanResource = normalizeResource(resource);

    if (!cleanResource) {
      return {
        ok: false,
        acquired: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis = getVolatileRedis();
    const lockKey = buildLockKey(cleanResource);

    const cleanTimeoutSeconds =
      normalizeTimeoutSeconds(timeoutSeconds);

    const lockId = createLockId();
    const acquiredAt = now();
    const expiresAt =
      acquiredAt + cleanTimeoutSeconds * 1000;

    const lockData = {
      id: lockId,
      resource: cleanResource,
      acquiredAt,
      expiresAt,
      timeoutSeconds: cleanTimeoutSeconds,
      ownerToken: lockId,
      status: 'HELD'
    };

    /*
     * setNxJson gebruikt in redis.js:
     *
     * redis.set(key, payload, {
     *   ex: timeout,
     *   nx: true
     * })
     *
     * Dit is de atomische lock-claim.
     */
    let insertResult = await setNxJson(
      redis,
      lockKey,
      lockData,
      {
        ex: cleanTimeoutSeconds
      }
    );

    let acquired =
      nxInsertSucceeded(insertResult);

    if (!acquired) {
      const existingLock = await readLock(
        redis,
        lockKey
      );

      /*
       * Redis EX verwijdert normaal automatisch verlopen keys.
       * Deze extra controle ruimt oude locks op wanneer een key
       * door afwijkende of oudere data nog aanwezig is.
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

        insertResult = await setNxJson(
          redis,
          lockKey,
          lockData,
          {
            ex: cleanTimeoutSeconds
          }
        );

        acquired =
          nxInsertSucceeded(insertResult);
      }
    }

    if (!acquired) {
      const currentLock = await readLock(
        redis,
        lockKey
      );

      return {
        ok: false,
        acquired: false,
        reason: 'LOCK_HELD',
        resource: cleanResource,
        lockKey,
        lock: currentLock
      };
    }

    return {
      ok: true,
      acquired: true,
      resource: cleanResource,
      lockKey,
      lockId,
      ownerToken: lockId,
      acquiredAt,
      expirationTime: expiresAt,
      expiresAt,
      timeoutSeconds: cleanTimeoutSeconds,
      lock: lockData
    };
  } catch (error) {
    console.error(
      'acquireLock error:',
      error
    );

    return {
      ok: false,
      acquired: false,
      reason: 'LOCK_ACQUIRE_ERROR',
      error: errorMessage(error)
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

    const redis = getVolatileRedis();
    const lockKey = buildLockKey(cleanResource);

    const currentLock = await readLock(
      redis,
      lockKey
    );

    if (!currentLock) {
      return {
        ok: true,
        released: false,
        reason: 'LOCK_NOT_FOUND',
        resource: cleanResource,
        lockKey
      };
    }

    if (currentLock.id !== cleanLockId) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_ID_MISMATCH',
        message:
          'Cannot release lock owned by another process',
        resource: cleanResource,
        lockKey,
        expectedLockId: cleanLockId,
        currentLockId: currentLock.id
      };
    }

    /*
     * Eigenaar nogmaals controleren vlak vóór het verwijderen.
     * Een volledig atomische compare-and-delete vereist Lua/EVAL.
     * Deze dubbele controle beschermt tegen normale owner-wisselingen.
     */
    const verification = await readLock(
      redis,
      lockKey
    );

    if (!verification) {
      return {
        ok: true,
        released: false,
        reason: 'LOCK_ALREADY_REMOVED',
        resource: cleanResource,
        lockKey
      };
    }

    if (verification.id !== cleanLockId) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_OWNER_CHANGED',
        resource: cleanResource,
        lockKey,
        currentLockId: verification.id
      };
    }

    const deleted = await delJson(
      redis,
      lockKey
    );

    return {
      ok: true,
      released: deletedCount(deleted) > 0,
      resource: cleanResource,
      lockKey,
      lockId: cleanLockId
    };
  } catch (error) {
    console.error(
      'releaseLock error:',
      error
    );

    return {
      ok: false,
      released: false,
      reason: 'LOCK_RELEASE_ERROR',
      error: errorMessage(error)
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

    const redis = getVolatileRedis();
    const lockKey = buildLockKey(cleanResource);

    const lock = await readLock(
      redis,
      lockKey
    );

    if (!lock) {
      return {
        ok: true,
        locked: false,
        resource: cleanResource,
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
        expired: true,
        expiredLockRemoved:
          cleanup.removed === true,
        resource: cleanResource,
        lockKey
      };
    }

    return {
      ok: true,
      locked: true,
      resource: cleanResource,
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
      reason: 'LOCK_CHECK_ERROR',
      error: errorMessage(error)
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
      normalizeMaxWaitMs(maxWaitMs);

    const cleanPollIntervalMs =
      normalizePollIntervalMs(
        pollIntervalMs
      );

    const startedAt = now();
    const deadlineAt =
      startedAt + cleanMaxWaitMs;

    while (now() <= deadlineAt) {
      const lockCheck =
        await isLocked(cleanResource);

      if (
        lockCheck.ok &&
        !lockCheck.locked
      ) {
        return {
          ok: true,
          available: true,
          resource: cleanResource,
          waitedMs: now() - startedAt
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
          resource: cleanResource,
          waitedMs: now() - startedAt
        };
      }

      const remainingMs =
        deadlineAt - now();

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
      reason: 'TIMEOUT',
      resource: cleanResource,
      waitedMs: now() - startedAt
    };
  } catch (error) {
    console.error(
      'waitForLock error:',
      error
    );

    return {
      ok: false,
      available: false,
      reason: 'LOCK_WAIT_ERROR',
      error: errorMessage(error)
    };
  }
}

export async function withLock(
  resource = '',
  fn = null,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
) {
  let acquiredLock = null;

  try {
    if (typeof fn !== 'function') {
      return {
        ok: false,
        executed: false,
        reason: 'LOCK_CALLBACK_REQUIRED'
      };
    }

    acquiredLock = await acquireLock(
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

    const result = await fn({
      resource:
        acquiredLock.resource,
      lockId:
        acquiredLock.lockId,
      ownerToken:
        acquiredLock.ownerToken,
      acquiredAt:
        acquiredLock.acquiredAt,
      expiresAt:
        acquiredLock.expiresAt
    });

    return {
      ok: true,
      executed: true,
      resource:
        acquiredLock.resource,
      result,
      lockId:
        acquiredLock.lockId,
      ownerToken:
        acquiredLock.ownerToken
    };
  } catch (error) {
    console.error(
      'withLock error:',
      error
    );

    return {
      ok: false,
      executed: false,
      reason: 'LOCKED_CALLBACK_ERROR',
      error: errorMessage(error),
      resource:
        normalizeResource(resource),
      lockId:
        acquiredLock?.lockId || null
    };
  } finally {
    if (
      acquiredLock?.acquired &&
      acquiredLock?.lockId
    ) {
      const releaseResult =
        await releaseLock(
          acquiredLock.resource,
          acquiredLock.lockId
        );

      if (!releaseResult.ok) {
        console.error(
          'withLock release error:',
          releaseResult
        );
      }
    }
  }
}

export async function withLockRetry(
  resource = '',
  fn = null,
  maxRetries = DEFAULT_MAX_RETRIES,
  initialBackoffMs =
    DEFAULT_INITIAL_BACKOFF_MS,
  timeoutSeconds =
    DEFAULT_TIMEOUT_SECONDS
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

    while (attempt < cleanMaxRetries) {
      attempt += 1;

      const result = await withLock(
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
          result: result.result,
          lockId: result.lockId,
          ownerToken:
            result.ownerToken,
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

      if (attempt >= cleanMaxRetries) {
        break;
      }

      const backoffMs =
        cleanInitialBackoffMs *
        Math.pow(2, attempt - 1);

      await sleep(
        Math.min(backoffMs, 60000)
      );
    }

    return {
      ok: false,
      executed: false,
      reason: 'MAX_RETRIES_EXCEEDED',
      lastReason,
      lastError,
      attempts: attempt
    };
  } catch (error) {
    console.error(
      'withLockRetry error:',
      error
    );

    return {
      ok: false,
      executed: false,
      reason: 'LOCK_RETRY_ERROR',
      error: errorMessage(error)
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
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis = getVolatileRedis();
    const lockKey = buildLockKey(cleanResource);

    const currentLock = await readLock(
      redis,
      lockKey
    );

    const deleted = await delJson(
      redis,
      lockKey
    );

    return {
      ok: true,
      released: deletedCount(deleted) > 0,
      forced: true,
      resource: cleanResource,
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
      error: errorMessage(error)
    };
  }
}

export async function getAllLocks() {
  try {
    const redis = getVolatileRedis();

    /*
     * getKeys() gebruikt SCAN en normaliseert LOCK:*
     * automatisch naar SHORT:LOCK:*.
     */
    const lockKeys = await getKeys(
      redis,
      LOCK_PATTERN,
      MAX_LOCK_LIST_RESULTS
    );

    const locks = [];
    let expiredRemoved = 0;

    for (const lockKey of lockKeys) {
      const lock = await readLock(
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

    locks.sort((left, right) => {
      return (
        Number(left.expiresAt || 0) -
        Number(right.expiresAt || 0)
      );
    });

    return {
      ok: true,
      locks,
      count: locks.length,
      expiredRemoved
    };
  } catch (error) {
    console.error(
      'getAllLocks error:',
      error
    );

    return {
      ok: false,
      reason: 'GET_ALL_LOCKS_ERROR',
      error: errorMessage(error),
      locks: [],
      count: 0,
      expiredRemoved: 0
    };
  }
}

export default {
  acquireLock,
  releaseLock,
  isLocked,
  waitForLock,
  withLock,
  withLockRetry,
  forceReleaseLock,
  getAllLocks
};