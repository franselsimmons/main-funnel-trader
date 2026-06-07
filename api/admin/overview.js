// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs
} from '../../src/redis.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function now() {
  return Date.now();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);

  return [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
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
    .replaceAll('SHORT_ONLY', 'SHORT');
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    return (
      value.snapshotId ||
      value.id ||
      value.latestSnapshotId ||
      value.scanId ||
      null
    );
  }

  return null;
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      row?.microFamilyId || row?.trueMicroFamilyId || row?.id || row?.key || String(index),
      row
    ]);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value);
  }

  return [];
}

function getDefinitionHaystack(row = {}) {
  return [
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
    .map((value) => cleanSideText(value))
    .join(' | ');
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const value = cleanSideText(input);

    if (!value) return 'UNKNOWN';

    if (
      value.includes('MICRO_LONG_') ||
      value.includes('TRADESIDE=LONG') ||
      value.includes('TRADE_SIDE=LONG') ||
      value.includes('SIDE=LONG') ||
      value.includes('SIDE=BULL') ||
      value.includes('DIRECTION=LONG') ||
      value.includes('DIRECTION=BULL') ||
      value.includes('POSITION_SIDE=LONG') ||
      value.includes('POSITIONSIDE=LONG')
    ) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (
      value.includes('MICRO_SHORT_') ||
      value.includes('TRADESIDE=SHORT') ||
      value.includes('TRADE_SIDE=SHORT') ||
      value.includes('SIDE=SHORT') ||
      value.includes('SIDE=BEAR') ||
      value.includes('DIRECTION=SHORT') ||
      value.includes('DIRECTION=BEAR') ||
      value.includes('POSITION_SIDE=SHORT') ||
      value.includes('POSITIONSIDE=SHORT') ||
      value.includes('SHORT') ||
      value.includes('BEAR') ||
      value.includes('SELL')
    ) {
      return TARGET_TRADE_SIDE;
    }

    if (
      value.includes('LONG') ||
      value.includes('BULL') ||
      value.includes('BUY')
    ) {
      return OPPOSITE_TRADE_SIDE;
    }

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    input.tradeSide ||
    input.side ||
    input.positionSide ||
    input.direction ||
    input.signalSide ||
    input.scannerSide ||
    input.actualScannerSide ||
    input.analysisSide ||
    input.entrySide ||
    input.bias ||
    input.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const rawSide = cleanSideText(input.side);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(rawSide)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(rawSide)) return OPPOSITE_TRADE_SIDE;

  const familyId = cleanSideText(input.familyId || input.family || input.baseFamilyId);

  const macroFamilyId = cleanSideText(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );

  const microFamilyId = cleanSideText(
    input.microFamilyId ||
    input.trueMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (familyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;

  if (macroFamilyId.includes('TRADESIDE=LONG') || macroFamilyId.includes('SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  if (macroFamilyId.includes('TRADESIDE=SHORT') || macroFamilyId.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;

  if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  if (microFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;

  if (microFamilyId.includes('TRADESIDE=LONG') || microFamilyId.includes('SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  if (microFamilyId.includes('TRADESIDE=SHORT') || microFamilyId.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;

  const definition = getDefinitionHaystack(input);

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY') ||
    definition.includes('POSITION_SIDE=LONG') ||
    definition.includes('POSITIONSIDE=LONG')
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL') ||
    definition.includes('POSITION_SIDE=SHORT') ||
    definition.includes('POSITIONSIDE=SHORT')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (microFamilyId.includes('LONG')) return OPPOSITE_TRADE_SIDE;
  if (microFamilyId.includes('SHORT')) return TARGET_TRADE_SIDE;

  if (macroFamilyId.includes('LONG')) return OPPOSITE_TRADE_SIDE;
  if (macroFamilyId.includes('SHORT')) return TARGET_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isAllowedShortId(id = '') {
  return inferTradeSide(String(id || '')) !== OPPOSITE_TRADE_SIDE;
}

function filterShortRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .filter(isShortRow);
}

function countMapOrArray(value) {
  return sourceEntries(value)
    .filter(([key, row]) => isShortRow({
      ...(row || {}),
      microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || key
    }))
    .length;
}

function countLongMapOrArray(value) {
  return sourceEntries(value)
    .filter(([key, row]) => isLongRow({
      ...(row || {}),
      microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || key
    }))
    .length;
}

function normalizeShortSide(row = {}) {
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

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterShortRows(rawCandidates).map(normalizeShortSide);

  const createdAt = safeNumber(
    latestScan.createdAt ||
    latestScan.completedAt ||
    latestScan.ts ||
    latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const topSymbols = rawCandidates.length > 0
    ? candidates
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean)
    : Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols
      : [];

  const fallbackCandidatesCount = safeNumber(
    latestScan.shortCandidatesCount ??
    latestScan.selectedTargetCandidateCount ??
    latestScan.scannerGateCandidatesCount ??
    latestScan.candidatesCount ??
    latestScan.count,
    0
  );

  return {
    ...latestScan,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    snapshotId: extractSnapshotId(latestScan),

    createdAt: createdAt || null,
    snapshotAgeSec,

    rawCandidatesCount: rawCandidates.length,

    candidatesCount: rawCandidates.length > 0
      ? candidates.length
      : fallbackCandidatesCount,

    shortCandidatesCount: rawCandidates.length > 0
      ? candidates.length
      : fallbackCandidatesCount,

    longCandidatesIgnored: rawCandidates.filter(isLongRow).length,

    topSymbols,

    candidates
  };
}

function normalizeRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawMicroFamilies = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const microFamilies = rawMicroFamilies
    .filter(isShortRow)
    .map(normalizeShortSide);

  const rowIds = microFamilies
    .map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id || row.key)
    .filter(Boolean);

  const explicitIds = uniqueStrings([
    ...(Array.isArray(rotation.microFamilyIds) ? rotation.microFamilyIds : []),
    ...(Array.isArray(rotation.activeMicroFamilyIds) ? rotation.activeMicroFamilyIds : []),
    ...(Array.isArray(rotation.trueMicroFamilyIds) ? rotation.trueMicroFamilyIds : []),
    ...(Array.isArray(rotation.ids) ? rotation.ids : [])
  ]).filter(isAllowedShortId);

  const microFamilyIds = uniqueStrings([
    ...explicitIds,
    ...rowIds
  ]);

  const macroFamilyIds = uniqueStrings([
    ...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
    ...(Array.isArray(rotation.activeMacroFamilyIds) ? rotation.activeMacroFamilyIds : []),
    ...(Array.isArray(rotation.macroIds) ? rotation.macroIds : []),
    ...microFamilies.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  ]).filter(isAllowedShortId);

  const bestShortRaw =
    rotation.bestShort ||
    microFamilies.find((row) => isShortRow(row)) ||
    null;

  const bestShort = bestShortRaw
    ? normalizeShortSide(bestShortRaw)
    : null;

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    sideMode: 'short_only',

    bestLong: null,
    bestShort,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    count: microFamilyIds.length || microFamilies.length,

    rawMicroFamiliesCount: rawMicroFamilies.length,
    longMicroFamiliesIgnored: rawMicroFamilies.filter(isLongRow).length,

    missingSides: microFamilyIds.length || microFamilies.length
      ? []
      : [TARGET_TRADE_SIDE]
  };
}

function actionIsLearningOnly(action = {}) {
  return Boolean(
    action.shadowOnly ||
    action.learningOnly ||
    action.observationOnly ||
    action.analysisInputOnly ||
    action.source === 'SHADOW' ||
    action.shadowResult ||
    action.reason === 'SHORT_RISK_INVALID' ||
    action.reason === 'RISK_ENGINE_EMPTY_SHORT_RISK_OBSERVATION_ONLY'
  );
}

function normalizeTradeAction(action = {}) {
  return normalizeShortSide({
    ...action,
    shadowOnly: actionIsLearningOnly(action),
    realTrade: !actionIsLearningOnly(action) && action.action === 'ENTRY',
    scannerScore: action.scannerScore ?? action.moveScore ?? null
  });
}

function buildActionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function buildShortActionCounts(actions = [], fallbackCounts = {}) {
  const shortActions = filterShortRows(actions);

  if (!shortActions.length && !actions.length) {
    return fallbackCounts || {};
  }

  return buildActionCounts(shortActions);
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},
      learningActionCounts: {},

      actions: 0,
      learningActions: 0,

      entries: 0,
      waits: 0,

      realExits: 0,
      shadowExits: 0,
      learningShadowExits: 0,

      skippedNewEntries: null,
      reason: null,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      realTradesOnly: true,
      shadowTradesExcluded: true
    };
  }

  const rawActions = Array.isArray(tradeMeta.actions)
    ? tradeMeta.actions.map(normalizeTradeAction)
    : [];

  const allShortActions = filterShortRows(rawActions).map(normalizeShortSide);
  const liveActions = allShortActions.filter((row) => !row.shadowOnly);
  const learningActions = allShortActions.filter((row) => row.shadowOnly);

  const longActionsIgnored = rawActions.filter(isLongRow).length;

  const realExits = Array.isArray(tradeMeta.realExits)
    ? filterShortRows(tradeMeta.realExits).map(normalizeShortSide)
    : [];

  const learningShadowExits = Array.isArray(tradeMeta.shadowExits)
    ? filterShortRows(tradeMeta.shadowExits).map((row) => normalizeShortSide({
      ...row,
      shadowOnly: true,
      learningOnly: true,
      realTrade: false
    }))
    : [];

  const entries = liveActions.filter((row) => row.action === 'ENTRY');
  const waits = liveActions.filter((row) => row.action === 'WAIT');

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,

    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    realTradesOnly: true,
    shadowTradesExcluded: true,
    shadowDataMode: 'LEARNING_DIAGNOSTIC_ONLY',

    actionCounts: buildShortActionCounts(liveActions, tradeMeta.actionCounts || {}),
    rawActionCounts: tradeMeta.actionCounts || buildActionCounts(rawActions),
    learningActionCounts: buildActionCounts(learningActions),

    actions: liveActions.length,
    rawActions: rawActions.length,
    allShortActions: allShortActions.length,
    learningActions: learningActions.length,
    longActionsIgnored,

    entries: entries.length,
    waits: waits.length,

    realExits: realExits.length,
    shadowExits: 0,
    learningShadowExits: learningShadowExits.length,

    rawRealExits: Array.isArray(tradeMeta.realExits) ? tradeMeta.realExits.length : 0,
    rawShadowExits: Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits.length : 0,

    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || null,

    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null,

    entriesSymbols: entries
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
      .slice(0, 20)
  };
}

