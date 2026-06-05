// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';

const TARGET_TRADE_SIDE = 'SHORT';

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
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
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

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
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

function getLockTtlSec() {
  const ttl = Number(CONFIG.trade?.lockTtlSec || 180);

  return Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 180;
}

function shouldForceProcessSnapshot(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(body.force) ||
    isTrue(body.forceProcessSnapshot)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forceProcessSnapshot)
  );

  return manual
    ? 'ADMIN_MANUAL_RUN'
    : 'CRON_OR_API_RUN';
}

function unwrapLockResult(lockResult) {
  return lockResult?.result || lockResult || null;
}

function responseOk(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.ok !== false &&
    payload?.ok !== false
  );
}

function responseSkipped(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return Boolean(
    lockResult?.skipped ||
    payload?.skippedNewEntries ||
    payload?.skipped ||
    false
  );
}

function responseReason(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.reason ||
    payload?.reason ||
    null
  );
}

function responseRunId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.runId || null;
}

function responseSnapshotId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.snapshotId || null;
}

function responseActionCounts(lockResult) {
  const payload = unwrapLockResult(lockResult);
  const counts = payload?.actionCounts || {};

  return {
    ...counts,
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true
  };
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';

  return 'UNKNOWN';
}

function inferActionTradeSide(row = {}) {
  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.analysisSide
  );

  if (direct !== 'UNKNOWN') return direct;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SHORT_') ||
    haystack.includes('_SHORT')
  ) {
    return 'SHORT';
  }

  if (
    haystack.includes('MICRO_LONG_') ||
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('LONG_') ||
    haystack.includes('_LONG')
  ) {
    return 'LONG';
  }

  return 'UNKNOWN';
}

function isShortAction(row = {}) {
  return inferActionTradeSide(row) === TARGET_TRADE_SIDE;
}

function responseCounts(lockResult) {
  const payload = unwrapLockResult(lockResult);

  const actions = Array.isArray(payload?.actions)
    ? payload.actions
    : [];

  const shortActions = actions.filter(isShortAction);
  const longActions = actions.filter((row) => inferActionTradeSide(row) === 'LONG');

  const realExits = Array.isArray(payload?.realExits)
    ? payload.realExits
    : [];

  const shadowExits = Array.isArray(payload?.shadowExits)
    ? payload.shadowExits
    : [];

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    candidates: Number(payload?.candidates || 0),
    liveRows: Number(payload?.liveRows || 0),

    actions: actions.length || Number(payload?.actionsCount || 0),
    shortActions: shortActions.length,
    longActionsBlockedOrIgnored: longActions.length,

    entries: shortActions.filter((row) => row?.action === 'ENTRY').length,
    waits: shortActions.filter((row) => row?.action === 'WAIT').length,

    realExits: realExits.length || Number(payload?.realExitsCount || 0),
    shadowExits: shadowExits.length || Number(payload?.shadowExitsCount || 0),

    activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
    activeMacroFamilies: Number(payload?.activeMacroFamilies || 0)
  };
}

function resolveStatus(error) {
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

function buildRunOptions(req, body = {}) {
  return {
    forceProcessSnapshot: shouldForceProcessSnapshot(req, body),

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const runOptions = buildRunOptions(req, body);

    const redis = getDurableRedis();
    const lockKey = KEYS.trade?.lock || 'TRADE:LOCK';
    const lockTtlSec = getLockTtlSec();

    const result = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runTradeSystem(runOptions)
    );

    const payload = unwrapLockResult(result);

    return res.status(200).json({
      ok: responseOk(result),
      skipped: responseSkipped(result),
      reason: responseReason(result),

      source: getRunSource(req, body),

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,

      forceProcessSnapshot: runOptions.forceProcessSnapshot,

      runId: responseRunId(result),
      snapshotId: responseSnapshotId(result),

      actionCounts: responseActionCounts(result),
      counts: responseCounts(result),

      activeRotationId: payload?.activeRotationId || null,
      activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
      activeMacroFamilies: Number(payload?.activeMacroFamilies || 0),

      durationMs: Date.now() - startedAt,

      run: payload,
      result
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}