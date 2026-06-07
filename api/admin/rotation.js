// ================= FILE: api/admin/rotation.js =================

import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import {
  activateSelectedMicroFamilies,
  getActiveRotation,
  getRotationDashboard
} from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const ALLOWED_ACTIONS = [
  'activateSelected',
  'activateSelectedMicroFamilies',
  'activateSelectedMacroFamilies'
];

const BLOCKED_AUTO_ACTIONS = new Set([
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestShortMicroFamily',
  'activateBestLongMicroFamily',
  'activateBestBullMicroFamily',
  'activateBestLong',
  'activateLong',
  'activateNextRotation',
  'autoActivate',
  'autoBootstrap'
]);

const ALLOWED_MODES = new Set([
  'manual',
  'selected',
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const DEFAULT_AVAILABLE_LIMIT = 120;
const MAX_AVAILABLE_LIMIT = 500;

const DEFAULT_ACTIVE_ROWS_LIMIT = 160;
const MAX_ACTIVE_ROWS_LIMIT = 500;

const DEFAULT_MIN_HARD_COMPLETED = 5;

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...modeFlags()
  });
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

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    noRealOrders: true,
    manualSelectionOnly: true,
    autoRotationDisabled: true,
    autoRotationActivationDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    trueMicroOnly: true
  };
}

function parseJson(text) {
  const clean = String(text || '').trim();

  if (!clean) return {};

  try {
    return JSON.parse(clean);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function toLimit(value, fallback = DEFAULT_AVAILABLE_LIMIT, max = MAX_AVAILABLE_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n < 1) return fallback;

  return Math.min(n, max);
}

function normalizeMode(value, fallback = 'manual') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
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
    .replaceAll('SHORT_ONLY', 'SHORT');
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return String(value || '')
          .split(/[\s,;\n\r]+/g)
          .map((part) => part.trim());
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function getMicroFamilyId(row = {}, fallback = null) {
  return (
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    fallback ||
    null
  );
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

function idLooksLikeLongFamily(id = '') {
  const value = cleanSideText(id);

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('LONG_') ||
    value.includes('_LONG_') ||
    value.endsWith('_LONG') ||
    value.includes('BULL') ||
    value.includes('BUY') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL')
  );
}

function idLooksLikeShortFamily(id = '') {
  const value = cleanSideText(id);

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('SHORT_') ||
    value.includes('_SHORT_') ||
    value.endsWith('_SHORT') ||
    value.startsWith('SHORT_') ||
    value.includes('BEAR') ||
    value.includes('SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR')
  );
}

function definitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    if (idLooksLikeLongFamily(input)) return OPPOSITE_TRADE_SIDE;
    if (idLooksLikeShortFamily(input)) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const directSources = [
    input.tradeSide,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.side,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const familyId = cleanSideText(input.familyId || input.family || input.baseFamilyId);
  const macroFamilyId = cleanSideText(getMacroFamilyId(input));
  const microFamilyId = cleanSideText(getMicroFamilyId(input));

  if (familyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;
  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;

  if (idLooksLikeLongFamily(macroFamilyId)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(macroFamilyId)) return TARGET_TRADE_SIDE;

  if (idLooksLikeLongFamily(microFamilyId)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(microFamilyId)) return TARGET_TRADE_SIDE;

  const definition = definitionHaystack(input);

  if (idLooksLikeLongFamily(definition)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(definition)) return TARGET_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShortId(id = '') {
  const side = inferTradeSide(String(id || ''));

  if (side === OPPOSITE_TRADE_SIDE) return false;
  if (side === TARGET_TRADE_SIDE) return true;

  return idLooksLikeShortFamily(id);
}

function rowSchema(row = {}) {
  return upper(row.microFamilySchema || row.schema || row.versionSchema || '');
}

function isMacroLikeRow(row = {}) {
  const id = cleanSideText(getMicroFamilyId(row));
  const schema = rowSchema(row);
  const version = upper(row.version);

  return (
    row.isLegacyMacro === true ||
    version.includes('MACRO') ||
    schema === 'MF_V1' ||
    /^SHORT_\d+$/i.test(id)
  );
}

function isTrueMicroFamilyRow(row = {}) {
  const id = getMicroFamilyId(row);

  if (!id) return false;
  if (!isShortRow(row)) return false;
  if (isMacroLikeRow(row)) return false;

  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (upper(row.version).includes('MICRO')) return true;
  if (rowSchema(row) === 'MF_V2') return true;
  if (cleanSideText(id).startsWith('MICRO_SHORT_')) return true;
  if (cleanSideText(id).includes('MICRO_SHORT_')) return true;

  return Boolean(getMacroFamilyId(row));
}

function sourceEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [
      getMicroFamilyId(row, String(index)),
      row
    ]);
  }

  if (!value || typeof value !== 'object') return [];

  return Object.entries(value);
}

