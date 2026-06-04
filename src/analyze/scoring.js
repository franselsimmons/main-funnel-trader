// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;

function now() {
  return Date.now();
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function rotationNumber(key, fallback) {
  return safeNumber(CONFIG.rotation?.[key], fallback);
}

function analyzeNumber(key, fallback) {
  return safeNumber(CONFIG.analyze?.[key], fallback);
}

function shadowWeight() {
  return clamp(analyzeNumber('shadowWeight', 0.35), 0, 1);
}

function priorTrades() {
  return Math.max(0, rotationNumber('priorTrades', DEFAULT_PRIOR_TRADES));
}

function priorWinrate() {
  return clamp(rotationNumber('priorWinrate', DEFAULT_PRIOR_WINRATE), 0, 1);
}

function wilsonZ() {
  return Math.max(0.1, rotationNumber('wilsonZ', DEFAULT_WILSON_Z));
}

function sampleCap() {
  return Math.max(1, rotationNumber('sampleReliabilityCap', DEFAULT_SAMPLE_CAP));
}

function avgRCap() {
  return Math.max(0.5, rotationNumber('avgRCap', DEFAULT_AVG_R_CAP));
}

function avgRSampleExponent() {
  return clamp(
    rotationNumber('avgRSampleExponent', DEFAULT_AVG_R_SAMPLE_EXPONENT),
    0.5,
    3
  );
}

function inc(obj, key, amount = 1) {
  const k = String(key || 'UNKNOWN').toUpperCase();

  obj[k] = safeNumber(obj[k], 0) + amount;
}

function makeCounters() {
  return {
    rsiZone: {},
    flow: {},
    obRelation: {},
    btcState: {},
    regime: {},
    scannerReason: {}
  };
}

function positive(value) {
  return Math.max(0, safeNumber(value, 0));
}

function actualOutcomeCounts(stats = {}) {
  const realWins = safeNumber(stats.realWins, 0);
  const realLosses = safeNumber(stats.realLosses, 0);
  const realFlats = safeNumber(stats.realFlats, 0);

  const shadowWins = safeNumber(stats.shadowWins, 0);
  const shadowLosses = safeNumber(stats.shadowLosses, 0);
  const shadowFlats = safeNumber(stats.shadowFlats, 0);

  const wins = realWins + shadowWins;
  const losses = realLosses + shadowLosses;
  const flats = realFlats + shadowFlats;
  const completed = wins + losses + flats;

  if (completed > 0) {
    return {
      wins,
      losses,
      flats,
      completed
    };
  }

  const weightedWins = safeNumber(stats.wins, 0);
  const weightedLosses = safeNumber(stats.losses, 0);
  const weightedFlats = safeNumber(stats.flats, 0);
  const weightedCompleted = weightedWins + weightedLosses + weightedFlats;

  if (weightedCompleted > 0) {
    return {
      wins: weightedWins,
      losses: weightedLosses,
      flats: weightedFlats,
      completed: weightedCompleted
    };
  }

  const completedFallback = safeNumber(stats.completed, 0);
  const winrateFallback = clamp(safeNumber(stats.winrate, 0), 0, 1);

  if (completedFallback <= 0) {
    return {
      wins: 0,
      losses: 0,
      flats: 0,
      completed: 0
    };
  }

  return {
    wins: completedFallback * winrateFallback,
    losses: completedFallback * (1 - winrateFallback),
    flats: 0,
    completed: completedFallback
  };
}

function weightedCompletedCount(stats = {}) {
  const realCompleted = safeNumber(stats.realCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

  if (realCompleted > 0 || shadowCompleted > 0) {
    return realCompleted + shadowCompleted * shadowWeight();
  }

  return safeNumber(stats.completed, 0);
}

function sampleReliability(completed) {
  const n = safeNumber(completed, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, sampleCap()) / sampleCap()), 0, 1);
}

function sampleAdjustedAvgR(avgR, reliability) {
  const cappedAvgR = clamp(
    safeNumber(avgR, 0),
    -avgRCap(),
    avgRCap()
  );

  const samplePenalty = Math.pow(
    clamp(reliability, 0, 1),
    avgRSampleExponent()
  );

  return cappedAvgR * samplePenalty;
}

