// ================= FILE: scripts/runTradeSystem.js =================

import { runTradeSystem } from '../src/trade/tradeSystem.js';

const VALID_TRADE_SIDES = new Set(['LONG', 'SHORT']);

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function shouldForceProcessSnapshot() {
  return (
    hasFlag('--force') ||
    hasFlag('--forceProcessSnapshot') ||
    hasFlag('--force-process-snapshot')
  );
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
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

function normalizeTradeSide(side) {
  const raw = upper(side, 'UNKNOWN');

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function inferSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (
    haystack.startsWith('LONG_') ||
    haystack.includes('_LONG_') ||
    haystack.includes('MICRO_LONG_') ||
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG')
  ) {
    return 'LONG';
  }

  if (
    haystack.startsWith('SHORT_') ||
    haystack.includes('_SHORT_') ||
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT')
  ) {
    return 'SHORT';
  }

  return 'UNKNOWN';
}

function getSide(row = {}) {
  const direct = normalizeTradeSide(
    row?.tradeSide ||
    row?.side ||
    row?.positionSide ||
    row?.direction ||
    row?.scannerSide ||
    row?.analysisSide
  );

  if (VALID_TRADE_SIDES.has(direct)) return direct;

  return inferSideFromIds(row);
}

function actionType(row = {}) {
  return upper(row?.action || row?.type || 'UNKNOWN', 'UNKNOWN');
}

function waitReason(row = {}) {
  return upper(row?.reason || row?.waitReason || 'UNKNOWN', 'UNKNOWN');
}

function getMicroFamilyId(row = {}) {
  return (
    row?.microFamilyId ||
    row?.trueMicroFamilyId ||
    row?.activeMicroFamilyId ||
    row?.id ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row?.activeMacroFamilyId ||
    row?.parentMacroFamilyId ||
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
  return row?.familyId || row?.family || null;
}

function getSymbol(row = {}) {
  return (
    row?.symbol ||
    row?.baseSymbol ||
    row?.contractSymbol ||
    null
  );
}

function countBy(rows = [], selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);

    if (!key) return acc;

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function unwrapRunResult(result = {}) {
  return result?.result || result || {};
}

function extractActions(result = {}) {
  const payload = unwrapRunResult(result);

  return asArray(
    payload.actions ||
    payload.tradeActions ||
    result.actions ||
    []
  );
}

function extractRealExits(result = {}) {
  const payload = unwrapRunResult(result);

  return asArray(
    payload.realExits ||
    result.realExits ||
    []
  );
}

function extractShadowExits(result = {}) {
  const payload = unwrapRunResult(result);

  return asArray(
    payload.shadowExits ||
    result.shadowExits ||
    []
  );
}

function getActionCounts(result = {}, actions = []) {
  const payload = unwrapRunResult(result);

  if (payload.actionCounts && typeof payload.actionCounts === 'object') {
    return payload.actionCounts;
  }

  return countBy(actions, actionType);
}

function summarizeEntries(actions = []) {
  const entries = actions.filter((row) => actionType(row) === 'ENTRY');

  return {
    count: entries.length,

    symbols: uniqueStrings(entries.map(getSymbol)),
    microFamilyIds: uniqueStrings(entries.map(getMicroFamilyId)),
    macroFamilyIds: uniqueStrings(entries.map(getMacroFamilyId)),
    familyIds: uniqueStrings(entries.map(getFamilyId)),

    bySide: countBy(entries, getSide),
    byMicroFamily: countBy(entries, getMicroFamilyId),
    byMacroFamily: countBy(entries, getMacroFamilyId),
    byFamily: countBy(entries, getFamilyId)
  };
}

function summarizeWaits(actions = []) {
  const waits = actions.filter((row) => actionType(row) === 'WAIT');

  return {
    count: waits.length,

    byReason: countBy(waits, waitReason),
    bySide: countBy(waits, getSide),
    byMicroFamily: countBy(waits, getMicroFamilyId),
    byMacroFamily: countBy(waits, getMacroFamilyId),

    shadowOnly: waits.filter((row) => Boolean(row.shadowOnly)).length,
    liveEligibleFalse: waits.filter((row) => row.liveEligible === false).length
  };
}

function summarizeExits(result = {}) {
  const realExits = extractRealExits(result);
  const shadowExits = extractShadowExits(result);
  const allExits = [...realExits, ...shadowExits];

  return {
    total: allExits.length,

    real: realExits.length,
    shadow: shadowExits.length,

    byReason: countBy(
      allExits,
      (row) => upper(row?.exitReason || row?.reason || 'UNKNOWN', 'UNKNOWN')
    ),

    bySide: countBy(allExits, getSide),
    byMicroFamily: countBy(allExits, getMicroFamilyId),
    byMacroFamily: countBy(allExits, getMacroFamilyId),

    realIds: uniqueStrings(realExits.map((row) => row?.tradeId || row?.id)),
    shadowIds: uniqueStrings(shadowExits.map((row) => (
      row?.tradeId ||
      row?.id ||
      row?.shadowId
    )))
  };
}

function buildRequestedOptions() {
  return {
    forceProcessSnapshot: shouldForceProcessSnapshot(),
    snapshotId: getArgValue('snapshotId') || undefined
  };
}

function buildRunOptions(requested = {}) {
  return {
    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot)
  };
}

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const payload = unwrapRunResult(result);
  const actions = extractActions(payload);
  const actionCounts = getActionCounts(payload, actions);
  const entries = summarizeEntries(actions);
  const waits = summarizeWaits(actions);
  const exits = summarizeExits(payload);

  return {
    ok: payload?.ok !== false,

    source: 'CLI_RUN_TRADE_SYSTEM',

    argv: argv(),
    requested,

    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),

    runId: payload?.runId || null,

    snapshotId: payload?.snapshotId || null,
    snapshotCreatedAt: payload?.snapshotCreatedAt || null,
    snapshotAgeSec: payload?.snapshotAgeSec ?? null,

    skippedNewEntries: Boolean(payload?.skippedNewEntries),
    reason: payload?.reason || null,

    candidates: payload?.candidates ?? null,
    processed: payload?.processed ?? null,
    earlyActions: payload?.earlyActions ?? null,

    liveRows: payload?.liveRows ?? null,
    actualLiveRows: payload?.actualLiveRows ?? null,
    mirrorRows: payload?.mirrorRows ?? null,

    analyzedRows: payload?.analyzedRows ?? null,
    analyzedActualRows: payload?.analyzedActualRows ?? null,
    analyzedMirrorRows: payload?.analyzedMirrorRows ?? null,

    activeRotationId: payload?.activeRotationId || null,
    activeMicroFamilies: payload?.activeMicroFamilies ?? null,
    activeMacroFamilies: payload?.activeMacroFamilies ?? null,
    trueMicroOnly: payload?.trueMicroOnly ?? null,
    usedLegacyFallback: Boolean(payload?.usedLegacyFallback),

    actions: actions.length,
    actionCounts,

    entries,
    waits,
    exits,

    scannerSnapshotStats: payload?.scannerSnapshotStats || null,

    durationMs: now() - startedAt,

    result: payload
  };
}

function buildCliError({
  error,
  requested,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_RUN_TRADE_SYSTEM',

    argv: argv(),
    requested,

    forceProcessSnapshot: Boolean(requested.forceProcessSnapshot),

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

async function main() {
  const startedAt = now();
  const requested = buildRequestedOptions();

  try {
    const result = await runTradeSystem(
      buildRunOptions(requested)
    );

    const response = buildCliResponse({
      result,
      requested,
      startedAt
    });

    console.log(JSON.stringify(response, null, 2));

    process.exitCode = response.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(
      buildCliError({
        error,
        requested,
        startedAt
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();