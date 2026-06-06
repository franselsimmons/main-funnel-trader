// ================= FILE: api/admin/rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import {
  getDurableRedis,
  setJson
} from '../../src/redis.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

const ALLOWED_ACTIONS = [
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestShortMicroFamily',
  'activateSelected',
  'activateSelectedMicroFamilies',
  'activateSelectedMacroFamilies'
];

const BLOCKED_LONG_ACTIONS = new Set([
  'activateBestLongMicroFamily',
  'activateBestBullMicroFamily',
  'activateBestLong',
  'activateLong'
]);

const ALLOWED_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const DEFAULT_ACTIVE_ROWS_LIMIT = 60;
const DEFAULT_NEXT_ROWS_LIMIT = 25;
const MAX_ROWS_LIMIT = 160;

const DEFAULT_BEST_SINGLE_TOP_N = 1;
const DEFAULT_ROTATION_TOP_N = 50;
const MAX_ROTATION_TOP_N = 160;

const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE = 25;
const DEFAULT_RECENT_WEEK_LOOKBACK = 10;
const MAX_RECENT_WEEK_LOOKBACK = 16;

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;

const WEEK_ROWS_CACHE_TTL_MS = 30_000;
const WEEK_ROWS_CACHE_MAX_KEYS = 16;
const HARD_ROUTE_BUDGET_MS = 52_000;

const weekRowsCache = globalThis.__ADMIN_ROTATION_SHORT_OBSERVATION_ROWS_CACHE__ ||= new Map();

function now() {
  return Date.now();
}

function elapsed(startedAt) {
  return now() - startedAt;
}

function routeBudgetExceeded(startedAt, maxMs = HARD_ROUTE_BUDGET_MS) {
  return elapsed(startedAt) >= maxMs;
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST']
  });
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body.trim());
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8').trim());

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8').trim());
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES' ||
    value === 'on' ||
    value === 'ON'
  );
}

function toLimit(value, fallback = DEFAULT_ACTIVE_ROWS_LIMIT, max = MAX_ROWS_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n < 1) return fallback;

  return Math.min(n, max);
}

function normalizeMode(value, fallback = 'balanced') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
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

