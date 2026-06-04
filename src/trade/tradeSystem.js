// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  fetchCandles,
  fetchFunding,
  fetchOrderBook,
  analyzeOrderBook
} from '../market/bitgetClient.js';
import {
  analyzeCandidatesBatch,
  createShadowPosition,
  buildOutcomeFromPosition,
  recordOutcome
} from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildLiveMetrics,
  buildRiskGeometry,
  isValidRiskGeometry
} from './riskEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  getOpenPosition,
  saveOpenPosition,
  monitorOpenPositions,
  updatePathMetrics
} from './positionEngine.js';
import {
  riskFractionForEntry,
  checkRiskCaps
} from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

function now() {
  return Date.now();
}

function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol
  );

  const symbol =
    normalizeBaseSymbol(candidate.symbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

  return {
    ...candidate,
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}

function isLong(side) {
  return sideToTradeSide(side) === 'LONG';
}

function isShort(side) {
  return sideToTradeSide(side) === 'SHORT';
}

function waitAction(candidate, reason, extra = {}) {
  return {
    action: 'WAIT',
    reason,
    symbol: candidate?.symbol || null,
    contractSymbol: candidate?.contractSymbol || null,
    side: candidate?.side || null,
    snapshotId: candidate?.snapshotId || null,
    scannerScore: candidate?.scannerScore ?? candidate?.moveScore ?? null,
    liveEligible: false,
    ...extra
  };
}

async function cachedVolatile(key, ttlSec, fn) {
  const redis = getVolatileRedis();

  const cached = await getJson(redis, key, null).catch(() => null);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const value = await fn();

  if (value !== undefined) {
    const ttl = Math.max(1, Number(ttlSec) || 1);
    await setJson(redis, key, value, { ex: ttl }).catch(() => null);
  }

  return value;
}

async function fetchLiveCandidateData(candidate) {
  const normalized = normalizeCandidate(candidate);
  const symbol = normalized.contractSymbol;

  if (!symbol) {
    return {
      symbol,
      ob: {
        fetchFailed: true,
        mid: 0,
        bias: 'NEUTRAL',
        spreadPct: CONFIG.cost?.fallbackSpreadPct || 0.0008,
        depthMinUsd1p: 0
      },
      funding: { rate: 0, fetchFailed: true },
      candles15m: [],
      candles1h: []
    };
  }

  const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
    cachedVolatile(
      KEYS.live.cache(symbol, 'ob'),
      CONFIG.trade.orderbookTtlSec,
      () => fetchOrderBook(symbol)
    ).catch(() => null),

    cachedVolatile(
      KEYS.live.cache(symbol, 'funding'),
      CONFIG.trade.fundingTtlSec,
      () => fetchFunding(symbol)
    ).catch(() => ({ rate: 0, fetchFailed: true })),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c15'),
      CONFIG.trade.candleTtlSec,
      () => fetchCandles(symbol, '15m', 100)
    ).catch(() => []),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c1h'),
      CONFIG.trade.candleTtlSec,
      () => fetchCandles(symbol, '1h', 100)
    ).catch(() => [])
  ]);

  const ob = analyzeOrderBook(rawOrderBook);

  return {
    symbol,
    ob,
    funding,
    candles15m: Array.isArray(candles15m) ? candles15m : [],
    candles1h: Array.isArray(candles1h) ? candles1h : []
  };
}

async function fetchMidPrice(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return 0;

  const rawOrderBook = await cachedVolatile(
    KEYS.live.cache(contractSymbol, 'ob'),
    CONFIG.trade.orderbookTtlSec,
    () => fetchOrderBook(contractSymbol)
  ).catch(() => null);

  const ob = analyzeOrderBook(rawOrderBook);

  return safeNumber(ob?.mid, 0);
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();
  const latest = await getJson(volatileRedis, KEYS.scan.latest, null);

  if (!latest?.snapshotId) return null;

  return getJson(
    volatileRedis,
    KEYS.scan.snapshot(latest.snapshotId),
    null
  );
}

function getWeeklyStats(activeRotation, microFamilyId) {
  return (activeRotation?.microFamilies || [])
    .find((row) => row.microFamilyId === microFamilyId) || null;
}

function validateExposure(openPositions, side) {
  const rows = Array.isArray(openPositions) ? openPositions : [];
  const tradeSide = sideToTradeSide(side);

  if (rows.length >= CONFIG.trade.maxOpenPositions) {
    return {
      ok: false,
      reason: 'MAX_OPEN_POSITIONS',
      count: rows.length,
      cap: CONFIG.trade.maxOpenPositions
    };
  }

  const sameSide = rows.filter((position) => (
    sideToTradeSide(position.side) === tradeSide
  )).length;

  if (sameSide >= CONFIG.trade.maxOpenSameSide) {
    return {
      ok: false,
      reason: 'MAX_OPEN_SAME_SIDE',
      side: tradeSide,
      count: sameSide,
      cap: CONFIG.trade.maxOpenSameSide
    };
  }

  return {
    ok: true
  };
}

