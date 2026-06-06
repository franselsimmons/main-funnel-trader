// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  fetchCandles,
  fetchFunding,
  fetchOrderBook,
  analyzeOrderBook
} from '../market/bitgetClient.js';
import {
  analyzeCandidatesBatch,
  createShadowPosition,
  buildOutcomeFromPosition,
  recordOutcome
} from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildRiskAndLiveMetricsForBothSides
} from './riskEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  getOpenPosition,
  saveOpenPosition,
  monitorOpenPositions,
  updatePathMetrics
} from './positionEngine.js';
import {
  riskFractionForEntry,
  checkRiskCaps
} from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 300;
const SNAPSHOT_SEARCH_LIMIT = 80;

const VALID_TRADE_SIDES = new Set(['LONG', 'SHORT']);
const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

function now() {
  return Date.now();
}

function cfgNumber(value, fallback) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function cfgBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(cfgNumber(value, fallback));

  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) return min;

  return Math.max(min, Math.min(max, n));
}

function tradeConfig() {
  const configuredTradeMax = cfgNumber(CONFIG.trade?.maxCandidatesPerSnapshot, 0);
  const configuredAnalyzeMax = cfgNumber(
    CONFIG.trade?.analyzeMaxCandidatesPerSnapshot ??
    CONFIG.trade?.maxAnalyzeCandidatesPerSnapshot ??
    CONFIG.scanner?.maxCandidates ??
    CONFIG.scanner?.analyzeMaxCandidates,
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT
  );

  const maxCandidatesPerSnapshot = positiveInt(
    Math.max(configuredTradeMax, configuredAnalyzeMax, DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT),
    DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
    1,
    1000
  );

  return {
    maxCandidatesPerSnapshot,

    maxSnapshotAgeSec: cfgNumber(CONFIG.trade?.maxSnapshotAgeSec, 8 * 60),

    dataConcurrency: positiveInt(
      CONFIG.trade?.dataConcurrency,
      8,
      1,
      20
    ),

    maxOpenPositions: positiveInt(
      CONFIG.trade?.maxOpenPositions,
      30
    ),

    maxOpenSameSide: positiveInt(
      CONFIG.trade?.maxOpenSameSide,
      30
    ),

    maxSpreadPct: cfgNumber(CONFIG.trade?.maxSpreadPct, 0.0015),

    candleTtlSec: positiveInt(
      CONFIG.trade?.candleTtlSec,
      90
    ),

    orderbookTtlSec: positiveInt(
      CONFIG.trade?.orderbookTtlSec,
      12
    ),

    fundingTtlSec: positiveInt(
      CONFIG.trade?.fundingTtlSec,
      120
    ),

    requireScannerGateForLiveEntries: CONFIG.trade?.requireScannerGateForLiveEntries !== false,

    blockDiscoveryOnlyLiveEntries: CONFIG.trade?.blockDiscoveryOnlyLiveEntries !== false,

    allowFakeBreakoutLiveEntries: cfgBoolean(
      CONFIG.trade?.allowFakeBreakoutLiveEntries,
      false
    ),

    allowLowConfidenceLiveEntries: cfgBoolean(
      CONFIG.trade?.allowLowConfidenceLiveEntries,
      false
    ),

    allowSyntheticRiskFallback: cfgBoolean(
      CONFIG.trade?.allowSyntheticRiskFallback,
      false
    ),

    allowSyntheticRiskLiveEntries: cfgBoolean(
      CONFIG.trade?.allowSyntheticRiskLiveEntries,
      false
    ),

    minLiveScannerScore: Math.max(
      0,
      cfgNumber(CONFIG.trade?.minLiveScannerScore, 0)
    ),

    minRiskPct: cfgNumber(CONFIG.trade?.minRiskPct, 0.004),
    maxRiskPct: cfgNumber(CONFIG.trade?.maxRiskPct, 0.025),
    fallbackRiskPct: cfgNumber(CONFIG.trade?.fallbackRiskPct, 0.005),
    defaultRR: cfgNumber(CONFIG.trade?.defaultRR, 1.5)
  };
}

function analyzeConfig() {
  return {
    shadowEnabled: CONFIG.analyze?.shadowEnabled !== false,
    shadowHorizonMin: cfgNumber(CONFIG.analyze?.shadowHorizonMin, 6 * 60),

    maxShadowMonitorsPerRun: positiveInt(
      CONFIG.analyze?.maxShadowMonitorsPerRun,
      80
    )
  };
}

function sizingConfig() {
  return {
    enabled: CONFIG.sizing?.enabled !== false,
    baseRiskPct: cfgNumber(CONFIG.sizing?.baseRiskPct, 0.0025)
  };
}

function schemaConfig() {
  const macroSchema = String(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    'MF_V1'
  ).toUpperCase();

  const microSchema = String(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  ).toUpperCase();

  const currentSchema = String(
    CONFIG.analyze?.schema ||
    microSchema
  ).toUpperCase();

  return {
    currentSchema,
    macroSchema,
    microSchema
  };
}

function allowLegacyMacroLiveEntries() {
  return Boolean(CONFIG.trade?.allowLegacyMacroLiveEntries);
}

function allowCoarseMicroAliasLiveEntries() {
  return Boolean(CONFIG.trade?.allowCoarseMicroAliasLiveEntries);
}

