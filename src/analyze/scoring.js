// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber } from '../utils.js';

export function createMicroStats({ microFamilyId, familyId, side, definitionParts = [] }) {
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
    shadowWins: 0,
    shadowLosses: 0,

    totalR: 0,
    realTotalR: 0,
    shadowTotalR: 0,
    avgR: 0,
    avgWinR: 0,
    avgLossR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,

    directSLCount: 0,
    nearTpCount: 0,
    reachedHalfRCount: 0,
    reachedOneRCount: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    profitFactor: 0,
    sampleReliability: 0,
    balancedScore: 0,

    counters: {
      rsiZone: {},
      flow: {},
      obRelation: {},
      btcState: {},
      regime: {},
      scannerReason: {}
    },

    examples: [],
    recentOutcomes: [],
    updatedAt: Date.now()
  };
}

function inc(obj, key) {
  const k = String(key || 'UNKNOWN').toUpperCase();
  obj[k] = Number(obj[k] || 0) + 1;
}

export function updateObservation(stats, row = {}) {
  stats.seen += 1;
  stats.observations += 1;
  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);
  if (stats.examples.length < 20) {
    stats.examples.push(`${row.symbol}_${row.side}_${row.rsiZone}_${row.flow}_${row.obRelation}`);
  }
  stats.updatedAt = Date.now();
  return stats;
}

export function updateOutcome(stats, row = {}, source = 'REAL') {
  const src = String(source || row.source || 'REAL').toUpperCase();
  const isShadow = src === 'SHADOW';
  const weight = isShadow ? CONFIG.analyze.shadowWeight : 1;
  const exitR = safeNumber(row.exitR);
  const pnlPct = safeNumber(row.pnlPct);
  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (isShadow) {
    stats.shadowCompleted += 1;
    if (win) stats.shadowWins += 1;
    if (loss) stats.shadowLosses += 1;
    stats.shadowTotalR += exitR;
  } else {
    stats.realCompleted += 1;
    if (win) stats.realWins += 1;
    if (loss) stats.realLosses += 1;
    stats.realTotalR += exitR;
  }

  stats.completed = safeNumber(stats.realCompleted) + safeNumber(stats.shadowCompleted) * CONFIG.analyze.shadowWeight;
  stats.wins += win ? weight : 0;
  stats.losses += loss ? weight : 0;
  stats.flats += flat ? weight : 0;
  stats.totalR += exitR * weight;
  stats.totalPnlPct += pnlPct * weight;

  if (row.directToSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;

  // BE/trailing learning signals (measure-only phase). These let weekly rotation see
  // per-family whether breakeven would have helped or hurt before we ever apply it live.
  stats.beWouldExitCount = safeNumber(stats.beWouldExitCount) + (row.beWouldExit ? weight : 0);
  stats.gaveBackAfterHalfRCount = safeNumber(stats.gaveBackAfterHalfRCount) + (row.gaveBackAfterHalfR ? weight : 0);
  stats.gaveBackAfterOneRCount = safeNumber(stats.gaveBackAfterOneRCount) + (row.gaveBackAfterOneR ? weight : 0);
  stats.nearTpThenLossCount = safeNumber(stats.nearTpThenLossCount) + (row.nearTpThenLoss ? weight : 0);
  stats.totalCostR = safeNumber(stats.totalCostR) + safeNumber(row.costR) * weight;

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol,
    side: row.side,
    exitReason: row.exitReason,
    exitR,
    pnlPct,
    mfeR: safeNumber(row.mfeR),
    maeR: safeNumber(row.maeR),
    ts: row.closedAt || row.completedAt || Date.now()
  });
  stats.recentOutcomes = stats.recentOutcomes.slice(-30);
  stats.updatedAt = Date.now();
  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = CONFIG.rotation.wilsonZ) {
  const n = safeNumber(completed);
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
  const n = safeNumber(completed);
  const w = safeNumber(wins);
  const priorTrades = Math.max(0, CONFIG.rotation.priorTrades);
  const priorWins = priorTrades * clamp(CONFIG.rotation.priorWinrate, 0, 1);
  const denominator = n + priorTrades;
  return denominator > 0 ? clamp((w + priorWins) / denominator, 0, 1) : 0;
}