export function createMicroStats({
  microFamilyId,
  familyId,
  side,
  definitionParts = []
} = {}) {
  const ts = now();

  return {
    microFamilyId,
    familyId,
    side,
    definitionParts,
    definition: definitionParts.join(' | '),

    seen: 0,
    observations: 0,

    realCompleted: 0,
    shadowCompleted: 0,
    completed: 0,
    winrateSample: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    shadowWins: 0,
    shadowLosses: 0,
    shadowFlats: 0,

    totalR: 0,
    realTotalR: 0,
    shadowTotalR: 0,

    grossWinR: 0,
    grossLossR: 0,

    avgR: 0,
    avgWinR: 0,
    avgLossR: 0,
    sampleAdjustedAvgR: 0,
    avgRScore: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    directSLCount: 0,
    nearTpCount: 0,
    reachedHalfRCount: 0,
    reachedOneRCount: 0,

    beWouldExitCount: 0,
    gaveBackAfterHalfRCount: 0,
    gaveBackAfterOneRCount: 0,
    nearTpThenLossCount: 0,

    totalCostR: 0,
    avgCostR: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,

    profitFactor: 0,
    sampleReliability: 0,
    balancedScore: 0,
    dashboardBalancedScore: 0,

    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    counters: makeCounters(),

    examples: [],
    recentOutcomes: [],

    createdAt: ts,
    updatedAt: ts
  };
}

function ensureStatsShape(stats = {}) {
  stats.counters ||= makeCounters();
  stats.counters.rsiZone ||= {};
  stats.counters.flow ||= {};
  stats.counters.obRelation ||= {};
  stats.counters.btcState ||= {};
  stats.counters.regime ||= {};
  stats.counters.scannerReason ||= {};

  stats.examples = Array.isArray(stats.examples) ? stats.examples : [];
  stats.recentOutcomes = Array.isArray(stats.recentOutcomes) ? stats.recentOutcomes : [];

  stats.definitionParts = Array.isArray(stats.definitionParts)
    ? stats.definitionParts
    : [];

  stats.definition ||= stats.definitionParts.join(' | ');

  stats.realFlats = safeNumber(stats.realFlats, 0);
  stats.shadowFlats = safeNumber(stats.shadowFlats, 0);

  stats.grossWinR = safeNumber(stats.grossWinR, 0);
  stats.grossLossR = safeNumber(stats.grossLossR, 0);
  stats.totalCostR = safeNumber(stats.totalCostR, 0);

  stats.winrateSample = safeNumber(stats.winrateSample, 0);
  stats.sampleAdjustedWinrate = safeNumber(stats.sampleAdjustedWinrate, 0);
  stats.sampleAdjustedAvgR = safeNumber(stats.sampleAdjustedAvgR, 0);
  stats.avgRScore = safeNumber(stats.avgRScore, 0);

  stats.balancedScore = safeNumber(stats.balancedScore, 0);
  stats.dashboardBalancedScore = safeNumber(stats.dashboardBalancedScore, 0);

  stats.createdAt ||= now();
  stats.updatedAt ||= now();

  return stats;
}

export function updateObservation(stats, row = {}) {
  ensureStatsShape(stats);

  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;

  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);

  if (stats.examples.length < 20) {
    stats.examples.push({
      symbol: row.symbol || null,
      side: row.side || null,
      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      scannerReason: row.scannerReason || null,
      ts: row.createdAt || row.ts || now()
    });
  }

  stats.updatedAt = now();

  return stats;
}

