// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const DEFAULT_LOCK_TTL_SEC = 180;

function now() {
  return Date.now();
}

function baseFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    source: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,

    learningOnly: true,
    microFamilyLearning: true,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...baseFlags()
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

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.trade?.lockTtlSec || DEFAULT_LOCK_TTL_SEC);

  if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
  if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
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
    ? 'ADMIN_MANUAL_TRADE_RUN'
    : 'CRON_OR_API_TRADE_RUN';
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORT_ONLY', 'SHORT');
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasShortSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('DIRECTION=SELL') ||
    text.includes(' SHORT_') ||
    text.includes('_SHORT ') ||
    text.includes('_SHORT_') ||
    text.includes('|SHORT|') ||
    text.includes(':SHORT') ||
    text.includes('=SHORT') ||
    text.includes(' BEAR ') ||
    text.includes('_BEAR') ||
    text.includes('BEAR_') ||
    text.includes('|BEAR|') ||
    text.includes(':BEAR') ||
    text.includes('=BEAR') ||
    text.includes(' SELL ') ||
    text.includes('_SELL') ||
    text.includes('SELL_') ||
    text.includes('|SELL|') ||
    text.includes(':SELL') ||
    text.includes('=SELL')
  );
}

function hasLongSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('DIRECTION=BUY') ||
    text.includes(' LONG_') ||
    text.includes('_LONG ') ||
    text.includes('_LONG_') ||
    text.includes('|LONG|') ||
    text.includes(':LONG') ||
    text.includes('=LONG') ||
    text.includes(' BULL ') ||
    text.includes('_BULL') ||
    text.includes('BULL_') ||
    text.includes('|BULL|') ||
    text.includes(':BULL') ||
    text.includes('=BULL') ||
    text.includes(' BUY ') ||
    text.includes('_BUY') ||
    text.includes('BUY_') ||
    text.includes('|BUY|') ||
    text.includes(':BUY') ||
    text.includes('=BUY')
  );
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const direct = normalizeTradeSide(text);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const shortHit = hasShortSignal(text);
  const longHit = hasLongSignal(text);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferActionTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

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
    row.side ||
    row.bias ||
    row.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const reasonSide = inferTradeSideFromText(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
    row.exitReason ||
    row.rejectionReason ||
    ''
  );

  if (reasonSide !== 'UNKNOWN') return reasonSide;

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
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|');

  const side = inferTradeSideFromText(haystack);

  if (side !== 'UNKNOWN') return side;

  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;
  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortAction(row = {}) {
  return inferActionTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isLongAction(row = {}) {
  return inferActionTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function forceShortVirtualRow(row = {}) {
  const inferredTradeSide = inferActionTradeSide(row);

  return {
    ...row,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    noExchangeOrders: true,

    learningOnly: true,
    microFamilyLearning: true,

    inferredTradeSide: inferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : inferredTradeSide,

    inferredFromShortOnlyMode: inferredTradeSide === 'UNKNOWN'
  };
}

function countActionsByType(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function unwrapLockResult(lockResult) {
  if (!lockResult) return null;

  if (lockResult.result?.result?.result) return lockResult.result.result.result;
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

function sanitizeArray(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(isShortAction)
    .map(forceShortVirtualRow);
}

function sanitizeIds(ids = []) {
  return [...new Set(
    (Array.isArray(ids) ? ids : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter((id) => inferTradeSideFromText(id) !== OPPOSITE_TRADE_SIDE)
  )];
}

function sanitizeRunPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawActions = Array.isArray(payload.actions) ? payload.actions : [];

  const rawExitRows = [
    ...(Array.isArray(payload.virtualExits) ? payload.virtualExits : []),
    ...(Array.isArray(payload.shadowExits) ? payload.shadowExits : []),
    ...(Array.isArray(payload.realExits) ? payload.realExits : []),
    ...(Array.isArray(payload.exits) ? payload.exits : []),
    ...(Array.isArray(payload.closedPositions) ? payload.closedPositions : []),
    ...(Array.isArray(payload.outcomes) ? payload.outcomes : [])
  ];

  const actions = sanitizeArray(rawActions);
  const virtualExits = sanitizeArray(rawExitRows);

  const ignoredLongActions = rawActions.filter(isLongAction).length;
  const ignoredUnknownSideActions = rawActions.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;
  const ignoredLongExitRows = rawExitRows.filter(isLongAction).length;
  const ignoredUnknownSideExitRows = rawExitRows.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const activeMicroFamilyIds = sanitizeIds(payload.activeMicroFamilyIds || payload.microFamilyIds || []);
  const activeMacroFamilyIds = sanitizeIds(payload.activeMacroFamilyIds || payload.macroFamilyIds || []);

  return {
    ...payload,

    ...baseFlags(),

    actions,
    virtualActions: actions,

    actionCounts: countActionsByType(actions),

    actionsCount: actions.length,
    virtualActionsCount: actions.length,

    realExits: [],
    realExitsCount: 0,

    shadowExits: virtualExits,
    shadowExitsCount: virtualExits.length,

    virtualExits,
    virtualExitsCount: virtualExits.length,

    exits: virtualExits,
    exitsCount: virtualExits.length,

    rawActionsCount: rawActions.length,
    rawExitRowsCount: rawExitRows.length,

    ignoredLongActions,
    ignoredUnknownSideActions,
    ignoredLongExitRows,
    ignoredUnknownSideExitRows,

    longActionsBlockedOrIgnored: ignoredLongActions,
    longExitsBlockedOrIgnored: ignoredLongExitRows,

    activeMicroFamilyIds,
    activeMacroFamilyIds,

    activeMicroFamilies: Number(payload.activeMicroFamilies || activeMicroFamilyIds.length || 0),
    activeMacroFamilies: Number(payload.activeMacroFamilies || activeMacroFamilyIds.length || 0),

    selectedOppositeCandidateCount: 0,

    realTradesOnly: false,
    virtualLearningOnly: true,
    shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED'
  };
}

function sanitizeLockResult(lockResult) {
  if (!lockResult || typeof lockResult !== 'object') {
    return lockResult;
  }

  const payload = sanitizeRunPayload(unwrapLockResult(lockResult));

  return {
    ok: lockResult.ok !== false && payload?.ok !== false,
    skipped: Boolean(lockResult.skipped || payload?.skipped || payload?.skippedNewEntries),
    reason: lockResult.reason || payload?.reason || null,

    ...baseFlags(),

    result: payload
  };
}

function responseActionCounts(lockResult) {
  const payload = sanitizeRunPayload(unwrapLockResult(lockResult));

  const actions = Array.isArray(payload?.actions)
    ? payload.actions
    : [];

  if (actions.length > 0) {
    return {
      ...baseFlags(),
      ...countActionsByType(actions)
    };
  }

  return {
    ...baseFlags(),
    ...(payload?.actionCounts || {})
  };
}

function responseCounts(lockResult) {
  const payload = sanitizeRunPayload(unwrapLockResult(lockResult)) || {};

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const virtualExits = Array.isArray(payload.virtualExits) ? payload.virtualExits : [];

  return {
    ...baseFlags(),

    candidates: Number(payload.candidates || payload.candidatesCount || 0),
    shortCandidateCount: Number(payload.shortCandidateCount || payload.targetCandidateCount || payload.shortCandidatesCount || 0),
    nonShortCandidateCount: Number(payload.nonShortCandidateCount || payload.nonTargetCandidateCount || 0),

    processed: Number(payload.processed || 0),
    earlyActions: Number(payload.earlyActions || 0),

    liveRows: Number(payload.liveRows || 0),
    analyzeInputRows: Number(payload.analyzeInputRows || 0),
    actualLiveRows: Number(payload.actualLiveRows || 0),

    observationOnlyRows: Number(payload.observationOnlyRows || 0),
    learningOnlyRows: Number(payload.learningOnlyRows || 0),

    riskValidRows: Number(payload.riskValidRows || payload.analyzedRiskValidRows || 0),
    riskInvalidRows: Number(payload.riskInvalidRows || 0),

    analyzedRowsRaw: Number(payload.analyzedRowsRaw || 0),
    analyzedRows: Number(payload.analyzedRows || 0),
    analyzedActualRows: Number(payload.analyzedActualRows || 0),
    analyzedRiskValidRows: Number(payload.analyzedRiskValidRows || 0),

    virtualOpenedRows: Number(
      payload.virtualOpenedRows ||
      payload.shadowCreatedRows ||
      actions.filter((row) => row.action === 'ENTRY').length ||
      0
    ),

    virtualSkippedRows: Number(payload.virtualSkippedRows || payload.shadowSkippedRows || 0),
    virtualFailedRows: Number(payload.virtualFailedRows || payload.shadowFailedRows || 0),

    shadowCreatedRows: Number(payload.shadowCreatedRows || 0),
    shadowSkippedRows: Number(payload.shadowSkippedRows || 0),
    shadowFailedRows: Number(payload.shadowFailedRows || 0),

    actions: actions.length || Number(payload.actionsCount || 0),
    shortActions: actions.length,

    entries: actions.filter((row) => row?.action === 'ENTRY').length,
    waits: actions.filter((row) => row?.action === 'WAIT').length,
    observations: actions.filter((row) => (
      row?.action === 'OBSERVATION' ||
      row?.observationWritten ||
      row?.analysisInputOnly ||
      row?.observationOnly
    )).length,

    realExits: 0,
    shadowExits: virtualExits.length,
    virtualExits: virtualExits.length,

    activeMicroFamilies: Number(payload.activeMicroFamilies || 0),
    activeMacroFamilies: Number(payload.activeMacroFamilies || 0),

    selectedTargetCandidateCount: Number(payload.selectedTargetCandidateCount || 0),
    selectedOppositeCandidateCount: 0,

    discordEligibleEntries: Number(payload.discordEligibleEntries || 0),
    discordSkippedNotSelected: Number(payload.discordSkippedNotSelected || 0),

    ignoredLongActions: Number(payload.ignoredLongActions || 0),
    ignoredUnknownSideActions: Number(payload.ignoredUnknownSideActions || 0),
    ignoredLongExitRows: Number(payload.ignoredLongExitRows || 0),
    ignoredUnknownSideExitRows: Number(payload.ignoredUnknownSideExitRows || 0),

    longActionsBlockedOrIgnored: Number(payload.longActionsBlockedOrIgnored || 0),
    longExitsBlockedOrIgnored: Number(payload.longExitsBlockedOrIgnored || 0)
  };
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    String(error?.message || '').includes('LOCK')
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

    monitorOpenPositionsFirst: true,
    processScannerSnapshot: !monitorOnly,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    source: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: true,
    microFamilyLearning: true,

    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Exchange-Orders-Disabled', 'true');
  res.setHeader('X-No-Real-Orders', 'true');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const runOptions = buildRunOptions(req, body);

    const redis = getDurableRedis();
    const lockKey = KEYS.trade?.lock || 'TRADE:LOCK';
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runTradeSystem(runOptions)
    );

    const payload = sanitizeRunPayload(unwrapLockResult(rawResult));
    const result = sanitizeLockResult(rawResult);

    return res.status(200).json({
      ok: responseOk(rawResult),
      skipped: responseSkipped(rawResult),
      reason: responseReason(rawResult),

      ...baseFlags(),

      runSource: getRunSource(req, body),

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      monitorOnly: runOptions.monitorOnly,
      monitorOpenPositionsFirst: runOptions.monitorOpenPositionsFirst,

      runId: responseRunId(rawResult),
      snapshotId: responseSnapshotId(rawResult),

      actionCounts: responseActionCounts(rawResult),
      counts: responseCounts(rawResult),

      activeRotationId: payload?.activeRotationId || null,
      activeMicroFamilies: Number(payload?.activeMicroFamilies || 0),
      activeMacroFamilies: Number(payload?.activeMacroFamilies || 0),

      activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds
        : [],

      activeMacroFamilyIds: Array.isArray(payload?.activeMacroFamilyIds)
        ? payload.activeMacroFamilyIds
        : [],

      selectedSnapshotSource: payload?.selectedSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: Number(payload?.selectedTargetCandidateCount || 0),
      selectedOppositeCandidateCount: 0,

      warnings: [
        payload?.ignoredLongActions > 0
          ? `LONG_ACTIONS_IGNORED:${payload.ignoredLongActions}`
          : null,
        payload?.ignoredLongExitRows > 0
          ? `LONG_EXIT_ROWS_IGNORED:${payload.ignoredLongExitRows}`
          : null,
        payload?.ignoredUnknownSideActions > 0
          ? `UNKNOWN_SIDE_ACTIONS_FORCED_SHORT:${payload.ignoredUnknownSideActions}`
          : null
      ].filter(Boolean),

      durationMs: now() - startedAt,

      run: payload,
      result
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
      ok: false,

      ...baseFlags(),

      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}