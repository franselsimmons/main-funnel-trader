// ================= FILE: scripts/freezeWeekly.js =================

import { CONFIG } from '../src/config.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey
} from '../src/utils.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';

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
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function asRows(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapRotation(result = {}) {
  return (
    result?.rotation ||
    result?.nextRotation ||
    result?.activeRotation ||
    result?.active ||
    result?.result?.rotation ||
    result?.result?.nextRotation ||
    null
  );
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
    row?.legacyMicroFamilyId ||
    row?.coarseMicroFamilyId ||
    row?.familyMacroId ||
    row?.familyId ||
    null
  );
}

function extractMicroFamilyIds(rotation = {}) {
  const rows = asRows(rotation?.microFamilies);

  return uniqueStrings([
    rotation?.microFamilyIds || [],
    rotation?.activeMicroFamilyIds || [],
    rotation?.trueMicroFamilyIds || [],
    rotation?.ids || [],
    rows.map(microId),
    rotation?.bestLong ? microId(rotation.bestLong) : null,
    rotation?.bestShort ? microId(rotation.bestShort) : null,
    rotation?.selectedRow ? microId(rotation.selectedRow) : null,
    rotation?.preservedOppositeRow ? microId(rotation.preservedOppositeRow) : null
  ]);
}

function extractMacroFamilyIds(rotation = {}) {
  const rows = asRows(rotation?.microFamilies);

  return uniqueStrings([
    rotation?.macroFamilyIds || [],
    rotation?.activeMacroFamilyIds || [],
    rotation?.macroIds || [],
    rows.map(macroId),
    rotation?.bestLong ? macroId(rotation.bestLong) : null,
    rotation?.bestShort ? macroId(rotation.bestShort) : null,
    rotation?.selectedRow ? macroId(rotation.selectedRow) : null,
    rotation?.preservedOppositeRow ? macroId(rotation.preservedOppositeRow) : null
  ]);
}

function getResultWeekKey(result, fallback = null) {
  const rotation = unwrapRotation(result);

  return (
    result?.weekKey ||
    result?.sourceWeekKey ||
    rotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getResultActiveWeekKey(result, fallback = null) {
  const rotation = unwrapRotation(result);

  return (
    result?.activeWeekKey ||
    rotation?.activeWeekKey ||
    fallback ||
    null
  );
}

function getResultRotationId(result = {}) {
  const rotation = unwrapRotation(result);

  return (
    result?.rotationId ||
    rotation?.rotationId ||
    null
  );
}

function getSelectedMicroCount(result = {}) {
  const rotation = unwrapRotation(result);
  const ids = extractMicroFamilyIds(rotation);

  return (
    result?.selectedMicroFamilies ||
    result?.selectedCount ||
    ids.length ||
    0
  );
}

function getSelectedMacroCount(result = {}) {
  const rotation = unwrapRotation(result);
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

    mode: getMode()
  };
}

function buildFreezeOptions(requested = {}) {
  return {
    weekKey: requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode
  };
}

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const rotation = unwrapRotation(result);
  const microFamilyIds = extractMicroFamilyIds(rotation);
  const macroFamilyIds = extractMacroFamilyIds(rotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_FREEZE_WEEKLY_ROTATION',

    argv: argv(),
    requested,

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getResultWeekKey(result, requested.sourceWeekKey || null),
    activeWeekKey: getResultActiveWeekKey(result, requested.activeWeekKey || null),

    mode: result?.mode || rotation?.mode || requested.mode,

    rotationId: getResultRotationId(result),

    selectedMicroFamilies: getSelectedMicroCount(result),
    selectedMacroFamilies: getSelectedMacroCount(result),

    microFamilyIds,
    macroFamilyIds,

    empty: Boolean(rotation?.empty),
    emptyReason: rotation?.emptyReason || result?.emptyReason || result?.reason || null,

    eligibleCount: rotation?.eligibleCount ?? null,
    rankedCount: rotation?.rankedCount ?? null,
    allRankedCount: rotation?.allRankedCount ?? null,

    microCount: rotation?.microCount ?? microFamilyIds.length,
    macroCount: rotation?.macroCount ?? macroFamilyIds.length,

    trueMicroOnly: rotation?.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(rotation?.usedLegacyFallback),
    usedSoftFallback: Boolean(rotation?.usedSoftFallback),
    usedObservationFallback: Boolean(rotation?.usedObservationFallback),

    selectedTier: rotation?.selectedTier || null,
    missingSides: Array.isArray(rotation?.missingSides)
      ? rotation.missingSides
      : [],

    durationMs: now() - startedAt,

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

    source: 'CLI_FREEZE_WEEKLY_ROTATION',

    argv: argv(),
    requested,

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