// ================= FILE: src/analyze/scoring.js =================
// COMPLEET family scoring system with statistical edge detection

import { log1p, safeNumber } from '../utils.js';

export function calculateFamilyScore(familyStats = {}) {
  try {
    const completed = safeNumber(familyStats.completedTrades, 0);
    const sampleRel = safeNumber(familyStats.sampleReliability, 0);
    const avgR = safeNumber(familyStats.averageR, 0);
    const totalR = safeNumber(familyStats.totalR, 0);
    const pfRatio = safeNumber(familyStats.profitFactor, 1);
    const nearTP = safeNumber(familyStats.nearTpCount, 0);
    const oneRWins = safeNumber(familyStats.oneRWinCount, 0);

    if (completed === 0) return 0;

    let score = 0;

    // Fair value from sample size
    const fairScore = Math.min(completed * 100, 4000);
    score += fairScore * 0.35;

    // Sample reliability penalty/bonus
    const sampleScore = Math.max(0, sampleRel * 100) * 0.15;
    score += sampleScore;

    // Total expectancy (log-scaled)
    const totalScore = log1p(Math.abs(totalR)) * 1200 * Math.sign(totalR);
    score += totalScore * 0.15;

    // Average R (efficiency)
    const avgScore = log1p(Math.abs(avgR)) * 800 * Math.sign(avgR);
    score += avgScore * 0.10;

    // Profit factor bonus
    let pfBonus = 0;
    if (pfRatio > 1.5) pfBonus = 200;
    else if (pfRatio > 1.2) pfBonus = 100;
    else if (pfRatio < 0.8) pfBonus = -300;
    score += pfBonus * 0.15;

    // Near TP tracking
    score += Math.min(nearTP * 50, 200) * 0.08;

    // 1R+ wins
    score += Math.min(oneRWins * 40, 150) * 0.07;

    // Penalize losing families
    if (totalR < -2) score -= 500;
    if (sampleRel < 0.3) score -= 300;

    return Math.max(0, score);

  } catch (err) {
    console.error('calculateFamilyScore error:', err);
    return 0;
  }
}

export function calculateConfidenceScore(stats = {}) {
  try {
    const completed = safeNumber(stats.completedTrades, 0);
    const winRate = safeNumber(stats.winRate, 0);
    const profitFactor = safeNumber(stats.profitFactor, 1);
    const sampleRel = safeNumber(stats.sampleReliability, 0);

    if (completed < 5) return 0.25;
    if (completed < 20) return 0.5;

    let confidence = Math.min(completed / 100, 1) * 0.4;
    confidence += Math.abs(winRate - 0.5) * 0.3;
    confidence += Math.min(profitFactor / 2, 1) * 0.2;
    confidence += sampleRel * 0.1;

    return Math.min(confidence, 1);

  } catch (err) {
    console.error('calculateConfidenceScore error:', err);
    return 0;
  }
}

export function calculateSampleReliability(wins = 0, losses = 0, totalTrades = 0) {
  try {
    if (totalTrades === 0) return 0;

    const winRate = wins / totalTrades;
    const expectedWins = totalTrades * 0.5;
    const variance = totalTrades * 0.5 * 0.5;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0.5;

    const zScore = Math.abs(wins - expectedWins) / stdDev;
    const reliability = Math.min(1 - Math.exp(-zScore / 2), 0.95);

    return Math.max(0, reliability);

  } catch (err) {
    console.error('calculateSampleReliability error:', err);
    return 0;
  }
}

export function calculateWilsonLowerBound(wins = 0, losses = 0, confidence = 0.95) {
  try {
    const n = wins + losses;
    if (n === 0) return 0;

    const p = wins / n;
    const z = confidence === 0.95 ? 1.96 : (confidence === 0.90 ? 1.645 : 1.282);
    const z2 = z * z;

    const denominator = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;

    return Math.max(0, center - margin);

  } catch (err) {
    console.error('calculateWilsonLowerBound error:', err);
    return 0;
  }
}

export function calculateBayesianShrinkage(observed = 0, prior = 0.5, credibility = 0.5) {
  try {
    return observed * credibility + prior * (1 - credibility);
  } catch (err) {
    console.error('calculateBayesianShrinkage error:', err);
    return prior;
  }
}

export function detectEdge(stats = {}, minSampleSize = 20) {
  try {
    const completed = safeNumber(stats.completedTrades, 0);
    if (completed < minSampleSize) {
      return { hasEdge: false, reason: 'INSUFFICIENT_SAMPLE', confidence: 0 };
    }

    const wins = safeNumber(stats.winCount, 0);
    const losses = safeNumber(stats.lossCount, 0);
    const winRate = wins / completed;
    
    const lcb = calculateWilsonLowerBound(wins, losses, 0.95);
    
    if (lcb > 0.5) {
      return {
        hasEdge: true,
        type: 'POSITIVE',
        lcb95: lcb,
        observedWinRate: winRate,
        confidence: calculateConfidenceScore(stats)
      };
    }

    if (lcb < 0.45) {
      return {
        hasEdge: true,
        type: 'NEGATIVE',
        lcb95: lcb,
        observedWinRate: winRate,
        confidence: calculateConfidenceScore(stats)
      };
    }

    return {
      hasEdge: false,
      reason: 'NO_STATISTICAL_EDGE',
      lcb95: lcb,
      observedWinRate: winRate,
      confidence: calculateConfidenceScore(stats)
    };

  } catch (err) {
    console.error('detectEdge error:', err);
    return { hasEdge: false, reason: 'ERROR', error: err.message };
  }
}

export function applyFDRCorrection(pValues = [], alpha = 0.05) {
  try {
    if (!pValues || pValues.length === 0) return [];

    const sorted = pValues
      .map((p, idx) => ({ p, idx }))
      .sort((a, b) => a.p - b.p);

    const rejected = [];
    const m = sorted.length;

    for (let i = 0; i < sorted.length; i++) {
      const threshold = ((i + 1) / m) * alpha;
      if (sorted[i].p <= threshold) {
        rejected.push(sorted[i].idx);
      }
    }

    return rejected;

  } catch (err) {
    console.error('applyFDRCorrection error:', err);
    return [];
  }
}

export default {
  calculateFamilyScore, calculateConfidenceScore, calculateSampleReliability,
  calculateWilsonLowerBound, calculateBayesianShrinkage, detectEdge, applyFDRCorrection
};
