// ================= FILE: src/analyze/weeklyCandidates.js =================
// Weekly candidate tracking

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, getWeekKey } from '../utils.js';

export async function recordWeeklyCandidates(candidates = []) {
  try {
    const redis = getRedis();
    const weekKey = getWeekKey();
    const key = keys.weeklyCandidates(weekKey);

    const data = {
      weekKey,
      candidates: candidates.map(c => ({
        symbol: c.symbol,
        setup: c.setup,
        regime: c.regime,
        confirmation: c.confirmationProfile,
        timestamp: c.timestamp
      })),
      count: candidates.length,
      recordedAt: now()
    };

    await redis.set(key, data);

    return { ok: true, weekKey, recorded: candidates.length };

  } catch (err) {
    console.error('recordWeeklyCandidates error:', err);
    return { ok: false, error: err.message };
  }
}

export async function getWeeklyCandidates(weekKey = '') {
  try {
    const redis = getRedis();
    const key = keys.weeklyCandidates(weekKey || getWeekKey());
    const data = await redis.get(key);

    if (!data) {
      return { ok: false, reason: 'NO_DATA', candidates: [] };
    }

    return { ok: true, weekKey: data.weekKey, candidates: data.candidates, count: data.count };

  } catch (err) {
    console.error('getWeeklyCandidates error:', err);
    return { ok: false, error: err.message, candidates: [] };
  }
}

export default { recordWeeklyCandidates, getWeeklyCandidates };
