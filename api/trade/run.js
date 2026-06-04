// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/src/tradeSystem.js';

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

function getLockTtlSec() {
  return Number(CONFIG.trade?.lockTtlSec || 180);
}

function shouldForceProcessSnapshot(req, body) {
  return (
    req.query?.force === 'true' ||
    req.query?.forceProcessSnapshot === 'true' ||
    body.force === true ||
    body.forceProcessSnapshot === true
  );
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);

    const redis = getDurableRedis();
    const lockKey = KEYS.trade?.lock || 'TRADE:LOCK';
    const lockTtlSec = getLockTtlSec();

    const result = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runTradeSystem({ forceProcessSnapshot })
    );

    return res.status(200).json({
      ok: result?.ok !== false,
      source: forceProcessSnapshot ? 'ADMIN_MANUAL_RUN' : 'CRON_OR_API_RUN',
      forceProcessSnapshot,
      durationMs: Date.now() - startedAt,
      result
    });
  } catch (error) {
    const status =
      error?.statusCode ||
      error?.reason === 'LOCK_NOT_ACQUIRED' ||
      error?.message === 'LOCK_NOT_ACQUIRED'
        ? 409
        : 500;

    return res.status(status).json({
      ok: false,
      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}