export function updateOutcome(stats, row = {}, source = 'REAL') {
  ensureStatsShape(stats);

  const src = String(source || row.source || 'REAL').toUpperCase();
  const isShadow = src === 'SHADOW';
  const weight = isShadow ? shadowWeight() : 1;

  const exitR = safeNumber(row.exitR ?? row.netR, 0);
  const pnlPct = safeNumber(row.pnlPct ?? row.netPnlPct, 0);
  const costR = safeNumber(row.costR, 0);

  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (isShadow) {
    stats.shadowCompleted = safeNumber(stats.shadowCompleted, 0) + 1;
    stats.shadowTotalR = safeNumber(stats.shadowTotalR, 0) + exitR;

    if (win) stats.shadowWins = safeNumber(stats.shadowWins, 0) + 1;
    if (loss) stats.shadowLosses = safeNumber(stats.shadowLosses, 0) + 1;
    if (flat) stats.shadowFlats = safeNumber(stats.shadowFlats, 0) + 1;
  } else {
    stats.realCompleted = safeNumber(stats.realCompleted, 0) + 1;
    stats.realTotalR = safeNumber(stats.realTotalR, 0) + exitR;

    if (win) stats.realWins = safeNumber(stats.realWins, 0) + 1;
    if (loss) stats.realLosses = safeNumber(stats.realLosses, 0) + 1;
    if (flat) stats.realFlats = safeNumber(stats.realFlats, 0) + 1;
  }

  stats.completed = weightedCompletedCount(stats);

  stats.wins = safeNumber(stats.wins, 0) + (win ? weight : 0);
  stats.losses = safeNumber(stats.losses, 0) + (loss ? weight : 0);
  stats.flats = safeNumber(stats.flats, 0) + (flat ? weight : 0);

  stats.totalR = safeNumber(stats.totalR, 0) + exitR * weight;
  stats.totalPnlPct = safeNumber(stats.totalPnlPct, 0) + pnlPct * weight;

  if (win) {
    stats.grossWinR = safeNumber(stats.grossWinR, 0) + exitR * weight;
  }

  if (loss) {
    stats.grossLossR = safeNumber(stats.grossLossR, 0) + Math.abs(exitR) * weight;
  }

  if (row.directToSL) stats.directSLCount = safeNumber(stats.directSLCount, 0) + weight;
  if (row.nearTpSeen) stats.nearTpCount = safeNumber(stats.nearTpCount, 0) + weight;
  if (row.reachedHalfR) stats.reachedHalfRCount = safeNumber(stats.reachedHalfRCount, 0) + weight;
  if (row.reachedOneR) stats.reachedOneRCount = safeNumber(stats.reachedOneRCount, 0) + weight;

  if (row.beWouldExit) stats.beWouldExitCount = safeNumber(stats.beWouldExitCount, 0) + weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount = safeNumber(stats.gaveBackAfterHalfRCount, 0) + weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount = safeNumber(stats.gaveBackAfterOneRCount, 0) + weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount = safeNumber(stats.nearTpThenLossCount, 0) + weight;

  stats.totalCostR = safeNumber(stats.totalCostR, 0) + costR * weight;

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol || null,
    side: row.side || null,

    exitReason: row.exitReason || null,

    exitR,
    netR: safeNumber(row.netR ?? exitR, exitR),
    grossR: safeNumber(row.grossR, 0),

    pnlPct,
    netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
    grossPnlPct: safeNumber(row.grossPnlPct, 0),

    costR,
    costPct: safeNumber(row.costPct, 0),

    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    directToSL: Boolean(row.directToSL),
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),

    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),

    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),

    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-30);
  stats.updatedAt = now();

  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
  const n = safeNumber(completed, 0);
  const w = clamp(safeNumber(wins, 0), 0, n);

  if (n <= 0) return 0;

  const p = w / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return clamp((centre - margin) / denominator, 0, 1);
}

export function bayesianWinrate(wins, completed) {
  const n = safeNumber(completed, 0);
  const w = safeNumber(wins, 0);

  const priorN = priorTrades();
  const priorW = priorN * priorWinrate();
  const denominator = n + priorN;

  return denominator > 0
    ? clamp((w + priorW) / denominator, 0, 1)
    : 0;
}

function fallbackGrossFromRecent(stats) {
  const outcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes
    : [];

  const grossWinR = outcomes
    .filter((row) => safeNumber(row.exitR, 0) > 0)
    .reduce((sum, row) => sum + safeNumber(row.exitR, 0), 0);

  const grossLossR = Math.abs(
    outcomes
      .filter((row) => safeNumber(row.exitR, 0) < 0)
      .reduce((sum, row) => sum + safeNumber(row.exitR, 0), 0)
  );

  return {
    grossWinR,
    grossLossR
  };
}