function normalizeFamilyIds(...values) {
  return uniqueStrings(values);
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function clamp(value, min = 0, max = 1) {
  const n = num(value, min);

  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

async function getRedisJson(redis, key, fallback = null) {
  if (!key || !redis || typeof redis.get !== 'function') return fallback;

  const value = await redis.get(key);

  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getMacroSchema() {
  return String(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    CONFIG.analyze?.schema ||
    'MF_V1'
  ).toUpperCase();
}

function getMicroSchema() {
  return String(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  ).toUpperCase();
}

function idHasSchema(id, schema) {
  const value = upper(id);
  const target = upper(schema);

  if (!value || !target) return false;

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function rowSchema(row = {}) {
  return upper(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  );
}

function rowMicroId(row = {}) {
  return String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
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

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
  if (Array.isArray(row.definition)) return row.definition;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY', 'SHORT');
}

function normalizeRequestedTradeSide(value) {
  const raw = cleanSideText(value);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === 'LONG') return 'LONG';

  return 'UNKNOWN';
}

function assertShortOnlySide(side) {
  if (side === TARGET_TRADE_SIDE) return;

  const error = new Error(
    side === 'LONG'
      ? 'LONG_DISABLED_SHORT_ONLY'
      : 'VALID_SIDE_REQUIRED_SHORT'
  );

  error.statusCode = 400;
  throw error;
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => cleanSideText(value))
    .join(' | ');
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    const value = cleanSideText(row);

    if (value.includes('MICRO_LONG_')) return 'LONG';
    if (value.includes('TRADESIDE=LONG')) return 'LONG';
    if (value.includes('TRADE_SIDE=LONG')) return 'LONG';
    if (value.includes('SIDE=LONG')) return 'LONG';
    if (value.includes('SIDE=BULL')) return 'LONG';
    if (value.includes('DIRECTION=LONG')) return 'LONG';
    if (value.includes('DIRECTION=BULL')) return 'LONG';

    if (value.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (value.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (value.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (value.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (value.includes('SIDE=BEAR')) return TARGET_TRADE_SIDE;
    if (value.includes('DIRECTION=SHORT')) return TARGET_TRADE_SIDE;
    if (value.includes('DIRECTION=BEAR')) return TARGET_TRADE_SIDE;
    if (value.includes('SHORT')) return TARGET_TRADE_SIDE;
    if (value.includes('BEAR')) return TARGET_TRADE_SIDE;
    if (value.includes('SELL')) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.analysisSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === 'LONG') return direct;

  const rawSide = upper(row.side);

  if (['BULL', 'LONG', 'BUY', 'BULLISH'].includes(rawSide)) return 'LONG';
  if (['BEAR', 'SHORT', 'SELL', 'BEARISH'].includes(rawSide)) return TARGET_TRADE_SIDE;

  const familyId = cleanSideText(row.familyId || row.family || row.baseFamilyId);

  const macroFamilyId = cleanSideText(
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    ''
  );

  const microFamilyId = cleanSideText(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  );

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;

  if (macroFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (macroFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;

  const definition = getDefinitionHaystack(row);

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY')
  ) {
    return 'LONG';
  }

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (microFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('LONG')) return 'LONG';

  if (microFamilyId.includes('SHORT')) return TARGET_TRADE_SIDE;
  if (macroFamilyId.includes('SHORT')) return TARGET_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== 'LONG';
}

function isShortId(id = '') {
  return inferTradeSide(String(id || '')) !== 'LONG';
}

function isLegacyMacroFamilyRow(row = {}) {
  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = upper(row.version);
  const macroSchema = getMacroSchema();

  if (!row || !id) return false;
  if (inferTradeSide(row) === 'LONG') return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (schema === macroSchema) return true;
  if (idHasSchema(id, macroSchema)) return true;

  return false;
}

function isTrueMicroFamilyRow(row = {}) {
  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = upper(row.version);

  const macroSchema = getMacroSchema();
  const microSchema = getMicroSchema();

  if (!row || !id) return false;
  if (inferTradeSide(row) === 'LONG') return false;

  if (row.isLegacyMacro === true) return false;
  if (version.includes('MACRO')) return false;
  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;

  if (row.isTrueMicro === true || row.trueMicro === true) return true;
  if (version.includes('MICRO')) return true;
  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;

  const macroId = getMacroFamilyId(row);

  return Boolean(macroId && macroId !== id);
}

function getOutcomeCounts(row = {}) {
  const realWins = num(row.realWins, 0);
  const realLosses = num(row.realLosses, 0);
  const realFlats = num(row.realFlats, 0);

  const shadowWins = num(row.shadowWins, 0);
  const shadowLosses = num(row.shadowLosses, 0);
  const shadowFlats = num(row.shadowFlats, 0);

  const actualWins = realWins + shadowWins;
  const actualLosses = realLosses + shadowLosses;
  const actualFlats = realFlats + shadowFlats;
  const actualTotal = actualWins + actualLosses + actualFlats;

  if (actualTotal > 0) {
    return {
      wins: actualWins,
      losses: actualLosses,
      flats: actualFlats,
      total: actualTotal
    };
  }

  const weightedWins = num(row.wins, 0);
  const weightedLosses = num(row.losses, 0);
  const weightedFlats = num(row.flats, 0);
  const weightedTotal = weightedWins + weightedLosses + weightedFlats;

  if (weightedTotal > 0) {
    return {
      wins: weightedWins,
      losses: weightedLosses,
      flats: weightedFlats,
      total: weightedTotal
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
  const counts = getOutcomeCounts(row);

  return Math.max(
    counts.total,
    num(row.completed, 0),
    num(row.realCompleted, 0) + num(row.shadowCompleted, 0),
    0
  );
}

function observationSample(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    num(row.winrateSample, 0),
    completedSample(row),
    0
  );
}

function wilsonLowerBound(successes, trials, z = WINRATE_Z) {
  const n = num(trials, 0);

  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function sampleReliability(sample, cap = SAMPLE_RELIABILITY_CAP) {
  const n = num(sample, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1);
}

function sampleWinrateMeta(row = {}) {
  const counts = getOutcomeCounts(row);
  const outcomeSample = completedSample(row);
  const obsSample = observationSample(row);

  if (outcomeSample <= 0) {
    return {
      sample: obsSample,
      outcomeSample: 0,
      observationSample: obsSample,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(obsSample),
      score: 0,
      awaitingOutcomes: obsSample > 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / outcomeSample, 0, 1);

  const bayesianWinrate = clamp(
    (successes + WINRATE_BAYES_ALPHA) /
      (outcomeSample + WINRATE_BAYES_ALPHA + WINRATE_BAYES_BETA),
    0,
    1
  );

  const wilson = wilsonLowerBound(successes, outcomeSample);
  const reliability = sampleReliability(outcomeSample);

  const score = clamp(
    wilson * 0.8 +
      bayesianWinrate * 0.15 +
      rawWinrate * 0.05,
    0,
    1
  );

  return {
    sample: outcomeSample,
    outcomeSample,
    observationSample: obsSample,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score,
    awaitingOutcomes: false
  };
}

function observationActivityScore(row = {}, meta = null) {
  const obsSample = meta?.observationSample ?? observationSample(row);

  if (obsSample <= 0) return 0;

  const seenComponent = Math.log1p(obsSample) * 8;
  const reliabilityComponent = sampleReliability(obsSample) * 18;

  const scannerBonus = row.scannerReason || row.scannerReasonCoarse ? 2 : 0;
  const definitionBonus = getDefinitionParts(row).length > 0 ? 2 : 0;

  return Math.max(
    1,
    Math.min(45, seenComponent + reliabilityComponent + scannerBonus + definitionBonus)
  );
}

function performanceBalancedScore(row = {}, meta = null) {
  const winrateMeta = meta || sampleWinrateMeta(row);

  const totalR = Math.max(0, num(row.totalR, 0));
  const avgR = Math.max(0, num(row.avgR, 0));
  const profitFactor = Math.min(Math.max(0, num(row.profitFactor, 0)), 20);

  const directSLPct = clamp(row.directSLPct, 0, 1);
  const nearTpThenLossPct = clamp(row.nearTpThenLossPct, 0, 1);
  const gaveBackAfterOneRPct = clamp(row.gaveBackAfterOneRPct, 0, 1);
  const avgCostR = Math.max(0, num(row.avgCostR, 0));

  const winrateComponent = winrateMeta.score * 100;
  const reliabilityComponent = winrateMeta.reliability * 20;
  const totalRComponent = Math.log1p(totalR) * 12;
  const avgRComponent = Math.log1p(avgR) * 8;
  const pfComponent = Math.log1p(profitFactor) * 3;

  const riskPenalty =
    directSLPct * 60 +
    nearTpThenLossPct * 45 +
    gaveBackAfterOneRPct * 20 +
    avgCostR * 3;

  return (
    winrateComponent +
    reliabilityComponent +
    totalRComponent +
    avgRComponent +
    pfComponent -
    riskPenalty
  );
}

function dashboardBalancedScore(row = {}, meta = null) {
  const winrateMeta = meta || sampleWinrateMeta(row);

  if (winrateMeta.outcomeSample <= 0 && winrateMeta.observationSample > 0) {
    return observationActivityScore(row, winrateMeta);
  }

  return performanceBalancedScore(row, winrateMeta);
}

function learningStatus(row = {}, meta = null) {
  const winrateMeta = meta || sampleWinrateMeta(row);

  if (winrateMeta.outcomeSample > 0) return 'OUTCOMES_READY';
  if (winrateMeta.observationSample > 0) return 'OBSERVING';

  return 'NO_DATA';
}

function rowEligibilityTier(row = {}) {
  const outcome = num(row.outcomeSample ?? completedSample(row), 0);
  const obs = num(row.observationSample ?? observationSample(row), 0);

  if (outcome >= rotationMinCompleted()) return 'HARD';

  if (
    outcome > 0 &&
    (
      num(row.dashboardBalancedScore ?? row.balancedScore, 0) > 0 ||
      num(row.avgR, 0) > 0 ||
      num(row.totalR, 0) > 0 ||
      num(row.fairWinrate ?? row.sampleAdjustedWinrate, 0) > 0 ||
      num(row.wilsonLowerBound ?? row.sampleWilsonLowerBound, 0) > 0
    )
  ) {
    return 'SOFT';
  }

  if (obs > 0) return 'OBSERVATION';

  return 'NONE';
}

function normalizeRotationRow(row = {}, index = 0) {
  const microFamilyId = getMicroFamilyId(row);

  if (!microFamilyId) return null;

  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId
  });

  const inferredTradeSide = inferTradeSide({
    ...row,
    microFamilyId,
    macroFamilyId
  });

  if (inferredTradeSide === 'LONG') return null;

  const meta = sampleWinrateMeta(row);
  const score = dashboardBalancedScore(row, meta);
  const tier = row.selectedTier || row.rotationEligibilityTier || rowEligibilityTier({
    ...row,
    outcomeSample: meta.outcomeSample,
    observationSample: meta.observationSample,
    dashboardBalancedScore: score
  });

  const normalized = {
    rank: num(row.rank, index + 1),

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId: getFamilyId(row),
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    inferredTradeSide,
    inferredFromShortOnlyMode: inferredTradeSide === 'UNKNOWN',

    shortOnly: true,
    longDisabled: true,

    schema: row.schema || row.microFamilySchema || null,
    microFamilySchema: row.microFamilySchema || row.schema || null,
    version: row.version || null,

    isTrueMicro: row.isTrueMicro === true || row.trueMicro === true,
    isLegacyMacro: Boolean(row.isLegacyMacro),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    outcomeSample: round(meta.outcomeSample, 4),
    observationSample: round(meta.observationSample, 4),
    awaitingOutcomes: Boolean(meta.awaitingOutcomes),
    learningStatus: learningStatus(row, meta),

    wins: round(row.wins, 4),
    losses: round(row.losses, 4),
    flats: round(row.flats, 4),

    realWins: num(row.realWins, 0),
    realLosses: num(row.realLosses, 0),
    realFlats: num(row.realFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    winrateSample: round(row.winrateSample ?? meta.sample, 4),
    winrate: round(row.winrate ?? meta.rawWinrate, 4),
    bayesianWinrate: round(row.bayesianWinrate ?? meta.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound ?? meta.wilsonLowerBound, 4),
    fairWinrate: round(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      meta.score ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? meta.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? meta.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? meta.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? meta.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? meta.reliability, 4),

    avgR: round(row.avgR, 4),
    totalR: round(row.totalR, 4),
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
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? score, 4),

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

    definitionParts: getDefinitionParts(row),
    definition: row.definition || '',

    macroDefinitionParts: getMacroDefinitionParts(row),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    selectedTier: tier,
    rotationEligibilityTier: tier,

    manualOnly: Boolean(row.manualOnly),

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    sourceWeekKey: row.sourceWeekKey || null,
    sourceWeekPrimary: Boolean(row.sourceWeekPrimary),
    sourceWeekFallback: Boolean(row.sourceWeekFallback)
  };

  normalized.isLegacyMacro = isLegacyMacroFamilyRow(normalized);
  normalized.isTrueMicro = isTrueMicroFamilyRow(normalized);

  return normalized;
}

function buildSelectionIndexes(microFamilies = []) {
  const rows = (Array.isArray(microFamilies) ? microFamilies : [])
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow);

  const microFamilyIds = normalizeFamilyIds(
    rows.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = normalizeFamilyIds(
    rows.map((row) => row.macroFamilyId)
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of rows) {
    const microId = String(row.microFamilyId || '').trim();
    const macroId = String(row.macroFamilyId || '').trim();

    if (!microId || !macroId) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = normalizeFamilyIds(
      macroToMicroFamilyIds[macroId]
    );
  }

  return {
    microFamilyIds,
    macroFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,
    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function microIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  return normalizeFamilyIds(
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids,
    rows.map((row) => getMicroFamilyId(row))
  )
    .filter(isShortId);
}

function macroIdsFromRotation(rotation = {}, microFamilyIds = []) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies.filter(isShortRow)
    : [];

  const macroIds = normalizeFamilyIds(
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rows.map((row) => getMacroFamilyId(row))
  )
    .filter(isShortId);

  if (macroIds.length > 0) return macroIds;

  return normalizeFamilyIds(microFamilyIds)
    .filter(isShortId);
}

function missingSides(rows = []) {
  const hasShort = rows.some((row) => row?.tradeSide === TARGET_TRADE_SIDE);

  return hasShort ? [] : [TARGET_TRADE_SIDE];
}

function buildManualRow(id, index = 0) {
  if (!isShortId(id)) return null;

  return normalizeRotationRow({
    rank: index + 1,

    microFamilyId: id,
    trueMicroFamilyId: id,
    familyId: null,
    macroFamilyId: null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    schema: getMicroSchema(),
    microFamilySchema: getMicroSchema(),
    version: 'manual_true_micro',

    isTrueMicro: true,
    isLegacyMacro: false,

    seen: 0,
    observations: 0,
    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    winrateSample: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedOneRPct: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    selectedTier: 'MANUAL',
    rotationEligibilityTier: 'MANUAL',

    definitionParts: [],
    definition: '',

    manualOnly: true,
    shortOnly: true,
    longDisabled: true
  }, index);
}

function normalizeRotation(rotation = {}, fallback = {}, options = {}) {
  const base = {
    ...fallback,
    ...(rotation || {})
  };

  const rowLimit = toLimit(
    options.rowLimit,
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ROWS_LIMIT
  );

  const rawRows = Array.isArray(base.microFamilies)
    ? base.microFamilies
    : [];

  const explicitMicroFamilyIds = microIdsFromRotation({
    ...base,
    microFamilies: rawRows
  });

  const rowsFromIds = rawRows.length === 0
    ? explicitMicroFamilyIds
      .map((id, index) => buildManualRow(id, index))
      .filter(Boolean)
    : [];

  const normalizedRawRows = [
    ...rawRows.map((row, index) => normalizeRotationRow(row, index)),
    ...rowsFromIds
  ]
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow);

  const microFamilies = normalizedRawRows.slice(0, rowLimit);

  const explicitMacroFamilyIds = normalizeFamilyIds(
    macroIdsFromRotation({
      ...base,
      microFamilies: rawRows
    }, explicitMicroFamilyIds),
    rawRows.map((row) => getMacroFamilyId(row))
  )
    .filter(isShortId);

  const indexes = buildSelectionIndexes(normalizedRawRows);

  const microFamilyIds = indexes.microFamilyIds.length
    ? indexes.microFamilyIds
    : explicitMicroFamilyIds;

  const macroFamilyIds = indexes.macroFamilyIds.length
    ? indexes.macroFamilyIds
    : explicitMacroFamilyIds;

  const bestShort =
    normalizedRawRows.find((row) => row.tradeSide === TARGET_TRADE_SIDE) ||
    (base.bestShort ? normalizeRotationRow(base.bestShort, 0) : null);

  const empty = base.empty ?? microFamilyIds.length === 0;

  return {
    rotationId: base.rotationId || null,
    source: base.source || null,
    mode: base.mode || null,
    sideMode: 'short_only',

    sourceWeekKey: base.sourceWeekKey || null,
    activeWeekKey: base.activeWeekKey || null,

    generatedAt: base.generatedAt || null,
    activatedAt: base.activatedAt || null,
    strategyVersion: base.strategyVersion || CONFIG.strategyVersion || null,

    schema: base.schema || null,
    macroSchema: base.macroSchema || getMacroSchema(),
    microSchema: base.microSchema || getMicroSchema(),

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(base.usedSoftFallback),
    usedObservationFallback: Boolean(base.usedObservationFallback),
    usedRawFallback: Boolean(base.usedRawFallback),
    usedPreviousWeekMerge: Boolean(base.usedPreviousWeekMerge),

    selectedTier: base.selectedTier || bestShort?.selectedTier || null,
    requestedTradeSide: TARGET_TRADE_SIDE,
    preservedTradeSide: null,
    replacedSide: TARGET_TRADE_SIDE,
    preservedSide: null,

    minWeightedCompleted: base.minWeightedCompleted ?? null,
    topNPerSide: base.topNPerSide ?? null,
    maxPerMacroFamily: base.maxPerMacroFamily ?? null,

    eligibleCount: base.eligibleCount ?? null,
    softEligibleCount: base.softEligibleCount ?? null,
    observationEligibleCount: base.observationEligibleCount ?? null,
    rawEligibleCount: base.rawEligibleCount ?? null,
    rankedCount: base.rankedCount ?? null,
    allRankedCount: base.allRankedCount ?? null,
    microCount: microFamilyIds.length || base.microCount || normalizedRawRows.length || 0,
    macroCount: macroFamilyIds.length || base.macroCount || 0,
    trueMicroCount: microFamilyIds.length,
    legacyMacroCount: 0,

    empty,
    emptyReason: empty
      ? base.emptyReason || 'NO_ACTIVE_SHORT_TRUE_MICRO_FAMILIES'
      : base.emptyReason || null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId: Object.keys(indexes.microToMacroFamilyId).length
      ? indexes.microToMacroFamilyId
      : base.microToMacroFamilyId || {},

    macroToMicroFamilyIds: Object.keys(indexes.macroToMicroFamilyIds).length
      ? indexes.macroToMicroFamilyIds
      : base.macroToMicroFamilyIds || {},

    microFamilies,

    rowsTruncated: normalizedRawRows.length > microFamilies.length,
    rowsReturned: microFamilies.length,
    rowsTotal: normalizedRawRows.length,

    selectedMicroFamilyId: base.selectedMicroFamilyId || bestShort?.microFamilyId || null,
    selectedMacroFamilyId: base.selectedMacroFamilyId || bestShort?.macroFamilyId || null,

    selectedRow: base.selectedRow
      ? normalizeRotationRow(base.selectedRow, 0)
      : bestShort,

    preservedOppositeRow: null,

    previousActiveMicroFamilyIds: normalizeFamilyIds(base.previousActiveMicroFamilyIds || [])
      .filter(isShortId),

    previousActiveMacroFamilyIds: normalizeFamilyIds(base.previousActiveMacroFamilyIds || [])
      .filter(isShortId),

    requestedMicroFamilyIds: normalizeFamilyIds(base.requestedMicroFamilyIds || [])
      .filter(isShortId),

    requestedMacroFamilyIds: normalizeFamilyIds(base.requestedMacroFamilyIds || [])
      .filter(isShortId),

    ignoredRequestedIds: Array.isArray(base.ignoredRequestedIds)
      ? base.ignoredRequestedIds
      : [],

    expandedFromMacro: base.expandedFromMacro || {},

    bestLong: null,
    bestShort,
    missingSides: missingSides(normalizedRawRows),

    count: microFamilyIds.length || microFamilies.length,
    activeCount: microFamilyIds.length || microFamilies.length
  };
}

function normalizeDashboardFromStored({
  activeRaw,
  nextRaw,
  validFrom,
  activeRowsLimit = DEFAULT_ACTIVE_ROWS_LIMIT,
  nextRowsLimit = DEFAULT_NEXT_ROWS_LIMIT
} = {}) {
  const active = normalizeRotation(activeRaw || {}, {}, {
    rowLimit: activeRowsLimit
  });

  const next = normalizeRotation(nextRaw || {}, {}, {
    rowLimit: nextRowsLimit
  });

  const activeRows = Array.isArray(active.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next.microFamilies)
    ? next.microFamilies
    : [];

  return {
    active,
    next,
    validFrom,

    activeRotation: active,
    nextRotation: next,

    activeRows,
    nextRows,

    activeCount: active.microFamilyIds.length || activeRows.length,
    nextCount: next.microFamilyIds.length || nextRows.length,

    activeMacroCount: active.macroFamilyIds.length,
    nextMacroCount: next.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    nextMicroFamilyIds: next.microFamilyIds,
    nextMacroFamilyIds: next.macroFamilyIds,

    activeMicroToMacroFamilyId: active.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next.microToMacroFamilyId || {},

    activeMacroToMicroFamilyIds: active.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next.macroToMicroFamilyIds || {},

    bestLong: null,
    bestShort: active.bestShort,

    nextBestLong: null,
    nextBestShort: next.bestShort,

    missingSides: active.missingSides || [],
    nextMissingSides: next.missingSides || [],

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true
  };
}

async function getStoredRotationDashboard(options = {}) {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getRedisJson(redis, KEYS.analyze?.activeRotation, null),
    getRedisJson(redis, KEYS.analyze?.nextRotation, null),
    getRedisJson(redis, KEYS.analyze?.rotationValidFrom, null)
  ]);

  return normalizeDashboardFromStored({
    activeRaw,
    nextRaw,
    validFrom,
    ...options
  });
}

async function getStoredActiveRotation() {
  const redis = getDurableRedis();
  const activeRaw = await getRedisJson(redis, KEYS.analyze?.activeRotation, null);

  return normalizeRotation(activeRaw || {}, {}, {
    rowLimit: DEFAULT_ACTIVE_ROWS_LIMIT
  });
}

async function handleGet(req, res) {
  const requestStartedAt = now();

  const activeRowsLimit = toLimit(
    firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT),
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ROWS_LIMIT
  );

  const nextRowsLimit = toLimit(
    firstValue(req.query?.nextRowsLimit, DEFAULT_NEXT_ROWS_LIMIT),
    DEFAULT_NEXT_ROWS_LIMIT,
    MAX_ROWS_LIMIT
  );

  const dashboard = await getStoredRotationDashboard({
    activeRowsLimit,
    nextRowsLimit
  });

  return res.status(200).json({
    ok: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    currentWeekKey: getIsoWeekKey(),
    previousWeekKey: getPreviousIsoWeekKey(),

    activeRowsLimit,
    nextRowsLimit,

    ...dashboard,

    perf: {
      durationMs: elapsed(requestStartedAt),
      source: 'stored_redis_only_short_true_micro_filtered',
      avoidsAnalyzeEngineDashboard: true
    },

    serverTs: Date.now()
  });
}

function selectedIdsFromBody(body = {}) {
  const allIds = normalizeFamilyIds(
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids
  );

  const explicitMacroIds = normalizeFamilyIds(
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds
  )
    .filter(isShortId);

  const explicitMicroIds = normalizeFamilyIds(
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids
  )
    .filter(isShortId);

  const ignoredLongIds = allIds
    .filter((id) => inferTradeSide(id) === 'LONG');

  return {
    microFamilyIds: explicitMicroIds,
    macroFamilyIds: explicitMacroIds,
    ignoredLongIds
  };
}

function rowMatchesSelection(row, microSet, macroSet) {
  if (!isShortRow(row)) return false;
  if (!isTrueMicroFamilyRow(row)) return false;

  const microFamilyId = row.microFamilyId || row.id || row.key || null;

  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId
  });

  return (
    (microFamilyId && microSet.has(microFamilyId)) ||
    (macroFamilyId && macroSet.has(macroFamilyId)) ||
    (microFamilyId && macroSet.has(microFamilyId))
  );
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    if (!row || !isShortRow(row)) continue;

    const normalized = normalizeRotationRow(row, output.length);

    if (!normalized || !isTrueMicroFamilyRow(normalized)) continue;

    const key = normalized.microFamilyId;

    if (!key || seen.has(key)) continue;

    seen.add(key);
    output.push(normalized);
  }

  return output.map((row, index) => normalizeRotationRow({
    ...row,
    rank: index + 1
  }, index)).filter(Boolean);
}

