// ================= FILE: api/admin/reset-rotation.js =================

import { getDurableRedis, pushJsonLog } from '../../src/redis.js';
import { KEYS } from '../../src/keys.js';
import { sendResetReport } from '../../src/discord/discord.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'POST_REQUIRED' });
    const redis = getDurableRedis();
    await redis.del(KEYS.analyze.activeRotation, KEYS.analyze.nextRotation, KEYS.analyze.rotationValidFrom);
    const report = { ok: true, type: 'RESET_ROTATION', deleted: { activeRotation: 1, nextRotation: 1 }, resetAt: Date.now() };
    await pushJsonLog(redis, KEYS.reset.logList, report, 100);
    await sendResetReport(report).catch(() => null);
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
