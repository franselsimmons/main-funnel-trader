// ================= FILE: src/analyze/rotationEngine.js =================
//
// Weekly rotation: select top 42 micro-families based on balancedScore
// CALLED BY: activateRotation cron every Monday 00:00 UTC
//

import { Redis } from '@upstash/redis';
import { rankMicros } from './scoring.js';
import { keys } from '../keys.js';
import { getAllParentMicroFamilyIds } from './microFamilies.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

const MIN_COMPLETED_FOR_SELECTION = 20;
const TARGET_FAMILY_COUNT = 42;
const TARGET_PARENT_FAMILIES = 15;

/**
 * Build rotation from week stats
 * 
 * CALLED BY: activateRotation.js
 * 
 * Process:
 *  1. Read week stats
 *  2. Filter families with completed >= 20
 *  3. Rank by balancedScore
 *  4. Select top 42
 *  5. Organize into 15 parent families
 *  6. Return rotation object
 */
export async function buildRotationFromWeek(weekKey = 'SHORT_LIVE') {
  try {
    // Get all stats for week
    const statsKey = keys.analyzeWeekMicros(weekKey);
    const allStats = await redis.get(statsKey) || {};
    
    if (Object.keys(allStats).length === 0) {
      return {
        ok: false,
        reason: 'NO_STATS_AVAILABLE',
        weekKey
      };
    }
    
    // Filter families with minimum completed
    const qualified = {};
    let filtered = 0;
    
    for (const [id, stats] of Object.entries(allStats)) {
      if (stats.completed >= MIN_COMPLETED_FOR_SELECTION) {
        qualified[id] = stats;
      } else {
        filtered++;
      }
    }
    
    if (Object.keys(qualified).length === 0) {
      return {
        ok: false,
        reason: 'NO_QUALIFIED_FAMILIES',
        details: {
          weekKey,
          totalFamilies: Object.keys(allStats).length,
          minCompletedRequired: MIN_COMPLETED_FOR_SELECTION,
          filtered
        }
      };
    }
    
    // Rank by balancedScore
    const ranked = rankMicros(qualified, 'balanced');
    
    // Select top 42
    const selected = ranked.slice(0, TARGET_FAMILY_COUNT);
    
    // Organize by parent family
    const parentFamilies = getAllParentMicroFamilyIds();
    const byParent = {};
    
    for (const pf of parentFamilies) {
      byParent[pf] = [];
    }
    
    for (const child of selected) {
      const parts = child.id.split('_');
      const setup = parts[2];
      const regime = parts[3];
      const parentId = `MICRO_SHORT_${setup}_${regime}`;
      
      if (byParent[parentId]) {
        byParent[parentId].push(child.id);
      }
    }
    
    // Create rotation object
    const rotation = {
      rotationId: `rot_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      activatedAt: new Date().toISOString(),
      weekKey,
      activeMicroFamilyIds: selected.map(s => s.id),
      activeMacroFamilyIds: Object.keys(byParent).filter(k => byParent[k].length > 0),
      familiesByParent: byParent,
      stats: {
        totalFamiliesInWeek: Object.keys(allStats).length,
        qualifiedFamilies: Object.keys(qualified).length,
        selectedFamilies: selected.length,
        topScore: selected[0]?.balancedScore || 0,
        bottomScore: selected[selected.length - 1]?.balancedScore || 0,
        avgScore: selected.reduce((sum, s) => sum + (s.balancedScore || 0), 0) / selected.length
      }
    };
    
    return {
      ok: true,
      rotation
    };
    
  } catch (err) {
    console.error('buildRotationFromWeek error:', err);
    return {
      ok: false,
      reason: 'BUILD_FAILED',
      error: err.message
    };
  }
}

/**
 * Save rotation as ACTIVE
 * 
 * Replaces previous ROTATION:ACTIVE with new one
 * TradeSystem will use this for filtering
 */
export async function activateRotation(rotation = null) {
  try {
    if (!rotation || !rotation.rotationId) {
      return {
        ok: false,
        reason: 'INVALID_ROTATION'
      };
    }
    
    const activeKey = keys.rotationActive();
    
    // Save new rotation
    await redis.set(activeKey, rotation);
    
    // Also save historical record
    const historyKey = `${activeKey}:HISTORY:${rotation.rotationId}`;
    await redis.set(historyKey, rotation);
    
    return {
      ok: true,
      rotationId: rotation.rotationId,
      familiesSelected: rotation.activeMicroFamilyIds.length,
      message: 'Rotation activated'
    };
    
  } catch (err) {
    console.error('activateRotation error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get current active rotation
 * 
 * CALLED BY: TradeSystem to filter candidates
 */
export async function getActiveRotation() {
  try {
    const activeKey = keys.rotationActive();
    const rotation = await redis.get(activeKey);
    
    if (!rotation) {
      return {
        ok: false,
        reason: 'NO_ACTIVE_ROTATION'
      };
    }
    
    return {
      ok: true,
      rotation,
      familiesCount: rotation.activeMicroFamilyIds?.length || 0
    };
    
  } catch (err) {
    console.error('getActiveRotation error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Check if family is in current rotation
 * 
 * CALLED BY: TradeSystem validation
 */
export async function isFamilyActive(microFamilyId = '') {
  try {
    const result = await getActiveRotation();
    
    if (!result.ok) {
      return false;
    }
    
    return result.rotation.activeMicroFamilyIds.includes(microFamilyId);
    
  } catch (err) {
    console.error('isFamilyActive error:', err);
    return false;
  }
}

/**
 * Get rotation history
 */
export async function getRotationHistory(limit = 10) {
  try {
    const activeKey = keys.rotationActive();
    const historyPrefix = `${activeKey}:HISTORY:`;
    
    // This would need a SCAN operation to properly get history
    // For now, return empty
    return {
      ok: true,
      history: []
    };
    
  } catch (err) {
    console.error('getRotationHistory error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get rotation summary (for dashboard)
 */
export async function getRotationSummary() {
  try {
    const result = await getActiveRotation();
    
    if (!result.ok) {
      return result;
    }
    
    const rotation = result.rotation;
    const familyStats = rotation.activeMicroFamilyIds || [];
    
    return {
      ok: true,
      rotationId: rotation.rotationId,
      activatedAt: rotation.activatedAt,
      weekKey: rotation.weekKey,
      familiesCount: familyStats.length,
      parentFamiliesCount: (rotation.activeMacroFamilyIds || []).length,
      topScore: rotation.stats?.topScore || 0,
      bottomScore: rotation.stats?.bottomScore || 0,
      avgScore: rotation.stats?.avgScore || 0,
      familiesByParent: rotation.familiesByParent || {}
    };
    
  } catch (err) {
    console.error('getRotationSummary error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Reset rotation (admin only)
 */
export async function resetRotation(confirm = false) {
  try {
    if (!confirm) {
      return {
        ok: false,
        reason: 'CONFIRM_REQUIRED'
      };
    }
    
    const activeKey = keys.rotationActive();
    await redis.del(activeKey);
    
    return {
      ok: true,
      message: 'Rotation reset'
    };
    
  } catch (err) {
    console.error('resetRotation error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export default {
  buildRotationFromWeek,
  activateRotation,
  getActiveRotation,
  isFamilyActive,
  getRotationHistory,
  getRotationSummary,
  resetRotation,
  MIN_COMPLETED_FOR_SELECTION,
  TARGET_FAMILY_COUNT
};
