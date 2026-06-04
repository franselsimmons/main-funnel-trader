// ================= FILE: api/admin/trade.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import {
  safeNumber,
  sideToTradeSide,
  normalizeBaseSymbol,
  normalizeContractSymbol
} from '../../src/utils.js';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === 'object') {
    return Object.values(value);
  }

  return [];
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function normalizeDashboardSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function calcAgeSec(ts) {
  const value = num(ts, 0);

  if (value <= 0) return null;

  return Math.max(0, Math.floor((Date.now() - value) / 1000));
}

function normalizePosition(position = {}) {
  const symbol = normalizeBaseSymbol(
    position.symbol ||
    position.baseSymbol ||
    position.contractSymbol
  );

  const contractSymbol = normalizeContractSymbol(
    position.contractSymbol ||
    position.symbol ||
    symbol
  );

  const side = normalizeDashboardSide(position.side);

  const entry = num(position.entry ?? position.entryPrice, 0);
  const sl = num(position.sl ?? position.stopLoss, 0);
  const initialSl = num(position.initialSl ?? position.initialStopLoss ?? sl, sl);
  const tp = num(position.tp ?? position.takeProfit, 0);
  const currentPrice = num(
    position.lastPrice ??
    position.currentPrice ??
    position.markPrice ??
    position.price,
    null
  );

  const riskDistance = entry > 0 && initialSl > 0
    ? Math.abs(entry - initialSl)
    : 0;

  const rewardDistance = entry > 0 && tp > 0
    ? Math.abs(tp - entry)
    : 0;

  const rr = num(
    position.rr,
    riskDistance > 0 ? rewardDistance / riskDistance : 0
  );

  const openedAt = num(
    position.openedAt ??
    position.createdAt ??
    position.ts,
    null
  );

  const currentR = num(position.currentR, 0);
  const mfeR = num(position.mfeR, 0);
  const maeR = num(position.maeR, 0);

  return {
    ...position,

    symbol: symbol || position.symbol || null,
    baseSymbol: symbol || position.baseSymbol || null,
    contractSymbol,

    side,

    entry,
    sl,
    initialSl,
    tp,
    rr: round(rr, 4),

    currentPrice,
    currentR: round(currentR, 4),
    mfeR: round(mfeR, 4),
    maeR: round(maeR, 4),

    riskPct: round(position.riskPct, 6),
    riskFraction: round(position.riskFraction, 6),

    familyId: position.familyId || null,
    microFamilyId: position.microFamilyId || null,

    activeRotationId: position.activeRotationId || null,

    openedAt,
    ageSec: calcAgeSec(openedAt),

    riskDistance,
    rewardDistance,

    ticksObserved: num(position.ticksObserved, 0),
    favorableTicks: num(position.favorableTicks, 0),
    adverseTicks: num(position.adverseTicks, 0),

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: num(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    liveManaged: Boolean(position.liveManaged),
    beLiveApplied: Boolean(position.beLiveApplied),
    trailLiveApplied: Boolean(position.trailLiveApplied),
    slManagementSource: position.slManagementSource || null,

    // Backwards-compatible namen voor admin.html / oude dashboard code.
    breakEvenArmed: Boolean(position.beArmed || position.breakEvenArmed),
    trailingActive: Boolean(
      position.trailLiveApplied ||
      position.trailingActive ||
      String(position.slManagementSource || '').toUpperCase() === 'TRAIL'
    )
  };
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + num(selector(row), 0), 0);
}

