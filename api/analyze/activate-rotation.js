// ================= FILE: api/analyze/activate-rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis, setJson } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { getIsoWeekKey } from '../../src/utils.js';
import {
  activateNextRotation,
  activateSelectedMicroFamilies,
  buildRotationFromWeek
} from '../../src/analyze/rotationEngine.js';

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

function query(req = {}) {
  return req.query || {};
}

function getParam(req, body, key, fallback = undefined) {
  const q = query(req);

  if (body?.[key] !== undefined) return body[key];
  if (q?.[key] !== undefined) return q[key];

  return fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function parseIdList(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.microFamilyId) return item.microFamilyId;
        if (item?.id) return item.id;

        return '';
      })
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\s,;\n\r]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    return parseIdList(
      value.microFamilyIds ||
      value.ids ||
      value.activeMicroFamilyIds ||
      []
    );
  }

  return [];
}

function extractMicroFamilyIds(req, body = {}) {
  const q = query(req);

  return uniqueStrings([
    ...parseIdList(body.microFamilyIds),
    ...parseIdList(body.ids),
    ...parseIdList(body.activeMicroFamilyIds),
    ...parseIdList(q.microFamilyIds),
    ...parseIdList(q.ids),
    ...parseIdList(q.activeMicroFamilyIds)
  ]);
}

function getActivateLockTtlSec() {
  const ttl = Number(CONFIG.analyze?.activateLockTtlSec || 600);

  return Number.isFinite(ttl) && ttl > 0
    ? ttl
    : 600;
}