export function refreshStats(stats) {
  const completed = safeNumber(stats.completed);
  const wins = safeNumber(stats.wins);
  const losses = safeNumber(stats.losses);
  const totalR = safeNumber(stats.totalR);

  const rawWinrate = completed > 0 ? wins / completed : 0;
  const bayes = bayesianWinrate(wins, completed);
  const wilson = wilsonLowerBound(wins, completed);
  const fair = completed > 0 ? wilson * 0.75 + bayes * 0.25 : 0;
  const sampleReliability = completed > 0 ? completed / (completed + CONFIG.rotation.priorTrades) : 0;

  const avgR = completed > 0 ? totalR / completed : 0;
  const avgPnlPct = completed > 0 ? safeNumber(stats.totalPnlPct) / completed : 0;
  const avgWinR = wins > 0 ? Math.max(0, totalR) / Math.max(1, wins) : 0;
  const avgLossR = losses > 0 ? Math.min(0, totalR) / Math.max(1, losses) : 0;

  const grossWinR = stats.recentOutcomes.filter(r => safeNumber(r.exitR) > 0).reduce((sum, r) => sum + safeNumber(r.exitR), 0);
  const grossLossR = Math.abs(stats.recentOutcomes.filter(r => safeNumber(r.exitR) < 0).reduce((sum, r) => sum + safeNumber(r.exitR), 0));
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? 99 : 0;
  const pfNorm = clamp(profitFactor, 0, 5) / 5;
  const directSLPct = completed > 0 ? safeNumber(stats.directSLCount) / completed : 0;

  const balancedScore =
    fair * 100 +
    avgR * 25 +
    sampleReliability * 20 +
    pfNorm * 10 -
    directSLPct * 25;

  Object.assign(stats, {
    completed: Number(completed.toFixed(4)),
    winrate: Number(rawWinrate.toFixed(4)),
    bayesianWinrate: Number(bayes.toFixed(4)),
    wilsonLowerBound: Number(wilson.toFixed(4)),
    fairWinrate: Number(fair.toFixed(4)),
    sampleReliability: Number(sampleReliability.toFixed(4)),
    avgR: Number(avgR.toFixed(4)),
    avgPnlPct: Number(avgPnlPct.toFixed(4)),
    avgWinR: Number(avgWinR.toFixed(4)),
    avgLossR: Number(avgLossR.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(4)),
    directSLPct: Number(directSLPct.toFixed(4)),
    nearTpPct: completed > 0 ? Number((safeNumber(stats.nearTpCount) / completed).toFixed(4)) : 0,
    // Per-family management diagnostics. A high gaveBackAfterOneR with low beWouldExit hurt
    // means this family surrenders winners and SHOULD get breakeven. High beWouldExit with
    // good gross winrate means BE would have chopped winners early — give it room instead.
    gaveBackAfterHalfRPct: completed > 0 ? Number((safeNumber(stats.gaveBackAfterHalfRCount) / completed).toFixed(4)) : 0,
    gaveBackAfterOneRPct: completed > 0 ? Number((safeNumber(stats.gaveBackAfterOneRCount) / completed).toFixed(4)) : 0,
    nearTpThenLossPct: completed > 0 ? Number((safeNumber(stats.nearTpThenLossCount) / completed).toFixed(4)) : 0,
    beWouldExitPct: completed > 0 ? Number((safeNumber(stats.beWouldExitCount) / completed).toFixed(4)) : 0,
    avgCostR: completed > 0 ? Number((safeNumber(stats.totalCostR) / completed).toFixed(4)) : 0,
    balancedScore: Number(balancedScore.toFixed(4))
  });

  return stats;
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const rows = Object.values(micros).map(refreshStats);
  const sorted = [...rows].sort((a, b) => {
    if (mode === 'winrate') return b.fairWinrate - a.fairWinrate || b.completed - a.completed || b.avgR - a.avgR;
    if (mode === 'totalR') return b.totalR - a.totalR || b.fairWinrate - a.fairWinrate;
    if (mode === 'avgR') return b.avgR - a.avgR || b.completed - a.completed;
    if (mode === 'directSL') return a.directSLPct - b.directSLPct || b.completed - a.completed;
    if (mode === 'observed') return b.seen - a.seen || b.completed - a.completed;
    return b.balancedScore - a.balancedScore || b.fairWinrate - a.fairWinrate || b.completed - a.completed;
  });
  return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
}