function outcomeCounts(row = {}) {
  const aggregateWins = num(row.wins, 0);
  const aggregateLosses = num(row.losses, 0);
  const aggregateFlats = num(row.flats, 0);
  const aggregateTotal = aggregateWins + aggregateLosses + aggregateFlats;

  if (aggregateTotal > 0) {
    return {
      wins: aggregateWins,
      losses: aggregateLosses,
      flats: aggregateFlats,
      total: aggregateTotal
    };
  }

  const realWins = num(row.realWins, 0);
  const realLosses = num(row.realLosses, 0);
  const realFlats = num(row.realFlats, 0);
  const realTotal = realWins + realLosses + realFlats;

  if (realTotal > 0) {
    return {
      wins: realWins,
      losses: realLosses,
      flats: realFlats,
      total: realTotal
    };
  }

  return {
    wins: 0,
    losses: 0,
    flats: 0,
    total: 0
  };
}

function completedSample(row = {}) {
  const counts = outcomeCounts(row);

  return Math.max(
    counts.total,
    num(row.completed, 0),
    num(row.realCompleted, 0),
    0
  );
}

function observationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    completedSample(row),
    0
  );
}

function learningStatus(row = {}) {
  if (completedSample(row) > 0) return 'OUTCOMES_READY';
  if (observationSample(row) > 0) return 'OBSERVING';

  return 'RAW';
}

function eligibilityTier(row = {}) {
  const completed = completedSample(row);
  const observed = observationSample(row);
  const score = num(row.dashboardBalancedScore ?? row.balancedScore, 0);

  if (completed >= DEFAULT_MIN_HARD_COMPLETED) return 'HARD';
  if (completed > 0 && score > 0) return 'SOFT';
  if (observed > 0) return 'OBSERVATION';

  return 'RAW';
}

