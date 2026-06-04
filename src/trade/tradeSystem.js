// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getVolatileRedis, getJson, setJson, getKeys } from '../redis.js';
import { mapConcurrent, normalizeBaseSymbol, normalizeContractSymbol, randomId, safeNumber } from '../utils.js';
import { fetchCandles, fetchFunding, fetchOrderBook, analyzeOrderBook } from '../market/bitgetClient.js';
import { analyzeCandidatesBatch, createShadowPosition, buildOutcomeFromPosition, recordOutcome } from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import { buildLiveMetrics, buildRiskGeometry, isValidRiskGeometry } from './riskEngine.js';
import { buildOpenPositionFromEntry, getOpenPositions, getOpenPosition, saveOpenPosition, monitorOpenPositions, updatePathMetrics } from './positionEngine.js';
import { riskFractionForEntry, checkRiskCaps } from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

async function cachedVolatile(key, ttlSec, fn) {
  const redis = getVolatileRedis();
  const cached = await getJson(redis, key, null).catch(() => null);
  if (cached) return cached;
  const value = await fn();
  await setJson(redis, key, value, { ex: ttlSec }).catch(() => null);
  return value;
}

async function fetchLiveCandidateData(candidate) {
  const symbol = normalizeContractSymbol(candidate.contractSymbol || candidate.symbol);
  const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
    cachedVolatile(KEYS.live.cache(symbol, 'ob'), CONFIG.trade.orderbookTtlSec, () => fetchOrderBook(symbol)).catch(() => null),
    cachedVolatile(KEYS.live.cache(symbol, 'funding'), CONFIG.trade.fundingTtlSec, () => fetchFunding(symbol)).catch(() => ({ rate: 0 })),
    cachedVolatile(KEYS.live.cache(symbol, 'c15'), CONFIG.trade.candleTtlSec, () => fetchCandles(symbol, '15m', 100)).catch(() => []),
    cachedVolatile(KEYS.live.cache(symbol, 'c1h'), CONFIG.trade.candleTtlSec, () => fetchCandles(symbol, '1h', 100)).catch(() => [])
  ]);

  const ob = analyzeOrderBook(rawOrderBook);
  return { symbol, ob, funding, candles15m, candles1h };
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();
  const latest = await getJson(volatileRedis, KEYS.scan.latest, null);
  if (!latest?.snapshotId) return null;
  return getJson(volatileRedis, KEYS.scan.snapshot(latest.snapshotId), null);
}

function getWeeklyStats(activeRotation, microFamilyId) {
  return (activeRotation?.microFamilies || []).find(row => row.microFamilyId === microFamilyId) || null;
}

// Mirror of the family classifier's BTC relation, used for correlation risk caps.
function deriveBtcRelation(row) {
  const s = String(row.side || '').toLowerCase();
  const btc = String(row.btcState || 'NEUTRAL').toUpperCase();
  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';
  if (s === 'bull' && ['BULLISH', 'STRONG_BULL'].includes(btc)) return 'BTC_WITH';
  if (s === 'bear' && ['BEARISH', 'STRONG_BEAR'].includes(btc)) return 'BTC_WITH';
  return 'BTC_AGAINST';
}

function validateExposure(openPositions, side) {
  if (openPositions.length >= CONFIG.trade.maxOpenPositions) return { ok: false, reason: 'MAX_OPEN_POSITIONS' };
  const sameSide = openPositions.filter(p => p.side === side).length;
  if (sameSide >= CONFIG.trade.maxOpenSameSide) return { ok: false, reason: 'MAX_OPEN_SAME_SIDE' };
  return { ok: true };
}

