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

function now() {
  return Date.now();
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
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

function rowId(row = {}) {
  return String(row.microFamilyId || row.id || '').toUpperCase();
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

export function isTrueMicroFamily(row = {}) {
  const { microSchema, macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (version.includes('MACRO')) return false;

  if (schema === microSchema) return true;
  if (hasSchemaInId(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (schema === macroSchema) return false;
  if (hasSchemaInId(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return Boolean(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId
  );
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isTrueMicroFamily(row)) return false;

  if (version.includes('MACRO')) return true;
  if (schema === macroSchema) return true;
  if (hasSchemaInId(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return !row.parentMacroFamilyId && !row.parentMicroFamilyId;
}

function isKnownTrueMicroId(id = '') {
  const { microSchema, macroSchema } = schemaMeta();
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (hasSchemaInId(value, macroSchema)) return false;

  return hasSchemaInId(value, microSchema);
}

function parentMacroFamilyId(row = {}) {
  return String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();
}

function microSide(row = {}) {
  const direct = sideToTradeSide(row.tradeSide || row.side);

  if (direct !== 'UNKNOWN') return direct;

  const familyId = String(row.familyId || '').toUpperCase();

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  const microId = String(row.microFamilyId || '').toUpperCase();

  if (microId.includes('MICRO_LONG_')) return 'LONG';
  if (microId.includes('MICRO_SHORT_')) return 'SHORT';

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  const side = microSide(row);

  if (side === 'LONG') return 'bull';
  if (side === 'SHORT') return 'bear';

  return String(row.side || 'unknown').toLowerCase();
}

function isEligible(row = {}) {
  return safeNumber(row.completed, 0) >= minWeightedCompleted();
}

function isManualEligible(row = {}) {
  if (allowManualBelowMinCompleted()) return true;

  return isEligible(row);
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const macroId = parentMacroFamilyId(refreshed);

  return {
    rank,

    microFamilyId: refreshed.microFamilyId,
    familyId: refreshed.familyId,

    macroFamilyId: macroId || refreshed.macroFamilyId || null,
    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: refreshed.parentMicroFamilyId || macroId || null,

    side,
    tradeSide,

    schema: refreshed.schema || refreshed.microFamilySchema || schemaMeta().microSchema,
    microFamilySchema: refreshed.microFamilySchema || refreshed.schema || schemaMeta().microSchema,
    version: refreshed.version || 'micro',

    isTrueMicro: isTrueMicroFamily(refreshed),
    isLegacyMacro: isLegacyMacroFamily(refreshed),

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

function selectTopPerSide(ranked, topN) {
  const safeTopN = Math.max(1, Number(topN) || 10);
  const macroCap = maxPerMacroFamily();

  const countsBySide = {
    LONG: 0,
    SHORT: 0
  };

  const countsByMacro = {};
  const selected = [];

  for (const row of ranked) {
    const side = microSide(row);

    if (!['LONG', 'SHORT'].includes(side)) continue;
    if (countsBySide[side] >= safeTopN) continue;

    const macroId = parentMacroFamilyId(row);

    if (macroCap > 0 && macroId) {
      const macroCount = countsByMacro[macroId] || 0;

      if (macroCount >= macroCap) continue;

      countsByMacro[macroId] = macroCount + 1;
    }

    countsBySide[side] += 1;
    selected.push(row);
  }

  return selected;
}

function filterRankedRows(rows = [], filter = 'trueMicro') {
  if (filter === 'all') return rows;
  if (filter === 'legacyMacro') return rows.filter(isLegacyMacroFamily);

  return rows.filter(isTrueMicroFamily);
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
  const microFamilyIds = uniqueStrings(
    microFamilies.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = uniqueStrings(
    microFamilies.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of microFamilies) {
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

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  ranked,
  eligible,
  emptyReason = 'NO_TRUE_MICRO_FAMILIES_MET_MIN_WEIGHTED_COMPLETED'
}) {
  const indexes = buildSelectionIndexes([]);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}`),
    source: 'ANALYZE_WEEKLY_RANKING',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    trueMicroOnly: !allowLegacyMacroActivation(),
    usedLegacyFallback: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, isTrueMicroFamily),
    legacyMacroCount: countByPredicate(micros, isLegacyMacroFamily),

    empty: true,
    emptyReason,

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

  const rankedAll = rankMicros(micros, mode);
  const rankedTrueMicros = rankedAll.filter(isTrueMicroFamily);

  let rankedCandidates = rankedTrueMicros;
  let usedLegacyFallback = false;

  if (rankedCandidates.length === 0 && allowLegacyMacroActivation()) {
    rankedCandidates = rankedAll.filter(isLegacyMacroFamily);
    usedLegacyFallback = true;
  }

  const eligible = rankedCandidates.filter(isEligible);
  const selected = selectTopPerSide(eligible, topNPerSide());

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey,
      activeWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_TRUE_MICRO_FAMILIES_FOUND'
        : 'NO_TRUE_MICRO_FAMILIES_MET_MIN_WEIGHTED_COMPLETED'
    });
  }

  const microFamilies = selected.map((row, index) => (
    compactRotationRow(row, index + 1)
  ));

  const indexes = buildSelectionIndexes(microFamilies);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}`),
    source: 'ANALYZE_WEEKLY_RANKING',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    trueMicroOnly: !usedLegacyFallback,
    usedLegacyFallback,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, isTrueMicroFamily),
    legacyMacroCount: countByPredicate(micros, isLegacyMacroFamily),

    empty: false,
    emptyReason: null,

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

  // Force refresh current week stats before building next rotation.
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
      trueMicroOnly: rotation.trueMicroOnly,
      usedLegacyFallback: rotation.usedLegacyFallback,
      selectedMicroFamilies: rotation.microFamilyIds.length,
      selectedMacroFamilies: rotation.macroFamilyIds.length
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
    selectedMicroFamilies: rotation.microFamilyIds.length,
    selectedMacroFamilies: rotation.macroFamilyIds.length,
    trueMicroOnly: rotation.trueMicroOnly,
    usedLegacyFallback: rotation.usedLegacyFallback,
    rotation
  };
}

function sanitizeActiveRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  if (allowLegacyMacroActivation()) {
    const indexes = buildSelectionIndexes(rows);

    return {
      ...rotation,
      ...indexes
    };
  }

  const trueRows = rows.filter((row) => (
    isTrueMicroFamily(row) ||
    isKnownTrueMicroId(row.microFamilyId)
  ));

  const indexes = buildSelectionIndexes(trueRows);

  return {
    ...rotation,

    trueMicroOnly: true,
    usedLegacyFallback: false,

    microFamilies: trueRows,
    microFamilyIds: indexes.microFamilyIds,
    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,
    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    empty: trueRows.length === 0,
    emptyReason: trueRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_TRUE_MICRO_FAMILIES'
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
    source: 'ANALYZE_NEXT_ROTATION_ACTIVATED',
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
    trueMicroOnly: active.trueMicroOnly
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
    .filter((id) => allowLegacyMacroActivation() || isKnownTrueMicroId(id));

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(
    active?.macroFamilyIds ||
    active?.activeMacroFamilyIds ||
    []
  );

  return new Set(ids);
}

function getChildrenForMacroId({ micros = {}, macroId, mode = 'balanced' }) {
  const id = String(macroId || '').trim();

  if (!id) return [];

  return rankMicros(micros, mode)
    .filter(isTrueMicroFamily)
    .filter((row) => parentMacroFamilyId(row) === id);
}

function buildManualOnlyRow(id, rank) {
  return {
    rank,

    microFamilyId: id,
    familyId: null,

    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    side: null,
    tradeSide: null,

    schema: schemaMeta().microSchema,
    microFamilySchema: schemaMeta().microSchema,
    version: 'manual_true_micro',

    isTrueMicro: true,
    isLegacyMacro: false,
    manualOnly: true,
    unverifiedManualId: true,

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

  const addRow = (row) => {
    const id = String(row?.microFamilyId || '').trim();

    if (!id || seen.has(id)) return;

    seen.add(id);
    selectedRows.push(row);
  };

  for (const id of requestedIds) {
    const row = micros[id];

    if (row && isTrueMicroFamily(row) && isManualEligible(row)) {
      addRow(row);
      continue;
    }

    if (row && isLegacyMacroFamily(row)) {
      const children = getChildrenForMacroId({
        micros,
        macroId: id,
        mode: mode === 'manual' ? defaultRotationMode() : mode
      });

      const eligibleChildren = children.filter(isManualEligible);

      if (eligibleChildren.length === 0) {
        ignoredIds.push({
          id,
          reason: 'MACRO_HAS_NO_ELIGIBLE_TRUE_MICRO_CHILDREN'
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
      addRow(buildManualOnlyRow(id, selectedRows.length + 1));
      continue;
    }

    ignoredIds.push({
      id,
      reason: row
        ? 'ROW_IS_NOT_TRUE_MICRO_OR_NOT_ELIGIBLE'
        : 'UNKNOWN_OR_LEGACY_ID'
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

  const microFamilies = selectedRows.map((row, index) => {
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
    rotationId: randomId(`ROT_${weekKey}_manual`),
    source: 'ADMIN_MANUAL_SELECTION',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    trueMicroOnly: !allowLegacyMacroActivation(),
    usedLegacyFallback: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
      ? 'NO_TRUE_MICRO_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

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

  const [active, next, validFrom] = await Promise.all([
    getJson(redis, KEYS.analyze.activeRotation, null),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);

  return {
    active,
    next,
    validFrom,

    activeRows: active?.microFamilies || [],
    nextRows: next?.microFamilies || [],

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
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {}
  };
}