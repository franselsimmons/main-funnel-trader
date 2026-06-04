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
  getPreviousIsoWeekKey,
  safeNumber
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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    return (
      value.snapshotId ||
      value.id ||
      value.latestSnapshotId ||
      value.scanId ||
      null
    );
  }

  return null;
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const candidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const createdAt = safeNumber(
    latestScan.createdAt ||
    latestScan.ts ||
    latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  return {
    ...latestScan,

    snapshotId: extractSnapshotId(latestScan),

    createdAt: createdAt || null,
    snapshotAgeSec,

    candidatesCount: safeNumber(
      latestScan.candidatesCount ??
      latestScan.count ??
      candidates.length,
      0
    ),

    topSymbols: Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols
      : candidates.slice(0, 20).map((row) => row.symbol).filter(Boolean)
  };
}

function normalizeRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const microFamilyIds = Array.isArray(rotation.microFamilyIds)
    ? rotation.microFamilyIds.filter(Boolean)
    : [];

  const microFamilies = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  return {
    ...rotation,
    microFamilyIds,
    microFamilies,
    count: microFamilyIds.length || microFamilies.length
  };
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},
      realExits: 0,
      shadowExits: 0,
      skippedNewEntries: null,
      reason: null
    };
  }

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,
    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,
    actionCounts: tradeMeta.actionCounts || {},
    realExits: Array.isArray(tradeMeta.realExits) ? tradeMeta.realExits.length : 0,
    shadowExits: Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits.length : 0,
    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || null,
    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null
  };
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value
    };
  } catch (error) {
    return {
      ok: false,
      label,
      value: fallback,
      error: error?.message || String(error)
    };
  }
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
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
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

    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);

    const positions = asArray(positionsRead.value);
    const currentMicros = currentMicrosRead.value || {};
    const previousMicros = previousMicrosRead.value || {};

    const rotationDashboard = rotationRead.value || {};
    const activeRotation = normalizeRotation(
      rotationDashboard.active ||
      rotationDashboard.activeRotation ||
      null
    );

    const nextRotation = normalizeRotation(
      rotationDashboard.next ||
      rotationDashboard.nextRotation ||
      null
    );

    const discordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const warnings = [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    return res.status(200).json({
      ok: true,

      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,

      latestScan,
      latestScannerSnapshotId: extractSnapshotId(latestScan),

      scannerCandidates: latestScan?.candidatesCount || 0,

      tradeMeta,
      tradeSummary,

      openPositions: positions.length,
      positionsCount: positions.length,
      positions,

      currentWeekMicroFamilies: countMapOrArray(currentMicros),
      previousWeekMicroFamilies: countMapOrArray(previousMicros),

      activeRotation,
      nextRotation,

      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,

      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,

      rotationDashboard,

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