function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol
  );

  const symbol =
    normalizeBaseSymbol(candidate.symbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

  return {
    ...candidate,
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}

function normalizeTradeSide(side) {
  const direct = sideToTradeSide(side);

  if (VALID_TRADE_SIDES.has(direct)) return direct;

  const raw = String(side || '').trim().toUpperCase();

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function isTargetSide(side) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

function idLooksLikeTargetFamily(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('SHORT') ||
    value.includes('BEAR') ||
    value.includes('SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('MICRO_SHORT_')
  );
}

function idLooksLikeOppositeFamily(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('LONG') ||
    value.includes('BULL') ||
    value.includes('BUY') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('MICRO_LONG_')
  );
}

function inferSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (idLooksLikeTargetFamily(haystack)) return TARGET_TRADE_SIDE;
  if (idLooksLikeOppositeFamily(haystack)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferSideFromDefinitions(row = {}) {
  const haystack = [
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

  if (!haystack) return 'UNKNOWN';

  if (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY')
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide
  );

  if (VALID_TRADE_SIDES.has(direct)) return direct;

  const fromIds = inferSideFromIds(row);

  if (VALID_TRADE_SIDES.has(fromIds)) return fromIds;

  return inferSideFromDefinitions(row);
}

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShort(side) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

function isMirrorAnalysisRow(row = {}) {
  return Boolean(
    row.isMirrorMicroFamily ||
    row.observationMirror ||
    row.analysisMirror ||
    row.mirrorAnalysisOnly
  );
}

function isLiveScannerRow(row = {}) {
  return !isMirrorAnalysisRow(row);
}

function buildAnalysisVariant(candidate = {}, side, scannerSide) {
  const tradeSide = normalizeTradeSide(side);
  const actualScannerSide = normalizeTradeSide(scannerSide);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (actualScannerSide !== TARGET_TRADE_SIDE) return null;

  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    actualScannerSide: TARGET_TRADE_SIDE,
    scannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    analyzeOnly: Boolean(candidate.analyzeOnly),
    discoveryOnly: Boolean(candidate.discoveryOnly),
    tradeDiscoveryOnly: Boolean(candidate.tradeDiscoveryOnly),

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function waitAction(candidate, reason, extra = {}) {
  const tradeSide = inferRowTradeSide(candidate);

  return {
    action: 'WAIT',
    reason,
    symbol: candidate?.symbol || null,
    contractSymbol: candidate?.contractSymbol || null,
    side: tradeSide === TARGET_TRADE_SIDE ? TARGET_DASHBOARD_SIDE : candidate?.side || null,
    tradeSide,
    snapshotId: candidate?.snapshotId || null,
    scannerScore: candidate?.scannerScore ?? candidate?.moveScore ?? null,
    isMirrorMicroFamily: Boolean(candidate?.isMirrorMicroFamily),
    observationMirror: Boolean(candidate?.observationMirror),
    liveEligible: false,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    ...extra
  };
}

function idHasSchema(id, schema) {
  const value = String(id || '').toUpperCase();
  const target = String(schema || '').toUpperCase();

  if (!value || !target) return false;

  return value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`);
}

function definitionHasSchema(row = {}, schema) {
  const target = String(schema || '').toUpperCase();

  if (!target) return false;

  const parts = Array.isArray(row.definitionParts)
    ? row.definitionParts
    : [];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${target}`)) {
    return true;
  }

  return String(row.definition || '').toUpperCase().includes(`SCHEMA=${target}`);
}

function rowSchema(row = {}) {
  return String(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  ).toUpperCase();
}

function rowMicroId(row = {}) {
  return String(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function parentMacroFamilyId(row = {}) {
  return String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();
}

function rowMicroAliasIds(row = {}, { includeCoarse = false } = {}) {
  const base = [
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key
  ];

  const coarse = includeCoarse
    ? [
      row.coarseMicroFamilyId,
      row.baseMicroFamilyId,
      row.legacyMicroFamilyId
    ]
    : [];

  return uniqueStrings([
    ...base,
    ...coarse
  ]).filter(idLooksLikeTargetFamily);
}

function isTrueMicroFamilyRow(row = {}) {
  const { microSchema, macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (!isTargetRow(row) && !idLooksLikeTargetFamily(id)) return false;
  if (version.includes('MACRO')) return false;

  if (row.isTrueMicro === true) return true;
  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (row.isLegacyMacro === true) return false;
  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return Boolean(parentMacroFamilyId(row));
}

function isLegacyMacroFamilyRow(row = {}) {
  const { macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (!isTargetRow(row) && !idLooksLikeTargetFamily(id)) return false;
  if (isTrueMicroFamilyRow(row)) return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (schema === macroSchema) return true;
  if (idHasSchema(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return !parentMacroFamilyId(row);
}

function isKnownTrueMicroFamilyId(id = '') {
  const { microSchema, macroSchema } = schemaConfig();

  if (!id) return false;
  if (!idLooksLikeTargetFamily(id)) return false;
  if (idHasSchema(id, macroSchema)) return false;

  return idHasSchema(id, microSchema) || String(id).toUpperCase().startsWith('MICRO_SHORT_');
}

function addRowAliasesToMaps({
  row,
  rowByMicroId,
  rowByAnyMicroId,
  includeCoarseAliases = false
}) {
  if (!row) return;

  const exactId = rowMicroId(row);

  if (exactId) {
    rowByMicroId.set(exactId, row);
    rowByAnyMicroId.set(exactId, row);
  }

  for (const aliasId of rowMicroAliasIds(row, { includeCoarse: includeCoarseAliases })) {
    if (!aliasId) continue;

    rowByAnyMicroId.set(aliasId, row);
  }
}

function buildActiveRotationContext(activeRotation) {
  const includeCoarseAliases = allowCoarseMicroAliasLiveEntries();

  const rawRows = Array.isArray(activeRotation?.microFamilies)
    ? activeRotation.microFamilies
    : [];

  const rows = rawRows.filter((row) => (
    isTargetRow(row) ||
    idLooksLikeTargetFamily(rowMicroId(row)) ||
    idLooksLikeTargetFamily(parentMacroFamilyId(row))
  ));

  const rowByMicroId = new Map();
  const rowByAnyMicroId = new Map();

  for (const row of rows) {
    addRowAliasesToMaps({
      row,
      rowByMicroId,
      rowByAnyMicroId,
      includeCoarseAliases
    });
  }

  const configuredIds = uniqueStrings([
    ...(Array.isArray(activeRotation?.microFamilyIds) ? activeRotation.microFamilyIds : []),
    ...(Array.isArray(activeRotation?.activeMicroFamilyIds) ? activeRotation.activeMicroFamilyIds : []),
    ...(Array.isArray(activeRotation?.trueMicroFamilyIds) ? activeRotation.trueMicroFamilyIds : []),
    ...(Array.isArray(activeRotation?.ids) ? activeRotation.ids : []),
    ...rows.map(rowMicroId)
  ]);

  const activeMicroFamilyIds = configuredIds.filter((id) => {
    if (!idLooksLikeTargetFamily(id)) return false;

    const row = rowByAnyMicroId.get(id) || rowByMicroId.get(id);

    if (allowLegacyMacroLiveEntries()) return true;
    if (row && isTrueMicroFamilyRow(row)) return true;

    return isKnownTrueMicroFamilyId(id);
  });

  const activeMicroSet = new Set(activeMicroFamilyIds);

  const activeMicroAliasIds = uniqueStrings([
    ...activeMicroFamilyIds,
    ...rows.flatMap((row) => {
      const exact = rowMicroId(row);

      if (!exact || !activeMicroSet.has(exact)) return [];

      return rowMicroAliasIds(row, {
        includeCoarse: includeCoarseAliases
      });
    })
  ]);

  const activeMicroAliasSet = new Set(activeMicroAliasIds);

  const activeMacroFamilyIds = uniqueStrings([
    ...(Array.isArray(activeRotation?.macroFamilyIds) ? activeRotation.macroFamilyIds : []),
    ...(Array.isArray(activeRotation?.activeMacroFamilyIds) ? activeRotation.activeMacroFamilyIds : []),
    ...(Array.isArray(activeRotation?.macroIds) ? activeRotation.macroIds : []),
    ...rows.map(parentMacroFamilyId)
  ]).filter(idLooksLikeTargetFamily);

  const activeMacroSet = new Set(activeMacroFamilyIds);

  const macroToMicroFamilyIds = {
    ...(activeRotation?.macroToMicroFamilyIds || {})
  };

  const microToMacroFamilyId = {
    ...(activeRotation?.microToMacroFamilyId || {})
  };

  for (const row of rows) {
    const microId = rowMicroId(row);
    const macroId = parentMacroFamilyId(row);

    if (!microId || !macroId) continue;
    if (!idLooksLikeTargetFamily(microId) || !idLooksLikeTargetFamily(macroId)) continue;

    microToMacroFamilyId[microId] ||= macroId;

    for (const aliasId of rowMicroAliasIds(row, { includeCoarse: includeCoarseAliases })) {
      microToMacroFamilyId[aliasId] ||= macroId;
    }

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    ).filter(idLooksLikeTargetFamily);
  }

  return {
    rotationId: activeRotation?.rotationId || null,
    activeRotation: activeRotation || null,

    activeMicroFamilyIds,
    activeMicroSet,
    activeMicroAliasIds,
    activeMicroAliasSet,

    activeMacroFamilyIds,
    activeMacroSet,

    rowByMicroId,
    rowByAnyMicroId,

    microToMacroFamilyId,
    macroToMicroFamilyIds,

    trueMicroOnly: activeRotation?.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation?.usedLegacyFallback),
    allowCoarseMicroAliasLiveEntries: includeCoarseAliases,

    empty: !activeMicroFamilyIds.length,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function getWeeklyStats(activeContext, microFamilyId, row = {}) {
  if (!activeContext) return null;

  const directId = String(microFamilyId || '').trim();

  if (directId) {
    const direct = activeContext.rowByMicroId.get(directId) ||
      activeContext.rowByAnyMicroId.get(directId);

    if (direct) return direct;
  }

  for (const aliasId of rowMicroAliasIds(row, {
    includeCoarse: activeContext.allowCoarseMicroAliasLiveEntries
  })) {
    const stats = activeContext.rowByAnyMicroId.get(aliasId);

    if (stats) return stats;
  }

  return null;
}

function hasActiveParentMacro(activeContext, row = {}) {
  const macroId = parentMacroFamilyId(row);

  if (!macroId) return false;

  return activeContext?.activeMacroSet?.has(macroId) || false;
}

function rowMatchesActiveMicro(activeContext, row = {}) {
  if (!activeContext || activeContext.empty) return false;

  const aliases = rowMicroAliasIds(row, {
    includeCoarse: activeContext.allowCoarseMicroAliasLiveEntries
  });

  return aliases.some((id) => (
    activeContext.activeMicroSet.has(id) ||
    activeContext.activeMicroAliasSet.has(id)
  ));
}

function buildRotationWaitReason(activeContext, row = {}) {
  if (!isTargetRow(row)) {
    return 'LONG_DISABLED_SHORT_ONLY_SYSTEM';
  }

  if (!activeContext || activeContext.empty) {
    return 'ACTIVE_SHORT_ROTATION_EMPTY';
  }

  if (!allowLegacyMacroLiveEntries() && !isTrueMicroFamilyRow(row)) {
    return isLegacyMacroFamilyRow(row)
      ? 'LEGACY_MACRO_FAMILY_NOT_TRADEABLE'
      : 'LIVE_ROW_NOT_TRUE_MICRO_FAMILY';
  }

  if (hasActiveParentMacro(activeContext, row)) {
    return 'PARENT_MACRO_ACTIVE_BUT_TRUE_MICRO_NOT_ACTIVE';
  }

  return 'SHORT_TRUE_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION';
}

function scannerGatePassed(row = {}) {
  if (row.scannerGatePassed === undefined || row.scannerGatePassed === null) {
    return true;
  }

  return Boolean(row.scannerGatePassed);
}

function isDiscoveryOnly(row = {}) {
  return Boolean(row.tradeDiscoveryOnly || row.discoveryOnly || row.analyzeOnly);
}

function hasValidRiskShape(row = {}) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);
  const tradeSide = inferRowTradeSide(row);

  if (row.liveRiskValid === false) return false;
  if (row.learningOnly === true) return false;

  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  if (tradeSide === TARGET_TRADE_SIDE) {
    return sl > entry && tp < entry;
  }

  return false;
}

function validateLiveEntryGates(row = {}) {
  const cfg = tradeConfig();

  const tradeSide = inferRowTradeSide(row);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      tradeSide
    };
  }

  if (row.syntheticRisk && !cfg.allowSyntheticRiskLiveEntries) {
    return {
      ok: false,
      reason: 'SYNTHETIC_RISK_NOT_LIVE',
      syntheticRisk: true,
      syntheticRiskReason: row.syntheticRiskReason || null
    };
  }

  if (!hasValidRiskShape(row)) {
    return {
      ok: false,
      reason: row.liveEntryBlockedReason || 'SHORT_RISK_INVALID',
      liveRiskValid: false,
      learningOnly: Boolean(row.learningOnly)
    };
  }

  const spreadPct = safeNumber(
    row.spreadPct ??
    row.liveSpreadPct ??
    row.orderbookSpreadPct,
    0
  );

  const score = safeNumber(
    row.scannerScore ??
    row.moveScore,
    0
  );

  if (isMirrorAnalysisRow(row)) {
    return {
      ok: false,
      reason: 'MIRROR_ANALYSIS_ONLY',
      mirrorOfSide: row.mirrorOfSide || null
    };
  }

  if (cfg.requireScannerGateForLiveEntries && !scannerGatePassed(row)) {
    return {
      ok: false,
      reason: 'SCANNER_GATE_NOT_PASSED',
      scannerGatePassed: false
    };
  }

  if (cfg.blockDiscoveryOnlyLiveEntries && isDiscoveryOnly(row)) {
    return {
      ok: false,
      reason: 'SCANNER_DISCOVERY_ONLY_NOT_LIVE',
      tradeDiscoveryOnly: true
    };
  }

  if (!cfg.allowFakeBreakoutLiveEntries && row.fakeBreakout) {
    return {
      ok: false,
      reason: 'FAKE_BREAKOUT_NOT_LIVE',
      fakeBreakout: true,
      fakeBreakoutReason: row.fakeBreakoutReason || null
    };
  }

  if (
    !cfg.allowLowConfidenceLiveEntries &&
    String(row.sideConfidence || '').toUpperCase() === 'LOW'
  ) {
    return {
      ok: false,
      reason: 'LOW_SIDE_CONFIDENCE_NOT_LIVE',
      sideConfidence: row.sideConfidence
    };
  }

  if (spreadPct > cfg.maxSpreadPct) {
    return {
      ok: false,
      reason: 'SPREAD_TOO_WIDE',
      spreadPct,
      maxSpreadPct: cfg.maxSpreadPct
    };
  }

  if (row.liveSpreadGatePassed === false) {
    return {
      ok: false,
      reason: 'SPREAD_GATE_FAILED',
      spreadPct,
      maxSpreadPct: cfg.maxSpreadPct
    };
  }

  if (cfg.minLiveScannerScore > 0 && score < cfg.minLiveScannerScore) {
    return {
      ok: false,
      reason: 'SCANNER_SCORE_TOO_LOW_FOR_LIVE',
      scannerScore: score,
      minLiveScannerScore: cfg.minLiveScannerScore
    };
  }

  return {
    ok: true,
    spreadPct,
    scannerScore: score,
    tradeSide: TARGET_TRADE_SIDE
  };
}

async function cachedVolatile(key, ttlSec, fn) {
  const redis = getVolatileRedis();

  const cached = await getJson(redis, key, null).catch(() => null);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const value = await fn();

  if (value !== undefined) {
    const ttl = Math.max(1, Number(ttlSec) || 1);
    await setJson(redis, key, value, { ex: ttl }).catch(() => null);
  }

  return value;
}

async function fetchLiveCandidateData(candidate) {
  const cfg = tradeConfig();

  const normalized = normalizeCandidate(candidate);
  const symbol = normalized.contractSymbol;

  if (!symbol) {
    return {
      symbol,
      ob: {
        fetchFailed: true,
        mid: 0,
        bias: 'NEUTRAL',
        spreadPct: CONFIG.cost?.fallbackSpreadPct || 0.0008,
        depthMinUsd1p: 0
      },
      funding: { rate: 0, fetchFailed: true },
      candles15m: [],
      candles1h: []
    };
  }

  const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
    cachedVolatile(
      KEYS.live.cache(symbol, 'ob'),
      cfg.orderbookTtlSec,
      () => fetchOrderBook(symbol)
    ).catch(() => null),

    cachedVolatile(
      KEYS.live.cache(symbol, 'funding'),
      cfg.fundingTtlSec,
      () => fetchFunding(symbol)
    ).catch(() => ({ rate: 0, fetchFailed: true })),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c15'),
      cfg.candleTtlSec,
      () => fetchCandles(symbol, '15m', 100)
    ).catch(() => []),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c1h'),
      cfg.candleTtlSec,
      () => fetchCandles(symbol, '1h', 100)
    ).catch(() => [])
  ]);

  const ob = analyzeOrderBook(rawOrderBook);

  return {
    symbol,
    ob,
    funding,
    candles15m: Array.isArray(candles15m) ? candles15m : [],
    candles1h: Array.isArray(candles1h) ? candles1h : []
  };
}