function getMode(req, body = {}) {
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

function getActiveWeekKey(req, body = {}, fallbackWeekKey) {
  return String(
    getParam(
      req,
      body,
      'activeWeekKey',
      fallbackWeekKey || getIsoWeekKey()
    ) || fallbackWeekKey || getIsoWeekKey()
  ).trim();
}

function isManualRun(req, body = {}, ids = []) {
  return (
    ids.length > 0 ||
    isTrue(getParam(req, body, 'manual', false)) ||
    isTrue(getParam(req, body, 'force', false)) ||
    isTrue(getParam(req, body, 'activateBest', false))
  );
}

function shouldBuildFreshRotation(req, body = {}, ids = []) {
  if (ids.length > 0) return false;

  return (
    isTrue(getParam(req, body, 'build', false)) ||
    isTrue(getParam(req, body, 'force', false)) ||
    isTrue(getParam(req, body, 'activateBest', false))
  );
}

function shouldAutoBuildIfMissing(req, body = {}) {
  return isTrue(getParam(req, body, 'autoBuildIfMissing', false));
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

function responseRotationId(payload) {
  return (
    payload?.activeRotation?.rotationId ||
    payload?.active?.rotationId ||
    payload?.rotationId ||
    payload?.builtRotation?.rotationId ||
    null
  );
}

function responseActivatedCount(payload) {
  return (
    payload?.activatedCount ||
    payload?.activeRotation?.microFamilyIds?.length ||
    payload?.active?.microFamilyIds?.length ||
    payload?.microFamilyIds?.length ||
    0
  );
}

function responseReason(lockResult, payload) {
  return (
    lockResult?.reason ||
    payload?.reason ||
    payload?.emptyReason ||
    payload?.activeRotation?.emptyReason ||
    null
  );
}

function lockOk(lockResult, payload) {
  if (lockResult?.ok === false) return false;
  if (payload?.ok === false) return false;

  return true;
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

async function buildFreshRotationAndActivate({
  redis,
  weekKey,
  activeWeekKey,
  mode
}) {
  const builtRotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    builtRotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: 'IMMEDIATE_ADMIN_ACTIVATION',
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: builtRotation.rotationId,
      mode
    }
  );

  const activated = await activateNextRotation();

  return {
    ok: activated?.ok !== false,
    type: 'BUILT_AND_ACTIVATED_ROTATION',

    weekKey,
    activeWeekKey,
    mode,

    rotationId:
      activated?.rotationId ||
      activated?.activeRotation?.rotationId ||
      builtRotation.rotationId,

    activatedCount:
      activated?.activatedCount ||
      activated?.activeRotation?.microFamilyIds?.length ||
      builtRotation.microFamilyIds?.length ||
      0,

    builtRotation,
    activeRotation: activated?.activeRotation || null,
    reason: activated?.reason || builtRotation.emptyReason || null,

    result: activated
  };
}

async function activateManualSelection({
  microFamilyIds,
  weekKey,
  mode
}) {
  const activeRotation = await activateSelectedMicroFamilies({
    microFamilyIds,
    weekKey,
    mode
  });

  return {
    ok: true,
    type: 'MANUAL_MICRO_FAMILY_ROTATION_ACTIVATED',

    weekKey,
    activeWeekKey: activeRotation.activeWeekKey || getIsoWeekKey(),
    mode,

    rotationId: activeRotation.rotationId,
    activatedCount: activeRotation.microFamilyIds?.length || 0,

    activeRotation,
    reason: activeRotation.emptyReason || null
  };
}

async function activateExistingNextRotation({
  redis,
  weekKey,
  activeWeekKey,
  mode,
  autoBuildIfMissing
}) {
  const activated = await activateNextRotation();

  if (
    activated?.ok === false &&
    activated?.reason === 'NEXT_ROTATION_MISSING' &&
    autoBuildIfMissing
  ) {
    return buildFreshRotationAndActivate({
      redis,
      weekKey,
      activeWeekKey,
      mode
    });
  }

  return {
    ok: activated?.ok !== false,
    type: 'NEXT_ROTATION_ACTIVATED',

    weekKey,
    activeWeekKey,
    mode,

    rotationId:
      activated?.rotationId ||
      activated?.activeRotation?.rotationId ||
      null,

    activatedCount:
      activated?.activatedCount ||
      activated?.activeRotation?.microFamilyIds?.length ||
      0,

    activeRotation: activated?.activeRotation || null,
    reason: activated?.reason || null,

    result: activated
  };
}

async function runActivation({
  req,
  body,
  redis
}) {
  const microFamilyIds = extractMicroFamilyIds(req, body);
  const weekKey = getWeekKey(req, body);
  const activeWeekKey = getActiveWeekKey(req, body, weekKey);
  const mode = getMode(req, body);

  if (microFamilyIds.length > 0) {
    return activateManualSelection({
      microFamilyIds,
      weekKey,
      mode: mode || 'manual'
    });
  }

  if (shouldBuildFreshRotation(req, body, microFamilyIds)) {
    return buildFreshRotationAndActivate({
      redis,
      weekKey,
      activeWeekKey,
      mode
    });
  }

  return activateExistingNextRotation({
    redis,
    weekKey,
    activeWeekKey,
    mode,
    autoBuildIfMissing: shouldAutoBuildIfMissing(req, body)
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
    const lockKey = KEYS.analyze?.activateLock || 'ANALYZE:ROTATION_ACTIVATE_LOCK';
    const lockTtlSec = getActivateLockTtlSec();

    const microFamilyIds = extractMicroFamilyIds(req, body);

    const lockResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runActivation({
        req,
        body,
        redis
      })
    );

    const payload = unwrapLockResult(lockResult);

    return res.status(200).json({
      ok: lockOk(lockResult, payload),
      skipped: Boolean(lockResult?.skipped || payload?.skipped),

      source: isManualRun(req, body, microFamilyIds)
        ? 'ADMIN_MANUAL_ACTIVATE_ROTATION'
        : 'CRON_OR_API_ACTIVATE_ROTATION',

      type: payload?.type || null,

      weekKey: payload?.weekKey || getWeekKey(req, body),
      activeWeekKey: payload?.activeWeekKey || null,
      mode: payload?.mode || getMode(req, body),

      rotationId: responseRotationId(payload),
      activatedCount: responseActivatedCount(payload),
      reason: responseReason(lockResult, payload),

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