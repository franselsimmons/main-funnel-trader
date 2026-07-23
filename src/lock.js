// ================= FILE: src/lock.js =================
// COMPLEET distributed lock management

import { getRedis } from './redis.js';
import { keys } from './keys.js';
import { now, generateShortId } from './utils.js';

export async function acquireLock(resource = '', timeoutSeconds = 30) {
  try {
    const redis = getRedis();
    const lockKey = keys.lock(resource);
    const lockId = generateShortId(16);
    const timestamp = now();
    const expirationTime = timestamp + (timeoutSeconds * 1000);

    const lockData = {
      id: lockId,
      resource,
      acquiredAt: timestamp,
      expiresAt: expirationTime,
      timeoutSeconds
    };

    const existingLock = await redis.get(lockKey);
    
    if (existingLock) {
      if (existingLock.expiresAt < now()) {
        await redis.delete(lockKey);
        return acquireLock(resource, timeoutSeconds);
      }
      
      return {
        ok: false,
        acquired: false,
        reason: 'LOCK_HELD',
        lock: existingLock
      };
    }

    await redis.set(lockKey, lockData, timeoutSeconds);

    return {
      ok: true,
      acquired: true,
      lockId,
      expirationTime,
      resource
    };

  } catch (err) {
    console.error('acquireLock error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function releaseLock(resource = '', lockId = '') {
  try {
    const redis = getRedis();
    const lockKey = keys.lock(resource);

    const currentLock = await redis.get(lockKey);
    
    if (!currentLock) {
      return {
        ok: true,
        released: false,
        reason: 'LOCK_NOT_FOUND'
      };
    }

    if (currentLock.id !== lockId) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_ID_MISMATCH',
        message: 'Cannot release lock owned by another process'
      };
    }

    await redis.delete(lockKey);

    return {
      ok: true,
      released: true,
      resource
    };

  } catch (err) {
    console.error('releaseLock error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function isLocked(resource = '') {
  try {
    const redis = getRedis();
    const lockKey = keys.lock(resource);
    const lock = await redis.get(lockKey);

    if (!lock) {
      return {
        ok: true,
        locked: false
      };
    }

    if (lock.expiresAt < now()) {
      await redis.delete(lockKey);
      return {
        ok: true,
        locked: false
      };
    }

    return {
      ok: true,
      locked: true,
      lock
    };

  } catch (err) {
    console.error('isLocked error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function waitForLock(resource = '', maxWaitMs = 30000, pollIntervalMs = 100) {
  try {
    const startTime = now();
    const maxTime = startTime + maxWaitMs;

    while (now() < maxTime) {
      const lockCheck = await isLocked(resource);

      if (lockCheck.ok && !lockCheck.locked) {
        return {
          ok: true,
          available: true,
          waitedMs: now() - startTime
        };
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return {
      ok: false,
      available: false,
      reason: 'TIMEOUT',
      waitedMs: maxWaitMs
    };

  } catch (err) {
    console.error('waitForLock error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function withLock(resource = '', fn = null, timeoutSeconds = 30) {
  try {
    const lockAcquire = await acquireLock(resource, timeoutSeconds);
    
    if (!lockAcquire.acquired) {
      return {
        ok: false,
        executed: false,
        reason: 'COULD_NOT_ACQUIRE_LOCK'
      };
    }

    const lockId = lockAcquire.lockId;

    try {
      const result = await fn();

      return {
        ok: true,
        executed: true,
        result,
        lockId
      };

    } finally {
      await releaseLock(resource, lockId);
    }

  } catch (err) {
    console.error('withLock error:', err);
    return {
      ok: false,
      error: err.message
    };
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
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      try {
        const waitResult = await waitForLock(resource, 60000);
        
        if (!waitResult.ok || !waitResult.available) {
          lastError = 'Could not acquire lock';
          attempt++;
          
          const backoffMs = initialBackoffMs * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }

        const execResult = await withLock(resource, fn, timeoutSeconds);
        
        if (execResult.ok && execResult.executed) {
          return {
            ok: true,
            executed: true,
            result: execResult.result,
            attempts: attempt + 1
          };
        }

        lastError = execResult.reason || execResult.error;
        attempt++;

        const backoffMs = initialBackoffMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, backoffMs));

      } catch (err) {
        lastError = err.message;
        attempt++;
        
        const backoffMs = initialBackoffMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }

    return {
      ok: false,
      executed: false,
      reason: 'MAX_RETRIES_EXCEEDED',
      lastError,
      attempts: maxRetries
    };

  } catch (err) {
    console.error('withLockRetry error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function forceReleaseLock(resource = '') {
  try {
    const redis = getRedis();
    const lockKey = keys.lock(resource);
    const result = await redis.delete(lockKey);

    return {
      ok: true,
      released: result.deleted,
      resource
    };

  } catch (err) {
    console.error('forceReleaseLock error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export async function getAllLocks() {
  try {
    const redis = getRedis();
    const pattern = 'SHORT:LOCK:*';
    const lockKeys = await redis.keys(pattern);

    const locks = [];

    for (const key of lockKeys) {
      const lock = await redis.get(key);
      if (lock) {
        locks.push({
          key,
          ...lock
        });
      }
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
      error: err.message,
      locks: []
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