function buildBalancedScore({
  fair,
  avgR,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;
  const totalRComponent = Math.log1p(positive(totalR)) * 12;
  const avgRComponent = Math.log1p(positive(avgR)) * 8;

  return (
    fair * 100 +
    sampleRel * 25 +
    totalRComponent +
    avgRComponent +
    pfNorm * 8 +
    nearTpPct * 4 +
    reachedOneRPct * 4 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8
  );
}

function buildAvgRScore({
  sampleAdjustedAvgRValue,
  fair,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;
  const totalRComponent = Math.log1p(positive(totalR)) * 8;

  return (
    sampleAdjustedAvgRValue * 100 +
    fair * 35 +
    sampleRel * 25 +
    totalRComponent +
    pfNorm * 8 +
    nearTpPct * 3 +
    reachedOneRPct * 3 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8
  );
}

export function refreshStats(stats) {
  ensureStatsShape(stats);

  const weightedCompleted = weightedCompletedCount(stats);
  const weightedWins = safeNumber(stats.wins, 0);
  const weightedLosses = safeNumber(stats.losses, 0);
  const totalR = safeNumber(stats.totalR, 0);

  const actualCounts = actualOutcomeCounts(stats);
  const winrateSample = safeNumber(actualCounts.completed, 0);
  const winrateWins = safeNumber(actualCounts.wins, 0);
  const winrateFlats = safeNumber(actualCounts.flats, 0);
  const winrateSuccesses = winrateWins + winrateFlats * 0.5;

  const rawWinrate = winrateSample > 0
    ? winrateSuccesses / winrateSample
    : 0;

  const bayes = bayesianWinrate(winrateSuccesses, winrateSample);
  const wilson = wilsonLowerBound(winrateSuccesses, winrateSample);

  const fair = winrateSample > 0
    ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
    : 0;

  const reliability = sampleReliability(winrateSample);
  const fallbackGross = fallbackGrossFromRecent(stats);

  const grossWinR = safeNumber(stats.grossWinR, 0) > 0
    ? safeNumber(stats.grossWinR, 0)
    : fallbackGross.grossWinR;

  const grossLossR = safeNumber(stats.grossLossR, 0) > 0
    ? safeNumber(stats.grossLossR, 0)
    : fallbackGross.grossLossR;

  const avgR = weightedCompleted > 0
    ? totalR / weightedCompleted
    : 0;

  const avgPnlPct = weightedCompleted > 0
    ? safeNumber(stats.totalPnlPct, 0) / weightedCompleted
    : 0;

  const avgWinR = weightedWins > 0
    ? grossWinR / weightedWins
    : 0;

  const avgLossR = weightedLosses > 0
    ? -grossLossR / weightedLosses
    : 0;

  const profitFactor =
    grossLossR > 0 ? grossWinR / grossLossR :
    grossWinR > 0 ? 99 :
    0;

  const directSLPct = weightedCompleted > 0
    ? safeNumber(stats.directSLCount, 0) / weightedCompleted
    : 0;

  const nearTpPct = weightedCompleted > 0
    ? safeNumber(stats.nearTpCount, 0) / weightedCompleted
    : 0;

  const reachedHalfRPct = weightedCompleted > 0
    ? safeNumber(stats.reachedHalfRCount, 0) / weightedCompleted
    : 0;

  const reachedOneRPct = weightedCompleted > 0
    ? safeNumber(stats.reachedOneRCount, 0) / weightedCompleted
    : 0;

  const gaveBackAfterHalfRPct = weightedCompleted > 0
    ? safeNumber(stats.gaveBackAfterHalfRCount, 0) / weightedCompleted
    : 0;

  const gaveBackAfterOneRPct = weightedCompleted > 0
    ? safeNumber(stats.gaveBackAfterOneRCount, 0) / weightedCompleted
    : 0;

  const nearTpThenLossPct = weightedCompleted > 0
    ? safeNumber(stats.nearTpThenLossCount, 0) / weightedCompleted
    : 0;

  const beWouldExitPct = weightedCompleted > 0
    ? safeNumber(stats.beWouldExitCount, 0) / weightedCompleted
    : 0;

  const avgCostR = weightedCompleted > 0
    ? safeNumber(stats.totalCostR, 0) / weightedCompleted
    : 0;

  const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);

  const balancedScore = buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });

  const avgRScore = buildAvgRScore({
    sampleAdjustedAvgRValue,
    fair,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });

  Object.assign(stats, {
    completed: round4(weightedCompleted),
    winrateSample: round4(winrateSample),

    grossWinR: round4(grossWinR),
    grossLossR: round4(grossLossR),

    winrate: round4(rawWinrate),
    bayesianWinrate: round4(bayes),
    wilsonLowerBound: round4(wilson),
    fairWinrate: round4(fair),
    sampleAdjustedWinrate: round4(fair),

    sampleReliability: round4(reliability),

    avgR: round4(avgR),
    avgPnlPct: round4(avgPnlPct),
    avgWinR: round4(avgWinR),
    avgLossR: round4(avgLossR),
    sampleAdjustedAvgR: round4(sampleAdjustedAvgRValue),
    avgRScore: round4(avgRScore),

    profitFactor: round4(profitFactor),

    directSLPct: round4(directSLPct),
    nearTpPct: round4(nearTpPct),
    reachedHalfRPct: round4(reachedHalfRPct),
    reachedOneRPct: round4(reachedOneRPct),

    gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
    gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
    nearTpThenLossPct: round4(nearTpThenLossPct),
    beWouldExitPct: round4(beWouldExitPct),

    avgCostR: round4(avgCostR),

    balancedScore: round4(balancedScore),
    dashboardBalancedScore: round4(balancedScore),

    updatedAt: now()
  });

  return stats;
}

