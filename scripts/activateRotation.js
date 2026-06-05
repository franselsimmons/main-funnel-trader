// ================= FILE: scripts/activateRotation.js =================

import { CONFIG } from '../src/config.js';
import { KEYS } from '../src/keys.js';
import {
  getDurableRedis,
  setJson
} from '../src/redis.js';
import { getIsoWeekKey } from '../src/utils.js';
import {
  activateNextRotation,
  activateSelectedMicroFamilies,
  buildRotationFromWeek
} from '../src/analyze/rotationEngine.js';

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

function parseIdList(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap(parseIdList));
  }

  if (typeof value === 'object') {
    return parseIdList(
      value.microFamilyIds ||
      value.activeMicroFamilyIds ||
      value.trueMicroFamilyIds ||
      value.ids ||
      value.id ||
      []
    );
  }

  return uniqueStrings(
    String(value)
      .split(/[\s,;\n\r]+/g)
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

function asRows(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapActiveRotation(result = {}) {
  return (
    result?.activeRotation ||
    result?.active ||
    result?.rotation ||
    result?.result?.activeRotation ||
    result?.result?.active ||
    result?.result?.rotation ||
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

function getActiveWeekKeyArg(fallbackWeekKey) {
  return String(
    firstValue(
      getArgValue('activeWeekKey'),
      getArgValue('nextWeekKey'),
      fallbackWeekKey,
      getIsoWeekKey()
    )
  ).trim();
}

function getRequestedMicroFamilyIds() {
  return uniqueStrings([
    parseIdList(getArgValue('microFamilyIds')),
    parseIdList(getArgValue('activeMicroFamilyIds')),
    parseIdList(getArgValue('trueMicroFamilyIds')),
    parseIdList(getArgValue('ids')),
    parseIdList(getArgValue('id'))
  ]);
}

function shouldBuildFreshRotation(requested = {}) {
  if (requested.microFamilyIds.length > 0) return false;

  return (
    requested.force ||
    hasFlag('build') ||
    hasFlag('activateBest') ||
    hasFlag('buildFresh')
  );
}

function shouldAutoBuildIfMissing() {
  return (
    hasFlag('autoBuildIfMissing') ||
    hasFlag('auto-build-if-missing')
  );
}

function buildRequestedOptions() {
  const weekKey = getWeekKey();

  return {
    force: hasFlag('force'),

    build: hasFlag('build') || hasFlag('buildFresh'),
    activateBest: hasFlag('activateBest'),
    autoBuildIfMissing: shouldAutoBuildIfMissing(),

    weekKey,
    sourceWeekKey: getArgValue('sourceWeekKey') || weekKey,
    activeWeekKey: getActiveWeekKeyArg(weekKey),

    mode: getMode(),

    microFamilyIds: getRequestedMicroFamilyIds()
  };
}

function isMissingNextRotation(result = {}) {
  return (
    result?.ok === false &&
    String(result?.reason || '').toUpperCase() === 'NEXT_ROTATION_MISSING'
  );
}

async function buildFreshRotationAndActivate({
  weekKey,
  activeWeekKey,
  mode
}) {
  const redis = getDurableRedis();

  const builtRotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    builtRotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: 'IMMEDIATE_CLI_ACTIVATION',
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: builtRotation.rotationId,
      mode
    }
  );

  const activated = await activateNextRotation();

  return {
    ok: activated?.ok !== false,
    type: 'CLI_BUILT_AND_ACTIVATED_ROTATION',

    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey,
    mode,

    rotationId:
      activated?.rotationId ||
      activated?.activeRotation?.rotationId ||
      builtRotation.rotationId ||
      null,

    activatedCount:
      activated?.activatedCount ||
      activated?.activeRotation?.microFamilyIds?.length ||
      builtRotation.microFamilyIds?.length ||
      0,

    builtRotation,
    activeRotation: activated?.activeRotation || null,
    reason: activated?.reason || builtRotation.emptyReason || null,

    result: activated
  };
}

async function activateManualSelection({
  microFamilyIds,
  weekKey,
  mode
}) {
  const activeRotation = await activateSelectedMicroFamilies({
    microFamilyIds,
    weekKey,
    mode: mode || 'manual'
  });

  return {
    ok: true,
    type: 'CLI_MANUAL_MICRO_FAMILY_ROTATION_ACTIVATED',

    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey: activeRotation.activeWeekKey || getIsoWeekKey(),
    mode: mode || 'manual',

    rotationId: activeRotation.rotationId || null,
    activatedCount: activeRotation.microFamilyIds?.length || 0,

    requestedMicroFamilyIds: microFamilyIds,

    activeRotation,
    reason: activeRotation.emptyReason || null
  };
}

async function activateExistingNextRotation({
  weekKey,
  activeWeekKey,
  mode,
  autoBuildIfMissing
}) {
  const activated = await activateNextRotation();

  if (
    isMissingNextRotation(activated) &&
    autoBuildIfMissing
  ) {
    return buildFreshRotationAndActivate({
      weekKey,
      activeWeekKey,
      mode
    });
  }

  return {
    ok: activated?.ok !== false,
    type: 'CLI_NEXT_ROTATION_ACTIVATED',

    weekKey,
    sourceWeekKey: activated?.activeRotation?.sourceWeekKey || null,
    activeWeekKey: activated?.activeRotation?.activeWeekKey || activeWeekKey,
    mode: activated?.activeRotation?.mode || mode,

    rotationId:
      activated?.rotationId ||
      activated?.activeRotation?.rotationId ||
      null,

    activatedCount:
      activated?.activatedCount ||
      activated?.activeRotation?.microFamilyIds?.length ||
      0,

    activeRotation: activated?.activeRotation || null,
    reason: activated?.reason || null,

    result: activated
  };
}

async function runActivation(requested = {}) {
  if (requested.microFamilyIds.length > 0) {
    return activateManualSelection({
      microFamilyIds: requested.microFamilyIds,
      weekKey: requested.weekKey,
      mode: requested.mode
    });
  }

  if (shouldBuildFreshRotation(requested)) {
    return buildFreshRotationAndActivate({
      weekKey: requested.sourceWeekKey || requested.weekKey,
      activeWeekKey: requested.activeWeekKey,
      mode: requested.mode
    });
  }

  return activateExistingNextRotation({
    weekKey: requested.sourceWeekKey || requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode,
    autoBuildIfMissing: requested.autoBuildIfMissing
  });
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

function buildCliResponse({
  result,
  requested,
  startedAt
}) {
  const activeRotation = unwrapActiveRotation(result);
  const microFamilyIds = extractMicroFamilyIds(activeRotation);
  const macroFamilyIds = extractMacroFamilyIds(activeRotation);

  return {
    ok: result?.ok !== false,

    source: 'CLI_ACTIVATE_ROTATION',

    argv: argv(),
    requested,

    type: result?.type || null,

    weekKey: getResultWeekKey(result, requested.weekKey || null),
    sourceWeekKey: getSourceWeekKey(
      result,
      requested.sourceWeekKey || requested.weekKey || null
    ),
    activeWeekKey: getActiveWeekKey(
      result,
      requested.activeWeekKey || null
    ),

    mode: result?.mode || activeRotation?.mode || requested.mode,

    rotationId: getResultRotationId(result),

    activatedMicroFamilies: getActivatedMicroCount(result),
    activatedMacroFamilies: getActivatedMacroCount(result),

    microFamilyIds,
    macroFamilyIds,

    empty: Boolean(activeRotation?.empty),
    emptyReason: activeRotation?.emptyReason || result?.reason || null,
    reason: result?.reason || null,

    trueMicroOnly: activeRotation?.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation?.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation?.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation?.usedObservationFallback),

    selectedTier: activeRotation?.selectedTier || result?.selectedTier || null,
    missingSides: Array.isArray(activeRotation?.missingSides)
      ? activeRotation.missingSides
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

    source: 'CLI_ACTIVATE_ROTATION',

    argv: argv(),
    requested,

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

async function main() {
  const startedAt = now();
  const requested = buildRequestedOptions();

  try {
    const result = await runActivation(requested);

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