function scoreByMode(row = {}, mode = 'balanced') {
  if (mode === 'winrate') {
    return num(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound ??
      row.winrate,
      0
    );
  }

  if (mode === 'totalR') return num(row.totalR, 0);
  if (mode === 'avgR') return num(row.avgRScore ?? row.avgR, 0);
  if (mode === 'directSL') return -num(row.directSLPct, 1);

  if (mode === 'observed') {
    return Math.max(
      num(row.observationSample, 0),
      num(row.seen, 0),
      num(row.observations, 0),
      num(row.outcomeSample, 0),
      num(row.completed, 0),
      num(row.winrateSample, 0)
    );
  }

  return num(row.dashboardBalancedScore ?? row.balancedScore, 0);
}

function compareRowsByMode(a = {}, b = {}, mode = 'balanced') {
  const scoreDiff = scoreByMode(b, mode) - scoreByMode(a, mode);

  if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;

  const tierWeight = {
    HARD: 4,
    SOFT: 3,
    OBSERVATION: 2,
    RAW_SIDE: 1,
    NONE: 0
  };

  const tierDiff =
    num(tierWeight[b.selectedTier || b.rotationEligibilityTier], 0) -
    num(tierWeight[a.selectedTier || a.rotationEligibilityTier], 0);

  if (tierDiff !== 0) return tierDiff;

  const outcomeDiff = num(b.outcomeSample, 0) - num(a.outcomeSample, 0);
  if (Math.abs(outcomeDiff) > 1e-12) return outcomeDiff;

  const obsDiff = num(b.observationSample, 0) - num(a.observationSample, 0);
  if (Math.abs(obsDiff) > 1e-12) return obsDiff;

  const totalRDiff = num(b.totalR, 0) - num(a.totalR, 0);
  if (Math.abs(totalRDiff) > 1e-12) return totalRDiff;

  const avgRDiff = num(b.avgR, 0) - num(a.avgR, 0);
  if (Math.abs(avgRDiff) > 1e-12) return avgRDiff;

  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function sortRowsByMode(rows = [], mode = 'balanced') {
  return [...rows]
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow)
    .sort((a, b) => compareRowsByMode(a, b, mode));
}

