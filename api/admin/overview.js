// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs
} from '../../src/redis.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/src/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/src/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/src/rotationEngine.js';

function countMapOrArray(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const candidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  return {
    ...latestScan,
    candidatesCount: Number(
      latestScan.candidatesCount ??
      latestScan.count ??
      candidates.length ??
      0
    )
  };
}

async function safeRead(label, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    return {
      __error: true,
      label,
      message: error?.message || String(error),
      fallback
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      allowed: ['GET']
    });
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const weekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const [
      latestScanResult,
      tradeMetaResult,
      positionsResult,
      microsResult,
      prevMicrosResult,
      rotationResult,
      discordLogsResult
    ] = await Promise.all([
      safeRead('latestScan', () => getJson(volatile, KEYS.scan.latest, null), null),
      safeRead('tradeMeta', () => getJson(durable, KEYS.trade.runMeta, null), null),
      safeRead('openPositions', () => getOpenPositions(), []),
      safeRead('currentWeekMicros', () => getWeekMicros(weekKey), {}),
      safeRead('previousWeekMicros', () => getWeekMicros(previousWeekKey), {}),
      safeRead('rotationDashboard', () => getRotationDashboard(), { active: null, next: null }),
      safeRead('discordLogs', () => readJsonLogs(durable, KEYS.discord.logList, 10), [])
    ]);

    const latestScan = latestScanResult?.__error ? null : normalizeLatestScan(latestScanResult);
    const tradeMeta = tradeMetaResult?.__error ? null : tradeMetaResult;
    const positions = positionsResult?.__error || !Array.isArray(positionsResult) ? [] : positionsResult;
    const micros = microsResult?.__error ? {} : microsResult;
    const prevMicros = prevMicrosResult?.__error ? {} : prevMicrosResult;
    const rotation = rotationResult?.__error ? { active: null, next: null } : rotationResult;
    const discordLogs = discordLogsResult?.__error || !Array.isArray(discordLogsResult) ? [] : discordLogsResult;

    const warnings = [
      latestScanResult,
      tradeMetaResult,
      positionsResult,
      microsResult,
      prevMicrosResult,
      rotationResult,
      discordLogsResult
    ]
      .filter((item) => item?.__error)
      .map((item) => ({
        source: item.label,
        error: item.message
      }));

    return res.status(200).json({
      ok: true,

      weekKey,
      previousWeekKey,

      latestScan,
      tradeMeta,

      openPositions: positions.length,
      positionsCount: positions.length,

      currentWeekMicroFamilies: countMapOrArray(micros),
      previousWeekMicroFamilies: countMapOrArray(prevMicros),

      activeRotation: rotation?.active || null,
      nextRotation: rotation?.next || null,

      discordLogs,

      warnings,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}