function detectShadowExit(shadow, price) {
  const current = safeNumber(price, 0);
  const tp = safeNumber(shadow.tp, 0);
  const sl = safeNumber(shadow.sl, 0);

  if (current <= 0 || tp <= 0 || sl <= 0) {
    return {
      shouldExit: false,
      reason: null
    };
  }

  if (isLong(shadow.side)) {
    if (current >= tp) return { shouldExit: true, reason: 'TP' };
    if (current <= sl) return { shouldExit: true, reason: 'SL' };
  }

  if (isShort(shadow.side)) {
    if (current <= tp) return { shouldExit: true, reason: 'TP' };
    if (current >= sl) return { shouldExit: true, reason: 'SL' };
  }

  if (now() >= safeNumber(shadow.monitorUntil, 0)) {
    return {
      shouldExit: true,
      reason: 'TIME_STOP'
    };
  }

  return {
    shouldExit: false,
    reason: null
  };
}

async function monitorOneShadowPosition(redis, key) {
  const shadow = await getJson(redis, key, null);

  if (!shadow || shadow.status !== 'OPEN') {
    return null;
  }

  const price = await fetchMidPrice(
    shadow.contractSymbol ||
    shadow.symbol
  ).catch(() => 0);

  if (!price) return null;

  updatePathMetrics(shadow, price);

  const exit = detectShadowExit(shadow, price);

  if (!exit.shouldExit) {
    await setJson(
      redis,
      key,
      shadow,
      {
        ex: Math.ceil(CONFIG.analyze.shadowHorizonMin * 60 * 1.2)
      }
    );

    return null;
  }

  const outcome = buildOutcomeFromPosition({
    position: shadow,
    exitPrice: price,
    exitReason: exit.reason,
    source: 'SHADOW'
  });

  await recordOutcome(outcome, {
    source: 'SHADOW'
  });

  await redis.del(key);

  return outcome;
}

async function monitorShadowPositions() {
  if (!CONFIG.analyze.shadowEnabled) return [];

  const redis = getDurableRedis();

  const keys = await getKeys(
    redis,
    KEYS.analyze.shadowOpenPattern,
    CONFIG.analyze.maxShadowMonitorsPerRun
  );

  if (!keys.length) return [];

  const results = await mapConcurrent(
    keys,
    CONFIG.trade.dataConcurrency || 5,
    (key) => monitorOneShadowPosition(redis, key)
  );

  return results.filter(Boolean);
}

async function processCandidate(candidate) {
  const normalized = normalizeCandidate(candidate);

  if (!normalized.symbol || !normalized.contractSymbol) {
    return {
      action: waitAction(normalized, 'INVALID_SYMBOL'),
      metrics: null
    };
  }

  const data = await fetchLiveCandidateData(normalized)
    .catch((error) => ({ error }));

  if (data.error || data.ob?.fetchFailed) {
    return {
      action: waitAction(normalized, 'LIVE_DATA_FAILED', {
        error: data.error?.message || null
      }),
      metrics: null
    };
  }

  if (safeNumber(data.ob.spreadPct, 0) > CONFIG.trade.maxSpreadPct) {
    return {
      action: waitAction(normalized, 'SPREAD_TOO_WIDE', {
        spreadPct: data.ob.spreadPct,
        maxSpreadPct: CONFIG.trade.maxSpreadPct
      }),
      metrics: null
    };
  }

  if (!Array.isArray(data.candles15m) || data.candles15m.length < 30) {
    return {
      action: waitAction(normalized, 'INSUFFICIENT_LIVE_CANDLES_15M', {
        candleCount: data.candles15m?.length || 0
      }),
      metrics: null
    };
  }

  const risk = buildRiskGeometry({
    candidate: normalized,
    ob: data.ob,
    candles15m: data.candles15m
  });

  if (!isValidRiskGeometry(risk, normalized.side)) {
    return {
      action: waitAction(normalized, 'RISK_INVALID'),
      metrics: null
    };
  }

  const metrics = buildLiveMetrics({
    candidate: normalized,
    ob: data.ob,
    funding: data.funding,
    candles15m: data.candles15m,
    candles1h: data.candles1h,
    btcState: normalized.btcState || candidate.btcState,
    regime: normalized.regime || candidate.regime,
    risk
  });

  return {
    action: null,
    metrics
  };
}

