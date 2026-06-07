// ================= FILE: scripts/freezeWeekly.js =================

import { CONFIG } from '../src/config.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey
} from '../src/utils.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
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
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value
            .split(/[\s,;\n\r]+/g)
            .map((part) => part.trim());
        }

        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function asRows(value) {
  return Array.isArray(value) ? value : [];
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
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function idLooksLikeLong(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=BUY') ||
    value.startsWith('LONG_') ||
    value.includes('_LONG_') ||
    value.endsWith('_LONG') ||
    value.startsWith('BULL_') ||
    value.includes('_BULL_') ||
    value.endsWith('_BULL') ||
    value.startsWith('BUY_') ||
    value.includes('_BUY_') ||
    value.endsWith('_BUY')
  );
}

function idLooksLikeShort(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SELL') ||
    value.startsWith('SHORT_') ||
    value.includes('_SHORT_') ||
    value.endsWith('_SHORT') ||
    value.startsWith('BEAR_') ||
    value.includes('_BEAR_') ||
    value.endsWith('_BEAR') ||
    value.startsWith('SELL_') ||
    value.includes('_SELL_') ||
    value.endsWith('_SELL')
  );
}

function inferTradeSideFromText(value = '') {
  const shortHit = idLooksLikeShort(value);
  const longHit = idLooksLikeLong(value);

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return inferTradeSideFromText(raw);
}

function microId(row = {}) {
  return (
    row?.microFamilyId ||
    row?.trueMicroFamilyId ||
    row?.id ||
    row?.key ||
    null
  );
}

function macroId(row = {}) {
  return (
    row?.parentMacroFamilyId ||
    row?.macroFamilyId ||
    row?.parentMicroFamilyId ||
    row?.parentFamilyId ||
    row?.macroId ||
    row?.legacyMicroFamilyId ||
    row?.coarseMicroFamilyId ||
    row?.familyMacroId ||
    row?.familyId ||
    null
  );
}

function familyId(row = {}) {
  return (
    row?.familyId ||
    row?.family ||
    row?.baseFamilyId ||
    null
  );
}

