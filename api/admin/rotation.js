// ================= FILE: api/admin/rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import {
  getDurableRedis,
  setJson
} from '../../src/redis.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import {
  getRotationDashboard,
  buildRotationFromWeek
} from '../../src/analyze/rotationEngine.js';

const ALLOWED_ACTIONS = [
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestLongMicroFamily',
  'activateBestShortMicroFamily',
  'activateSelected',
  'activateSelectedMicroFamilies',
  'activateSelectedMacroFamilies'
];

const ALLOWED_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const TRADE_SIDES = new Set(['LONG', 'SHORT']);

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST']
  });
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      return parseJson(req.body.trim());
    }

    if (Buffer.isBuffer(req.body)) {
      return parseJson(req.body.toString('utf8').trim());
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function normalizeMode(value, fallback = 'balanced') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return String(value || '')
          .split(/[\s,]+/g)
          .map((part) => part.trim());
      })
      .filter(Boolean)
  )];
}

function normalizeFamilyIds(...values) {
  return uniqueStrings(values);
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function normalizeRequestedTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (raw === 'LONG' || raw === 'BULL' || raw === 'BUY') return 'LONG';
  if (raw === 'SHORT' || raw === 'BEAR' || raw === 'SELL') return 'SHORT';

  const converted = sideToTradeSide(raw);

  if (TRADE_SIDES.has(converted)) return converted;

  return 'UNKNOWN';
}

function oppositeTradeSide(side) {
  if (side === 'LONG') return 'SHORT';
  if (side === 'SHORT') return 'LONG';

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = String(row.side || '').toUpperCase();

  if (['BULL', 'LONG', 'BUY'].includes(rawSide)) return 'LONG';
  if (['BEAR', 'SHORT', 'SELL'].includes(rawSide)) return 'SHORT';

  const familyId = String(row.familyId || '').toUpperCase();
  const macroFamilyId = String(row.macroFamilyId || '').toUpperCase();
  const microFamilyId = String(row.microFamilyId || row.id || '').toUpperCase();

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  return 'UNKNOWN';
}

function normalizeDashboardSide(row = {}) {
  const tradeSide = inferTradeSide(row);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
  if (Array.isArray(row.definition)) return row.definition;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function normalizeRotationRow(row = {}, index = 0) {
  const microFamilyId = row.microFamilyId || row.id || row.key || null;
  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId
  });

  const tradeSide = inferTradeSide({
    ...row,
    microFamilyId,
    macroFamilyId
  });

  return {
    ...row,

    rank: num(row.rank, index + 1),

    microFamilyId,
    familyId: getFamilyId(row),
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: normalizeDashboardSide({
      ...row,
      microFamilyId,
      macroFamilyId,
      tradeSide
    }),
    tradeSide,

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    winrateSample: round(row.winrateSample, 4),
    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate, 4),

    avgR: round(row.avgR, 4),
    totalR: round(row.totalR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    nearTpPct: round(row.nearTpPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitPct: round(row.beWouldExitPct, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    avgCostR: round(row.avgCostR, 4),
    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? row.balancedScore, 4),

    definitionParts: getDefinitionParts(row),
    definition: row.definition || '',

    macroDefinitionParts: getMacroDefinitionParts(row),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    manualOnly: Boolean(row.manualOnly)
  };
}

function microIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  return normalizeFamilyIds(
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids,
    rows.map((row) => row?.microFamilyId)
  );
}

function macroIdsFromRotation(rotation = {}, microFamilyIds = []) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const macroIds = normalizeFamilyIds(
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rows.map((row) => getMacroFamilyId(row))
  );

  if (macroIds.length > 0) return macroIds;

  return normalizeFamilyIds(microFamilyIds);
}