function compactRotationDashboard(rotationDashboard = {}) {
  const active = normalizeRotation(
    rotationDashboard.active ||
    rotationDashboard.activeRotation ||
    null
  );

  const next = normalizeRotation(
    rotationDashboard.next ||
    rotationDashboard.nextRotation ||
    null
  );

  const activeRows = filterShortRows(rotationDashboard.activeRows || []).map(normalizeShortSide);
  const nextRows = filterShortRows(rotationDashboard.nextRows || []).map(normalizeShortSide);

  return {
    ...rotationDashboard,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    active,
    next,
    activeRotation: active,
    nextRotation: next,

    activeRows,
    nextRows,

    activeCount: active?.count || activeRows.length || 0,
    nextCount: next?.count || nextRows.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    bestLong: null,
    bestShort: active?.bestShort || null,

    nextBestLong: null,
    nextBestShort: next?.bestShort || null,

    missingSides: active?.missingSides || [],
    nextMissingSides: next?.missingSides || []
  };
}

function buildPositionSummary(rawPositions = []) {
  const positions = filterShortRows(rawPositions).map(normalizeShortSide);
  const ignoredLongPositions = rawPositions.filter(isLongRow).length;
  const ignoredUnknownPositions = rawPositions.filter((row) => inferTradeSide(row) === 'UNKNOWN').length;

  return {
    positions,
    positionsCount: positions.length,
    rawPositionsCount: rawPositions.length,
    ignoredLongPositions,
    ignoredUnknownPositions
  };
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value
    };
  } catch (error) {
    return {
      ok: false,
      label,
      value: fallback,
      error: error?.message || String(error)
    };
  }
}