function rotationMinCompleted() {
  return num(CONFIG.rotation?.minWeightedCompleted, 5);
}

function explicitTopNFromBody(body = {}) {
  const raw = firstValue(
    body.topN,
    firstValue(
      body.limit,
      firstValue(body.activeRowsLimit, null)
    )
  );

  if (raw === null || raw === undefined || raw === '') return null;

  return toLimit(raw, DEFAULT_BEST_SINGLE_TOP_N, MAX_ROTATION_TOP_N);
}

function rotationTopN(body = {}, fallback = DEFAULT_ROTATION_TOP_N) {
  const explicit = explicitTopNFromBody(body);

  if (explicit !== null) return explicit;

  return toLimit(
    CONFIG.rotation?.topNPerSide ?? fallback,
    fallback,
    MAX_ROTATION_TOP_N
  );
}

function rotationMaxPerMacroFamily(body = {}) {
  const raw = firstValue(
    body.maxPerMacroFamily,
    CONFIG.rotation?.maxPerMacroFamily ?? 0
  );

  const n = Math.floor(Number(raw));

  if (!Number.isFinite(n) || n < 1) return 0;

  return Math.min(n, MAX_ROTATION_TOP_N);
}

function minPrimaryRowsForPreviousMerge(body = {}) {
  return toLimit(
    firstValue(
      body.minPrimaryRowsForMerge,
      CONFIG.rotation?.minPrimaryRowsForPreviousMerge ??
        DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE
    ),
    DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
    MAX_ROTATION_TOP_N
  );
}

function recentWeekLookback(body = {}) {
  return toLimit(
    firstValue(
      body.recentWeekLookback,
      CONFIG.rotation?.recentWeekLookback ?? DEFAULT_RECENT_WEEK_LOOKBACK
    ),
    DEFAULT_RECENT_WEEK_LOOKBACK,
    MAX_RECENT_WEEK_LOOKBACK
  );
}