function normalizeRotationRow(row = {}, index = 0) {
  const microFamilyId = getMicroFamilyId(row);

  if (!microFamilyId) return null;

  const normalizedInput = {
    ...row,
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true
  };

  if (!isShortRow(normalizedInput)) return null;

  const macroFamilyId = getMacroFamilyId(normalizedInput);
  const counts = outcomeCounts(row);
  const completed = completedSample(row);
  const observed = observationSample(row);
  const tier = row.selectedTier || row.rotationEligibilityTier || eligibilityTier(row);

  return {
    rank: index + 1,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId: getFamilyId(row),
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    ...modeFlags(),

    schema: row.schema || row.microFamilySchema || null,
    microFamilySchema: row.microFamilySchema || row.schema || null,
    version: row.version || null,

    isTrueMicro: isTrueMicroFamilyRow(normalizedInput),
    isLegacyMacro: isMacroLikeRow(normalizedInput),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(completed, 4),
    realCompleted: round(row.realCompleted, 4),
    shadowCompleted: round(row.shadowCompleted, 4),

    outcomeSample: round(completed, 4),
    observationSample: round(observed, 4),
    awaitingOutcomes: completed <= 0 && observed > 0,
    learningStatus: learningStatus(row),

    wins: round(counts.wins, 4),
    losses: round(counts.losses, 4),
    flats: round(counts.flats, 4),

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate, 4),

    winrateSample: round(row.winrateSample ?? completed, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? row.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(row.avgR, 4),
    totalR: round(row.totalR ?? row.realTotalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    nearTpPct: round(row.nearTpPct, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitPct: round(row.beWouldExitPct, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(row.totalCostR, 4),
    avgCostR: round(row.avgCostR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? row.balancedScore, 4),

    selectedTier: tier,
    rotationEligibilityTier: tier,

    assetClass: row.assetClass || null,

    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,

    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,

    obRelation: row.obRelation || null,

    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,

    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    executionFingerprintHash: row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : [],
    executionFingerprintSchema: row.executionFingerprintSchema || null,

    definitionParts: getDefinitionParts(row),
    definition: row.definition || '',

    macroDefinitionParts: getMacroDefinitionParts(row),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    sourceWeekKey: row.sourceWeekKey || null,
    sourceWeekPrimary: Boolean(row.sourceWeekPrimary),
    sourceWeekFallback: Boolean(row.sourceWeekFallback),

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function compareRows(a = {}, b = {}) {
  return (
    num(b.dashboardBalancedScore, 0) - num(a.dashboardBalancedScore, 0) ||
    num(b.totalR, 0) - num(a.totalR, 0) ||
    num(b.avgR, 0) - num(a.avgR, 0) ||
    num(b.outcomeSample, 0) - num(a.outcomeSample, 0) ||
    num(b.observationSample, 0) - num(a.observationSample, 0) ||
    String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''))
  );
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    if (!row?.microFamilyId) continue;
    if (seen.has(row.microFamilyId)) continue;
    if (!isShortRow(row)) continue;
    if (!isTrueMicroFamilyRow(row)) continue;

    seen.add(row.microFamilyId);
    output.push(row);
  }

  return output;
}

async function loadAvailableRows({
  weekKey,
  includePrevious = true,
  limit = DEFAULT_AVAILABLE_LIMIT
} = {}) {
  const currentWeekKey = weekKey || getIsoWeekKey();
  const previousWeekKey = getPreviousIsoWeekKey();

  const current = await getWeekMicros(currentWeekKey).catch(() => ({}));

  const previous = includePrevious && previousWeekKey !== currentWeekKey
    ? await getWeekMicros(previousWeekKey).catch(() => ({}))
    : {};

  const merged = {
    ...(previous || {}),
    ...(current || {})
  };

  const rows = sourceEntries(merged)
    .map(([key, row], index) => normalizeRotationRow({
      ...(row || {}),
      key,
      microFamilyId: getMicroFamilyId(row, key),
      sourceWeekKey: row?.sourceWeekKey || (current[key] ? currentWeekKey : previousWeekKey),
      sourceWeekPrimary: Boolean(current[key]),
      sourceWeekFallback: Boolean(!current[key] && previous[key])
    }, index))
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow)
    .sort(compareRows);

  return {
    currentWeekKey,
    previousWeekKey,
    currentRows: sourceEntries(current).length,
    previousRows: sourceEntries(previous).length,
    mergedRows: rows.length,
    rows: dedupeRows(rows).slice(0, limit)
  };
}

function extractIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return uniqueStrings([
    ...(Array.isArray(rotation?.microFamilyIds) ? rotation.microFamilyIds : []),
    ...(Array.isArray(rotation?.activeMicroFamilyIds) ? rotation.activeMicroFamilyIds : []),
    ...(Array.isArray(rotation?.trueMicroFamilyIds) ? rotation.trueMicroFamilyIds : []),
    ...rows.map((row) => getMicroFamilyId(row))
  ]).filter(isShortId);
}

function extractMacroIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation?.microFamilies)
    ? rotation.microFamilies
    : [];

  return uniqueStrings([
    ...(Array.isArray(rotation?.macroFamilyIds) ? rotation.macroFamilyIds : []),
    ...(Array.isArray(rotation?.activeMacroFamilyIds) ? rotation.activeMacroFamilyIds : []),
    ...rows.map((row) => getMacroFamilyId(row))
  ]).filter(isShortId);
}

