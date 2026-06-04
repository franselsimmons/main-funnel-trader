// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getVolatileRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST']
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.scanner?.lockTtlSec || 240);

  return Number.isFinite(ttl) && ttl > 0 ? ttl : 240;
}

function sourceLabel(req) {
  if (req.query?.force === 'true') return 'ADMIN_MANUAL_RUN';

  return 'CRON_OR_API_RUN';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const redis = getVolatileRedis();
    const lockKey = KEYS.scan?.lock || 'SCAN:LOCK';
    const lockTtlSec = getLockTtlSec();

    const result = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner()
    );

    return res.status(200).json({
      ok: result?.ok !== false,
      source: sourceLabel(req),
      durationMs: Date.now() - startedAt,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}