function rowsByEligibility(sideRows = []) {
  const hardRows = [];
  const softRows = [];
  const observationRows = [];
  const rawRows = [];

  for (const row of sideRows.filter(isShortRow).filter(isTrueMicroFamilyRow)) {
    const tier = rowEligibilityTier(row);

    if (tier === 'HARD') {
      hardRows.push({
        ...row,
        selectedTier: 'HARD',
        rotationEligibilityTier: 'HARD'
      });
      continue;
    }

    if (tier === 'SOFT') {
      softRows.push({
        ...row,
        selectedTier: 'SOFT',
        rotationEligibilityTier: 'SOFT'
      });
      continue;
    }

    if (tier === 'OBSERVATION') {
      observationRows.push({
        ...row,
        selectedTier: 'OBSERVATION',
        rotationEligibilityTier: 'OBSERVATION'
      });
      continue;
    }

    rawRows.push({
      ...row,
      selectedTier: 'RAW_SIDE',
      rotationEligibilityTier: 'RAW_SIDE'
    });
  }

  return {
    hardRows,
    softRows,
    observationRows,
    rawRows
  };
}

function selectTopRotationRows(rows = [], {
  mode = 'balanced',
  topN = DEFAULT_ROTATION_TOP_N,
  maxPerMacroFamily = 0
} = {}) {
  const sorted = sortRowsByMode(rows, mode);
  const output = [];
  const byMacro = {};

  for (const row of sorted) {
    if (output.length >= topN) break;

    const macroId = String(row.macroFamilyId || row.parentMacroFamilyId || 'NO_MACRO').trim();

    if (maxPerMacroFamily > 0) {
      byMacro[macroId] = byMacro[macroId] || 0;

      if (byMacro[macroId] >= maxPerMacroFamily) continue;

      byMacro[macroId] += 1;
    }

    output.push(row);
  }

  return output
    .map((row, index) => normalizeRotationRow({
      ...row,
      rank: index + 1
    }, index))
    .filter(Boolean)
    .filter(isTrueMicroFamilyRow);
}

function pruneWeekRowsCache() {
  const entries = [...weekRowsCache.entries()];

  if (entries.length <= WEEK_ROWS_CACHE_MAX_KEYS) return;

  entries
    .sort((a, b) => num(a[1]?.ts, 0) - num(b[1]?.ts, 0))
    .slice(0, Math.max(0, entries.length - WEEK_ROWS_CACHE_MAX_KEYS))
    .forEach(([key]) => weekRowsCache.delete(key));
}

function microsSignature(micros = {}) {
  const keys = Object.keys(micros || {}).sort();
  const count = keys.length;

  if (count <= 0) return '0';

  const first = keys[0] || '';
  const middle = keys[Math.floor(count / 2)] || '';
  const last = keys[count - 1] || '';

  return `${count}:${first}:${middle}:${last}`;
}

function parseIsoWeekKey(weekKey = '') {
  const match = String(weekKey || '').match(/^(\d{4})-W(\d{1,2})$/i);

  if (!match) return null;

  return {
    year: Number(match[1]),
    week: Number(match[2])
  };
}

