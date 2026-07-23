// ================= FILE: src/analyze/analyzeEngine.js =================
//
// CRITICAL ENGINE: Records outcomes, applies costs, updates family stats
// This is where NET-R learning happens
//

import { Redis } from '@upstash/redis';
import { createMicroStats, updateObservation, updateOutcome, refreshStats, rankMicros } from './scoring.js';
import { classifyMicroFamily } from './microFamilies.js';
import { applyCosts, calculateOutcome } from '../trade/costModel.js';
import { keys } from '../keys.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

/**
 * Record observation (position created)
 * CALLED BY: TradeSystem when position is created
 */
export async function recordObservation({
  candidateId = null,
  microFamilyId = null,
  setup = '',
  regime = '',
  confirmationProfile = '',
  symbol = '',
  entryPrice = 0,
  tp = null,
  sl = null,
  riskPct = 0.01,
  side = 'SHORT',
  timestamp = Date.now()
} = {}) {
  
  try {
    // Classify micro-family
    const classification = classifyMicroFamily({
      setup,
      regime,
      confirmationProfile
    });
    
    if (!classification.ok) {
      return {
        ok: false,
        reason: 'CLASSIFICATION_FAILED',
        details: classification
      };
    }
    
    const childId = classification.childId;
    const parentId = classification.parentId;
    const weekKey = 'SHORT_LIVE'; // Always use current week
    
    // Get or create stats
    const redisKey = keys.analyzeWeekMicros(weekKey);
    const allStats = await redis.get(redisKey) || {};
    
    if (!allStats[childId]) {
      allStats[childId] = createMicroStats({
        microFamilyId: childId,
        parentMicroFamilyId: parentId,
        setup: classification.setup,
        regime: classification.regime,
        confirmationProfile: classification.confirmation
      });
    }
    
    // Update with observation
    const stats = allStats[childId];
    updateObservation(stats, {
      symbol,
      candidateId,
      timestamp
    });
    
    // Save to Redis
    await redis.set(redisKey, allStats);
    
    return {
      ok: true,
      microFamilyId: childId,
      parentMicroFamilyId: parentId,
      observed: true
    };
    
  } catch (err) {
    console.error('recordObservation error:', err);
    return {
      ok: false,
      reason: 'REDIS_ERROR',
      error: err.message
    };
  }
}

/**
 * Record outcome (position closed)
 * CALLED BY: PositionEngine when position closes
 * 
 * CRITICAL: This is where costs are applied!
 */
export async function recordOutcome({
  microFamilyId = null,
  setup = '',
  regime = '',
  confirmationProfile = '',
  symbol = '',
  entryPrice = 0,
  exitPrice = 0,
  tp = null,
  sl = null,
  riskPct = 0.01,
  side = 'SHORT',
  hitTP = false,
  hitSL = false,
  durationHours = 1,
  executionMode = 'market',
  timestamp = Date.now()
} = {}) {
  
  try {
    // Classify if not provided
    let childId = microFamilyId;
    let parentId = null;
    
    if (!childId) {
      const classification = classifyMicroFamily({
        setup,
        regime,
        confirmationProfile
      });
      
      if (!classification.ok) {
        return {
          ok: false,
          reason: 'CLASSIFICATION_FAILED'
        };
      }
      
      childId = classification.childId;
      parentId = classification.parentId;
    }
    
    const weekKey = 'SHORT_LIVE';
    
    // Calculate outcome WITH COSTS applied
    const outcomeResult = calculateOutcome({
      side,
      entryPrice,
      exitPrice,
      tp,
      sl,
      risk: riskPct,
      hitTp: hitTP,
      hitSL,
      durationHours,
      executionMode
    });
    
    if (!outcomeResult.ok) {
      return {
        ok: false,
        reason: 'OUTCOME_CALCULATION_FAILED'
      };
    }
    
    // Get stats
    const redisKey = keys.analyzeWeekMicros(weekKey);
    const allStats = await redis.get(redisKey) || {};
    
    if (!allStats[childId]) {
      allStats[childId] = createMicroStats({
        microFamilyId: childId,
        parentMicroFamilyId: parentId
      });
    }
    
    const stats = allStats[childId];
    
    // Detect quality metrics
    const directSL = hitSL && exitPrice === sl;
    const nearTP = !hitTP && tp && Math.abs(exitPrice - tp) / tp < 0.005;
    const gaveBack = outcomeResult.netR > 0 && outcomeResult.pnlPct > riskPct && outcomeResult.pnlPct < 0;
    const nearTpThenLoss = nearTP && outcomeResult.netR < 0;
    
    // Update with outcome (using NET-R!)
    updateOutcome(stats, {
      netR: outcomeResult.netR,  // ← NET-R (after costs!)
      costR: outcomeResult.costR,
      grossR: outcomeResult.grossR,
      pnlPct: outcomeResult.pnlPct,
      directSL,
      hitSLDirectly: directSL,
      nearTP,
      nearTp,
      gaveBackAfterOneR: gaveBack,
      nearTpThenLoss,
      symbol,
      timestamp
    });
    
    // Recalculate all metrics
    refreshStats(stats);
    
    // Save to Redis
    await redis.set(redisKey, allStats);
    
    return {
      ok: true,
      microFamilyId: childId,
      netR: outcomeResult.netR,
      costR: outcomeResult.costR,
      pnlPct: outcomeResult.pnlPct,
      balancedScore: stats.balancedScore,
      completed: stats.completed
    };
    
  } catch (err) {
    console.error('recordOutcome error:', err);
    return {
      ok: false,
      reason: 'REDIS_ERROR',
      error: err.message
    };
  }
}

