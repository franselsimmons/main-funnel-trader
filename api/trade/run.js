// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';

export default async function handler(req, res) {
  try {
    const forceProcessSnapshot = req.query?.force === 'true' || req.body?.forceProcessSnapshot === true;
    const result = await withRedisLock(getDurableRedis(), KEYS.trade.lock, CONFIG.trade.lockTtlSec, () => runTradeSystem({ forceProcessSnapshot }));
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
