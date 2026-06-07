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

const HARD_SAMPLE_MIN = 5;

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
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

    observationFirst: true,
    netOutcomesOnly: true,

    noRealOrders: true,
    manualSelectionOnly: true,
    autoRotationActivationDisabled: true,
    discordOnlyForSelectedMicroFamilies: true
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);

  return [];
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

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
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
      value.includes('POSITIONSIDE=LONG') ||
      value.includes(' BULL ') ||
      value.includes('_BULL') ||
      value.includes('BULL_') ||
      value.includes(' BUY ') ||
      value.includes('_BUY') ||
      value.includes('BUY_')
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

function normalizeShortSide(row = {}) {
  return {
    ...row,
    ...modeFlags()
  };
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

function getMicroFamilyId(row = {}, key = '') {
  return (
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    key ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.familyId ||
    row.macroId ||
    null
  );
}

function getOutcomeSample(row = {}) {
  const wins = num(row.wins ?? row.realWins, 0);
  const losses = num(row.losses ?? row.realLosses, 0);
  const flats = num(row.flats ?? row.realFlats, 0);

  return Math.max(
    wins + losses + flats,
    num(row.completed, 0),
    num(row.realCompleted, 0),
    num(row.outcomeSample, 0),
    0
  );
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    getOutcomeSample(row),
    0
  );
}

