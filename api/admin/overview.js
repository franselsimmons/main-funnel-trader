// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, getVolatileRedis, getJson, readJsonLogs } from '../../src/redis.js';
import { getIsoWeekKey, getPreviousIsoWeekKey } from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

export default async function handler(req, res) {
  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();
    const weekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();
    const [latestScan, tradeMeta, positions, micros, prevMicros, rotation, discordLogs] = await Promise.all([
      getJson(volatile, KEYS.scan.latest, null),
      getJson(durable, KEYS.trade.runMeta, null),
      getOpenPositions(),
      getWeekMicros(weekKey),
      getWeekMicros(previousWeekKey),
      getRotationDashboard(),
      readJsonLogs(durable, KEYS.discord.logList, 10)
    ]);

    res.status(200).json({
      weekKey,
      previousWeekKey,
      latestScan,
      tradeMeta,
      openPositions: positions.length,
      currentWeekMicroFamilies: Object.keys(micros || {}).length,
      previousWeekMicroFamilies: Object.keys(prevMicros || {}).length,
      activeRotation: rotation.active,
      nextRotation: rotation.next,
      discordLogs
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
