// ================= FILE: api/admin/trade.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, getJson } from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';

export default async function handler(req, res) {
  try {
    const redis = getDurableRedis();
    const [positions, runMeta, lastProcessed] = await Promise.all([
      getOpenPositions(),
      getJson(redis, KEYS.trade.runMeta, null),
      getJson(redis, KEYS.trade.lastProcessedSnapshot, null)
    ]);
    res.status(200).json({ positions, runMeta, lastProcessed });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
