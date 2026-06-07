// ================= FILE: scripts/runTradeSystem.js =================

import { runTradeSystem } from '../src/trade/tradeSystem.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function hasFlag(flag) {
  return (
    process.argv.includes(flag) ||
    process.argv.includes(`--${flag}`)
  );
}

function getArgValue(name) {
  const normalizedName = String(name || '').replace(/^--/, '');
  const prefix = `--${normalizedName}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force'].includes(raw);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function shouldForceProcessSnapshot() {
  return (
    hasFlag('force') ||
    hasFlag('--force') ||
    hasFlag('forceProcessSnapshot') ||
    hasFlag('--forceProcessSnapshot') ||
    hasFlag('force-process-snapshot') ||
    hasFlag('--force-process-snapshot') ||
    isTrue(getArgValue('force')) ||
    isTrue(getArgValue('forceProcessSnapshot')) ||
    isTrue(getArgValue('force-process-snapshot'))
  );
}

function shouldMonitorOnly() {
  return (
    hasFlag('monitorOnly') ||
    hasFlag('--monitorOnly') ||
    hasFlag('monitor-only') ||
    hasFlag('--monitor-only') ||
    isTrue(getArgValue('monitorOnly')) ||
    isTrue(getArgValue('monitor-only'))
  );
}

function shouldManualRun() {
  return (
    hasFlag('manual') ||
    hasFlag('--manual') ||
    shouldForceProcessSnapshot() ||
    isTrue(getArgValue('manual'))
  );
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length > 0) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    output.push(value);
  }

  return output;
}

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === 'object') {
    return Object.values(value);
  }

  return [];
}

function upper(value, fallback = '') {
  const text = String(value || '').trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeTradeSide(side) {
  const raw = cleanSideText(side);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferSideFromText(value = '') {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const shortHit = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL')
  );

  const longHit = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY')
  );

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function getDefinitionHaystack(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.activeMicroFamilyId,
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

    row.scannerReason,
    row.reason,
    row.waitReason,
    row.signalReason,
    row.actionReason,
    row.exitReason,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function getSide(row = {}) {
  if (typeof row === 'string') {
    return inferSideFromText(row);
  }

  if (!row || typeof row !== 'object') {
    return 'UNKNOWN';
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side ||
    row.bias ||
    row.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const inferred = inferSideFromText(getDefinitionHaystack(row));

  if (inferred === TARGET_TRADE_SIDE || inferred === OPPOSITE_TRADE_SIDE) {
    return inferred;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return getSide(row) === TARGET_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return getSide(row) === OPPOSITE_TRADE_SIDE;
}

function forceShortRow(row = {}) {
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
    shortDisabled: false,

    source: row.source || 'VIRTUAL',
    virtualOnly: row.virtualOnly !== false,
    virtualTracked: row.virtualTracked !== false,
    shadowOnly: row.shadowOnly !== false,

    realTrade: false
  };
}

function onlyShortRows(rows = []) {
  return asArray(rows)
    .filter(isShortRow)
    .map(forceShortRow);
}

function actionType(row = {}) {
  return upper(row?.action || row?.type || 'UNKNOWN', 'UNKNOWN');
}

function waitReason(row = {}) {
  return upper(row?.reason || row?.waitReason || 'UNKNOWN', 'UNKNOWN');
}

function exitReason(row = {}) {
  return upper(row?.exitReason || row?.reason || row?.type || 'UNKNOWN', 'UNKNOWN');
}

function getMicroFamilyId(row = {}) {
  return (
    row?.microFamilyId ||
    row?.trueMicroFamilyId ||
    row?.activeMicroFamilyId ||
    row?.liveMicroFamilyId ||
    row?.realMicroFamilyId ||
    row?.executionMicroFamilyId ||
    row?.id ||
    null
  );
}

function getTrueMicroFamilyId(row = {}) {
  return (
    row?.trueMicroFamilyId ||
    row?.microFamilyId ||
    row?.executionMicroFamilyId ||
    row?.id ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row?.parentMacroFamilyId ||
    row?.activeMacroFamilyId ||
    row?.macroFamilyId ||
    row?.parentMicroFamilyId ||
    row?.legacyMicroFamilyId ||
    row?.coarseMicroFamilyId ||
    row?.familyMacroId ||
    row?.familyId ||
    null
  );
}

function getFamilyId(row = {}) {
  return row?.familyId || row?.family || row?.baseFamilyId || null;
}

function getSymbol(row = {}) {
  return (
    row?.symbol ||
    row?.baseSymbol ||
    row?.contractSymbol ||
    null
  );
}

function netR(row = {}) {
  const value = Number(
    row.netR ??
    row.finalNetR ??
    row.outcomeNetR ??
    row.resultNetR ??
    row.rNet ??
    0
  );

  return Number.isFinite(value) ? value : 0;
}

function grossR(row = {}) {
  const value = Number(
    row.grossR ??
    row.finalGrossR ??
    row.outcomeGrossR ??
    row.resultGrossR ??
    row.rGross ??
    0
  );

  return Number.isFinite(value) ? value : 0;
}

function costR(row = {}) {
  const value = Number(
    row.costR ??
    row.totalCostR ??
    row.feeCostR ??
    row.executionCostR ??
    Math.max(0, grossR(row) - netR(row))
  );

  return Number.isFinite(value) ? value : 0;
}

function countBy(rows = [], selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);

    if (!key) return acc;

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function sum(rows = [], selector) {
  return rows.reduce((total, row) => {
    const value = Number(selector(row));

    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function avg(rows = [], selector) {
  if (!rows.length) return 0;

  return sum(rows, selector) / rows.length;
}

function round(value, decimals = 4) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Number(n.toFixed(decimals));
}

function unwrapRunResult(result = {}) {
  if (!result || typeof result !== 'object') return {};

  if (result.result?.result) return result.result.result;
  if (result.result) return result.result;

  return result;
}

function extractActions(payload = {}) {
  return asArray(
    payload.actions ||
    payload.tradeActions ||
    payload.result?.actions ||
    []
  );
}

function extractVirtualExits(payload = {}) {
  return asArray([
    ...asArray(payload.virtualExits),
    ...asArray(payload.exits),
    ...asArray(payload.realExits),
    ...asArray(payload.shadowExits),
    ...asArray(payload.learningShadowExits),
    ...asArray(payload.closedPositions),
    ...asArray(payload.outcomes)
  ]);
}

function extractOpenPositions(payload = {}) {
  return asArray(
    payload.openPositions ||
    payload.positions ||
    payload.virtualPositions ||
    payload.result?.openPositions ||
    []
  );
}

function getActionCounts(payload = {}, actions = []) {
  if (payload.actionCounts && typeof payload.actionCounts === 'object') {
    const shortActions = onlyShortRows(actions);

    if (shortActions.length > 0) {
      return countBy(shortActions, actionType);
    }

    return payload.actionCounts;
  }

  return countBy(actions, actionType);
}

function summarizeEntries(actions = []) {
  const entries = onlyShortRows(actions)
    .filter((row) => actionType(row) === 'ENTRY');

  return {
    count: entries.length,

    symbols: uniqueStrings(entries.map(getSymbol)),
    microFamilyIds: uniqueStrings(entries.map(getMicroFamilyId)),
    trueMicroFamilyIds: uniqueStrings(entries.map(getTrueMicroFamilyId)),
    macroFamilyIds: uniqueStrings(entries.map(getMacroFamilyId)),
    familyIds: uniqueStrings(entries.map(getFamilyId)),

    byMicroFamily: countBy(entries, getMicroFamilyId),
    byTrueMicroFamily: countBy(entries, getTrueMicroFamilyId),
    byMacroFamily: countBy(entries, getMacroFamilyId),
    byFamily: countBy(entries, getFamilyId)
  };
}

function summarizeWaits(actions = []) {
  const waits = onlyShortRows(actions)
    .filter((row) => actionType(row) === 'WAIT');

  return {
    count: waits.length,

    byReason: countBy(waits, waitReason),
    byMicroFamily: countBy(waits, getMicroFamilyId),
    byTrueMicroFamily: countBy(waits, getTrueMicroFamilyId),
    byMacroFamily: countBy(waits, getMacroFamilyId),

    observationOnly: waits.filter((row) => Boolean(row.observationOnly)).length,
    riskInvalid: waits.filter((row) => Boolean(row.riskInvalid || row.invalidRisk)).length,
    symbolAlreadyOpen: waits.filter((row) => waitReason(row).includes('SYMBOL_ALREADY_OPEN')).length,
    nonSelectedSilent: waits.filter((row) => Boolean(row.nonSelectedSilent || row.discordAlertEligible === false)).length
  };
}

function summarizeVirtualExits(payload = {}) {
  const rawExits = extractVirtualExits(payload);
  const exits = onlyShortRows(rawExits);

  return {
    total: exits.length,

    virtual: exits.filter((row) => row.virtualOnly !== false).length,
    selectedForDiscord: exits.filter((row) => Boolean(row.discordAlertEligible || row.selectedForDiscord)).length,

    wins: exits.filter((row) => netR(row) > 0).length,
    losses: exits.filter((row) => netR(row) < 0).length,
    flats: exits.filter((row) => netR(row) === 0).length,

    totalGrossR: round(sum(exits, grossR), 4),
    totalCostR: round(sum(exits, costR), 4),
    totalNetR: round(sum(exits, netR), 4),

    avgGrossR: round(avg(exits, grossR), 4),
    avgCostR: round(avg(exits, costR), 4),
    avgNetR: round(avg(exits, netR), 4),

    byReason: countBy(exits, exitReason),
    byMicroFamily: countBy(exits, getMicroFamilyId),
    byTrueMicroFamily: countBy(exits, getTrueMicroFamilyId),
    byMacroFamily: countBy(exits, getMacroFamilyId),

    tradeIds: uniqueStrings(exits.map((row) => row?.tradeId || row?.positionId || row?.id))
  };
}

function summarizeOpenPositions(payload = {}) {
  const positions = onlyShortRows(extractOpenPositions(payload));

  return {
    count: positions.length,

    symbols: uniqueStrings(positions.map(getSymbol)),
    microFamilyIds: uniqueStrings(positions.map(getMicroFamilyId)),
    trueMicroFamilyIds: uniqueStrings(positions.map(getTrueMicroFamilyId)),
    macroFamilyIds: uniqueStrings(positions.map(getMacroFamilyId)),

    byMicroFamily: countBy(positions, getMicroFamilyId),
    byTrueMicroFamily: countBy(positions, getTrueMicroFamilyId),
    byMacroFamily: countBy(positions, getMacroFamilyId),

    selectedForDiscord: positions.filter((row) => Boolean(row.discordAlertEligible || row.selectedForDiscord)).length,
    virtualOnly: positions.filter((row) => row.virtualOnly !== false).length
  };
}

function summarizeIgnoredSides(payload = {}, actions = []) {
  const allActions = asArray(actions);
  const allExits = extractVirtualExits(payload);
  const allPositions = extractOpenPositions(payload);

  return {
    longActionsIgnored: allActions.filter(isLongRow).length,
    unknownSideActionsIgnored: allActions.filter((row) => getSide(row) === 'UNKNOWN').length,

    longExitsIgnored: allExits.filter(isLongRow).length,
    unknownSideExitsIgnored: allExits.filter((row) => getSide(row) === 'UNKNOWN').length,

    longPositionsIgnored: allPositions.filter(isLongRow).length,
    unknownSidePositionsIgnored: allPositions.filter((row) => getSide(row) === 'UNKNOWN').length
  };
}

function buildRequestedOptions() {
  const forceProcessSnapshot = shouldForceProcessSnapshot();
  const monitorOnly = shouldMonitorOnly();

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    snapshotId: firstValue(
      getArgValue('snapshotId'),
      getArgValue('snapshot')
    ) || undefined,

    source: shouldManualRun()
      ? 'CLI_MANUAL_RUN'
      : 'CLI_RUN',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false,

    sourceMode: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true
  };
}

function buildRunOptions(requested = {}) {
  return {
    force: Boolean(requested.force),
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    monitorOnly: Boolean(requested.monitorOnly),

    snapshotId: requested.snapshotId,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false,

    source: 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true
  };
}

function sanitizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const actions = onlyShortRows(extractActions(payload));
  const exits = onlyShortRows(extractVirtualExits(payload));
  const openPositions = onlyShortRows(extractOpenPositions(payload));

  return {
    ...payload,

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

    source: payload.source || 'VIRTUAL',
    sourceMode: payload.sourceMode || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    actions,
    actionCounts: countBy(actions, actionType),
    actionsCount: actions.length,

    virtualExits: exits,
    exits,
    realExits: [],
    shadowExits: exits,
    virtualExitsCount: exits.length,
    exitsCount: exits.length,
    realExitsCount: 0,
    shadowExitsCount: exits.length,

    openPositions,
    positions: openPositions,
    virtualPositions: openPositions,
    openPositionsCount: openPositions.length,

    longActionsBlockedOrIgnored: asArray(payload.actions).filter(isLongRow).length,
    longDisabledRowsIgnored: asArray(payload.actions).filter(isLongRow).length
  };
}

function buildCliResponse({
  result,
  requested,
  runOptions,
  startedAt
}) {
  const rawPayload = unwrapRunResult(result);
  const payload = sanitizePayload(rawPayload);

  const actions = extractActions(payload);
  const actionCounts = getActionCounts(payload, actions);
  const entries = summarizeEntries(actions);
  const waits = summarizeWaits(actions);
  const exits = summarizeVirtualExits(payload);
  const positions = summarizeOpenPositions(payload);
  const ignoredSides = summarizeIgnoredSides(rawPayload, extractActions(rawPayload));

  return {
    ok: payload?.ok !== false,

    source: 'CLI_RUN_TRADE_SYSTEM_SHORT_ONLY',
    runSource: requested.source,

    argv: argv(),
    requested,
    runOptions,

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

    sourceMode: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    force: Boolean(requested.force),
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    monitorOnly: Boolean(requested.monitorOnly),

    runId: payload?.runId || null,

    snapshotId: payload?.snapshotId || null,
    snapshotCreatedAt: payload?.snapshotCreatedAt || null,
    snapshotAgeSec: payload?.snapshotAgeSec ?? null,

    skippedNewEntries: Boolean(payload?.skippedNewEntries),
    reason: payload?.reason || null,

    candidates: payload?.candidates ?? null,
    shortCandidateCount: payload?.shortCandidateCount ?? payload?.targetCandidateCount ?? null,
    nonShortCandidateCount: payload?.nonShortCandidateCount ?? payload?.nonTargetCandidateCount ?? null,

    processed: payload?.processed ?? null,
    earlyActions: payload?.earlyActions ?? null,

    observationsWritten: payload?.observationsWritten ?? payload?.analyzedRows ?? null,
    analyzedRows: payload?.analyzedRows ?? null,
    analyzedRiskValidRows: payload?.analyzedRiskValidRows ?? null,

    liveRows: payload?.liveRows ?? null,
    actualLiveRows: payload?.actualLiveRows ?? null,
    analyzeInputRows: payload?.analyzeInputRows ?? null,
    observationOnlyRows: payload?.observationOnlyRows ?? null,
    riskValidRows: payload?.riskValidRows ?? null,

    virtualPositionsOpened: payload?.virtualPositionsOpened ?? payload?.shadowCreatedRows ?? null,
    virtualPositionsSkipped: payload?.virtualPositionsSkipped ?? payload?.shadowSkippedRows ?? null,
    virtualPositionsFailed: payload?.virtualPositionsFailed ?? payload?.shadowFailedRows ?? null,

    activeRotationId: payload?.activeRotationId || null,
    activeMicroFamilies: payload?.activeMicroFamilies ?? null,
    activeMacroFamilies: payload?.activeMacroFamilies ?? null,
    trueMicroOnly: payload?.trueMicroOnly ?? true,
    manualSelectionOnly: payload?.manualSelectionOnly ?? true,
    autoSelectionDisabled: true,

    actions: actions.length,
    actionCounts,

    entries,
    waits,
    exits,
    positions,

    ignoredSides,

    scannerSnapshotStats: payload?.scannerSnapshotStats || null,

    durationMs: now() - startedAt,

    result: payload
  };
}

function buildCliError({
  error,
  requested,
  runOptions,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_RUN_TRADE_SYSTEM_SHORT_ONLY',

    argv: argv(),
    requested,
    runOptions,

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

    sourceMode: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    force: Boolean(requested.force),
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),
    monitorOnly: Boolean(requested.monitorOnly),

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

async function main() {
  const startedAt = now();
  const requested = buildRequestedOptions();
  const runOptions = buildRunOptions(requested);

  try {
    const result = await runTradeSystem(runOptions);

    const response = buildCliResponse({
      result,
      requested,
      runOptions,
      startedAt
    });

    console.log(JSON.stringify(response, null, 2));

    process.exitCode = response.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(
      buildCliError({
        error,
        requested,
        runOptions,
        startedAt
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();