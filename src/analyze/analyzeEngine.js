// ================= FILE: src/analyze/analyzeEngine.js =================
// COMPLEET analysis engine for micro-families

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, groupBy } from '../utils.js';
import {
  calculateFamilyScore, calculateSampleReliability, calculateWilsonLowerBound,
  detectEdge, calculateConfidenceScore
} from './scoring.js';

export async function recordObservation(trade = {}) {
  try {
    const redis = getRedis();
    const familyId = trade.microFamilyId || 'UNKNOWN';
    const key = keys.familyObservation(familyId, now());

    const obs = {
      symbol: trade.symbol,
      entryPrice: trade.entryPrice,
      tp: trade.tp,
      sl: trade.sl,
      setup: trade.setup,
      regime: trade.regime,
      confirmation: trade.confirmationProfile,
      rsi: trade.rsi,
      volatility: trade.volatility,
      rrRatio: trade.rrRatio,
      timestamp: now()
    };

    await redis.set(key, obs);

    // Expire after 2 months
    await redis.expire(key, 60 * 24 * 60 * 60);

    return { ok: true, recordId: key };
  } catch (err) {
    console.error('recordObservation error:', err);
    return { ok: false, error: err.message };
  }
}

export async function getCompletedTrades(familyId = '') {
  try {
    const redis = getRedis();
    const pattern = keys.familyTrade(familyId, '*');
    const tradeKeys = await redis.keys(pattern);

    const trades = [];
    for (const key of tradeKeys) {
      const trade = await redis.get(key);
      if (trade && trade.exitReason) {
        trades.push(trade);
      }
    }

    return { ok: true, trades };
  } catch (err) {
    console.error('getCompletedTrades error:', err);
    return { ok: false, trades: [], error: err.message };
  }
}

export async function analyzeFamilyPerformance(familyId = '') {
  try {
    const tradeResult = await getCompletedTrades(familyId);
    const trades = tradeResult.trades || [];

    if (trades.length === 0) {
      return {
        ok: true,
        familyId,
        completedTrades: 0,
        stats: null,
        edge: { hasEdge: false, reason: 'NO_TRADES' }
      };
    }

    const wins = trades.filter(t => (t.netPnlR || 0) > 0).length;
    const losses = trades.filter(t => (t.netPnlR || 0) <= 0).length;
    const winRate = wins / trades.length;

    const totalR = trades.reduce((sum, t) => sum + (t.netPnlR || 0), 0);
    const averageR = totalR / trades.length;

    const profitWins = trades.filter(t => (t.pnl || 0) > 0);
    const profitWinsSum = profitWins.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const lossTrades = trades.filter(t => (t.pnl || 0) < 0);
    const lossSum = Math.abs(lossTrades.reduce((sum, t) => sum + (t.pnl || 0), 0));

    const profitFactor = lossSum > 0 ? profitWinsSum / lossSum : (profitWinsSum > 0 ? 999 : 1);

    const nearTPCount = trades.filter(t => {
      const exitRatio = Math.abs(t.exitPrice - t.tp) / Math.abs(t.tp - t.entryPrice);
      return exitRatio < 0.1;
    }).length;

    const oneRWinCount = trades.filter(t => (t.netPnlR || 0) >= 1).length;

    const sampleRel = calculateSampleReliability(wins, losses, trades.length);

    const stats = {
      completedTrades: trades.length,
      winCount: wins,
      lossCount: losses,
      winRate,
      totalR,
      averageR,
      profitFactor,
      nearTpCount: nearTPCount,
      oneRWinCount: oneRWinCount,
      sampleReliability: sampleRel
    };

    const edge = detectEdge(stats, 5);
    const score = calculateFamilyScore(stats);

    const redis = getRedis();
    const statsKey = keys.familyStats(familyId);
    await redis.set(statsKey, { ...stats, score, edge, lastUpdated: now() });

    return {
      ok: true,
      familyId,
      completedTrades: trades.length,
      stats,
      score,
      edge
    };

  } catch (err) {
    console.error('analyzeFamilyPerformance error:', err);
    return {
      ok: false,
      familyId,
      error: err.message,
      completedTrades: 0
    };
  }
}

export async function analyzeAllFamilies() {
  try {
    const redis = getRedis();
    const pattern = 'SHORT:FAMILY:STATS:*';
    const familyKeys = await redis.keys(pattern);

    const familyIds = familyKeys.map(k => k.split(':').pop());
    const results = [];

    for (const familyId of familyIds) {
      const result = await analyzeFamilyPerformance(familyId);
      if (result.ok && result.stats) {
        results.push({
          familyId,
          score: result.score,
          edge: result.edge,
          stats: result.stats
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    const summary = {
      analyzed: results.length,
      results,
      timestamp: now()
    };

    await redis.set(keys.familiesAnalysisSummary(), summary);

    return {
      ok: true,
      analyzed: results.length,
      topFamilies: results.slice(0, 10),
      summary
    };

  } catch (err) {
    console.error('analyzeAllFamilies error:', err);
    return { ok: false, error: err.message, analyzed: 0 };
  }
}

export async function getTopFamilies(limit = 42) {
  try {
    const redis = getRedis();
    const summaryKey = keys.familiesAnalysisSummary();
    const summary = await redis.get(summaryKey);

    if (!summary || !summary.results) {
      return { ok: false, reason: 'NO_SUMMARY', families: [] };
    }

    const top = summary.results.slice(0, limit);
    return { ok: true, families: top, count: top.length };

  } catch (err) {
    console.error('getTopFamilies error:', err);
    return { ok: false, error: err.message, families: [] };
  }
}

export default {
  recordObservation, getCompletedTrades, analyzeFamilyPerformance,
  analyzeAllFamilies, getTopFamilies
};
