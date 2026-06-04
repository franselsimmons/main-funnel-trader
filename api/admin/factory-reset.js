// ================= FILE: api/admin/factory-reset.js =================

import { randomUUID } from 'node:crypto';

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  delPattern,
  pushJsonLog
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/src/positionEngine.js';
import { sendResetReport } from '../../src/discord/src/discord.js';

const LOCK_TTL_SEC = 300;

const LOCK_KEYS = {
  admin: 'ADMIN:FACTORY_RESET:LOCK',
  scanner: KEYS.scan?.lock || 'SCAN:LOCK',
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

function isTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isConfirmed(body, requiredText) {
  return (
    body.confirm === requiredText ||
    body.confirmed === requiredText
  );
}

async function delKey(redis, key) {
  if (!key) return 0;
  return redis.del(key);
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

    if (current !== token) {
      return false;
    }

    await redis.del(key);
    return true;
  } catch {
    return false;
  }
}

async function acquireResetLocks({ durable, volatile, token }) {
  const acquired = [];

  const adminAcquired = await acquireLock(durable, LOCK_KEYS.admin, token);

  if (!adminAcquired) {
    return {
      ok: false,
      reason: 'FACTORY_RESET_ALREADY_RUNNING',
      acquired
    };
  }

  acquired.push({
    redis: durable,
    key: LOCK_KEYS.admin
  });

  const scannerAcquired = await acquireLock(volatile, LOCK_KEYS.scanner, token);

  if (!scannerAcquired) {
    return {
      ok: false,
      reason: 'SCANNER_RUN_ACTIVE',
      acquired
    };
  }

  acquired.push({
    redis: volatile,
    key: LOCK_KEYS.scanner
  });

  const tradeAcquired = await acquireLock(durable, LOCK_KEYS.trade, token);

  if (!tradeAcquired) {
    return {
      ok: false,
      reason: 'TRADE_RUN_ACTIVE',
      acquired
    };
  }

  acquired.push({
    redis: durable,
    key: LOCK_KEYS.trade
  });

  return {
    ok: true,
    acquired
  };
}

async function releaseResetLocks(acquired, token) {
  const released = [];

  for (const lock of [...acquired].reverse()) {
    const ok = await releaseLock(lock.redis, lock.key, token);

    released.push({
      key: lock.key,
      released: ok
    });
  }

  return released;
}

async function runDeleteSteps({ durable, volatile }) {
  const deleted = {};

  // Scanner volatile data
  deleted.scanSnapshots = await delPattern(volatile, 'SCAN:SNAPSHOT:*', 10000);
  deleted.scanLatest = await delKey(volatile, KEYS.scan?.latest);

  // Trade durable data
  deleted.tradeOpen = await delPattern(durable, 'TRADE:OPEN:*', 10000);
  deleted.tradeLastProcessed = await delKey(durable, KEYS.trade?.lastProcessedSnapshot);
  deleted.tradeMeta = await delKey(durable, KEYS.trade?.runMeta);

  // Circuit breakers
  deleted.circuitPaused = await delPattern(durable, 'CIRCUIT:PAUSED:*', 10000);

  // Analyze learning data
  deleted.analyzeWeeks = await delPattern(durable, 'ANALYZE:WEEK:*', 10000);
  deleted.analyzeMicros = await delPattern(durable, 'ANALYZE:MICRO:*', 10000);
  deleted.analyzeObsLast = await delPattern(durable, 'ANALYZE:OBS:LAST:*', 10000);
  deleted.analyzeShadow = await delPattern(durable, 'ANALYZE:SHADOW:*', 10000);

  // Rotation
  deleted.activeRotation = await delKey(durable, KEYS.analyze?.activeRotation);
  deleted.nextRotation = await delKey(durable, KEYS.analyze?.nextRotation);
  deleted.rotationValidFrom = await delKey(durable, KEYS.analyze?.rotationValidFrom);

  // Volatile live cache
  deleted.liveCache = await delPattern(volatile, 'LIVE:CACHE:*', 10000);

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

    const requiredConfirmText =
      CONFIG.reset?.confirmText || 'FACTORY_RESET_CONFIRMED';

    const confirmed = isConfirmed(body, requiredConfirmText);

    const force =
      isTrue(body.force) ||
      isTrue(body.forceClosePositions);

    if (!confirmed) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'CONFIRMATION_REQUIRED',
        required: requiredConfirmText
      });
    }

    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const lockResult = await acquireResetLocks({
      durable,
      volatile,
      token
    });

    acquiredLocks = lockResult.acquired || [];

    if (!lockResult.ok) {
      const released = await releaseResetLocks(acquiredLocks, token);
      acquiredLocks = [];

      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: lockResult.reason,
        released
      });
    }

    const openPositions = await getOpenPositions();

    if (openPositions.length > 0 && !force) {
      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: 'OPEN_POSITIONS_EXIST',
        count: openPositions.length,
        symbols: openPositions
          .map((position) => position.symbol)
          .filter(Boolean)
      });
    }

    const deleted = await runDeleteSteps({
      durable,
      volatile
    });

    const report = {
      ok: true,
      type: 'FACTORY_RESET',
      force,
      openPositionsCount: openPositions.length,
      openPositionSymbols: openPositions
        .map((position) => position.symbol)
        .filter(Boolean),
      deleted,
      preserved: {
        resetLogs: true,
        discordLogs: true
      },
      resetAt: Date.now()
    };

    await pushJsonLog(
      durable,
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
      await releaseResetLocks(acquiredLocks, token);
    }
  }
}