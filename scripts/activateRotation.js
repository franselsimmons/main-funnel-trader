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
      value.microFamilyId ||
      value.trueMicroFamilyId ||
      value.id ||
      value.key ||
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
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
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
    value.endsWith('_BUY') ||
    value.includes('|LONG|') ||
    value.includes('|BULL|') ||
    value.includes('|BUY|') ||
    value.includes('=LONG') ||
    value.includes('=BULL') ||
    value.includes('=BUY')
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
    value.endsWith('_SELL') ||
    value.includes('|SHORT|') ||
    value.includes('|BEAR|') ||
    value.includes('|SELL|') ||
    value.includes('=SHORT') ||
    value.includes('=BEAR') ||
    value.includes('=SELL')
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

function isAllowedShortOrUnknownMacroId(id = '') {
  return inferTradeSideFromId(id) !== OPPOSITE_TRADE_SIDE;
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
    hasFlag('activate-best') ||
    hasFlag('buildFresh') ||
    hasFlag('build-fresh') ||
    hasFlag('autoBuildIfMissing') ||
    hasFlag('auto-build-if-missing') ||
    hasFlag('activateNext') ||
    hasFlag('activate-next') ||
    hasFlag('activateNextRotation') ||
    hasFlag('activate-next-rotation') ||
    hasFlag('autoActivate') ||
    hasFlag('auto-activate')
  );
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

    noRealOrders: true,
    manualSelectionOnly: true,
    discordOnlyForSelectedMicroFamilies: true,

    autoRotation: false,
    autoRotationDisabled: true,
    activateNextDisabled: true,
    buildFreshDisabled: true
  };
}

function buildRequestedOptions() {
  const weekKey = getWeekKey();
  const requestedMicroFamilyIds = getRequestedMicroFamilyIds();
  const normalized = normalizeManualMicroFamilyIds(requestedMicroFamilyIds);
  const mode = getMode();

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

    mode,

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    discordOnly: true,

    requestedMicroFamilyIds: normalized.requestedMicroFamilyIds,

    microFamilyIds: normalized.acceptedMicroFamilyIds,
    activeMicroFamilyIds: normalized.acceptedMicroFamilyIds,
    trueMicroFamilyIds: normalized.acceptedMicroFamilyIds,

    acceptedMicroFamilyIds: normalized.acceptedMicroFamilyIds,

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
  if (!result || typeof result !== 'object') return null;

  return (
    result.activeRotation ||
    result.active ||
    result.rotation ||
    result.result?.activeRotation ||
    result.result?.active ||
    result.result?.rotation ||
    result.result?.result?.activeRotation ||
    result.result?.result?.active ||
    result.result?.result?.rotation ||
    null
  );
}

function microId(row = {}) {
  return (
    row?.microFamilyId ||
    row?.trueMicroFamilyId ||
    row?.liveMicroFamilyId ||
    row?.realMicroFamilyId ||
    row?.executionMicroFamilyId ||
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
  ]).filter(isAllowedShortOrUnknownMacroId);
}

