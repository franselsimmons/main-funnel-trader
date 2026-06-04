// ================= FILE: api/admin/trade.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, getVolatileRedis, getJson } from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/src/positionEngine.js';

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === 'object') {
    return Object.values(value);
  }

  return [];
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSide(side) {
  const value = String(side || '').toLowerCase();

  if (value === 'bull' || value === 'long' || value === 'buy') return 'bull';
  if (value === 'bear' || value === 'short' || value === 'sell') return 'bear';

  return value || 'unknown';
}

function normalizePosition(position) {
  const entry = toNumber(position.entry ?? position.entryPrice);
  const sl = toNumber(position.sl ?? position.stopLoss);
  const tp = toNumber(position.tp ?? position.takeProfit);
  const currentPrice = toNumber(position.currentPrice ?? position.markPrice ?? position.price, null);

  const side = normalizeSide(position.side);
  const risk =
    side === 'bull'
      ? Math.abs(entry - sl)
      : Math.abs(sl - entry);

  const reward =
    side === 'bull'
      ? Math.abs(tp - entry)
      : Math.abs(entry - tp);

  const rr = toNumber(position.rr, risk > 0 ? reward / risk : 0);

  const openedAt = toNumber(position.openedAt ?? position.createdAt ?? position.ts, null);
  const ageSec = openedAt
    ? Math.max(0, Math.floor((Date.now() - openedAt) / 1000))
    : null;

  return {
    ...position,

    symbol: position.symbol || position.baseSymbol || null,
    contractSymbol: position.contractSymbol || null,
    side,

    entry,
    sl,
    tp,
    rr,

    currentPrice,
    currentR: toNumber(position.currentR),
    mfeR: toNumber(position.mfeR),
    maeR: toNumber(position.maeR),

    familyId: position.familyId || null,
    microFamilyId: position.microFamilyId || null,

    openedAt,
    ageSec,

    riskDistance: risk,
    rewardDistance: reward,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),
    breakEvenArmed: Boolean(position.breakEvenArmed),
    trailingActive: Boolean(position.trailingActive)
  };
}

function buildPositionStats(positions) {
  const bull = positions.filter((p) => p.side === 'bull');
  const bear = positions.filter((p) => p.side === 'bear');

  const totalCurrentR = positions.reduce((sum, p) => {
    return sum + toNumber(p.currentR);
  }, 0);

  const totalMfeR = positions.reduce((sum, p) => {
    return sum + toNumber(p.mfeR);
  }, 0);

  const totalMaeR = positions.reduce((sum, p) => {
    return sum + toNumber(p.maeR);
  }, 0);

  const profitable = positions.filter((p) => toNumber(p.currentR) > 0);
  const losing = positions.filter((p) => toNumber(p.currentR) < 0);

  return {
    openPositions: positions.length,
    bullPositions: bull.length,
    bearPositions: bear.length,

    profitablePositions: profitable.length,
    losingPositions: losing.length,

    totalCurrentR,
    avgCurrentR: positions.length ? totalCurrentR / positions.length : 0,

    totalMfeR,
    avgMfeR: positions.length ? totalMfeR / positions.length : 0,

    totalMaeR,
    avgMaeR: positions.length ? totalMaeR / positions.length : 0,

    reachedHalfR: positions.filter((p) => p.reachedHalfR).length,
    reachedOneR: positions.filter((p) => p.reachedOneR).length,
    nearTpSeen: positions.filter((p) => p.nearTpSeen).length,

    breakEvenArmed: positions.filter((p) => p.breakEvenArmed).length,
    trailingActive: positions.filter((p) => p.trailingActive).length
  };
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

function normalizeLastProcessed(lastProcessed) {
  const snapshotId = extractSnapshotId(lastProcessed);

  if (!lastProcessed) {
    return {
      snapshotId: null,
      raw: null
    };
  }

  if (typeof lastProcessed === 'string') {
    return {
      snapshotId: lastProcessed,
      raw: lastProcessed
    };
  }

  return {
    ...lastProcessed,
    snapshotId,
    raw: lastProcessed
  };
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

    const [
      rawPositions,
      runMeta,
      lastProcessed,
      latestScan
    ] = await Promise.all([
      getOpenPositions(),
      getJson(durable, KEYS.trade.runMeta, null),
      getJson(durable, KEYS.trade.lastProcessedSnapshot, null),
      getJson(volatile, KEYS.scan.latest, null)
    ]);

    const positions = asArray(rawPositions).map(normalizePosition);
    const stats = buildPositionStats(positions);

    const normalizedLastProcessed = normalizeLastProcessed(lastProcessed);
    const latestScannerSnapshotId = extractSnapshotId(latestScan);

    const scannerAndTradeInSync =
      Boolean(latestScannerSnapshotId) &&
      Boolean(normalizedLastProcessed.snapshotId) &&
      latestScannerSnapshotId === normalizedLastProcessed.snapshotId;

    return res.status(200).json({
      ok: true,

      positions,
      openPositions: positions,
      positionsCount: positions.length,

      stats,

      runMeta,
      lastProcessed: normalizedLastProcessed,

      latestScan,
      latestScannerSnapshotId,
      scannerAndTradeInSync,

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