function compactActiveRotation(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;

  const activeMicroFamilyIds = extractIdsFromRotation(rotation);
  const activeMacroFamilyIds = extractMacroIdsFromRotation(rotation);

  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
      .map((row, index) => normalizeRotationRow(row, index))
      .filter(Boolean)
      .filter(isShortRow)
      .filter(isTrueMicroFamilyRow)
    : [];

  return {
    rotationId: rotation.rotationId || null,
    source: rotation.source || null,
    mode: rotation.mode || null,
    sourceWeekKey: rotation.sourceWeekKey || null,
    activeWeekKey: rotation.activeWeekKey || null,
    generatedAt: rotation.generatedAt || null,
    activatedAt: rotation.activatedAt || null,

    ...modeFlags(),

    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: rows.length > 0,

    empty: rows.length === 0,
    emptyReason: rows.length === 0
      ? 'NO_MANUAL_SHORT_TRUE_MICRO_SELECTION_ACTIVE'
      : null,

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    microFamilies: rows,

    count: activeMicroFamilyIds.length,
    activeCount: activeMicroFamilyIds.length,

    bestLong: null,
    bestShort: rows[0] || null,
    missingSides: rows.length ? [] : [TARGET_TRADE_SIDE]
  };
}

function parseSelectedIds(body = {}) {
  const microFamilyIds = uniqueStrings([
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids,
    body.id,
    body.microFamilyId
  ]);

  const macroFamilyIds = uniqueStrings([
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.macroFamilyId
  ]);

  const requestedIds = uniqueStrings([
    microFamilyIds,
    macroFamilyIds
  ]);

  const acceptedIds = requestedIds.filter(isShortId);

  const ignoredRequestedIds = requestedIds
    .filter((id) => !isShortId(id))
    .map((id) => ({
      id,
      reason: inferTradeSide(id) === OPPOSITE_TRADE_SIDE
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'UNKNOWN_OR_NON_SHORT_ID_REJECTED'
    }));

  return {
    requestedIds,
    microFamilyIds: microFamilyIds.filter(isShortId),
    macroFamilyIds: macroFamilyIds.filter(isShortId),
    acceptedIds,
    ignoredRequestedIds
  };
}

function normalizeAction(body = {}) {
  const raw = String(body?.action || '').trim();

  if (raw) return raw;

  const ids = parseSelectedIds(body);

  if (ids.acceptedIds.length > 0) return 'activateSelectedMicroFamilies';

  return '';
}

function buildTierSummary(rows = []) {
  return rows.reduce((acc, row) => {
    const tier = row.rotationEligibilityTier || row.selectedTier || eligibilityTier(row);

    acc.total += 1;
    acc[tier] = (acc[tier] || 0) + 1;

    return acc;
  }, {
    total: 0,
    HARD: 0,
    SOFT: 0,
    OBSERVATION: 0,
    RAW: 0
  });
}