async function monitorShadowPositions() {
  if (!CONFIG.analyze.shadowEnabled) return [];
  const redis = getDurableRedis();
  const keys = await getKeys(redis, KEYS.analyze.shadowOpenPattern, CONFIG.analyze.maxShadowMonitorsPerRun);
  const closed = [];

  for (const key of keys) {
    const shadow = await getJson(redis, key, null);
    if (!shadow || shadow.status !== 'OPEN') continue;
    const data = await fetchLiveCandidateData(shadow).catch(() => null);
    const price = safeNumber(data?.ob?.mid || shadow.entry);
    if (!price) continue;

    updatePathMetrics(shadow, price);
    const isBull = shadow.side === 'bull';
    const hitTP = isBull ? price >= shadow.tp : price <= shadow.tp;
    const hitSL = isBull ? price <= shadow.sl : price >= shadow.sl;
    const expired = Date.now() >= safeNumber(shadow.monitorUntil);

    if (!hitTP && !hitSL && !expired) {
      await setJson(redis, key, shadow, { ex: Math.ceil(CONFIG.analyze.shadowHorizonMin * 60 * 1.2) });
      continue;
    }

    const exitReason = hitTP ? 'HIT_TP' : hitSL ? 'HIT_SL' : 'HORIZON_DONE';
    const outcome = buildOutcomeFromPosition({ position: shadow, exitPrice: price, exitReason, source: 'SHADOW' });
    await recordOutcome(outcome, { source: 'SHADOW' });
    await redis.del(key);
    closed.push(outcome);
  }

  return closed;
}

