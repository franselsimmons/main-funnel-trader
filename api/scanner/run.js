// ================= FILE: api/scanner/run.js =================
//
// Cron handler for scanner
// Runs every 5 minutes: */5 * * * *
//

import { scanForCandidates } from '../../src/market/scanner.js';
import { assessMarketWeather, saveWeatherHistory } from '../../src/market/marketWeather.js';
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

    console.log('🔍 Scanner cron triggered at', new Date().toISOString());

    const redis = getRedis();

    // 1. Assess market weather
    console.log('📊 Assessing market weather...');
    const mockMarketData = {
      prices: Array(30).fill(50000).map((p, i) => p + (Math.random() - 0.5) * 1000),
      volumes: Array(30).fill(1000000).map(v => v + Math.random() * 100000),
      highs: Array(30).fill(50500),
      lows: Array(30).fill(49500)
    };

    const weatherResult = await assessMarketWeather(mockMarketData);
    if (weatherResult.ok) {
      await saveWeatherHistory(weatherResult.weather);
      console.log('✅ Weather:', weatherResult.weather.condition);
    }

    // 2. Run scanner
    console.log('🔎 Running candidate scan...');
    const scanResult = await scanForCandidates();

    if (!scanResult.ok) {
      console.warn('⚠️  Scan failed:', scanResult.reason);
      return res.status(200).json({
        ok: false,
        reason: scanResult.reason,
        timestamp: now()
      });
    }

    // 3. Save scan stats
    const scanStats = {
      scanId: scanResult.snapshotId,
      candidatesCount: scanResult.candidatesCount,
      processed: scanResult.processed,
      errors: scanResult.errors,
      timestamp: now(),
      weather: weatherResult.ok ? weatherResult.weather.condition : 'UNKNOWN'
    };

    await redis.set(keys.scanStats(), scanStats);

    // 4. Send Discord alert if significant candidates found
    if (scanResult.candidatesCount > 5) {
      const message = `
🚀 **SCAN ALERT** 
📊 Found ${scanResult.candidatesCount} candidates from ${scanResult.processed} symbols
🎯 Scan ID: ${scanResult.snapshotId}
🌤️  Market: ${weatherResult.ok ? weatherResult.weather.condition : 'UNKNOWN'}
⏰ ${new Date().toISOString()}
      `.trim();

      await sendDiscordAlert(message, 'SCAN_RESULT');
    }

    console.log('✅ Scanner run complete');

    return res.status(200).json({
      ok: true,
      candidatesCount: scanResult.candidatesCount,
      scanId: scanResult.snapshotId,
      timestamp: now()
    });

  } catch (err) {
    console.error('❌ Scanner cron error:', err);

    // Send error alert
    await sendDiscordAlert(
      `⚠️ Scanner cron failed: ${err.message}`,
      'ERROR'
    ).catch(() => {});

    return res.status(500).json({
      ok: false,
      reason: 'CRON_ERROR',
      error: err.message
    });
  }
}
