// ================= FILE: api/trade/run.js =================
//
// Cron handler for trade system
// Runs every 2 minutes: */2 * * * *
//

import { executeFullTradeCycle, checkTradingHaltConditions } from '../../src/trade/tradeSystem.js';
import { getRedis } from '../../src/redis.js';
import { keys } from '../../src/keys.js';
import { now } from '../../src/utils.js';
import { sendDiscordAlert } from '../../src/discord/discord.js';

export default async function handler(req, res) {
  try {
    // Only allow Vercel cron requests
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
    }

    console.log('🎯 Trade system cron triggered at', new Date().toISOString());

    const redis = getRedis();

    // 1. Check halt conditions
    console.log('🛑 Checking halt conditions...');
    const haltCheck = await checkTradingHaltConditions();

    if (haltCheck.shouldHalt) {
      console.warn('⚠️  Trading halted:', haltCheck.reasons);

      await sendDiscordAlert(
        `🛑 **TRADING HALTED**\nReasons: ${haltCheck.reasons.join(', ')}`,
        'HALT'
      ).catch(() => {});

      return res.status(200).json({
        ok: false,
        reason: 'TRADING_HALTED',
        reasons: haltCheck.reasons,
        timestamp: now()
      });
    }

    // 2. Execute full trade cycle
    console.log('🚀 Executing trade cycle...');
    const cycleResult = await executeFullTradeCycle();

    if (!cycleResult.ok) {
      console.warn('⚠️  Trade cycle failed:', cycleResult.reason);

      return res.status(200).json({
        ok: false,
        reason: cycleResult.reason,
        timestamp: now()
      });
    }

    // 3. Update trade stats
    const stats = {
      lastRunAt: now(),
      entriesAttempted: cycleResult.entries?.entriesAttempted || 0,
      entriesSuccessful: cycleResult.entries?.entriesSuccessful || 0,
      positionsChecked: cycleResult.management?.checked || 0,
      tpHits: cycleResult.management?.tpHits || 0,
      slHits: cycleResult.management?.slHits || 0,
      status: 'ACTIVE'
    };

    await redis.set(keys.tradeSystemStats(), stats);

    // 4. Send Discord update if significant activity
    const totalActivity = (stats.entriesSuccessful || 0) + (stats.tpHits || 0) + (stats.slHits || 0);

    if (totalActivity > 0) {
      const message = `
📈 **TRADE UPDATE**
✅ Entries: ${stats.entriesSuccessful}/${stats.entriesAttempted}
🎯 TP Hits: ${stats.tpHits}
🛑 SL Hits: ${stats.slHits}
📊 Positions Checked: ${stats.positionsChecked}
⏰ ${new Date().toISOString()}
      `.trim();

      await sendDiscordAlert(message, 'TRADE_UPDATE').catch(() => {});
    }

    console.log('✅ Trade cycle complete');

    return res.status(200).json({
      ok: true,
      entries: stats.entriesSuccessful,
      tpHits: stats.tpHits,
      slHits: stats.slHits,
      positionsChecked: stats.positionsChecked,
      timestamp: now()
    });

  } catch (err) {
    console.error('❌ Trade system cron error:', err);

    // Send error alert
    await sendDiscordAlert(
      `⚠️ Trade system cron failed: ${err.message}`,
      'ERROR'
    ).catch(() => {});

    return res.status(500).json({
      ok: false,
      reason: 'CRON_ERROR',
      error: err.message
    });
  }
}