async function handleGet(req, res) {
  const startedAt = now();

  const requestedWeekKey = String(
    firstValue(req.query?.weekKey, getIsoWeekKey())
  ).trim();

  const availableLimit = toLimit(
    firstValue(req.query?.availableLimit, DEFAULT_AVAILABLE_LIMIT),
    DEFAULT_AVAILABLE_LIMIT,
    MAX_AVAILABLE_LIMIT
  );

  const activeRowsLimit = toLimit(
    firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT),
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ACTIVE_ROWS_LIMIT
  );

  const includeAvailable = isTrue(
    firstValue(req.query?.includeAvailable, true),
    true
  );

  const includePrevious = isTrue(
    firstValue(req.query?.includePrevious, true),
    true
  );

  const [dashboard, activeRotation, availableResult] = await Promise.all([
    getRotationDashboard().catch(() => null),
    getActiveRotation().catch(() => null),
    includeAvailable
      ? loadAvailableRows({
        weekKey: requestedWeekKey,
        includePrevious,
        limit: availableLimit
      }).catch((error) => ({
        currentWeekKey: requestedWeekKey,
        previousWeekKey: getPreviousIsoWeekKey(),
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        rows: [],
        warning: error?.message || String(error)
      }))
      : Promise.resolve({
        currentWeekKey: requestedWeekKey,
        previousWeekKey: getPreviousIsoWeekKey(),
        currentRows: 0,
        previousRows: 0,
        mergedRows: 0,
        rows: []
      })
  ]);

  const active = compactActiveRotation(activeRotation);
  const availableRows = availableResult.rows || [];

  return res.status(200).json({
    ok: true,

    ...modeFlags(),

    currentWeekKey: getIsoWeekKey(),
    previousWeekKey: getPreviousIsoWeekKey(),
    requestedWeekKey,

    activeRowsLimit,
    availableLimit,
    includeAvailable,
    includePrevious,

    activeRotation: active,
    active,

    activeRotationId: active?.rotationId || null,
    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    activeRows: (active?.microFamilies || []).slice(0, activeRowsLimit),
    activeCount: active?.activeMicroFamilyIds?.length || 0,

    dashboard: dashboard || null,
    nextRotation: dashboard?.next || dashboard?.nextRotation || null,
    nextRotationStoredOnly: true,
    nextRotationAutoActivationDisabled: true,

    availableMicroFamilies: availableRows,
    availableRows,
    availableCount: availableRows.length,

    availableTierSummary: buildTierSummary(availableRows),

    sourceRows: {
      currentWeekRows: availableResult.currentRows,
      previousWeekRows: availableResult.previousRows,
      mergedRows: availableResult.mergedRows,
      warning: availableResult.warning || null
    },

    allowedActions: ALLOWED_ACTIONS,
    blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],

    perf: {
      durationMs: now() - startedAt,
      source: 'manual_selection_only_rotation_dashboard'
    },

    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const action = normalizeAction(body);

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (BLOCKED_AUTO_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'AUTO_ROTATION_DISABLED_MANUAL_SELECTION_ONLY',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  if (!ALLOWED_ACTIONS.includes(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'UNKNOWN_OR_DISABLED_ACTION',
      action,
      allowedActions: ALLOWED_ACTIONS,
      blockedAutoActions: [...BLOCKED_AUTO_ACTIONS],
      ...modeFlags()
    });
  }

  const selected = parseSelectedIds(body);

  if (selected.acceptedIds.length === 0) {
    return res.status(400).json({
      ok: false,
      reason: selected.ignoredRequestedIds.some((row) => row.reason === 'LONG_DISABLED_SHORT_ONLY')
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'SHORT_MICRO_OR_MACRO_FAMILY_IDS_REQUIRED',

      requestedIds: selected.requestedIds,
      ignoredRequestedIds: selected.ignoredRequestedIds,

      allowedActions: ALLOWED_ACTIONS,
      ...modeFlags()
    });
  }

  const weekKey = String(
    firstValue(body.weekKey, getIsoWeekKey())
  ).trim();

  const mode = normalizeMode(
    firstValue(body.mode, action === 'activateSelected' ? 'selected' : 'manual'),
    'manual'
  );

  const activation = await activateSelectedMicroFamilies({
    microFamilyIds: selected.acceptedIds,
    weekKey,
    mode
  });

  const active = compactActiveRotation(activation);

  return res.status(200).json({
    ok: true,
    action,

    ...modeFlags(),

    weekKey,
    mode,

    requestedMicroFamilyIds: selected.microFamilyIds,
    requestedMacroFamilyIds: selected.macroFamilyIds,
    requestedIds: selected.requestedIds,
    acceptedIds: selected.acceptedIds,
    ignoredRequestedIds: [
      ...selected.ignoredRequestedIds,
      ...(Array.isArray(activation?.ignoredRequestedIds)
        ? activation.ignoredRequestedIds
        : [])
    ],

    activeRotation: active,
    active,

    activatedCount: active?.activeMicroFamilyIds?.length || 0,
    activatedMicroCount: active?.activeMicroFamilyIds?.length || 0,
    activatedMacroCount: active?.activeMacroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: active?.activeMacroFamilyIds || [],

    bestLong: null,
    bestShort: active?.bestShort || null,

    discordEntryAlertsEnabledForSelectedMicroFamiliesOnly:
      (active?.activeMicroFamilyIds || []).length > 0,

    noSelectionMeansNoDiscord:
      (active?.activeMicroFamilyIds || []).length === 0,

    rawActivation: activation,

    perf: {
      durationMs: now() - startedAt,
      source: 'activateSelectedMicroFamilies_manual_only'
    },

    serverTs: Date.now()
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'short-only-manual-selection-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');

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

      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}