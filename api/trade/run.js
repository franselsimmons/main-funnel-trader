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
    source: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
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
    row.coarseMicroFamilyId,
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
    .map((part) => String(part || '').trim())
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

    source: row.source || 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

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
    payload?.skipReason ||
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

function selectRawExitRows(payload = {}) {
  if (Array.isArray(payload.virtualExits)) return payload.virtualExits;
  if (Array.isArray(payload.shadowExits)) return payload.shadowExits;
  if (Array.isArray(payload.exits)) return payload.exits;
  if (Array.isArray(payload.closedPositions)) return payload.closedPositions;
  if (Array.isArray(payload.outcomes)) return payload.outcomes;

  return [];
}

function buildExitAction(exit = {}) {
  return forceShortVirtualRow({
    ...exit,
    action: 'VIRTUAL_EXIT',
    reason: exit.exitReason || exit.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL'
  });
}

function sanitizeExitRows(rows = []) {
  return sanitizeArray(rows).map((row) => ({
    ...row,
    action: 'VIRTUAL_EXIT',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    noRealOrders: true
  }));
}

function buildMergedActionCounts(actions = [], virtualExits = [], payloadActionCounts = {}) {
  const exitActions = virtualExits.map(buildExitAction);

  return {
    ...(payloadActionCounts || {}),
    ...countActionsByType([
      ...actions,
      ...exitActions
    ])
  };
}

function sanitizeRunPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
  const rawExitRows = selectRawExitRows(payload);

  const actions = sanitizeArray(rawActions);
  const virtualExits = sanitizeExitRows(rawExitRows);
  const shadowExits = virtualExits;

  const ignoredLongActions = rawActions.filter(isLongAction).length;
  const ignoredUnknownSideActions = rawActions.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const ignoredLongExitRows = rawExitRows.filter(isLongAction).length;
  const ignoredUnknownSideExitRows = rawExitRows.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const activeMicroFamilyIds = sanitizeIds(
    payload.activeMicroFamilyIds ||
    payload.selectedMicroFamilyIds ||
    payload.microFamilyIds ||
    []
  );

  const activeMacroFamilyIds = sanitizeIds(
    payload.activeMacroFamilyIds ||
    payload.selectedMacroFamilyIds ||
    payload.macroFamilyIds ||
    []
  );

  const actionCounts = buildMergedActionCounts(
    actions,
    virtualExits,
    payload.actionCounts
  );

  const entryRows = safeNumber(
    payload.entryRows ??
    actions.filter((row) => row.action === 'VIRTUAL_ENTRY' || row.action === 'ENTRY').length,
    0
  );

  const waitRows = safeNumber(
    payload.waitRows ??
    actions.filter((row) => row.action === 'WAIT').length,
    0
  );

  const virtualCreatedRows = safeNumber(
    payload.virtualCreatedRows ??
    payload.shadowCreatedRows ??
    entryRows,
    0
  );

  return {
    ...payload,

    ...baseFlags(),

    actions,
    virtualActions: actions,

    actionCounts,

    actionsCount: actions.length,
    virtualActionsCount: actions.length,

    entryRows,
    waitRows,
    virtualCreatedRows,

    virtualSkippedRows: safeNumber(payload.virtualSkippedRows ?? payload.shadowSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows ?? payload.shadowFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows ?? virtualCreatedRows, virtualCreatedRows),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows ?? payload.virtualSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows ?? payload.virtualFailedRows, 0),

    realExits: [],
    realExitsCount: 0,
    realExitRows: 0,

    shadowExits,
    shadowExitsCount: shadowExits.length,
    shadowExitRows: shadowExits.length,

    virtualExits,
    virtualExitsCount: virtualExits.length,
    virtualExitRows: virtualExits.length,

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

    selectedMicroFamilyIds: sanitizeIds(payload.selectedMicroFamilyIds || activeMicroFamilyIds),
    selectedMacroFamilyIds: sanitizeIds(payload.selectedMacroFamilyIds || activeMacroFamilyIds),

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies || activeMicroFamilyIds.length, 0),
    activeMacroFamilies: safeNumber(payload.activeMacroFamilies || activeMacroFamilyIds.length, 0),

    selectedOppositeCandidateCount: 0,

    skippedNewEntries: Boolean(payload.skippedNewEntries),
    skipReason: payload.skipReason || payload.reason || null,

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
    reason: lockResult.reason || payload?.reason || payload?.skipReason || null,

    ...baseFlags(),

    result: payload
  };
}

