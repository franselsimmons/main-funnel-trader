// ================= FILE: src/analyze/freezeWeekly.js =================
//
// Implementation: Close current week
// CALLED BY: api/analyze/weekly-freeze.js (cron Sunday 22:00 UTC)
//

import { Redis } from '@upstash/redis';
import { keys } from '../keys.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

/**
 * Freeze the current week
 * 
 * After this:
 *  - No more observations can be added to SHORT_LIVE
 *  - Stats become read-only
 *  - activateRotation will rank these stats
 *  - New week begins
 */
export async function freezeWeek() {
  try {
    const weekKey = 'SHORT_LIVE';
    const statsKey = keys.analyzeWeekMicros(weekKey);
    
    // Get current stats
    const stats = await redis.get(statsKey);
    
    if (!stats) {
      return {
        ok: false,
        reason: 'NO_STATS_TO_FREEZE',
        weekKey
      };
    }
    
    // Create frozen copy
    const freezeKey = `SHORT:ANALYZE:WEEK:${weekKey}:FROZEN:${Date.now()}`;
    await redis.set(freezeKey, stats);
    
    // Mark week as frozen
    const freezeMarkerKey = `${statsKey}:FROZEN`;
    await redis.set(freezeMarkerKey, {
      frozenAt: new Date().toISOString(),
      frozenTimestamp: Date.now(),
      familiesCount: Object.keys(stats).length
    });
    
    console.log(`✅ Week frozen: ${Object.keys(stats).length} families`);
    
    return {
      ok: true,
      weekKey,
      frozenKey: freezeKey,
      familiesCount: Object.keys(stats).length,
      timestamp: new Date().toISOString()
    };
    
  } catch (err) {
    console.error('freezeWeek error:', err);
    return {
      ok: false,
      reason: 'FREEZE_FAILED',
      error: err.message
    };
  }
}

export default {
  freezeWeek
};
