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
// Compatibility:
// - ondersteunt keys.js met export `KEYS`
// - ondersteunt oudere keys.js met export `keys`
// - veroorzaakt geen ESM-importfout wanneer
//   `assertKeyAllowedForWriteScope` niet wordt geëxporteerd
// - fallback-writeguard staat uitsluitend SHORT:ANALYZE:* toe

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

function plainClone(value) {
  try {
    return JSON.parse(
      JSON.stringify(value)
    );
  } catch {
    return {
      ...asObject(value)
    };
  }
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

  /*
   * Gebruik de centrale write-scopeguard wanneer de
   * actieve keys.js-versie deze functie exporteert.
   *
   * Door de namespace-import ontstaat geen ESM-importfout
   * wanneer deze export in een oudere versie ontbreekt.
   */
  if (
    typeof KeysApi.assertKeyAllowedForWriteScope ===
    'function'
  ) {
    return KeysApi.assertKeyAllowedForWriteScope(
      WRITE_SCOPE,
      normalizedKey
    );
  }

  /*
   * Compatibiliteitsfallback:
   * Analyze mag uitsluitend onder SHORT:ANALYZE:* schrijven.
   */
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
  return Math.max(
    20,
    Math.floor(
      safeNumber(
        CONFIG.short?.analyze
          ?.recentOutcomeLimit ??
          CONFIG.analyze
            ?.recentOutcomeLimit,

        DEFAULT_RECENT_OUTCOME_LIMIT
      )
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

    /*
     * Dashboard/product-alias.
     * Er wordt geen extra taxonomielaag gemaakt.
     */
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
      row.definitionParts ||
      row.microDefinitionParts ||
      []
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
    ]);

  out.observationDedupeKeys =
    obsKey
      ? [
          ...dedupeKeys,
          obsKey
        ].slice(-5000)
      : dedupeKeys;

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
    ]);

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

      netR,
      grossR,
      costR,

      source:
        row.source,

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

  /*
   * Sequentiële writes voorkomen verloren updates in
   * het gedeelde Redis JSON-aggregate.
   */
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

  return {
    ...plainClone(position),
    ...identity,
    ...shortIdentityFlags(),

    ok:
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

    learnable:
      true,

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
      now()
  };
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
        identity.id
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

  const enriched = {
    ...row,
    ...shortIdentityFlags(),

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
  };

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

  await saveAggregate(
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
    ].slice(
      -recentOutcomeLimit()
    )
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
      primaryStats
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