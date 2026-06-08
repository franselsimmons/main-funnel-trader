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
  analyzeCandidatesBatch
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
  monitorOpenPositions
} from './positionEngine.js';
import {
  riskFractionForEntry
} from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 300;
const SNAPSHOT_SEARCH_LIMIT = 80;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';

const OPPOSITE_TRADE_SIDE = 'LONG';

const KNOWN_TRADE_SIDES = new Set([
  TARGET_TRADE_SIDE,
  OPPOSITE_TRADE_SIDE
]);

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

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

  return {
    maxCandidatesPerSnapshot: positiveInt(
      Math.max(configuredTradeMax, configuredAnalyzeMax, DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT),
      DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT,
      1,
      1000
    ),

    maxSnapshotAgeSec: cfgNumber(CONFIG.trade?.maxSnapshotAgeSec, 8 * 60),

    dataConcurrency: positiveInt(
      CONFIG.trade?.dataConcurrency,
      8,
      1,
      20
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

    allowSyntheticRiskFallback: cfgBoolean(
      CONFIG.trade?.allowSyntheticRiskFallback,
      false
    ),

    allowSyntheticRiskVirtualEntries: cfgBoolean(
      CONFIG.trade?.allowSyntheticRiskVirtualEntries,
      false
    ),

    minRiskPct: cfgNumber(CONFIG.trade?.minRiskPct, 0.004),
    maxRiskPct: cfgNumber(CONFIG.trade?.maxRiskPct, 0.025),
    fallbackRiskPct: cfgNumber(CONFIG.trade?.fallbackRiskPct, 0.005),
    defaultRR: cfgNumber(CONFIG.trade?.defaultRR, 1.5),
    minRR: cfgNumber(CONFIG.trade?.minRR, 0.5)
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

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanSideText(value = '') {
  return upper(value, '')
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('LONG_DISABLED_TRUE', '')
    .replaceAll('LONGDISABLED_TRUE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
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
  const raw = cleanSideText(side);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (SHORT_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (longHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function idLooksLikeTargetFamily(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_SHORT_') ||
    /^SHORT_\d+$/u.test(value) ||
    value.startsWith('SHORT_') ||
    value.includes('_SHORT_') ||
    value.endsWith('_SHORT') ||
    value.startsWith('BEAR_') ||
    value.includes('_BEAR_') ||
    value.endsWith('_BEAR') ||
    value.startsWith('SELL_') ||
    value.includes('_SELL_') ||
    value.endsWith('_SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SELL')
  );
}

function idLooksLikeOppositeFamily(id = '') {
  const value = cleanSideText(id);

  if (!value) return false;

  return (
    value.includes('MICRO_LONG_') ||
    /^LONG_\d+$/u.test(value) ||
    value.startsWith('LONG_') ||
    value.includes('_LONG_') ||
    value.endsWith('_LONG') ||
    value.startsWith('BULL_') ||
    value.includes('_BULL_') ||
    value.endsWith('_BULL') ||
    value.startsWith('BUY_') ||
    value.includes('_BUY_') ||
    value.endsWith('_BUY') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=BUY')
  );
}

function inferSideFromIds(row = {}) {
  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  const longHit = idLooksLikeOppositeFamily(haystack);
  const shortHit = idLooksLikeTargetFamily(haystack);

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

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
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  const shortHit =
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    idLooksLikeTargetFamily(haystack);

  const longHit =
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    idLooksLikeOppositeFamily(haystack);

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.signalSide,
    row.entrySide,
    row.side
  ];

  for (const value of directSources) {
    const direct = normalizeTradeSide(value);

    if (KNOWN_TRADE_SIDES.has(direct)) return direct;
  }

  const fromIds = inferSideFromIds(row);

  if (KNOWN_TRADE_SIDES.has(fromIds)) return fromIds;

  const fromDefinitions = inferSideFromDefinitions(row);

  if (KNOWN_TRADE_SIDES.has(fromDefinitions)) return fromDefinitions;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
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

    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,

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

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function definitionHasSchema(row = {}, schema) {
  const target = String(schema || '').toUpperCase();

  if (!target) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${target}`)) {
    return true;
  }

  return String(row.definition || row.microDefinition || '').toUpperCase().includes(`SCHEMA=${target}`);
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
    row.familyMacroId ||
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

  if (row.isTrueMicro === true || row.trueMicro === true) return true;
  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (row.isLegacyMacro === true) return false;
  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return Boolean(parentMacroFamilyId(row));
}

function isKnownTrueMicroFamilyId(id = '') {
  const { microSchema, macroSchema } = schemaConfig();

  if (!id) return false;
  if (!idLooksLikeTargetFamily(id)) return false;
  if (idHasSchema(id, macroSchema)) return false;

  return (
    idHasSchema(id, microSchema) ||
    String(id).toUpperCase().startsWith('MICRO_SHORT_')
  );
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

function buildSelectedAlertContext(activeRotation) {
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

  const selectedMicroFamilyIds = configuredIds.filter((id) => {
    if (!idLooksLikeTargetFamily(id)) return false;

    const row = rowByAnyMicroId.get(id) || rowByMicroId.get(id);

    if (row && isTrueMicroFamilyRow(row)) return true;

    return isKnownTrueMicroFamilyId(id);
  });

  const selectedMicroSet = new Set(selectedMicroFamilyIds);

  const selectedMicroAliasIds = uniqueStrings([
    ...selectedMicroFamilyIds,
    ...rows.flatMap((row) => {
      const exact = rowMicroId(row);

      if (!exact || !selectedMicroSet.has(exact)) return [];

      return rowMicroAliasIds(row, {
        includeCoarse: includeCoarseAliases
      });
    })
  ]);

  const selectedMicroAliasSet = new Set(selectedMicroAliasIds);

  const selectedMacroFamilyIds = uniqueStrings([
    ...(Array.isArray(activeRotation?.macroFamilyIds) ? activeRotation.macroFamilyIds : []),
    ...(Array.isArray(activeRotation?.activeMacroFamilyIds) ? activeRotation.activeMacroFamilyIds : []),
    ...(Array.isArray(activeRotation?.macroIds) ? activeRotation.macroIds : []),
    ...rows.map(parentMacroFamilyId)
  ]).filter(idLooksLikeTargetFamily);

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
    selectedRotation: activeRotation || null,

    selectedMicroFamilyIds,
    selectedMicroSet,
    selectedMicroAliasIds,
    selectedMicroAliasSet,

    selectedMacroFamilyIds,

    rowByMicroId,
    rowByAnyMicroId,

    microToMacroFamilyId,
    macroToMicroFamilyIds,

    trueMicroOnly: activeRotation?.trueMicroOnly !== false,
    allowCoarseMicroAliasLiveEntries: includeCoarseAliases,

    empty: !selectedMicroFamilyIds.length,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    selectionPurpose: 'DISCORD_ALERT_ONLY'
  };
}

function rowMatchesSelectedAlertMicro(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) return false;

  const aliases = rowMicroAliasIds(row, {
    includeCoarse: alertContext.allowCoarseMicroAliasLiveEntries
  });

  return aliases.some((id) => (
    alertContext.selectedMicroSet.has(id) ||
    alertContext.selectedMicroAliasSet.has(id)
  ));
}

function getSelectedWeeklyStats(alertContext, microFamilyId, row = {}) {
  if (!alertContext) return null;

  const directId = String(microFamilyId || '').trim();

  if (directId) {
    const direct = alertContext.rowByMicroId.get(directId) ||
      alertContext.rowByAnyMicroId.get(directId);

    if (direct) return direct;
  }

  for (const aliasId of rowMicroAliasIds(row, {
    includeCoarse: alertContext.allowCoarseMicroAliasLiveEntries
  })) {
    const stats = alertContext.rowByAnyMicroId.get(aliasId);

    if (stats) return stats;
  }

  return null;
}

function hasValidRiskShape(row = {}) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);
  const rr = safeNumber(row.rr, 0);
  const tradeSide = inferRowTradeSide(row);

  if (row.learningOnly === true) return false;
  if (tradeSide !== TARGET_TRADE_SIDE) return false;

  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;

  return sl > entry && tp < entry;
}

function validateVirtualEntry(row = {}) {
  const cfg = tradeConfig();
  const tradeSide = inferRowTradeSide(row);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      tradeSide
    };
  }

  if (isMirrorAnalysisRow(row)) {
    return {
      ok: false,
      reason: 'MIRROR_ANALYSIS_ONLY'
    };
  }

  if (row.syntheticRisk && !cfg.allowSyntheticRiskVirtualEntries) {
    return {
      ok: false,
      reason: 'SYNTHETIC_RISK_NOT_ALLOWED_FOR_VIRTUAL_TRACKING',
      syntheticRisk: true,
      syntheticRiskReason: row.syntheticRiskReason || null
    };
  }

  if (!hasValidRiskShape(row)) {
    return {
      ok: false,
      reason: row.liveEntryBlockedReason || 'SHORT_RISK_INVALID'
    };
  }

  return {
    ok: true,
    reason: 'SHORT_VIRTUAL_RISK_VALID'
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
  return inferRowTradeSide(candidate);
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

      scannerSide: TARGET_TRADE_SIDE,
      actualScannerSide: TARGET_TRADE_SIDE,
      analysisSide: TARGET_TRADE_SIDE,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_SCANNER_SIDE,
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
    targetScannerSide: TARGET_SCANNER_SIDE,
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

  const rr = Math.max(
    cfg.minRR,
    cfg.defaultRR,
    0.5
  );

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
      'LONG_DISABLED_SHORT_ONLY_SYSTEM'
    );
  }

  const hasShortMetrics = metricsRows.some((row) => (
    inferRowTradeSide(row) === TARGET_TRADE_SIDE &&
    hasValidRiskShape(row)
  ));

  if (hasShortMetrics) return null;

  return waitAction(
    {
      ...normalized,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE
    },
    'SHORT_RISK_INVALID_OBSERVATION_ONLY'
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

  const scannerSide = inferRowTradeSide(normalized);

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
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE
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
      const rowSide = inferRowTradeSide(row);

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

function buildVirtualEntryAction({
  row,
  alertContext,
  selectedWeeklyStats,
  riskFraction,
  virtualGate,
  discordAlertEligible
}) {
  const microFamilyId = rowMicroId(row);

  const selectedMacroFamilyId =
    parentMacroFamilyId(row) ||
    alertContext.microToMacroFamilyId[microFamilyId] ||
    alertContext.microToMacroFamilyId[row.microFamilyId] ||
    null;

  return {
    ...row,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    action: 'VIRTUAL_ENTRY',
    reason: 'SHORT_VIRTUAL_RISK_VALID',

    source: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,

    selectedMicroFamilyAlert: Boolean(discordAlertEligible),
    discordAlertEligible: Boolean(discordAlertEligible),
    discordAlertReason: discordAlertEligible
      ? 'SELECTED_SHORT_TRUE_MICRO_FAMILY_MATCH'
      : alertContext.empty
        ? 'NO_MANUAL_MICRO_FAMILY_SELECTED'
        : 'MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT',

    selectedMacroFamilyId,
    activeMacroFamilyId: selectedMacroFamilyId,

    selectedWeeklyStats,
    weeklyStats: selectedWeeklyStats,

    riskFraction,
    virtualGate,

    btcRelation: row.btcRelation,

    liveEligible: Boolean(discordAlertEligible),

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    entryCreatedAt: now()
  };
}

function maybeSendDiscordEntryAlert(entry = {}) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      reason: entry.discordAlertReason || 'MICRO_FAMILY_NOT_SELECTED_FOR_DISCORD_ALERT'
    };
  }

  sendEntryAlert(entry).catch(() => null);

  return {
    sent: false,
    skipped: false,
    queued: true,
    fireAndForget: true,
    reason: 'DISCORD_ENTRY_ALERT_QUEUED_FIRE_AND_FORGET'
  };
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

  const realExits = [];
  const shadowExits = await monitorOpenPositions({ priceFetcher });

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
  const alertContext = buildSelectedAlertContext(activeRotation);

  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .filter((candidate) => candidateTradeSide(candidate) === TARGET_TRADE_SIDE)
    .slice(0, cfg.maxCandidatesPerSnapshot)
    .map((candidate) => ({
      ...candidate,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      scannerSide: TARGET_TRADE_SIDE,
      actualScannerSide: TARGET_TRADE_SIDE,
      analysisSide: TARGET_TRADE_SIDE,

      btcState: snapshot.btcState,
      regime: snapshot.regime,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false
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

  let entryRows = 0;
  let waitRows = earlyActions.length;

  let virtualCreatedRows = 0;
  let virtualSkippedRows = 0;
  let virtualFailedRows = 0;

  let discordAlertEligibleRows = 0;
  let discordAlertsQueued = 0;
  let discordAlertsSkippedNoSelectedMicro = 0;

  let selectedMicroMatchRows = 0;
  let unselectedMicroEntryRows = 0;

  for (const row of analyzedRows) {
    const microFamilyId = rowMicroId(row);

    if (!isTargetRow(row)) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM',
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: false,
        liveEligible: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const virtualGate = validateVirtualEntry(row);

    if (!virtualGate.ok) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: virtualGate.reason,
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(row) || null,
        virtualGate,
        virtualTracked: false,
        liveEligible: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const alreadyOpen = await getOpenPosition(row.symbol);

    if (alreadyOpen) {
      waitRows += 1;
      virtualSkippedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION',
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: true,
        liveEligible: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });

      continue;
    }

    const selectedWeeklyStats = getSelectedWeeklyStats(
      alertContext,
      microFamilyId,
      row
    );

    const sizingStats = selectedWeeklyStats || row;

    const riskFraction = sizing.enabled
      ? riskFractionForEntry({ weeklyStats: sizingStats })
      : sizing.baseRiskPct;

    const discordAlertEligible = rowMatchesSelectedAlertMicro(alertContext, row);

    if (discordAlertEligible) {
      discordAlertEligibleRows += 1;
      selectedMicroMatchRows += 1;
    } else {
      discordAlertsSkippedNoSelectedMicro += 1;
      unselectedMicroEntryRows += 1;
    }

    const entry = buildVirtualEntryAction({
      row,
      alertContext,
      selectedWeeklyStats,
      riskFraction,
      virtualGate,
      discordAlertEligible
    });

    try {
      const position = buildOpenPositionFromEntry(entry);

      await saveOpenPosition(position);
      openPositions.push(position);

      entryRows += 1;
      virtualCreatedRows += 1;

      const discordResult = maybeSendDiscordEntryAlert(entry);

      if (discordResult.queued) discordAlertsQueued += 1;

      actions.push({
        ...entry,
        discordAlertResult: discordResult,
        discordAlertQueued: Boolean(discordResult.queued),
        discordAlertSent: false
      });
    } catch (error) {
      waitRows += 1;
      virtualFailedRows += 1;

      actions.push({
        ...row,
        microFamilyId,
        trueMicroFamilyId: microFamilyId,
        action: 'WAIT',
        reason: 'VIRTUAL_POSITION_CREATE_FAILED',
        error: error?.message || String(error),
        selectedRotationId: alertContext.rotationId,
        activeRotationId: alertContext.rotationId,
        virtualTracked: false,
        liveEligible: false,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      });
    }
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

      entryRows,
      waitRows,

      virtualCreatedRows,
      virtualSkippedRows,
      virtualFailedRows,

      shadowCreatedRows: virtualCreatedRows,
      shadowSkippedRows: virtualSkippedRows,
      shadowFailedRows: virtualFailedRows,
      shadowDisabled: false,

      discordAlertEligibleRows,
      discordAlertsQueued,
      discordAlertsSent: 0,
      discordAlertsSkippedNoSelectedMicro,

      selectedMicroMatchRows,
      unselectedMicroEntryRows,

      actions: actions.length,

      selectedRotationId: alertContext.rotationId,
      activeRotationId: alertContext.rotationId,

      selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      selectedMacroFamilies: alertContext.selectedMacroFamilyIds.length,
      selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
      selectedMicroAliasIds: alertContext.selectedMicroAliasIds,
      selectedMacroFamilyIds: alertContext.selectedMacroFamilyIds,

      activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,
      activeMacroFamilies: alertContext.selectedMacroFamilyIds.length,
      activeMicroFamilyIds: alertContext.selectedMicroFamilyIds,
      activeMicroAliasIds: alertContext.selectedMicroAliasIds,
      activeMacroFamilyIds: alertContext.selectedMacroFamilyIds,

      trueMicroOnly: alertContext.trueMicroOnly,
      allowCoarseMicroAliasLiveEntries: alertContext.allowCoarseMicroAliasLiveEntries,

      selectionPurpose: 'DISCORD_ALERT_ONLY'
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

    entryRows,
    waitRows,

    virtualCreatedRows,
    virtualSkippedRows,
    virtualFailedRows,

    shadowCreatedRows: virtualCreatedRows,
    shadowSkippedRows: virtualSkippedRows,
    shadowFailedRows: virtualFailedRows,
    shadowDisabled: false,

    discordAlertEligibleRows,
    discordAlertsQueued,
    discordAlertsSent: 0,
    discordAlertsSkippedNoSelectedMicro,

    selectedMicroMatchRows,
    unselectedMicroEntryRows,

    actions,
    actionCounts: actionCounts(actions),

    realExits,
    shadowExits,

    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,

    selectedMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    selectedMacroFamilies: alertContext.selectedMacroFamilyIds.length,
    selectedMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    selectedMicroAliasIds: alertContext.selectedMicroAliasIds,
    selectedMacroFamilyIds: alertContext.selectedMacroFamilyIds,

    activeMicroFamilies: alertContext.selectedMicroFamilyIds.length,
    activeMacroFamilies: alertContext.selectedMacroFamilyIds.length,
    activeMicroFamilyIds: alertContext.selectedMicroFamilyIds,
    activeMicroAliasIds: alertContext.selectedMicroAliasIds,
    activeMacroFamilyIds: alertContext.selectedMacroFamilyIds,

    trueMicroOnly: alertContext.trueMicroOnly,
    allowCoarseMicroAliasLiveEntries: alertContext.allowCoarseMicroAliasLiveEntries,

    selectionPurpose: 'DISCORD_ALERT_ONLY',

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