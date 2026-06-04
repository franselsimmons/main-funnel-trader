// ================= FILE: src/lock.js =================

import crypto from 'node:crypto';

export async function withRedisLock(redis, key, ttlSec, task) {
  const token = `${Date.now()}_${crypto.randomUUID()}`;
  const acquired = await redis.set(key, token, { nx: true, ex: ttlSec });

  if (!acquired) {
    return {
      ok: false,
      skipped: true,
      reason: 'PREVIOUS_RUN_STILL_ACTIVE',
      lockKey: key
    };
  }

  try {
    const result = await task({ lockKey: key, lockToken: token });
    return {
      ok: true,
      skipped: false,
      lockKey: key,
      result
    };
  } finally {
    const current = await redis.get(key).catch(() => null);
    if (current === token) {
      await redis.del(key).catch(() => null);
    }
  }
}
