// ================= FILE: api/admin/discord-logs.js =================
//
// Admin endpoint to view Discord alert logs
// GET endpoint
//

import { getRedis } from '../../src/redis.js';
import { keys } from '../../src/keys.js';
import { now } from '../../src/utils.js';

export default async function handler(req, res) {
  try {
    // Verify admin access
    const token = req.headers['x-admin-token'];
    if (token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
    }

    // Only GET
    if (req.method !== 'GET') {
      return res.status(405).json({ ok: false, reason: 'METHOD_NOT_ALLOWED' });
    }

    const redis = getRedis();

    // Query parameters
    const limit = parseInt(req.query.limit || '100', 10);
    const startTime = parseInt(req.query.startTime || Date.now() - (24 * 60 * 60 * 1000), 10);
    const endTime = parseInt(req.query.endTime || now(), 10);
    const alertType = req.query.alertType || 'ALL'; // SCAN_RESULT, TRADE_UPDATE, ERROR, HALT, ALL

    // Fetch logs
    const logsKey = 'DISCORD:LOGS:*';
    const logKeys = await redis.keys(logsKey);

    const logs = [];

    for (const key of logKeys) {
      const log = await redis.get(key);
      if (!log) continue;

      // Filter by time range
      if (log.timestamp < startTime || log.timestamp > endTime) {
        continue;
      }

      // Filter by type
      if (alertType !== 'ALL' && log.type !== alertType) {
        continue;
      }

      logs.push(log);
    }

    // Sort by timestamp descending
    logs.sort((a, b) => b.timestamp - a.timestamp);

    // Limit results
    const limited = logs.slice(0, limit);

    // Group by type
    const byType = {};
    for (const log of limited) {
      if (!byType[log.type]) {
        byType[log.type] = [];
      }
      byType[log.type].push(log);
    }

    return res.status(200).json({
      ok: true,
      totalLogs: logs.length,
      returned: limited.length,
      logs: limited,
      byType,
      timeRange: {
        startTime,
        endTime,
        durationHours: (endTime - startTime) / (60 * 60 * 1000)
      }
    });

  } catch (err) {
    console.error('discord-logs error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