export default async function handler(req, res) {
  const startedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Overview-Mode', 'short-only-real-trades');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Shadow-Trades-Excluded', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const weekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ] = await Promise.all([
      safeRead(
        'latestScan',
        () => getJson(volatile, KEYS.scan.latest, null),
        null
      ),

      safeRead(
        'tradeMeta',
        () => getJson(durable, KEYS.trade.runMeta, null),
        null
      ),

      safeRead(
        'openPositions',
        () => getOpenPositions(),
        []
      ),

      safeRead(
        'currentWeekMicros',
        () => getWeekMicros(weekKey),
        {}
      ),

      safeRead(
        'previousWeekMicros',
        () => getWeekMicros(previousWeekKey),
        {}
      ),

      safeRead(
        'rotationDashboard',
        () => getRotationDashboard(),
        {
          active: null,
          next: null,
          validFrom: null,
          activeRows: [],
          nextRows: [],
          activeCount: 0,
          nextCount: 0
        }
      ),

      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, KEYS.discord.logList, 10),
        []
      )
    ]);

    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);

    const rawPositions = asArray(positionsRead.value);
    const positionSummary = buildPositionSummary(rawPositions);

    const currentMicros = currentMicrosRead.value || {};
    const previousMicros = previousMicrosRead.value || {};

    const rawRotationDashboard = rotationRead.value || {};
    const rotationDashboard = compactRotationDashboard(rawRotationDashboard);

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const discordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const warnings = [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    const longIgnored = {
      positions: positionSummary.ignoredLongPositions,
      currentWeekMicroFamilies: countLongMapOrArray(currentMicros),
      previousWeekMicroFamilies: countLongMapOrArray(previousMicros),
      scannerCandidates: latestScan?.longCandidatesIgnored || 0,
      activeRotationRows: activeRotation?.longMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.longMicroFamiliesIgnored || 0
    };

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      realTradesOnly: true,
      shadowTradesExcluded: true,
      shadowDataMode: 'LEARNING_DIAGNOSTIC_ONLY',

      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,

      latestScan,
      latestScannerSnapshotId: latestScan?.snapshotId || null,

      scannerCandidates: latestScan?.candidatesCount || 0,
      shortScannerCandidates: latestScan?.shortCandidatesCount || latestScan?.candidatesCount || 0,

      tradeMeta,
      tradeSummary,

      openPositions: positionSummary.positionsCount,
      positionsCount: positionSummary.positionsCount,
      rawPositionsCount: positionSummary.rawPositionsCount,
      ignoredLongPositions: positionSummary.ignoredLongPositions,
      ignoredUnknownPositions: positionSummary.ignoredUnknownPositions,
      positions: positionSummary.positions,

      currentWeekMicroFamilies: countMapOrArray(currentMicros),
      previousWeekMicroFamilies: countMapOrArray(previousMicros),

      activeRotation,
      nextRotation,

      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,

      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,

      activeMicroFamilyIds: activeRotation?.microFamilyIds || [],
      nextMicroFamilyIds: nextRotation?.microFamilyIds || [],

      activeMacroFamilyIds: activeRotation?.macroFamilyIds || [],
      nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],

      bestLong: null,
      bestShort: activeRotation?.bestShort || null,
      nextBestLong: null,
      nextBestShort: nextRotation?.bestShort || null,

      rotationDashboard,

      discordLogs,

      longIgnored,
      warnings,

      perf: {
        durationMs: now() - startedAt,
        source: 'short_only_real_trades_overview'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      realTradesOnly: true,
      shadowTradesExcluded: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}