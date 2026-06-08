// ================= FILE: src/lock.js =================

import { randomUUID } from 'node:crypto';

const DEFAULT_LOCK_TTL_SEC = 180;
const MIN_LOCK_TTL_SEC = 5;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

function normalizeTtlSec(ttlSec) {
  const n = Number(ttlSec);

  if (!Number.isFinite(n)) return DEFAULT_LOCK_TTL_SEC;

  return Math.max(MIN_LOCK_TTL_SEC, Math.floor(n));
}

function normalizeLockKey(key) {
  return String(key || '').trim();
}

function createLockToken() {
  return `${Date.now()}_${randomUUID()}`;
}

function isLockAcquiredResult(value) {
  if (value === true) return true;
  if (value === 'OK') return true;
  if (value === 'ok') return true;
  if (value === 1) return true;

  return false;
}

async function atomicRelease(redis, key, token) {
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);

    return Number(result) === 1;
  }

  if (typeof redis.evalsha === 'function') {
    // Kept out of the hot path; scripts are not preloaded in this app.
    return false;
  }

  return null;
}

async function fallbackRelease(redis, key, token) {
  const current = await redis.get(key);

  if (String(current || '') !== token) {
    return {
      ok: false,
      released: false,
      reason: current ? 'LOCK_TOKEN_MISMATCH' : 'LOCK_ALREADY_EXPIRED',
      key
    };
  }

  const deleted = await redis.del(key);

  return {
    ok: Number(deleted) > 0,
    released: Number(deleted) > 0,
    reason: Number(deleted) > 0 ? 'LOCK_RELEASED' : 'LOCK_DELETE_NOOP',
    key
  };
}

export async function acquireRedisLock(redis, key, ttlSec = DEFAULT_LOCK_TTL_SEC) {
  const lockKey = normalizeLockKey(key);

  if (!redis || !lockKey) {
    throw new Error('ACQUIRE_LOCK_INVALID_REDIS_OR_KEY');
  }

  const token = createLockToken();
  const ttl = normalizeTtlSec(ttlSec);

  const acquired = await redis.set(lockKey, token, {
    nx: true,
    ex: ttl
  });

  if (!isLockAcquiredResult(acquired)) {
    return {
      ok: false,
      acquired: false,
      key: lockKey,
      ttlSec: ttl,
      token: null,
      reason: 'PREVIOUS_RUN_STILL_ACTIVE'
    };
  }

  return {
    ok: true,
    acquired: true,
    key: lockKey,
    ttlSec: ttl,
    token
  };
}

export async function releaseRedisLock(redis, key, token) {
  const lockKey = normalizeLockKey(key);
  const lockToken = String(token || '').trim();

  if (!redis || !lockKey || !lockToken) {
    return {
      ok: false,
      released: false,
      reason: 'RELEASE_LOCK_INVALID_INPUT',
      key: lockKey || key
    };
  }

  try {
    const atomic = await atomicRelease(redis, lockKey, lockToken);

    if (atomic === true) {
      return {
        ok: true,
        released: true,
        reason: 'LOCK_RELEASED_ATOMIC',
        key: lockKey
      };
    }

    if (atomic === false) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_TOKEN_MISMATCH_OR_ALREADY_EXPIRED',
        key: lockKey
      };
    }

    return await fallbackRelease(redis, lockKey, lockToken);
  } catch (error) {
    try {
      return await fallbackRelease(redis, lockKey, lockToken);
    } catch (fallbackError) {
      return {
        ok: false,
        released: false,
        reason: 'LOCK_RELEASE_FAILED',
        key: lockKey,
        error: fallbackError?.message || error?.message || String(fallbackError || error)
      };
    }
  }
}

export async function withRedisLock(redis, key, ttlSec, task) {
  if (typeof task !== 'function') {
    throw new Error('WITH_REDIS_LOCK_TASK_MUST_BE_FUNCTION');
  }

  const lockKey = normalizeLockKey(key);
  const lock = await acquireRedisLock(redis, lockKey, ttlSec);

  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
      lockKey,
      ttlSec: lock.ttlSec
    };
  }

  let taskResult;
  let taskError;
  let releaseResult;

  try {
    taskResult = await task({
      lockKey,
      lockToken: lock.token,
      lockTtlSec: lock.ttlSec
    });
  } catch (error) {
    taskError = error;
  }

  releaseResult = await releaseRedisLock(redis, lockKey, lock.token);

  if (taskError) {
    taskError.lockReleased = Boolean(releaseResult?.released);
    taskError.lockReleaseReason = releaseResult?.reason || null;

    throw taskError;
  }

  return {
    ok: true,
    skipped: false,
    lockKey,
    ttlSec: lock.ttlSec,
    lockReleased: Boolean(releaseResult?.released),
    lockReleaseReason: releaseResult?.reason || null,
    result: taskResult
  };
}