async function fetchMidPrice(symbol) {
  const cfg = tradeConfig();
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return 0;

  const rawOrderBook = await cachedVolatile(
    KEYS.live.cache(contractSymbol, 'ob'),
    cfg.orderbookTtlSec,
    () => fetchOrderBook(contractSymbol)
  ).catch(() => null);

  const ob = analyzeOrderBook(rawOrderBook);

  return safeNumber(ob?.mid, 0);
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function snapshotPattern() {
  try {
    return KEYS.scan.snapshot('*');
  } catch {
    return 'SCAN:SNAPSHOT:*';
  }
}

function snapshotCreatedAt(snapshot = {}) {
  return safeNumber(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
}

function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function candidateTradeSide(candidate = {}) {
  return normalizeTradeSide(
    candidate.tradeSide ||
    candidate.positionSide ||
    candidate.direction ||
    candidate.scannerSide ||
    candidate.actualScannerSide ||
    candidate.analysisSide ||
    candidate.side
  );
}

function countTargetCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows.filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE).length;
}

function countOppositeCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return rows.filter((candidate) => candidateTradeSide(candidate) === OPPOSITE_TRADE_SIDE).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentTargetSnapshots(redis) {
  const keys = await getKeys(
    redis,
    snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);

      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        key,
        snapshot,
        targetCount: countTargetCandidates(snapshot),
        oppositeCount: countOppositeCandidates(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const targetRows = rows
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .map((candidate) => ({
      ...candidate,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false
    }));

  return {
    ...snapshot,

    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: targetRows.length,
    selectedOppositeCandidateCount: countOppositeCandidates(snapshot),

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    candidates: targetRows,
    candidatesCount: targetRows.length,
    shortCandidatesCount: targetRows.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: targetRows.filter((row) => row.scannerGatePassed).length,
    analyzeOnlyCandidatesCount: targetRows.filter((row) => (
      row.tradeDiscoveryOnly ||
      row.discoveryOnly ||
      row.analyzeOnly
    )).length,

    topSymbols: targetRows
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean),

    scannerGateSymbols: targetRows
      .filter((row) => row.scannerGatePassed)
      .slice(0, 20)
      .map((row) => row.symbol)
      .filter(Boolean)
  };
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();

  const latest = await safeGetSnapshotJson(
    volatileRedis,
    KEYS.scan.latest,
    null
  );

  const latestSnapshotId = extractSnapshotId(latest);

  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      source: 'SCAN:LATEST_FULL_SNAPSHOT',
      snapshot: latest,
      targetCount: countTargetCandidates(latest),
      oppositeCount: countOppositeCandidates(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (latestSnapshotId) {
    const byId = await safeGetSnapshotJson(
      volatileRedis,
      KEYS.scan.snapshot(latestSnapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      candidates.push({
        source: 'SCAN:SNAPSHOT_BY_LATEST_ID',
        snapshot: byId,
        targetCount: countTargetCandidates(byId),
        oppositeCount: countOppositeCandidates(byId),
        createdAt: snapshotCreatedAt(byId)
      });
    }
  }

  const recent = await loadRecentTargetSnapshots(volatileRedis);

  for (const item of recent) {
    candidates.push({
      source: `SCAN:RECENT_SEARCH:${item.key}`,
      snapshot: item.snapshot,
      targetCount: item.targetCount,
      oppositeCount: item.oppositeCount,
      createdAt: item.createdAt
    });
  }

  const unique = new Map();

  for (const item of candidates) {
    const id = item.snapshot?.snapshotId || item.source;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.targetCount > previous.targetCount ||
      (
        item.targetCount === previous.targetCount &&
        item.createdAt > previous.createdAt
      )
    ) {
      unique.set(id, item);
    }
  }

  const sorted = [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);

  const selectedTarget = sorted.find((item) => item.targetCount > 0);

  if (selectedTarget) {
    return normalizeSelectedSnapshot(selectedTarget.snapshot, {
      source: selectedTarget.source,
      reason: 'NEWEST_SHORT_SNAPSHOT_WITH_CANDIDATES'
    });
  }

  const selectedAny = sorted[0] || null;

  if (!selectedAny) return null;

  return normalizeSelectedSnapshot(selectedAny.snapshot, {
    source: selectedAny.source,
    reason: 'NO_SHORT_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE'
  });
}

function validateExposure(openPositions, side) {
  const cfg = tradeConfig();

  const rows = Array.isArray(openPositions) ? openPositions : [];
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      side: tradeSide
    };
  }

  if (rows.length >= cfg.maxOpenPositions) {
    return {
      ok: false,
      reason: 'MAX_OPEN_POSITIONS',
      count: rows.length,
      cap: cfg.maxOpenPositions
    };
  }

  const sameSide = rows.filter((position) => (
    normalizeTradeSide(position.side || position.tradeSide) === TARGET_TRADE_SIDE
  )).length;

  if (sameSide >= cfg.maxOpenSameSide) {
    return {
      ok: false,
      reason: 'MAX_OPEN_SAME_SIDE',
      side: TARGET_TRADE_SIDE,
      count: sameSide,
      cap: cfg.maxOpenSameSide
    };
  }

  return {
    ok: true
  };
}

