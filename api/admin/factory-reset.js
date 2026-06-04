// ================= FILE: api/admin/factory-reset.js =================

import { CONFIG } from '../../src/config.js';
import { getDurableRedis, getVolatileRedis, delPattern, pushJsonLog } from '../../src/redis.js';
import { KEYS } from '../../src/keys.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { sendResetReport } from '../../src/discord/discord.js';

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'POST_REQUIRED' });
    const body = await readBody(req);
    const confirmed = body.confirm === CONFIG.reset.confirmText;
    const force = body.force === true;
    const openPositions = await getOpenPositions();

    if (!confirmed) {
      return res.status(400).json({ ok: false, blocked: true, reason: 'CONFIRMATION_REQUIRED', required: CONFIG.reset.confirmText });
    }

    if (openPositions.length > 0 && !force) {
      return res.status(409).json({ ok: false, blocked: true, reason: 'OPEN_POSITIONS_EXIST', count: openPositions.length });
    }

    const durable = getDurableRedis();
    const volatile = getVolatileRedis();
    const deleted = {
      scanSnapshots: await delPattern(volatile, 'SCAN:SNAPSHOT:*', 10000),
      scanLatest: await volatile.del(KEYS.scan.latest),
      tradeOpen: await delPattern(durable, 'TRADE:OPEN:*', 10000),
      tradeLastProcessed: await durable.del(KEYS.trade.lastProcessedSnapshot),
      tradeMeta: await durable.del(KEYS.trade.runMeta),
      analyzeWeeks: await delPattern(durable, 'ANALYZE:WEEK:*', 10000),
      analyzeObs: await delPattern(durable, 'ANALYZE:OBS:LAST:*', 10000),
      analyzeShadowOpen: await delPattern(durable, 'ANALYZE:SHADOW:OPEN:*', 10000),
      analyzeShadowLast: await delPattern(durable, 'ANALYZE:SHADOW:LAST:*', 10000),
      activeRotation: await durable.del(KEYS.analyze.activeRotation),
      nextRotation: await durable.del(KEYS.analyze.nextRotation),
      rotationValidFrom: await durable.del(KEYS.analyze.rotationValidFrom),
      liveCache: await delPattern(volatile, 'LIVE:CACHE:*', 10000)
    };

    const report = {
      ok: true,
      type: 'FACTORY_RESET',
      force,
      openPositionsCount: openPositions.length,
      deleted,
      resetAt: Date.now()
    };
    await pushJsonLog(durable, KEYS.reset.logList, report, 100);
    await sendResetReport(report).catch(() => null);
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