function normalizeRotation(rotation = {}, fallback = {}) {
  const base = {
    ...fallback,
    ...(rotation || {})
  };

  const microFamilies = Array.isArray(base.microFamilies)
    ? base.microFamilies.map((row, index) => normalizeRotationRow(row, index))
    : [];

  const microFamilyIds = normalizeFamilyIds(
    microIdsFromRotation({
      ...base,
      microFamilies
    }),
    microFamilies.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = normalizeFamilyIds(
    macroIdsFromRotation({
      ...base,
      microFamilies
    }, microFamilyIds),
    microFamilies.map((row) => row.macroFamilyId)
  );

  const bestLong =
    base.bestLong ||
    microFamilies.find((row) => row.tradeSide === 'LONG') ||
    null;

  const bestShort =
    base.bestShort ||
    microFamilies.find((row) => row.tradeSide === 'SHORT') ||
    null;

  return {
    ...base,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    bestLong,
    bestShort,

    count: microFamilyIds.length || microFamilies.length,
    microCount: microFamilyIds.length || microFamilies.length,
    macroCount: macroFamilyIds.length
  };
}

function rowsFromDashboardRows(rows, fallbackRows) {
  if (Array.isArray(rows) && rows.length > 0) return rows;
  if (Array.isArray(fallbackRows)) return fallbackRows;

  return [];
}

function normalizeDashboard(dashboard = {}) {
  const active = normalizeRotation(
    dashboard.active ||
    dashboard.activeRotation ||
    {}
  );

  const next = normalizeRotation(
    dashboard.next ||
    dashboard.nextRotation ||
    {}
  );

  const activeRows = rowsFromDashboardRows(
    dashboard.activeRows,
    active.microFamilies
  ).map((row, index) => normalizeRotationRow(row, index));

  const nextRows = rowsFromDashboardRows(
    dashboard.nextRows,
    next.microFamilies
  ).map((row, index) => normalizeRotationRow(row, index));

  return {
    ...dashboard,

    active,
    next,

    activeRotation: active,
    nextRotation: next,

    activeRows,
    nextRows,

    activeCount: active.microFamilyIds.length || activeRows.length,
    nextCount: next.microFamilyIds.length || nextRows.length,

    activeMacroCount: active.macroFamilyIds.length,
    nextMacroCount: next.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    nextMicroFamilyIds: next.microFamilyIds,
    nextMacroFamilyIds: next.macroFamilyIds,

    bestLong: active.bestLong,
    bestShort: active.bestShort,

    nextBestLong: next.bestLong,
    nextBestShort: next.bestShort
  };
}

async function handleGet(req, res) {
  const dashboard = normalizeDashboard(await getRotationDashboard());

  return res.status(200).json({
    ok: true,

    currentWeekKey: getIsoWeekKey(),
    previousWeekKey: getPreviousIsoWeekKey(),

    ...dashboard,

    serverTs: Date.now()
  });
}

function selectedIdsFromBody(body = {}) {
  const explicitMacroIds = normalizeFamilyIds(
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds
  );

  const explicitMicroIds = normalizeFamilyIds(
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids
  );

  const macroFamilyIds = explicitMacroIds.length
    ? explicitMacroIds
    : [];

  const microFamilyIds = explicitMicroIds.length
    ? explicitMicroIds
    : [];

  return {
    microFamilyIds,
    macroFamilyIds
  };
}

function rowMatchesSelection(row, microSet, macroSet) {
  const microFamilyId = row.microFamilyId || row.id || row.key || null;
  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId
  });

  return (
    (microFamilyId && microSet.has(microFamilyId)) ||
    (macroFamilyId && macroSet.has(macroFamilyId)) ||
    (microFamilyId && macroSet.has(microFamilyId))
  );
}

function buildManualRow(id, index = 0, type = 'micro') {
  const microFamilyId = id;
  const macroFamilyId = type === 'macro'
    ? id
    : null;

  return normalizeRotationRow({
    rank: index + 1,
    microFamilyId,
    macroFamilyId,

    familyId: null,
    side: null,
    tradeSide: 'UNKNOWN',

    seen: 0,
    observations: 0,
    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    winrateSample: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedOneRPct: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    definitionParts: [],
    definition: '',

    manualOnly: true
  }, index);
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    const key = row.microFamilyId || row.macroFamilyId;

    if (!key || seen.has(key)) continue;

    seen.add(key);
    output.push(row);
  }

  return output.map((row, index) => normalizeRotationRow(row, index));
}