function weeksInIsoYear(year) {
  const date = new Date(Date.UTC(year, 11, 28));
  const day = date.getUTCDay() || 7;

  date.setUTCDate(date.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function previousIsoWeekKeyFrom(weekKey = '') {
  const parsed = parseIsoWeekKey(weekKey);

  if (!parsed) return getPreviousIsoWeekKey();

  let { year, week } = parsed;

  week -= 1;

  if (week >= 1) {
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  year -= 1;
  week = weeksInIsoYear(year);

  return `${year}-W${String(week).padStart(2, '0')}`;
}

function recentIsoWeekKeys(startWeekKey, count = DEFAULT_RECENT_WEEK_LOOKBACK) {
  const keys = [];
  let cursor = String(startWeekKey || getIsoWeekKey()).trim();

  for (let index = 0; index < count; index += 1) {
    if (!cursor || keys.includes(cursor)) break;

    keys.push(cursor);
    cursor = previousIsoWeekKeyFrom(cursor);
  }

  return keys;
}

async function getSingleWeekRows(weekKey, startedAt = now()) {
  const micros = await getWeekMicros(weekKey);
  const signature = microsSignature(micros);
  const cacheKey = `SHORT_TRUE_MICRO|${weekKey}|${signature}`;
  const cached = weekRowsCache.get(cacheKey);

  if (cached && now() - cached.ts < WEEK_ROWS_CACHE_TTL_MS) {
    return {
      weekKey,
      rows: cached.rows,
      micros,
      cacheHit: true,
      cacheKey,
      warning: null
    };
  }

  const entries = Object.entries(micros || {});
  const rows = [];

  for (let index = 0; index < entries.length; index += 1) {
    if (routeBudgetExceeded(startedAt)) break;

    const [key, row] = entries[index];

    const normalized = normalizeRotationRow({
      ...row,
      key,
      microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || key,
      sourceWeekKey: weekKey
    }, index);

    if (normalized?.microFamilyId && isTrueMicroFamilyRow(normalized)) {
      rows.push(normalized);
    }
  }

  weekRowsCache.set(cacheKey, {
    ts: now(),
    rows
  });

  pruneWeekRowsCache();

  return {
    weekKey,
    rows,
    micros,
    cacheHit: false,
    cacheKey,
    warning: null
  };
}

function mergeWeekRowsByRecency(weekResults = []) {
  const byKey = new Map();

  for (const result of [...weekResults].reverse()) {
    const weekKey = result?.weekKey || null;
    const isPrimary = weekKey === weekResults[0]?.weekKey;

    for (const row of result?.rows || []) {
      const key = row.microFamilyId;
      if (!key) continue;

      byKey.set(key, normalizeRotationRow({
        ...row,
        sourceWeekKey: weekKey,
        sourceWeekPrimary: Boolean(isPrimary),
        sourceWeekFallback: !isPrimary
      }, byKey.size));
    }
  }

  return [...byKey.values()]
    .filter(Boolean)
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow);
}

async function getWeekRows(weekKey, startedAt = now(), options = {}) {
  const minRowsForMerge = toLimit(
    options.minPrimaryRowsForMerge,
    DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
    MAX_ROTATION_TOP_N
  );

  const lookback = toLimit(
    options.recentWeekLookback,
    DEFAULT_RECENT_WEEK_LOOKBACK,
    MAX_RECENT_WEEK_LOOKBACK
  );

  const weekKeys = recentIsoWeekKeys(weekKey, lookback);
  const results = [];

  for (const key of weekKeys) {
    if (routeBudgetExceeded(startedAt)) break;

    const result = await getSingleWeekRows(key, startedAt).catch((error) => ({
      weekKey: key,
      rows: [],
      micros: {},
      cacheHit: false,
      cacheKey: null,
      warning: error?.message || String(error)
    }));

    results.push(result);

    const mergedRows = mergeWeekRowsByRecency(results);

    if (mergedRows.length >= minRowsForMerge) {
      return {
        weekKey,
        rows: mergedRows,
        micros: Object.assign({}, ...results.map((row) => row.micros || {})),
        cacheHit: results.every((row) => row.cacheHit),
        cacheKey: results.map((row) => row.cacheKey).filter(Boolean).join('|MERGED|'),
        source: results.length <= 1 ? 'requestedWeek' : 'recentWeeksMerged',
        primaryWeekKey: weekKey,
        previousWeekKey: weekKeys[1] || getPreviousIsoWeekKey(),
        primaryRows: results[0]?.rows?.length || 0,
        previousRows: results[1]?.rows?.length || 0,
        mergedPreviousWeek: results.length > 1,
        recentWeekLookback: lookback,
        recentWeekKeysScanned: results.map((row) => row.weekKey),
        recentWeekRows: results.map((row) => ({
          weekKey: row.weekKey,
          rows: row.rows.length,
          cacheHit: Boolean(row.cacheHit),
          warning: row.warning || null
        })),
        warnings: uniqueStrings(results.map((row) => row.warning).filter(Boolean))
      };
    }
  }

  const rows = mergeWeekRowsByRecency(results);

  return {
    weekKey,
    rows,
    micros: Object.assign({}, ...results.map((row) => row.micros || {})),
    cacheHit: results.length > 0 && results.every((row) => row.cacheHit),
    cacheKey: results.map((row) => row.cacheKey).filter(Boolean).join('|MERGED|'),
    source: results.length <= 1 ? 'requestedWeek' : 'recentWeeksMergedInsufficientRows',
    primaryWeekKey: weekKey,
    previousWeekKey: weekKeys[1] || getPreviousIsoWeekKey(),
    primaryRows: results[0]?.rows?.length || 0,
    previousRows: results[1]?.rows?.length || 0,
    mergedPreviousWeek: results.length > 1,
    recentWeekLookback: lookback,
    recentWeekKeysScanned: results.map((row) => row.weekKey),
    recentWeekRows: results.map((row) => ({
      weekKey: row.weekKey,
      rows: row.rows.length,
      cacheHit: Boolean(row.cacheHit),
      warning: row.warning || null
    })),
    warnings: uniqueStrings(results.map((row) => row.warning).filter(Boolean))
  };
}

async function findBestWeekShortRows({
  weekKey,
  mode,
  topN = DEFAULT_BEST_SINGLE_TOP_N,
  maxPerMacroFamily = 0,
  minPrimaryRowsForMerge = DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
  recentWeekLookback = DEFAULT_RECENT_WEEK_LOOKBACK,
  startedAt = now()
} = {}) {
  const weekResult = await getWeekRows(weekKey, startedAt, {
    minPrimaryRowsForMerge,
    recentWeekLookback
  });

  const rows = weekResult.rows || [];
  const sideRows = rows
    .filter(isShortRow)
    .filter(isTrueMicroFamilyRow);

  const {
    hardRows,
    softRows,
    observationRows,
    rawRows
  } = rowsByEligibility(sideRows);

  let candidateRows = hardRows;
  let selectedTier = 'HARD';

  if (candidateRows.length === 0) {
    candidateRows = softRows;
    selectedTier = 'SOFT';
  }

  if (candidateRows.length === 0) {
    candidateRows = observationRows;
    selectedTier = 'OBSERVATION';
  }

  if (candidateRows.length === 0) {
    candidateRows = rawRows.length ? rawRows : sideRows;
    selectedTier = 'RAW_SIDE';
  }

  const selectedRows = selectTopRotationRows(candidateRows, {
    mode,
    topN,
    maxPerMacroFamily
  });

  const best = selectedRows[0] || null;

  return {
    best: best
      ? normalizeRotationRow({
        ...best,
        rotationEligibilityTier: rowEligibilityTier(best),
        selectedTier
      }, 0)
      : null,

    selectedRows: selectedRows.map((row, index) => normalizeRotationRow({
      ...row,
      rotationEligibilityTier: rowEligibilityTier(row),
      selectedTier,
      rank: index + 1
    }, index)).filter(Boolean),

    rows,
    sideRows,
    candidateRows,

    sideCount: sideRows.length,
    candidateCount: candidateRows.length,

    hardCount: hardRows.length,
    softCount: softRows.length,
    observationCount: observationRows.length,
    rawCount: rawRows.length,

    tradableCount: hardRows.length + softRows.length + observationRows.length,
    selectedTier,

    topN,
    maxPerMacroFamily,

    weekRowsCacheHit: weekResult.cacheHit,
    weekRowsCacheKey: weekResult.cacheKey,
    scannedRows: rows.length,

    source: weekResult.source,
    primaryWeekKey: weekResult.primaryWeekKey,
    previousWeekKey: weekResult.previousWeekKey,
    primaryRows: weekResult.primaryRows,
    previousRows: weekResult.previousRows,
    mergedPreviousWeek: weekResult.mergedPreviousWeek,
    recentWeekLookback: weekResult.recentWeekLookback,
    recentWeekKeysScanned: weekResult.recentWeekKeysScanned,
    recentWeekRows: weekResult.recentWeekRows,
    warnings: weekResult.warnings || []
  };
}

async function buildSelectedRotationRows({
  weekKey,
  microFamilyIds = [],
  macroFamilyIds = [],
  minPrimaryRowsForMerge = DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
  recentWeekLookback = DEFAULT_RECENT_WEEK_LOOKBACK,
  startedAt = now()
} = {}) {
  const weekResult = await getWeekRows(weekKey, startedAt, {
    minPrimaryRowsForMerge,
    recentWeekLookback
  });

  const rows = weekResult.rows || [];
  const micros = weekResult.micros || {};

  const microSet = new Set(microFamilyIds.filter(isShortId));
  const macroSet = new Set(macroFamilyIds.filter(isShortId));

  const matchedRows = [];

  for (const row of rows) {
    if (routeBudgetExceeded(startedAt)) break;
    if (rowMatchesSelection(row, microSet, macroSet)) matchedRows.push(row);
  }

  const matchedMicroIds = new Set(matchedRows.map((row) => row.microFamilyId).filter(Boolean));
  const matchedMacroIds = new Set(matchedRows.map((row) => row.macroFamilyId).filter(Boolean));

  const missingMicroRows = microFamilyIds
    .filter(isShortId)
    .filter((id) => !matchedMicroIds.has(id) && !matchedMacroIds.has(id))
    .map((id, index) => buildManualRow(id, matchedRows.length + index))
    .filter(Boolean)
    .filter(isTrueMicroFamilyRow);

  return {
    rows: dedupeRows([
      ...matchedRows,
      ...missingMicroRows
    ]),
    weekRowsCacheHit: weekResult.cacheHit,
    weekRowsCacheKey: weekResult.cacheKey,
    scannedRows: rows.length,
    microsCount: Object.keys(micros || {}).length,
    source: weekResult.source,
    primaryWeekKey: weekResult.primaryWeekKey,
    previousWeekKey: weekResult.previousWeekKey,
    primaryRows: weekResult.primaryRows,
    previousRows: weekResult.previousRows,
    mergedPreviousWeek: weekResult.mergedPreviousWeek,
    recentWeekLookback: weekResult.recentWeekLookback,
    recentWeekKeysScanned: weekResult.recentWeekKeysScanned,
    recentWeekRows: weekResult.recentWeekRows,
    warnings: weekResult.warnings || []
  };
}

async function persistActiveRotation(active) {
  const normalizedActive = normalizeRotation(active, {}, {
    rowLimit: MAX_ROWS_LIMIT
  });

  await setJson(
    getDurableRedis(),
    KEYS.analyze.activeRotation,
    normalizedActive
  );

  return normalizedActive;
}

async function activateBestBalanced(body, startedAt = now()) {
  const sourceWeekKey = firstValue(body.weekKey, getIsoWeekKey());
  const activeWeekKey = firstValue(body.activeWeekKey, getIsoWeekKey());
  const mode = normalizeMode(firstValue(body.mode, 'balanced'), 'balanced');

  const topN = rotationTopN(body, DEFAULT_ROTATION_TOP_N);
  const maxPerMacroFamily = rotationMaxPerMacroFamily(body);
  const minMergeRows = minPrimaryRowsForPreviousMerge(body);
  const lookback = recentWeekLookback(body);

  const sideResult = await findBestWeekShortRows({
    weekKey: sourceWeekKey,
    mode,
    topN,
    maxPerMacroFamily,
    minPrimaryRowsForMerge: minMergeRows,
    recentWeekLookback: lookback,
    startedAt
  });

  const selectedRow = sideResult.best;
  const microFamilies = dedupeRows(sideResult.selectedRows || []);

  if (!selectedRow || microFamilies.length === 0) {
    const previousActive = await getStoredActiveRotation();

    return {
      action: 'activateBestBalanced',

      sourceWeekKey,
      activeWeekKey,
      mode,
      topN,
      maxPerMacroFamily,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      trueMicroOnly: true,

      skipped: true,
      changed: false,
      empty: previousActive.microFamilyIds.length === 0,
      emptyReason: 'NO_SHORT_TRUE_MICRO_FAMILY_FOUND',

      activeRotation: previousActive,
      active: previousActive,

      activatedCount: previousActive.microFamilyIds.length,
      activatedMicroCount: previousActive.microFamilyIds.length,
      activatedMacroCount: previousActive.macroFamilyIds.length,

      activeMicroFamilyIds: previousActive.microFamilyIds,
      activeMacroFamilyIds: previousActive.macroFamilyIds,

      bestLong: null,
      bestShort: previousActive.bestShort,
      missingSides: previousActive.missingSides || [],

      sideCount: sideResult.sideCount,
      candidateCount: sideResult.candidateCount,
      hardCount: sideResult.hardCount,
      softCount: sideResult.softCount,
      observationCount: sideResult.observationCount,
      rawCount: sideResult.rawCount,
      selectedTier: null,

      warnings: sideResult.warnings || [],

      perf: {
        durationMs: elapsed(startedAt),
        source: 'short_only_findBestWeekShortRows',
        weekRowsCacheHit: sideResult.weekRowsCacheHit,
        weekRowsCacheKey: sideResult.weekRowsCacheKey,
        scannedRows: sideResult.scannedRows,
        primaryRows: sideResult.primaryRows,
        previousRows: sideResult.previousRows,
        mergedPreviousWeek: sideResult.mergedPreviousWeek,
        recentWeekLookback: sideResult.recentWeekLookback,
        recentWeekKeysScanned: sideResult.recentWeekKeysScanned,
        recentWeekRows: sideResult.recentWeekRows
      }
    };
  }

  const indexes = buildSelectionIndexes(microFamilies);

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_short_balanced`),

    source: 'ADMIN_ACTIVATE_TOP_BALANCED_SHORT_TRUE_MICROS',

    mode,
    sideMode: 'short_only',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    requestedTradeSide: TARGET_TRADE_SIDE,
    replacedSide: TARGET_TRADE_SIDE,

    empty: microFamilies.length === 0,
    emptyReason: microFamilies.length === 0
      ? 'NO_SHORT_TRUE_MICRO_ROWS_ACTIVE'
      : null,

    topNPerSide: topN,
    maxPerMacroFamily,

    eligibleCount: sideResult.tradableCount,
    softEligibleCount: sideResult.softCount,
    observationEligibleCount: sideResult.observationCount,
    rawEligibleCount: sideResult.rawCount,
    rankedCount: sideResult.candidateCount,
    allRankedCount: sideResult.sideCount,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,
    selectedTier: sideResult.selectedTier,

    selectedRow,

    usedSoftFallback: sideResult.selectedTier === 'SOFT',
    usedObservationFallback: sideResult.selectedTier === 'OBSERVATION',
    usedRawFallback: sideResult.selectedTier === 'RAW_SIDE',
    usedPreviousWeekMerge: Boolean(sideResult.mergedPreviousWeek)
  });

  return {
    action: 'activateBestBalanced',

    sourceWeekKey,
    activeWeekKey,
    mode,
    topN,
    maxPerMacroFamily,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    skipped: false,
    changed: true,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,
    selectedRow,

    bestLong: null,
    bestShort: active.bestShort,
    missingSides: active.missingSides || [],

    sideCount: sideResult.sideCount,
    candidateCount: sideResult.candidateCount,
    hardCount: sideResult.hardCount,
    softCount: sideResult.softCount,
    observationCount: sideResult.observationCount,
    rawCount: sideResult.rawCount,
    tradableCount: sideResult.tradableCount,
    selectedTier: sideResult.selectedTier,

    empty: Boolean(active.empty),
    emptyReason: active.emptyReason || null,
    usedSoftFallback: Boolean(active.usedSoftFallback),
    usedObservationFallback: Boolean(active.usedObservationFallback),
    usedRawFallback: Boolean(active.usedRawFallback),
    usedPreviousWeekMerge: Boolean(active.usedPreviousWeekMerge),

    warnings: sideResult.warnings || [],

    perf: {
      durationMs: elapsed(startedAt),
      source: 'short_only_findBestWeekShortRows',
      weekRowsCacheHit: sideResult.weekRowsCacheHit,
      weekRowsCacheKey: sideResult.weekRowsCacheKey,
      scannedRows: sideResult.scannedRows,
      primaryRows: sideResult.primaryRows,
      previousRows: sideResult.previousRows,
      mergedPreviousWeek: sideResult.mergedPreviousWeek,
      recentWeekLookback: sideResult.recentWeekLookback,
      recentWeekKeysScanned: sideResult.recentWeekKeysScanned,
      recentWeekRows: sideResult.recentWeekRows
    }
  };
}

async function activateBestSideMicro(body, forcedTradeSide = null, startedAt = now()) {
  const sourceWeekKey = firstValue(body.weekKey, getIsoWeekKey());
  const activeWeekKey = firstValue(body.activeWeekKey, getIsoWeekKey());
  const mode = normalizeMode(firstValue(body.mode, 'balanced'), 'balanced');

  const requestedTradeSide = forcedTradeSide || normalizeRequestedTradeSide(
    firstValue(
      body.tradeSide,
      firstValue(body.side, firstValue(body.direction, TARGET_TRADE_SIDE))
    )
  );

  assertShortOnlySide(requestedTradeSide);

  const previousActive = await getStoredActiveRotation();

  const topN = rotationTopN(body, DEFAULT_BEST_SINGLE_TOP_N);
  const maxPerMacroFamily = rotationMaxPerMacroFamily(body);
  const minMergeRows = minPrimaryRowsForPreviousMerge(body);
  const lookback = recentWeekLookback(body);

  const sideResult = await findBestWeekShortRows({
    weekKey: sourceWeekKey,
    mode,
    topN,
    maxPerMacroFamily,
    minPrimaryRowsForMerge: minMergeRows,
    recentWeekLookback: lookback,
    startedAt
  });

  const selectedRow = sideResult.best;
  const combinedRows = sortRowsByMode(
    dedupeRows(sideResult.selectedRows || []),
    mode
  ).map((row, index) => normalizeRotationRow({
    ...row,
    rank: index + 1
  }, index)).filter(Boolean);

  if (!selectedRow || combinedRows.length === 0) {
    return {
      action: 'activateBestSideMicro',

      sourceWeekKey,
      activeWeekKey,
      mode,
      topN,
      maxPerMacroFamily,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      trueMicroOnly: true,

      requestedTradeSide: TARGET_TRADE_SIDE,
      preservedTradeSide: null,

      skipped: true,
      changed: false,
      empty: previousActive.microFamilyIds.length === 0,
      emptyReason: 'NO_SHORT_TRUE_MICRO_FAMILY_FOUND',

      sideCount: sideResult.sideCount,
      candidateCount: sideResult.candidateCount,
      hardCount: sideResult.hardCount,
      softCount: sideResult.softCount,
      observationCount: sideResult.observationCount,
      rawCount: sideResult.rawCount,
      tradableCount: sideResult.tradableCount,
      selectedTier: null,

      activeRotation: previousActive,
      active: previousActive,

      activatedCount: previousActive.microFamilyIds.length,
      activatedMicroCount: previousActive.microFamilyIds.length,
      activatedMacroCount: previousActive.macroFamilyIds.length,

      activeMicroFamilyIds: previousActive.microFamilyIds,
      activeMacroFamilyIds: previousActive.macroFamilyIds,

      selectedMicroFamilyId: null,
      selectedMacroFamilyId: null,
      selectedRow: null,

      bestLong: null,
      bestShort: previousActive.bestShort,
      missingSides: previousActive.missingSides || [],

      warnings: sideResult.warnings || [],

      perf: {
        durationMs: elapsed(startedAt),
        weekRowsCacheHit: sideResult.weekRowsCacheHit,
        weekRowsCacheKey: sideResult.weekRowsCacheKey,
        scannedRows: sideResult.scannedRows,
        primaryRows: sideResult.primaryRows,
        previousRows: sideResult.previousRows,
        mergedPreviousWeek: sideResult.mergedPreviousWeek,
        recentWeekLookback: sideResult.recentWeekLookback,
        recentWeekKeysScanned: sideResult.recentWeekKeysScanned,
        recentWeekRows: sideResult.recentWeekRows
      }
    };
  }

  const indexes = buildSelectionIndexes(combinedRows);

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_short_selected_best`),

    source: topN === 1
      ? 'ADMIN_ACTIVATE_SINGLE_BEST_SHORT_TRUE_MICRO'
      : 'ADMIN_ACTIVATE_TOP_SHORT_TRUE_MICROS',

    mode,
    sideMode: 'short_only',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    requestedTradeSide: TARGET_TRADE_SIDE,
    preservedTradeSide: null,

    replacedSide: TARGET_TRADE_SIDE,
    preservedSide: null,

    empty: combinedRows.length === 0,
    emptyReason: combinedRows.length === 0
      ? 'NO_SHORT_TRUE_MICRO_ROWS_ACTIVE'
      : null,

    topNPerSide: topN,
    maxPerMacroFamily,

    eligibleCount: sideResult.tradableCount,
    softEligibleCount: sideResult.softCount,
    observationEligibleCount: sideResult.observationCount,
    rawEligibleCount: sideResult.rawCount,
    rankedCount: sideResult.candidateCount,
    allRankedCount: sideResult.sideCount,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies: combinedRows,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,
    selectedTier: sideResult.selectedTier,

    selectedRow,
    preservedOppositeRow: null,

    previousActiveMicroFamilyIds: previousActive.microFamilyIds,
    previousActiveMacroFamilyIds: previousActive.macroFamilyIds,

    usedSoftFallback: sideResult.selectedTier === 'SOFT',
    usedObservationFallback: sideResult.selectedTier === 'OBSERVATION',
    usedRawFallback: sideResult.selectedTier === 'RAW_SIDE',
    usedPreviousWeekMerge: Boolean(sideResult.mergedPreviousWeek)
  });

  return {
    action: 'activateBestSideMicro',

    sourceWeekKey,
    activeWeekKey,
    mode,
    topN,
    maxPerMacroFamily,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    requestedTradeSide: TARGET_TRADE_SIDE,
    preservedTradeSide: null,

    skipped: false,
    changed: true,

    sideCount: sideResult.sideCount,
    candidateCount: sideResult.candidateCount,
    hardCount: sideResult.hardCount,
    softCount: sideResult.softCount,
    observationCount: sideResult.observationCount,
    rawCount: sideResult.rawCount,
    tradableCount: sideResult.tradableCount,
    selectedTier: sideResult.selectedTier,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,

    selectedRow,
    preservedOppositeRow: null,

    bestLong: null,
    bestShort: active.bestShort,
    missingSides: active.missingSides || [],

    usedSoftFallback: Boolean(active.usedSoftFallback),
    usedObservationFallback: Boolean(active.usedObservationFallback),
    usedRawFallback: Boolean(active.usedRawFallback),
    usedPreviousWeekMerge: Boolean(active.usedPreviousWeekMerge),

    warnings: sideResult.warnings || [],

    perf: {
      durationMs: elapsed(startedAt),
      weekRowsCacheHit: sideResult.weekRowsCacheHit,
      weekRowsCacheKey: sideResult.weekRowsCacheKey,
      scannedRows: sideResult.scannedRows,
      primaryRows: sideResult.primaryRows,
      previousRows: sideResult.previousRows,
      mergedPreviousWeek: sideResult.mergedPreviousWeek,
      recentWeekLookback: sideResult.recentWeekLookback,
      recentWeekKeysScanned: sideResult.recentWeekKeysScanned,
      recentWeekRows: sideResult.recentWeekRows
    }
  };
}

