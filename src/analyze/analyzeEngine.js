// ================= FILE: src/analyze/analyzeEngine.js =================
// SHORT-only Analyze engine.
//
// Pipeline contract:
// scanner candidate -> exact 75-child true micro-family observation
// closed virtual/shadow position -> cost-aware netR outcome
// persistent + ISO-week aggregates -> weekly manual rotation -> Discord
//
// In this project the exact 75-child identity is the finest selectable layer
// (the user-facing "micro-micro family"). Parent-15 remains context-only.
//
// Storage safety:
// - MICRO_OUTCOMES stores compact outcome rows only;
// - full scanner payloads, candle arrays, definition arrays and
//   currentMarketWeather.rows are never persisted in outcome history;
// - existing oversized histories are compacted automatically;
// - a hard byte budget keeps every MICRO_OUTCOMES value safely below
//   the Upstash request limit.
//
// Compatibility:
// - supports keys.js with export `KEYS`;
// - supports older keys.js with export `keys`;
// - no ESM import failure when assertKeyAllowedForWriteScope is absent;
// - fallback write guard allows SHORT:ANALYZE:* only.

import { CONFIG } from '../config.js';
import * as KeysApi from '../keys.js';

import {
  getDurableRedis,
  getJson,
  setJson,
  setNxJson
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

import {
  attachMicroFamilies
} from './microFamilies.js';

import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';

const KEYS =
  KeysApi.KEYS ||
  KeysApi.keys ||
  null;

if (
  !KEYS ||
  typeof KEYS !== 'object' ||
  !KEYS.analyze
) {
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

const TRUE_MICRO_SCHEMA =
  'FIXED_TAXONOMY_75';

const PARENT_TRUE_MICRO_SCHEMA =
  'FIXED_TAXONOMY_15';

const MICRO_MICRO_SCHEMA =
  TRUE_MICRO_SCHEMA;

const LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const PARENT_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const WRITE_SCOPE =
  KEYS.scopes?.ANALYZE_PARTIAL ||
  'ANALYZE_PARTIAL';

const DEFAULT_OBSERVATION_TTL_SEC =
  60 * 60 * 24 * 62;

const DEFAULT_OUTCOME_TTL_SEC =
  60 * 60 * 24 * 365;

const DEFAULT_RECENT_OUTCOME_LIMIT =
  250;

const DEFAULT_MAX_MICRO_OUTCOME_HISTORY_BYTES =
  2_000_000;

const EMERGENCY_MAX_MICRO_OUTCOME_HISTORY_BYTES =
  500_000;

const MAX_RECENT_OUTCOME_LIMIT =
  1000;

const MAX_COMPACT_DEFINITION_PARTS =
  16;

const MAX_COMPACT_STRING_LENGTH =
  240;

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function asObject(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    ? value
    : {};
}

function uniqueStrings(values = []) {
  return [
    ...new Set(
      (
        Array.isArray(values)
          ? values
          : [values]
      )
        .flat(Infinity)
        .map(
          (value) =>
            String(value || '').trim()
        )
        .filter(Boolean)
    )
  ];
}

function compactText(
  value,
  maxLength = MAX_COMPACT_STRING_LENGTH
) {
  const text =
    String(value || '').trim();

  if (!text) {
    return null;
  }

  return text.length > maxLength
    ? text.slice(0, maxLength)
    : text;
}

function compactStringList(
  values = [],
  limit = MAX_COMPACT_DEFINITION_PARTS,
  maxLength = MAX_COMPACT_STRING_LENGTH
) {
  return uniqueStrings(values)
    .map(
      (value) =>
        compactText(
          value,
          maxLength
        )
    )
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

function assertAnalyzeWrite(key) {
  const normalizedKey =
    String(key || '').trim();

  if (!normalizedKey) {
    throw new Error(
      'ANALYZE_WRITE_KEY_REQUIRED'
    );
  }

  if (
    typeof KeysApi.assertKeyAllowedForWriteScope ===
    'function'
  ) {
    return KeysApi.assertKeyAllowedForWriteScope(
      WRITE_SCOPE,
      normalizedKey
    );
  }

  if (
    !normalizedKey.startsWith(
      ANALYZE_KEY_PREFIX
    )
  ) {
    const error = new Error(
      'ANALYZE_WRITE_SCOPE_VIOLATION_SHORT_ONLY'
    );

    error.details = {
      scopeName:
        WRITE_SCOPE,

      key:
        normalizedKey,

      requiredPrefix:
        ANALYZE_KEY_PREFIX,

      namespace:
        SHORT_NAMESPACE,

      keyPrefix:
        SHORT_KEY_PREFIX,

      targetTradeSide:
        TARGET_TRADE_SIDE,

      dashboardSide:
        TARGET_DASHBOARD_SIDE,

      scannerSide:
        TARGET_SCANNER_SIDE,

      shortOnly:
        true,

      longDisabled:
        true,

      longRootTouched:
        false,

      virtualOnly:
        true,

      realOrdersDisabled:
        true,

      bitgetOrdersDisabled:
        true,

      exchangeOrdersDisabled:
        true
    };

    throw error;
  }

  return true;
}

function resolveWeekKey(value) {
  const raw =
    String(value || '').trim();

  return (
    raw ||
    PERSISTENT_LEARNING_KEY
  );
}

function observationTtlSec() {
  return Math.max(
    60,
    Math.floor(
      safeNumber(
        CONFIG.short?.analyze
          ?.observationDedupeTtlSec ??
          CONFIG.analyze
            ?.observationDedupeTtlSec,

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
        CONFIG.short?.analyze
          ?.outcomeDedupeTtlSec ??
          CONFIG.analyze
            ?.outcomeDedupeTtlSec,

        DEFAULT_OUTCOME_TTL_SEC
      )
    )
  );
}

function recentOutcomeLimit() {
  const configured = Math.floor(
    safeNumber(
      CONFIG.short?.analyze
        ?.recentOutcomeLimit ??
        CONFIG.analyze
          ?.recentOutcomeLimit,

      DEFAULT_RECENT_OUTCOME_LIMIT
    )
  );

  return Math.max(
    20,
    Math.min(
      MAX_RECENT_OUTCOME_LIMIT,
      configured
    )
  );
}

function maxMicroOutcomeHistoryBytes() {
  const configured = Math.floor(
    safeNumber(
      CONFIG.short?.analyze
        ?.maxMicroOutcomeHistoryBytes ??
        CONFIG.analyze
          ?.maxMicroOutcomeHistoryBytes,

      DEFAULT_MAX_MICRO_OUTCOME_HISTORY_BYTES
    )
  );

  return Math.max(
    250_000,
    Math.min(
      8_000_000,
      configured
    )
  );
}

function normalizeSource(value) {
  const source =
    upper(value || 'VIRTUAL');

  return source === 'SHADOW'
    ? 'SHADOW'
    : 'VIRTUAL';
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(
      JSON.stringify(value),
      'utf8'
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function compactMarketWeather(
  value = null
) {
  const weather =
    asObject(value);

  if (!Object.keys(weather).length) {
    return null;
  }

  return {
    ok:
      weather.ok !== false,

    available:
      weather.available !== false,

    version:
      compactText(
        weather.version,
        100
      ),

    source:
      compactText(
        weather.source,
        40
      ),

    snapshotId:
      compactText(
        weather.snapshotId,
        120
      ),

    generatedAt:
      safeNumber(
        weather.generatedAt,
        0
      ) || null,

    updatedAt:
      safeNumber(
        weather.updatedAt,
        0
      ) || null,

    currentRegime:
      compactText(
        weather.currentRegime ||
        weather.regime,
        40
      ),

    currentTrendSide:
      compactText(
        weather.currentTrendSide ||
        weather.trendSide,
        40
      ),

    currentFlow:
      compactText(
        weather.currentFlow ||
        weather.flow,
        60
      ),

    currentVolatilityState:
      compactText(
        weather.currentVolatilityState ||
        weather.volatilityState,
        60
      ),

    confidence:
      safeNumber(
        weather.confidence ??
        weather.weatherConfidence,
        0
      ),

    bullishPct:
      safeNumber(
        weather.bullishPct,
        0
      ),

    bearishPct:
      safeNumber(
        weather.bearishPct,
        0
      ),

    neutralPct:
      safeNumber(
        weather.neutralPct,
        0
      ),

    squeezePct:
      safeNumber(
        weather.squeezePct,
        0
      ),

    avgAtrPct:
      safeNumber(
        weather.avgAtrPct,
        0
      ),

    avgRangePct:
      safeNumber(
        weather.avgRangePct,
        0
      ),

    avgRealizedVolPct:
      safeNumber(
        weather.avgRealizedVolPct,
        0
      ),

    avgVolumeExpansion:
      safeNumber(
        weather.avgVolumeExpansion,
        0
      ),

    universeCount:
      safeNumber(
        weather.universeCount ??
        weather.count,
        0
      ),

    rowsExcluded:
      true,

    symbolsExcluded:
      true
  };
}

function compactOutcomeRecord(
  input = {},
  overrides = {}
) {
  const row = {
    ...asObject(input),
    ...asObject(overrides)
  };

  const childCandidate =
    upper(
      row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.microFamilyId ||
      row.analyzeMicroFamilyId ||
      row.learningMicroFamilyId
    );

  const parsed =
    parseShortTaxonomyMicroId(
      childCandidate
    );

  const childId =
    parsed?.isChild
      ? upper(
          parsed.childTrueMicroFamilyId ||
          childCandidate
        )
      : childCandidate;

  const parentId =
    upper(
      row.parentTrueMicroFamilyId ||
      row.parentMicroFamilyId ||
      row.parentMacroFamilyId ||
      row.coarseMicroFamilyId ||
      parsed?.parentTrueMicroFamilyId
    );

  const source =
    normalizeSource(
      row.source ||
      row.outcomeSource
    );

  const entry =
    safeNumber(
      row.entry ??
      row.entryPrice,
      0
    );

  const initialSl =
    safeNumber(
      row.initialSl ??
      row.initialStopLoss ??
      row.sl ??
      row.stopLoss,
      0
    );

  const sl =
    safeNumber(
      row.sl ??
      row.stopLoss ??
      initialSl,
      initialSl
    );

  const tp =
    safeNumber(
      row.tp ??
      row.takeProfit,
      0
    );

  const exitPrice =
    safeNumber(
      row.exitPrice ??
      row.currentPrice ??
      row.lastPrice ??
      row.price,
      0
    );

  const grossR =
    safeNumber(
      row.grossR ??
      row.shortGrossR ??
      row.rawR,
      0
    );

  const netR =
    safeNumber(
      row.netR ??
      row.exitR ??
      row.netPnlR ??
      row.realizedNetR ??
      row.realizedR,
      grossR
    );

  const costR =
    safeNumber(
      row.costR ??
      row.totalCostR,
      Math.max(
        0,
        grossR - netR
      )
    );

  const closedAt =
    safeNumber(
      row.closedAt ??
      row.completedAt ??
      row.exitAt,
      0
    );

  const openedAt =
    safeNumber(
      row.openedAt ??
      row.createdAt ??
      row.entryAt,
      0
    );

  const symbol =
    normalizeBaseSymbol(
      row.symbol ||
      row.baseSymbol ||
      row.contractSymbol
    ) || 'UNKNOWN';

  const contractSymbol =
    compactText(
      row.contractSymbol ||
      (
        symbol !== 'UNKNOWN'
          ? `${symbol}USDT`
          : null
      ),
      80
    );

  const weather =
    compactMarketWeather(
      row.currentMarketWeather ||
      row.marketWeather
    );

  return {
    ok:
      row.ok !== false,

    learnable:
      row.learnable !== false,

    outcomeId:
      compactText(
        row.outcomeId ||
        row.positionId ||
        row.tradeId ||
        row.id,
        160
      ),

    positionId:
      compactText(
        row.positionId ||
        row.tradeId ||
        row.id,
        160
      ),

    outcomeDedupeKey:
      compactText(
        row.outcomeDedupeKey,
        220
      ),

    snapshotId:
      compactText(
        row.snapshotId ||
        row.scanId ||
        row.batchId,
        160
      ),

    symbol,
    baseSymbol:
      symbol,
    contractSymbol,

    side:
      TARGET_DASHBOARD_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    scannerSide:
      TARGET_SCANNER_SIDE,

    actualScannerSide:
      TARGET_SCANNER_SIDE,

    source,
    outcomeSource:
      source,

    status:
      compactText(
        row.status || 'CLOSED',
        40
      ),

    shortOnly:
      true,

    longDisabled:
      true,

    virtualOnly:
      true,

    realTrade:
      false,

    realOrder:
      false,

    exchangeOrder:
      false,

    bitgetOrderPlaced:
      false,

    trueMicroFamilyId:
      childId || null,

    childTrueMicroFamilyId:
      childId || null,

    microFamilyId:
      childId || null,

    analyzeMicroFamilyId:
      childId || null,

    learningMicroFamilyId:
      childId || null,

    microMicroFamilyId:
      childId || null,

    parentTrueMicroFamilyId:
      parentId || null,

    parentMicroFamilyId:
      parentId || null,

    parentMacroFamilyId:
      parentId || null,

    coarseMicroFamilyId:
      parentId || null,

    setupType:
      compactText(
        row.setupType ||
        row.setup ||
        parsed?.setup,
        60
      ),

    regimeBucket:
      compactText(
        row.regimeBucket ||
        parsed?.regime,
        60
      ),

    confirmationProfile:
      compactText(
        row.confirmationProfile ||
        parsed?.confirmationProfile,
        80
      ),

    trueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity:
      LEARNING_GRANULARITY,

    parentLearningGranularity:
      PARENT_LEARNING_GRANULARITY,

    entry,
    entryPrice:
      entry,
    initialSl,
    sl,
    tp,
    exitPrice,

    grossR,
    shortGrossR:
      grossR,
    rawR:
      grossR,

    netR,
    exitR:
      netR,
    realizedR:
      safeNumber(
        row.realizedR,
        netR
      ),

    costR,

    directToSL:
      Boolean(
        row.directToSL ??
        row.directSL
      ),

    directSL:
      Boolean(
        row.directSL ??
        row.directToSL
      ),

    exitReason:
      compactText(
        upper(
          row.exitReason ||
          row.reason ||
          'UNKNOWN'
        ),
        100
      ),

    scannerReason:
      compactText(
        row.scannerReason,
        100
      ),

    currentFit:
      compactText(
        typeof row.currentFit === 'string'
          ? row.currentFit
          : row.currentFitLabel,
        100
      ),

    currentFitScore:
      safeNumber(
        row.currentFitScore ??
        row.fitScore,
        0
      ),

    scannerScore:
      safeNumber(
        row.scannerScore,
        0
      ),

    moveScore:
      safeNumber(
        row.moveScore,
        0
      ),

    change1h:
      safeNumber(
        row.change1h,
        0
      ),

    change24h:
      safeNumber(
        row.change24h,
        0
      ),

    volume24h:
      safeNumber(
        row.volume24h ??
        row.quoteVolume24h ??
        row.quoteVolume,
        0
      ),

    volumeExpansion:
      safeNumber(
        row.volumeExpansion,
        0
      ),

    atrPct:
      safeNumber(
        row.atrPct,
        0
      ),

    openedAt:
      openedAt || null,

    createdAt:
      openedAt ||
      safeNumber(
        row.createdAt,
        0
      ) ||
      null,

    closedAt:
      closedAt || null,

    completedAt:
      closedAt ||
      safeNumber(
        row.completedAt,
        0
      ) ||
      null,

    updatedAt:
      safeNumber(
        row.updatedAt,
        now()
      ),

    outcomeDuplicate:
      Boolean(
        row.outcomeDuplicate
      ),

    outcomeAlreadyRecorded:
      Boolean(
        row.outcomeAlreadyRecorded
      ),

    outcomeCounted:
      row.outcomeCounted !== false,

    countOutcome:
      row.countOutcome !== false,

    definitionParts:
      compactStringList(
        row.definitionParts ||
        row.microDefinitionParts ||
        [],
        MAX_COMPACT_DEFINITION_PARTS,
        180
      ),

    currentMarketWeather:
      weather,

    fullScannerPayloadExcluded:
      true,

    marketWeatherRowsExcluded:
      true,

    candleDataExcluded:
      true,

    executionFingerprintPartsExcluded:
      true
  };
}

function minimalOutcomeRecord(
  row = {}
) {
  const compact =
    compactOutcomeRecord(row);

  return {
    outcomeId:
      compact.outcomeId,

    positionId:
      compact.positionId,

    snapshotId:
      compact.snapshotId,

    symbol:
      compact.symbol,

    contractSymbol:
      compact.contractSymbol,

    source:
      compact.source,

    status:
      compact.status,

    trueMicroFamilyId:
      compact.trueMicroFamilyId,

    parentTrueMicroFamilyId:
      compact.parentTrueMicroFamilyId,

    setupType:
      compact.setupType,

    regimeBucket:
      compact.regimeBucket,

    confirmationProfile:
      compact.confirmationProfile,

    entry:
      compact.entry,

    initialSl:
      compact.initialSl,

    tp:
      compact.tp,

    exitPrice:
      compact.exitPrice,

    grossR:
      compact.grossR,

    netR:
      compact.netR,

    costR:
      compact.costR,

    exitReason:
      compact.exitReason,

    openedAt:
      compact.openedAt,

    closedAt:
      compact.closedAt,

    directSL:
      compact.directSL,

    currentFit:
      compact.currentFit,

    currentFitScore:
      compact.currentFitScore,

    compactEmergencyRecord:
      true
  };
}

function compactOutcomeHistory(
  rows = [],
  {
    maxItems = recentOutcomeLimit(),
    maxBytes = maxMicroOutcomeHistoryBytes()
  } = {}
) {
  const sourceRows =
    Array.isArray(rows)
      ? rows
      : [];

  const deduped =
    new Map();

  for (const row of sourceRows) {
    const compact =
      compactOutcomeRecord(row);

    const dedupeKey =
      compact.outcomeId ||
      compact.outcomeDedupeKey ||
      stableHash(
        {
          symbol:
            compact.symbol,

          trueMicroFamilyId:
            compact.trueMicroFamilyId,

          closedAt:
            compact.closedAt,

          exitReason:
            compact.exitReason,

          exitPrice:
            compact.exitPrice,

          netR:
            compact.netR
        },
        24
      );

    if (deduped.has(dedupeKey)) {
      deduped.delete(dedupeKey);
    }

    deduped.set(
      dedupeKey,
      compact
    );
  }

  let compactRows = [
    ...deduped.values()
  ].slice(
    -Math.max(
      1,
      Math.floor(maxItems)
    )
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
    compactRows = [
      minimalOutcomeRecord(
        compactRows[0]
      )
    ];
  }

  return compactRows;
}

function isMaxRequestSizeError(error) {
  const text =
    String(
      error?.message ||
      error ||
      ''
    ).toUpperCase();

  return (
    text.includes(
      'MAX REQUEST SIZE EXCEEDED'
    ) ||
    text.includes(
      '10485760'
    )
  );
}

async function saveMicroOutcomeHistory(
  redis,
  key,
  rows = []
) {
  assertAnalyzeWrite(key);

  let history =
    compactOutcomeHistory(rows);

  let bytes =
    jsonByteLength(history);

  try {
    await setJson(
      redis,
      key,
      history
    );

    return {
      history,
      bytes,
      fallbackUsed:
        false
    };
  } catch (error) {
    if (!isMaxRequestSizeError(error)) {
      throw error;
    }

    history =
      compactOutcomeHistory(
        history,
        {
          maxItems:
            Math.min(
              100,
              recentOutcomeLimit()
            ),

          maxBytes:
            EMERGENCY_MAX_MICRO_OUTCOME_HISTORY_BYTES
        }
      );

    bytes =
      jsonByteLength(history);

    await setJson(
      redis,
      key,
      history
    );

    return {
      history,
      bytes,
      fallbackUsed:
        true
    };
  }
}

async function compactExistingOutcomeHistory(
  redis,
  microId
) {
  const key =
    KEYS.analyze.microOutcomes(
      microId
    );

  const prior =
    await getJson(
      redis,
      key,
      []
    );

  const rows =
    Array.isArray(prior)
      ? prior
      : [];

  if (!rows.length) {
    return {
      cleaned:
        false,

      key,

      beforeRows:
        0,

      afterRows:
        0,

      beforeBytes:
        0,

      afterBytes:
        0
    };
  }

  const beforeBytes =
    jsonByteLength(rows);

  const saved =
    await saveMicroOutcomeHistory(
      redis,
      key,
      rows
    );

  return {
    cleaned:
      true,

    key,

    beforeRows:
      rows.length,

    afterRows:
      saved.history.length,

    beforeBytes,

    afterBytes:
      saved.bytes,

    fallbackUsed:
      saved.fallbackUsed
  };
}

function isExplicitNonShort(row = {}) {
  const candidates = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.side,
    row.targetTradeSide
  ].filter(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ''
  );

  return candidates.some(
    (value) => {
      const side =
        sideToTradeSide(value);

      return (
        side &&
        side !== TARGET_TRADE_SIDE
      );
    }
  );
}

function shortIdentityFlags() {
  return {
    targetTradeSide:
      TARGET_TRADE_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    side:
      TARGET_DASHBOARD_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    scannerSide:
      TARGET_SCANNER_SIDE,

    actualScannerSide:
      TARGET_SCANNER_SIDE,

    shortOnly:
      true,

    longDisabled:
      true,

    longOnly:
      false,

    shortDisabled:
      false,

    virtualOnly:
      true,

    virtualLearning:
      true,

    realOrdersDisabled:
      true,

    exchangeOrdersDisabled:
      true,

    bitgetOrdersDisabled:
      true,

    trueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    childTrueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    exactTrueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    microMicroFamilySchema:
      MICRO_MICRO_SCHEMA,

    learningGranularity:
      LEARNING_GRANULARITY,

    parentLearningGranularity:
      PARENT_LEARNING_GRANULARITY,

    selectionGranularity:
      'EXACT_75_CHILD',

    userFacingSelectionLayer:
      'MICRO_MICRO_FAMILY',

    redisNamespace:
      SHORT_NAMESPACE,

    redisKeyPrefix:
      SHORT_KEY_PREFIX,

    persistentLearningKey:
      PERSISTENT_LEARNING_KEY,

    redisKeysSeparatedFromLongRoot:
      true,

    longRootTouched:
      false,

    completedDefinition:
      'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',

    scoringRSource:
      'netR',

    winsLossesFlatsSource:
      'netR',

    winrateDefinition:
      'netR > 0',

    avgRSource:
      'netR',

    totalRSource:
      'netR',

    avgCostRShown:
      true,

    riskGeometryRule:
      'SHORT: tp < entry < sl',

    tpHitRule:
      'SHORT: price <= tp',

    slHitRule:
      'SHORT: price >= sl',

    grossRFormula:
      '(entry - exitPrice) / (initialSl - entry)',

    currentRFormula:
      '(entry - currentPrice) / (initialSl - entry)',

    currentFitSoftOnly:
      true,

    currentFitBlocksLearning:
      false,

    currentFitPolarity:
      'BEARISH_POSITIVE_BULLISH_NEGATIVE',

    currentFitDefinition:
      'SHORT_MIRRORED_CURRENT_FIT'
  };
}

function normalizeAnalyzeIdentity(
  input = {}
) {
  if (isExplicitNonShort(input)) {
    return null;
  }

  const attached =
    attachMicroFamilies({
      ...input,
      ...shortIdentityFlags()
    });

  const candidateId =
    upper(
      attached?.trueMicroFamilyId ||
      attached?.childTrueMicroFamilyId ||
      attached?.microFamilyId ||
      input.trueMicroFamilyId ||
      input.childTrueMicroFamilyId ||
      input.microFamilyId
    );

  if (
    !candidateId ||
    !validLearningId(candidateId)
  ) {
    return null;
  }

  if (
    !isSelectableShortTrueMicroFamilyId(
      candidateId
    )
  ) {
    return null;
  }

  const parsed =
    parseShortTaxonomyMicroId(
      candidateId
    );

  if (
    !parsed ||
    !parsed.isChild
  ) {
    return null;
  }

  const parentId =
    upper(
      parsed.parentTrueMicroFamilyId
    );

  const childId =
    upper(
      parsed.childTrueMicroFamilyId
    );

  if (
    !parentId ||
    !childId
  ) {
    return null;
  }

  return {
    ...input,
    ...attached,
    ...shortIdentityFlags(),

    setup:
      parsed.setup,

    setupType:
      parsed.setup,

    regimeBucket:
      parsed.regime,

    confirmationProfile:
      parsed.confirmationProfile,

    parentTrueMicroFamilyId:
      parentId,

    parentMicroFamilyId:
      parentId,

    parentMacroFamilyId:
      parentId,

    macroFamilyId:
      parentId,

    coarseMicroFamilyId:
      parentId,

    childTrueMicroFamilyId:
      childId,

    microFamilyId:
      childId,

    trueMicroFamilyId:
      childId,

    analyzeMicroFamilyId:
      childId,

    learningMicroFamilyId:
      childId,

    microMicroFamilyId:
      childId,

    exactMicroMicroFamilyId:
      childId,

    selectable:
      true,

    selectableChild:
      true,

    exactTrueMicroOnly:
      true,

    exactTrueMicroFamilyRequired:
      true
  };
}

function observationIdentity(row = {}) {
  const snapshotId =
    String(
      row.snapshotId ||
      row.scanId ||
      row.batchId ||
      'NO_SNAPSHOT'
    ).trim();

  const symbol =
    normalizeBaseSymbol(
      row.symbol ||
      row.baseSymbol ||
      row.contractSymbol
    ) || 'UNKNOWN';

  const microId =
    upper(
      row.trueMicroFamilyId ||
      row.microFamilyId
    );

  const entry =
    safeNumber(
      row.entry ??
      row.entryPrice,
      0
    );

  const raw =
    `${snapshotId}|` +
    `${symbol}|` +
    `${microId}|` +
    `${entry || 'NO_ENTRY'}`;

  return {
    snapshotId,
    symbol,
    microId,

    key:
      upper(
        row.observationDedupeKey ||
        raw
      ),

    redisKey:
      KEYS.analyze.obsLast(
        snapshotId,
        symbol,
        microId
      )
  };
}

function outcomeIdentity(row = {}) {
  const microId =
    upper(
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.childTrueMicroFamilyId
    );

  const positionId =
    String(
      row.positionId ||
      row.tradeId ||
      row.id ||
      row.outcomeId ||
      row.entryId ||
      ''
    ).trim();

  const symbol =
    normalizeBaseSymbol(
      row.symbol ||
      row.baseSymbol ||
      row.contractSymbol
    ) || 'UNKNOWN';

  const closedAt =
    safeNumber(
      row.closedAt ??
      row.completedAt ??
      row.exitAt,
      0
    );

  const exitReason =
    upper(
      row.exitReason ||
      row.reason ||
      'UNKNOWN'
    );

  const fallback =
    stableHash(
      {
        microId,
        symbol,
        closedAt,
        exitReason,
        exitPrice:
          row.exitPrice
      },
      20
    );

  const id =
    positionId ||
    fallback;

  return {
    id,

    key:
      `${id}|${microId}`,

    redisKey:
      KEYS.analyze.obsLast(
        `OUTCOME_${id}`,
        symbol,
        microId
      )
  };
}

function createStatsFor(row = {}) {
  return createMicroStats({
    microFamilyId:
      row.trueMicroFamilyId,

    familyId:
      row.parentTrueMicroFamilyId,

    side:
      TARGET_DASHBOARD_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    definitionParts:
      compactStringList(
        row.definitionParts ||
        row.microDefinitionParts ||
        [],
        MAX_COMPACT_DEFINITION_PARTS,
        180
      )
  });
}

function createParentStatsFor(row = {}) {
  const parentId =
    row.parentTrueMicroFamilyId;

  const timestamp =
    now();

  return {
    parentTrueMicroFamilyId:
      parentId,

    microFamilyId:
      parentId,

    trueMicroFamilyId:
      parentId,

    familyId:
      parentId,

    schema:
      PARENT_TRUE_MICRO_SCHEMA,

    trueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity:
      PARENT_LEARNING_GRANULARITY,

    setupType:
      row.setupType || null,

    regimeBucket:
      row.regimeBucket || null,

    seen:
      0,

    observations:
      0,

    completed:
      0,

    wins:
      0,

    losses:
      0,

    flats:
      0,

    totalR:
      0,

    netTotalR:
      0,

    totalCostR:
      0,

    grossTotalR:
      0,

    avgR:
      0,

    avgCostR:
      0,

    winrate:
      0,

    recentOutcomes:
      [],

    children:
      [],

    observationDedupeKeys:
      [],

    createdAt:
      timestamp,

    updatedAt:
      timestamp,

    ...shortIdentityFlags(),

    selectable:
      false,

    parentSelectable:
      false,

    childSelectable:
      true
  };
}

function updateParentObservation(
  stats = {},
  row = {}
) {
  const out = {
    ...createParentStatsFor(row),
    ...asObject(stats)
  };

  const childId =
    row.trueMicroFamilyId;

  const obsKey =
    String(
      row.observationDedupeKey || ''
    );

  const dedupeKeys =
    Array.isArray(
      out.observationDedupeKeys
    )
      ? out.observationDedupeKeys
      : [];

  if (
    obsKey &&
    dedupeKeys.includes(obsKey)
  ) {
    return out;
  }

  out.seen =
    safeNumber(
      out.seen,
      0
    ) + 1;

  out.observations =
    safeNumber(
      out.observations,
      0
    ) + 1;

  out.children =
    uniqueStrings([
      out.children || [],
      childId
    ]).slice(-75);

  out.observationDedupeKeys =
    obsKey
      ? [
          ...dedupeKeys,
          obsKey
        ].slice(-1000)
      : dedupeKeys.slice(-1000);

  out.updatedAt =
    now();

  return out;
}

function updateParentOutcome(
  stats = {},
  row = {}
) {
  const out = {
    ...createParentStatsFor(row),
    ...asObject(stats)
  };

  const netR =
    safeNumber(
      row.netR ??
      row.exitR ??
      row.netPnlR,
      0
    );

  const grossR =
    safeNumber(
      row.grossR ??
      row.rawR,
      netR
    );

  const costR =
    safeNumber(
      row.costR,
      Math.max(
        0,
        grossR - netR
      )
    );

  out.completed =
    safeNumber(
      out.completed,
      0
    ) + 1;

  out.wins =
    safeNumber(
      out.wins,
      0
    ) +
    (
      netR > 0
        ? 1
        : 0
    );

  out.losses =
    safeNumber(
      out.losses,
      0
    ) +
    (
      netR < 0
        ? 1
        : 0
    );

  out.flats =
    safeNumber(
      out.flats,
      0
    ) +
    (
      netR === 0
        ? 1
        : 0
    );

  out.totalR =
    safeNumber(
      out.totalR,
      0
    ) +
    netR;

  out.netTotalR =
    out.totalR;

  out.grossTotalR =
    safeNumber(
      out.grossTotalR,
      0
    ) +
    grossR;

  out.totalCostR =
    safeNumber(
      out.totalCostR,
      0
    ) +
    costR;

  out.avgR =
    out.completed > 0
      ? out.totalR /
        out.completed
      : 0;

  out.avgCostR =
    out.completed > 0
      ? out.totalCostR /
        out.completed
      : 0;

  out.winrate =
    out.completed > 0
      ? out.wins /
        out.completed
      : 0;

  out.children =
    uniqueStrings([
      out.children || [],
      row.trueMicroFamilyId
    ]).slice(-75);

  out.recentOutcomes = [
    ...(
      Array.isArray(
        out.recentOutcomes
      )
        ? out.recentOutcomes
        : []
    ),

    {
      outcomeId:
        row.outcomeId || null,

      childTrueMicroFamilyId:
        row.trueMicroFamilyId,

      symbol:
        row.symbol || null,

      netR,
      grossR,
      costR,

      source:
        row.source,

      exitReason:
        row.exitReason || null,

      closedAt:
        row.closedAt ||
        row.completedAt ||
        now()
    }
  ].slice(
    -recentOutcomeLimit()
  );

  out.updatedAt =
    now();

  return out;
}

async function saveAggregate(
  redis,
  key,
  value
) {
  assertAnalyzeWrite(key);

  await setJson(
    redis,
    key,
    value
  );

  return value;
}

export async function getWeekMicros(
  weekKey =
    PERSISTENT_LEARNING_KEY
) {
  const redis =
    getDurableRedis();

  const key =
    KEYS.analyze.weekMicros(
      resolveWeekKey(weekKey)
    );

  const value =
    await getJson(
      redis,
      key,
      {}
    );

  return asObject(value);
}

export async function saveWeekMicros(
  weekKey =
    PERSISTENT_LEARNING_KEY,
  micros = {}
) {
  const redis =
    getDurableRedis();

  const key =
    KEYS.analyze.weekMicros(
      resolveWeekKey(weekKey)
    );

  return saveAggregate(
    redis,
    key,
    asObject(micros)
  );
}

export async function getWeekParents(
  weekKey =
    PERSISTENT_LEARNING_KEY
) {
  const redis =
    getDurableRedis();

  const key =
    KEYS.analyze.weekParents(
      resolveWeekKey(weekKey)
    );

  const value =
    await getJson(
      redis,
      key,
      {}
    );

  return asObject(value);
}

export async function saveWeekParents(
  weekKey =
    PERSISTENT_LEARNING_KEY,
  parents = {}
) {
  const redis =
    getDurableRedis();

  const key =
    KEYS.analyze.weekParents(
      resolveWeekKey(weekKey)
    );

  return saveAggregate(
    redis,
    key,
    asObject(parents)
  );
}

async function updateObservationInWeek(
  redis,
  weekKey,
  row
) {
  const key =
    KEYS.analyze.weekMicros(
      weekKey
    );

  const micros =
    asObject(
      await getJson(
        redis,
        key,
        {}
      )
    );

  const current =
    micros[
      row.trueMicroFamilyId
    ] ||
    createStatsFor(row);

  micros[
    row.trueMicroFamilyId
  ] =
    refreshStats(
      updateObservation(
        current,
        row
      )
    );

  await saveAggregate(
    redis,
    key,
    micros
  );

  return micros[
    row.trueMicroFamilyId
  ];
}

async function updateParentObservationInWeek(
  redis,
  weekKey,
  row
) {
  const key =
    KEYS.analyze.weekParents(
      weekKey
    );

  const parents =
    asObject(
      await getJson(
        redis,
        key,
        {}
      )
    );

  const parentId =
    row.parentTrueMicroFamilyId;

  parents[parentId] =
    updateParentObservation(
      parents[parentId],
      row
    );

  await saveAggregate(
    redis,
    key,
    parents
  );

  return parents[parentId];
}

async function updateOutcomeInWeek(
  redis,
  weekKey,
  row,
  source
) {
  const key =
    KEYS.analyze.weekMicros(
      weekKey
    );

  const micros =
    asObject(
      await getJson(
        redis,
        key,
        {}
      )
    );

  const current =
    micros[
      row.trueMicroFamilyId
    ] ||
    createStatsFor(row);

  micros[
    row.trueMicroFamilyId
  ] =
    refreshStats(
      updateOutcome(
        current,
        row,
        source
      )
    );

  await saveAggregate(
    redis,
    key,
    micros
  );

  return micros[
    row.trueMicroFamilyId
  ];
}

async function updateParentOutcomeInWeek(
  redis,
  weekKey,
  row
) {
  const key =
    KEYS.analyze.weekParents(
      weekKey
    );

  const parents =
    asObject(
      await getJson(
        redis,
        key,
        {}
      )
    );

  const parentId =
    row.parentTrueMicroFamilyId;

  parents[parentId] =
    updateParentOutcome(
      parents[parentId],
      row
    );

  await saveAggregate(
    redis,
    key,
    parents
  );

  return parents[parentId];
}

export async function recordObservation(
  trade = {},
  options = {}
) {
  const row =
    normalizeAnalyzeIdentity({
      ...trade,
      ...shortIdentityFlags()
    });

  if (!row) {
    return {
      ok:
        false,

      skipped:
        true,

      reason:
        'INVALID_OR_NON_SHORT_EXACT_75_CHILD_ID'
    };
  }

  const redis =
    getDurableRedis();

  const identity =
    observationIdentity(row);

  const dedupeValue = {
    observationDedupeKey:
      identity.key,

    snapshotId:
      identity.snapshotId,

    symbol:
      identity.symbol,

    trueMicroFamilyId:
      identity.microId,

    createdAt:
      now()
  };

  assertAnalyzeWrite(
    identity.redisKey
  );

  const insertResult =
    await setNxJson(
      redis,
      identity.redisKey,
      dedupeValue,
      {
        ex:
          observationTtlSec()
      }
    );

  const inserted =
    nxInsertSucceeded(
      insertResult
    );

  if (!inserted) {
    return {
      ok:
        true,

      skipped:
        true,

      duplicate:
        true,

      reason:
        'OBSERVATION_ALREADY_RECORDED',

      row: {
        ...row,

        observationRecorded:
          false,

        observationDuplicate:
          true,

        observationDedupeKey:
          identity.key
      }
    };
  }

  const observedAt =
    now();

  const enriched = {
    ...row,

    observationId:
      randomId('obs'),

    observationDedupeKey:
      identity.key,

    observationRecorded:
      true,

    observationDuplicate:
      false,

    observationAlwaysCounted:
      false,

    observedAt,

    createdAt:
      row.createdAt ||
      observedAt
  };

  const requestedWeekKey =
    resolveWeekKey(
      options.weekKey ||
      options.persistentLearningKey
    );

  const isoWeekKey =
    getIsoWeekKey(
      enriched.observedAt
    );

  const weekKeys =
    uniqueStrings([
      requestedWeekKey,
      PERSISTENT_LEARNING_KEY,
      isoWeekKey
    ]);

  const childStats = [];

  for (
    const weekKey
    of weekKeys
  ) {
    childStats.push(
      await updateObservationInWeek(
        redis,
        weekKey,
        enriched
      )
    );

    await updateParentObservationInWeek(
      redis,
      weekKey,
      enriched
    );
  }

  const primaryStats =
    childStats[0] || null;

  await saveAggregate(
    redis,

    KEYS.analyze.microStats(
      enriched.trueMicroFamilyId
    ),

    primaryStats
  );

  const requestedParents =
    asObject(
      await getJson(
        redis,

        KEYS.analyze.weekParents(
          requestedWeekKey
        ),

        {}
      )
    );

  await saveAggregate(
    redis,

    KEYS.analyze.parentStats(
      enriched.parentTrueMicroFamilyId
    ),

    requestedParents[
      enriched.parentTrueMicroFamilyId
    ] || null
  );

  return {
    ok:
      true,

    skipped:
      false,

    duplicate:
      false,

    recordId:
      identity.redisKey,

    row:
      enriched,

    stats:
      primaryStats
  };
}

export async function analyzeCandidate(
  candidate = {},
  options = {}
) {
  const identity =
    normalizeAnalyzeIdentity(
      candidate
    );

  if (!identity) {
    return null;
  }

  const result =
    await recordObservation(
      identity,
      options
    );

  return {
    ...identity,

    observationRecorded:
      Boolean(
        result.ok &&
        !result.skipped
      ),

    observationDuplicate:
      Boolean(
        result.duplicate
      ),

    observationDedupeKey:
      result.row
        ?.observationDedupeKey ||
      observationIdentity(
        identity
      ).key,

    analyzeObservationResult: {
      ok:
        Boolean(result.ok),

      skipped:
        Boolean(result.skipped),

      duplicate:
        Boolean(result.duplicate),

      reason:
        result.reason || null
    }
  };
}

export async function analyzeCandidatesBatch(
  candidates = [],
  options = {}
) {
  const rows =
    Array.isArray(candidates)
      ? candidates
      : [];

  const output = [];

  for (
    const candidate
    of rows
  ) {
    const analyzed =
      await analyzeCandidate(
        candidate,
        options
      );

    if (analyzed) {
      output.push(analyzed);
    }
  }

  return output;
}

function calculateGrossR(
  position = {},
  exitPrice
) {
  const entry =
    safeNumber(
      position.entry ??
      position.entryPrice,
      0
    );

  const initialSl =
    safeNumber(
      position.initialSl ??
      position.sl,
      0
    );

  const exit =
    safeNumber(
      exitPrice ??
      position.exitPrice,
      0
    );

  const risk =
    initialSl - entry;

  if (
    !(
      entry > 0 &&
      initialSl > entry &&
      exit > 0 &&
      risk > 0
    )
  ) {
    return 0;
  }

  return (
    entry - exit
  ) / risk;
}

export function buildOutcomeFromPosition({
  position = {},
  exitPrice,
  exitReason,
  source = 'VIRTUAL'
} = {}) {
  const identity =
    normalizeAnalyzeIdentity(
      position
    );

  if (!identity) {
    return {
      ok:
        false,

      learnable:
        false,

      reason:
        'INVALID_POSITION_LEARNING_ID',

      source:
        normalizeSource(source),

      ...shortIdentityFlags()
    };
  }

  const normalizedExitPrice =
    safeNumber(
      exitPrice,
      safeNumber(
        position.exitPrice,
        0
      )
    );

  const grossR =
    calculateGrossR(
      position,
      normalizedExitPrice
    );

  const closedAt =
    safeNumber(
      position.closedAt ??
      position.completedAt,
      now()
    );

  const outcomeId =
    String(
      position.outcomeId ||
      position.positionId ||
      position.tradeId ||
      position.id ||
      randomId('outcome')
    );

  const normalizedNetR =
    safeNumber(
      position.netR ??
      position.netPnlR ??
      position.exitR,
      grossR
    );

  const normalizedSource =
    normalizeSource(source);

  return compactOutcomeRecord(
    position,
    {
      ok:
        true,

      learnable:
        true,

      outcomeId,

      positionId:
        position.positionId ||
        position.id ||
        null,

      source:
        normalizedSource,

      outcomeSource:
        normalizedSource,

      status:
        'CLOSED',

      exitPrice:
        normalizedExitPrice,

      exitReason:
        upper(
          exitReason ||
          position.exitReason ||
          'UNKNOWN'
        ),

      closedAt,

      completedAt:
        closedAt,

      grossR,

      shortGrossR:
        grossR,

      rawR:
        grossR,

      netR:
        normalizedNetR,

      exitR:
        normalizedNetR,

      costR:
        safeNumber(
          position.costR,
          Math.max(
            0,
            grossR -
            normalizedNetR
          )
        ),

      directToSL:
        Boolean(
          position.directToSL ??
          position.directSL
        ),

      directSL:
        Boolean(
          position.directSL ??
          position.directToSL
        ),

      createdAt:
        position.createdAt ||
        position.openedAt ||
        now(),

      updatedAt:
        now(),

      trueMicroFamilyId:
        identity.trueMicroFamilyId,

      childTrueMicroFamilyId:
        identity.childTrueMicroFamilyId,

      parentTrueMicroFamilyId:
        identity.parentTrueMicroFamilyId,

      setupType:
        identity.setupType,

      regimeBucket:
        identity.regimeBucket,

      confirmationProfile:
        identity.confirmationProfile
    }
  );
}

export async function recordOutcome(
  outcome = {},
  options = {}
) {
  const row =
    normalizeAnalyzeIdentity({
      ...outcome,
      ...shortIdentityFlags()
    });

  if (
    !row ||
    outcome.learnable === false
  ) {
    return {
      ok:
        false,

      skipped:
        true,

      reason:
        'INVALID_OR_NON_SHORT_OUTCOME_ID'
    };
  }

  const source =
    normalizeSource(
      options.source ||
      row.source ||
      row.outcomeSource
    );

  const redis =
    getDurableRedis();

  const identity =
    outcomeIdentity(row);

  assertAnalyzeWrite(
    identity.redisKey
  );

  const insertResult =
    await setNxJson(
      redis,

      identity.redisKey,

      {
        outcomeDedupeKey:
          identity.key,

        outcomeId:
          identity.id,

        trueMicroFamilyId:
          row.trueMicroFamilyId,

        createdAt:
          now()
      },

      {
        ex:
          outcomeTtlSec()
      }
    );

  const inserted =
    nxInsertSucceeded(
      insertResult
    );

  if (!inserted) {
    const cleanup =
      await compactExistingOutcomeHistory(
        redis,
        row.trueMicroFamilyId
      ).catch(
        (error) => ({
          cleaned:
            false,

          error:
            error?.message ||
            String(error)
        })
      );

    return {
      ok:
        true,

      skipped:
        true,

      duplicate:
        true,

      reason:
        'OUTCOME_ALREADY_RECORDED',

      outcomeId:
        identity.id,

      outcomeHistoryCleanup:
        cleanup
    };
  }

  const closedAt =
    safeNumber(
      row.closedAt ??
      row.completedAt,
      now()
    );

  const completedAt =
    safeNumber(
      row.completedAt ??
      row.closedAt,
      closedAt
    );

  const enriched =
    compactOutcomeRecord(
      row,
      {
        outcomeId:
          identity.id,

        outcomeDedupeKey:
          identity.key,

        outcomeDuplicate:
          false,

        outcomeAlreadyRecorded:
          false,

        outcomeCounted:
          true,

        countOutcome:
          true,

        source,

        outcomeSource:
          source,

        status:
          'CLOSED',

        closedAt,

        completedAt
      }
    );

  const requestedWeekKey =
    resolveWeekKey(
      options.weekKey ||
      options.persistentLearningKey
    );

  const isoWeekKey =
    getIsoWeekKey(
      enriched.completedAt
    );

  const weekKeys =
    uniqueStrings([
      requestedWeekKey,
      PERSISTENT_LEARNING_KEY,
      isoWeekKey
    ]);

  const childStats = [];

  for (
    const weekKey
    of weekKeys
  ) {
    childStats.push(
      await updateOutcomeInWeek(
        redis,
        weekKey,
        enriched,
        source
      )
    );

    await updateParentOutcomeInWeek(
      redis,
      weekKey,
      enriched
    );
  }

  const primaryStats =
    childStats[0] || null;

  await saveAggregate(
    redis,

    KEYS.analyze.microStats(
      enriched.trueMicroFamilyId
    ),

    primaryStats
  );

  const outcomeKey =
    KEYS.analyze.microOutcomes(
      enriched.trueMicroFamilyId
    );

  const priorOutcomes =
    await getJson(
      redis,
      outcomeKey,
      []
    );

  const savedHistory =
    await saveMicroOutcomeHistory(
      redis,
      outcomeKey,
      [
        ...(
          Array.isArray(
            priorOutcomes
          )
            ? priorOutcomes
            : []
        ),

        enriched
      ]
    );

  const parentMap =
    asObject(
      await getJson(
        redis,

        KEYS.analyze.weekParents(
          requestedWeekKey
        ),

        {}
      )
    );

  await saveAggregate(
    redis,

    KEYS.analyze.parentStats(
      enriched.parentTrueMicroFamilyId
    ),

    parentMap[
      enriched.parentTrueMicroFamilyId
    ] || null
  );

  return {
    ok:
      true,

    skipped:
      false,

    duplicate:
      false,

    outcomeId:
      identity.id,

    outcome:
      enriched,

    stats:
      primaryStats,

    outcomeHistory: {
      key:
        outcomeKey,

      rows:
        savedHistory.history.length,

      bytes:
        savedHistory.bytes,

      maxBytes:
        maxMicroOutcomeHistoryBytes(),

      compact:
        true,

      fallbackUsed:
        savedHistory.fallbackUsed,

      fullRowsPersisted:
        false,

      marketWeatherRowsPersisted:
        false
    }
  };
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