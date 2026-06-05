// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const ROTATION_SIDES = [TARGET_TRADE_SIDE];

function now() {
  return Date.now();
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeSchema(value) {
  return String(value || '').trim().toUpperCase();
}

function schemaMeta() {
  const macroSchema = normalizeSchema(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    CONFIG.analyze?.schema ||
    'MF_V1'
  );

  const microSchema = normalizeSchema(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  );

  return {
    schema: normalizeSchema(CONFIG.analyze?.schema || macroSchema),
    macroSchema,
    microSchema,
    strategyVersion: CONFIG.strategyVersion
  };
}

function minWeightedCompleted() {
  return safeNumber(CONFIG.rotation?.minWeightedCompleted, 5);
}

function topNPerSide() {
  const n = Number(CONFIG.rotation?.topNPerSide || 10);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 10;
}

function maxPerMacroFamily() {
  const n = Number(CONFIG.rotation?.maxPerMacroFamily || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

function defaultRotationMode() {
  return CONFIG.rotation?.mode || 'balanced';
}

function allowLegacyMacroActivation() {
  return Boolean(CONFIG.rotation?.allowLegacyMacroActivation);
}

function allowManualUnknownTrueMicroIds() {
  return CONFIG.rotation?.allowManualUnknownTrueMicroIds !== false;
}

function allowManualBelowMinCompleted() {
  return Boolean(CONFIG.rotation?.allowManualBelowMinCompleted);
}

function allowSoftRotationFallback() {
  return CONFIG.rotation?.allowSoftRotationFallback !== false;
}

function allowObservationRotationFallback() {
  return CONFIG.rotation?.allowObservationRotationFallback !== false;
}

function rowId(row = {}) {
  return String(row.microFamilyId || row.id || '').toUpperCase();
}

function idLooksLikeMicroFamily(id = '') {
  return String(id || '').toUpperCase().startsWith('MICRO_');
}

function idLooksLikeShortFamily(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('SHORT') ||
    value.includes('BEAR') ||
    value.includes('SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR')
  );
}

function idLooksLikeSimpleMacroFamily(id = '') {
  return /^SHORT_\d+$/i.test(String(id || '').trim());
}

function hasSchemaInId(id, schema) {
  const s = normalizeSchema(schema);
  const value = String(id || '').toUpperCase();

  if (!s) return false;

  return value.includes(`_${s}_`) ||
    value.endsWith(`_${s}`) ||
    value.includes(`|SCHEMA=${s}`);
}

function definitionHasSchema(row = {}, schema) {
  const s = normalizeSchema(schema);

  if (!s) return false;

  const parts = Array.isArray(row.definitionParts)
    ? row.definitionParts
    : [];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
    return true;
  }

  return String(row.definition || '').toUpperCase().includes(`SCHEMA=${s}`);
}

function rowSchema(row = {}) {
  return normalizeSchema(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  );
}

function hasParentMacro(row = {}) {
  return Boolean(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId
  );
}

export function isTrueMicroFamily(row = {}) {
  const { microSchema, macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (row.isLegacyMacro === true) return false;
  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (version.includes('MACRO')) return false;

  if (idLooksLikeMicroFamily(id)) return true;

  if (schema === microSchema) return true;
  if (hasSchemaInId(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (hasParentMacro(row) && !idLooksLikeSimpleMacroFamily(id)) return true;

  if (schema === macroSchema) return false;
  if (hasSchemaInId(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return false;
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isTrueMicroFamily(row)) return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (idLooksLikeSimpleMacroFamily(id)) return true;
  if (schema === macroSchema) return true;
  if (hasSchemaInId(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return !row.parentMacroFamilyId && !row.parentMicroFamilyId;
}

function isKnownTrueMicroId(id = '') {
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (!idLooksLikeMicroFamily(value)) return false;

  return idLooksLikeShortFamily(value);
}

function parentMacroFamilyId(row = {}) {
  const direct = String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();

  if (direct) return direct;

  const familyId = String(row.familyId || '').trim();

  if (familyId) return familyId;

  const id = String(row.microFamilyId || row.id || '').trim();

  if (idLooksLikeSimpleMacroFamily(id)) return id;

  return '';
}

function microSide(row = {}) {
  const direct = sideToTradeSide(row.tradeSide || row.side);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const familyId = String(row.familyId || '').toUpperCase();

  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;

  const macroId = String(parentMacroFamilyId(row) || '').toUpperCase();

  if (macroId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(macroId)) return TARGET_TRADE_SIDE;

  const microId = String(row.microFamilyId || row.id || '').toUpperCase();

  if (microId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
  if (microId.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (microId.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (microId.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (microId.includes('SIDE=BEAR')) return TARGET_TRADE_SIDE;

  const definition = [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .join('|');

  if (definition.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (definition.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (definition.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (definition.includes('SIDE=BEAR')) return TARGET_TRADE_SIDE;
  if (definition.includes('DIRECTION=SHORT')) return TARGET_TRADE_SIDE;
  if (definition.includes('DIRECTION=BEAR')) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  const side = microSide(row);

  if (side === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return 'unknown';
}

function isShortRotationRow(row = {}) {
  return microSide(row) === TARGET_TRADE_SIDE;
}

function isEligible(row = {}) {
  if (!isShortRotationRow(row)) return false;

  return safeNumber(row.completed, 0) >= minWeightedCompleted();
}

function isSoftEligible(row = {}) {
  if (!allowSoftRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const completed = safeNumber(row.completed, 0);
  const balancedScore = safeNumber(
    row.balancedScore ?? row.dashboardBalancedScore,
    0
  );

  if (completed <= 0) return false;
  if (balancedScore <= 0) return false;

  return (
    safeNumber(row.avgR, 0) > 0 ||
    safeNumber(row.totalR, 0) > 0 ||
    safeNumber(row.fairWinrate, 0) > 0 ||
    safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
    safeNumber(row.wilsonLowerBound, 0) > 0
  );
}

function isObservationEligible(row = {}) {
  if (!allowObservationRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const seen = safeNumber(row.seen, 0);
  const observations = safeNumber(row.observations, 0);

  return Math.max(seen, observations) > 0;
}

function rotationEligibilityTier(row = {}) {
  if (isEligible(row)) return 'HARD';
  if (isSoftEligible(row)) return 'SOFT';
  if (isObservationEligible(row)) return 'OBSERVATION';

  return 'NONE';
}

function isManualEligible(row = {}) {
  if (!isShortRotationRow(row)) return false;

  if (allowManualBelowMinCompleted()) return true;

  return isEligible(row) || isSoftEligible(row) || isObservationEligible(row);
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const macroId = parentMacroFamilyId(refreshed);
  const eligibilityTier = rotationEligibilityTier(refreshed);

  return {
    rank,

    microFamilyId: refreshed.microFamilyId,
    familyId: refreshed.familyId,

    macroFamilyId: macroId || refreshed.macroFamilyId || null,
    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: refreshed.parentMicroFamilyId || macroId || null,

    side,
    tradeSide,

    shortOnly: true,
    longDisabled: true,

    schema: refreshed.schema || refreshed.microFamilySchema || schemaMeta().microSchema,
    microFamilySchema: refreshed.microFamilySchema || refreshed.schema || schemaMeta().microSchema,
    version: refreshed.version || 'micro',

    isTrueMicro: isTrueMicroFamily(refreshed),
    isLegacyMacro: isLegacyMacroFamily(refreshed),

    rotationEligibilityTier: eligibilityTier,
    rotationEligible: eligibilityTier !== 'NONE',
    hardEligible: eligibilityTier === 'HARD',
    softEligible: eligibilityTier === 'SOFT',
    observationEligible: eligibilityTier === 'OBSERVATION',

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: safeNumber(refreshed.realCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrateSample: safeNumber(refreshed.winrateSample, 0),
    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    sampleWilsonLowerBound: safeNumber(
      refreshed.sampleWilsonLowerBound ?? refreshed.wilsonLowerBound,
      0
    ),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),
    sampleAdjustedWinrate: safeNumber(refreshed.sampleAdjustedWinrate, 0),
    sampleReliability: safeNumber(refreshed.sampleReliability, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    totalR: safeNumber(refreshed.totalR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(
      refreshed.dashboardBalancedScore ?? refreshed.balancedScore,
      0
    ),

    assetClass: refreshed.assetClass || null,

    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,

    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,

    obRelation: refreshed.obRelation || null,

    btcState: refreshed.btcState || null,
    btcRelation: refreshed.btcRelation || null,

    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,

    scannerReason: refreshed.scannerReason || null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,

    definitionParts: Array.isArray(refreshed.definitionParts)
      ? refreshed.definitionParts
      : [],

    definition: refreshed.definition || '',

    parentDefinitionParts: Array.isArray(refreshed.parentDefinitionParts)
      ? refreshed.parentDefinitionParts
      : [],

    parentDefinition: refreshed.parentDefinition || '',

    counters: refreshed.counters || {},
    examples: Array.isArray(refreshed.examples)
      ? refreshed.examples.slice(0, 20)
      : [],

    recentOutcomes: Array.isArray(refreshed.recentOutcomes)
      ? refreshed.recentOutcomes.slice(0, 20)
      : []
  };
}

function canUseMacroSlot({
  row,
  countsByMacro
}) {
  const macroCap = maxPerMacroFamily();

  if (macroCap <= 0) return true;

  const macroId = parentMacroFamilyId(row);

  if (!macroId) return true;

  return safeNumber(countsByMacro[macroId], 0) < macroCap;
}

function reserveMacroSlot({
  row,
  countsByMacro
}) {
  const macroId = parentMacroFamilyId(row);

  if (!macroId) return;

  countsByMacro[macroId] = safeNumber(countsByMacro[macroId], 0) + 1;
}

function addSelectedRow({
  row,
  selected,
  selectedIds,
  countsBySide,
  countsByMacro
}) {
  const id = String(row?.microFamilyId || '').trim();
  const side = microSide(row);

  if (!id) return false;
  if (selectedIds.has(id)) return false;
  if (side !== TARGET_TRADE_SIDE) return false;
  if (!canUseMacroSlot({ row, countsByMacro })) return false;

  selectedIds.add(id);
  countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0) + 1;
  reserveMacroSlot({ row, countsByMacro });
  selected.push(row);

  return true;
}

function buildSelectionState(existing = []) {
  const selected = [];
  const selectedIds = new Set();
  const countsBySide = {
    [TARGET_TRADE_SIDE]: 0
  };
  const countsByMacro = {};

  for (const row of existing) {
    addSelectedRow({
      row,
      selected,
      selectedIds,
      countsBySide,
      countsByMacro
    });
  }

  return {
    selected,
    selectedIds,
    countsBySide,
    countsByMacro
  };
}

function selectTopPerSide(ranked, topN, existing = []) {
  const safeTopN = Math.max(1, Number(topN) || 10);
  const state = buildSelectionState(existing);

  for (const row of ranked) {
    const side = microSide(row);

    if (side !== TARGET_TRADE_SIDE) continue;
    if (state.countsBySide[side] >= safeTopN) continue;

    addSelectedRow({
      row,
      selected: state.selected,
      selectedIds: state.selectedIds,
      countsBySide: state.countsBySide,
      countsByMacro: state.countsByMacro
    });
  }

  return state.selected;
}

function hasSelectedSide(rows = [], side) {
  return rows.some((row) => microSide(row) === side);
}

function missingSides(rows = []) {
  return ROTATION_SIDES.filter((side) => !hasSelectedSide(rows, side));
}

function fillMissingSide({
  selected,
  rankedRows,
  side,
  maxRows = 1
}) {
  if (side !== TARGET_TRADE_SIDE) return selected;

  const candidates = rankedRows.filter((row) => microSide(row) === side);

  if (!candidates.length) return selected;

  const state = buildSelectionState(selected);
  const targetCount = state.countsBySide[side] + Math.max(1, Math.floor(maxRows));

  for (const row of candidates) {
    if (state.countsBySide[side] >= targetCount) break;

    addSelectedRow({
      row,
      selected: state.selected,
      selectedIds: state.selectedIds,
      countsBySide: state.countsBySide,
      countsByMacro: state.countsByMacro
    });
  }

  return state.selected;
}

function selectRotationCandidates(rankedCandidates = []) {
  const shortCandidates = rankedCandidates.filter(isShortRotationRow);

  const hardEligible = shortCandidates.filter(isEligible);
  const softEligible = shortCandidates.filter(isSoftEligible);
  const observationEligible = shortCandidates.filter(isObservationEligible);

  let selected = selectTopPerSide(
    hardEligible,
    topNPerSide()
  );

  if (allowSoftRotationFallback()) {
    for (const side of missingSides(selected)) {
      selected = fillMissingSide({
        selected,
        rankedRows: softEligible,
        side,
        maxRows: 1
      });
    }
  }

  if (allowObservationRotationFallback()) {
    for (const side of missingSides(selected)) {
      selected = fillMissingSide({
        selected,
        rankedRows: observationEligible,
        side,
        maxRows: 1
      });
    }
  }

  if (selected.length === 0 && allowSoftRotationFallback()) {
    selected = selectTopPerSide(
      softEligible,
      topNPerSide()
    );
  }

  if (selected.length === 0 && allowObservationRotationFallback()) {
    selected = selectTopPerSide(
      observationEligible,
      topNPerSide()
    );
  }

  return {
    selected,
    eligible: hardEligible,
    softEligible,
    observationEligible,
    usedSoftFallback: selected.some((row) => !isEligible(row) && isSoftEligible(row)),
    usedObservationFallback: selected.some((row) => !isEligible(row) && !isSoftEligible(row) && isObservationEligible(row)),
    missingSides: missingSides(selected)
  };
}

function filterRankedRows(rows = [], filter = 'trueMicro') {
  const shortRows = rows.filter(isShortRotationRow);

  if (filter === 'all') return shortRows;
  if (filter === 'legacyMacro') return shortRows.filter(isLegacyMacroFamily);

  return shortRows.filter(isTrueMicroFamily);
}

function buildRankings(micros, { filter = 'trueMicro' } = {}) {
  const modes = [
    'balanced',
    'winrate',
    'totalR',
    'avgR',
    'directSL',
    'observed'
  ];

  return Object.fromEntries(
    modes.map((mode) => {
      const rows = filterRankedRows(rankMicros(micros, mode), filter)
        .slice(0, 50)
        .map((row, index) => compactRotationRow(row, index + 1));

      return [mode, rows];
    })
  );
}

function buildSelectionIndexes(microFamilies = []) {
  const shortRows = microFamilies.filter(isShortRotationRow);

  const microFamilyIds = uniqueStrings(
    shortRows.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = uniqueStrings(
    shortRows.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of shortRows) {
    const microId = String(row.microFamilyId || '').trim();
    const macroId = String(
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
    ).trim();

    if (!microId || !macroId) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    );
  }

  return {
    microFamilyIds,
    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,
    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function countByPredicate(micros = {}, predicate) {
  return Object.values(micros || {}).filter(predicate).length;
}

function bestShortRow(rows = []) {
  return rows.find((row) => microSide(row) === TARGET_TRADE_SIDE) || null;
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  ranked,
  eligible,
  softEligible = [],
  observationEligible = [],
  emptyReason = 'NO_SHORT_TRUE_MICRO_FAMILIES_MET_MIN_WEIGHTED_COMPLETED'
}) {
  const indexes = buildSelectionIndexes([]);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_only`),
    source: 'ANALYZE_WEEKLY_RANKING_SHORT_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: !allowLegacyMacroActivation(),
    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    missingSides: [TARGET_TRADE_SIDE],

    empty: true,
    emptyReason,

    bestLong: null,
    bestShort: null,

    microFamilyIds: indexes.microFamilyIds,
    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies: [],

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function buildRotationFromWeek({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const micros = await getWeekMicros(weekKey);

  const rankedAll = rankMicros(micros, mode).filter(isShortRotationRow);
  const rankedTrueMicros = rankedAll.filter(isTrueMicroFamily);

  let rankedCandidates = rankedTrueMicros;
  let usedLegacyFallback = false;

  if (rankedCandidates.length === 0 && allowLegacyMacroActivation()) {
    rankedCandidates = rankedAll.filter(isLegacyMacroFamily);
    usedLegacyFallback = true;
  }

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    usedSoftFallback,
    usedObservationFallback,
    missingSides: selectedMissingSides
  } = selectRotationCandidates(rankedCandidates);

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey,
      activeWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      softEligible,
      observationEligible,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_SHORT_TRUE_MICRO_FAMILIES_FOUND'
        : 'NO_SHORT_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
    });
  }

  const microFamilies = selected
    .filter(isShortRotationRow)
    .map((row, index) => compactRotationRow(row, index + 1));

  const indexes = buildSelectionIndexes(microFamilies);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_only`),
    source: 'ANALYZE_WEEKLY_RANKING_SHORT_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: !usedLegacyFallback,
    usedLegacyFallback,
    usedSoftFallback,
    usedObservationFallback,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    missingSides: selectedMissingSides,

    empty: false,
    emptyReason: null,

    bestLong: null,
    bestShort: bestShortRow(microFamilies),

    microFamilyIds: indexes.microFamilyIds,
    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function freezeWeeklyRotation({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();

  const micros = await getWeekMicros(weekKey);

  await saveWeekMicros(weekKey, micros);

  const rotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    rotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: rotation.rotationId,

      shortOnly: true,
      longDisabled: true,

      trueMicroOnly: rotation.trueMicroOnly,
      usedLegacyFallback: rotation.usedLegacyFallback,
      usedSoftFallback: rotation.usedSoftFallback,
      usedObservationFallback: rotation.usedObservationFallback,
      selectedMicroFamilies: rotation.microFamilyIds.length,
      selectedMacroFamilies: rotation.macroFamilyIds.length,
      missingSides: rotation.missingSides || [],
      bestLong: null,
      bestShort: rotation.bestShort?.microFamilyId || null
    }
  );

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_READY'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_READY',
    weekKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,

    shortOnly: true,
    longDisabled: true,

    selectedMicroFamilies: rotation.microFamilyIds.length,
    selectedMacroFamilies: rotation.macroFamilyIds.length,
    trueMicroOnly: rotation.trueMicroOnly,
    usedLegacyFallback: rotation.usedLegacyFallback,
    usedSoftFallback: rotation.usedSoftFallback,
    usedObservationFallback: rotation.usedObservationFallback,
    missingSides: rotation.missingSides || [],
    bestLong: null,
    bestShort: rotation.bestShort,
    rotation
  };
}

function sanitizeActiveRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const shortRows = rows
    .filter((row) => isShortRotationRow(row))
    .filter((row) => (
      allowLegacyMacroActivation() ||
      isTrueMicroFamily(row) ||
      isKnownTrueMicroId(row.microFamilyId)
    ))
    .map((row, index) => compactRotationRow(row, index + 1));

  const indexes = buildSelectionIndexes(shortRows);

  return {
    ...rotation,

    shortOnly: true,
    longDisabled: true,

    trueMicroOnly: !allowLegacyMacroActivation(),
    usedLegacyFallback: allowLegacyMacroActivation()
      ? Boolean(rotation.usedLegacyFallback)
      : false,

    microFamilies: shortRows,
    microFamilyIds: indexes.microFamilyIds,
    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    bestLong: null,
    bestShort: bestShortRow(shortRows),
    missingSides: missingSides(shortRows),

    empty: shortRows.length === 0,
    emptyReason: shortRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_SHORT_TRUE_MICRO_FAMILIES'
      : rotation.emptyReason || null
  };
}

export async function activateNextRotation() {
  const redis = getDurableRedis();

  const next = await getJson(
    redis,
    KEYS.analyze.nextRotation,
    null
  );

  if (!next) {
    return {
      ok: false,
      reason: 'NEXT_ROTATION_MISSING'
    };
  }

  const active = sanitizeActiveRotation({
    ...next,
    source: 'ANALYZE_NEXT_ROTATION_ACTIVATED_SHORT_ONLY',
    activatedAt: now()
  });

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  );

  await sendWeeklyRotationReport(
    active,
    'ACTIVE_ROTATION_ACTIVATED'
  ).catch(() => null);

  return {
    ok: true,
    activeRotation: active,
    rotationId: active.rotationId,
    activatedCount: active.microFamilyIds?.length || 0,
    activatedMacroCount: active.macroFamilyIds?.length || 0,

    shortOnly: true,
    longDisabled: true,

    trueMicroOnly: active.trueMicroOnly,
    usedSoftFallback: active.usedSoftFallback,
    usedObservationFallback: active.usedObservationFallback,
    missingSides: active.missingSides || [],
    bestLong: null,
    bestShort: active.bestShort
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  return await getJson(
    redis,
    KEYS.analyze.activeRotation,
    null
  );
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(active?.microFamilyIds || [])
    .filter((id) => allowLegacyMacroActivation() || isKnownTrueMicroId(id))
    .filter(idLooksLikeShortFamily);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(
    active?.macroFamilyIds ||
    active?.activeMacroFamilyIds ||
    []
  ).filter(idLooksLikeShortFamily);

  return new Set(ids);
}

function getChildrenForMacroId({ micros = {}, macroId, mode = 'balanced' }) {
  const id = String(macroId || '').trim();

  if (!id) return [];
  if (!idLooksLikeShortFamily(id)) return [];

  return rankMicros(micros, mode)
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .filter((row) => parentMacroFamilyId(row) === id);
}

function manualSideFromId(id = '') {
  const value = String(id || '').toUpperCase();

  if (idLooksLikeShortFamily(value)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank) {
  const tradeSide = manualSideFromId(id);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;

  return {
    rank,

    microFamilyId: id,
    familyId: null,

    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,

    schema: schemaMeta().microSchema,
    microFamilySchema: schemaMeta().microSchema,
    version: 'manual_true_micro',

    isTrueMicro: true,
    isLegacyMacro: false,
    manualOnly: true,
    unverifiedManualId: true,

    rotationEligibilityTier: 'MANUAL',
    rotationEligible: true,
    hardEligible: false,
    softEligible: false,
    observationEligible: false,

    seen: 0,
    observations: 0,

    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    winrateSample: 0,
    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    sampleWilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,
    sampleReliability: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    totalCostR: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    definitionParts: [],
    definition: '',

    parentDefinitionParts: [],
    parentDefinition: ''
  };
}

function resolveManualSelection({
  requestedIds = [],
  micros = {},
  mode = 'manual'
}) {
  const selectedRows = [];
  const ignoredIds = [];
  const expandedFromMacro = {};
  const seen = new Set();

  const microsByUpperId = Object.fromEntries(
    Object.values(micros || {})
      .filter(Boolean)
      .map((row) => [
        String(row.microFamilyId || row.id || '').toUpperCase(),
        row
      ])
      .filter(([id]) => Boolean(id))
  );

  const addRow = (row) => {
    const id = String(row?.microFamilyId || '').trim();

    if (!id || seen.has(id)) return;
    if (!isShortRotationRow(row)) return;

    seen.add(id);
    selectedRows.push(row);
  };

  for (const id of requestedIds) {
    if (!idLooksLikeShortFamily(id)) {
      ignoredIds.push({
        id,
        reason: 'LONG_OR_UNKNOWN_SIDE_DISABLED_IN_SHORT_ONLY_SYSTEM'
      });
      continue;
    }

    const directRow = micros[id];
    const upperRow = microsByUpperId[String(id || '').toUpperCase()];
    const row = directRow || upperRow;

    if (
      row &&
      isShortRotationRow(row) &&
      isTrueMicroFamily(row) &&
      isManualEligible(row)
    ) {
      addRow(row);
      continue;
    }

    if (
      row &&
      isShortRotationRow(row) &&
      isLegacyMacroFamily(row)
    ) {
      const children = getChildrenForMacroId({
        micros,
        macroId: id,
        mode: mode === 'manual' ? defaultRotationMode() : mode
      });

      const eligibleChildren = children.filter(isManualEligible);

      if (eligibleChildren.length === 0) {
        ignoredIds.push({
          id,
          reason: 'SHORT_MACRO_HAS_NO_ELIGIBLE_TRUE_MICRO_CHILDREN'
        });
        continue;
      }

      expandedFromMacro[id] = uniqueStrings(
        eligibleChildren.map((child) => child.microFamilyId)
      );

      for (const child of eligibleChildren) {
        addRow(child);
      }

      continue;
    }

    if (!row && isKnownTrueMicroId(id) && allowManualUnknownTrueMicroIds()) {
      const manualRow = buildManualOnlyRow(id, selectedRows.length + 1);

      if (manualRow) {
        addRow(manualRow);
        continue;
      }
    }

    ignoredIds.push({
      id,
      reason: row
        ? 'ROW_IS_NOT_SHORT_TRUE_MICRO_OR_NOT_ELIGIBLE'
        : 'UNKNOWN_OR_NON_SHORT_ID'
    });
  }

  return {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  };
}

export async function activateSelectedMicroFamilies({
  microFamilyIds = [],
  weekKey = getIsoWeekKey(),
  mode = 'manual'
} = {}) {
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);

  const requestedIds = uniqueStrings(microFamilyIds);

  const {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  } = resolveManualSelection({
    requestedIds,
    micros,
    mode
  });

  const microFamilies = selectedRows
    .filter(isShortRotationRow)
    .map((row, index) => {
      if (row.manualOnly) {
        return {
          ...row,
          rank: index + 1
        };
      }

      return compactRotationRow(row, index + 1);
    });

  const indexes = buildSelectionIndexes(microFamilies);

  const active = {
    rotationId: randomId(`ROT_${weekKey}_manual_short_only`),
    source: 'ADMIN_MANUAL_SELECTION_SHORT_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    shortOnly: true,
    longDisabled: true,

    trueMicroOnly: !allowLegacyMacroActivation(),
    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
      ? 'NO_SHORT_TRUE_MICRO_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

    bestLong: null,
    bestShort: bestShortRow(microFamilies),
    missingSides: missingSides(microFamilies),

    microFamilyIds: indexes.microFamilyIds,
    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies
  };

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  );

  return active;
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getJson(redis, KEYS.analyze.activeRotation, null),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);

  const activeRows = Array.isArray(activeRaw?.microFamilies)
    ? activeRaw.microFamilies.filter(isShortRotationRow)
    : [];

  const nextRows = Array.isArray(nextRaw?.microFamilies)
    ? nextRaw.microFamilies.filter(isShortRotationRow)
    : [];

  const active = activeRaw
    ? {
      ...activeRaw,
      shortOnly: true,
      longDisabled: true,
      bestLong: null,
      bestShort: bestShortRow(activeRows),
      microFamilies: activeRows,
      missingSides: missingSides(activeRows)
    }
    : null;

  const next = nextRaw
    ? {
      ...nextRaw,
      shortOnly: true,
      longDisabled: true,
      bestLong: null,
      bestShort: bestShortRow(nextRows),
      microFamilies: nextRows,
      missingSides: missingSides(nextRows)
    }
    : null;

  return {
    active,
    next,
    validFrom,

    activeRows,
    nextRows,

    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0,

    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},

    activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},

    bestLong: null,
    bestShort: active?.bestShort || null,
    nextBestLong: null,
    nextBestShort: next?.bestShort || null,

    missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
    nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],

    usedSoftFallback: Boolean(active?.usedSoftFallback),
    nextUsedSoftFallback: Boolean(next?.usedSoftFallback),

    usedObservationFallback: Boolean(active?.usedObservationFallback),
    nextUsedObservationFallback: Boolean(next?.usedObservationFallback),

    shortOnly: true,
    longDisabled: true
  };
}