function detectShadowExit(shadow, price) {
  const current = safeNumber(price, 0);
  const tp = safeNumber(shadow.tp, 0);
  const sl = safeNumber(shadow.sl, 0);

  if (current <= 0 || tp <= 0 || sl <= 0) {
    return {
      shouldExit: false,
      reason: null
    };
  }

  if (!isShort(shadow.side || shadow.tradeSide)) {
    return {
      shouldExit: true,
      reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM'
    };
  }

  if (current <= tp) return { shouldExit: true, reason: 'TP' };
  if (current >= sl) return { shouldExit: true, reason: 'SL' };

  if (now() >= safeNumber(shadow.monitorUntil, 0)) {
    return {
      shouldExit: true,
      reason: 'TIME_STOP'
    };
  }

  return {
    shouldExit: false,
    reason: null
  };
}

async function monitorOneShadowPosition(redis, key) {
  const cfg = analyzeConfig();

  const shadow = await getJson(redis, key, null);

  if (!shadow || shadow.status !== 'OPEN') {
    return null;
  }

  const shadowSide = inferRowTradeSide(shadow);

  if (shadowSide !== TARGET_TRADE_SIDE) {
    await redis.del(key).catch(() => null);

    return {
      skipped: true,
      reason: 'NON_SHORT_SHADOW_REMOVED',
      symbol: shadow.symbol || shadow.contractSymbol || null,
      tradeSide: shadowSide
    };
  }

  const price = await fetchMidPrice(
    shadow.contractSymbol ||
    shadow.symbol
  ).catch(() => 0);

  if (!price) return null;

  updatePathMetrics(shadow, price);

  const exit = detectShadowExit(shadow, price);

  if (!exit.shouldExit) {
    await setJson(
      redis,
      key,
      shadow,
      {
        ex: Math.ceil(cfg.shadowHorizonMin * 60 * 1.2)
      }
    );

    return null;
  }

  if (exit.reason === 'LONG_DISABLED_SHORT_ONLY_SYSTEM') {
    await redis.del(key).catch(() => null);

    return {
      skipped: true,
      reason: 'NON_SHORT_SHADOW_REMOVED',
      symbol: shadow.symbol || shadow.contractSymbol || null,
      tradeSide: shadowSide
    };
  }

  const outcome = buildOutcomeFromPosition({
    position: {
      ...shadow,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
    },
    exitPrice: price,
    exitReason: exit.reason,
    source: 'SHADOW'
  });

  await recordOutcome(outcome, {
    source: 'SHADOW'
  });

  await redis.del(key);

  return outcome;
}

