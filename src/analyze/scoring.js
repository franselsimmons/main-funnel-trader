// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber } from '../utils.js';

function now() {
  return Date.now();
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
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

export function createMicroStats({
  microFamilyId,
  familyId,
  side,
  definitionParts = []
} = {}) {
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

    profitFactor: 0,
    sampleReliability: 0,
    balancedScore: 0,

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

    createdAt: now(),
    updatedAt: now()
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

  stats.examples ||= [];
  stats.recentOutcomes ||= [];

  stats.grossWinR = safeNumber(stats.grossWinR, 0);
  stats.grossLossR = safeNumber(stats.grossLossR, 0);
  stats.totalCostR = safeNumber(stats.totalCostR, 0);

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
  const weight = isShadow ? CONFIG.analyze.shadowWeight : 1;

  const exitR = safeNumber(row.exitR, 0);
  const pnlPct = safeNumber(row.pnlPct, 0);
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

  stats.completed =
    safeNumber(stats.realCompleted, 0) +
    safeNumber(stats.shadowCompleted, 0) * CONFIG.analyze.shadowWeight;

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
    pnlPct,
    costR,
    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),
    directToSL: Boolean(row.directToSL),
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),
    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-30);
  stats.updatedAt = now();

  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = CONFIG.rotation.wilsonZ) {
  const n = safeNumber(completed, 0);
  const w = clamp(wins, 0, n);

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

  const priorTrades = Math.max(0, safeNumber(CONFIG.rotation.priorTrades, 24));
  const priorWinrate = clamp(CONFIG.rotation.priorWinrate, 0, 1);
  const priorWins = priorTrades * priorWinrate;

  const denominator = n + priorTrades;

  return denominator > 0
    ? clamp((w + priorWins) / denominator, 0, 1)
    : 0;
}

function fallbackGrossFromRecent(stats) {
  const outcomes = Array.isArray(stats.recentOutcomes) ? stats.recentOutcomes : [];

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

export function refreshStats(stats) {
  ensureStatsShape(stats);

  const completed = safeNumber(stats.completed, 0);
  const wins = safeNumber(stats.wins, 0);
  const losses = safeNumber(stats.losses, 0);
  const totalR = safeNumber(stats.totalR, 0);

  const rawWinrate = completed > 0 ? wins / completed : 0;
  const bayes = bayesianWinrate(wins, completed);
  const wilson = wilsonLowerBound(wins, completed);
  const fair = completed > 0 ? wilson * 0.75 + bayes * 0.25 : 0;

  const priorTrades = Math.max(0, safeNumber(CONFIG.rotation.priorTrades, 24));
  const sampleReliability = completed > 0
    ? completed / (completed + priorTrades)
    : 0;

  const fallbackGross = fallbackGrossFromRecent(stats);

  const grossWinR = safeNumber(stats.grossWinR, 0) > 0
    ? safeNumber(stats.grossWinR, 0)
    : fallbackGross.grossWinR;

  const grossLossR = safeNumber(stats.grossLossR, 0) > 0
    ? safeNumber(stats.grossLossR, 0)
    : fallbackGross.grossLossR;

  const avgR = completed > 0 ? totalR / completed : 0;
  const avgPnlPct = completed > 0 ? safeNumber(stats.totalPnlPct, 0) / completed : 0;

  const avgWinR = wins > 0 ? grossWinR / wins : 0;
  const avgLossR = losses > 0 ? -grossLossR / losses : 0;

  const profitFactor =
    grossLossR > 0 ? grossWinR / grossLossR :
    grossWinR > 0 ? 99 :
    0;

  const pfNorm = clamp(profitFactor, 0, 5) / 5;

  const directSLPct = completed > 0
    ? safeNumber(stats.directSLCount, 0) / completed
    : 0;

  const nearTpPct = completed > 0
    ? safeNumber(stats.nearTpCount, 0) / completed
    : 0;

  const reachedHalfRPct = completed > 0
    ? safeNumber(stats.reachedHalfRCount, 0) / completed
    : 0;

  const reachedOneRPct = completed > 0
    ? safeNumber(stats.reachedOneRCount, 0) / completed
    : 0;

  const gaveBackAfterOneRPct = completed > 0
    ? safeNumber(stats.gaveBackAfterOneRCount, 0) / completed
    : 0;

  const nearTpThenLossPct = completed > 0
    ? safeNumber(stats.nearTpThenLossCount, 0) / completed
    : 0;

  const avgCostR = completed > 0
    ? safeNumber(stats.totalCostR, 0) / completed
    : 0;

  const balancedScore =
    fair * 100 +
    avgR * 25 +
    sampleReliability * 20 +
    pfNorm * 10 +
    nearTpPct * 4 +
    reachedOneRPct * 4 -
    directSLPct * 25 -
    nearTpThenLossPct * 8 -
    Math.max(0, avgCostR) * 8;

  Object.assign(stats, {
    completed: round4(completed),

    grossWinR: round4(grossWinR),
    grossLossR: round4(grossLossR),

    winrate: round4(rawWinrate),
    bayesianWinrate: round4(bayes),
    wilsonLowerBound: round4(wilson),
    fairWinrate: round4(fair),

    sampleReliability: round4(sampleReliability),

    avgR: round4(avgR),
    avgPnlPct: round4(avgPnlPct),
    avgWinR: round4(avgWinR),
    avgLossR: round4(avgLossR),

    profitFactor: round4(profitFactor),

    directSLPct: round4(directSLPct),
    nearTpPct: round4(nearTpPct),
    reachedHalfRPct: round4(reachedHalfRPct),
    reachedOneRPct: round4(reachedOneRPct),

    gaveBackAfterHalfRPct: completed > 0
      ? round4(safeNumber(stats.gaveBackAfterHalfRCount, 0) / completed)
      : 0,

    gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
    nearTpThenLossPct: round4(nearTpThenLossPct),

    beWouldExitPct: completed > 0
      ? round4(safeNumber(stats.beWouldExitCount, 0) / completed)
      : 0,

    avgCostR: round4(avgCostR),
    balancedScore: round4(balancedScore),

    updatedAt: stats.updatedAt || now()
  });

  return stats;
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const rows = Object.values(micros || {})
    .filter(Boolean)
    .map((row) => refreshStats(row));

  const sorted = [...rows].sort((a, b) => {
    if (mode === 'winrate') {
      return (
        b.fairWinrate - a.fairWinrate ||
        b.completed - a.completed ||
        b.avgR - a.avgR ||
        b.totalR - a.totalR
      );
    }

    if (mode === 'totalR') {
      return (
        b.totalR - a.totalR ||
        b.fairWinrate - a.fairWinrate ||
        b.completed - a.completed
      );
    }

    if (mode === 'avgR') {
      return (
        b.avgR - a.avgR ||
        b.completed - a.completed ||
        b.fairWinrate - a.fairWinrate
      );
    }

    if (mode === 'directSL') {
      return (
        a.directSLPct - b.directSLPct ||
        b.completed - a.completed ||
        b.balancedScore - a.balancedScore
      );
    }

    if (mode === 'observed') {
      return (
        b.seen - a.seen ||
        b.completed - a.completed ||
        b.balancedScore - a.balancedScore
      );
    }

    return (
      b.balancedScore - a.balancedScore ||
      b.fairWinrate - a.fairWinrate ||
      b.completed - a.completed ||
      b.totalR - a.totalR
    );
  });

  return sorted.map((row, index) => ({
    ...row,
    rank: index + 1
  }));
}