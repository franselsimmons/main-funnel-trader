// ================= FILE: src/lock.js =================
// COMPLEET distributed lock management

import { getRedis } from './redis.js';
import { keys } from './keys.js';
import { now, randomId } from './utils.js';

function createLockId() {
  return randomId('lock');
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeTimeoutSeconds(value, fallback = 30) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(parsed));
}

function normalizeWaitMs(value, fallback = 30000) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.max(0, Math.floor(parsed));
}

function normalizeLockValue(value) {
  if (!value) return null;

  if (typeof value === 'object') {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);

      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function redisDelete(redis, key) {
  if (typeof redis.delete === 'function') {
    return redis.delete(key);
  }

  if (typeof redis.del === 'function') {
    return redis.del(key);
  }

  throw new Error('REDIS_DELETE_METHOD_NOT_AVAILABLE');
}

function deletedCount(result) {
  if (typeof result === 'number') {
    return result;
  }

  if (result && typeof result === 'object') {
    if (typeof result.deleted === 'number') return result.deleted;
    if (typeof result.result === 'number') return result.result;
  }

  return result ? 1 : 0;
}

async function setLockIfAbsent(redis, lockKey, lockData, timeoutSeconds) {
  /*
   * Upstash ondersteunt:
   *
   * redis.set(key, value, {
   *   nx: true,
   *   ex: timeoutSeconds
   * })
   *
   * Dit is atomair. Daardoor kunnen twee processen niet tegelijk dezelfde
   * lock verkrijgen.
   */
  const result = await redis.set(lockKey, lockData, {
    nx: true,
    ex: timeoutSeconds
  });

  return result === 'OK' || result === true;
}

async function removeExpiredLock(redis, lockKey, expectedLock = null) {
  const currentRaw = await redis.get(lockKey);
  const currentLock = normalizeLockValue(currentRaw);

  if (!currentLock) {
    return {
      removed: false,
      reason: 'LOCK_NOT_FOUND'
    };
  }

  if (expectedLock?.id && currentLock.id !== expectedLock.id) {
    return {
      removed: false,
      reason: 'LOCK_CHANGED'
    };
  }

  if (Number(currentLock.expiresAt || 0) >= now()) {
    return {
      removed: false,
      reason: 'LOCK_NOT_EXPIRED'
    };
  }

  const result = await redisDelete(redis, lockKey);

  return {
    removed: deletedCount(result) > 0,
    reason: 'EXPIRED_LOCK_REMOVED'
  };
}

export async function acquireLock(resource = '', timeoutSeconds = 30) {
  try {
    const cleanResource = String(resource || '').trim();

    if (!cleanResource) {
      return {
        ok: false,
        acquired: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis = getRedis();
    const lockKey = keys.lock(cleanResource);
    const cleanTimeoutSeconds = normalizeTimeoutSeconds(timeoutSeconds);
    const lockId = createLockId();
    const timestamp = now();
    const expirationTime = timestamp + cleanTimeoutSeconds * 1000;

    const lockData = {
      id: lockId,
      resource: cleanResource,
      acquiredAt: timestamp,
      expiresAt: expirationTime,
      timeoutSeconds: cleanTimeoutSeconds
    };

    let acquired = await setLockIfAbsent(
      redis,
      lockKey,
      lockData,
      cleanTimeoutSeconds
    );

    if (!acquired) {
      const existingRaw = await redis.get(lockKey);
      const existingLock = normalizeLockValue(existingRaw);

      if (
        existingLock &&
        Number(existingLock.expiresAt || 0) > 0 &&
        Number(existingLock.expiresAt) < now()
      ) {
        await removeExpiredLock(redis, lockKey, existingLock);

        acquired = await setLockIfAbsent(
          redis,
          lockKey,
          lockData,
          cleanTimeoutSeconds
        );
      }

      if (!acquired) {
        const currentRaw = await redis.get(lockKey);
        const currentLock = normalizeLockValue(currentRaw);

        return {
          ok: false,
          acquired: false,
          reason: 'LOCK_HELD',
          resource: cleanResource,
          lock: currentLock
        };
      }
    }

    return {
      ok: true,
      acquired: true,
      lockId,
      expirationTime,
      expiresAt: expirationTime,
      timeoutSeconds: cleanTimeoutSeconds,
      resource: cleanResource,
      lock: lockData
    };
  } catch (err) {
    console.error('acquireLock error:', err);

    return {
      ok: false,
      acquired: false,
      reason: 'LOCK_ACQUIRE_ERROR',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function releaseLock(resource = '', lockId = '') {
  try {
    const cleanResource = String(resource || '').trim();
    const cleanLockId = String(lockId || '').trim();

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
        reason: 'LOCK_ID_REQUIRED'
      };
    }

    const redis = getRedis();
    const lockKey = keys.lock(cleanResource);

    const currentRaw = await redis.get(lockKey);
    const currentLock = normalizeLockValue(currentRaw);

    if (!currentLock) {
      return {
        ok: true,
        released: false,
        reason: 'LOCK_NOT_FOUND',
        resource: cleanResource
      };
    }

    if (currentLock.id !== cleanLockId) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_ID_MISMATCH',
        message: 'Cannot release lock owned by another process',
        resource: cleanResource
      };
    }

    /*
     * Controleer de eigenaar direct vóór verwijderen.
     * Dit beperkt het risico dat een verlopen lock van een nieuw proces wordt
     * verwijderd. Volledig atomair vergelijken en verwijderen vereist een
     * Redis Lua-script, maar deze eigenaarcontrole voorkomt normale mismatches.
     */
    const verifyRaw = await redis.get(lockKey);
    const verifyLock = normalizeLockValue(verifyRaw);

    if (!verifyLock) {
      return {
        ok: true,
        released: false,
        reason: 'LOCK_ALREADY_REMOVED',
        resource: cleanResource
      };
    }

    if (verifyLock.id !== cleanLockId) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_OWNER_CHANGED',
        resource: cleanResource
      };
    }

    const result = await redisDelete(redis, lockKey);

    return {
      ok: true,
      released: deletedCount(result) > 0,
      resource: cleanResource
    };
  } catch (err) {
    console.error('releaseLock error:', err);

    return {
      ok: false,
      released: false,
      reason: 'LOCK_RELEASE_ERROR',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function isLocked(resource = '') {
  try {
    const cleanResource = String(resource || '').trim();

    if (!cleanResource) {
      return {
        ok: false,
        locked: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis = getRedis();
    const lockKey = keys.lock(cleanResource);
    const rawLock = await redis.get(lockKey);
    const lock = normalizeLockValue(rawLock);

    if (!lock) {
      return {
        ok: true,
        locked: false,
        resource: cleanResource
      };
    }

    if (
      Number(lock.expiresAt || 0) > 0 &&
      Number(lock.expiresAt) < now()
    ) {
      await removeExpiredLock(redis, lockKey, lock);

      return {
        ok: true,
        locked: false,
        expired: true,
        resource: cleanResource
      };
    }

    return {
      ok: true,
      locked: true,
      resource: cleanResource,
      lock
    };
  } catch (err) {
    console.error('isLocked error:', err);

    return {
      ok: false,
      locked: false,
      reason: 'LOCK_CHECK_ERROR',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function waitForLock(
  resource = '',
  maxWaitMs = 30000,
  pollIntervalMs = 100
) {
  try {
    const cleanResource = String(resource || '').trim();

    if (!cleanResource) {
      return {
        ok: false,
        available: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const cleanMaxWaitMs = normalizeWaitMs(maxWaitMs, 30000);
    const cleanPollIntervalMs = Math.max(
      25,
      normalizeWaitMs(pollIntervalMs, 100)
    );

    const startTime = now();
    const maxTime = startTime + cleanMaxWaitMs;

    while (now() <= maxTime) {
      const lockCheck = await isLocked(cleanResource);

      if (lockCheck.ok && !lockCheck.locked) {
        return {
          ok: true,
          available: true,
          resource: cleanResource,
          waitedMs: now() - startTime
        };
      }

      if (!lockCheck.ok) {
        return {
          ok: false,
          available: false,
          resource: cleanResource,
          reason: lockCheck.reason || 'LOCK_CHECK_FAILED',
          error: lockCheck.error
        };
      }

      const remainingMs = maxTime - now();

      if (remainingMs <= 0) {
        break;
      }

      await sleep(Math.min(cleanPollIntervalMs, remainingMs));
    }

    return {
      ok: false,
      available: false,
      resource: cleanResource,
      reason: 'TIMEOUT',
      waitedMs: now() - startTime
    };
  } catch (err) {
    console.error('waitForLock error:', err);

    return {
      ok: false,
      available: false,
      reason: 'LOCK_WAIT_ERROR',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function withLock(
  resource = '',
  fn = null,
  timeoutSeconds = 30
) {
  let lockId = '';

  try {
    if (typeof fn !== 'function') {
      return {
        ok: false,
        executed: false,
        reason: 'LOCK_CALLBACK_REQUIRED'
      };
    }

    const lockAcquire = await acquireLock(resource, timeoutSeconds);

    if (!lockAcquire.ok || !lockAcquire.acquired) {
      return {
        ok: false,
        executed: false,
        reason: lockAcquire.reason || 'COULD_NOT_ACQUIRE_LOCK',
        lock: lockAcquire.lock || null
      };
    }

    lockId = lockAcquire.lockId;

    const result = await fn({
      resource,
      lockId,
      expiresAt: lockAcquire.expiresAt
    });

    return {
      ok: true,
      executed: true,
      result,
      lockId
    };
  } catch (err) {
    console.error('withLock error:', err);

    return {
      ok: false,
      executed: false,
      reason: 'LOCKED_CALLBACK_ERROR',
      error: err instanceof Error ? err.message : String(err),
      lockId: lockId || null
    };
  } finally {
    if (lockId) {
      const releaseResult = await releaseLock(resource, lockId);

      if (!releaseResult.ok) {
        console.error('withLock release error:', releaseResult);
      }
    }
  }
}

export async function withLockRetry(
  resource = '',
  fn = null,
  maxRetries = 3,
  initialBackoffMs = 100,
  timeoutSeconds = 30
) {
  try {
    if (typeof fn !== 'function') {
      return {
        ok: false,
        executed: false,
        reason: 'LOCK_CALLBACK_REQUIRED'
      };
    }

    const cleanMaxRetries = Math.max(
      1,
      Math.floor(Number(maxRetries) || 3)
    );

    const cleanInitialBackoffMs = Math.max(
      25,
      Math.floor(Number(initialBackoffMs) || 100)
    );

    let attempt = 0;
    let lastError = null;

    while (attempt < cleanMaxRetries) {
      attempt += 1;

      try {
        const execResult = await withLock(
          resource,
          fn,
          timeoutSeconds
        );

        if (execResult.ok && execResult.executed) {
          return {
            ok: true,
            executed: true,
            result: execResult.result,
            attempts: attempt,
            lockId: execResult.lockId
          };
        }

        lastError =
          execResult.reason ||
          execResult.error ||
          'Could not acquire lock';

        if (attempt >= cleanMaxRetries) {
          break;
        }

        const backoffMs =
          cleanInitialBackoffMs * Math.pow(2, attempt - 1);

        await sleep(backoffMs);
      } catch (err) {
        lastError =
          err instanceof Error ? err.message : String(err);

        if (attempt >= cleanMaxRetries) {
          break;
        }

        const backoffMs =
          cleanInitialBackoffMs * Math.pow(2, attempt - 1);

        await sleep(backoffMs);
      }
    }

    return {
      ok: false,
      executed: false,
      reason: 'MAX_RETRIES_EXCEEDED',
      lastError,
      attempts: cleanMaxRetries
    };
  } catch (err) {
    console.error('withLockRetry error:', err);

    return {
      ok: false,
      executed: false,
      reason: 'LOCK_RETRY_ERROR',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function forceReleaseLock(resource = '') {
  try {
    const cleanResource = String(resource || '').trim();

    if (!cleanResource) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_RESOURCE_REQUIRED'
      };
    }

    const redis = getRedis();
    const lockKey = keys.lock(cleanResource);
    const result = await redisDelete(redis, lockKey);

    return {
      ok: true,
      released: deletedCount(result) > 0,
      resource: cleanResource
    };
  } catch (err) {
    console.error('forceReleaseLock error:', err);

    return {
      ok: false,
      released: false,
      reason: 'FORCE_LOCK_RELEASE_ERROR',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function getAllLocks() {
  try {
    const redis = getRedis();
    const pattern = 'SHORT:LOCK:*';

    if (typeof redis.keys !== 'function') {
      return {
        ok: false,
        locks: [],
        count: 0,
        reason: 'REDIS_KEYS_METHOD_NOT_AVAILABLE'
      };
    }

    const lockKeys = await redis.keys(pattern);
    const locks = [];

    for (const key of Array.isArray(lockKeys) ? lockKeys : []) {
      const rawLock = await redis.get(key);
      const lock = normalizeLockValue(rawLock);

      if (!lock) continue;

      if (
        Number(lock.expiresAt || 0) > 0 &&
        Number(lock.expiresAt) < now()
      ) {
        await removeExpiredLock(redis, key, lock);
        continue;
      }

      locks.push({
        key,
        ...lock
      });
    }

    return {
      ok: true,
      locks,
      count: locks.length
    };
  } catch (err) {
    console.error('getAllLocks error:', err);

    return {
      ok: false,
      reason: 'GET_ALL_LOCKS_ERROR',
      error: err instanceof Error ? err.message : String(err),
      locks: [],
      count: 0
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