async function monitorShadowPositions() {
  const cfg = analyzeConfig();

  if (!cfg.shadowEnabled) return [];

  const redis = getDurableRedis();

  const keys = await getKeys(
    redis,
    KEYS.analyze.shadowOpenPattern,
    cfg.maxShadowMonitorsPerRun
  );

  if (!keys.length) return [];

  const results = await mapConcurrent(
    keys,
    tradeConfig().dataConcurrency,
    (key) => monitorOneShadowPosition(redis, key)
  );

  return results.filter(Boolean);
}

function enrichMetricsWithScannerAndLiveGates({
  metrics,
  candidate,
  ob
}) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);

  const spreadPct = safeNumber(
    metrics?.spreadPct ??
    ob?.spreadPct,
    0
  );

  const enriched = {
    ...metrics,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    snapshotId: normalized.snapshotId || metrics.snapshotId || null,

    symbol: normalized.symbol || metrics.symbol,
    baseSymbol: normalized.baseSymbol || metrics.baseSymbol,
    contractSymbol: normalized.contractSymbol || metrics.contractSymbol,

    price: safeNumber(normalized.price ?? metrics.price ?? ob?.mid, 0),

    scannerScore: safeNumber(
      normalized.scannerScore ??
      normalized.moveScore ??
      metrics.scannerScore,
      0
    ),

    moveScore: safeNumber(
      normalized.moveScore ??
      normalized.scannerScore ??
      metrics.moveScore,
      0
    ),

    scannerReason: normalized.scannerReason || metrics.scannerReason || null,
    scannerTs: normalized.scannerTs || metrics.scannerTs || null,

    scannerGatePassed: normalized.scannerGatePassed !== false,
    scannerGateReason: normalized.scannerGateReason || null,

    analyzeEligible: normalized.analyzeEligible !== false,
    tradeDiscoveryOnly: Boolean(normalized.tradeDiscoveryOnly),
    discoveryOnly: Boolean(normalized.discoveryOnly),
    analyzeOnly: Boolean(normalized.analyzeOnly),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,
    mirrorOfSide: null,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,
    liveEntryBlockedReason: normalized.liveEntryBlockedReason || null,

    passesMoveFilter: normalized.passesMoveFilter !== false,
    passesVolumeFilter: normalized.passesVolumeFilter !== false,
    hasDirectionalSide: normalized.hasDirectionalSide !== false,

    sideConfidence: normalized.sideConfidence || metrics.sideConfidence || null,

    fakeBreakout: Boolean(normalized.fakeBreakout || metrics.fakeBreakout),
    fakeBreakoutRisk: Boolean(normalized.fakeBreakoutRisk || metrics.fakeBreakoutRisk),
    fakeBreakoutReason: normalized.fakeBreakoutReason || metrics.fakeBreakoutReason || null,
    breakoutType: normalized.breakoutType || metrics.breakoutType || null,

    pullbackConfirmed: Boolean(normalized.pullbackConfirmed || metrics.pullbackConfirmed),
    retestConfirmed: Boolean(normalized.retestConfirmed || metrics.retestConfirmed),
    sweepConfirmed: Boolean(normalized.sweepConfirmed || metrics.sweepConfirmed),

    spreadPct,
    liveSpreadPct: spreadPct,
    maxSpreadPct: cfg.maxSpreadPct,
    liveSpreadGatePassed: spreadPct <= cfg.maxSpreadPct,

    liveRiskValid: metrics.liveRiskValid !== false,
    learningOnly: Boolean(metrics.learningOnly),

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    liveDataTs: now()
  };

  return {
    ...enriched,
    liveRiskValid: hasValidRiskShape(enriched)
  };
}

function buildObservationOnlyMetrics({
  normalized,
  data = {},
  reason = 'SHORT_RISK_INVALID'
}) {
  const ob = data.ob || {};
  const spreadPct = safeNumber(
    ob.spreadPct ??
    normalized.spreadPct ??
    CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  const mid = safeNumber(
    ob.mid ??
    normalized.price ??
    normalized.markPrice ??
    normalized.currentPrice,
    0
  );

  return enrichMetricsWithScannerAndLiveGates({
    metrics: {
      symbol: normalized.symbol,
      baseSymbol: normalized.baseSymbol,
      contractSymbol: normalized.contractSymbol,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      price: mid,

      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,

      riskPct: 0,
      rewardPct: 0,

      confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
      sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),

      spreadPct,
      depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
      fundingRate: safeNumber(data.funding?.rate, 0),

      rsiZone: normalized.rsiZone || null,
      rsiCoarse: normalized.rsiCoarse || null,
      flow: normalized.flow || null,
      flowCoarse: normalized.flowCoarse || null,
      obRelation: normalized.obRelation || null,
      btcRelation: normalized.btcRelation || null,
      btcState: normalized.btcState || null,
      regime: normalized.regime || null,
      regimeCoarse: normalized.regimeCoarse || null,

      observationOnly: true,
      analysisInputOnly: true,
      shadowEligible: false,

      learningOnly: true,
      liveRiskValid: false,
      liveEntryBlockedReason: reason
    },
    candidate: {
      ...normalized,
      liveEntryBlockedReason: reason
    },
    ob
  });
}

