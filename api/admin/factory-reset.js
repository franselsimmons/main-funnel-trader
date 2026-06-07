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
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { sendResetReport } from '../../src/discord/discord.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

const LOCK_TTL_SEC = 300;

const LOCK_KEYS = {
  admin: 'ADMIN:FACTORY_RESET:LOCK',
  scanner: KEYS.scan?.lock || 'SCAN:LOCK',
  trade: KEYS.trade?.lock || 'TRADE:LOCK',
  freeze: KEYS.analyze?.freezeLock || 'ANALYZE:WEEKLY_FREEZE_LOCK',
  activate: KEYS.analyze?.activateLock || 'ANALYZE:ROTATION_ACTIVATE_LOCK'
};

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],

    ...modePayload()
  });
}

function modePayload() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualPositionsOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    manualSelectionRequired: true,
    discordOnlyForSelectedMicroFamilies: true,

    autoRotationActivationDisabled: true
  };
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
    if (typeof req.body === 'string') {
      return parseJson(req.body.trim());
    }

    if (Buffer.isBuffer(req.body)) {
      return parseJson(req.body.toString('utf8').trim());
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1'
  );
}

function isConfirmed(body = {}, requiredText) {
  return (
    body.confirm === requiredText ||
    body.confirmed === requiredText
  );
}

async function delKey(redis, key) {
  if (!redis || !key) return 0;

  return redis.del(key).catch(() => 0);
}

async function delPatternSafe(redis, pattern, count = 10000) {
  if (!redis || !pattern) return 0;

  return delPattern(redis, pattern, count).catch(() => 0);
}

async function acquireLock(redis, key, token) {
  if (!redis || !key || !token) return false;

  const acquired = await redis.set(key, token, {
    nx: true,
    ex: LOCK_TTL_SEC
  });

  return Boolean(acquired);
}

async function releaseLock(redis, key, token) {
  try {
    if (!redis || !key || !token) return false;

    const current = await redis.get(key);

    if (current !== token) return false;

    await redis.del(key);

    return true;
  } catch {
    return false;
  }
}

async function acquireOneLock({
  redis,
  key,
  token,
  reason,
  acquired
}) {
  const ok = await acquireLock(redis, key, token);

  if (!ok) {
    return {
      ok: false,
      reason,
      acquired
    };
  }

  acquired.push({
    redis,
    key
  });

  return {
    ok: true,
    acquired
  };
}

