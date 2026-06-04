// ================= FILE: api/analyze/activate-rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getDurableRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { activateNextRotation } from '../../src/analyze/rotationEngine.js';

export default async function handler(req, res) {
  try {
    const result = await withRedisLock(getDurableRedis(), KEYS.analyze.activateLock, CONFIG.analyze.activateLockTtlSec, activateNextRotation);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
