// ================= FILE: api/analyze/activate-rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { activateNextRotation } from '../../src/analyze/src/rotationEngine.js';

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

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
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
    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return parseJson(text);
}

function getActivateLockTtlSec() {
  return Number(CONFIG.analyze?.activateLockTtlSec || 300);
}

function errorStatus(error) {
  if (error?.statusCode) return error.statusCode;

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    error?.message?.includes?.('LOCK')
  ) {
    return 409;
  }

  return 500;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const redis = getDurableRedis();
    const lockKey = KEYS.analyze?.activateLock || 'ANALYZE:ACTIVATE:LOCK';
    const lockTtlSec = getActivateLockTtlSec();

    const result = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => activateNextRotation()
    );

    return res.status(200).json({
      ok: result?.ok !== false,
      source: req.query?.force === 'true' || body.force === true
        ? 'ADMIN_MANUAL_ACTIVATE_ROTATION'
        : 'CRON_OR_API_ACTIVATE_ROTATION',
      durationMs: Date.now() - startedAt,
      result
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({
      ok: false,
      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}