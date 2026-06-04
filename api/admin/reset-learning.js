// ================= FILE: api/admin/reset-learning.js =================

import { getDurableRedis, delPattern, pushJsonLog } from '../../src/redis.js';
import { KEYS } from '../../src/keys.js';
import { sendResetReport } from '../../src/discord/discord.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'POST_REQUIRED' });
    const redis = getDurableRedis();
    const deleted = {
      weeks: await delPattern(redis, 'ANALYZE:WEEK:*', 10000),
      obs: await delPattern(redis, 'ANALYZE:OBS:LAST:*', 10000),
      shadowOpen: await delPattern(redis, 'ANALYZE:SHADOW:OPEN:*', 10000),
      shadowLast: await delPattern(redis, 'ANALYZE:SHADOW:LAST:*', 10000)
    };
    const report = { ok: true, type: 'RESET_LEARNING', deleted, resetAt: Date.now() };
    await pushJsonLog(redis, KEYS.reset.logList, report, 100);
    await sendResetReport(report).catch(() => null);
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
