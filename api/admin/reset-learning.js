// ================= FILE: api/admin/reset-learning.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import {
  getDurableRedis,
  pushJsonLog,
  delPattern
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';

const CONFIRM_TEXT = 'RESET_LEARNING';
const LOCK_TTL_SEC = 180;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

const LOCK_KEYS = {
  resetLearning: 'ADMIN:RESET_LEARNING:LOCK',
  trade: KEYS.trade?.lock || 'TRADE:LOCK',
  freeze: KEYS.analyze?.freezeLock || 'ANALYZE:WEEKLY_FREEZE_LOCK',
  activate: KEYS.analyze?.activateLock || 'ANALYZE:ROTATION_ACTIVATE_LOCK'
};

const DELETE_SCAN_COUNT = 10_000;

function now() {
  return Date.now();
}

function modeFlags() {
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

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    shadowOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'ALL_LEARNING_OUTCOMES',

    observationFirst: true,
    netOutcomesOnly: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    manualSelectionOnly: true,
    manualSelectionPreserved: true,
    activeRotationPreserved: true,
    autoRotationActivationDisabled: true,
    discordOnlyForSelectedMicroFamilies: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],
    ...modeFlags()
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

function isConfirmed(body = {}) {
  return (
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT ||
    body.confirmation === CONFIRM_TEXT
  );
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES' ||
    value === 'on' ||
    value === 'ON'
  );
}

function wantsForbiddenRotationReset(body = {}) {
  return (
    isTrue(body.resetRotation) ||
    isTrue(body.clearRotation) ||
    isTrue(body.resetManualSelection) ||
    isTrue(body.clearManualSelection) ||
    isTrue(body.wipeRotation)
  );
}

async function acquireLock(redis, key, token) {
  if (!redis || !key || !token) return true;

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
  if (!key) {
    return {
      ok: true,
      acquired
    };
  }

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
  if (!redis || !key) return 0;

  return redis.del(key).catch(() => 0);
}

async function delPatternSafe(redis, pattern, count = DELETE_SCAN_COUNT) {
  if (!redis || !pattern) return 0;

  return delPattern(redis, pattern, count).catch(() => 0);
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function getWeekKeyCandidates(body = {}) {
  return uniqueStrings([
    getPreviousIsoWeekKey(),
    getIsoWeekKey(),
    firstValue(body.weekKey, null),
    firstValue(body.currentWeekKey, null),
    firstValue(body.previousWeekKey, null),
    ...(Array.isArray(body.weekKeys) ? body.weekKeys : [])
  ]);
}

function weekMicrosKey(weekKey) {
  if (typeof KEYS.analyze?.weekMicros === 'function') {
    return KEYS.analyze.weekMicros(weekKey);
  }

  return `ANALYZE:WEEK:${weekKey}:MICROS`;
}

function weekMetaKey(weekKey) {
  if (typeof KEYS.analyze?.weekMeta === 'function') {
    return KEYS.analyze.weekMeta(weekKey);
  }

  return `ANALYZE:WEEK:${weekKey}:META`;
}

function getWeekStorageKeys(weekKey) {
  const base = weekMicrosKey(weekKey);

  return [
    base,
    `${base}:INDEX`,
    `${base}:TOP`,
    weekMetaKey(weekKey)
  ].filter(Boolean);
}

function getWeekRowPatterns(weekKey) {
  const base = weekMicrosKey(weekKey);

  return [
    `${base}:ROW:*`
  ].filter(Boolean);
}

async function deleteExactKeys(redis, keys = []) {
  const safeKeys = uniqueStrings(keys);

  if (!safeKeys.length) return 0;

  let deleted = 0;

  for (const key of safeKeys) {
    deleted += await delKey(redis, key);
  }

  return deleted;
}

async function deletePatterns(redis, patterns = []) {
  const safePatterns = uniqueStrings(patterns);

  if (!safePatterns.length) return 0;

  let deleted = 0;

  for (const pattern of safePatterns) {
    deleted += await delPatternSafe(redis, pattern);
  }

  return deleted;
}

async function runLearningDeleteSteps(redis, body = {}) {
  const allWeeks = isTrue(body.allWeeks ?? body.full ?? true);
  const weekKeys = getWeekKeyCandidates(body);

  const weekMainKeys = weekKeys.flatMap(getWeekStorageKeys);
  const weekRowPatterns = weekKeys.flatMap(getWeekRowPatterns);

  const deleted = {
    weekKeys,
    allWeeks,

    exactWeekStorageKeys: await deleteExactKeys(redis, weekMainKeys),
    shardedWeekRows: await deletePatterns(redis, weekRowPatterns),

    observationDedupe: await delPatternSafe(
      redis,
      'ANALYZE:OBS:LAST:*'
    ),

    outcomeDedupe: await delPatternSafe(
      redis,
      'ANALYZE:OUTCOME:*'
    ),

    shadowAnalyzeData: await delPatternSafe(
      redis,
      'ANALYZE:SHADOW:*'
    ),

    legacyMicroData: await delPatternSafe(
      redis,
      'ANALYZE:MICRO:*'
    )
  };

  if (allWeeks) {
    deleted.allWeekAnalyzeData = await delPatternSafe(
      redis,
      'ANALYZE:WEEK:*'
    );
  } else {
    deleted.allWeekAnalyzeData = 0;
  }

  deleted.nextRotation = await delKey(
    redis,
    KEYS.analyze?.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    redis,
    KEYS.analyze?.rotationValidFrom
  );

  deleted.activeRotation = 0;

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Reset-Learning-Mode', 'short-only-virtual-learning-v2');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Preserved', 'true');
  res.setHeader('X-Active-Rotation-Preserved', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');

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
        required: CONFIRM_TEXT,
        ...modeFlags()
      });
    }

    if (wantsForbiddenRotationReset(body)) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'ROTATION_RESET_NOT_ALLOWED_HERE',
        note: 'reset-learning wist alleen leerdata. Gebruik reset-rotation apart als je handmatige selectie bewust wilt wissen.',
        ...modeFlags()
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
        released,
        ...modeFlags()
      });
    }

    const deleted = await runLearningDeleteSteps(redis, body);

    const report = {
      ok: true,
      type: 'RESET_LEARNING_SHORT_ONLY_VIRTUAL',

      ...modeFlags(),

      exchangeTouched: false,
      bitgetOrdersTouched: false,
      realOrdersTouched: false,

      deleted,

      preserved: {
        activeRotation: true,
        manualSelection: true,
        openVirtualPositions: true,
        scannerSnapshots: true,
        tradeRunMeta: true,
        resetLogs: true,
        discordLogs: true,
        environmentVariables: true,
        deploymentConfig: true
      },

      removed: {
        weekMicros: true,
        weekMeta: true,
        weekTopSnapshots: true,
        shardedWeekRows: true,
        observationDedupe: true,
        outcomeDedupe: true,
        shadowAnalyzeData: true,
        legacyMicroData: true,
        nextRotation: true,
        rotationValidFrom: true,
        activeRotation: false,
        manualSelection: false,
        openVirtualPositions: false
      },

      resetAt: now()
    };

    await pushJsonLog(
      redis,
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
      ...modeFlags(),

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