function sortById(a, b) {
  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function compareWinrate(a, b) {
  return (
    b.fairWinrate - a.fairWinrate ||
    b.wilsonLowerBound - a.wilsonLowerBound ||
    b.bayesianWinrate - a.bayesianWinrate ||
    b.winrateSample - a.winrateSample ||
    b.winrate - a.winrate ||
    b.totalR - a.totalR ||
    b.avgR - a.avgR ||
    sortById(a, b)
  );
}

function compareAvgR(a, b) {
  return (
    b.avgRScore - a.avgRScore ||
    b.sampleAdjustedAvgR - a.sampleAdjustedAvgR ||
    b.winrateSample - a.winrateSample ||
    b.fairWinrate - a.fairWinrate ||
    b.totalR - a.totalR ||
    b.avgR - a.avgR ||
    sortById(a, b)
  );
}

function compareBalanced(a, b) {
  return (
    b.balancedScore - a.balancedScore ||
    compareWinrate(a, b)
  );
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const selectedMode = String(mode || 'balanced').trim();

  const rows = Object.values(micros || {})
    .filter(Boolean)
    .map((row) => {
      const refreshed = refreshStats(row);

      refreshed.dashboardBalancedScore = refreshed.balancedScore;

      return refreshed;
    });

  const sorted = [...rows].sort((a, b) => {
    if (selectedMode === 'winrate') {
      return compareWinrate(a, b);
    }

    if (selectedMode === 'totalR') {
      return (
        b.totalR - a.totalR ||
        compareWinrate(a, b)
      );
    }

    if (selectedMode === 'avgR') {
      return compareAvgR(a, b);
    }

    if (selectedMode === 'directSL') {
      return (
        a.directSLPct - b.directSLPct ||
        b.winrateSample - a.winrateSample ||
        compareBalanced(a, b)
      );
    }

    if (selectedMode === 'observed') {
      return (
        b.seen - a.seen ||
        b.winrateSample - a.winrateSample ||
        compareBalanced(a, b)
      );
    }

    return compareBalanced(a, b);
  });

  return sorted.map((row, index) => ({
    ...row,
    dashboardBalancedScore: row.balancedScore,
    rank: index + 1
  }));
}