/**
 * Get all micro-family stats for current week
 */
export async function getAllMicroStats(weekKey = 'SHORT_LIVE') {
  try {
    const redisKey = keys.analyzeWeekMicros(weekKey);
    const stats = await redis.get(redisKey) || {};
    return {
      ok: true,
      weekKey,
      stats
    };
  } catch (err) {
    console.error('getAllMicroStats error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get single micro-family stats
 */
export async function getMicroStats(microFamilyId, weekKey = 'SHORT_LIVE') {
  try {
    const redisKey = keys.analyzeWeekMicros(weekKey);
    const allStats = await redis.get(redisKey) || {};
    const stats = allStats[microFamilyId];
    
    if (!stats) {
      return {
        ok: false,
        reason: 'NOT_FOUND'
      };
    }
    
    return {
      ok: true,
      microFamilyId,
      stats
    };
  } catch (err) {
    console.error('getMicroStats error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get ranked micro-families (for rotation selection)
 */
export async function getRankedMicros(weekKey = 'SHORT_LIVE', minCompleted = 20) {
  try {
    const redisKey = keys.analyzeWeekMicros(weekKey);
    const allStats = await redis.get(redisKey) || {};
    
    // Filter by minimum completed
    const filtered = {};
    for (const [id, stats] of Object.entries(allStats)) {
      if (stats.completed >= minCompleted) {
        filtered[id] = stats;
      }
    }
    
    // Rank by balancedScore
    const ranked = rankMicros(filtered, 'balanced');
    
    return {
      ok: true,
      weekKey,
      minCompleted,
      totalFamilies: Object.keys(allStats).length,
      qualifyingFamilies: ranked.length,
      ranked
    };
  } catch (err) {
    console.error('getRankedMicros error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Reset all stats (admin only)
 */
export async function resetAllStats(weekKey = 'SHORT_LIVE', confirm = false) {
  try {
    if (!confirm) {
      return {
        ok: false,
        reason: 'CONFIRM_REQUIRED'
      };
    }
    
    const redisKey = keys.analyzeWeekMicros(weekKey);
    await redis.del(redisKey);
    
    return {
      ok: true,
      message: 'All stats reset'
    };
  } catch (err) {
    console.error('resetAllStats error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Backup current week before rotation
 */
export async function backupWeekStats(weekKey = 'SHORT_LIVE') {
  try {
    const redisKey = keys.analyzeWeekMicros(weekKey);
    const stats = await redis.get(redisKey) || {};
    
    const backupKey = `${redisKey}:BACKUP:${Date.now()}`;
    await redis.set(backupKey, stats);
    
    return {
      ok: true,
      weekKey,
      backupKey,
      familiesBackedUp: Object.keys(stats).length
    };
  } catch (err) {
    console.error('backupWeekStats error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get analysis summary
 */
export async function getAnalysisSummary(weekKey = 'SHORT_LIVE') {
  try {
    const allStats = await getAllMicroStats(weekKey);
    if (!allStats.ok) {
      return allStats;
    }
    
    const stats = allStats.stats;
    const entries = Object.entries(stats);
    
    let totalCompleted = 0;
    let totalWins = 0;
    let totalR = 0;
    let maxScore = -Infinity;
    let minScore = Infinity;
    
    for (const [id, s] of entries) {
      totalCompleted += s.completed || 0;
      totalWins += s.wins || 0;
      totalR += s.totalR || 0;
      const score = s.balancedScore || 0;
      maxScore = Math.max(maxScore, score);
      minScore = Math.min(minScore, score);
    }
    
    const avgCompleted = entries.length > 0 ? totalCompleted / entries.length : 0;
    const avgWinrate = totalCompleted > 0 ? totalWins / totalCompleted : 0;
    const avgR = totalCompleted > 0 ? totalR / totalCompleted : 0;
    
    return {
      ok: true,
      weekKey,
      summary: {
        totalFamilies: entries.length,
        totalObservations: totalCompleted,
        totalWins,
        totalR: Number(totalR.toFixed(2)),
        avgCompleted: Number(avgCompleted.toFixed(1)),
        avgWinrate: Number(avgWinrate.toFixed(3)),
        avgR: Number(avgR.toFixed(2)),
        maxScore: Number(maxScore.toFixed(1)),
        minScore: Number(minScore.toFixed(1))
      }
    };
  } catch (err) {
    console.error('getAnalysisSummary error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export default {
  recordObservation,
  recordOutcome,
  getAllMicroStats,
  getMicroStats,
  getRankedMicros,
  resetAllStats,
  backupWeekStats,
  getAnalysisSummary
};