function buildManualRow(id, index = 0) {
  return {
    rank: index + 1,

    microFamilyId: id,
    trueMicroFamilyId: id,

    familyId: null,
    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    ...modeFlags(),

    source: 'CLI_MANUAL_SELECTION_SHORT_ONLY',
    selectedTier: 'MANUAL',
    rotationEligibilityTier: 'MANUAL',

    manualOnly: true,
    adminSelected: true,

    seen: 0,
    observations: 0,
    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    wins: 0,
    losses: 0,
    flats: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: 0,
    fairWinrate: 0,
    wilsonLowerBound: 0,

    avgR: 0,
    totalR: 0,
    realTotalR: 0,
    profitFactor: 0,

    totalCostR: 0,
    avgCostR: 0,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      'CLI_MANUAL_SELECTION=true'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | CLI_MANUAL_SELECTION=true`
  };
}

function forceShortRow(row = {}, index = 0) {
  const rowMicroId = microId(row);
  const rowMacroId = macroId(row);

  return {
    ...row,

    rank: Number.isFinite(Number(row.rank))
      ? Number(row.rank)
      : index + 1,

    microFamilyId: rowMicroId,
    trueMicroFamilyId: row.trueMicroFamilyId || rowMicroId,

    macroFamilyId: rowMacroId,
    parentMacroFamilyId: row.parentMacroFamilyId || rowMacroId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || rowMacroId || null,

    ...modeFlags(),

    source: row.source || 'CLI_MANUAL_SELECTION_SHORT_ONLY',
    selectedTier: row.selectedTier || row.rotationEligibilityTier || 'MANUAL',
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || 'MANUAL',

    manualOnly: true,
    adminSelected: true,

    bestLong: null
  };
}

function forceShortRotation(rotation = {}, requested = {}) {
  const baseRotation = unwrapActiveRotation(rotation) || rotation || {};
  const requestedIds = requested.microFamilyIds || requested.acceptedMicroFamilyIds || [];

  const rowsById = new Map();

  for (const [index, row] of asRows(baseRotation.microFamilies).entries()) {
    const id = microId(row);

    if (!id || !isShortMicroFamilyId(id)) continue;

    rowsById.set(id, forceShortRow(row, index));
  }

  for (const [index, id] of requestedIds.entries()) {
    if (!id || rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size || index));
  }

  const rows = [...rowsById.values()]
    .map((row, index) => forceShortRow({
      ...row,
      rank: index + 1
    }, index));

  const microFamilyIds = uniqueStrings([
    baseRotation.microFamilyIds || [],
    baseRotation.activeMicroFamilyIds || [],
    baseRotation.trueMicroFamilyIds || [],
    requestedIds,
    rows.map(microId)
  ]).filter(isShortMicroFamilyId);

  const macroFamilyIds = uniqueStrings([
    baseRotation.macroFamilyIds || [],
    baseRotation.activeMacroFamilyIds || [],
    rows.map(macroId)
  ]).filter(isAllowedShortOrUnknownMacroId);

  const empty = microFamilyIds.length === 0;

  return {
    ...baseRotation,

    rotationId: baseRotation.rotationId || null,
    source: baseRotation.source || 'CLI_MANUAL_SELECTION_SHORT_ONLY',
    mode: requested.mode || baseRotation.mode || 'selected',
    sideMode: 'short_only',

    sourceWeekKey: baseRotation.sourceWeekKey || requested.sourceWeekKey || requested.weekKey || null,
    activeWeekKey: baseRotation.activeWeekKey || requested.activeWeekKey || requested.weekKey || null,

    generatedAt: baseRotation.generatedAt || now(),
    activatedAt: baseRotation.activatedAt || now(),

    ...modeFlags(),

    trueMicroOnly: true,
    manualOnly: true,
    adminSelected: true,
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

    bestShort: rows[0] || null,
    selectedRow: rows[0] || null,
    selectedMicroFamilyId: rows[0]?.microFamilyId || null,
    selectedMacroFamilyId: rows[0]?.macroFamilyId || null,

    activeCount: microFamilyIds.length,
    count: microFamilyIds.length,
    microCount: microFamilyIds.length,
    trueMicroCount: microFamilyIds.length,
    macroCount: macroFamilyIds.length,

    empty,
    emptyReason: empty
      ? baseRotation.emptyReason || 'NO_MANUAL_SHORT_MICRO_FAMILY_IDS_ACTIVE'
      : null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : []
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

      ...modeFlags(),

      manualOnly: true,
      adminSelected: true,
      discordOnly: true,

      oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),

      weekKey: requested.weekKey,
      sourceWeekKey: requested.sourceWeekKey,
      activeWeekKey: requested.activeWeekKey,
      mode: requested.mode,

      requestedMicroFamilyIds: requested.requestedMicroFamilyIds,
      acceptedMicroFamilyIds: [],
      ignoredIds: requested.ignoredIds,
      ignoredLongIds: requested.ignoredLongIds,
      ignoredUnknownIds: requested.ignoredUnknownIds
    };
  }

  const engineResult = await activateSelectedMicroFamilies({
    microFamilyIds: requested.microFamilyIds,
    activeMicroFamilyIds: requested.microFamilyIds,
    trueMicroFamilyIds: requested.microFamilyIds,

    weekKey: requested.weekKey,
    sourceWeekKey: requested.sourceWeekKey,
    activeWeekKey: requested.activeWeekKey,
    mode: requested.mode || 'selected',

    source: 'CLI_MANUAL_SELECTION_SHORT_ONLY',

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
    adminSelected: true,
    discordOnly: true,
    discordOnlyForSelectedMicroFamilies: true,

    autoRotation: false,
    autoRotationDisabled: true,
    activateNextDisabled: true,
    buildFreshDisabled: true
  });

  const activeRotation = forceShortRotation(engineResult, requested);

  return {
    ok: true,
    skipped: false,
    changed: true,
    type: 'CLI_MANUAL_SHORT_MICRO_FAMILY_DISCORD_SELECTION_ACTIVATED',

    source: 'CLI_MANUAL_SELECTION_SHORT_ONLY',

    weekKey: requested.weekKey,
    sourceWeekKey: requested.sourceWeekKey,
    activeWeekKey: activeRotation.activeWeekKey || requested.activeWeekKey,
    mode: requested.mode || 'selected',

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    discordOnly: true,

    oldAutoFlagsIgnored: Boolean(requested.disabledAutoFlagPresent),

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
    result: engineResult,

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
  const normalizedActiveRotation = activeRotation
    ? forceShortRotation(activeRotation, requested)
    : null;

  const microFamilyIds = extractMicroFamilyIds(normalizedActiveRotation || {});
  const macroFamilyIds = extractMacroFamilyIds(normalizedActiveRotation || {});

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

    mode: requested.mode || result?.mode || 'selected',

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    discordOnly: true,

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

    empty: Boolean(normalizedActiveRotation?.empty || microFamilyIds.length === 0),
    emptyReason: normalizedActiveRotation?.emptyReason || result?.reason || null,
    reason: result?.reason || null,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(normalizedActiveRotation?.usedSoftFallback),
    usedObservationFallback: Boolean(normalizedActiveRotation?.usedObservationFallback),
    usedRawFallback: Boolean(normalizedActiveRotation?.usedRawFallback),

    selectedTier: normalizedActiveRotation?.selectedTier || result?.selectedTier || null,
    missingSides: Array.isArray(normalizedActiveRotation?.missingSides)
      ? normalizedActiveRotation.missingSides
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

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    discordOnly: true,

    oldAutoFlagsIgnored: Boolean(requested?.disabledAutoFlagPresent),

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