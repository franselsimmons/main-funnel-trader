// ================= FILE: api/admin/reset-rotation.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  pushJsonLog
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/src/discord.js';

const CONFIRM_TEXT = 'RESET_ROTATION';
const LOCK_TTL_SEC = 180;

const LOCK_KEYS = {
  resetRotation: 'ADMIN:RESET_ROTATION:LOCK',
  trade: KEYS.trade?.lock || 'TRADE:LOCK'
};

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST']
  });
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

async function acquireLock(redis, key, token) {
  const acquired = await redis.set(key, token, {
    nx: true,
    ex: LOCK_TTL_SEC
  });

  return Boolean(acquired);
}

async function releaseLock(redis, key, token) {
  try {
    const current = await redis.get(key);

    if (current === token) {
      await redis.del(key);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function acquireResetRotationLocks(redis, token) {
  const acquired = [];

  const resetAcquired = await acquireLock(redis, LOCK_KEYS.resetRotation, token);

  if (!resetAcquired) {
    return {
      ok: false,
      reason: 'RESET_ROTATION_ALREADY_RUNNING',
      acquired
    };
  }

  acquired.push(LOCK_KEYS.resetRotation);

  const tradeAcquired = await acquireLock(redis, LOCK_KEYS.trade, token);

  if (!tradeAcquired) {
    return {
      ok: false,
      reason: 'TRADE_RUN_ACTIVE',
      acquired
    };
  }

  acquired.push(LOCK_KEYS.trade);

  return {
    ok: true,
    acquired
  };
}

async function releaseLocks(redis, keys, token) {
  const released = [];

  for (const key of [...keys].reverse()) {
    const ok = await releaseLock(redis, key, token);

    released.push({
      key,
      released: ok
    });
  }

  return released;
}

function isConfirmed(body) {
  return (
    body.confirm === true ||
    body.confirmed === true ||
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT
  );
}

async function deleteRotationKeys(redis) {
  const deleted = {};

  deleted.activeRotation = await redis.del(KEYS.analyze.activeRotation);
  deleted.nextRotation = await redis.del(KEYS.analyze.nextRotation);
  deleted.rotationValidFrom = await redis.del(KEYS.analyze.rotationValidFrom);

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const token = randomUUID();
  let redis = null;
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    if (!isConfirmed(body)) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'CONFIRMATION_REQUIRED',
        required: CONFIRM_TEXT
      });
    }

    redis = getDurableRedis();

    const lockResult = await acquireResetRotationLocks(redis, token);
    acquiredLocks = lockResult.acquired || [];

    if (!lockResult.ok) {
      const released = await releaseLocks(redis, acquiredLocks, token);
      acquiredLocks = [];

      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: lockResult.reason,
        released
      });
    }

    const deleted = await deleteRotationKeys(redis);

    const report = {
      ok: true,
      type: 'RESET_ROTATION',
      deleted,
      preserved: {
        learning: true,
        weeklyStats: true,
        observations: true,
        outcomes: true,
        openPositions: true,
        scannerSnapshots: true
      },
      resetAt: Date.now()
    };

    await pushJsonLog(
      redis,
      KEYS.reset?.logList || 'RESET:LOGS',
      report,
      100
    );

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  } finally {
    if (redis && acquiredLocks.length > 0) {
      await releaseLocks(redis, acquiredLocks, token);
    }
  }
}