function buildSyntheticShortRiskMetrics({
  normalized,
  data = {},
  reason = 'RISK_ENGINE_EMPTY_SYNTHETIC_SHORT_RISK'
}) {
  const cfg = tradeConfig();
  const ob = data.ob || {};

  const spreadPct = safeNumber(
    ob.spreadPct ??
    normalized.spreadPct ??
    CONFIG.cost?.fallbackSpreadPct,
    0.0008
  );

  const mid = safeNumber(
    ob.mid ??
    normalized.price ??
    normalized.markPrice ??
    normalized.currentPrice,
    0
  );

  if (mid <= 0) {
    return buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'SYNTHETIC_SHORT_RISK_NO_MID_PRICE'
    });
  }

  const rr = Math.max(0.5, cfgNumber(cfg.defaultRR, 1.5));
  const riskPct = clampNumber(
    cfg.fallbackRiskPct,
    Math.max(0.0005, cfg.minRiskPct),
    Math.max(cfg.minRiskPct, cfg.maxRiskPct)
  );

  const entry = mid;
  const sl = entry * (1 + riskPct);
  const tp = Math.max(entry * (1 - riskPct * rr), entry * 0.0001);
  const rewardPct = Math.max(0, (entry - tp) / entry);

  return enrichMetricsWithScannerAndLiveGates({
    metrics: {
      symbol: normalized.symbol,
      baseSymbol: normalized.baseSymbol,
      contractSymbol: normalized.contractSymbol,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      price: mid,

      entry,
      sl,
      tp,
      rr,

      riskPct,
      rewardPct,

      confluence: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),
      sniperScore: safeNumber(normalized.scannerScore ?? normalized.moveScore, 0),

      spreadPct,
      depthMinUsd1p: safeNumber(ob.depthMinUsd1p, 0),
      fundingRate: safeNumber(data.funding?.rate, 0),

      rsiZone: normalized.rsiZone || null,
      rsiCoarse: normalized.rsiCoarse || null,
      flow: normalized.flow || null,
      flowCoarse: normalized.flowCoarse || null,
      obRelation: normalized.obRelation || null,
      btcRelation: normalized.btcRelation || null,
      btcState: normalized.btcState || null,
      regime: normalized.regime || null,
      regimeCoarse: normalized.regimeCoarse || null,

      syntheticRisk: true,
      syntheticRiskReason: reason,
      observationOnly: false,
      analysisInputOnly: false,
      shadowEligible: true,

      learningOnly: false,
      liveRiskValid: true,
      liveEntryBlockedReason: null
    },
    candidate: {
      ...normalized,
      liveEntryBlockedReason: null
    },
    ob
  });
}

function buildActualRiskWaitIfNeeded({
  normalized,
  scannerSide,
  metricsRows
}) {
  if (scannerSide !== TARGET_TRADE_SIDE) {
    return waitAction(
      {
        ...normalized,
        side: scannerSide,
        tradeSide: scannerSide
      },
      'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      {
        shortOnly: true,
        longDisabled: true
      }
    );
  }

  const hasShortMetrics = metricsRows.some((row) => (
    normalizeTradeSide(row.tradeSide || row.side) === TARGET_TRADE_SIDE &&
    hasValidRiskShape(row)
  ));

  if (hasShortMetrics) return null;

  return waitAction(
    {
      ...normalized,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    },
    'SHORT_RISK_INVALID'
  );
}

async function processCandidate(candidate) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);

  if (!normalized.symbol || !normalized.contractSymbol) {
    return {
      actions: [waitAction(normalized, 'INVALID_SYMBOL')],
      metrics: []
    };
  }

  const scannerSide = normalizeTradeSide(
    normalized.tradeSide ||
    normalized.side
  );

  if (scannerSide !== TARGET_TRADE_SIDE) {
    return {
      actions: [
        waitAction(
          {
            ...normalized,
            tradeSide: scannerSide,
            side: normalized.side
          },
          'LONG_DISABLED_SHORT_ONLY_SYSTEM',
          {
            skippedBeforeLiveFetch: true,
            detectedScannerSide: scannerSide
          }
        )
      ],
      metrics: []
    };
  }

  const data = await fetchLiveCandidateData(normalized)
    .catch((error) => ({ error }));

  if (data.error || data.ob?.fetchFailed) {
    const fallback = buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'LIVE_DATA_FAILED'
    });

    return {
      actions: [
        waitAction(normalized, 'LIVE_DATA_FAILED', {
          error: data.error?.message || null
        })
      ],
      metrics: [fallback]
    };
  }

  const hasEnough15mCandles = Array.isArray(data.candles15m) && data.candles15m.length >= 30;

  if (!hasEnough15mCandles) {
    const fallback = buildObservationOnlyMetrics({
      normalized,
      data,
      reason: 'INSUFFICIENT_LIVE_CANDLES_15M'
    });

    return {
      actions: [
        waitAction(normalized, 'INSUFFICIENT_LIVE_CANDLES_15M', {
          candleCount: data.candles15m?.length || 0
        })
      ],
      metrics: [fallback]
    };
  }

  const generatedMetrics = buildRiskAndLiveMetricsForBothSides({
    candidate: {
      ...normalized,
      side: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    },
    ob: data.ob,
    funding: data.funding,
    candles15m: data.candles15m,
    candles1h: data.candles1h,
    btcState: normalized.btcState || candidate.btcState,
    regime: normalized.regime || candidate.regime
  });

  const rawMetrics = Array.isArray(generatedMetrics)
    ? generatedMetrics
    : [];

  const metrics = rawMetrics
    .map((row) => {
      const rowSide = normalizeTradeSide(row.tradeSide || row.side);

      if (rowSide !== TARGET_TRADE_SIDE) return null;

      const variant = buildAnalysisVariant(
        normalized,
        TARGET_TRADE_SIDE,
        scannerSide
      );

      if (!variant) return null;

      return enrichMetricsWithScannerAndLiveGates({
        metrics: row,
        candidate: variant,
        ob: data.ob
      });
    })
    .filter(Boolean);

  const hasValidShortRisk = metrics.some(hasValidRiskShape);

  const finalMetrics = hasValidShortRisk
    ? metrics
    : [
      cfg.allowSyntheticRiskFallback
        ? buildSyntheticShortRiskMetrics({
          normalized,
          data,
          reason: 'RISK_ENGINE_EMPTY_SYNTHETIC_SHORT_RISK'
        })
        : buildObservationOnlyMetrics({
          normalized,
          data,
          reason: 'RISK_ENGINE_EMPTY_SHORT_RISK_OBSERVATION_ONLY'
        })
    ];

  const riskWait = buildActualRiskWaitIfNeeded({
    normalized,
    scannerSide,
    metricsRows: finalMetrics
  });

  return {
    actions: riskWait ? [riskWait] : [],
    metrics: finalMetrics
  };
}

