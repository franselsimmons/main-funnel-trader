// ================= FILE: src/analyze/freezeWeekly.js =================
// Weekly freeze (closes all open trades, calculates stats)

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, getWeekKey } from '../utils.js';
import { analyzeAllFamilies } from './analyzeEngine.js';

export async function freezeWeekly() {
  try {
    const redis = getRedis();
    const weekKey = getWeekKey();

    // Close all open positions for this week
    const openPositionPattern = 'SHORT:POSITION:OPEN:*';
    const openKeys = await redis.keys(openPositionPattern);

    let closed = 0;
    for (const key of openKeys) {
      const position = await redis.get(key);
      if (position && position.weekKey === weekKey) {
        position.closedAt = now();
        position.closeReason = 'WEEKLY_FREEZE';
        await redis.set(key, position);
        closed++;
      }
    }

    // Analyze all families for this week
    const analysisResult = await analyzeAllFamilies();

    // Calculate week stats
    const stats = {
      weekKey,
      frozenAt: now(),
      closedPositions: closed,
      familiesAnalyzed: analysisResult.analyzed || 0,
      topFamilies: analysisResult.topFamilies || []
    };

    await redis.set(keys.weeklyFreeze(weekKey), stats);

    return {
      ok: true,
      weekKey,
      closedPositions: closed,
      familiesAnalyzed: analysisResult.analyzed,
      stats
    };

  } catch (err) {
    console.error('freezeWeekly error:', err);
    return { ok: false, error: err.message };
  }
}

export default { freezeWeekly };
