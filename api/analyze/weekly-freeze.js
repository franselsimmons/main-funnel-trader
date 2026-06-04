// ================= FILE: api/analyze/weekly-freeze.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey
} from '../../src/utils.js';
import { freezeWeeklyRotation } from '../../src/analyze/rotationEngine.js';

function now() {
  return Date.now();
}

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
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8');

  return parseJson(text);
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES'
  );
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0];

  return value;
}

function query(req = {}) {
  return req.query || {};
}

function getParam(req, body, key, fallback = undefined) {
  const q = query(req);

  const bodyValue = firstValue(body?.[key]);
  const queryValue = firstValue(q?.[key]);

  if (bodyValue !== undefined && bodyValue !== null && bodyValue !== '') {
    return bodyValue;
  }

  if (queryValue !== undefined && queryValue !== null && queryValue !== '') {
    return queryValue;
  }

  return fallback;
}

function getFreezeLockTtlSec() {
  const ttl = Number(CONFIG.analyze?.freezeLockTtlSec || 600);

  return Number.isFinite(ttl) && ttl > 0
    ? ttl
    : 600;
}

function getRotationMode(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'mode',
      CONFIG.rotation?.mode || 'balanced'
    ) || 'balanced'
  ).trim();
}

function getWeekKey(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'weekKey',
      getIsoWeekKey()
    ) || getIsoWeekKey()
  ).trim();
}

function getActiveWeekKey(req, body = {}) {
  const explicit =
    getParam(req, body, 'activeWeekKey', null) ||
    getParam(req, body, 'nextWeekKey', null);

  if (explicit) {
    return String(explicit).trim();
  }

  return getNextIsoWeekKey();
}

function isManualRun(req, body = {}) {
  return (
    isTrue(getParam(req, body, 'force', false)) ||
    isTrue(getParam(req, body, 'manual', false)) ||
    Boolean(getParam(req, body, 'weekKey', null)) ||
    Boolean(getParam(req, body, 'activeWeekKey', null)) ||
    Boolean(getParam(req, body, 'nextWeekKey', null)) ||
    Boolean(getParam(req, body, 'mode', null))
  );
}

function unwrapLockResult(lockResult) {
  if (
    lockResult &&
    typeof lockResult === 'object' &&
    Object.prototype.hasOwnProperty.call(lockResult, 'result')
  ) {
    return lockResult.result;
  }

  return lockResult || null;
}

function payloadOk(lockResult, payload) {
  if (lockResult?.ok === false) return false;
  if (payload?.ok === false) return false;

  return true;
}

function responseWeekKey(payload, fallbackWeekKey = null) {
  return (
    payload?.weekKey ||
    payload?.rotation?.sourceWeekKey ||
    fallbackWeekKey ||
    null
  );
}

function responseActiveWeekKey(payload, fallbackActiveWeekKey = null) {
  return (
    payload?.activeWeekKey ||
    payload?.rotation?.activeWeekKey ||
    fallbackActiveWeekKey ||
    null
  );
}

function responseRotationId(payload) {
  return (
    payload?.rotationId ||
    payload?.rotation?.rotationId ||
    null
  );
}

function responseSelectedCount(payload) {
  return (
    payload?.selectedMicroFamilies ||
    payload?.rotation?.microFamilyIds?.length ||
    payload?.rotation?.microFamilies?.length ||
    0
  );
}

function responseEligibleCount(payload) {
  return (
    payload?.rotation?.eligibleCount ||
    0
  );
}

function responseRankedCount(payload) {
  return (
    payload?.rotation?.rankedCount ||
    0
  );
}

function responseEmptyReason(payload) {
  return (
    payload?.rotation?.emptyReason ||
    payload?.emptyReason ||
    payload?.reason ||
    null
  );
}

function responseMicroFamilyIds(payload) {
  return Array.isArray(payload?.rotation?.microFamilyIds)
    ? payload.rotation.microFamilyIds
    : [];
}

function errorStatus(error) {
  if (Number.isFinite(error?.statusCode)) {
    return error.statusCode;
  }

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    error?.message?.includes?.('LOCK')
  ) {
    return 409;
  }

  return 500;
}

async function runFreeze({
  req,
  body
}) {
  const weekKey = getWeekKey(req, body);
  const activeWeekKey = getActiveWeekKey(req, body);
  const mode = getRotationMode(req, body);

  return freezeWeeklyRotation({
    weekKey,
    activeWeekKey,
    mode
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const redis = getDurableRedis();
    const lockKey = KEYS.analyze?.freezeLock || 'ANALYZE:WEEKLY_FREEZE_LOCK';
    const lockTtlSec = getFreezeLockTtlSec();

    const weekKey = getWeekKey(req, body);
    const activeWeekKey = getActiveWeekKey(req, body);
    const mode = getRotationMode(req, body);

    const lockResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runFreeze({
        req,
        body
      })
    );

    const payload = unwrapLockResult(lockResult);

    return res.status(200).json({
      ok: payloadOk(lockResult, payload),
      skipped: Boolean(lockResult?.skipped || payload?.skipped),

      source: isManualRun(req, body)
        ? 'ADMIN_MANUAL_FREEZE'
        : 'CRON_OR_API_FREEZE',

      type: payload?.type || 'NEXT_ROTATION_READY',

      weekKey: responseWeekKey(payload, weekKey),
      activeWeekKey: responseActiveWeekKey(payload, activeWeekKey),
      mode,

      rotationId: responseRotationId(payload),

      selectedMicroFamilies: responseSelectedCount(payload),
      eligibleCount: responseEligibleCount(payload),
      rankedCount: responseRankedCount(payload),

      empty: Boolean(payload?.rotation?.empty),
      emptyReason: responseEmptyReason(payload),

      microFamilyIds: responseMicroFamilyIds(payload),

      durationMs: now() - startedAt,

      result: payload,
      lock: {
        ok: lockResult?.ok !== false,
        skipped: Boolean(lockResult?.skipped),
        reason: lockResult?.reason || null
      }
    });
  } catch (error) {
    return res.status(errorStatus(error)).json({
      ok: false,
      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}