export async function runTradeSystem(options = {}) {
  const durableRedis = getDurableRedis();
  const runId = randomId('trade_run');
  const startedAt = Date.now();

  const priceFetcher = async symbol => {
    const data = await fetchLiveCandidateData({ symbol });
    return data?.ob?.mid || 0;
  };

  const realExits = await monitorOpenPositions({ priceFetcher });
  const shadowExits = await monitorShadowPositions();

  const snapshot = await getLatestSnapshot();
  if (!snapshot?.snapshotId) {
    const result = { runId, startedAt, actions: [], realExits, shadowExits, reason: 'NO_SCANNER_SNAPSHOT' };
    await setJson(durableRedis, KEYS.trade.runMeta, result);
    return result;
  }

  const lastProcessed = await getJson(durableRedis, KEYS.trade.lastProcessedSnapshot, null);
  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  // Snapshot TTL is 30 min, but acting on 20-min-old candidates in crypto futures is dangerous.
  // Open-position monitoring above already ran; here we only gate *new* entries on freshness.
  const snapshotAgeSec = (Date.now() - safeNumber(snapshot.createdAt)) / 1000;
  if (snapshotAgeSec > CONFIG.trade.maxSnapshotAgeSec) {
    const result = {
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      reason: 'SNAPSHOT_TOO_STALE'
    };
    await setJson(durableRedis, KEYS.trade.runMeta, result);
    return result;
  }

  if (sameSnapshot && !options.forceProcessSnapshot) {
    const result = {
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED'
    };
    await setJson(durableRedis, KEYS.trade.runMeta, result);
    return result;
  }

  const activeRotation = await getActiveRotation();
  const activeSet = new Set(activeRotation?.microFamilyIds || []);
  const candidates = (snapshot.candidates || []).slice(0, CONFIG.trade.maxCandidatesPerSnapshot);
  const liveRows = [];
  const actions = [];

  await mapConcurrent(candidates, CONFIG.trade.dataConcurrency, async candidate => {
    const normalized = {
      ...candidate,
      symbol: normalizeBaseSymbol(candidate.symbol),
      contractSymbol: normalizeContractSymbol(candidate.contractSymbol || candidate.symbol)
    };

    const data = await fetchLiveCandidateData(normalized).catch(error => ({ error }));
    if (data.error || data.ob?.fetchFailed) {
      actions.push({ action: 'WAIT', reason: 'LIVE_DATA_FAILED', symbol: normalized.symbol, side: normalized.side });
      return;
    }

    if (safeNumber(data.ob.spreadPct) > CONFIG.trade.maxSpreadPct) {
      actions.push({ action: 'WAIT', reason: 'SPREAD_TOO_WIDE', symbol: normalized.symbol, side: normalized.side, spreadPct: data.ob.spreadPct });
      return;
    }

    const risk = buildRiskGeometry({ candidate: normalized, ob: data.ob, candles15m: data.candles15m });
    if (!isValidRiskGeometry(risk, normalized.side)) {
      actions.push({ action: 'WAIT', reason: 'RISK_INVALID', symbol: normalized.symbol, side: normalized.side });
      return;
    }

    const metrics = buildLiveMetrics({
      candidate: normalized,
      ob: data.ob,
      funding: data.funding,
      candles15m: data.candles15m,
      candles1h: data.candles1h,
      btcState: snapshot.btcState,
      regime: snapshot.regime,
      risk
    });

    liveRows.push(metrics);
  });

  const analyzedRows = await analyzeCandidatesBatch(liveRows);
  const openPositions = await getOpenPositions();

  for (const row of analyzedRows) {
    await createShadowPosition(row).catch(() => null);

    const weeklyStats = getWeeklyStats(activeRotation, row.microFamilyId);
    const isActive = activeSet.has(row.microFamilyId);

    if (!isActive) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: activeSet.size ? 'MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION' : 'ACTIVE_ROTATION_EMPTY',
        activeRotationId: activeRotation?.rotationId || null,
        liveEligible: false,
        shadowOnly: true
      });
      continue;
    }

    const alreadyOpen = await getOpenPosition(row.symbol);
    if (alreadyOpen) {
      actions.push({ ...row, action: 'WAIT', reason: 'SYMBOL_ALREADY_OPEN', liveEligible: false });
      continue;
    }

    const exposure = validateExposure(openPositions, row.side);
    if (!exposure.ok) {
      actions.push({ ...row, action: 'WAIT', reason: exposure.reason, liveEligible: false });
      continue;
    }

    // Portfolio risk caps. btcRelation derives from the family classifier (BTC_WITH/AGAINST/NEUTRAL).
    // This bounds correlated drawdown — the real tail risk when 30 BTC-correlated longs lose together.
    const btcRelation = deriveBtcRelation(row);
    const riskFraction = CONFIG.sizing.enabled ? riskFractionForEntry({ weeklyStats }) : CONFIG.sizing.baseRiskPct;

    if (CONFIG.sizing.enabled) {
      const caps = checkRiskCaps({ openPositions, side: row.side, btcRelation, riskFraction });
      if (!caps.ok) {
        actions.push({ ...row, action: 'WAIT', reason: caps.reason, riskCaps: caps, liveEligible: false });
        continue;
      }
    }

    const entry = {
      ...row,
      action: 'ENTRY',
      reason: 'ACTIVE_MICRO_FAMILY_ENTRY',
      activeRotationId: activeRotation.rotationId,
      weeklyStats,
      riskFraction,
      btcRelation,
      liveEligible: true,
      shadowOnly: false
    };

    const position = buildOpenPositionFromEntry(entry);
    await saveOpenPosition(position);
    openPositions.push(position);
    await sendEntryAlert(entry).catch(() => null);
    actions.push(entry);
  }

  await setJson(durableRedis, KEYS.trade.lastProcessedSnapshot, {
    snapshotId: snapshot.snapshotId,
    processedAt: Date.now(),
    actions: actions.length
  });

  const result = {
    runId,
    startedAt,
    completedAt: Date.now(),
    snapshotId: snapshot.snapshotId,
    candidates: candidates.length,
    liveRows: liveRows.length,
    actions,
    actionCounts: actions.reduce((acc, a) => {
      acc[a.action] = (acc[a.action] || 0) + 1;
      return acc;
    }, {}),
    realExits,
    shadowExits,
    activeRotationId: activeRotation?.rotationId || null,
    activeMicroFamilies: activeSet.size
  };

  await setJson(durableRedis, KEYS.trade.runMeta, result);
  return result;
}
