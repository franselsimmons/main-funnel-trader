// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getVolatileRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';

export default async function handler(req, res) {
  try {
    const result = await withRedisLock(getVolatileRedis(), KEYS.scan.lock, CONFIG.scanner.lockTtlSec, runScanner);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
