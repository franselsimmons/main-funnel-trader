// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import { getVolatileRedis, getJson } from '../../src/redis.js';

export default async function handler(req, res) {
  try {
    const redis = getVolatileRedis();
    const latest = await getJson(redis, KEYS.scan.latest, null);
    const snapshot = latest?.snapshotId ? await getJson(redis, KEYS.scan.snapshot(latest.snapshotId), null) : null;
    res.status(200).json({ latest, snapshot });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
