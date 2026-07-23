// ================= FILE: src/analyze/weeklyCandidates.js =================
//
// Weekly candidate tracking and statistics
// Monitors which candidates appeared and their performance
//

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now } from '../utils.js';

/**
 * Record candidate appearance
 */
export async function recordCandidateAppearance(candidate = {}) {
  try {
    const redis = getRedis();
    const timestamp = now();
    const dateKey = new Date(timestamp).toISOString().split('T')[0];
    const weekKey = getWeekKey(timestamp);

    // Create candidate record
    const record = {
      symbol: candidate.symbol,
      microFamilyId: candidate.microFamilyId,
      setup: candidate.setup,
      regime: candidate.regime,
      confirmationProfile: candidate.confirmationProfile,
      entryPrice: candidate.entryPrice,
      tp: candidate.tp,
      sl: candidate.sl,
      rrRatio: candidate.rrRatio,
      timestamp,
      dateKey,
      weekKey,
      appearances: 1
    };

    // Store daily
    await redis.set(`CANDIDATE:DAILY:${dateKey}:${candidate.symbol}:${timestamp}`, record);

    // Store weekly aggregate
    const weeklyKey = `CANDIDATE:WEEKLY:${weekKey}:${candidate.microFamilyId}`;
    const existing = await redis.get(weeklyKey) || {};

    if (!existing.appearances) {
      existing.appearances = 0;
      existing.symbols = [];
      existing.setupCounts = {};
      existing.regimeCounts = {};
    }

    existing.appearances++;

    if (!existing.symbols.includes(candidate.symbol)) {
      existing.symbols.push(candidate.symbol);
    }

    existing.setupCounts[candidate.setup] = (existing.setupCounts[candidate.setup] || 0) + 1;
    existing.regimeCounts[candidate.regime] = (existing.regimeCounts[candidate.regime] || 0) + 1;

    await redis.set(weeklyKey, existing);

    return { ok: true };
  } catch (err) {
    console.error('recordCandidateAppearance error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Get weekly statistics
 */
export async function getWeeklyStats(weekKey = '') {
  try {
    const redis = getRedis();
    const week = weekKey || getWeekKey(now());

    // Get all families for this week
    const familyPattern = `CANDIDATE:WEEKLY:${week}:*`;
    const familyKeys = await redis.keys(familyPattern);

    const stats = {
      week: week,
      totalAppearances: 0,
      familyStats: {},
      setupDistribution: {},
      regimeDistribution: {},
      symbolsScanned: new Set()
    };

    for (const key of familyKeys) {
      const familyId = key.split(':')[3];
      const data = await redis.get(key);

      if (!data) continue;

      stats.totalAppearances += data.appearances || 0;

      stats.familyStats[familyId] = {
        appearances: data.appearances,
        symbols: data.symbols || [],
        setups: data.setupCounts || {},
        regimes: data.regimeCounts || {}
      };

      // Aggregate distributions
      for (const setup in data.setupCounts) {
        stats.setupDistribution[setup] = (stats.setupDistribution[setup] || 0) + data.setupCounts[setup];
      }

      for (const regime in data.regimeCounts) {
        stats.regimeDistribution[regime] = (stats.regimeDistribution[regime] || 0) + data.regimeCounts[regime];
      }

      // Track unique symbols
      if (data.symbols) {
        for (const sym of data.symbols) {
          stats.symbolsScanned.add(sym);
        }
      }
    }

    stats.uniqueSymbols = stats.symbolsScanned.size;
    delete stats.symbolsScanned;

    return {
      ok: true,
      stats
    };
  } catch (err) {
    console.error('getWeeklyStats error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Get daily statistics
 */
export async function getDailyStats(dateKey = '') {
  try {
    const redis = getRedis();
    const date = dateKey || new Date(now()).toISOString().split('T')[0];

    const pattern = `CANDIDATE:DAILY:${date}:*`;
    const candidateKeys = await redis.keys(pattern);

    const stats = {
      date,
      totalCandidates: candidateKeys.length,
      bySymbol: {},
      bySetup: {},
      byRegime: {},
      avgRR: 0
    };

    let totalRR = 0;
    let rrCount = 0;

    for (const key of candidateKeys) {
      const parts = key.split(':');
      const symbol = parts[3];

      const record = await redis.get(key);
      if (!record) continue;

      // By symbol
      if (!stats.bySymbol[symbol]) {
        stats.bySymbol[symbol] = { count: 0, setups: {}, regimes: {} };
      }
      stats.bySymbol[symbol].count++;
      stats.bySymbol[symbol].setups[record.setup] = (stats.bySymbol[symbol].setups[record.setup] || 0) + 1;
      stats.bySymbol[symbol].regimes[record.regime] = (stats.bySymbol[symbol].regimes[record.regime] || 0) + 1;

      // By setup
      stats.bySetup[record.setup] = (stats.bySetup[record.setup] || 0) + 1;

      // By regime
      stats.byRegime[record.regime] = (stats.byRegime[record.regime] || 0) + 1;

      // Average R/R
      if (record.rrRatio) {
        totalRR += record.rrRatio;
        rrCount++;
      }
    }

    if (rrCount > 0) {
      stats.avgRR = (totalRR / rrCount).toFixed(2);
    }

    return {
      ok: true,
      stats
    };
  } catch (err) {
    console.error('getDailyStats error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Compare performance of different setups
 */
export async function compareSetupPerformance(weekKey = '') {
  try {
    const redis = getRedis();
    const week = weekKey || getWeekKey(now());

    const setupStats = {};

    // Get all trades from this week
    const tradePattern = `FAMILY_TRADE:*`;
    const tradeKeys = await redis.keys(tradePattern);

    for (const key of tradeKeys) {
      const trade = await redis.get(key);

      if (!trade || !trade.setup) continue;

      const tradeWeek = getWeekKey(trade.closedAt || trade.createdAt);
      if (tradeWeek !== week) continue;

      if (!setupStats[trade.setup]) {
        setupStats[trade.setup] = {
          count: 0,
          wins: 0,
          losses: 0,
          totalR: 0,
          avgR: 0,
          maxWin: 0,
          maxLoss: 0
        };
      }

      const stat = setupStats[trade.setup];
      stat.count++;

      const netR = trade.netPnlR || trade.pnlPercent / 100;

      if (netR > 0) {
        stat.wins++;
      } else if (netR < 0) {
        stat.losses++;
      }

      stat.totalR += netR;
      stat.maxWin = Math.max(stat.maxWin, netR);
      stat.maxLoss = Math.min(stat.maxLoss, netR);
    }

    // Calculate averages
    for (const setup in setupStats) {
      const stat = setupStats[setup];
      stat.avgR = stat.count > 0 ? (stat.totalR / stat.count).toFixed(4) : 0;
      stat.winRate = stat.count > 0 ? ((stat.wins / stat.count) * 100).toFixed(1) : 0;
    }

    return {
      ok: true,
      week,
      setupPerformance: setupStats
    };
  } catch (err) {
    console.error('compareSetupPerformance error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Get week key from timestamp
 */
function getWeekKey(timestamp = 0) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const week = Math.ceil((date.getDate() + new Date(year, 0, 1).getDay()) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export default {
  recordCandidateAppearance,
  getWeeklyStats,
  getDailyStats,
  compareSetupPerformance,
  getWeekKey
};
