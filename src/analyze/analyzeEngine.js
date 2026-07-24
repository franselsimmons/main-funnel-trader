// ================= FILE: src/analyze/analyzeEngine.js =================

import { CONFIG } from '../config.js';
import * as KeysApi from '../keys.js';

import {
  getDurableRedis,
  getJson,
  setJson,
  setNxJson,
  delJson
} from '../redis.js';

import {
  getIsoWeekKey,
  normalizeBaseSymbol,
  randomId,
  safeNumber,
  sideToTradeSide,
  stableHash,
  parseShortTaxonomyMicroId,
  isSelectableShortTrueMicroFamilyId,
  validLearningId
} from '../utils.js';

import { attachMicroFamilies } from './microFamilies.js';

import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';

const KEYS = KeysApi.KEYS || KeysApi.keys || null;

if (!KEYS || typeof KEYS !== 'object' || !KEYS.analyze) {
  throw new Error(
    'ANALYZE_ENGINE_KEYS_API_MISSING: keys.js must export KEYS.analyze or keys.analyze'
  );
}

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const ANALYZE_KEY_PREFIX = `${SHORT_KEY_PREFIX}ANALYZE:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;

const LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const PARENT_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const WRITE_SCOPE = KEYS.scopes?.ANALYZE_PARTIAL || 'ANALYZE_PARTIAL';

const DEFAULT_OBSERVATION_TTL_SEC = 60 * 60 * 24 * 62;
const DEFAULT_OUTCOME_TTL_SEC = 60 * 60 * 24 * 365;
const DEFAULT_RECENT_OUTCOME_LIMIT = 250;
const DEFAULT_MAX_MICRO_OUTCOME_HISTORY_BYTES = 2_000_000;
const EMERGENCY_MAX_MICRO_OUTCOME_HISTORY_BYTES = 500_000;
const DEFAULT_DEDUPE_CONCURRENCY = 24;
const DEFAULT_MIRROR_WRITE_CONCURRENCY = 12;

const MAX_RECENT_OUTCOME_LIMIT = 1000;
const MAX_COMPACT_DEFINITION_PARTS = 16;
const MAX_COMPACT_STRING_LENGTH = 240;
const MAX_STATS_STRING_LENGTH = 1000;
const MAX_GENERIC_ARRAY_ITEMS = 1000;

const HEAVY_DROP_KEYS = new Set([
  'rows',
  'symbols',
  'candidates',
  'candidateRows',
  'actions',
  'virtualActions',
  'scannerRows',
  'marketWeatherRows',
  'candles',
  'candles15m',
  'candles1h',
  'candles4h',
  'candleData',
  'rawCandles',
  'rawOrderBook',
  'orderBook',
  'orderbook',
  'currentMarketUniverse',
  'entryMarketUniverse',
  'marketUniverse',
  'universe',
  'scannerDefinitionParts',
  'microDefinitionParts',
  'macroDefinitionParts',
  'parentDefinitionParts',
  'executionFingerprintParts'
]);

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .flat(Infinity)
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  ];
}

function compactText(value, maxLength = MAX_COMPACT_STRING_LENGTH) {
  const text = String(value || '').trim();

  if (!text) return null;

  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function compactStringList(
  values = [],
  limit = MAX_COMPACT_DEFINITION_PARTS,
  maxLength = MAX_COMPACT_STRING_LENGTH
) {
  return uniqueStrings(values)
    .map((value) => compactText(value, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function nxInsertSucceeded(result) {
  return (
    result === 'OK' ||
    result === 'ok' ||
    result === true ||
    result === 1
  );
}

function normalizeConcurrency(value, fallback, max = 50) {
  const n = Math.floor(safeNumber(value, fallback));

  if (!Number.isFinite(n) || n <= 0) return fallback;

  return Math.max(1, Math.min(max, n));
}

async function mapLimit(values = [], concurrency = 8, worker) {
  const rows = Array.isArray(values) ? values : [];
  const out = new Array(rows.length);
  const limit = normalizeConcurrency(concurrency, 8, 50);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= rows.length) return;

      out[index] = await worker(rows[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, Math.max(1, rows.length)) },
      () => runWorker()
    )
  );

  return out;
}

function assertAnalyzeWrite(key) {
  const normalizedKey = String(key || '').trim();

  if (!normalizedKey) {
    throw new Error('ANALYZE_WRITE_KEY_REQUIRED');
  }

  if (typeof KeysApi.assertKeyAllowedForWriteScope === 'function') {
    return KeysApi.assertKeyAllowedForWriteScope(WRITE_SCOPE, normalizedKey);
  }

  if (!normalizedKey.startsWith(ANALYZE_KEY_PREFIX)) {
    const error = new Error('ANALYZE_WRITE_SCOPE_VIOLATION_SHORT_ONLY');

    error.details = {
      scopeName: WRITE_SCOPE,
      key: normalizedKey,
      requiredPrefix: ANALYZE_KEY_PREFIX,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      shortOnly: true,
      longDisabled: true,
      longRootTouched: false,
      virtualOnly: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeOrdersDisabled: true
    };

    throw error;
  }

  return true;
}

function resolveWeekKey(value) {
  const raw = String(value || '').trim();
  return raw || PERSISTENT_LEARNING_KEY;
}

function observationTtlSec() {
  return Math.max(
    60,
    Math.floor(
      safeNumber(
        CONFIG.short?.analyze?.observationDedupeTtlSec ??
          CONFIG.analyze?.observationDedupeTtlSec,
        DEFAULT_OBSERVATION_TTL_SEC
      )
    )
  );
}

function outcomeTtlSec() {
  return Math.max(
    60,
    Math.floor(
      safeNumber(
        CONFIG.short?.analyze?.outcomeDedupeTtlSec ??
          CONFIG.analyze?.outcomeDedupeTtlSec,
        DEFAULT_OUTCOME_TTL_SEC
      )
    )
  );
}

function recentOutcomeLimit() {
  const configured = Math.floor(
    safeNumber(
      CONFIG.short?.analyze?.recentOutcomeLimit ??
        CONFIG.analyze?.recentOutcomeLimit,
      DEFAULT_RECENT_OUTCOME_LIMIT
    )
  );

  return Math.max(20, Math.min(MAX_RECENT_OUTCOME_LIMIT, configured));
}

function maxMicroOutcomeHistoryBytes() {
  const configured = Math.floor(
    safeNumber(
      CONFIG.short?.analyze?.maxMicroOutcomeHistoryBytes ??
        CONFIG.analyze?.maxMicroOutcomeHistoryBytes,
      DEFAULT_MAX_MICRO_OUTCOME_HISTORY_BYTES
    )
  );

  return Math.max(250_000, Math.min(8_000_000, configured));
}

function dedupeConcurrency() {
  return normalizeConcurrency(
    CONFIG.short?.analyze?.dedupeConcurrency ??
      CONFIG.analyze?.dedupeConcurrency,
    DEFAULT_DEDUPE_CONCURRENCY,
    50
  );
}

function mirrorWriteConcurrency() {
  return normalizeConcurrency(
    CONFIG.short?.analyze?.mirrorWriteConcurrency ??
      CONFIG.analyze?.mirrorWriteConcurrency,
    DEFAULT_MIRROR_WRITE_CONCURRENCY,
    30
  );
}

function normalizeSource(value) {
  return upper(value || 'VIRTUAL') === 'SHADOW' ? 'SHADOW' : 'VIRTUAL';
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function compactMarketWeather(value = null) {
  const weather = asObject(value);

  if (!Object.keys(weather).length) return null;

  return {
    ok: weather.ok !== false,
    available: weather.available !== false,
    version: compactText(weather.version, 100),
    source: compactText(weather.source, 40),
    snapshotId: compactText(weather.snapshotId, 120),
    generatedAt: safeNumber(weather.generatedAt, 0) || null,
    createdAt: safeNumber(weather.createdAt, 0) || null,
    completedAt: safeNumber(weather.completedAt, 0) || null,
    updatedAt: safeNumber(weather.updatedAt, 0) || null,
    currentRegime: compactText(
      weather.currentRegime || weather.regime,
      40
    ),
    currentTrendSide: compactText(
      weather.currentTrendSide || weather.trendSide,
      40
    ),
    currentFlow: compactText(weather.currentFlow || weather.flow, 60),
    currentVolatilityState: compactText(
      weather.currentVolatilityState || weather.volatilityState,
      60
    ),
    confidence: safeNumber(
      weather.confidence ?? weather.weatherConfidence,
      0
    ),
    bullishPct: safeNumber(weather.bullishPct, 0),
    bearishPct: safeNumber(weather.bearishPct, 0),
    neutralPct: safeNumber(weather.neutralPct, 0),
    squeezePct: safeNumber(weather.squeezePct, 0),
    avgAtrPct: safeNumber(weather.avgAtrPct, 0),
    avgRangePct: safeNumber(weather.avgRangePct, 0),
    avgRealizedVolPct: safeNumber(weather.avgRealizedVolPct, 0),
    avgVolumeExpansion: safeNumber(weather.avgVolumeExpansion, 0),
    universeCount: safeNumber(weather.universeCount ?? weather.count, 0),
    rowsExcluded: true,
    symbolsExcluded: true
  };
}

function stripHeavyValue(value, depth = 0, keyName = '') {
  if (value === null || value === undefined) return value;

  if (depth > 7) return null;

  if (typeof value === 'string') {
    return value.length > MAX_STATS_STRING_LENGTH
      ? value.slice(0, MAX_STATS_STRING_LENGTH)
      : value;
  }

  if (typeof value !== 'object') return value;

  if (
    keyName === 'currentMarketWeather' ||
    keyName === 'entryMarketWeather' ||
    keyName === 'marketWeather'
  ) {
    return compactMarketWeather(value);
  }

  if (Array.isArray(value)) {
    const source = value.slice(-MAX_GENERIC_ARRAY_ITEMS);
    return source.map((row) => stripHeavyValue(row, depth + 1, keyName));
  }

  const out = {};

  for (const [key, child] of Object.entries(value)) {
    if (HEAVY_DROP_KEYS.has(key)) continue;

    if (key === 'definitionParts') {
      out[key] = compactStringList(child, MAX_COMPACT_DEFINITION_PARTS, 180);
      continue;
    }

    if (key === 'recentOutcomes') {
      out[key] = (Array.isArray(child) ? child : [])
        .slice(-recentOutcomeLimit())
        .map((row) => minimalOutcomeRecord(row));
      continue;
    }

    out[key] = stripHeavyValue(child, depth + 1, key);
  }

  return out;
}

function compactOutcomeRecord(input = {}, overrides = {}) {
  const row = {
    ...asObject(input),
    ...asObject(overrides)
  };

  const childCandidate = upper(
    row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      row.analyzeMicroFamilyId ||
      row.learningMicroFamilyId
  );

  const parsed = parseShortTaxonomyMicroId(childCandidate);

  const childId = parsed?.isChild
    ? upper(parsed.childTrueMicroFamilyId || childCandidate)
    : childCandidate;

  const parentId = upper(
    row.parentTrueMicroFamilyId ||
      row.parentMicroFamilyId ||
      row.parentMacroFamilyId ||
      row.coarseMicroFamilyId ||
      parsed?.parentTrueMicroFamilyId
  );

  const source = normalizeSource(row.source || row.outcomeSource);

  const entry = safeNumber(row.entry ?? row.entryPrice, 0);
  const initialSl = safeNumber(
    row.initialSl ?? row.initialStopLoss ?? row.sl ?? row.stopLoss,
    0
  );
  const sl = safeNumber(row.sl ?? row.stopLoss ?? initialSl, initialSl);
  const tp = safeNumber(row.tp ?? row.takeProfit, 0);
  const exitPrice = safeNumber(
    row.exitPrice ?? row.currentPrice ?? row.lastPrice ?? row.price,
    0
  );
  const grossR = safeNumber(
    row.grossR ?? row.shortGrossR ?? row.rawR,
    0
  );
  const netR = safeNumber(
    row.netR ??
      row.exitR ??
      row.netPnlR ??
      row.realizedNetR ??
      row.realizedR,
    grossR
  );
  const costR = safeNumber(
    row.costR ?? row.totalCostR,
    Math.max(0, grossR - netR)
  );
  const closedAt = safeNumber(
    row.closedAt ?? row.completedAt ?? row.exitAt,
    0
  );
  const openedAt = safeNumber(
    row.openedAt ?? row.createdAt ?? row.entryAt,
    0
  );

  const symbol =
    normalizeBaseSymbol(
      row.symbol || row.baseSymbol || row.contractSymbol
    ) || 'UNKNOWN';

  const contractSymbol = compactText(
    row.contractSymbol || (symbol !== 'UNKNOWN' ? `${symbol}USDT` : null),
    80
  );

  return {
    ok: row.ok !== false,
    learnable: row.learnable !== false,

    outcomeId: compactText(
      row.outcomeId || row.positionId || row.tradeId || row.id,
      160
    ),
    positionId: compactText(row.positionId || row.tradeId || row.id, 160),
    outcomeDedupeKey: compactText(row.outcomeDedupeKey, 220),
    snapshotId: compactText(row.snapshotId || row.scanId || row.batchId, 160),

    symbol,
    baseSymbol: symbol,
    contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,

    source,
    outcomeSource: source,
    status: compactText(row.status || 'CLOSED', 40),

    shortOnly: true,
    longDisabled: true,
    virtualOnly: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    trueMicroFamilyId: childId || null,
    childTrueMicroFamilyId: childId || null,
    microFamilyId: childId || null,
    analyzeMicroFamilyId: childId || null,
    learningMicroFamilyId: childId || null,
    microMicroFamilyId: childId || null,

    parentTrueMicroFamilyId: parentId || null,
    parentMicroFamilyId: parentId || null,
    parentMacroFamilyId: parentId || null,
    coarseMicroFamilyId: parentId || null,

    setupType: compactText(row.setupType || row.setup || parsed?.setup, 60),
    regimeBucket: compactText(row.regimeBucket || parsed?.regime, 60),
    confirmationProfile: compactText(
      row.confirmationProfile || parsed?.confirmationProfile,
      80
    ),

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    entry,
    entryPrice: entry,
    initialSl,
    sl,
    tp,
    exitPrice,

    grossR,
    shortGrossR: grossR,
    rawR: grossR,
    netR,
    exitR: netR,
    realizedR: safeNumber(row.realizedR, netR),
    costR,

    directToSL: Boolean(row.directToSL ?? row.directSL),
    directSL: Boolean(row.directSL ?? row.directToSL),

    exitReason: compactText(
      upper(row.exitReason || row.reason || 'UNKNOWN'),
      100
    ),
    scannerReason: compactText(row.scannerReason, 100),

    currentFit: compactText(
      typeof row.currentFit === 'string'
        ? row.currentFit
        : row.currentFitLabel,
      100
    ),
    currentFitScore: safeNumber(row.currentFitScore ?? row.fitScore, 0),
    currentFitConfidence: safeNumber(
      row.currentFitConfidence ?? row.entryCurrentFitConfidence,
      0
    ),

    scannerScore: safeNumber(row.scannerScore, 0),
    moveScore: safeNumber(row.moveScore, 0),
    change1h: safeNumber(row.change1h, 0),
    change24h: safeNumber(row.change24h, 0),
    volume24h: safeNumber(
      row.volume24h ?? row.quoteVolume24h ?? row.quoteVolume,
      0
    ),
    volumeExpansion: safeNumber(row.volumeExpansion, 0),
    atrPct: safeNumber(row.atrPct, 0),

    openedAt: openedAt || null,
    createdAt: openedAt || safeNumber(row.createdAt, 0) || null,
    closedAt: closedAt || null,
    completedAt: closedAt || safeNumber(row.completedAt, 0) || null,
    updatedAt: safeNumber(row.updatedAt, now()),

    outcomeDuplicate: Boolean(row.outcomeDuplicate),
    outcomeAlreadyRecorded: Boolean(row.outcomeAlreadyRecorded),
    outcomeCounted: row.outcomeCounted !== false,
    countOutcome: row.countOutcome !== false,

    definitionParts: compactStringList(
      row.definitionParts || row.microDefinitionParts || [],
      MAX_COMPACT_DEFINITION_PARTS,
      180
    ),

    currentMarketWeather: compactMarketWeather(
      row.currentMarketWeather || row.entryMarketWeather || row.marketWeather
    ),

    fullScannerPayloadExcluded: true,
    marketWeatherRowsExcluded: true,
    candleDataExcluded: true,
    executionFingerprintPartsExcluded: true
  };
}

function minimalOutcomeRecord(row = {}) {
  const compact = compactOutcomeRecord(row);

  return {
    outcomeId: compact.outcomeId,
    positionId: compact.positionId,
    snapshotId: compact.snapshotId,
    symbol: compact.symbol,
    contractSymbol: compact.contractSymbol,
    source: compact.source,
    status: compact.status,
    trueMicroFamilyId: compact.trueMicroFamilyId,
    parentTrueMicroFamilyId: compact.parentTrueMicroFamilyId,
    setupType: compact.setupType,
    regimeBucket: compact.regimeBucket,
    confirmationProfile: compact.confirmationProfile,
    entry: compact.entry,
    initialSl: compact.initialSl,
    tp: compact.tp,
    exitPrice: compact.exitPrice,
    grossR: compact.grossR,
    netR: compact.netR,
    costR: compact.costR,
    exitReason: compact.exitReason,
    openedAt: compact.openedAt,
    closedAt: compact.closedAt,
    directSL: compact.directSL,
    currentFit: compact.currentFit,
    currentFitScore: compact.currentFitScore,
    compactEmergencyRecord: true
  };
}

function compactObservationRecord(row = {}) {
  const symbol =
    normalizeBaseSymbol(
      row.symbol || row.baseSymbol || row.contractSymbol
    ) || 'UNKNOWN';

  return {
    observationId: compactText(row.observationId, 160),
    observationDedupeKey: compactText(row.observationDedupeKey, 240),
    observationRecorded: row.observationRecorded !== false,
    observationDuplicate: Boolean(row.observationDuplicate),
    observedAt: safeNumber(row.observedAt, now()),
    createdAt: safeNumber(row.createdAt, now()),

    snapshotId: compactText(row.snapshotId || row.scanId || row.batchId, 160),
    symbol,
    baseSymbol: symbol,
    contractSymbol: compactText(
      row.contractSymbol || (symbol !== 'UNKNOWN' ? `${symbol}USDT` : null),
      80
    ),

    trueMicroFamilyId: row.trueMicroFamilyId,
    childTrueMicroFamilyId: row.trueMicroFamilyId,
    microFamilyId: row.trueMicroFamilyId,
    analyzeMicroFamilyId: row.trueMicroFamilyId,
    learningMicroFamilyId: row.trueMicroFamilyId,
    microMicroFamilyId: row.trueMicroFamilyId,

    parentTrueMicroFamilyId: row.parentTrueMicroFamilyId,
    parentMicroFamilyId: row.parentTrueMicroFamilyId,
    parentMacroFamilyId: row.parentTrueMicroFamilyId,
    coarseMicroFamilyId: row.parentTrueMicroFamilyId,

    setupType: compactText(row.setupType || row.setup, 60),
    regimeBucket: compactText(row.regimeBucket, 60),
    confirmationProfile: compactText(row.confirmationProfile, 80),

    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,

    shortOnly: true,
    longDisabled: true,
    virtualOnly: true,
    virtualLearning: true,

    entry: safeNumber(row.entry ?? row.entryPrice, 0),
    entryPrice: safeNumber(row.entryPrice ?? row.entry, 0),
    sl: safeNumber(row.sl ?? row.initialSl, 0),
    initialSl: safeNumber(row.initialSl ?? row.sl, 0),
    tp: safeNumber(row.tp, 0),
    rr: safeNumber(row.rr, 0),

    scannerScore: safeNumber(row.scannerScore, 0),
    moveScore: safeNumber(row.moveScore, 0),
    confluence: safeNumber(row.confluence, 0),
    sniperScore: safeNumber(row.sniperScore, 0),
    spreadPct: safeNumber(row.spreadPct, 0),
    depthMinUsd1p: safeNumber(row.depthMinUsd1p, 0),
    fundingRate: safeNumber(row.fundingRate, 0),

    change1h: safeNumber(row.change1h, 0),
    change24h: safeNumber(row.change24h, 0),
    volume24h: safeNumber(
      row.volume24h ?? row.quoteVolume24h ?? row.quoteVolume,
      0
    ),
    volumeExpansion: safeNumber(row.volumeExpansion, 0),
    atrPct: safeNumber(row.atrPct, 0),

    scannerReason: compactText(row.scannerReason, 120),
    sideConfidence: compactText(row.sideConfidence, 60),
    btcState: compactText(row.btcState, 60),
    regime: compactText(row.regime, 60),
    currentFit: compactText(row.currentFit || row.entryCurrentFit, 80),
    currentFitScore: safeNumber(row.currentFitScore, 0),
    currentFitConfidence: safeNumber(
      row.currentFitConfidence ?? row.entryCurrentFitConfidence,
      0
    ),

    definitionParts: compactStringList(
      row.definitionParts || row.microDefinitionParts || [],
      MAX_COMPACT_DEFINITION_PARTS,
      180
    ),

    currentMarketWeather: compactMarketWeather(
      row.currentMarketWeather || row.entryMarketWeather
    ),

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fullScannerPayloadExcluded: true,
    marketWeatherRowsExcluded: true,
    marketUniverseExcluded: true,
    candleDataExcluded: true,
    orderBookExcluded: true,
    executionFingerprintPartsExcluded: true
  };
}

function compactStatsRecord(value = {}) {
  return stripHeavyValue(asObject(value));
}

function compactStatsMap(value = {}) {
  const input = asObject(value);
  const out = {};

  for (const [key, row] of Object.entries(input)) {
    out[key] = compactStatsRecord(row);
  }

  return out;
}

function isStatsRecord(value = {}) {
  const row = asObject(value);

  return Boolean(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.parentTrueMicroFamilyId ||
    row.familyId ||
    Object.prototype.hasOwnProperty.call(row, 'seen') ||
    Object.prototype.hasOwnProperty.call(row, 'completed') ||
    Object.prototype.hasOwnProperty.call(row, 'wins') ||
    Object.prototype.hasOwnProperty.call(row, 'totalR')
  );
}

function compactAggregateValue(value) {
  if (Array.isArray(value)) return value;
  if (isStatsRecord(value)) return compactStatsRecord(value);
  return compactStatsMap(value);
}

function compactOutcomeHistory(
  rows = [],
  {
    maxItems = recentOutcomeLimit(),
    maxBytes = maxMicroOutcomeHistoryBytes()
  } = {}
) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const deduped = new Map();

  for (const row of sourceRows) {
    const compact = compactOutcomeRecord(row);
    const dedupeKey =
      compact.outcomeId ||
      compact.outcomeDedupeKey ||
      stableHash(
        {
          symbol: compact.symbol,
          trueMicroFamilyId: compact.trueMicroFamilyId,
          closedAt: compact.closedAt,
          exitReason: compact.exitReason,
          exitPrice: compact.exitPrice,
          netR: compact.netR
        },
        24
      );

    if (deduped.has(dedupeKey)) deduped.delete(dedupeKey);
    deduped.set(dedupeKey, compact);
  }

  let compactRows = [...deduped.values()].slice(
    -Math.max(1, Math.floor(maxItems))
  );

  while (
    compactRows.length > 1 &&
    jsonByteLength(compactRows) > maxBytes
  ) {
    compactRows.shift();
  }

  if (
    compactRows.length === 1 &&
    jsonByteLength(compactRows) > maxBytes
  ) {
    compactRows = [minimalOutcomeRecord(compactRows[0])];
  }

  return compactRows;
}

function isMaxRequestSizeError(error) {
  const text = String(error?.message || error || '').toUpperCase();

  return (
    text.includes('MAX REQUEST SIZE EXCEEDED') ||
    text.includes('10485760')
  );
}

async function saveMicroOutcomeHistory(redis, key, rows = []) {
  assertAnalyzeWrite(key);

  let history = compactOutcomeHistory(rows);
  let bytes = jsonByteLength(history);

  try {
    await setJson(redis, key, history);

    return {
      history,
      bytes,
      fallbackUsed: false
    };
  } catch (error) {
    if (!isMaxRequestSizeError(error)) throw error;

    history = compactOutcomeHistory(history, {
      maxItems: Math.min(100, recentOutcomeLimit()),
      maxBytes: EMERGENCY_MAX_MICRO_OUTCOME_HISTORY_BYTES
    });

    bytes = jsonByteLength(history);
    await setJson(redis, key, history);

    return {
      history,
      bytes,
      fallbackUsed: true
    };
  }
}

function isExplicitNonShort(row = {}) {
  const candidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.side,
    row.targetTradeSide
  ].filter(
    (value) => value !== undefined && value !== null && value !== ''
  );

  return candidates.some((value) => {
    const side = sideToTradeSide(value);
    return side && side !== TARGET_TRADE_SIDE;
  });
}

function shortIdentityFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    userFacingSelectionLayer: 'MICRO_MICRO_FAMILY',

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
}

function normalizeAnalyzeIdentity(input = {}) {
  if (isExplicitNonShort(input)) return null;

  const attached = attachMicroFamilies({
    ...input,
    ...shortIdentityFlags()
  });

  const candidateId = upper(
    attached?.trueMicroFamilyId ||
      attached?.childTrueMicroFamilyId ||
      attached?.microFamilyId ||
      input.trueMicroFamilyId ||
      input.childTrueMicroFamilyId ||
      input.microFamilyId
  );

  if (!candidateId || !validLearningId(candidateId)) return null;

  if (!isSelectableShortTrueMicroFamilyId(candidateId)) return null;

  const parsed = parseShortTaxonomyMicroId(candidateId);

  if (!parsed || !parsed.isChild) return null;

  const parentId = upper(parsed.parentTrueMicroFamilyId);
  const childId = upper(parsed.childTrueMicroFamilyId);

  if (!parentId || !childId) return null;

  return {
    ...input,
    ...attached,
    ...shortIdentityFlags(),

    setup: parsed.setup,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    parentTrueMicroFamilyId: parentId,
    parentMicroFamilyId: parentId,
    parentMacroFamilyId: parentId,
    macroFamilyId: parentId,
    coarseMicroFamilyId: parentId,

    childTrueMicroFamilyId: childId,
    microFamilyId: childId,
    trueMicroFamilyId: childId,
    analyzeMicroFamilyId: childId,
    learningMicroFamilyId: childId,
    microMicroFamilyId: childId,
    exactMicroMicroFamilyId: childId,

    selectable: true,
    selectableChild: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true
  };
}

function observationIdentity(row = {}) {
  const snapshotId = String(
    row.snapshotId || row.scanId || row.batchId || 'NO_SNAPSHOT'
  ).trim();

  const symbol =
    normalizeBaseSymbol(
      row.symbol || row.baseSymbol || row.contractSymbol
    ) || 'UNKNOWN';

  const microId = upper(row.trueMicroFamilyId || row.microFamilyId);
  const entry = safeNumber(row.entry ?? row.entryPrice, 0);
  const raw = `${snapshotId}|${symbol}|${microId}|${entry || 'NO_ENTRY'}`;

  return {
    snapshotId,
    symbol,
    microId,
    key: upper(row.observationDedupeKey || raw),
    redisKey: KEYS.analyze.obsLast(snapshotId, symbol, microId)
  };
}

function outcomeIdentity(row = {}) {
  const microId = upper(
    row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.childTrueMicroFamilyId
  );

  const positionId = String(
    row.positionId ||
      row.tradeId ||
      row.id ||
      row.outcomeId ||
      row.entryId ||
      ''
  ).trim();

  const symbol =
    normalizeBaseSymbol(
      row.symbol || row.baseSymbol || row.contractSymbol
    ) || 'UNKNOWN';

  const closedAt = safeNumber(
    row.closedAt ?? row.completedAt ?? row.exitAt,
    0
  );

  const exitReason = upper(row.exitReason || row.reason || 'UNKNOWN');

  const fallback = stableHash(
    {
      microId,
      symbol,
      closedAt,
      exitReason,
      exitPrice: row.exitPrice
    },
    20
  );

  const id = positionId || fallback;

  return {
    id,
    key: `${id}|${microId}`,
    redisKey: KEYS.analyze.obsLast(`OUTCOME_${id}`, symbol, microId)
  };
}

function createStatsFor(row = {}) {
  return createMicroStats({
    microFamilyId: row.trueMicroFamilyId,
    familyId: row.parentTrueMicroFamilyId,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    definitionParts: compactStringList(
      row.definitionParts || row.microDefinitionParts || [],
      MAX_COMPACT_DEFINITION_PARTS,
      180
    )
  });
}

function createParentStatsFor(row = {}) {
  const parentId = row.parentTrueMicroFamilyId;
  const timestamp = now();

  return {
    parentTrueMicroFamilyId: parentId,
    microFamilyId: parentId,
    trueMicroFamilyId: parentId,
    familyId: parentId,

    schema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: PARENT_LEARNING_GRANULARITY,

    setupType: row.setupType || null,
    regimeBucket: row.regimeBucket || null,

    seen: 0,
    observations: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalR: 0,
    netTotalR: 0,
    totalCostR: 0,
    grossTotalR: 0,
    avgR: 0,
    avgCostR: 0,
    winrate: 0,

    recentOutcomes: [],
    children: [],
    observationDedupeKeys: [],

    createdAt: timestamp,
    updatedAt: timestamp,

    ...shortIdentityFlags(),

    selectable: false,
    parentSelectable: false,
    childSelectable: true
  };
}

function updateParentObservation(stats = {}, row = {}) {
  const out = {
    ...createParentStatsFor(row),
    ...asObject(stats)
  };

  const childId = row.trueMicroFamilyId;
  const obsKey = String(row.observationDedupeKey || '');
  const dedupeKeys = Array.isArray(out.observationDedupeKeys)
    ? out.observationDedupeKeys
    : [];

  if (obsKey && dedupeKeys.includes(obsKey)) return out;

  out.seen = safeNumber(out.seen, 0) + 1;
  out.observations = safeNumber(out.observations, 0) + 1;
  out.children = uniqueStrings([out.children || [], childId]).slice(-75);
  out.observationDedupeKeys = obsKey
    ? [...dedupeKeys, obsKey].slice(-1000)
    : dedupeKeys.slice(-1000);
  out.updatedAt = now();

  return compactStatsRecord(out);
}

function updateParentOutcome(stats = {}, row = {}) {
  const out = {
    ...createParentStatsFor(row),
    ...asObject(stats)
  };

  const netR = safeNumber(row.netR ?? row.exitR ?? row.netPnlR, 0);
  const grossR = safeNumber(row.grossR ?? row.rawR, netR);
  const costR = safeNumber(row.costR, Math.max(0, grossR - netR));

  out.completed = safeNumber(out.completed, 0) + 1;
  out.wins = safeNumber(out.wins, 0) + (netR > 0 ? 1 : 0);
  out.losses = safeNumber(out.losses, 0) + (netR < 0 ? 1 : 0);
  out.flats = safeNumber(out.flats, 0) + (netR === 0 ? 1 : 0);
  out.totalR = safeNumber(out.totalR, 0) + netR;
  out.netTotalR = out.totalR;
  out.grossTotalR = safeNumber(out.grossTotalR, 0) + grossR;
  out.totalCostR = safeNumber(out.totalCostR, 0) + costR;
  out.avgR = out.completed > 0 ? out.totalR / out.completed : 0;
  out.avgCostR = out.completed > 0 ? out.totalCostR / out.completed : 0;
  out.winrate = out.completed > 0 ? out.wins / out.completed : 0;
  out.children = uniqueStrings([
    out.children || [],
    row.trueMicroFamilyId
  ]).slice(-75);

  out.recentOutcomes = [
    ...(Array.isArray(out.recentOutcomes) ? out.recentOutcomes : []),
    minimalOutcomeRecord(row)
  ].slice(-recentOutcomeLimit());

  out.updatedAt = now();

  return compactStatsRecord(out);
}

async function saveAggregate(redis, key, value) {
  assertAnalyzeWrite(key);

  const compactValue = compactAggregateValue(value);

  await setJson(redis, key, compactValue);
  return compactValue;
}

async function readWeekMaps(redis, weekKeys = []) {
  const entries = await Promise.all(
    weekKeys.map(async (weekKey) => {
      const microsKey = KEYS.analyze.weekMicros(weekKey);
      const parentsKey = KEYS.analyze.weekParents(weekKey);

      const [micros, parents] = await Promise.all([
        getJson(redis, microsKey, {}).catch(() => ({})),
        getJson(redis, parentsKey, {}).catch(() => ({}))
      ]);

      return [
        weekKey,
        {
          microsKey,
          parentsKey,
          micros: compactStatsMap(micros),
          parents: compactStatsMap(parents)
        }
      ];
    })
  );

  return new Map(entries);
}

async function saveWeekMaps(redis, weekMaps) {
  const writes = [];

  for (const data of weekMaps.values()) {
    writes.push(saveAggregate(redis, data.microsKey, data.micros));
    writes.push(saveAggregate(redis, data.parentsKey, data.parents));
  }

  await Promise.all(writes);
}

async function rollbackDedupeKeys(redis, keys = []) {
  await mapLimit(
    uniqueStrings(keys),
    dedupeConcurrency(),
    async (key) => {
      await delJson(redis, key).catch(() => null);
      return true;
    }
  );
}

export async function getWeekMicros(
  weekKey = PERSISTENT_LEARNING_KEY
) {
  const redis = getDurableRedis();
  const key = KEYS.analyze.weekMicros(resolveWeekKey(weekKey));
  const value = await getJson(redis, key, {});
  return compactStatsMap(value);
}

export async function saveWeekMicros(
  weekKey = PERSISTENT_LEARNING_KEY,
  micros = {}
) {
  const redis = getDurableRedis();
  const key = KEYS.analyze.weekMicros(resolveWeekKey(weekKey));
  return saveAggregate(redis, key, micros);
}

export async function getWeekParents(
  weekKey = PERSISTENT_LEARNING_KEY
) {
  const redis = getDurableRedis();
  const key = KEYS.analyze.weekParents(resolveWeekKey(weekKey));
  const value = await getJson(redis, key, {});
  return compactStatsMap(value);
}

export async function saveWeekParents(
  weekKey = PERSISTENT_LEARNING_KEY,
  parents = {}
) {
  const redis = getDurableRedis();
  const key = KEYS.analyze.weekParents(resolveWeekKey(weekKey));
  return saveAggregate(redis, key, parents);
}

async function recordObservationsBatchInternal(candidates = [], options = {}) {
  const sourceRows = Array.isArray(candidates) ? candidates : [];
  const redis = getDurableRedis();

  const prepared = sourceRows.map((candidate, index) => {
    const row = normalizeAnalyzeIdentity(candidate);

    if (!row) {
      return {
        index,
        valid: false,
        candidate,
        reason: 'INVALID_OR_NON_SHORT_EXACT_75_CHILD_ID'
      };
    }

    const identity = observationIdentity(row);

    return {
      index,
      valid: true,
      candidate,
      row,
      identity
    };
  });

  const uniqueByRedisKey = new Map();

  for (const item of prepared) {
    if (!item.valid) continue;

    if (!uniqueByRedisKey.has(item.identity.redisKey)) {
      uniqueByRedisKey.set(item.identity.redisKey, item);
    }
  }

  const uniqueItems = [...uniqueByRedisKey.values()];

  const dedupeResults = await mapLimit(
    uniqueItems,
    dedupeConcurrency(),
    async (item) => {
      assertAnalyzeWrite(item.identity.redisKey);

      try {
        const insertResult = await setNxJson(
          redis,
          item.identity.redisKey,
          {
            observationDedupeKey: item.identity.key,
            snapshotId: item.identity.snapshotId,
            symbol: item.identity.symbol,
            trueMicroFamilyId: item.identity.microId,
            createdAt: now()
          },
          {
            ex: observationTtlSec()
          }
        );

        return {
          redisKey: item.identity.redisKey,
          inserted: nxInsertSucceeded(insertResult),
          error: null
        };
      } catch (error) {
        return {
          redisKey: item.identity.redisKey,
          inserted: false,
          error: error?.message || String(error)
        };
      }
    }
  );

  const dedupeByKey = new Map(
    dedupeResults.map((row) => [row.redisKey, row])
  );

  const observedAt = now();
  const insertedItems = [];
  const insertedRedisKeys = [];

  for (const item of uniqueItems) {
    const status = dedupeByKey.get(item.identity.redisKey);

    if (!status?.inserted) continue;

    const enriched = {
      ...item.row,
      observationId: randomId('obs'),
      observationDedupeKey: item.identity.key,
      observationRecorded: true,
      observationDuplicate: false,
      observationAlwaysCounted: false,
      observedAt,
      createdAt: item.row.createdAt || observedAt
    };

    insertedItems.push({
      ...item,
      enriched,
      compact: compactObservationRecord(enriched)
    });

    insertedRedisKeys.push(item.identity.redisKey);
  }

  const requestedWeekKey = resolveWeekKey(
    options.weekKey || options.persistentLearningKey
  );

  let primaryMicros = {};
  let primaryParents = {};
  let mirrorWriteErrors = [];

  if (insertedItems.length > 0) {
    const allWeekKeys = uniqueStrings(
      insertedItems.flatMap((item) => [
        requestedWeekKey,
        PERSISTENT_LEARNING_KEY,
        getIsoWeekKey(item.compact.observedAt)
      ])
    );

    try {
      const weekMaps = await readWeekMaps(redis, allWeekKeys);

      for (const item of insertedItems) {
        const row = item.compact;
        const rowWeekKeys = uniqueStrings([
          requestedWeekKey,
          PERSISTENT_LEARNING_KEY,
          getIsoWeekKey(row.observedAt)
        ]);

        for (const weekKey of rowWeekKeys) {
          const bucket = weekMaps.get(weekKey);
          if (!bucket) continue;

          const currentChild =
            bucket.micros[row.trueMicroFamilyId] || createStatsFor(row);

          bucket.micros[row.trueMicroFamilyId] = compactStatsRecord(
            refreshStats(updateObservation(currentChild, row))
          );

          const parentId = row.parentTrueMicroFamilyId;
          bucket.parents[parentId] = updateParentObservation(
            bucket.parents[parentId],
            row
          );
        }
      }

      await saveWeekMaps(redis, weekMaps);

      const primary = weekMaps.get(requestedWeekKey);
      primaryMicros = primary?.micros || {};
      primaryParents = primary?.parents || {};

      const childIds = uniqueStrings(
        insertedItems.map((item) => item.compact.trueMicroFamilyId)
      );

      const parentIds = uniqueStrings(
        insertedItems.map((item) => item.compact.parentTrueMicroFamilyId)
      );

      const mirrorResults = await mapLimit(
        [
          ...childIds.map((id) => ({
            type: 'child',
            id,
            key: KEYS.analyze.microStats(id),
            value: primaryMicros[id] || null
          })),
          ...parentIds.map((id) => ({
            type: 'parent',
            id,
            key: KEYS.analyze.parentStats(id),
            value: primaryParents[id] || null
          }))
        ],
        mirrorWriteConcurrency(),
        async (entry) => {
          try {
            await saveAggregate(redis, entry.key, entry.value || {});
            return null;
          } catch (error) {
            return {
              type: entry.type,
              id: entry.id,
              error: error?.message || String(error)
            };
          }
        }
      );

      mirrorWriteErrors = mirrorResults.filter(Boolean);
    } catch (error) {
      await rollbackDedupeKeys(redis, insertedRedisKeys);
      throw error;
    }
  }

  const firstIndexByRedisKey = new Map();

  for (const item of prepared) {
    if (!item.valid) continue;

    if (!firstIndexByRedisKey.has(item.identity.redisKey)) {
      firstIndexByRedisKey.set(item.identity.redisKey, item.index);
    }
  }

  const output = prepared
    .map((item) => {
      if (!item.valid) return null;

      const status = dedupeByKey.get(item.identity.redisKey);
      const firstIndex = firstIndexByRedisKey.get(item.identity.redisKey);
      const sameBatchDuplicate = item.index !== firstIndex;
      const inserted = Boolean(status?.inserted && !sameBatchDuplicate);
      const duplicate = !inserted && !status?.error;

      return {
        ...item.row,
        observationRecorded: inserted,
        observationDuplicate: duplicate,
        observationDedupeKey: item.identity.key,
        analyzeObservationResult: {
          ok: !status?.error,
          skipped: !inserted,
          duplicate,
          sameBatchDuplicate,
          reason: status?.error
            ? 'OBSERVATION_DEDUPE_WRITE_FAILED'
            : inserted
              ? null
              : 'OBSERVATION_ALREADY_RECORDED',
          error: status?.error || null
        }
      };
    })
    .filter(Boolean);

  return {
    output,
    requestedWeekKey,
    primaryMicros,
    primaryParents,
    meta: {
      inputRows: sourceRows.length,
      validRows: prepared.filter((row) => row.valid).length,
      invalidRows: prepared.filter((row) => !row.valid).length,
      uniqueDedupeRows: uniqueItems.length,
      insertedRows: insertedItems.length,
      duplicateRows: output.filter((row) => row.observationDuplicate).length,
      dedupeErrorRows: dedupeResults.filter((row) => row.error).length,
      mirrorWriteErrors,
      aggregateReadWriteMode: 'BATCHED_PER_WEEK_KEY',
      fullRowsPersisted: false,
      marketWeatherRowsPersisted: false,
      marketUniversePersisted: false,
      candleDataPersisted: false
    }
  };
}

export async function recordObservation(trade = {}, options = {}) {
  const result = await recordObservationsBatchInternal([trade], options);
  const row = result.output[0] || null;

  if (!row) {
    return {
      ok: false,
      skipped: true,
      reason: 'INVALID_OR_NON_SHORT_EXACT_75_CHILD_ID'
    };
  }

  const inserted = row.observationRecorded === true;
  const duplicate = row.observationDuplicate === true;
  const error = row.analyzeObservationResult?.error || null;

  return {
    ok: !error,
    skipped: !inserted,
    duplicate,
    reason: error
      ? 'OBSERVATION_DEDUPE_WRITE_FAILED'
      : duplicate
        ? 'OBSERVATION_ALREADY_RECORDED'
        : null,
    recordId: observationIdentity(row).redisKey,
    row,
    stats: result.primaryMicros[row.trueMicroFamilyId] || null,
    batchMeta: result.meta
  };
}

export async function analyzeCandidate(candidate = {}, options = {}) {
  const result = await recordObservationsBatchInternal([candidate], options);
  return result.output[0] || null;
}

export async function analyzeCandidatesBatch(candidates = [], options = {}) {
  const result = await recordObservationsBatchInternal(candidates, options);
  const output = result.output;

  Object.defineProperty(output, 'batchMeta', {
    value: result.meta,
    enumerable: false,
    configurable: false,
    writable: false
  });

  return output;
}

function calculateGrossR(position = {}, exitPrice) {
  const entry = safeNumber(position.entry ?? position.entryPrice, 0);
  const initialSl = safeNumber(position.initialSl ?? position.sl, 0);
  const exit = safeNumber(exitPrice ?? position.exitPrice, 0);
  const risk = initialSl - entry;

  if (!(entry > 0 && initialSl > entry && exit > 0 && risk > 0)) {
    return 0;
  }

  return (entry - exit) / risk;
}

export function buildOutcomeFromPosition({
  position = {},
  exitPrice,
  exitReason,
  source = 'VIRTUAL'
} = {}) {
  const identity = normalizeAnalyzeIdentity(position);

  if (!identity) {
    return {
      ok: false,
      learnable: false,
      reason: 'INVALID_POSITION_LEARNING_ID',
      source: normalizeSource(source),
      ...shortIdentityFlags()
    };
  }

  const normalizedExitPrice = safeNumber(
    exitPrice,
    safeNumber(position.exitPrice, 0)
  );

  const grossR = calculateGrossR(position, normalizedExitPrice);
  const closedAt = safeNumber(
    position.closedAt ?? position.completedAt,
    now()
  );

  const outcomeId = String(
    position.outcomeId ||
      position.positionId ||
      position.tradeId ||
      position.id ||
      randomId('outcome')
  );

  const normalizedNetR = safeNumber(
    position.netR ?? position.netPnlR ?? position.exitR,
    grossR
  );

  const normalizedSource = normalizeSource(source);

  return compactOutcomeRecord(position, {
    ok: true,
    learnable: true,
    outcomeId,
    positionId: position.positionId || position.id || null,
    source: normalizedSource,
    outcomeSource: normalizedSource,
    status: 'CLOSED',
    exitPrice: normalizedExitPrice,
    exitReason: upper(exitReason || position.exitReason || 'UNKNOWN'),
    closedAt,
    completedAt: closedAt,
    grossR,
    shortGrossR: grossR,
    rawR: grossR,
    netR: normalizedNetR,
    exitR: normalizedNetR,
    costR: safeNumber(
      position.costR,
      Math.max(0, grossR - normalizedNetR)
    ),
    directToSL: Boolean(position.directToSL ?? position.directSL),
    directSL: Boolean(position.directSL ?? position.directToSL),
    createdAt: position.createdAt || position.openedAt || now(),
    updatedAt: now(),
    trueMicroFamilyId: identity.trueMicroFamilyId,
    childTrueMicroFamilyId: identity.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: identity.parentTrueMicroFamilyId,
    setupType: identity.setupType,
    regimeBucket: identity.regimeBucket,
    confirmationProfile: identity.confirmationProfile
  });
}

export async function recordOutcome(outcome = {}, options = {}) {
  const row = normalizeAnalyzeIdentity({
    ...outcome,
    ...shortIdentityFlags()
  });

  if (!row || outcome.learnable === false) {
    return {
      ok: false,
      skipped: true,
      reason: 'INVALID_OR_NON_SHORT_OUTCOME_ID'
    };
  }

  const source = normalizeSource(
    options.source || row.source || row.outcomeSource
  );

  const redis = getDurableRedis();
  const identity = outcomeIdentity(row);

  assertAnalyzeWrite(identity.redisKey);

  const insertResult = await setNxJson(
    redis,
    identity.redisKey,
    {
      outcomeDedupeKey: identity.key,
      outcomeId: identity.id,
      trueMicroFamilyId: row.trueMicroFamilyId,
      createdAt: now()
    },
    {
      ex: outcomeTtlSec()
    }
  );

  const inserted = nxInsertSucceeded(insertResult);

  if (!inserted) {
    return {
      ok: true,
      skipped: true,
      duplicate: true,
      reason: 'OUTCOME_ALREADY_RECORDED',
      outcomeId: identity.id
    };
  }

  const closedAt = safeNumber(row.closedAt ?? row.completedAt, now());
  const completedAt = safeNumber(row.completedAt ?? row.closedAt, closedAt);

  const enriched = compactOutcomeRecord(row, {
    outcomeId: identity.id,
    outcomeDedupeKey: identity.key,
    outcomeDuplicate: false,
    outcomeAlreadyRecorded: false,
    outcomeCounted: true,
    countOutcome: true,
    source,
    outcomeSource: source,
    status: 'CLOSED',
    closedAt,
    completedAt
  });

  const requestedWeekKey = resolveWeekKey(
    options.weekKey || options.persistentLearningKey
  );

  const weekKeys = uniqueStrings([
    requestedWeekKey,
    PERSISTENT_LEARNING_KEY,
    getIsoWeekKey(enriched.completedAt)
  ]);

  try {
    const weekMaps = await readWeekMaps(redis, weekKeys);

    for (const weekKey of weekKeys) {
      const bucket = weekMaps.get(weekKey);
      if (!bucket) continue;

      const currentChild =
        bucket.micros[enriched.trueMicroFamilyId] || createStatsFor(enriched);

      bucket.micros[enriched.trueMicroFamilyId] = compactStatsRecord(
        refreshStats(updateOutcome(currentChild, enriched, source))
      );

      const parentId = enriched.parentTrueMicroFamilyId;
      bucket.parents[parentId] = updateParentOutcome(
        bucket.parents[parentId],
        enriched
      );
    }

    await saveWeekMaps(redis, weekMaps);

    const primary = weekMaps.get(requestedWeekKey);
    const primaryStats =
      primary?.micros?.[enriched.trueMicroFamilyId] || null;
    const primaryParent =
      primary?.parents?.[enriched.parentTrueMicroFamilyId] || null;

    await Promise.allSettled([
      saveAggregate(
        redis,
        KEYS.analyze.microStats(enriched.trueMicroFamilyId),
        primaryStats || {}
      ),
      saveAggregate(
        redis,
        KEYS.analyze.parentStats(enriched.parentTrueMicroFamilyId),
        primaryParent || {}
      )
    ]);

    const outcomeKey = KEYS.analyze.microOutcomes(
      enriched.trueMicroFamilyId
    );

    const priorOutcomes = await getJson(redis, outcomeKey, []).catch(() => []);

    const savedHistory = await saveMicroOutcomeHistory(redis, outcomeKey, [
      ...(Array.isArray(priorOutcomes) ? priorOutcomes : []),
      enriched
    ]);

    return {
      ok: true,
      skipped: false,
      duplicate: false,
      outcomeId: identity.id,
      outcome: enriched,
      stats: primaryStats,
      outcomeHistory: {
        key: outcomeKey,
        rows: savedHistory.history.length,
        bytes: savedHistory.bytes,
        maxBytes: maxMicroOutcomeHistoryBytes(),
        compact: true,
        fallbackUsed: savedHistory.fallbackUsed,
        fullRowsPersisted: false,
        marketWeatherRowsPersisted: false
      }
    };
  } catch (error) {
    await delJson(redis, identity.redisKey).catch(() => null);
    throw error;
  }
}

export default {
  analyzeCandidate,
  analyzeCandidatesBatch,
  recordObservation,
  buildOutcomeFromPosition,
  recordOutcome,
  getWeekMicros,
  saveWeekMicros,
  getWeekParents,
  saveWeekParents
};