function responseActionCounts(lockResult) {
  const payload = sanitizeRunPayload(unwrapLockResult(lockResult));

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

    candidates: safeNumber(payload.candidates || payload.candidatesCount, 0),
    shortCandidateCount: safeNumber(
      payload.shortCandidateCount ||
      payload.targetCandidateCount ||
      payload.shortCandidatesCount,
      0
    ),
    nonShortCandidateCount: safeNumber(
      payload.nonShortCandidateCount ||
      payload.nonTargetCandidateCount,
      0
    ),

    processed: safeNumber(payload.processed, 0),
    earlyActions: safeNumber(payload.earlyActions, 0),

    liveRows: safeNumber(payload.liveRows, 0),
    analyzeInputRows: safeNumber(payload.analyzeInputRows, 0),
    actualLiveRows: safeNumber(payload.actualLiveRows, 0),

    observationOnlyRows: safeNumber(payload.observationOnlyRows, 0),
    learningOnlyRows: safeNumber(payload.learningOnlyRows, 0),

    riskValidRows: safeNumber(payload.riskValidRows || payload.analyzedRiskValidRows, 0),
    riskInvalidRows: safeNumber(payload.riskInvalidRows, 0),

    analyzedRowsRaw: safeNumber(payload.analyzedRowsRaw, 0),
    analyzedRows: safeNumber(payload.analyzedRows, 0),
    analyzedActualRows: safeNumber(payload.analyzedActualRows, 0),
    analyzedRiskValidRows: safeNumber(payload.analyzedRiskValidRows, 0),

    entryRows: safeNumber(payload.entryRows, 0),
    waitRows: safeNumber(payload.waitRows, 0),

    virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualOpenedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(payload.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows, 0),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows, 0),

    actions: actions.length || safeNumber(payload.actionsCount, 0),
    shortActions: actions.length,

    entries: safeNumber(
      payload.entryRows ||
      actions.filter((row) => row?.action === 'VIRTUAL_ENTRY' || row?.action === 'ENTRY').length,
      0
    ),

    waits: safeNumber(
      payload.waitRows ||
      actions.filter((row) => row?.action === 'WAIT').length,
      0
    ),

    observations: actions.filter((row) => (
      row?.action === 'OBSERVATION' ||
      row?.observationWritten ||
      row?.analysisInputOnly ||
      row?.observationOnly
    )).length,

    realExits: 0,
    realExitRows: 0,

    shadowExits: virtualExits.length,
    shadowExitRows: virtualExits.length,

    virtualExits: virtualExits.length,
    virtualExitRows: virtualExits.length,

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
    activeMacroFamilies: safeNumber(payload.activeMacroFamilies, 0),

    selectedTargetCandidateCount: safeNumber(payload.selectedTargetCandidateCount, 0),
    selectedOppositeCandidateCount: 0,

    discordEligibleEntries: safeNumber(
      payload.discordAlertEligibleRows ||
      payload.discordEligibleEntries,
      0
    ),

    discordSkippedNotSelected: safeNumber(
      payload.discordAlertsSkippedNoSelectedMicro ||
      payload.discordSkippedNotSelected,
      0
    ),

    ignoredLongActions: safeNumber(payload.ignoredLongActions, 0),
    ignoredUnknownSideActions: safeNumber(payload.ignoredUnknownSideActions, 0),
    ignoredLongExitRows: safeNumber(payload.ignoredLongExitRows, 0),
    ignoredUnknownSideExitRows: safeNumber(payload.ignoredUnknownSideExitRows, 0),

    longActionsBlockedOrIgnored: safeNumber(payload.longActionsBlockedOrIgnored, 0),
    longExitsBlockedOrIgnored: safeNumber(payload.longExitsBlockedOrIgnored, 0)
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
    source: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
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

    const actionCounts = responseActionCounts(rawResult);
    const counts = responseCounts(rawResult);

    return res.status(200).json({
      ok: responseOk(rawResult),
      skipped: responseSkipped(rawResult),
      reason: responseReason(rawResult),
      skipReason: payload?.skipReason || responseReason(rawResult),

      ...baseFlags(),

      runSource: getRunSource(req, body),

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      monitorOnly: runOptions.monitorOnly,
      monitorOpenPositionsFirst: runOptions.monitorOpenPositionsFirst,
      processScannerSnapshot: runOptions.processScannerSnapshot,

      runId: responseRunId(rawResult),
      snapshotId: responseSnapshotId(rawResult),

      entryRows: safeNumber(payload?.entryRows, 0),
      waitRows: safeNumber(payload?.waitRows, 0),
      virtualCreatedRows: safeNumber(payload?.virtualCreatedRows, 0),

      virtualExitRows: safeNumber(payload?.virtualExitRows, 0),
      shadowExitRows: safeNumber(payload?.shadowExitRows, 0),

      virtualExits: Array.isArray(payload?.virtualExits)
        ? payload.virtualExits
        : [],

      shadowExits: Array.isArray(payload?.shadowExits)
        ? payload.shadowExits
        : [],

      realExits: [],

      actionCounts,
      counts,

      activeRotationId: payload?.activeRotationId || null,
      selectedRotationId: payload?.selectedRotationId || payload?.activeRotationId || null,

      activeMicroFamilies: safeNumber(payload?.activeMicroFamilies, 0),
      activeMacroFamilies: safeNumber(payload?.activeMacroFamilies, 0),

      activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds
        : [],

      activeMacroFamilyIds: Array.isArray(payload?.activeMacroFamilyIds)
        ? payload.activeMacroFamilyIds
        : [],

      selectedMicroFamilyIds: Array.isArray(payload?.selectedMicroFamilyIds)
        ? payload.selectedMicroFamilyIds
        : [],

      selectedMacroFamilyIds: Array.isArray(payload?.selectedMacroFamilyIds)
        ? payload.selectedMacroFamilyIds
        : [],

      selectedSnapshotSource: payload?.selectedSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: safeNumber(payload?.selectedTargetCandidateCount, 0),
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
          : null,
        payload?.ignoredUnknownSideExitRows > 0
          ? `UNKNOWN_SIDE_EXIT_ROWS_FORCED_SHORT:${payload.ignoredUnknownSideExitRows}`
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