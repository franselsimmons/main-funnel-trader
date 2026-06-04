// ================= FILE: api/admin/reset-learning.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  delPattern,
  pushJsonLog
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/src/discord.js';

const CONFIRM_TEXT = 'RESET_LEARNING';
const LOCK_TTL_SEC = 180;

const LOCK_KEYS = {
  resetLearning: 'ADMIN:RESET_LEARNING:LOCK',
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

async function acquireResetLearningLocks(redis, token) {
  const acquired = [];

  const resetAcquired = await acquireLock(redis, LOCK_KEYS.resetLearning, token);

  if (!resetAcquired) {
    return {
      ok: false,
      reason: 'RESET_LEARNING_ALREADY_RUNNING',
      acquired
    };
  }

  acquired.push(LOCK_KEYS.resetLearning);

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

async function runLearningDeleteSteps(redis) {
  const deleted = {};

  deleted.weeks = await delPattern(redis, 'ANALYZE:WEEK:*', 10000);
  deleted.microStats = await delPattern(redis, 'ANALYZE:MICRO:*', 10000);
  deleted.observationDedupe = await delPattern(redis, 'ANALYZE:OBS:LAST:*', 10000);
  deleted.shadow = await delPattern(redis, 'ANALYZE:SHADOW:*', 10000);

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const token = randomUUID();
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const confirmed =
      body.confirm === CONFIRM_TEXT ||
      body.confirmed === CONFIRM_TEXT;

    if (!confirmed) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'CONFIRMATION_REQUIRED',
        required: CONFIRM_TEXT
      });
    }

    const redis = getDurableRedis();

    const lockResult = await acquireResetLearningLocks(redis, token);
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

    const deleted = await runLearningDeleteSteps(redis);

    const report = {
      ok: true,
      type: 'RESET_LEARNING',
      deleted,
      preserved: {
        activeRotation: true,
        nextRotation: true,
        openPositions: true,
        scannerSnapshots: true,
        tradeMemory: true
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
    if (acquiredLocks.length > 0) {
      await releaseLocks(getDurableRedis(), acquiredLocks, token);
    }
  }
}