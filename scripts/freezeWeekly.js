// ================= FILE: scripts/freezeWeekly.js =================

import { CONFIG } from '../src/config.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';

function now() {
  return Date.now();
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

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function unwrapRotation(result = {}) {
  return (
    result?.rotation ||
    result?.nextRotation ||
    result?.activeRotation ||
    result?.active ||
    null
  );
}

function extractMicroFamilyIds(rotation = {}) {
  return uniqueStrings(
    rotation?.microFamilyIds ||
    rotation?.activeMicroFamilyIds ||
    rotation?.ids ||
    (
      Array.isArray(rotation?.microFamilies)
        ? rotation.microFamilies.map((row) => (
          row?.microFamilyId ||
          row?.trueMicroFamilyId ||
          row?.id ||
          null
        ))
        : []
    )
  );
}

function extractMacroFamilyIds(rotation = {}) {
  return uniqueStrings(
    rotation?.macroFamilyIds ||
    rotation?.activeMacroFamilyIds ||
    rotation?.macroIds ||
    (
      Array.isArray(rotation?.microFamilies)
        ? rotation.microFamilies.map((row) => (
          row?.macroFamilyId ||
          row?.parentMicroFamilyId ||
          row?.legacyMicroFamilyId ||
          row?.coarseMicroFamilyId ||
          row?.familyMacroId ||
          row?.familyId ||
          null
        ))
        : []
    )
  );
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
  return (
    getArgValue('mode') ||
    CONFIG.rotation?.mode ||
    'balanced'
  );
}

function buildRequestedOptions() {
  const weekKey =
    getArgValue('weekKey') ||
    getArgValue('week') ||
    getArgValue('sourceWeekKey') ||
    undefined;

  return {
    force: hasFlag('force'),
    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey: getArgValue('activeWeekKey') || undefined,
    mode: getMode()
  };
}

function buildCliResponse({
  result,
  argv,
  requested,
  startedAt
}) {
  const rotation = unwrapRotation(result);
  const microFamilyIds = extractMicroFamilyIds(rotation);
  const macroFamilyIds = extractMacroFamilyIds(rotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_FREEZE_WEEKLY_ROTATION',

    argv,
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
    emptyReason: rotation?.emptyReason || null,

    eligibleCount: rotation?.eligibleCount ?? null,
    rankedCount: rotation?.rankedCount ?? null,
    microCount: rotation?.microCount ?? null,

    durationMs: now() - startedAt,

    result
  };
}

function buildCliError({
  error,
  argv,
  requested,
  startedAt
}) {
  return {
    ok: false,

    source: 'CLI_FREEZE_WEEKLY_ROTATION',

    argv,
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
  const argv = process.argv.slice(2);
  const requested = buildRequestedOptions();

  try {
    const result = await freezeWeeklyRotation({
      weekKey: requested.weekKey,
      activeWeekKey: requested.activeWeekKey,
      mode: requested.mode
    });

    const response = buildCliResponse({
      result,
      argv,
      requested,
      startedAt
    });

    console.log(JSON.stringify(response, null, 2));

    process.exitCode = response.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(
      buildCliError({
        error,
        argv,
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