async function acquireResetLocks({
  durable,
  volatile,
  token
}) {
  const acquired = [];

  const steps = [
    {
      redis: durable,
      key: LOCK_KEYS.admin,
      reason: 'FACTORY_RESET_ALREADY_RUNNING'
    },
    {
      redis: volatile,
      key: LOCK_KEYS.scanner,
      reason: 'SCANNER_RUN_ACTIVE'
    },
    {
      redis: durable,
      key: LOCK_KEYS.trade,
      reason: 'TRADE_RUN_ACTIVE'
    },
    {
      redis: durable,
      key: LOCK_KEYS.freeze,
      reason: 'WEEKLY_FREEZE_ACTIVE'
    },
    {
      redis: durable,
      key: LOCK_KEYS.activate,
      reason: 'ROTATION_ACTIVATE_ACTIVE'
    }
  ];

  for (const step of steps) {
    const result = await acquireOneLock({
      redis: step.redis,
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

async function releaseResetLocks(acquired = [], token) {
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

function openPositionSymbols(openPositions = []) {
  return openPositions
    .map((position) => (
      position.symbol ||
      position.baseSymbol ||
      position.contractSymbol ||
      null
    ))
    .filter(Boolean);
}

function normalizeOpenPosition(position = {}) {
  return {
    tradeId: position.tradeId || null,

    symbol: position.symbol || position.baseSymbol || null,
    baseSymbol: position.baseSymbol || position.symbol || null,
    contractSymbol: position.contractSymbol || null,

    microFamilyId: position.microFamilyId || position.trueMicroFamilyId || null,
    trueMicroFamilyId: position.trueMicroFamilyId || position.microFamilyId || null,
    familyId: position.familyId || null,
    macroFamilyId:
      position.parentMacroFamilyId ||
      position.macroFamilyId ||
      position.parentMicroFamilyId ||
      null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,

    source: position.source || 'VIRTUAL',
    virtualOnly: position.virtualOnly !== false,
    virtualTracked: position.virtualTracked !== false,
    shadowOnly: position.shadowOnly !== false,

    openedAt: position.openedAt || position.createdAt || null,
    updatedAt: position.updatedAt || null
  };
}

async function runDeleteSteps({
  durable,
  volatile
}) {
  const deleted = {};

  // Scanner volatile data.
  deleted.scanSnapshots = await delPatternSafe(
    volatile,
    'SCAN:SNAPSHOT:*',
    10000
  );

  deleted.scanLatest = await delKey(
    volatile,
    KEYS.scan?.latest
  );

  deleted.scanRunMeta = await delKey(
    volatile,
    KEYS.scan?.runMeta
  );

  // Trade durable data: virtual open positions only.
  deleted.tradeOpenVirtualPositions = await delPatternSafe(
    durable,
    'TRADE:OPEN:*',
    10000
  );

  deleted.tradeLastProcessed = await delKey(
    durable,
    KEYS.trade?.lastProcessedSnapshot
  );

  deleted.tradeMeta = await delKey(
    durable,
    KEYS.trade?.runMeta
  );

  deleted.tradeLocks = 0;

  // Circuit breakers / optional safety state.
  deleted.circuitPaused = await delPatternSafe(
    durable,
    'CIRCUIT:PAUSED:*',
    10000
  );

  // Analyze learning data.
  deleted.analyzeWeeks = await delPatternSafe(
    durable,
    'ANALYZE:WEEK:*',
    10000
  );

  deleted.analyzeMicros = await delPatternSafe(
    durable,
    'ANALYZE:MICRO:*',
    10000
  );

  deleted.analyzeObsLast = await delPatternSafe(
    durable,
    'ANALYZE:OBS:LAST:*',
    10000
  );

  deleted.analyzeShadow = await delPatternSafe(
    durable,
    'ANALYZE:SHADOW:*',
    10000
  );

  deleted.analyzeOutcomeDedupe = await delPatternSafe(
    durable,
    'ANALYZE:OUTCOME:*',
    10000
  );

  // Rotation: explicit factory reset may wipe manual selection.
  deleted.activeRotation = await delKey(
    durable,
    KEYS.analyze?.activeRotation
  );

  deleted.nextRotation = await delKey(
    durable,
    KEYS.analyze?.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    durable,
    KEYS.analyze?.rotationValidFrom
  );

  // Volatile live cache.
  deleted.liveCache = await delPatternSafe(
    volatile,
    'LIVE:CACHE:*',
    10000
  );

  deleted.marketCache = await delPatternSafe(
    volatile,
    'MARKET:CACHE:*',
    10000
  );

  deleted.bitgetCache = await delPatternSafe(
    volatile,
    'BITGET:CACHE:*',
    10000
  );

  return deleted;
}

function buildBlockedResponse({
  reason,
  extra = {}
} = {}) {
  return {
    ok: false,
    blocked: true,
    reason,

    ...modePayload(),

    ...extra
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Factory-Reset-Mode', 'short-only-virtual-learning-v2');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Virtual-Positions-Only', 'true');

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
      return res.status(400).json(
        buildBlockedResponse({
          reason: 'CONFIRMATION_REQUIRED',
          extra: {
            required: requiredConfirmText
          }
        })
      );
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

      return res.status(409).json(
        buildBlockedResponse({
          reason: lockResult.reason,
          extra: {
            released
          }
        })
      );
    }

    const openPositions = await getOpenPositions();

    if (openPositions.length > 0 && !force) {
      return res.status(409).json(
        buildBlockedResponse({
          reason: 'OPEN_VIRTUAL_POSITIONS_EXIST',
          extra: {
            count: openPositions.length,
            symbols: openPositionSymbols(openPositions),
            openPositions: openPositions.map(normalizeOpenPosition),
            requiredForceFlag: 'force=true'
          }
        })
      );
    }

    const deleted = await runDeleteSteps({
      durable,
      volatile
    });

    const report = {
      ok: true,
      type: 'FACTORY_RESET',

      ...modePayload(),

      force,

      exchangeTouched: false,
      bitgetOrdersTouched: false,
      realOrdersTouched: false,

      openPositionsCount: openPositions.length,
      openPositionSymbols: openPositionSymbols(openPositions),
      openPositions: openPositions.map(normalizeOpenPosition),

      deleted,

      preserved: {
        resetLogs: true,
        discordLogs: true,
        environmentVariables: true,
        deploymentConfig: true
      },

      resetAt: now()
    };

    await pushJsonLog(
      durable,
      KEYS.reset?.logList || 'RESET:LOGS',
      report,
      100
    ).catch(() => null);

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      ...modePayload(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  } finally {
    if (acquiredLocks.length > 0) {
      await releaseResetLocks(acquiredLocks, token);
    }
  }
}