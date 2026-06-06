// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
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
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force'].includes(raw);
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
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||

    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );
}

function shouldMonitorOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.monitorOnly, false)) ||
    isTrue(firstValue(req.query?.monitor_only, false)) ||

    isTrue(body.monitorOnly) ||
    isTrue(body.monitor_only)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||

    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );

  return manual
    ? 'ADMIN_MANUAL_RUN'
    : 'CRON_OR_API_RUN';
}

function unwrapLockResult(lockResult) {
  if (!lockResult) return null;

  if (lockResult.result?.result) return lockResult.result.result;
  if (lockResult.result) return lockResult.result;

  return lockResult;
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

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = String(value || '').toUpperCase();

  if (!text) return 'UNKNOWN';

  const shortHit = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.includes('SHORT_') ||
    text.includes('_SHORT') ||
    text.includes('BEAR_') ||
    text.includes('_BEAR') ||
    text.includes('SELL_') ||
    text.includes('_SELL')
  );

  const longHit = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.includes('LONG_') ||
    text.includes('_LONG') ||
    text.includes('BULL_') ||
    text.includes('_BULL') ||
    text.includes('BUY_') ||
    text.includes('_BUY')
  );

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferActionTradeSide(row = {}) {
  if (typeof row === 'string') {
    return inferTradeSideFromText(row);
  }

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.entrySide ||
    row.side
  );

  if (direct !== 'UNKNOWN') return direct;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  return inferTradeSideFromText(haystack);
}

function isShortAction(row = {}) {
  return inferActionTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongAction(row = {}) {
  return inferActionTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function forceShortAction(row = {}) {
  return {
    ...row,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function countActionsByType(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function responseActionCounts(lockResult) {
  const payload = unwrapLockResult(lockResult);

  const rawActions = Array.isArray(payload?.actions)
    ? payload.actions
    : [];

  if (rawActions.length > 0) {
    const shortActions = rawActions
      .filter(isShortAction)
      .map(forceShortAction);

    return {
      ...countActionsByType(shortActions),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false
    };
  }

  return {
    ...(payload?.actionCounts || {}),

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function responseCounts(lockResult) {
  const payload = unwrapLockResult(lockResult);

  const actions = Array.isArray(payload?.actions)
    ? payload.actions
    : [];

  const shortActions = actions.filter(isShortAction);
  const longActions = actions.filter(isLongAction);
  const unknownActions = actions.filter((row) => inferActionTradeSide(row) === 'UNKNOWN');

  const realExits = Array.isArray(payload?.realExits)
    ? payload.realExits
    : [];

  const shadowExits = Array.isArray(payload?.shadowExits)
    ? payload.shadowExits
    : [];

  const shortRealExits = realExits.filter(isShortAction);
  const shortShadowExits = shadowExits.filter(isShortAction);

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    candidates: Number(payload?.candidates || 0),
    shortCandidateCount: Number(payload?.shortCandidateCount || payload?.targetCandidateCount || 0),
    nonShortCandidateCount: Number(payload?.nonShortCandidateCount || payload?.nonTargetCandidateCount || 0),

    processed: Number(payload?.processed || 0),
    earlyActions: Number(payload?.earlyActions || 0),

    liveRows: Number(payload?.liveRows || 0),
    analyzeInputRows: Number(payload?.analyzeInputRows || 0),
    actualLiveRows: Number(payload?.actualLiveRows || 0),
    mirrorRows: Number(payload?.mirrorRows || 0),
    observationOnlyRows: Number(payload?.observationOnlyRows || 0),
    syntheticRiskRows: Number(payload?.syntheticRiskRows || 0),
    learningOnlyRows: Number(payload?.learningOnlyRows || 0),
    riskValidRows: Number(payload?.riskValidRows || 0),

    analyzedRowsRaw: Number(payload?.analyzedRowsRaw || 0),
    analyzedRows: Number(payload?.analyzedRows || 0),
    analyzedActualRows: Number(payload?.analyzedActualRows || 0),
    analyzedMirrorRows: Number(payload?.analyzedMirrorRows || 0),
    analyzedRiskValidRows: Number(payload?.analyzedRiskValidRows || 0),
    analyzedSyntheticRiskRows: Number(payload?.analyzedSyntheticRiskRows || 0),

    shadowCreatedRows: Number(payload?.shadowCreatedRows || 0),
    shadowSkippedRows: Number(payload?.shadowSkippedRows || 0),
    shadowFailedRows: Number(payload?.shadowFailedRows || 0),

    actions: actions.length || Number(payload?.actionsCount || 0),
    shortActions: shortActions.length,
    longActionsBlockedOrIgnored: longActions.length,
    unknownSideActionsIgnored: unknownActions.length,

    entries: shortActions.filter((row) => row?.action === 'ENTRY').length,
    waits: shortActions.filter((row) => row?.action === 'WAIT').length,

    realExits: shortRealExits.length || Number(payload?.realExitsCount || 0),
    shadowExits: shortShadowExits.length || Number(payload?.shadowExitsCount || 0),

    longRealExitsIgnored: realExits.filter(isLongAction).length,
    longShadowExitsIgnored: shadowExits.filter(isLongAction).length,

    activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
    activeMacroFamilies: Number(payload?.activeMacroFamilies || 0),

    selectedTargetCandidateCount: Number(payload?.selectedTargetCandidateCount || 0),
    selectedOppositeCandidateCount: Number(payload?.selectedOppositeCandidateCount || 0)
  };
}

function sanitizeRunPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const actions = Array.isArray(payload.actions)
    ? payload.actions.filter(isShortAction).map(forceShortAction)
    : payload.actions;

  const realExits = Array.isArray(payload.realExits)
    ? payload.realExits.filter(isShortAction).map(forceShortAction)
    : payload.realExits;

  const shadowExits = Array.isArray(payload.shadowExits)
    ? payload.shadowExits.filter(isShortAction).map(forceShortAction)
    : payload.shadowExits;

  const actionCounts = Array.isArray(actions)
    ? countActionsByType(actions)
    : payload.actionCounts;

  return {
    ...payload,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    actions,
    realExits,
    shadowExits,
    actionCounts,

    actionsCount: Array.isArray(actions) ? actions.length : payload.actionsCount,
    realExitsCount: Array.isArray(realExits) ? realExits.length : payload.realExitsCount,
    shadowExitsCount: Array.isArray(shadowExits) ? shadowExits.length : payload.shadowExitsCount
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
  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const monitorOnly = shouldMonitorOnly(req, body);

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,

    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
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

    const payload = sanitizeRunPayload(unwrapLockResult(result));

    return res.status(200).json({
      ok: responseOk(result),
      skipped: responseSkipped(result),
      reason: responseReason(result),

      source: getRunSource(req, body),

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      monitorOnly: runOptions.monitorOnly,

      runId: responseRunId(result),
      snapshotId: responseSnapshotId(result),

      actionCounts: responseActionCounts(result),
      counts: responseCounts(result),

      activeRotationId: payload?.activeRotationId || null,
      activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
      activeMacroFamilies: Number(payload?.activeMacroFamilies || 0),

      selectedSnapshotSource: payload?.selectedSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: Number(payload?.selectedTargetCandidateCount || 0),
      selectedOppositeCandidateCount: Number(payload?.selectedOppositeCandidateCount || 0),

      durationMs: Date.now() - startedAt,

      run: payload,
      result
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}