function tierForMicro(row = {}) {
  const existing = upper(row.tier || row.rotationEligibilityTier || row.selectedTier);

  if (['HARD', 'SOFT', 'OBSERVATION', 'RAW'].includes(existing)) {
    return existing;
  }

  const completed = getOutcomeSample(row);
  const observed = getObservationSample(row);

  if (completed >= HARD_SAMPLE_MIN) return 'HARD';
  if (completed > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function statusForMicro(row = {}) {
  const existing = upper(row.status || row.learningStatus);

  if (existing) return existing;

  const completed = getOutcomeSample(row);
  const observed = getObservationSample(row);

  if (completed >= HARD_SAMPLE_MIN) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';
  if (observed > 0) return 'OBSERVING';

  return 'RAW';
}

function summarizeMicros(micros = {}) {
  const rows = sourceEntries(micros)
    .map(([key, row]) => ({
      ...(row || {}),
      microFamilyId: getMicroFamilyId(row, key)
    }))
    .filter(isShortRow);

  const summary = rows.reduce((acc, row) => {
    const tier = tierForMicro(row);
    const status = statusForMicro(row);

    acc.rows += 1;
    acc.seen += num(row.seen, 0);
    acc.observations += num(row.observations, 0);
    acc.completed += getOutcomeSample(row);
    acc.totalR += num(row.totalR ?? row.realTotalR ?? row.netTotalR, 0);
    acc.totalCostR += num(row.totalCostR ?? row.realTotalCostR, 0);

    acc.tierCounts[tier] = (acc.tierCounts[tier] || 0) + 1;
    acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

    if (getOutcomeSample(row) > 0) acc.completedFamilies += 1;
    if (getObservationSample(row) > 0 && getOutcomeSample(row) <= 0) acc.observationOnlyFamilies += 1;

    return acc;
  }, {
    rows: 0,
    seen: 0,
    observations: 0,
    completed: 0,
    totalR: 0,
    totalCostR: 0,
    completedFamilies: 0,
    observationOnlyFamilies: 0,
    tierCounts: {
      HARD: 0,
      SOFT: 0,
      OBSERVATION: 0,
      RAW: 0
    },
    statusCounts: {}
  });

  return {
    ...summary,
    seen: round(summary.seen, 4),
    observations: round(summary.observations, 4),
    completed: round(summary.completed, 4),
    totalR: round(summary.totalR, 4),
    totalCostR: round(summary.totalCostR, 4),
    avgR: summary.completed > 0 ? round(summary.totalR / summary.completed, 4) : 0,
    avgCostR: summary.completed > 0 ? round(summary.totalCostR / summary.completed, 4) : 0
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterShortRows(rawCandidates)
    .map((row) => normalizeShortSide({
      ...row,
      source: row.source || 'SCANNER',
      scannerOnly: true
    }));

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

  const fallbackCandidatesCount = safeNumber(
    latestScan.shortCandidatesCount ??
    latestScan.selectedTargetCandidateCount ??
    latestScan.scannerGateCandidatesCount ??
    latestScan.candidatesCount ??
    latestScan.count,
    0
  );

  const topSymbols = candidates.length > 0
    ? candidates
      .slice(0, 20)
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
    : Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols.slice(0, 20)
      : [];

  return {
    ...latestScan,
    ...modeFlags(),

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
    .map((row) => getMicroFamilyId(row))
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
    ...microFamilies.map(getMacroFamilyId)
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
    ...modeFlags(),

    sideMode: 'short_only',

    manualOnly: rotation.manualOnly === true || rotation.adminSelected === true,
    adminSelected: rotation.adminSelected === true || rotation.manualOnly === true,
    autoRotation: false,
    liveSelectable: Boolean(rotation.liveSelectable && microFamilyIds.length > 0),

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

function actionIsLearningVirtual(action = {}) {
  return Boolean(
    action.virtualOnly !== false ||
    action.virtualTracked !== false ||
    action.shadowOnly !== false ||
    action.learningOnly ||
    action.observationOnly ||
    action.analysisInputOnly ||
    action.source === 'VIRTUAL' ||
    action.source === 'SHADOW' ||
    action.shadowResult ||
    action.reason === 'SHORT_RISK_INVALID' ||
    action.reason === 'RISK_ENGINE_EMPTY_SHORT_RISK_OBSERVATION_ONLY'
  );
}

function normalizeTradeAction(action = {}) {
  return normalizeShortSide({
    ...action,

    source: action.source || 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    learningOnly: true,
    realOrderPlaced: false,
    exchangeOrder: false,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    learningAction: actionIsLearningVirtual(action),
    discordAlertEligible: Boolean(action.discordAlertEligible),
    discordAlertSent: Boolean(action.discordAlertSent)
  });
}

function buildActionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},

      actions: 0,
      learningActions: 0,

      virtualEntries: 0,
      virtualWaits: 0,
      virtualExits: 0,

      discordEligibleActions: 0,
      discordAlertsSent: 0,

      skippedNewEntries: null,
      reason: null,

      ...modeFlags()
    };
  }

  const rawActions = Array.isArray(tradeMeta.actions)
    ? tradeMeta.actions.map(normalizeTradeAction)
    : [];

  const allShortActions = filterShortRows(rawActions).map(normalizeShortSide);
  const learningActions = allShortActions.filter((row) => row.learningAction || row.virtualOnly || row.shadowOnly);
  const longActionsIgnored = rawActions.filter(isLongRow).length;

  const entries = allShortActions.filter((row) => row.action === 'ENTRY');
  const waits = allShortActions.filter((row) => row.action === 'WAIT');

  const exitArrays = [
    ...(Array.isArray(tradeMeta.exits) ? tradeMeta.exits : []),
    ...(Array.isArray(tradeMeta.virtualExits) ? tradeMeta.virtualExits : []),
    ...(Array.isArray(tradeMeta.realExits) ? tradeMeta.realExits : []),
    ...(Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []),
    ...(Array.isArray(tradeMeta.outcomes) ? tradeMeta.outcomes : [])
  ];

  const virtualExits = filterShortRows(exitArrays).map((row) => normalizeShortSide({
    ...row,
    source: row.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    realOrderPlaced: false
  }));

  const discordEligibleActions = allShortActions.filter((row) => row.discordAlertEligible);
  const discordAlertsSent = allShortActions.filter((row) => row.discordAlertSent);

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,

    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

    ...modeFlags(),

    actionCounts: buildActionCounts(allShortActions),
    rawActionCounts: tradeMeta.actionCounts || buildActionCounts(rawActions),
    learningActionCounts: buildActionCounts(learningActions),

    actions: allShortActions.length,
    rawActions: rawActions.length,
    allShortActions: allShortActions.length,
    learningActions: learningActions.length,
    longActionsIgnored,

    virtualEntries: entries.length,
    virtualWaits: waits.length,
    virtualExits: virtualExits.length,

    entries: entries.length,
    waits: waits.length,
    exits: virtualExits.length,

    discordEligibleActions: discordEligibleActions.length,
    discordAlertsSent: discordAlertsSent.length,

    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || null,

    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null,

    entriesSymbols: entries
      .map((row) => row.symbol || row.contractSymbol)
      .filter(Boolean)
      .slice(0, 20),

    exitSymbols: virtualExits
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
    ...modeFlags(),

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

function normalizePosition(position = {}) {
  return normalizeShortSide({
    ...position,

    source: position.source || 'VIRTUAL',

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrderPlaced: false,
    exchangeOrder: false,

    selectedMicroFamily: Boolean(position.selectedMicroFamily || position.discordAlertEligible),
    discordAlertEligible: Boolean(position.discordAlertEligible),
    discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
    discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
    discordExitAlertSent: Boolean(position.discordExitAlertSent)
  });
}

function buildPositionSummary(rawPositions = []) {
  const positions = filterShortRows(rawPositions).map(normalizePosition);
  const ignoredLongPositions = rawPositions.filter(isLongRow).length;
  const ignoredUnknownPositions = rawPositions.filter((row) => inferTradeSide(row) === 'UNKNOWN').length;

  return {
    positions,
    positionsCount: positions.length,
    rawPositionsCount: rawPositions.length,
    ignoredLongPositions,
    ignoredUnknownPositions,

    virtualPositions: positions.length,
    selectedPositions: positions.filter((row) => row.selectedMicroFamily || row.discordAlertEligible).length,
    discordEntryAlertSentPositions: positions.filter((row) => row.discordEntryAlertSent).length,
    discordExitAlertEligiblePositions: positions.filter((row) => row.discordExitAlertEligible).length
  };
}

function normalizeDiscordLog(row = {}) {
  const payload = row.payload || {};

  return {
    ...row,
    payload,

    type: row.type || row.level || 'UNKNOWN',

    symbol: row.symbol || payload.symbol || payload.contractSymbol || null,
    microFamilyId: row.microFamilyId || payload.microFamilyId || null,
    familyId: row.familyId || payload.familyId || null,

    selectedOnly: Boolean(
      row.selectedOnly ||
      payload.selectedOnly ||
      payload.discordAlertEligible
    ),

    ts: row.ts || row.createdAt || null
  };
}

function summarizeDiscordLogs(logs = []) {
  const normalized = logs.map(normalizeDiscordLog);

  return normalized.reduce((acc, log) => {
    const type = upper(log.type || 'UNKNOWN');

    acc.total += 1;
    acc.byType[type] = (acc.byType[type] || 0) + 1;

    if (log.selectedOnly) acc.selectedOnly += 1;

    return acc;
  }, {
    total: 0,
    selectedOnly: 0,
    byType: {}
  });
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
  res.setHeader('X-Admin-Overview-Mode', 'short-only-virtual-learning');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');

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

    const currentMicroSummary = summarizeMicros(currentMicros);
    const previousMicroSummary = summarizeMicros(previousMicros);

    const rawRotationDashboard = rotationRead.value || {};
    const rotationDashboard = compactRotationDashboard(rawRotationDashboard);

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const discordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value.map(normalizeDiscordLog)
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
      tradeActions: tradeSummary.longActionsIgnored || 0,
      activeRotationRows: activeRotation?.longMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.longMicroFamiliesIgnored || 0
    };

    return res.status(200).json({
      ok: true,
      ...modeFlags(),

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

      virtualPositions: positionSummary.virtualPositions,
      selectedPositions: positionSummary.selectedPositions,

      ignoredLongPositions: positionSummary.ignoredLongPositions,
      ignoredUnknownPositions: positionSummary.ignoredUnknownPositions,

      positions: positionSummary.positions,

      currentWeekMicroFamilies: currentMicroSummary.rows,
      previousWeekMicroFamilies: previousMicroSummary.rows,

      currentMicroSummary,
      previousMicroSummary,

      observingMicroFamilies: currentMicroSummary.observationOnlyFamilies,
      completedMicroFamilies: currentMicroSummary.completedFamilies,

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
      discordSummary: summarizeDiscordLogs(discordLogs),

      longIgnored,
      warnings,

      perf: {
        durationMs: now() - startedAt,
        source: 'short_only_virtual_learning_overview'
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}