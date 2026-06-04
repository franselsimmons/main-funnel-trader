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
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

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

function unwrap(result, fallback) {
  if (result?.__error) return fallback;
  return result ?? fallback;
}

function collectWarnings(results = []) {
  return results
    .filter((item) => item?.__error)
    .map((item) => ({
      source: item.label,
      error: item.message
    }));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
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
      safeRead(
        'latestScan',
        () => getJson(volatile, KEYS.scan.latest, null),
        null
      ),
      safeRead(
        'tradeMeta',
        () => getJson(durable, KEYS.trade.runMeta, null),
        null
      ),
      safeRead(
        'openPositions',
        () => getOpenPositions(),
        []
      ),
      safeRead(
        'currentWeekMicros',
        () => getWeekMicros(weekKey),
        {}
      ),
      safeRead(
        'previousWeekMicros',
        () => getWeekMicros(previousWeekKey),
        {}
      ),
      safeRead(
        'rotationDashboard',
        () => getRotationDashboard(),
        {
          active: null,
          next: null,
          validFrom: null,
          activeRows: [],
          nextRows: [],
          activeCount: 0,
          nextCount: 0
        }
      ),
      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, KEYS.discord.logList, 10),
        []
      )
    ]);

    const latestScan = normalizeLatestScan(
      unwrap(latestScanResult, null)
    );

    const tradeMeta = unwrap(tradeMetaResult, null);

    const positionsRaw = unwrap(positionsResult, []);
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];

    const micros = unwrap(microsResult, {});
    const prevMicros = unwrap(prevMicrosResult, {});

    const rotation = unwrap(rotationResult, {
      active: null,
      next: null,
      validFrom: null,
      activeRows: [],
      nextRows: [],
      activeCount: 0,
      nextCount: 0
    });

    const discordLogsRaw = unwrap(discordLogsResult, []);
    const discordLogs = Array.isArray(discordLogsRaw) ? discordLogsRaw : [];

    const warnings = collectWarnings([
      latestScanResult,
      tradeMetaResult,
      positionsResult,
      microsResult,
      prevMicrosResult,
      rotationResult,
      discordLogsResult
    ]);

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
      rotationValidFrom: rotation?.validFrom || null,

      activeRotationCount:
        rotation?.activeCount ??
        rotation?.active?.microFamilyIds?.length ??
        0,

      nextRotationCount:
        rotation?.nextCount ??
        rotation?.next?.microFamilyIds?.length ??
        0,

      activeRows: rotation?.activeRows || [],
      nextRows: rotation?.nextRows || [],

      discordLogs,

      warnings,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}