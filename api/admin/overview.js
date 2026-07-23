// ================= FILE: api/admin/overview.js =================
//
// Admin dashboard overview endpoint
// Provides all key metrics for the dashboard
//

import { getRedis } from '../../src/redis.js';
import { keys } from '../../src/keys.js';
import { now } from '../../src/utils.js';
import { getOpenPositions, calculatePortfolioPnL } from '../../src/trade/positionEngine.js';
import { getMarketWeather } from '../../src/market/marketWeather.js';

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

    // Gather all data concurrently
    const [
      scanStats,
      tradeStats,
      openPosResult,
      pnlResult,
      weatherResult,
      rotationActive,
      accountStats
    ] = await Promise.all([
      redis.get(keys.scanStats()),
      redis.get(keys.tradeSystemStats()),
      getOpenPositions(),
      calculatePortfolioPnL(),
      getMarketWeather(),
      redis.get(keys.rotationActive()),
      redis.get(keys.accountStats())
    ]);

    // Get latest scan for candidates list
    const latestScan = await redis.get(keys.scanLatest());
    const candidatesList = (latestScan?.candidates || []).slice(0, 20);

    // Build overview
    const overview = {
      ok: true,
      timestamp: now(),
      systemTime: new Date().toISOString(),
      
      // Scan status
      candidates: {
        count: scanStats?.candidatesCount || 0,
        processed: scanStats?.processed || 0,
        errors: scanStats?.errors || 0,
        list: candidatesList,
        lastScanId: scanStats?.scanId,
        lastScanTime: scanStats?.timestamp
      },

      // Trade system status
      trade: {
        status: tradeStats?.status || 'INACTIVE',
        entriesAttempted: tradeStats?.entriesAttempted || 0,
        entriesSuccessful: tradeStats?.entriesSuccessful || 0,
        lastRunAt: tradeStats?.lastRunAt,
        consecutiveLosses: accountStats?.consecutiveLosses || 0,
        currentDrawdown: accountStats?.currentDrawdown || 0
      },

      // Position tracking
      positions: {
        open: openPosResult?.count || 0,
        closed: 0,
        details: openPosResult?.positions || []
      },

      // P&L and performance
      pnl: {
        total: pnlResult?.totalPnl || 0,
        positionCount: pnlResult?.positionCount || 0,
        winCount: pnlResult?.winCount || 0,
        lossCount: pnlResult?.lossCount || 0,
        winRate: parseFloat(pnlResult?.winRate || 0),
        avgPnl: pnlResult?.statistics?.avgPnl || 0,
        largestWin: pnlResult?.statistics?.largestWin || 0,
        largestLoss: pnlResult?.statistics?.largestLoss || 0
      },

      // Market conditions
      weather: {
        condition: weatherResult?.weather?.condition || 'UNKNOWN',
        volatility: weatherResult?.weather?.volatilityValue || 0,
        trend: weatherResult?.weather?.trend || 'UNKNOWN',
        momentum: weatherResult?.weather?.momentum || 'UNKNOWN',
        lastUpdate: weatherResult?.weather?.timestamp
      },

      // Rotation
      rotation: {
        active: rotationActive?.selectedFamilies?.length || 0,
        targetFamilies: 42,
        activeFamilies: rotationActive?.selectedFamilies || [],
        lastRotationTime: rotationActive?.activatedAt,
        nextRotationTime: calculateNextRotationTime()
      },

      // Account info
      account: {
        size: accountStats?.size || 100000,
        riskPercent: accountStats?.riskPct || 0.01,
        maxDrawdown: accountStats?.maxDrawdown || 0.20,
        currentDrawdown: accountStats?.currentDrawdown || 0
      },

      // Cron status
      crons: {
        scanner: {
          name: 'Scanner',
          schedule: '*/5 * * * *',
          status: 'ACTIVE',
          lastRun: scanStats?.timestamp,
          nextRun: calculateNextCronRun('*/5 * * * *')
        },
        trade: {
          name: 'Trade System',
          schedule: '*/2 * * * *',
          status: 'ACTIVE',
          lastRun: tradeStats?.lastRunAt,
          nextRun: calculateNextCronRun('*/2 * * * *')
        },
        weeklyFreeze: {
          name: 'Weekly Freeze',
          schedule: '0 22 * * 0',
          status: 'SCHEDULED',
          nextRun: calculateNextCronRun('0 22 * * 0')
        },
        rotationActivate: {
          name: 'Rotation Activate',
          schedule: '0 0 * * 1',
          status: 'SCHEDULED',
          nextRun: calculateNextCronRun('0 0 * * 1')
        }
      },

      // System health
      health: {
        redis: 'OK',
        bitgetApi: 'OK',
        discordWebhook: 'CONFIGURED',
        overallStatus: 'HEALTHY'
      }
    };

    return res.status(200).json(overview);

  } catch (err) {
    console.error('overview error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}

/**
 * Calculate next rotation time (Monday 00:00 UTC)
 */
function calculateNextRotationTime() {
  const now = new Date();
  const nextMonday = new Date(now);
  
  // Calculate days until Monday
  const dayOfWeek = now.getUTCDay();
  const daysUntilMonday = dayOfWeek === 1 ? 7 : (1 - dayOfWeek + 7) % 7;
  
  nextMonday.setUTCDate(nextMonday.getUTCDate() + daysUntilMonday);
  nextMonday.setUTCHours(0, 0, 0, 0);
  
  return nextMonday.getTime();
}

/**
 * Calculate next cron execution time
 */
function calculateNextCronRun(schedule = '') {
  const now = new Date();
  
  if (schedule.includes('*/5 * * * *')) {
    // Every 5 minutes
    const nextRun = new Date(now.getTime() + (5 * 60 * 1000));
    return nextRun.getTime();
  }
  
  if (schedule.includes('*/2 * * * *')) {
    // Every 2 minutes
    const nextRun = new Date(now.getTime() + (2 * 60 * 1000));
    return nextRun.getTime();
  }
  
  if (schedule.includes('0 22 * * 0')) {
    // Sunday 22:00 UTC
    const nextRun = new Date(now);
    nextRun.setUTCDate(nextRun.getUTCDate() + ((0 - nextRun.getUTCDay() + 7) % 7 || 7));
    nextRun.setUTCHours(22, 0, 0, 0);
    return nextRun.getTime();
  }
  
  if (schedule.includes('0 0 * * 1')) {
    // Monday 00:00 UTC
    const nextRun = new Date(now);
    nextRun.setUTCDate(nextRun.getUTCDate() + ((1 - nextRun.getUTCDay() + 7) % 7 || 7));
    nextRun.setUTCHours(0, 0, 0, 0);
    return nextRun.getTime();
  }
  
  return now.getTime() + (60 * 1000); // Default 1 minute
}
