// ================= FILE: api/admin/discord-logs.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, readJsonLogs } from '../../src/redis.js';

export default async function handler(req, res) {
  try {
    const limit = Number(req.query?.limit || 100);
    const logs = await readJsonLogs(getDurableRedis(), KEYS.discord.logList, limit);
    res.status(200).json({ logs });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