function definitionHaystack(row = {}) {
  return [
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function inferRowTradeSide(row = {}) {
  if (typeof row === 'string') {
    return inferTradeSideFromText(row);
  }

  if (!row || typeof row !== 'object') {
    return 'UNKNOWN';
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const haystackSide = inferTradeSideFromText(definitionHaystack(row));

  if (haystackSide === TARGET_TRADE_SIDE || haystackSide === OPPOSITE_TRADE_SIDE) {
    return haystackSide;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortId(id = '') {
  return inferTradeSideFromText(id) === TARGET_TRADE_SIDE;
}

function isAllowedShortId(id = '') {
  const side = inferTradeSideFromText(id);

  if (side === OPPOSITE_TRADE_SIDE) return false;
  if (side === TARGET_TRADE_SIDE) return true;

  return idLooksLikeShort(id);
}

function isShortRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function forceShortRow(row = {}, index = 0) {
  const trueMicroFamilyId = microId(row);
  const parentMacroFamilyId = macroId(row);

  return {
    ...row,

    rank: row.rank || index + 1,

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

    microFamilyId: trueMicroFamilyId,
    trueMicroFamilyId,
    parentMacroFamilyId,
    macroFamilyId: parentMacroFamilyId || row.macroFamilyId || null
  };
}

function unwrapRotation(result = {}) {
  return (
    result?.rotation ||
    result?.nextRotation ||
    result?.result?.rotation ||
    result?.result?.nextRotation ||
    null
  );
}

function sanitizeRotation(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawRows = asRows(rotation.microFamilies);

  const microFamilies = rawRows
    .filter(isShortRow)
    .map(forceShortRow)
    .filter((row) => isAllowedShortId(microId(row)));

  const microFamilyIds = uniqueStrings([
    rotation.microFamilyIds || [],
    rotation.activeMicroFamilyIds || [],
    rotation.trueMicroFamilyIds || [],
    rotation.ids || [],
    microFamilies.map(microId)
  ]).filter(isAllowedShortId);

  const macroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds || [],
    rotation.activeMacroFamilyIds || [],
    rotation.macroIds || [],
    microFamilies.map(macroId)
  ]).filter((id) => inferTradeSideFromText(id) !== OPPOSITE_TRADE_SIDE);

  const bestShortRaw =
    rotation.bestShort ||
    microFamilies.find((row) => isShortRow(row)) ||
    null;

  const bestShort = bestShortRaw
    ? forceShortRow(bestShortRaw, 0)
    : null;

  const empty = microFamilyIds.length === 0 && microFamilies.length === 0;

  return {
    ...rotation,

    source: rotation.source || 'CLI_WEEKLY_FREEZE_SHORT_ONLY',
    mode: rotation.mode || getMode(),
    sideMode: 'short_only',

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

    trueMicroOnly: true,

    freezeOnly: true,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    manualSelectionPreserved: true,
    activeOverwriteDisabled: true,
    autoActivationDisabled: true,

    bestLong: null,
    bestShort,
    preservedOppositeRow: null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    microCount: rotation.microCount ?? microFamilyIds.length,
    macroCount: rotation.macroCount ?? macroFamilyIds.length,
    trueMicroCount: microFamilyIds.length,
    legacyMacroCount: 0,

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_SHORT_MICRO_FAMILIES_FOR_NEXT_ROTATION'
      : rotation.emptyReason || null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : []
  };
}

function extractMicroFamilyIds(rotation = {}) {
  const sanitized = sanitizeRotation(rotation);

  if (!sanitized) return [];

  return uniqueStrings([
    sanitized.microFamilyIds || [],
    sanitized.activeMicroFamilyIds || [],
    sanitized.trueMicroFamilyIds || [],
    asRows(sanitized.microFamilies).map(microId),
    sanitized.bestShort ? microId(sanitized.bestShort) : null,
    sanitized.selectedRow ? microId(sanitized.selectedRow) : null
  ]).filter(isAllowedShortId);
}

function extractMacroFamilyIds(rotation = {}) {
  const sanitized = sanitizeRotation(rotation);

  if (!sanitized) return [];

  return uniqueStrings([
    sanitized.macroFamilyIds || [],
    sanitized.activeMacroFamilyIds || [],
    sanitized.macroIds || [],
    asRows(sanitized.microFamilies).map(macroId),
    sanitized.bestShort ? macroId(sanitized.bestShort) : null,
    sanitized.selectedRow ? macroId(sanitized.selectedRow) : null
  ]).filter((id) => inferTradeSideFromText(id) !== OPPOSITE_TRADE_SIDE);
}

function getResultWeekKey(result, fallback = null) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});

  return (
    result?.weekKey ||
    result?.sourceWeekKey ||
    rotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getResultActiveWeekKey(result, fallback = null) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});

  return (
    result?.activeWeekKey ||
    rotation?.activeWeekKey ||
    fallback ||
    null
  );
}

function getResultRotationId(result = {}) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});

  return (
    result?.rotationId ||
    rotation?.rotationId ||
    null
  );
}

function getSelectedMicroCount(result = {}) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});
  const ids = extractMicroFamilyIds(rotation);

  return (
    result?.selectedMicroFamilies ||
    result?.selectedCount ||
    ids.length ||
    0
  );
}

function getSelectedMacroCount(result = {}) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});
  const ids = extractMacroFamilyIds(rotation);

  return ids.length || 0;
}

function getMode() {
  return String(
    getArgValue('mode') ||
    CONFIG.rotation?.mode ||
    'balanced'
  ).trim();
}

function getWeekKey() {
  return String(
    firstValue(
      getArgValue('weekKey'),
      getArgValue('week'),
      getArgValue('sourceWeekKey'),
      getIsoWeekKey()
    )
  ).trim();
}