async function safeProcessCandidate(candidate) {
  try {
    return await processCandidate(candidate);
  } catch (error) {
    const normalized = normalizeCandidate(candidate);

    return {
      actions: [
        waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
          error: error?.message || String(error)
        })
      ],
      metrics: [
        buildObservationOnlyMetrics({
          normalized,
          reason: 'CANDIDATE_PROCESS_ERROR'
        })
      ]
    };
  }
}

function buildEntryAction({
  row,
  activeContext,
  weeklyStats,
  riskFraction,
  riskCaps,
  liveGate
}) {
  const microFamilyId = rowMicroId(row);

  const activeMacroFamilyId =
    parentMacroFamilyId(row) ||
    activeContext.microToMacroFamilyId[microFamilyId] ||
    activeContext.microToMacroFamilyId[row.microFamilyId] ||
    null;

  return {
    ...row,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    action: 'ENTRY',
    reason: 'ACTIVE_SHORT_TRUE_MICRO_FAMILY_ENTRY',

    rotationMatchType: 'TRUE_MICRO_EXACT',
    activeRotationId: activeContext.rotationId,
    activeMacroFamilyId,

    weeklyStats,

    riskFraction,
    riskCaps,
    liveGate,

    btcRelation: row.btcRelation,

    liveEligible: true,
    shadowOnly: false,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    entryCreatedAt: now()
  };
}

function normalizeShadowResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      created: true,
      skipped: false,
      reason: 'SHADOW_CREATED'
    };
  }

  return {
    created: result.created !== false && result.skipped !== true,
    skipped: Boolean(result.skipped),
    reason: result.reason || (result.skipped ? 'SHADOW_SKIPPED' : 'SHADOW_CREATED'),
    ...result
  };
}

async function createShadowForRow(row = {}) {
  const cfg = analyzeConfig();

  if (!cfg.shadowEnabled) {
    return {
      created: false,
      skipped: true,
      reason: 'SHADOW_DISABLED'
    };
  }

  if (!isTargetRow(row)) {
    return {
      created: false,
      skipped: true,
      reason: 'NON_SHORT_SHADOW_SKIPPED'
    };
  }

  if (!hasValidRiskShape(row)) {
    return {
      created: false,
      skipped: true,
      reason: 'SHADOW_RISK_INVALID'
    };
  }

  if (row.shadowEligible === false) {
    return {
      created: false,
      skipped: true,
      reason: row.shadowBlockedReason || 'SHADOW_NOT_ELIGIBLE'
    };
  }

  try {
    const result = await createShadowPosition({
      ...row,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
    });

    return normalizeShadowResult(result);
  } catch (error) {
    return {
      created: false,
      skipped: false,
      failed: true,
      reason: 'SHADOW_CREATE_ERROR',
      error: error?.message || String(error)
    };
  }
}

async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();

  const completedAt = now();

  const finalResult = {
    ok: true,
    ...result,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts: result.actionCounts || actionCounts(result.actions || [])
  };

  await setJson(
    durableRedis,
    KEYS.trade.runMeta,
    finalResult
  );

  return finalResult;
}

