// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const ROTATION_SIDES = [TARGET_TRADE_SIDE];

const DEFAULT_TOP_N_PER_SIDE = 1;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_WEIGHTED_COMPLETED = 0.35;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;

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
    schema: normalizeSchema(CONFIG.analyze?.schema || microSchema),
    macroSchema,
    microSchema,
    strategyVersion: CONFIG.strategyVersion
  };
}

function minWeightedCompleted() {
  return Math.max(
    0,
    safeNumber(CONFIG.rotation?.minWeightedCompleted, DEFAULT_MIN_WEIGHTED_COMPLETED)
  );
}

function topNPerSide() {
  const preferred =
    CONFIG.rotation?.topNShort ??
    CONFIG.rotation?.topNPerSide ??
    DEFAULT_TOP_N_PER_SIDE;

  const n = Math.floor(Number(preferred));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N_PER_SIDE;

  return Math.max(1, Math.min(MAX_TOP_N_PER_SIDE, n));
}

function maxPerMacroFamily() {
  if (CONFIG.rotation?.enforceMaxPerMacroFamily !== true) return 0;

  const n = Number(CONFIG.rotation?.maxPerMacroFamily || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

function minPrimaryRowsForPreviousMerge() {
  const n = Number(CONFIG.rotation?.minPrimaryRowsForPreviousMerge || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}

function defaultRotationMode() {
  return CONFIG.rotation?.mode || 'balanced';
}

function allowLegacyMacroActivation() {
  return false;
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

function allowRawRotationFallback() {
  return CONFIG.rotation?.allowRawRotationFallback !== false;
}

function rowId(row = {}) {
  return String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).toUpperCase();
}

function idLooksLikeMicroFamily(id = '') {
  return String(id || '').toUpperCase().startsWith('MICRO_');
}

function idLooksLikeLongFamily(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('LONG_') ||
    value.includes('_LONG') ||
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
  const value = String(id || '').toUpperCase();

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('SHORT_') ||
    value.includes('_SHORT') ||
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

function idLooksLikeSimpleMacroFamily(id = '') {
  return /^SHORT_\d+$/i.test(String(id || '').trim());
}

function hasSchemaInId(id, schema) {
  const s = normalizeSchema(schema);
  const value = String(id || '').toUpperCase();

  if (!s) return false;

  return (
    value.includes(`_${s}_`) ||
    value.endsWith(`_${s}`) ||
    value.includes(`|SCHEMA=${s}`) ||
    value.includes(`SCHEMA=${s}`)
  );
}

function definitionText(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');
}

function definitionHasSchema(row = {}, schema) {
  const s = normalizeSchema(schema);

  if (!s) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
    return true;
  }

  return definitionText(row).includes(`SCHEMA=${s}`);
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

function parentMacroFamilyId(row = {}) {
  const direct = String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();

  if (direct) return direct;

  const familyId = String(row.familyId || '').trim();

  if (familyId && /^SHORT_\d+$/i.test(familyId)) return familyId;

  const id = String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();

  if (idLooksLikeSimpleMacroFamily(id)) return id;

  return '';
}

function normalizeDirectSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function definitionSide(row = {}) {
  const text = definitionText(row);

  const longHit = (
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.includes('MICRO_LONG_')
  );

  const shortHit = (
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.includes('MICRO_SHORT_')
  );

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function microSide(row = {}) {
  const direct = normalizeDirectSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.entrySide ||
    row.side
  );

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const familyId = String(row.familyId || '').toUpperCase();
  const macroId = String(parentMacroFamilyId(row) || '').toUpperCase();
  const microId = rowId(row);

  if (familyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(macroId)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(microId)) return OPPOSITE_TRADE_SIDE;

  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (macroId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(macroId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(microId)) return TARGET_TRADE_SIDE;

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (fromDefinition === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

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

export function isTrueMicroFamily(row = {}) {
  const { microSchema, macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (!isShortRotationRow(row)) return false;

  if (row.isLegacyMacro === true) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO')) return false;
  if (schema === macroSchema) return false;
  if (hasSchemaInId(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (version.includes('MICRO')) return true;
  if (schema === microSchema) return true;
  if (hasSchemaInId(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (hasParentMacro(row) && idLooksLikeMicroFamily(id)) return true;

  return false;
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (!isShortRotationRow(row)) return false;
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
  const { microSchema, macroSchema } = schemaMeta();
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (!idLooksLikeShortFamily(value)) return false;
  if (idLooksLikeLongFamily(value)) return false;
  if (!idLooksLikeMicroFamily(value)) return false;
  if (hasSchemaInId(value, macroSchema)) return false;

  return hasSchemaInId(value, microSchema) || value.startsWith('MICRO_SHORT_');
}

function isEligible(row = {}) {
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return safeNumber(row.completed, 0) >= minWeightedCompleted();
}

function isSoftEligible(row = {}) {
  if (!allowSoftRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const completed = safeNumber(row.completed, 0);
  const balancedScore = safeNumber(
    row.dashboardBalancedScore ?? row.balancedScore,
    0
  );

  if (completed <= 0) return false;
  if (balancedScore <= 0) return false;

  return (
    safeNumber(row.avgR, 0) > 0 ||
    safeNumber(row.totalR, 0) > 0 ||
    safeNumber(row.fairWinrate, 0) > 0 ||
    safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
    safeNumber(row.wilsonLowerBound, 0) > 0 ||
    safeNumber(row.sampleWilsonLowerBound, 0) > 0
  );
}

function isObservationEligible(row = {}) {
  if (!allowObservationRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const seen = safeNumber(row.seen, 0);
  const observations = safeNumber(row.observations, 0);
  const winrateSample = safeNumber(row.winrateSample, 0);
  const completed = safeNumber(row.completed, 0);

  return Math.max(seen, observations, winrateSample, completed) > 0;
}

function isRawFallbackEligible(row = {}) {
  if (!allowRawRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return true;
}

function rotationEligibilityTier(row = {}) {
  if (isEligible(row)) return 'HARD';
  if (isSoftEligible(row)) return 'SOFT';
  if (isObservationEligible(row)) return 'OBSERVATION';
  if (isRawFallbackEligible(row)) return 'RAW';

  return 'NONE';
}

function isManualEligible(row = {}) {
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  if (allowManualBelowMinCompleted()) return true;

  return rotationEligibilityTier(row) !== 'NONE';
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const macroId = parentMacroFamilyId(refreshed);
  const eligibilityTier = rotationEligibilityTier(refreshed);
  const meta = schemaMeta();

  const microFamilyId = String(
    refreshed.microFamilyId ||
    refreshed.trueMicroFamilyId ||
    refreshed.id ||
    ''
  ).trim();

  return {
    rank,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId: refreshed.familyId || null,

    macroFamilyId: macroId || refreshed.macroFamilyId || null,
    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: refreshed.parentMicroFamilyId || macroId || null,

    side,
    tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    schema: refreshed.schema || refreshed.microFamilySchema || meta.microSchema,
    microFamilySchema: refreshed.microFamilySchema || refreshed.schema || meta.microSchema,
    version: refreshed.version || 'micro',

    isTrueMicro: isTrueMicroFamily(refreshed),
    isLegacyMacro: isLegacyMacroFamily(refreshed),

    rotationEligibilityTier: eligibilityTier,
    rotationEligible: eligibilityTier !== 'NONE',
    hardEligible: eligibilityTier === 'HARD',
    softEligible: eligibilityTier === 'SOFT',
    observationEligible: eligibilityTier === 'OBSERVATION',
    rawEligible: eligibilityTier === 'RAW',

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: safeNumber(refreshed.realCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrateSample: safeNumber(refreshed.winrateSample ?? refreshed.completed, 0),
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
  const id = String(row?.microFamilyId || row?.trueMicroFamilyId || row?.id || '').trim();
  const side = microSide(row);

  if (!id) return false;
  if (selectedIds.has(id)) return false;
  if (side !== TARGET_TRADE_SIDE) return false;
  if (!isTrueMicroFamily(row)) return false;
  if (!canUseMacroSlot({ row, countsByMacro })) return false;

  selectedIds.add(id);
  countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0) + 1;
  reserveMacroSlot({ row, countsByMacro });

  selected.push({
    ...row,
    microFamilyId: id,
    trueMicroFamilyId: id
  });

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

function appendRowsToSelection({
  state,
  rows = [],
  targetCount = topNPerSide()
}) {
  for (const row of rows) {
    if (state.countsBySide[TARGET_TRADE_SIDE] >= targetCount) break;

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

function selectRotationCandidates(rankedCandidates = []) {
  const trueShortCandidates = rankedCandidates
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily);

  const hardEligible = trueShortCandidates.filter(isEligible);

  const softEligible = trueShortCandidates
    .filter((row) => !isEligible(row))
    .filter(isSoftEligible);

  const observationEligible = trueShortCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter(isObservationEligible);

  const rawFallback = trueShortCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter((row) => !isObservationEligible(row))
    .filter(isRawFallbackEligible);

  const targetCount = topNPerSide();
  const state = buildSelectionState();

  appendRowsToSelection({
    state,
    rows: hardEligible,
    targetCount
  });

  if (allowSoftRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: softEligible,
      targetCount
    });
  }

  if (allowObservationRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: observationEligible,
      targetCount
    });
  }

  if (allowRawRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: rawFallback,
      targetCount
    });
  }

  return {
    selected: state.selected,
    eligible: hardEligible,
    softEligible,
    observationEligible,
    rawFallback,

    usedSoftFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'SOFT'),
    usedObservationFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'OBSERVATION'),
    usedRawFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'RAW'),

    missingSides: missingSides(state.selected)
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
        .slice(0, MAX_TOP_N_PER_SIDE)
        .map((row, index) => compactRotationRow(row, index + 1));

      return [mode, rows];
    })
  );
}

function buildSelectionIndexes(microFamilies = []) {
  const shortRows = microFamilies
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily);

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
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

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

function mergeMicros(primary = {}, fallback = {}) {
  return {
    ...(fallback || {}),
    ...(primary || {})
  };
}

async function getRotationMicros(weekKey = getIsoWeekKey()) {
  const primary = await getWeekMicros(weekKey);
  const primaryRows = Object.keys(primary || {}).length;

  const previousWeekKey = getPreviousIsoWeekKey();
  const shouldMergePrevious =
    weekKey !== previousWeekKey &&
    primaryRows < minPrimaryRowsForPreviousMerge();

  if (!shouldMergePrevious) {
    return {
      micros: primary || {},
      primaryWeekKey: weekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false
    };
  }

  const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
  const previousRows = Object.keys(previous || {}).length;

  if (previousRows <= 0) {
    return {
      micros: primary || {},
      primaryWeekKey: weekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false
    };
  }

  return {
    micros: mergeMicros(primary, previous),
    primaryWeekKey: weekKey,
    previousWeekKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge: true
  };
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
  rawFallback = [],
  usedPreviousWeekMerge = false,
  primaryRows = 0,
  previousRows = 0,
  emptyReason = 'NO_SHORT_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
}) {
  const indexes = buildSelectionIndexes([]);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_only`),
    source: 'ANALYZE_WEEKLY_RANKING_SHORT_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,
    usedRawFallback: false,
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: [TARGET_TRADE_SIDE],

    empty: true,
    emptyReason,

    bestLong: null,
    bestShort: null,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

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
  const {
    micros,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge
  } = await getRotationMicros(weekKey);

  const rankedAll = rankMicros(micros, mode)
    .filter(isShortRotationRow);

  const rankedTrueMicros = rankedAll
    .filter(isTrueMicroFamily);

  const rankedCandidates = rankedTrueMicros;

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    rawFallback,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
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
      rawFallback,
      usedPreviousWeekMerge,
      primaryRows,
      previousRows,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_SHORT_TRUE_MICRO_FAMILIES_FOUND'
        : 'NO_SHORT_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
    });
  }

  const microFamilies = selected
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId);

  const indexes = buildSelectionIndexes(microFamilies);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_only`),
    source: 'ANALYZE_WEEKLY_RANKING_SHORT_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: selectedMissingSides,

    empty: false,
    emptyReason: null,

    bestLong: null,
    bestShort: bestShortRow(microFamilies),

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

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

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      trueMicroOnly: true,

      usedLegacyFallback: false,
      usedSoftFallback: rotation.usedSoftFallback,
      usedObservationFallback: rotation.usedObservationFallback,
      usedRawFallback: rotation.usedRawFallback,
      usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,

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

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,

    selectedMicroFamilies: rotation.microFamilyIds.length,
    selectedMacroFamilies: rotation.macroFamilyIds.length,

    usedLegacyFallback: false,
    usedSoftFallback: rotation.usedSoftFallback,
    usedObservationFallback: rotation.usedObservationFallback,
    usedRawFallback: rotation.usedRawFallback,
    usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,

    missingSides: rotation.missingSides || [],
    bestLong: null,
    bestShort: rotation.bestShort,
    rotation
  };
}

function sanitizeActiveRotation(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') return null;

  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const shortRows = rows
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId);

  const indexes = buildSelectionIndexes(shortRows);

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    usedLegacyFallback: false,

    microFamilies: shortRows,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

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
      : null
  };
}

async function autoBootstrapActiveRotation(redis) {
  const weekKey = getIsoWeekKey();

  const rotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey: weekKey,
    mode: defaultRotationMode()
  }).catch(() => null);

  if (!rotation || rotation.empty || !rotation.microFamilyIds?.length) {
    return null;
  }

  const active = sanitizeActiveRotation({
    ...rotation,
    source: 'AUTO_BOOTSTRAP_ACTIVE_ROTATION_SHORT_TRUE_MICRO_ONLY',
    activeWeekKey: weekKey,
    activatedAt: now(),
    autoBootstrapped: true
  });

  if (!active || active.empty) return null;

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  ).catch(() => null);

  return active;
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
    source: 'ANALYZE_NEXT_ROTATION_ACTIVATED_SHORT_TRUE_MICRO_ONLY',
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
    activatedMicroCount: active.microFamilyIds?.length || 0,
    activatedMacroCount: active.macroFamilyIds?.length || 0,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,

    usedSoftFallback: active.usedSoftFallback,
    usedObservationFallback: active.usedObservationFallback,
    usedRawFallback: active.usedRawFallback,
    usedPreviousWeekMerge: active.usedPreviousWeekMerge,

    missingSides: active.missingSides || [],
    bestLong: null,
    bestShort: active.bestShort
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  const raw = await getJson(
    redis,
    KEYS.analyze.activeRotation,
    null
  );

  const sanitized = sanitizeActiveRotation(raw);

  if (sanitized && !sanitized.empty && sanitized.microFamilyIds?.length) {
    if (
      raw?.longOnly === true ||
      raw?.shortDisabled === true ||
      raw?.targetTradeSide === 'LONG' ||
      raw?.dashboardSide === 'bull'
    ) {
      await setJson(
        redis,
        KEYS.analyze.activeRotation,
        sanitized
      ).catch(() => null);
    }

    return sanitized;
  }

    // Puur-handmatig: nooit zelf activeren. Geen handmatige keuze = leeg = puur shadow, geen Discord.
  return null;

}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(
    active?.activeMicroFamilyIds ||
    active?.trueMicroFamilyIds ||
    active?.microFamilyIds ||
    []
  )
    .filter(isKnownTrueMicroId)
    .filter(idLooksLikeShortFamily);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(
    active?.activeMacroFamilyIds ||
    active?.macroFamilyIds ||
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

  if (idLooksLikeLongFamily(value)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(value)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank) {
  const tradeSide = manualSideFromId(id);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isKnownTrueMicroId(id)) return null;

  return {
    rank,

    microFamilyId: id,
    trueMicroFamilyId: id,
    familyId: null,

    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

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
    rawEligible: false,

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
        String(row.microFamilyId || row.trueMicroFamilyId || row.id || '').toUpperCase(),
        row
      ])
      .filter(([id]) => Boolean(id))
  );

  const addRow = (row) => {
    const id = String(row?.microFamilyId || row?.trueMicroFamilyId || row?.id || '').trim();

    if (!id || seen.has(id)) return;
    if (!isShortRotationRow(row)) return;
    if (!isTrueMicroFamily(row)) return;

    seen.add(id);
    selectedRows.push({
      ...row,
      microFamilyId: id,
      trueMicroFamilyId: id
    });
  };

  for (const id of requestedIds) {
    if (!idLooksLikeShortFamily(id) || idLooksLikeLongFamily(id)) {
      ignoredIds.push({
        id,
        reason: 'LONG_OR_UNKNOWN_SIDE_DISABLED_IN_SHORT_ONLY_SYSTEM'
      });
      continue;
    }

    const children = getChildrenForMacroId({
      micros,
      macroId: id,
      mode: mode === 'manual' ? defaultRotationMode() : mode
    }).filter(isManualEligible);

    if (children.length > 0) {
      expandedFromMacro[id] = uniqueStrings(
        children.map((child) => child.microFamilyId)
      );

      for (const child of children) {
        addRow(child);
      }

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
        : 'UNKNOWN_SHORT_TRUE_MICRO_OR_MACRO_WITHOUT_CHILDREN'
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

  const {
    micros,
    usedPreviousWeekMerge,
    primaryRows,
    previousRows
  } = await getRotationMicros(weekKey);

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
    .filter(isTrueMicroFamily)
    .map((row, index) => {
      if (row.manualOnly) {
        return {
          ...row,
          rank: index + 1
        };
      }

      return compactRotationRow(row, index + 1);
    })
    .filter((row) => row.microFamilyId);

  const indexes = buildSelectionIndexes(microFamilies);

  const active = {
    rotationId: randomId(`ROT_${weekKey}_manual_short_only`),
    source: 'ADMIN_MANUAL_SELECTION_SHORT_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,

    usedLegacyFallback: false,
    usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'SOFT'),
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),
    usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'RAW'),
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    primaryRows,
    previousRows,

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
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

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

function sanitizeDashboardRotation(rotation) {
  return sanitizeActiveRotation(rotation);
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getActiveRotation(),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);

  const active = sanitizeDashboardRotation(activeRaw);
  const next = sanitizeDashboardRotation(nextRaw);

  const activeRows = Array.isArray(active?.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next?.microFamilies)
    ? next.microFamilies
    : [];

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

    usedRawFallback: Boolean(active?.usedRawFallback),
    nextUsedRawFallback: Boolean(next?.usedRawFallback),

    usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
    nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true
  };
}