function getActiveWeekKey() {
  return String(
    firstValue(
      getArgValue('activeWeekKey'),
      getArgValue('nextWeekKey'),
      getNextIsoWeekKey()
    )
  ).trim();
}

function buildRequestedOptions() {
  const weekKey = getWeekKey();
  const activeWeekKey = getActiveWeekKey();

  return {
    force: hasFlag('force'),

    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey,

    mode: getMode(),

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

    freezeOnly: true,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    manualSelectionPreserved: true,
    activeOverwriteDisabled: true,
    autoActivationDisabled: true
  };
}

function buildFreezeOptions(requested = {}) {
  return {
    weekKey: requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode,

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

    freezeOnly: true,
    nextRotationOnly: true,
    activate: false,
    activateNext: false,
    activateNextRotation: false,

    preventActiveOverwrite: true,
    preserveActiveRotation: true,
    manualSelectionPreserved: true,
    activeOverwriteDisabled: true,
    autoActivationDisabled: true
  };
}

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const rotation = sanitizeRotation(unwrapRotation(result) || {});
  const microFamilyIds = extractMicroFamilyIds(rotation);
  const macroFamilyIds = extractMacroFamilyIds(rotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_FREEZE_WEEKLY_NEXT_ROTATION_SHORT_ONLY',

    argv: argv(),
    requested,

    type: result?.type || 'NEXT_ROTATION_READY',

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

    freezeOnly: true,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    manualSelectionPreserved: true,
    activeOverwriteDisabled: true,
    autoActivationDisabled: true,

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getResultWeekKey(result, requested.sourceWeekKey || null),
    activeWeekKey: getResultActiveWeekKey(result, requested.activeWeekKey || null),

    mode: result?.mode || rotation?.mode || requested.mode,

    rotationId: getResultRotationId(result),

    selectedMicroFamilies: getSelectedMicroCount(result),
    selectedMacroFamilies: getSelectedMacroCount(result),

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    empty: Boolean(rotation?.empty || microFamilyIds.length === 0),
    emptyReason: rotation?.emptyReason || result?.emptyReason || result?.reason || null,

    eligibleCount: rotation?.eligibleCount ?? null,
    rankedCount: rotation?.rankedCount ?? null,
    allRankedCount: rotation?.allRankedCount ?? null,

    microCount: rotation?.microCount ?? microFamilyIds.length,
    macroCount: rotation?.macroCount ?? macroFamilyIds.length,
    trueMicroCount: rotation?.trueMicroCount ?? microFamilyIds.length,
    legacyMacroCount: 0,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(rotation?.usedSoftFallback),
    usedObservationFallback: Boolean(rotation?.usedObservationFallback),
    usedRawFallback: Boolean(rotation?.usedRawFallback),

    selectedTier: rotation?.selectedTier || null,
    missingSides: Array.isArray(rotation?.missingSides)
      ? rotation.missingSides.filter((side) => normalizeTradeSide(side) === TARGET_TRADE_SIDE)
      : microFamilyIds.length === 0
        ? [TARGET_TRADE_SIDE]
        : [],

    durationMs: now() - startedAt,

    rotation,
    result
  };
}

function buildCliError({
  error,
  requested,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_FREEZE_WEEKLY_NEXT_ROTATION_SHORT_ONLY',

    argv: argv(),
    requested,

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

    freezeOnly: true,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    manualSelectionPreserved: true,
    activeOverwriteDisabled: true,
    autoActivationDisabled: true,

    weekKey: requested.weekKey || null,
    sourceWeekKey: requested.sourceWeekKey || null,
    activeWeekKey: requested.activeWeekKey || null,
    mode: requested.mode,

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

async function main() {
  const startedAt = now();
  const requested = buildRequestedOptions();

  try {
    const result = await freezeWeeklyRotation(
      buildFreezeOptions(requested)
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