function scoreByMode(row = {}, mode = 'balanced') {
  if (mode === 'winrate') {
    return num(
      row.fairWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound ??
      row.winrate,
      0
    );
  }

  if (mode === 'totalR') {
    return num(row.totalR, 0);
  }

  if (mode === 'avgR') {
    return num(row.avgR, 0);
  }

  if (mode === 'directSL') {
    return -num(row.directSLPct, 1);
  }

  if (mode === 'observed') {
    return num(
      row.completed ??
      row.winrateSample ??
      row.realCompleted ??
      row.seen ??
      row.observations,
      0
    );
  }

  return num(row.dashboardBalancedScore ?? row.balancedScore, 0);
}

function compareRowsByMode(a = {}, b = {}, mode = 'balanced') {
  const scoreDiff = scoreByMode(b, mode) - scoreByMode(a, mode);

  if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;

  const completedDiff = num(b.completed, 0) - num(a.completed, 0);
  if (Math.abs(completedDiff) > 1e-12) return completedDiff;

  const totalRDiff = num(b.totalR, 0) - num(a.totalR, 0);
  if (Math.abs(totalRDiff) > 1e-12) return totalRDiff;

  const avgRDiff = num(b.avgR, 0) - num(a.avgR, 0);
  if (Math.abs(avgRDiff) > 1e-12) return avgRDiff;

  const seenDiff = num(b.seen, 0) - num(a.seen, 0);
  if (Math.abs(seenDiff) > 1e-12) return seenDiff;

  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function sortRowsByMode(rows = [], mode = 'balanced') {
  return [...rows].sort((a, b) => compareRowsByMode(a, b, mode));
}

function bestRowForSide(rows = [], tradeSide, mode = 'balanced') {
  const sideRows = rows.filter((row) => row.tradeSide === tradeSide);

  if (sideRows.length === 0) return null;

  return sortRowsByMode(sideRows, mode)[0] || null;
}

async function getWeekRows(weekKey) {
  const micros = await getWeekMicros(weekKey);

  return Object.entries(micros || {})
    .map(([key, row], index) => normalizeRotationRow({
      ...row,
      key,
      microFamilyId: row?.microFamilyId || key
    }, index))
    .filter((row) => row.microFamilyId);
}

async function findBestWeekSideRow({
  weekKey,
  tradeSide,
  mode
} = {}) {
  const rows = await getWeekRows(weekKey);

  const sideRows = rows.filter((row) => row.tradeSide === tradeSide);

  const tradableRows = sideRows.filter((row) => {
    return (
      num(row.completed, 0) > 0 ||
      num(row.realCompleted, 0) > 0 ||
      num(row.shadowCompleted, 0) > 0 ||
      num(row.seen, 0) > 0
    );
  });

  const candidateRows = tradableRows.length > 0
    ? tradableRows
    : sideRows;

  const best = sortRowsByMode(candidateRows, mode)[0] || null;

  return {
    best,
    rows,
    sideRows,
    candidateRows,
    sideCount: sideRows.length,
    candidateCount: candidateRows.length,
    tradableCount: tradableRows.length
  };
}

async function buildSelectedRotationRows({
  weekKey,
  microFamilyIds = [],
  macroFamilyIds = []
} = {}) {
  const micros = await getWeekMicros(weekKey);

  const microSet = new Set(microFamilyIds);
  const macroSet = new Set(macroFamilyIds);

  const rows = Object.entries(micros || {})
    .map(([key, row], index) => normalizeRotationRow({
      ...row,
      key,
      microFamilyId: row?.microFamilyId || key
    }, index))
    .filter((row) => rowMatchesSelection(row, microSet, macroSet));

  const matchedMicroIds = new Set(rows.map((row) => row.microFamilyId).filter(Boolean));
  const matchedMacroIds = new Set(rows.map((row) => row.macroFamilyId).filter(Boolean));

  const missingMicroRows = microFamilyIds
    .filter((id) => !matchedMicroIds.has(id) && !matchedMacroIds.has(id))
    .map((id, index) => buildManualRow(id, rows.length + index, 'micro'));

  const missingMacroRows = macroFamilyIds
    .filter((id) => !matchedMacroIds.has(id) && !matchedMicroIds.has(id))
    .map((id, index) => buildManualRow(
      id,
      rows.length + missingMicroRows.length + index,
      'macro'
    ));

  return dedupeRows([
    ...rows,
    ...missingMicroRows,
    ...missingMacroRows
  ]);
}

async function persistActiveRotation(active) {
  const normalizedActive = normalizeRotation(active);

  await setJson(
    getDurableRedis(),
    KEYS.analyze.activeRotation,
    normalizedActive
  );

  return normalizedActive;
}

async function activateBestBalanced(body) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const mode = normalizeMode(
    firstValue(body.mode, 'balanced'),
    'balanced'
  );

  const rotation = await buildRotationFromWeek({
    weekKey: sourceWeekKey,
    activeWeekKey,
    mode
  });

  const active = await persistActiveRotation({
    ...rotation,

    source: 'ADMIN_ACTIVATE_BEST_BALANCED',

    sourceWeekKey,
    activeWeekKey,
    mode,

    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion
  });

  return {
    action: 'activateBestBalanced',

    sourceWeekKey,
    activeWeekKey,
    mode,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    bestLong: active.bestLong,
    bestShort: active.bestShort,

    empty: Boolean(active.empty),
    emptyReason: active.emptyReason || null,
    usedSoftFallback: Boolean(active.usedSoftFallback)
  };
}

