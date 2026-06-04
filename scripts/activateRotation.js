// ================= FILE: scripts/activateRotation.js =================

import { activateNextRotation } from '../src/analyze/rotationEngine.js';

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

function unwrapActiveRotation(result = {}) {
  return (
    result?.activeRotation ||
    result?.active ||
    result?.rotation ||
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
  const activeRotation = unwrapActiveRotation(result);

  return (
    result?.weekKey ||
    result?.activeWeekKey ||
    result?.sourceWeekKey ||
    activeRotation?.activeWeekKey ||
    activeRotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getSourceWeekKey(result, fallback = null) {
  const activeRotation = unwrapActiveRotation(result);

  return (
    result?.sourceWeekKey ||
    activeRotation?.sourceWeekKey ||
    fallback ||
    null
  );
}

function getActiveWeekKey(result, fallback = null) {
  const activeRotation = unwrapActiveRotation(result);

  return (
    result?.activeWeekKey ||
    activeRotation?.activeWeekKey ||
    fallback ||
    null
  );
}

function getResultRotationId(result = {}) {
  const activeRotation = unwrapActiveRotation(result);

  return (
    result?.rotationId ||
    activeRotation?.rotationId ||
    null
  );
}

function getActivatedMicroCount(result = {}) {
  const activeRotation = unwrapActiveRotation(result);
  const ids = extractMicroFamilyIds(activeRotation);

  return (
    result?.activatedMicroFamilies ||
    result?.activatedCount ||
    ids.length ||
    0
  );
}

function getActivatedMacroCount(result = {}) {
  const activeRotation = unwrapActiveRotation(result);
  const ids = extractMacroFamilyIds(activeRotation);

  return ids.length || 0;
}

function buildRequestedOptions() {
  return {
    force: hasFlag('force'),
    weekKey: getArgValue('weekKey') || getArgValue('week') || undefined,
    sourceWeekKey: getArgValue('sourceWeekKey') || undefined,
    activeWeekKey: getArgValue('activeWeekKey') || undefined,
    mode: getArgValue('mode') || undefined
  };
}

function buildCliResponse({
  result,
  argv,
  requested,
  startedAt
}) {
  const activeRotation = unwrapActiveRotation(result);
  const microFamilyIds = extractMicroFamilyIds(activeRotation);
  const macroFamilyIds = extractMacroFamilyIds(activeRotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_ACTIVATE_NEXT_ROTATION',

    argv,
    requested,

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getSourceWeekKey(
      result,
      requested.sourceWeekKey || requested.weekKey || null
    ),
    activeWeekKey: getActiveWeekKey(
      result,
      requested.activeWeekKey || null
    ),

    rotationId: getResultRotationId(result),

    activatedMicroFamilies: getActivatedMicroCount(result),
    activatedMacroFamilies: getActivatedMacroCount(result),

    microFamilyIds,
    macroFamilyIds,

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

    source: 'CLI_ACTIVATE_NEXT_ROTATION',

    argv,
    requested,

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
    const result = await activateNextRotation();

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