async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();

  const completedAt = now();

  const finalResult = {
    ...result,
    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts: result.actionCounts || actionCounts(result.actions || [])
  };

  await setJson(
    durableRedis,
    KEYS.trade.runMeta,
    finalResult
  );

  return finalResult;
}

export async function runTradeSystem(options = {}) {
  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run');
  const startedAt = now();

  const forceProcessSnapshot = Boolean(options.forceProcessSnapshot);

  const priceFetcher = async (symbol) => fetchMidPrice(symbol);

  const realExits = await monitorOpenPositions({ priceFetcher });
  const shadowExits = await monitorShadowPositions();

  const snapshot = await getLatestSnapshot();

  if (!snapshot?.snapshotId) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'NO_SCANNER_SNAPSHOT'
    });
  }

  const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

  if (snapshotAgeSec > CONFIG.trade.maxSnapshotAgeSec) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_TOO_STALE'
    });
  }

  const lastProcessed = await getJson(
    durableRedis,
    KEYS.trade.lastProcessedSnapshot,
    null
  );

  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  if (sameSnapshot && !forceProcessSnapshot) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED'
    });
  }

  const activeRotation = await getActiveRotation();
  const activeSet = new Set(activeRotation?.microFamilyIds || []);

  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .slice(0, CONFIG.trade.maxCandidatesPerSnapshot)
    .map((candidate) => ({
      ...candidate,
      btcState: snapshot.btcState,
      regime: snapshot.regime
    }));

  const processed = await mapConcurrent(
    candidates,
    CONFIG.trade.dataConcurrency,
    processCandidate
  );

  const earlyActions = processed
    .map((row) => row?.action)
    .filter(Boolean);

  const liveRows = processed
    .map((row) => row?.metrics)
    .filter(Boolean);

  const analyzedRows = await analyzeCandidatesBatch(liveRows);

  const openPositions = await getOpenPositions();
  const actions = [...earlyActions];

  for (const row of analyzedRows) {
    await createShadowPosition(row).catch(() => null);

    const weeklyStats = getWeeklyStats(
      activeRotation,
      row.microFamilyId
    );

    const isActive = activeSet.has(row.microFamilyId);

    if (!isActive) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: activeSet.size
          ? 'MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION'
          : 'ACTIVE_ROTATION_EMPTY',
        activeRotationId: activeRotation?.rotationId || null,
        liveEligible: false,
        shadowOnly: true
      });

      continue;
    }

    const alreadyOpen = await getOpenPosition(row.symbol);

    if (alreadyOpen) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: 'SYMBOL_ALREADY_OPEN',
        liveEligible: false
      });

      continue;
    }

    const exposure = validateExposure(openPositions, row.side);

    if (!exposure.ok) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: exposure.reason,
        exposure,
        liveEligible: false
      });

      continue;
    }

    const riskFraction = CONFIG.sizing.enabled
      ? riskFractionForEntry({ weeklyStats })
      : CONFIG.sizing.baseRiskPct;

    const riskCaps = checkRiskCaps({
      openPositions,
      side: row.side,
      btcRelation: row.btcRelation,
      riskFraction
    });

    if (!riskCaps.ok) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: riskCaps.reason,
        riskCaps,
        liveEligible: false
      });

      continue;
    }

    const entry = {
      ...row,

      action: 'ENTRY',
      reason: 'ACTIVE_MICRO_FAMILY_ENTRY',

      activeRotationId: activeRotation?.rotationId || null,
      weeklyStats,

      riskFraction,
      riskCaps,

      btcRelation: row.btcRelation,

      liveEligible: true,
      shadowOnly: false,

      entryCreatedAt: now()
    };

    const position = buildOpenPositionFromEntry(entry);

    await saveOpenPosition(position);

    openPositions.push(position);

    await sendEntryAlert(entry).catch(() => null);

    actions.push(entry);
  }

  await setJson(
    durableRedis,
    KEYS.trade.lastProcessedSnapshot,
    {
      snapshotId: snapshot.snapshotId,
      processedAt: now(),
      forceProcessSnapshot,
      candidates: candidates.length,
      liveRows: liveRows.length,
      actions: actions.length
    }
  );

  return saveRunMeta({
    runId,
    startedAt,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec: Math.round(snapshotAgeSec),

    candidates: candidates.length,
    liveRows: liveRows.length,

    actions,
    actionCounts: actionCounts(actions),

    realExits,
    shadowExits,

    activeRotationId: activeRotation?.rotationId || null,
    activeMicroFamilies: activeSet.size,

    skippedNewEntries: false
  });
}