async function activateSelected(body, forcedType = null, startedAt = now()) {
  const sourceWeekKey = firstValue(body.weekKey, getIsoWeekKey());
  const activeWeekKey = firstValue(body.activeWeekKey, getIsoWeekKey());

  const requested = selectedIdsFromBody(body);

  let microFamilyIds = requested.microFamilyIds;
  let macroFamilyIds = requested.macroFamilyIds;

  if (forcedType === 'micro') {
    microFamilyIds = requested.microFamilyIds;
    macroFamilyIds = [];
  }

  if (forcedType === 'macro') {
    microFamilyIds = [];
    macroFamilyIds = requested.macroFamilyIds.length
      ? requested.macroFamilyIds
      : requested.microFamilyIds.filter(isShortId);
  }

  if (forcedType === null && microFamilyIds.length === 0 && macroFamilyIds.length === 0) {
    microFamilyIds = requested.microFamilyIds;
    macroFamilyIds = requested.microFamilyIds.filter(isShortId);
  }

  const hasMicroIds = microFamilyIds.length > 0;
  const hasMacroIds = macroFamilyIds.length > 0;

  if (!hasMicroIds && !hasMacroIds) {
    const error = new Error(
      requested.ignoredLongIds.length > 0
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'SHORT_MICRO_OR_MACRO_FAMILY_IDS_REQUIRED'
    );
    error.statusCode = 400;
    throw error;
  }

  const selectedResult = await buildSelectedRotationRows({
    weekKey: sourceWeekKey,
    microFamilyIds,
    macroFamilyIds,
    minPrimaryRowsForMerge: minPrimaryRowsForPreviousMerge(body),
    recentWeekLookback: recentWeekLookback(body),
    startedAt
  });

  const microFamilies = selectedResult.rows;
  const indexes = buildSelectionIndexes(microFamilies);

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_short_selected`),

    source: forcedType === 'macro'
      ? 'ADMIN_ACTIVATE_SELECTED_SHORT_MACRO_EXPANDED_TRUE_MICROS'
      : forcedType === 'micro'
        ? 'ADMIN_ACTIVATE_SELECTED_SHORT_TRUE_MICROS'
        : 'ADMIN_ACTIVATE_SELECTED_SHORT_TRUE_MICROS',

    mode: 'selected',
    sideMode: 'short_only',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    empty: microFamilies.length === 0,
    emptyReason: microFamilies.length === 0
      ? 'NO_SELECTED_SHORT_TRUE_MICRO_IDS_MATCHED'
      : null,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    requestedMicroFamilyIds: microFamilyIds,
    requestedMacroFamilyIds: macroFamilyIds,
    ignoredRequestedIds: requested.ignoredLongIds.map((id) => ({
      id,
      reason: 'LONG_DISABLED_SHORT_ONLY'
    })),

    usedPreviousWeekMerge: Boolean(selectedResult.mergedPreviousWeek)
  });

  return {
    action: forcedType === 'macro'
      ? 'activateSelectedMacroFamilies'
      : forcedType === 'micro'
        ? 'activateSelectedMicroFamilies'
        : 'activateSelected',

    sourceWeekKey,
    activeWeekKey,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    bestLong: null,
    bestShort: active.bestShort,
    missingSides: active.missingSides || [],

    ignoredRequestedIds: active.ignoredRequestedIds || [],

    warnings: selectedResult.warnings || [],

    perf: {
      durationMs: elapsed(startedAt),
      weekRowsCacheHit: selectedResult.weekRowsCacheHit,
      weekRowsCacheKey: selectedResult.weekRowsCacheKey,
      scannedRows: selectedResult.scannedRows,
      microsCount: selectedResult.microsCount,
      primaryRows: selectedResult.primaryRows,
      previousRows: selectedResult.previousRows,
      mergedPreviousWeek: selectedResult.mergedPreviousWeek,
      recentWeekLookback: selectedResult.recentWeekLookback,
      recentWeekKeysScanned: selectedResult.recentWeekKeysScanned,
      recentWeekRows: selectedResult.recentWeekRows
    }
  };
}

async function handlePost(req, res) {
  const requestStartedAt = now();
  const body = await readBody(req);
  const action = String(body?.action || '').trim();

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      trueMicroOnly: true
    });
  }

  if (BLOCKED_LONG_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'LONG_DISABLED_SHORT_ONLY',
      action,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      trueMicroOnly: true,

      allowedActions: ALLOWED_ACTIONS
    });
  }

  if (action === 'activateBestBalanced') {
    const result = await activateBestBalanced(body, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (
    action === 'activateBestSideMicro' ||
    action === 'activateBestSideMicroFamily'
  ) {
    const result = await activateBestSideMicro(body, null, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateBestShortMicroFamily') {
    const result = await activateBestSideMicro(body, TARGET_TRADE_SIDE, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelected') {
    const result = await activateSelected(body, null, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelectedMicroFamilies') {
    const result = await activateSelected(body, 'micro', requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelectedMacroFamilies') {
    const result = await activateSelected(body, 'macro', requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  return res.status(400).json({
    ok: false,
    reason: 'UNKNOWN_ACTION',
    action,
    allowedActions: ALLOWED_ACTIONS,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'short-only-single-best-or-selected-true-micro');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');

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

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      trueMicroOnly: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}