function buildPositionStats(positions = []) {
  const bull = positions.filter((position) => position.side === 'bull');
  const bear = positions.filter((position) => position.side === 'bear');
  const unknown = positions.filter((position) => position.side === 'unknown');

  const totalCurrentR = sum(positions, (p) => p.currentR);
  const totalMfeR = sum(positions, (p) => p.mfeR);
  const totalMaeR = sum(positions, (p) => p.maeR);
  const totalRiskFraction = sum(positions, (p) => p.riskFraction);

  const profitable = positions.filter((p) => num(p.currentR, 0) > 0);
  const losing = positions.filter((p) => num(p.currentR, 0) < 0);

  const longRiskFraction = sum(bull, (p) => p.riskFraction);
  const shortRiskFraction = sum(bear, (p) => p.riskFraction);

  return {
    openPositions: positions.length,

    bullPositions: bull.length,
    bearPositions: bear.length,
    unknownSidePositions: unknown.length,

    longPositions: bull.length,
    shortPositions: bear.length,

    profitablePositions: profitable.length,
    losingPositions: losing.length,
    flatPositions: positions.length - profitable.length - losing.length,

    totalCurrentR: round(totalCurrentR, 4),
    avgCurrentR: positions.length ? round(totalCurrentR / positions.length, 4) : 0,

    totalMfeR: round(totalMfeR, 4),
    avgMfeR: positions.length ? round(totalMfeR / positions.length, 4) : 0,

    totalMaeR: round(totalMaeR, 4),
    avgMaeR: positions.length ? round(totalMaeR / positions.length, 4) : 0,

    totalRiskFraction: round(totalRiskFraction, 6),
    longRiskFraction: round(longRiskFraction, 6),
    shortRiskFraction: round(shortRiskFraction, 6),

    reachedHalfR: positions.filter((p) => p.reachedHalfR).length,
    reachedOneR: positions.filter((p) => p.reachedOneR).length,
    nearTpSeen: positions.filter((p) => p.nearTpSeen).length,

    beArmed: positions.filter((p) => p.beArmed).length,
    beWouldExit: positions.filter((p) => p.beWouldExit).length,

    breakEvenArmed: positions.filter((p) => p.breakEvenArmed).length,
    trailingActive: positions.filter((p) => p.trailingActive).length,

    gaveBackAfterHalfR: positions.filter((p) => p.gaveBackAfterHalfR).length,
    gaveBackAfterOneR: positions.filter((p) => p.gaveBackAfterOneR).length,
    nearTpThenLoss: positions.filter((p) => p.nearTpThenLoss).length
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

function normalizeRunMeta(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;

  return {
    ...runMeta,
    actionCounts: runMeta.actionCounts || {},
    actionsCount: Array.isArray(runMeta.actions)
      ? runMeta.actions.length
      : num(runMeta.actionsCount, 0),
    realExitsCount: Array.isArray(runMeta.realExits)
      ? runMeta.realExits.length
      : num(runMeta.realExitsCount, 0),
    shadowExitsCount: Array.isArray(runMeta.shadowExits)
      ? runMeta.shadowExits.length
      : num(runMeta.shadowExitsCount, 0)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const [
      rawPositions,
      runMetaRaw,
      lastProcessedRaw,
      latestScan
    ] = await Promise.all([
      getOpenPositions(),
      getJson(durable, KEYS.trade.runMeta, null),
      getJson(durable, KEYS.trade.lastProcessedSnapshot, null),
      getJson(volatile, KEYS.scan.latest, null)
    ]);

    const positions = asArray(rawPositions).map(normalizePosition);
    const stats = buildPositionStats(positions);

    const runMeta = normalizeRunMeta(runMetaRaw);
    const lastProcessed = normalizeLastProcessed(lastProcessedRaw);

    const latestScannerSnapshotId = extractSnapshotId(latestScan);

    const scannerAndTradeInSync =
      Boolean(latestScannerSnapshotId) &&
      Boolean(lastProcessed.snapshotId) &&
      latestScannerSnapshotId === lastProcessed.snapshotId;

    return res.status(200).json({
      ok: true,

      positions,
      openPositions: positions,
      positionsCount: positions.length,

      stats,

      runMeta,
      lastProcessed,

      latestScan,
      latestScannerSnapshotId,
      scannerAndTradeInSync,

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