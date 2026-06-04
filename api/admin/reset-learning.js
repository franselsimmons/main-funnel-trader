// ================= FILE: api/admin/reset-learning.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  delPattern,
  pushJsonLog
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';

const CONFIRM_TEXT = 'RESET_LEARNING';
const LOCK_TTL_SEC = 180;

const LOCK_KEYS = {
  resetLearning: 'ADMIN:RESET_LEARNING:LOCK',
  trade: KEYS.trade?.lock || 'TRADE:LOCK',
  freeze: KEYS.analyze?.freezeLock || 'ANALYZE:WEEKLY_FREEZE_LOCK',
  activate: KEYS.analyze?.activateLock || 'ANALYZE:ROTATION_ACTIVATE_LOCK'
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
    if (typeof req.body === 'string') return parseJson(req.body.trim());
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8').trim());

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function isConfirmed(body) {
  return (
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT
  );
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

    if (current !== token) return false;

    await redis.del(key);

    return true;
  } catch {
    return false;
  }
}

async function acquireOneLock({ redis, key, token, reason, acquired }) {
  const ok = await acquireLock(redis, key, token);

  if (!ok) {
    return {
      ok: false,
      reason,
      acquired
    };
  }

  acquired.push(key);

  return {
    ok: true,
    acquired
  };
}

async function acquireResetLearningLocks(redis, token) {
  const acquired = [];

  const steps = [
    {
      key: LOCK_KEYS.resetLearning,
      reason: 'RESET_LEARNING_ALREADY_RUNNING'
    },
    {
      key: LOCK_KEYS.trade,
      reason: 'TRADE_RUN_ACTIVE'
    },
    {
      key: LOCK_KEYS.freeze,
      reason: 'WEEKLY_FREEZE_ACTIVE'
    },
    {
      key: LOCK_KEYS.activate,
      reason: 'ROTATION_ACTIVATE_ACTIVE'
    }
  ];

  for (const step of steps) {
    const result = await acquireOneLock({
      redis,
      key: step.key,
      token,
      reason: step.reason,
      acquired
    });

    if (!result.ok) return result;
  }

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

async function delKey(redis, key) {
  if (!key) return 0;

  return redis.del(key);
}

async function runLearningDeleteSteps(redis) {
  const deleted = {};

  // Alles onder ANALYZE:WEEK:* pakt:
  // - oude full-object week key
  // - nieuwe compressed/sharded index
  // - nieuwe compressed/sharded rows
  // - week meta
  deleted.weeks = await delPattern(
    redis,
    'ANALYZE:WEEK:*',
    10000
  );

  deleted.microStats = await delPattern(
    redis,
    'ANALYZE:MICRO:*',
    10000
  );

  deleted.observationDedupeA = await delPattern(
    redis,
    'ANALYZE:OBS:LAST:*',
    10000
  );

  deleted.observationDedupeB = await delPattern(
    redis,
    'ANALYZE:OBS:*',
    10000
  );

  deleted.shadowA = await delPattern(
    redis,
    'ANALYZE:SHADOW:*',
    10000
  );

  deleted.shadowB = await delPattern(
    redis,
    'ANALYZE:SHADOW_OPEN:*',
    10000
  );

  deleted.shadowC = await delPattern(
    redis,
    'ANALYZE:SHADOW_LAST:*',
    10000
  );

  // Active rotation blijft staan, zodat TradeSystem niet direct zonder gate draait.
  // Next rotation moet weg, want die is gebaseerd op learning-data die nu verwijderd is.
  deleted.nextRotation = await delKey(
    redis,
    KEYS.analyze?.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    redis,
    KEYS.analyze?.rotationValidFrom
  );

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
        openPositions: true,
        scannerSnapshots: true,
        tradeMemory: true,
        resetLogs: true,
        discordLogs: true
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
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  } finally {
    if (redis && acquiredLocks.length > 0) {
      await releaseLocks(redis, acquiredLocks, token);
    }
  }
}