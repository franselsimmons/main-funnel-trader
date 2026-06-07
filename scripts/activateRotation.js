// ================= FILE: scripts/activateRotation.js =================

import { getIsoWeekKey } from '../src/utils.js';
import { activateSelectedMicroFamilies } from '../src/analyze/rotationEngine.js';

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

function inferTradeSideFromId(id = '') {
  const shortHit = idLooksLikeShort(id);
  const longHit = idLooksLikeLong(id);

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortMicroFamilyId(id = '') {
  return inferTradeSideFromId(id) === TARGET_TRADE_SIDE;
}

function normalizeManualMicroFamilyIds(ids = []) {
  const requestedIds = uniqueStrings(ids);
  const acceptedMicroFamilyIds = [];
  const ignoredIds = [];

  for (const id of requestedIds) {
    const side = inferTradeSideFromId(id);

    if (side === TARGET_TRADE_SIDE) {
      acceptedMicroFamilyIds.push(id);
      continue;
    }

    ignoredIds.push({
      id,
      side,
      reason: side === OPPOSITE_TRADE_SIDE
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'UNKNOWN_OR_NON_SHORT_ID_REJECTED'
    });
  }

  return {
    requestedMicroFamilyIds: requestedIds,
    acceptedMicroFamilyIds: uniqueStrings(acceptedMicroFamilyIds),
    ignoredIds,
    ignoredLongIds: ignoredIds
      .filter((row) => row.reason === 'LONG_DISABLED_SHORT_ONLY')
      .map((row) => row.id),
    ignoredUnknownIds: ignoredIds
      .filter((row) => row.reason === 'UNKNOWN_OR_NON_SHORT_ID_REJECTED')
      .map((row) => row.id)
  };
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

function getMode() {
  return String(
    firstValue(
      getArgValue('mode'),
      'selected'
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

function hasDisabledAutoFlag() {
  return (
    hasFlag('build') ||
    hasFlag('activateBest') ||
    hasFlag('buildFresh') ||
    hasFlag('autoBuildIfMissing') ||
    hasFlag('auto-build-if-missing') ||
    hasFlag('activateNext') ||
    hasFlag('activate-next')
  );
}

function buildRequestedOptions() {
  const weekKey = getWeekKey();
  const requestedMicroFamilyIds = getRequestedMicroFamilyIds();
  const normalized = normalizeManualMicroFamilyIds(requestedMicroFamilyIds);

  return {
    argv: argv(),

    weekKey,
    sourceWeekKey: weekKey,
    activeWeekKey: String(
      firstValue(
        getArgValue('activeWeekKey'),
        getArgValue('nextWeekKey'),
        weekKey,
        getIsoWeekKey()
      )
    ).trim(),

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

    manualOnly: true,
    discordOnly: true,
    autoRotation: false,
    activateNextDisabled: true,
    buildFreshDisabled: true,

    requestedMicroFamilyIds: normalized.requestedMicroFamilyIds,
    microFamilyIds: normalized.acceptedMicroFamilyIds,
    activeMicroFamilyIds: normalized.acceptedMicroFamilyIds,
    trueMicroFamilyIds: normalized.acceptedMicroFamilyIds,

    ignoredIds: normalized.ignoredIds,
    ignoredLongIds: normalized.ignoredLongIds,
    ignoredUnknownIds: normalized.ignoredUnknownIds,

    disabledAutoFlagPresent: hasDisabledAutoFlag()
  };
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
    row?.parentFamilyId ||
    row?.macroId ||
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
    rotation?.bestShort ? microId(rotation.bestShort) : null,
    rotation?.selectedRow ? microId(rotation.selectedRow) : null
  ]).filter(isShortMicroFamilyId);
}

function extractMacroFamilyIds(rotation = {}) {
  const rows = asRows(rotation?.microFamilies);

  return uniqueStrings([
    rotation?.macroFamilyIds || [],
    rotation?.activeMacroFamilyIds || [],
    rotation?.macroIds || [],
    rows.map(macroId),
    rotation?.bestShort ? macroId(rotation.bestShort) : null,
    rotation?.selectedRow ? macroId(rotation.selectedRow) : null
  ]).filter((id) => inferTradeSideFromId(id) !== OPPOSITE_TRADE_SIDE);
}

function forceShortRotation(rotation = {}) {
  const rows = asRows(rotation.microFamilies)
    .filter((row) => isShortMicroFamilyId(microId(row)))
    .map((row, index) => ({
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

      manualOnly: true
    }));

  const microFamilyIds = uniqueStrings([
    rotation.microFamilyIds || [],
    rotation.activeMicroFamilyIds || [],
    rotation.trueMicroFamilyIds || [],
    rows.map(microId)
  ]).filter(isShortMicroFamilyId);

  const macroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds || [],
    rotation.activeMacroFamilyIds || [],
    rows.map(macroId)
  ]).filter((id) => inferTradeSideFromId(id) !== OPPOSITE_TRADE_SIDE);

  return {
    ...rotation,

    source: rotation.source || 'CLI_MANUAL_SELECTION_SHORT_ONLY',
    mode: rotation.mode || 'selected',
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
    manualOnly: true,
    discordOnly: true,
    autoRotation: false,

    bestLong: null,
    preservedOppositeRow: null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies: rows,

    activeCount: microFamilyIds.length,
    microCount: microFamilyIds.length,
    trueMicroCount: microFamilyIds.length,
    macroCount: macroFamilyIds.length,

    empty: microFamilyIds.length === 0,
    emptyReason: microFamilyIds.length === 0
      ? rotation.emptyReason || 'NO_MANUAL_SHORT_MICRO_FAMILY_IDS_ACTIVE'
      : null
  };
}

async function activateManualSelection(requested = {}) {
  if (requested.microFamilyIds.length <= 0) {
    return {
      ok: requested.requestedMicroFamilyIds.length === 0,
      skipped: true,
      changed: false,
      type: 'CLI_MANUAL_SELECTION_REQUIRED',

      reason: requested.requestedMicroFamilyIds.length > 0
        ? 'NO_VALID_SHORT_MICRO_FAMILY_IDS'
        : 'NO_MICRO_FAMILY_IDS_PROVIDED',

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      manualOnly: true,
      discordOnly: true,

      activateNextDisabled: true,
      buildFreshDisabled: true,

      requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
      acceptedMicroFamilyIds: [],
      ignoredIds: requested.ignoredIds,
      ignoredLongIds: requested.ignoredLongIds,
      ignoredUnknownIds: requested.ignoredUnknownIds
    };
  }

  const activeRotationRaw = await activateSelectedMicroFamilies({
    microFamilyIds: requested.microFamilyIds,
    activeMicroFamilyIds: requested.microFamilyIds,
    trueMicroFamilyIds: requested.microFamilyIds,

    weekKey: requested.weekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: 'selected',

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

    manualOnly: true,
    discordOnly: true,
    autoRotation: false
  });

  const activeRotation = forceShortRotation(activeRotationRaw);

  return {
    ok: true,
    skipped: false,
    changed: true,
    type: 'CLI_MANUAL_SHORT_MICRO_FAMILY_DISCORD_SELECTION_ACTIVATED',

    source: 'CLI_MANUAL_SELECTION_SHORT_ONLY',

    weekKey: requested.weekKey,
    sourceWeekKey: requested.sourceWeekKey,
    activeWeekKey: activeRotation.activeWeekKey || requested.activeWeekKey,
    mode: 'selected',

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

    manualOnly: true,
    discordOnly: true,
    autoRotation: false,

    activateNextDisabled: true,
    buildFreshDisabled: true,

    rotationId: activeRotation.rotationId || null,
    activatedCount: activeRotation.microFamilyIds?.length || 0,
    activatedMicroFamilies: activeRotation.microFamilyIds?.length || 0,
    activatedMacroFamilies: activeRotation.macroFamilyIds?.length || 0,

    requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
    acceptedMicroFamilyIds: requested.microFamilyIds,
    ignoredIds: requested.ignoredIds,
    ignoredLongIds: requested.ignoredLongIds,
    ignoredUnknownIds: requested.ignoredUnknownIds,

    microFamilyIds: activeRotation.microFamilyIds || [],
    activeMicroFamilyIds: activeRotation.activeMicroFamilyIds || [],
    trueMicroFamilyIds: activeRotation.trueMicroFamilyIds || [],

    macroFamilyIds: activeRotation.macroFamilyIds || [],
    activeMacroFamilyIds: activeRotation.activeMacroFamilyIds || [],

    activeRotation,
    reason: activeRotation.emptyReason || null
  };
}

async function runActivation(requested = {}) {
  return activateManualSelection(requested);
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
    skipped: Boolean(result?.skipped),
    changed: Boolean(result?.changed),

    source: 'CLI_MANUAL_SHORT_MICRO_FAMILY_DISCORD_SELECTION',

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

    mode: 'selected',

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

    manualOnly: true,
    discordOnly: true,
    autoRotation: false,

    activateNextDisabled: true,
    buildFreshDisabled: true,
    oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),

    rotationId: getResultRotationId(result),

    activatedMicroFamilies:
      result?.activatedMicroFamilies ||
      result?.activatedCount ||
      microFamilyIds.length ||
      0,

    activatedMacroFamilies:
      result?.activatedMacroFamilies ||
      macroFamilyIds.length ||
      0,

    requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
    acceptedMicroFamilyIds: requested.microFamilyIds,

    ignoredIds: requested.ignoredIds,
    ignoredLongIds: requested.ignoredLongIds,
    ignoredUnknownIds: requested.ignoredUnknownIds,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    empty: Boolean(activeRotation?.empty || microFamilyIds.length === 0),
    emptyReason: activeRotation?.emptyReason || result?.reason || null,
    reason: result?.reason || null,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(activeRotation?.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation?.usedObservationFallback),
    usedRawFallback: Boolean(activeRotation?.usedRawFallback),

    selectedTier: activeRotation?.selectedTier || result?.selectedTier || null,
    missingSides: Array.isArray(activeRotation?.missingSides)
      ? activeRotation.missingSides
      : microFamilyIds.length === 0
        ? [TARGET_TRADE_SIDE]
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

    source: 'CLI_MANUAL_SHORT_MICRO_FAMILY_DISCORD_SELECTION',

    argv: argv(),
    requested,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    manualOnly: true,
    discordOnly: true,

    activateNextDisabled: true,
    buildFreshDisabled: true,

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