async function activateBestSideMicro(body, forcedTradeSide = null) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const mode = normalizeMode(
    firstValue(body.mode, 'balanced'),
    'balanced'
  );

  const requestedTradeSide = forcedTradeSide || normalizeRequestedTradeSide(
    firstValue(
      body.tradeSide,
      firstValue(body.side, firstValue(body.direction, null))
    )
  );

  if (!TRADE_SIDES.has(requestedTradeSide)) {
    const error = new Error('VALID_SIDE_REQUIRED_LONG_OR_SHORT');
    error.statusCode = 400;
    throw error;
  }

  const oppositeSide = oppositeTradeSide(requestedTradeSide);

  const dashboard = normalizeDashboard(await getRotationDashboard());
  const previousActive = normalizeRotation(
    dashboard.active ||
    dashboard.activeRotation ||
    {}
  );

  const previousRows = Array.isArray(previousActive.microFamilies)
    ? previousActive.microFamilies.map((row, index) => normalizeRotationRow(row, index))
    : [];

  const preservedOppositeRow = bestRowForSide(previousRows, oppositeSide, mode);

  const {
    best: selectedRow,
    sideCount,
    candidateCount,
    tradableCount
  } = await findBestWeekSideRow({
    weekKey: sourceWeekKey,
    tradeSide: requestedTradeSide,
    mode
  });

  if (!selectedRow) {
    return {
      action: 'activateBestSideMicro',

      sourceWeekKey,
      activeWeekKey,
      mode,

      requestedTradeSide,
      preservedTradeSide: oppositeSide,

      skipped: true,
      changed: false,
      empty: previousActive.microFamilyIds.length === 0,
      emptyReason: `NO_${requestedTradeSide}_MICRO_FAMILY_FOUND`,

      sideCount,
      candidateCount,
      tradableCount,

      activeRotation: previousActive,
      active: previousActive,

      activatedCount: previousActive.microFamilyIds.length,
      activatedMicroCount: previousActive.microFamilyIds.length,
      activatedMacroCount: previousActive.macroFamilyIds.length,

      activeMicroFamilyIds: previousActive.microFamilyIds,
      activeMacroFamilyIds: previousActive.macroFamilyIds,

      selectedMicroFamilyId: null,
      selectedMacroFamilyId: null,

      selectedRow: null,

      bestLong: previousActive.bestLong,
      bestShort: previousActive.bestShort
    };
  }

  const combinedRows = sortRowsByMode(
    dedupeRows([
      selectedRow,
      preservedOppositeRow
    ].filter(Boolean)),
    mode
  ).map((row, index) => normalizeRotationRow(row, index));

  const microFamilyIds = normalizeFamilyIds(
    combinedRows.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = normalizeFamilyIds(
    combinedRows.map((row) => row.macroFamilyId)
  );

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_${requestedTradeSide.toLowerCase()}_side`),

    source: `ADMIN_ACTIVATE_BEST_${requestedTradeSide}_MICRO`,

    mode,
    sideMode: 'single_side_plus_preserved_opposite',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    requestedTradeSide,
    preservedTradeSide: oppositeSide,

    replacedSide: requestedTradeSide,
    preservedSide: oppositeSide,

    empty: combinedRows.length === 0,
    emptyReason: combinedRows.length === 0
      ? 'NO_SIDE_ROWS_ACTIVE'
      : null,

    microFamilyIds,
    macroFamilyIds,
    microFamilies: combinedRows,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,

    selectedRow,

    previousActiveMicroFamilyIds: previousActive.microFamilyIds,
    previousActiveMacroFamilyIds: previousActive.macroFamilyIds
  });

  return {
    action: 'activateBestSideMicro',

    sourceWeekKey,
    activeWeekKey,
    mode,

    requestedTradeSide,
    preservedTradeSide: oppositeSide,

    skipped: false,
    changed: true,

    sideCount,
    candidateCount,
    tradableCount,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,

    selectedRow,

    bestLong: active.bestLong,
    bestShort: active.bestShort
  };
}

async function activateSelected(body, forcedType = null) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const requested = selectedIdsFromBody(body);

  let microFamilyIds = requested.microFamilyIds;
  let macroFamilyIds = requested.macroFamilyIds;

  if (forcedType === 'micro') {
    microFamilyIds = requested.microFamilyIds;
    macroFamilyIds = [];
  }

  if (forcedType === 'macro') {
    microFamilyIds = [];
    macroFamilyIds = requested.macroFamilyIds.length
      ? requested.macroFamilyIds
      : requested.microFamilyIds;
  }

  if (forcedType === null && microFamilyIds.length === 0 && macroFamilyIds.length === 0) {
    macroFamilyIds = requested.microFamilyIds;
    microFamilyIds = requested.microFamilyIds;
  }

  const hasMicroIds = microFamilyIds.length > 0;
  const hasMacroIds = macroFamilyIds.length > 0;

  if (!hasMicroIds && !hasMacroIds) {
    const error = new Error('MICRO_OR_MACRO_FAMILY_IDS_REQUIRED');
    error.statusCode = 400;
    throw error;
  }

  const microFamilies = await buildSelectedRotationRows({
    weekKey: sourceWeekKey,
    microFamilyIds,
    macroFamilyIds
  });

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_selected`),

    source: forcedType === 'macro'
      ? 'ADMIN_ACTIVATE_SELECTED_MACRO_FAMILIES'
      : forcedType === 'micro'
        ? 'ADMIN_ACTIVATE_SELECTED_MICRO_FAMILIES'
        : 'ADMIN_ACTIVATE_SELECTED',

    mode: 'selected',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    empty: microFamilies.length === 0,
    emptyReason: microFamilies.length === 0
      ? 'NO_SELECTED_IDS_MATCHED'
      : null,

    microFamilyIds: normalizeFamilyIds(
      microFamilyIds,
      microFamilies.map((row) => row.microFamilyId)
    ),

    macroFamilyIds: normalizeFamilyIds(
      macroFamilyIds,
      microFamilies.map((row) => row.macroFamilyId)
    ),

    microFamilies
  });

  return {
    action: forcedType === 'macro'
      ? 'activateSelectedMacroFamilies'
      : forcedType === 'micro'
        ? 'activateSelectedMicroFamilies'
        : 'activateSelected',

    sourceWeekKey,
    activeWeekKey,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    bestLong: active.bestLong,
    bestShort: active.bestShort
  };
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const action = String(body?.action || '').trim();

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS
    });
  }

  if (action === 'activateBestBalanced') {
    const result = await activateBestBalanced(body);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (
    action === 'activateBestSideMicro' ||
    action === 'activateBestSideMicroFamily'
  ) {
    const result = await activateBestSideMicro(body);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateBestLongMicroFamily') {
    const result = await activateBestSideMicro(body, 'LONG');

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateBestShortMicroFamily') {
    const result = await activateBestSideMicro(body, 'SHORT');

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelected') {
    const result = await activateSelected(body);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelectedMicroFamilies') {
    const result = await activateSelected(body, 'micro');

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelectedMacroFamilies') {
    const result = await activateSelected(body, 'macro');

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  return res.status(400).json({
    ok: false,
    reason: 'UNKNOWN_ACTION',
    action,
    allowedActions: ALLOWED_ACTIONS
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}