export async function runTradeSystem(options = {}) {
  const cfg = tradeConfig();
  const sizing = sizingConfig();

  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run');
  const startedAt = now();

  const forceProcessSnapshot = Boolean(options.forceProcessSnapshot || options.force);
  const monitorOnly = Boolean(options.monitorOnly);

  const priceFetcher = async (symbol) => fetchMidPrice(symbol);

  const realExits = await monitorOpenPositions({ priceFetcher });
  const shadowExits = await monitorShadowPositions();

  if (monitorOnly) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'MONITOR_ONLY'
    });
  }

  const snapshot = await getLatestSnapshot();

  if (!snapshot?.snapshotId) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'NO_SCANNER_SNAPSHOT'
    });
  }

  const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

  if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_TOO_STALE'
    });
  }

  const lastProcessed = await getJson(
    durableRedis,
    KEYS.trade.lastProcessedSnapshot,
    null
  );

  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  if (sameSnapshot && !forceProcessSnapshot) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED'
    });
  }

  const activeRotation = await getActiveRotation();
  const activeContext = buildActiveRotationContext(activeRotation);

  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .slice(0, cfg.maxCandidatesPerSnapshot)
    .map((candidate) => ({
      ...candidate,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      btcState: snapshot.btcState,
      regime: snapshot.regime
    }));

  const shortCandidateCount = candidates.length;
  const nonShortCandidateCount = 0;

  const processed = await mapConcurrent(
    candidates,
    cfg.dataConcurrency,
    safeProcessCandidate
  );

  const earlyActions = processed
    .flatMap((row) => Array.isArray(row?.actions) ? row.actions : [])
    .filter(Boolean);

  const liveRows = processed
    .flatMap((row) => Array.isArray(row?.metrics) ? row.metrics : [])
    .filter(Boolean)
    .filter(isTargetRow);

  const actualLiveRows = liveRows.filter(isLiveScannerRow).length;
  const mirrorRows = liveRows.filter(isMirrorAnalysisRow).length;
  const observationOnlyRows = liveRows.filter((row) => row.observationOnly || row.analysisInputOnly).length;
  const syntheticRiskRows = liveRows.filter((row) => row.syntheticRisk).length;
  const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
  const riskValidRows = liveRows.filter(hasValidRiskShape).length;

  let analyzedRowsRaw = [];
  let analyzeError = null;

  try {
    analyzedRowsRaw = await analyzeCandidatesBatch(liveRows);
  } catch (error) {
    analyzeError = error?.message || String(error);
    analyzedRowsRaw = [];
  }

  const analyzedRows = analyzedRowsRaw
    .filter(Boolean)
    .filter(isTargetRow)
    .filter((row) => !isMirrorAnalysisRow(row));

  const analyzedActualRows = analyzedRows.filter(isLiveScannerRow).length;
  const analyzedMirrorRows = analyzedRows.filter(isMirrorAnalysisRow).length;
  const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
  const analyzedSyntheticRiskRows = analyzedRows.filter((row) => row.syntheticRisk).length;

  const openPositions = await getOpenPositions();
  const actions = [...earlyActions];

  let shadowCreatedRows = 0;
  let shadowSkippedRows = 0;
  let shadowFailedRows = 0;

  for (const row of analyzedRows) {
    if (!isTargetRow(row)) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
        activeRotationId: activeContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(row) || null,
        liveEligible: false,
        shadowOnly: true,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const shadowResult = await createShadowForRow(row);

    if (shadowResult.failed) shadowFailedRows += 1;
    else if (shadowResult.skipped) shadowSkippedRows += 1;
    else if (shadowResult.created) shadowCreatedRows += 1;

    const rowWithShadow = {
      ...row,
      shadowResult
    };

    const microFamilyId = rowMicroId(rowWithShadow);

    if (!hasValidRiskShape(rowWithShadow)) {
      actions.push({
        ...rowWithShadow,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: rowWithShadow.liveEntryBlockedReason || 'SHORT_RISK_INVALID',
        activeRotationId: activeContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(rowWithShadow) || null,
        liveEligible: false,
        shadowOnly: true,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const trueMicroRow = isTrueMicroFamilyRow(rowWithShadow);
    const activeExactMicro = rowMatchesActiveMicro(activeContext, rowWithShadow);

    if (!activeExactMicro || (!allowLegacyMacroLiveEntries() && !trueMicroRow)) {
      actions.push({
        ...rowWithShadow,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: buildRotationWaitReason(activeContext, rowWithShadow),
        activeRotationId: activeContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(rowWithShadow) || null,
        activeMicroFamilies: activeContext.activeMicroFamilyIds.length,
        activeMacroFamilies: activeContext.activeMacroFamilyIds.length,
        activeMicroAliasIds: activeContext.activeMicroAliasIds,
        rowMicroAliasIds: rowMicroAliasIds(rowWithShadow, {
          includeCoarse: activeContext.allowCoarseMicroAliasLiveEntries
        }),
        allowCoarseMicroAliasLiveEntries: activeContext.allowCoarseMicroAliasLiveEntries,
        liveEligible: false,
        shadowOnly: true,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const liveGate = validateLiveEntryGates(rowWithShadow);

    if (!liveGate.ok) {
      actions.push({
        ...rowWithShadow,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: liveGate.reason,
        activeRotationId: activeContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(rowWithShadow) || null,
        liveGate,
        liveEligible: false,
        shadowOnly: true,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const alreadyOpen = await getOpenPosition(rowWithShadow.symbol);

    if (alreadyOpen) {
      actions.push({
        ...rowWithShadow,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'SYMBOL_ALREADY_OPEN',
        activeRotationId: activeContext.rotationId,
        liveEligible: false,
        shadowOnly: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const exposure = validateExposure(openPositions, TARGET_TRADE_SIDE);

    if (!exposure.ok) {
      actions.push({
        ...rowWithShadow,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: exposure.reason,
        activeRotationId: activeContext.rotationId,
        exposure,
        liveEligible: false,
        shadowOnly: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const weeklyStats = getWeeklyStats(
      activeContext,
      microFamilyId,
      rowWithShadow
    );

    const riskFraction = sizing.enabled
      ? riskFractionForEntry({ weeklyStats })
      : sizing.baseRiskPct;

    const riskCaps = checkRiskCaps({
      openPositions,
      side: TARGET_TRADE_SIDE,
      btcRelation: rowWithShadow.btcRelation,
      riskFraction
    });

    if (!riskCaps.ok) {
      actions.push({
        ...rowWithShadow,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: riskCaps.reason,
        activeRotationId: activeContext.rotationId,
        riskCaps,
        liveEligible: false,
        shadowOnly: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const entry = buildEntryAction({
      row: rowWithShadow,
      activeContext,
      weeklyStats,
      riskFraction,
      riskCaps,
      liveGate
    });

    const position = buildOpenPositionFromEntry(entry);

    await saveOpenPosition(position);

    openPositions.push(position);

    await sendEntryAlert(entry).catch(() => null);

    actions.push(entry);
  }

  await setJson(
    durableRedis,
    KEYS.trade.lastProcessedSnapshot,
    {
      snapshotId: snapshot.snapshotId,
      processedAt: now(),
      forceProcessSnapshot,

      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      candidates: candidates.length,
      shortCandidateCount,
      nonShortCandidateCount,

      processed: processed.length,
      earlyActions: earlyActions.length,

      liveRows: liveRows.length,
      analyzeInputRows: liveRows.length,
      actualLiveRows,
      mirrorRows,
      observationOnlyRows,
      syntheticRiskRows,
      learningOnlyRows,
      riskValidRows,

      analyzedRows: analyzedRows.length,
      analyzedRowsRaw: analyzedRowsRaw.length,
      analyzedActualRows,
      analyzedMirrorRows,
      analyzedRiskValidRows,
      analyzedSyntheticRiskRows,

      analyzeError,

      shadowCreatedRows,
      shadowSkippedRows,
      shadowFailedRows,

      actions: actions.length,

      activeRotationId: activeContext.rotationId,
      activeMicroFamilies: activeContext.activeMicroFamilyIds.length,
      activeMacroFamilies: activeContext.activeMacroFamilyIds.length,
      activeMicroFamilyIds: activeContext.activeMicroFamilyIds,
      activeMicroAliasIds: activeContext.activeMicroAliasIds,
      activeMacroFamilyIds: activeContext.activeMacroFamilyIds,
      trueMicroOnly: activeContext.trueMicroOnly,
      usedLegacyFallback: activeContext.usedLegacyFallback,
      allowCoarseMicroAliasLiveEntries: activeContext.allowCoarseMicroAliasLiveEntries
    }
  );

  return saveRunMeta({
    runId,
    startedAt,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec: Math.round(snapshotAgeSec),

    selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
    selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
    selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    candidates: candidates.length,
    shortCandidateCount,
    nonShortCandidateCount,

    processed: processed.length,
    earlyActions: earlyActions.length,

    liveRows: liveRows.length,
    analyzeInputRows: liveRows.length,
    actualLiveRows,
    mirrorRows,
    observationOnlyRows,
    syntheticRiskRows,
    learningOnlyRows,
    riskValidRows,

    analyzedRows: analyzedRows.length,
    analyzedRowsRaw: analyzedRowsRaw.length,
    analyzedActualRows,
    analyzedMirrorRows,
    analyzedRiskValidRows,
    analyzedSyntheticRiskRows,

    analyzeError,

    shadowCreatedRows,
    shadowSkippedRows,
    shadowFailedRows,

    actions,
    actionCounts: actionCounts(actions),

    realExits,
    shadowExits,

    activeRotationId: activeContext.rotationId,
    activeMicroFamilies: activeContext.activeMicroFamilyIds.length,
    activeMacroFamilies: activeContext.activeMacroFamilyIds.length,
    activeMicroFamilyIds: activeContext.activeMicroFamilyIds,
    activeMicroAliasIds: activeContext.activeMicroAliasIds,
    activeMacroFamilyIds: activeContext.activeMacroFamilyIds,
    trueMicroOnly: activeContext.trueMicroOnly,
    usedLegacyFallback: activeContext.usedLegacyFallback,
    allowCoarseMicroAliasLiveEntries: activeContext.allowCoarseMicroAliasLiveEntries,

    scannerSnapshotStats: {
      candidatesCount: snapshot.candidatesCount || candidates.length,
      scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount || null,
      analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount || null,
      filteredUniverse: snapshot.filteredUniverse || null,
      rawCount: snapshot.rawCount || null
    },

    skippedNewEntries: false
  });
}