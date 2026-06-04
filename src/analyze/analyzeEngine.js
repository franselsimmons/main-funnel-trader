// ================= FILE: src/analyze/analyzeEngine.js =================

import { gzipSync, gunzipSync } from 'zlib';
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  classifyMicroFamily,
  classifyMacroFamily,
  isMicroFamilyV1Id,
  isMicroFamilyV2Id
} from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

const WEEK_MICROS_CODEC = 'ANALYZE_WEEK_MICROS_GZIP_V1';
const WEEK_MICRO_ROW_CODEC = 'ANALYZE_WEEK_MICRO_ROW_GZIP_V1';

const DEFAULT_MAX_REDIS_SET_BYTES = 9_500_000;
const DEFAULT_MAX_ROW_SET_BYTES = 250_000;

function now() {
  return Date.now();
}

function normalizeSource(source) {
  return String(source || 'REAL').toUpperCase();
}

function isLongSide(side) {
  return sideToTradeSide(side) === 'LONG';
}

function getAnalyzeSchemaMeta() {
  return {
    schema: CONFIG?.analyze?.schema,
    macroSchema: CONFIG?.analyze?.macroSchema || CONFIG?.analyze?.schema || 'MF_V1',
    microSchema: CONFIG?.analyze?.microSchema || 'MF_V2',
    strategyVersion: CONFIG.strategyVersion
  };
}

function getWeekStorageConfig() {
  return {
    compressionEnabled: CONFIG.analyze?.weekMicrosCompressionEnabled !== false,

    compressionLevel: Math.max(
      1,
      Math.min(9, Math.floor(safeNumber(CONFIG.analyze?.weekMicrosCompressionLevel, 6)))
    ),

    maxRedisSetBytes: Math.max(
      500_000,
      Math.floor(safeNumber(CONFIG.redis?.maxRequestBytes, DEFAULT_MAX_REDIS_SET_BYTES))
    ),

    maxRowSetBytes: Math.max(
      50_000,
      Math.floor(safeNumber(CONFIG.analyze?.maxMicroRowSetBytes, DEFAULT_MAX_ROW_SET_BYTES))
    ),

    weekMicrosTtlSec: Math.max(
      60 * 60,
      Math.floor(safeNumber(CONFIG.analyze?.weekMicrosTtlSec, 60 * 60 * 24 * 21))
    ),

    weekMetaTtlSec: Math.max(
      60 * 60,
      Math.floor(safeNumber(CONFIG.analyze?.weekMetaTtlSec, 60 * 60 * 24 * 90))
    ),

    storageConcurrency: Math.max(
      1,
      Math.min(20, Math.floor(safeNumber(CONFIG.analyze?.storageConcurrency, 8)))
    ),

    maxExamplesPerMicro: Math.max(
      0,
      Math.floor(safeNumber(CONFIG.analyze?.maxExamplesPerMicro, 8))
    ),

    maxRecentOutcomesPerMicro: Math.max(
      0,
      Math.floor(safeNumber(CONFIG.analyze?.maxRecentOutcomesPerMicro, 8))
    ),

    maxDefinitionPartsPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxDefinitionPartsPerMicro, 64))
    ),

    maxParentDefinitionPartsPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxParentDefinitionPartsPerMicro, 48))
    ),

    maxCounterKeysPerMicro: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxCounterKeysPerMicro, 18))
    ),

    maxCounterValuesPerCounter: Math.max(
      4,
      Math.floor(safeNumber(CONFIG.analyze?.maxCounterValuesPerCounter, 24))
    ),

    maxStringLength: Math.max(
      80,
      Math.floor(safeNumber(CONFIG.analyze?.maxStoredStringLength, 480))
    )
  };
}

function getWeekMicrosBaseKey(weekKey) {
  return KEYS.analyze.weekMicros(weekKey);
}

function getWeekMicrosIndexKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:INDEX`;
}

function getWeekMicroRowKey(weekKey, microFamilyId) {
  return `${getWeekMicrosBaseKey(weekKey)}:ROW:${microFamilyId}`;
}

async function mapLimit(items = [], concurrency = 8, worker) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(rows.length);

  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(rows[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, rows.length) },
      () => runWorker()
    )
  );

  return results;
}

function normalizeStatsSide(side, classified = {}) {
  if (classified.side) return classified.side;

  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return String(side || 'unknown').toLowerCase();
}

function hasUsableDefinitionParts(value) {
  return Array.isArray(value) && value.length > 0;
}

function shouldReclassifyAsTrueMicro(row = {}) {
  if (!row.microFamilyId || !row.familyId) return true;

  if (isMicroFamilyV1Id(row.microFamilyId)) return true;

  if (isMicroFamilyV2Id(row.microFamilyId)) return false;

  return !row.parentMacroFamilyId && !row.macroFamilyId;
}

function truncateString(value, maxLength = 480) {
  const text = String(value ?? '');

  if (text.length <= maxLength) return text;

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactDefinitionParts(parts = [], maxItems = 64, maxStringLength = 480) {
  if (!Array.isArray(parts)) return [];

  return parts
    .slice(0, maxItems)
    .map((part) => truncateString(part, maxStringLength))
    .filter(Boolean);
}

function compactCounterValues(counter = {}, maxValues = 24) {
  if (!counter || typeof counter !== 'object') return {};

  return Object.fromEntries(
    Object.entries(counter)
      .sort((a, b) => safeNumber(b[1], 0) - safeNumber(a[1], 0))
      .slice(0, maxValues)
      .map(([key, value]) => [
        truncateString(key, 160),
        safeNumber(value, 0)
      ])
  );
}

function compactCounters(counters = {}, maxKeys = 18, maxValues = 24) {
  if (!counters || typeof counters !== 'object') return {};

  return Object.fromEntries(
    Object.entries(counters)
      .slice(0, maxKeys)
      .map(([key, value]) => [
        truncateString(key, 160),
        compactCounterValues(value, maxValues)
      ])
  );
}

function compactExample(example, maxStringLength = 480) {
  if (typeof example === 'string') {
    return truncateString(example, maxStringLength);
  }

  if (!example || typeof example !== 'object') {
    return example ?? null;
  }

  return {
    symbol: example.symbol || example.baseSymbol || example.contractSymbol || null,
    side: example.side || null,
    rsiZone: example.rsiZone || null,
    rsiCoarse: example.rsiCoarse || null,
    flow: example.flow || null,
    flowCoarse: example.flowCoarse || null,
    obRelation: example.obRelation || null,
    btcRelation: example.btcRelation || null,
    btcState: example.btcState || null,
    regime: example.regime || null,
    scannerReason: example.scannerReason || null,
    scannerReasonCoarse: example.scannerReasonCoarse || null,
    ts: safeNumber(example.ts || example.createdAt, null)
  };
}

function compactExamples(examples = [], maxItems = 8, maxStringLength = 480) {
  if (!Array.isArray(examples) || maxItems <= 0) return [];

  return examples
    .slice(-maxItems)
    .map((example) => compactExample(example, maxStringLength))
    .filter((example) => example !== null && example !== undefined);
}

function compactOutcome(outcome = {}) {
  if (!outcome || typeof outcome !== 'object') return null;

  return {
    source: outcome.source || null,

    tradeId: outcome.tradeId || null,
    shadowId: outcome.shadowId || outcome.id || null,

    symbol: outcome.symbol || outcome.baseSymbol || outcome.contractSymbol || null,
    contractSymbol: outcome.contractSymbol || null,
    side: outcome.side || null,
    tradeSide: outcome.tradeSide || sideToTradeSide(outcome.side),

    exitReason: outcome.exitReason || outcome.reason || null,

    exitR: safeNumber(outcome.exitR ?? outcome.netR, 0),
    netR: safeNumber(outcome.netR ?? outcome.exitR, 0),
    grossR: safeNumber(outcome.grossR, 0),

    pnlPct: safeNumber(outcome.pnlPct ?? outcome.netPnlPct, 0),
    netPnlPct: safeNumber(outcome.netPnlPct ?? outcome.pnlPct, 0),
    grossPnlPct: safeNumber(outcome.grossPnlPct, 0),

    costR: safeNumber(outcome.costR, 0),
    costPct: safeNumber(outcome.costPct, 0),

    mfeR: safeNumber(outcome.mfeR, 0),
    maeR: safeNumber(outcome.maeR, 0),

    directToSL: Boolean(outcome.directToSL),
    nearTpSeen: Boolean(outcome.nearTpSeen),
    reachedHalfR: Boolean(outcome.reachedHalfR),
    reachedOneR: Boolean(outcome.reachedOneR),

    beArmed: Boolean(outcome.beArmed),
    beWouldExit: Boolean(outcome.beWouldExit),
    beExitR: safeNumber(outcome.beExitR, 0),

    gaveBackAfterHalfR: Boolean(outcome.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(outcome.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(outcome.nearTpThenLoss),

    ts: safeNumber(
      outcome.ts ||
      outcome.closedAt ||
      outcome.completedAt ||
      outcome.updatedAt,
      now()
    )
  };
}

function compactRecentOutcomes(outcomes = [], maxItems = 8) {
  if (!Array.isArray(outcomes) || maxItems <= 0) return [];

  return outcomes
    .slice(-maxItems)
    .map(compactOutcome)
    .filter(Boolean);
}

function removeKnownBulkyFields(row = {}) {
  const clean = { ...row };

  const bulkyKeys = [
    'raw',
    'payload',
    'debug',
    'request',
    'response',
    'stack',
    'html',
    'candles',
    'candles15m',
    'candles1h',
    'candles4h',
    'candles1d',
    'orderBook',
    'rawOrderBook',
    'bids',
    'asks',
    'ticks',
    'prices',
    'history',
    'marketData'
  ];

  for (const key of bulkyKeys) {
    delete clean[key];
  }

  return clean;
}

function enrichWithMicroFamily(row = {}) {
  const classified = classifyMicroFamily(row);
  const macro = classifyMacroFamily(row);

  if (shouldReclassifyAsTrueMicro(row)) {
    return {
      ...row,

      familyId: classified.familyId,
      microFamilyId: classified.microFamilyId,

      macroFamilyId: classified.macroFamilyId || macro.microFamilyId,
      parentMacroFamilyId: classified.parentMacroFamilyId || macro.microFamilyId,
      parentMicroFamilyId: classified.parentMicroFamilyId || macro.microFamilyId,

      definitionParts: hasUsableDefinitionParts(row.definitionParts)
        ? row.definitionParts
        : classified.definitionParts,

      definition: row.definition || classified.definition,

      parentDefinition: row.parentDefinition || classified.parentDefinition || macro.definition,
      parentDefinitionParts: hasUsableDefinitionParts(row.parentDefinitionParts)
        ? row.parentDefinitionParts
        : classified.parentDefinitionParts || macro.definitionParts,

      schema: classified.schema,
      microFamilySchema: classified.schema,
      version: classified.version,

      side: classified.side || row.side,
      tradeSide: classified.tradeSide || sideToTradeSide(row.side),

      assetClass: classified.assetClass || row.assetClass,

      obRelation: classified.obRelation || row.obRelation,
      btcRelation: classified.btcRelation || row.btcRelation,
      btcState: classified.btcState || row.btcState,

      flow: classified.flow || row.flow,
      flowCoarse: classified.flowCoarse || row.flowCoarse,

      regime: classified.regime || row.regime,
      regimeCoarse: classified.regimeCoarse || row.regimeCoarse,

      scannerReason: classified.scannerReason || row.scannerReason,
      scannerReasonCoarse: classified.scannerReasonCoarse || row.scannerReasonCoarse,

      rsiZone: classified.rsiZone || row.rsiZone,
      rsiCoarse: classified.rsiCoarse || row.rsiCoarse,

      spreadBps: classified.spreadBps ?? row.spreadBps
    };
  }

  return {
    ...row,

    familyId: row.familyId || classified.familyId,

    macroFamilyId: row.macroFamilyId || row.parentMacroFamilyId || classified.macroFamilyId || macro.microFamilyId,
    parentMacroFamilyId: row.parentMacroFamilyId || row.macroFamilyId || classified.parentMacroFamilyId || macro.microFamilyId,
    parentMicroFamilyId: row.parentMicroFamilyId || row.parentMacroFamilyId || row.macroFamilyId || classified.parentMicroFamilyId || macro.microFamilyId,

    definitionParts: hasUsableDefinitionParts(row.definitionParts)
      ? row.definitionParts
      : classified.definitionParts,

    definition: row.definition || classified.definition,

    parentDefinition: row.parentDefinition || classified.parentDefinition || macro.definition,
    parentDefinitionParts: hasUsableDefinitionParts(row.parentDefinitionParts)
      ? row.parentDefinitionParts
      : classified.parentDefinitionParts || macro.definitionParts,

    schema: row.schema || classified.schema,
    microFamilySchema: row.microFamilySchema || row.schema || classified.schema,
    version: row.version || classified.version,

    side: row.side || classified.side,
    tradeSide: row.tradeSide || classified.tradeSide || sideToTradeSide(row.side),

    assetClass: row.assetClass || classified.assetClass,

    obRelation: row.obRelation || classified.obRelation,
    btcRelation: row.btcRelation || classified.btcRelation,
    btcState: row.btcState || classified.btcState,

    flow: row.flow || classified.flow,
    flowCoarse: row.flowCoarse || classified.flowCoarse,

    regime: row.regime || classified.regime,
    regimeCoarse: row.regimeCoarse || classified.regimeCoarse,

    scannerReason: row.scannerReason || classified.scannerReason,
    scannerReasonCoarse: row.scannerReasonCoarse || classified.scannerReasonCoarse,

    rsiZone: row.rsiZone || classified.rsiZone,
    rsiCoarse: row.rsiCoarse || classified.rsiCoarse,

    spreadBps: row.spreadBps ?? classified.spreadBps
  };
}

function compactMicroForStorage(row = {}, aggressive = false) {
  const cfg = getWeekStorageConfig();
  const refreshed = refreshStats(removeKnownBulkyFields(row));

  const maxStringLength = aggressive
    ? Math.max(80, Math.floor(cfg.maxStringLength / 2))
    : cfg.maxStringLength;

  const definitionParts = compactDefinitionParts(
    refreshed.definitionParts,
    aggressive ? 32 : cfg.maxDefinitionPartsPerMicro,
    maxStringLength
  );

  const parentDefinitionParts = compactDefinitionParts(
    refreshed.parentDefinitionParts,
    aggressive ? 24 : cfg.maxParentDefinitionPartsPerMicro,
    maxStringLength
  );

  return {
    ...refreshed,

    definitionParts,
    definition: definitionParts.length
      ? definitionParts.join(' | ')
      : truncateString(refreshed.definition || '', maxStringLength * 4),

    parentDefinitionParts,
    parentDefinition: parentDefinitionParts.length
      ? parentDefinitionParts.join(' | ')
      : truncateString(refreshed.parentDefinition || '', maxStringLength * 4),

    counters: aggressive
      ? {}
      : compactCounters(
        refreshed.counters,
        cfg.maxCounterKeysPerMicro,
        cfg.maxCounterValuesPerCounter
      ),

    examples: compactExamples(
      refreshed.examples,
      aggressive ? Math.min(3, cfg.maxExamplesPerMicro) : cfg.maxExamplesPerMicro,
      maxStringLength
    ),

    recentOutcomes: compactRecentOutcomes(
      refreshed.recentOutcomes,
      aggressive ? Math.min(3, cfg.maxRecentOutcomesPerMicro) : cfg.maxRecentOutcomesPerMicro
    )
  };
}

function getMinimalMicroForStorage(row = {}) {
  const refreshed = refreshStats(removeKnownBulkyFields(row));

  return {
    microFamilyId: refreshed.microFamilyId,
    familyId: refreshed.familyId,
    side: refreshed.side,
    tradeSide: refreshed.tradeSide,

    schema: refreshed.schema,
    microFamilySchema: refreshed.microFamilySchema,
    version: refreshed.version,

    macroFamilyId: refreshed.macroFamilyId,
    parentMacroFamilyId: refreshed.parentMacroFamilyId,
    parentMicroFamilyId: refreshed.parentMicroFamilyId,

    definitionParts: compactDefinitionParts(refreshed.definitionParts, 24, 180),
    definition: truncateString(refreshed.definition || '', 800),

    parentDefinitionParts: compactDefinitionParts(refreshed.parentDefinitionParts, 18, 180),
    parentDefinition: truncateString(refreshed.parentDefinition || '', 800),

    assetClass: refreshed.assetClass,

    obRelation: refreshed.obRelation,
    btcRelation: refreshed.btcRelation,
    btcState: refreshed.btcState,

    flow: refreshed.flow,
    flowCoarse: refreshed.flowCoarse,

    regime: refreshed.regime,
    regimeCoarse: refreshed.regimeCoarse,

    scannerReason: refreshed.scannerReason,
    scannerReasonCoarse: refreshed.scannerReasonCoarse,

    rsiZone: refreshed.rsiZone,
    rsiCoarse: refreshed.rsiCoarse,
    spreadBps: refreshed.spreadBps,

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: safeNumber(refreshed.realCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    wins: safeNumber(refreshed.wins, 0),
    losses: safeNumber(refreshed.losses, 0),
    flats: safeNumber(refreshed.flats, 0),

    realWins: safeNumber(refreshed.realWins, 0),
    realLosses: safeNumber(refreshed.realLosses, 0),
    realFlats: safeNumber(refreshed.realFlats, 0),

    shadowWins: safeNumber(refreshed.shadowWins, 0),
    shadowLosses: safeNumber(refreshed.shadowLosses, 0),
    shadowFlats: safeNumber(refreshed.shadowFlats, 0),

    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),

    totalR: safeNumber(refreshed.totalR, 0),
    realTotalR: safeNumber(refreshed.realTotalR, 0),
    shadowTotalR: safeNumber(refreshed.shadowTotalR, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),

    directSLCount: safeNumber(refreshed.directSLCount, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),

    nearTpCount: safeNumber(refreshed.nearTpCount, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),

    reachedHalfRCount: safeNumber(refreshed.reachedHalfRCount, 0),
    reachedOneRCount: safeNumber(refreshed.reachedOneRCount, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitCount: safeNumber(refreshed.beWouldExitCount, 0),
    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),

    gaveBackAfterHalfRCount: safeNumber(refreshed.gaveBackAfterHalfRCount, 0),
    gaveBackAfterOneRCount: safeNumber(refreshed.gaveBackAfterOneRCount, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),

    nearTpThenLossCount: safeNumber(refreshed.nearTpThenLossCount, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    sampleReliability: safeNumber(refreshed.sampleReliability, 0),
    balancedScore: safeNumber(refreshed.balancedScore, 0),

    examples: compactExamples(refreshed.examples, 2, 120),
    recentOutcomes: compactRecentOutcomes(refreshed.recentOutcomes, 2),

    createdAt: refreshed.createdAt || null,
    updatedAt: refreshed.updatedAt || now()
  };
}

function getOrCreateMicro(micros, classified, side) {
  const microFamilyId = classified.microFamilyId;
  const familyId = classified.familyId;

  if (!microFamilyId) {
    throw new Error('MICRO_FAMILY_ID_MISSING');
  }

  if (!familyId) {
    throw new Error('FAMILY_ID_MISSING');
  }

  const normalizedSide = normalizeStatsSide(side, classified);

  if (!micros[microFamilyId]) {
    micros[microFamilyId] = createMicroStats({
      microFamilyId,
      familyId,
      side: normalizedSide,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[microFamilyId];

  micro.microFamilyId ||= microFamilyId;
  micro.familyId ||= familyId;
  micro.side ||= normalizedSide;
  micro.tradeSide ||= classified.tradeSide || sideToTradeSide(side);

  micro.schema ||= classified.schema || classified.microFamilySchema || getAnalyzeSchemaMeta().microSchema;
  micro.microFamilySchema ||= classified.microFamilySchema || classified.schema || getAnalyzeSchemaMeta().microSchema;
  micro.version ||= classified.version || 'micro';

  micro.macroFamilyId ||= classified.macroFamilyId || classified.parentMacroFamilyId || null;
  micro.parentMacroFamilyId ||= classified.parentMacroFamilyId || classified.macroFamilyId || null;
  micro.parentMicroFamilyId ||= classified.parentMicroFamilyId || classified.parentMacroFamilyId || classified.macroFamilyId || null;

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts ||= classified.parentDefinitionParts || [];

  micro.definitionParts ||= classified.definitionParts || [];
  micro.definition ||= classified.definition || micro.definitionParts.join(' | ');

  micro.assetClass ||= classified.assetClass || null;

  micro.obRelation ||= classified.obRelation || null;
  micro.btcRelation ||= classified.btcRelation || null;
  micro.btcState ||= classified.btcState || null;

  micro.flow ||= classified.flow || null;
  micro.flowCoarse ||= classified.flowCoarse || null;

  micro.regime ||= classified.regime || null;
  micro.regimeCoarse ||= classified.regimeCoarse || null;

  micro.scannerReason ||= classified.scannerReason || null;
  micro.scannerReasonCoarse ||= classified.scannerReasonCoarse || null;

  micro.rsiZone ||= classified.rsiZone || null;
  micro.rsiCoarse ||= classified.rsiCoarse || null;

  if (classified.spreadBps !== undefined && micro.spreadBps === undefined) {
    micro.spreadBps = classified.spreadBps;
  }

  return micro;
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(
    Object.entries(micros || {})
      .filter(([id, row]) => id && row)
      .map(([id, row]) => {
        const microFamilyId = row.microFamilyId || id;

        return [
          microFamilyId,
          compactMicroForStorage({
            ...row,
            microFamilyId
          })
        ];
      })
  );
}

function maybeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeCompressedBase64(data) {
  const buffer = Buffer.from(data, 'base64');
  const json = gunzipSync(buffer).toString('utf8');

  return JSON.parse(json);
}

function decodeStoragePayload(payload) {
  const parsed = maybeParseJson(payload);

  if (!parsed) return {};

  if (
    typeof parsed === 'object' &&
    [WEEK_MICROS_CODEC, WEEK_MICRO_ROW_CODEC].includes(parsed.codec) &&
    typeof parsed.data === 'string'
  ) {
    return decodeCompressedBase64(parsed.data);
  }

  if (
    typeof parsed === 'object' &&
    parsed.__compressed === true &&
    parsed.codec === 'gzip-base64' &&
    typeof parsed.data === 'string'
  ) {
    return decodeCompressedBase64(parsed.data);
  }

  if (typeof parsed === 'object') {
    return parsed;
  }

  throw new Error('STORAGE_PAYLOAD_UNREADABLE');
}

function encodeStoragePayload(value = {}, {
  codec,
  maxBytes,
  count,
  extraMeta = {}
} = {}) {
  const cfg = getWeekStorageConfig();
  const schemaMeta = getAnalyzeSchemaMeta();

  const json = JSON.stringify(value || {});
  const rawBytes = Buffer.byteLength(json, 'utf8');

  if (!cfg.compressionEnabled) {
    if (rawBytes > maxBytes) {
      const error = new Error('STORAGE_RAW_PAYLOAD_TOO_LARGE');
      error.details = {
        rawBytes,
        maxBytes,
        count
      };
      throw error;
    }

    return {
      payload: json,
      meta: {
        compressed: false,
        codec: 'json',
        rawBytes,
        payloadBytes: rawBytes,
        count,
        ...extraMeta
      }
    };
  }

  const compressed = gzipSync(Buffer.from(json, 'utf8'), {
    level: cfg.compressionLevel
  });

  const wrapper = {
    codec,
    compressed: true,

    rawBytes,
    compressedBytes: compressed.length,

    count,

    schema: schemaMeta.schema,
    macroSchema: schemaMeta.macroSchema,
    microSchema: schemaMeta.microSchema,
    strategyVersion: schemaMeta.strategyVersion,

    encodedAt: now(),
    data: compressed.toString('base64'),

    ...extraMeta
  };

  const payload = JSON.stringify(wrapper);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');

  if (payloadBytes > maxBytes) {
    const error = new Error('STORAGE_COMPRESSED_PAYLOAD_TOO_LARGE');
    error.details = {
      rawBytes,
      compressedBytes: compressed.length,
      payloadBytes,
      maxBytes,
      count,
      codec
    };
    throw error;
  }

  return {
    payload,
    meta: {
      compressed: true,
      codec,
      rawBytes,
      compressedBytes: compressed.length,
      payloadBytes,
      count,
      ...extraMeta
    }
  };
}

function encodeMicroRowPayload(row = {}) {
  const cfg = getWeekStorageConfig();

  try {
    return encodeStoragePayload(row, {
      codec: WEEK_MICRO_ROW_CODEC,
      maxBytes: cfg.maxRowSetBytes,
      count: 1,
      extraMeta: {
        microFamilyId: row.microFamilyId || null,
        rowMode: 'compact'
      }
    });
  } catch (firstError) {
    const aggressive = compactMicroForStorage(row, true);

    try {
      return encodeStoragePayload(aggressive, {
        codec: WEEK_MICRO_ROW_CODEC,
        maxBytes: cfg.maxRowSetBytes,
        count: 1,
        extraMeta: {
          microFamilyId: row.microFamilyId || null,
          rowMode: 'aggressive'
        }
      });
    } catch {
      const minimal = getMinimalMicroForStorage(row);

      return encodeStoragePayload(minimal, {
        codec: WEEK_MICRO_ROW_CODEC,
        maxBytes: cfg.maxRowSetBytes,
        count: 1,
        extraMeta: {
          microFamilyId: row.microFamilyId || null,
          rowMode: 'minimal',
          previousError: firstError?.message || null
        }
      });
    }
  }
}

function encodeLegacyWeekMicrosPayload(micros = {}) {
  const cfg = getWeekStorageConfig();

  return encodeStoragePayload(micros, {
    codec: WEEK_MICROS_CODEC,
    maxBytes: cfg.maxRedisSetBytes,
    count: Object.keys(micros || {}).length,
    extraMeta: {
      storageMode: 'legacy-single-key'
    }
  });
}

async function getRawRedisValue(redis, key, fallback = null) {
  const direct = await redis.get(key).catch(() => undefined);

  if (direct !== undefined && direct !== null) return direct;

  return getJson(redis, key, fallback);
}

async function readWeekMicrosSharded(redis, weekKey) {
  const index = await getJson(
    redis,
    getWeekMicrosIndexKey(weekKey),
    null
  ).catch(() => null);

  if (!index || !Array.isArray(index.ids)) {
    return null;
  }

  const ids = index.ids.filter(Boolean);

  if (!ids.length) return {};

  const cfg = getWeekStorageConfig();

  const entries = await mapLimit(
    ids,
    cfg.storageConcurrency,
    async (id) => {
      const raw = await getRawRedisValue(
        redis,
        getWeekMicroRowKey(weekKey, id),
        null
      ).catch(() => null);

      if (!raw) return null;

      const row = decodeStoragePayload(raw);

      if (!row) return null;

      return [
        row.microFamilyId || id,
        row
      ];
    }
  );

  return Object.fromEntries(entries.filter(Boolean));
}

async function saveWeekMicrosSharded(redis, weekKey, micros) {
  const cfg = getWeekStorageConfig();

  const ids = Object.keys(micros || {})
    .filter(Boolean)
    .sort();

  const rowMeta = await mapLimit(
    ids,
    cfg.storageConcurrency,
    async (id) => {
      const row = {
        ...micros[id],
        microFamilyId: micros[id]?.microFamilyId || id
      };

      const encoded = encodeMicroRowPayload(row);

      await redis.set(
        getWeekMicroRowKey(weekKey, id),
        encoded.payload,
        {
          ex: cfg.weekMicrosTtlSec
        }
      );

      return {
        id,
        bytes: encoded.meta.payloadBytes,
        rawBytes: encoded.meta.rawBytes,
        compressedBytes: encoded.meta.compressedBytes || 0,
        rowMode: encoded.meta.rowMode || 'json'
      };
    }
  );

  const totalPayloadBytes = rowMeta.reduce(
    (sum, row) => sum + safeNumber(row.bytes, 0),
    0
  );

  const totalRawBytes = rowMeta.reduce(
    (sum, row) => sum + safeNumber(row.rawBytes, 0),
    0
  );

  const maxRowBytes = rowMeta.reduce(
    (max, row) => Math.max(max, safeNumber(row.bytes, 0)),
    0
  );

  const schemaMeta = getAnalyzeSchemaMeta();

  await setJson(
    redis,
    getWeekMicrosIndexKey(weekKey),
    {
      weekKey,
      ids,
      count: ids.length,

      storageMode: 'SHARDED_COMPRESSED_ROWS',
      codec: WEEK_MICRO_ROW_CODEC,

      totalPayloadBytes,
      totalRawBytes,
      maxRowBytes,

      updatedAt: now(),

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      strategyVersion: schemaMeta.strategyVersion
    },
    {
      ex: cfg.weekMicrosTtlSec
    }
  );

  // Oude single-key storage verwijderen. Die veroorzaakte de Upstash 10MB SET.
  await redis.del(getWeekMicrosBaseKey(weekKey)).catch(() => null);

  return {
    ids,
    rowMeta,
    totalPayloadBytes,
    totalRawBytes,
    maxRowBytes
  };
}

export async function getWeekMicros(weekKey = getIsoWeekKey()) {
  const redis = getDurableRedis();

  const sharded = await readWeekMicrosSharded(redis, weekKey);

  if (sharded !== null) {
    return normalizeMicros(sharded || {});
  }

  const raw = await getRawRedisValue(
    redis,
    getWeekMicrosBaseKey(weekKey),
    null
  );

  if (!raw) return {};

  const decoded = decodeStoragePayload(raw);

  return normalizeMicros(decoded || {});
}

export async function saveWeekMicros(weekKey, micros) {
  if (!weekKey) {
    throw new Error('WEEK_KEY_MISSING');
  }

  const redis = getDurableRedis();
  const cfg = getWeekStorageConfig();
  const clean = normalizeMicros(micros);
  const schemaMeta = getAnalyzeSchemaMeta();

  let storage;

  try {
    storage = await saveWeekMicrosSharded(
      redis,
      weekKey,
      clean
    );
  } catch (error) {
    // Fallback alleen voor extreme edge-cases. In normale flow blijft dit uit.
    const legacy = encodeLegacyWeekMicrosPayload(clean);

    await redis.set(
      getWeekMicrosBaseKey(weekKey),
      legacy.payload,
      {
        ex: cfg.weekMicrosTtlSec
      }
    );

    storage = {
      ids: Object.keys(clean),
      fallbackToLegacy: true,
      fallbackReason: error?.message || String(error),
      totalPayloadBytes: legacy.meta.payloadBytes,
      totalRawBytes: legacy.meta.rawBytes,
      maxRowBytes: 0
    };
  }

  await setJson(
    redis,
    KEYS.analyze.weekMeta(weekKey),
    {
      weekKey,
      updatedAt: now(),
      microFamilies: Object.keys(clean).length,

      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      strategyVersion: schemaMeta.strategyVersion,

      storage: {
        storageMode: storage.fallbackToLegacy
          ? 'LEGACY_COMPRESSED_SINGLE_KEY_FALLBACK'
          : 'SHARDED_COMPRESSED_ROWS',

        codec: storage.fallbackToLegacy
          ? WEEK_MICROS_CODEC
          : WEEK_MICRO_ROW_CODEC,

        count: storage.ids.length,

        totalPayloadBytes: storage.totalPayloadBytes,
        totalRawBytes: storage.totalRawBytes,
        maxRowBytes: storage.maxRowBytes,

        fallbackToLegacy: Boolean(storage.fallbackToLegacy),
        fallbackReason: storage.fallbackReason || null,

        ttlSec: cfg.weekMicrosTtlSec
      }
    },
    {
      ex: cfg.weekMetaTtlSec
    }
  );

  return clean;
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = getIsoWeekKey() } = {}
) {
  const rows = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean)
    : [];

  if (rows.length === 0) {
    return [];
  }

  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const analyzed = [];

  for (const metrics of rows) {
    const classified = enrichWithMicroFamily(metrics);

    const obsKey = KEYS.analyze.obsLast(
      metrics.snapshotId || 'NO_SNAPSHOT',
      metrics.symbol || metrics.contractSymbol || 'UNKNOWN',
      classified.microFamilyId
    );

    const firstObservation = await redis.set(obsKey, '1', {
      nx: true,
      ex: CONFIG.analyze.obsDedupeTtlSec
    });

    const micro = getOrCreateMicro(
      micros,
      classified,
      classified.side || metrics.side
    );

    if (firstObservation) {
      updateObservation(micro, {
        ...metrics,
        ...classified,
        weekKey,
        strategyVersion: CONFIG.strategyVersion,
        createdAt: metrics.createdAt || now()
      });
    }

    analyzed.push({
      ...metrics,
      ...classified,
      analysisType: 'OBSERVATION',
      observationRecorded: Boolean(firstObservation),
      weekKey,
      strategyVersion: CONFIG.strategyVersion
    });
  }

  await saveWeekMicros(weekKey, micros);

  return analyzed;
}

export async function recordOutcome(
  outcome = {},
  {
    source = outcome.source || 'REAL',
    weekKey = getIsoWeekKey(outcome.closedAt || outcome.completedAt || now())
  } = {}
) {
  const src = normalizeSource(source);

  const row = enrichWithMicroFamily({
    ...outcome,
    source: src,
    weekKey,
    strategyVersion: CONFIG.strategyVersion
  });

  const micros = await getWeekMicros(weekKey);

  const micro = getOrCreateMicro(
    micros,
    row,
    row.side
  );

  updateOutcome(micro, row, src);

  await saveWeekMicros(weekKey, micros);

  return {
    ...row,
    source: src,
    weekKey,
    recordedAt: now()
  };
}

export async function createShadowPosition(metrics = {}) {
  if (!CONFIG.analyze.shadowEnabled) {
    return {
      ok: false,
      skipped: true,
      reason: 'SHADOW_DISABLED'
    };
  }

  const classified = enrichWithMicroFamily(metrics);

  if (!classified.microFamilyId) {
    return {
      ok: false,
      skipped: true,
      reason: 'MICRO_MISSING'
    };
  }

  if (!classified.entry || !classified.sl || !classified.tp) {
    return {
      ok: false,
      skipped: true,
      reason: 'RISK_MISSING'
    };
  }

  const redis = getDurableRedis();

  const dedupeKey = KEYS.analyze.shadowLast(
    classified.symbol || classified.contractSymbol || 'UNKNOWN',
    classified.microFamilyId
  );

  const first = await redis.set(dedupeKey, '1', {
    nx: true,
    ex: CONFIG.analyze.shadowDedupeTtlSec
  });

  if (!first) {
    return {
      ok: false,
      skipped: true,
      reason: 'SHADOW_DEDUPED'
    };
  }

  const id = randomId('shadow');
  const createdAt = now();

  const row = {
    ...classified,

    id,
    source: 'SHADOW',
    status: 'OPEN',

    strategyVersion: CONFIG.strategyVersion,

    createdAt,
    monitorUntil: createdAt + CONFIG.analyze.shadowHorizonMin * 60 * 1000,

    ticks: 0,
    maxPnlPct: 0,
    minPnlPct: 0,
    mfeR: 0,
    maeR: 0,

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,

    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false
  };

  await setJson(
    redis,
    KEYS.analyze.shadowOpen(id),
    row,
    {
      ex: Math.ceil(CONFIG.analyze.shadowHorizonMin * 60 * 1.2)
    }
  );

  return {
    ok: true,
    shadowId: id,
    microFamilyId: row.microFamilyId,
    macroFamilyId: row.parentMacroFamilyId || row.macroFamilyId || null
  };
}

function calcGrossMovePct({ side, entry, exit }) {
  if (entry <= 0 || exit <= 0) return 0;

  return isLongSide(side)
    ? (exit - entry) / entry
    : (entry - exit) / entry;
}

function calcRiskPct({ entry, sl }) {
  if (entry <= 0 || sl <= 0) return 0;

  return Math.abs(entry - sl) / entry;
}

function inferDirectToSL({ position, exitReason }) {
  const reason = String(exitReason || '').toUpperCase();

  const mfeR = safeNumber(position.mfeR, 0);
  const maeR = safeNumber(position.maeR, 0);

  const stoppedOut = [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS'
  ].includes(reason);

  return Boolean(position.directToSL) ||
    (
      stoppedOut &&
      mfeR < 0.25 &&
      maeR <= -0.8
    );
}

function copyMicroClassificationFields(position = {}) {
  return {
    familyId: position.familyId,
    microFamilyId: position.microFamilyId,

    macroFamilyId: position.macroFamilyId,
    parentMacroFamilyId: position.parentMacroFamilyId,
    parentMicroFamilyId: position.parentMicroFamilyId,

    definitionParts: position.definitionParts || [],
    definition: position.definition || null,

    parentDefinition: position.parentDefinition || null,
    parentDefinitionParts: position.parentDefinitionParts || [],

    schema: position.schema || position.microFamilySchema || null,
    microFamilySchema: position.microFamilySchema || position.schema || null,
    version: position.version || null,

    assetClass: position.assetClass || null,

    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,
    rsiSlope: position.rsiSlope ?? null,
    rsiVelocity: position.rsiVelocity ?? null,
    rsiDelta: position.rsiDelta ?? null,
    rsiMomentum: position.rsiMomentum ?? null,

    obRelation: position.obRelation || null,
    obBias: position.obBias ?? null,
    obImbalance: position.obImbalance ?? null,
    orderbookImbalance: position.orderbookImbalance ?? null,
    bookImbalance: position.bookImbalance ?? null,
    bidAskImbalance: position.bidAskImbalance ?? null,

    spoofScore: position.spoofScore ?? null,
    orderbookSpoofScore: position.orderbookSpoofScore ?? null,
    obSpoofScore: position.obSpoofScore ?? null,
    fakeLiquidityScore: position.fakeLiquidityScore ?? null,

    btcState: position.btcState || null,
    btcRelation: position.btcRelation || null,

    flow: position.flow || null,
    flowCoarse: position.flowCoarse || null,

    regime: position.regime || null,
    regimeCoarse: position.regimeCoarse || null,

    confluence: position.confluence ?? null,
    sniperScore: position.sniperScore ?? null,

    scannerReason: position.scannerReason || null,
    scannerReasonCoarse: position.scannerReasonCoarse || null,

    spreadPct: position.spreadPct ?? null,
    exitSpreadPct: position.exitSpreadPct ?? null,
    spreadBps: position.spreadBps ?? null,

    depthMinUsd1p: position.depthMinUsd1p ?? null,
    fundingRate: position.fundingRate ?? null,

    entryQuality: position.entryQuality || null,
    retestConfirmed: Boolean(position.retestConfirmed),
    pullbackConfirmed: Boolean(position.pullbackConfirmed),
    sweepConfirmed: Boolean(position.sweepConfirmed),
    fakeBreakout: Boolean(position.fakeBreakout),

    entryDistancePct: position.entryDistancePct ?? null,
    entryDistanceToMidPct: position.entryDistanceToMidPct ?? null,
    pullbackDistancePct: position.pullbackDistancePct ?? null,
    distanceToEntryPct: position.distanceToEntryPct ?? null,
    distancePct: position.distancePct ?? null,

    slDistancePct: position.slDistancePct ?? null,
    stopDistancePct: position.stopDistancePct ?? null,
    stopLossDistancePct: position.stopLossDistancePct ?? null,

    tpDistancePct: position.tpDistancePct ?? null,
    takeProfitDistancePct: position.takeProfitDistancePct ?? null,

    liqDistancePct: position.liqDistancePct ?? null,
    liquidationDistancePct: position.liquidationDistancePct ?? null,
    distanceToLiquidationPct: position.distanceToLiquidationPct ?? null,
    nearestLiqDistancePct: position.nearestLiqDistancePct ?? null,

    atrPct: position.atrPct ?? null,
    volatilityPct: position.volatilityPct ?? null,
    rangePct: position.rangePct ?? null,
    realizedVolPct: position.realizedVolPct ?? null,

    costR: position.costR ?? position.estimatedCostR ?? null,
    avgCostR: position.avgCostR ?? null,
    estimatedCostR: position.estimatedCostR ?? null
  };
}

export function buildOutcomeFromPosition({
  position,
  exitPrice,
  exitReason,
  source = 'REAL'
}) {
  if (!position) {
    throw new Error('POSITION_REQUIRED_FOR_OUTCOME');
  }

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);

  const riskPct =
    safeNumber(position.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = calcGrossMovePct({
    side: position.side,
    entry,
    exit
  });

  const cost = applyCosts({
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct, 0),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const closedAt = now();

  return {
    type: 'OUTCOME',
    source: normalizeSource(source),
    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,
    shadowId: position.shadowId || position.id || null,

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,
    side: position.side,
    tradeSide: position.tradeSide || sideToTradeSide(position.side),

    ...copyMicroClassificationFields(position),

    entry,
    exit,
    sl: safeNumber(position.sl, 0),
    initialSl,
    tp: safeNumber(position.tp, 0),
    rr: safeNumber(position.rr, 0),
    riskPct,

    exitReason,

    grossR: cost.grossR,
    grossPnlPct: cost.grossPnlPct,

    exitR: cost.netR,
    pnlPct: cost.netPnlPct,
    netR: cost.netR,
    netPnlPct: cost.netPnlPct,

    costR: cost.costR,
    costPct: cost.costPct,
    feePct: cost.feePct,
    slippagePct: cost.slippagePct,

    mfeR: safeNumber(position.mfeR, 0),
    maeR: safeNumber(position.maeR, 0),

    directToSL: inferDirectToSL({
      position,
      exitReason
    }),

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    openedAt: position.openedAt || position.createdAt || null,
    closedAt
  };
}