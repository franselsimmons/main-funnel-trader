// ================= FILE: src/market/scanner.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getVolatileRedis, setJson } from '../redis.js';
import {
  classifyBtcState,
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber
} from '../utils.js';
import {
  calculateAtrPct,
  classifyVolatilityRegime,
  calcVolumeExpansion
} from './indicators.js';
import { detectFakeBreakout } from './fakeBreakout.js';
import {
  fetchBitgetTickers,
  parseTicker,
  fetchCandles
} from './bitgetClient.js';

function inferSide({ change1h, change24h }) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);

  if (ch1 > 0 && ch24 > -0.5) return 'bull';
  if (ch1 < 0 && ch24 < 0.5) return 'bear';

  if (ch24 > CONFIG.scanner.minAbsChange24h) return 'bull';
  if (ch24 < -CONFIG.scanner.minAbsChange24h) return 'bear';

  return null;
}

function calcChangePct(first, last) {
  const a = safeNumber(first, 0);
  const b = safeNumber(last, 0);

  if (a <= 0 || b <= 0) return 0;

  return ((b - a) / a) * 100;
}

function calcOneHourChange(candles15m) {
  const rows = Array.isArray(candles15m) ? candles15m : [];

  if (rows.length < 5) return 0;

  const first = rows.at(-5)?.close;
  const last = rows.at(-1)?.close;

  return calcChangePct(first, last);
}

function calcScannerScore({
  change1h,
  change24h,
  volume24h,
  volumeExpansion,
  fakeBreakoutRisk,
  pullbackConfirmed,
  sweepConfirmed,
  retestConfirmed,
  breakoutType
}) {
  let score = 0;

  score += Math.min(35, Math.abs(safeNumber(change1h, 0)) * 12);
  score += Math.min(22, Math.abs(safeNumber(change24h, 0)) * 2.7);
  score += Math.min(20, Math.log10(Math.max(10, safeNumber(volume24h, 0))) * 2.0);

  if (safeNumber(volumeExpansion, 1) >= 1.25) score += 6;
  if (safeNumber(volumeExpansion, 1) >= 1.75) score += 4;

  if (pullbackConfirmed) score += 7;
  if (retestConfirmed) score += 5;
  if (sweepConfirmed) score += 3;
  if (breakoutType === 'VALID_BREAKOUT') score += 4;

  if (fakeBreakoutRisk) score -= 12;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scannerReasonFrom({ fake, volumeExpansion }) {
  if (fake?.pullbackConfirmed && fake?.retestConfirmed) return 'MOMENTUM_PULLBACK_RETEST';
  if (fake?.pullbackConfirmed) return 'MOMENTUM_PULLBACK';
  if (fake?.breakoutType === 'VALID_BREAKOUT') return 'VALID_BREAKOUT';
  if (volumeExpansion >= 1.5) return 'VOLUME_EXPANSION';

  return 'MOMENTUM_EXPANSION';
}

function cleanFakeResult(fake = {}) {
  return {
    fakeBreakout: Boolean(fake.fakeBreakout),
    fakeBreakoutRisk: Boolean(fake.fakeBreakoutRisk),
    fakeBreakoutReason: fake.fakeBreakoutReason || null,
    breakoutType: fake.breakoutType || 'UNKNOWN',
    pullbackConfirmed: Boolean(fake.pullbackConfirmed),
    sweepConfirmed: Boolean(fake.sweepConfirmed),
    retestConfirmed: Boolean(fake.retestConfirmed)
  };
}

function isTradableTicker(ticker) {
  if (!ticker?.symbol) return false;
  if (!ticker?.baseSymbol) return false;
  if (safeNumber(ticker.price, 0) <= 0) return false;
  if (safeNumber(ticker.volume24h, 0) < CONFIG.scanner.minQuoteVolume24h) return false;

  return true;
}

function dedupeByBaseSymbol(tickers) {
  const byBase = new Map();

  for (const ticker of tickers) {
    const baseSymbol = normalizeBaseSymbol(ticker.baseSymbol || ticker.symbol);

    if (!baseSymbol) continue;

    const existing = byBase.get(baseSymbol);

    if (!existing || safeNumber(ticker.volume24h, 0) > safeNumber(existing.volume24h, 0)) {
      byBase.set(baseSymbol, {
        ...ticker,
        baseSymbol,
        symbol: normalizeContractSymbol(ticker.symbol)
      });
    }
  }

  return [...byBase.values()];
}

function buildTickerUniverse(rawTickers) {
  return dedupeByBaseSymbol(
    (Array.isArray(rawTickers) ? rawTickers : [])
      .map(parseTicker)
      .filter(isTradableTicker)
  )
    .sort((a, b) => safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0))
    .slice(0, CONFIG.scanner.maxSymbols);
}

async function createCandleCache() {
  const cache = new Map();

  return async function getCandles(symbol, timeframe = '15m', limit = CONFIG.scanner.candleLimit) {
    const contractSymbol = normalizeContractSymbol(symbol);
    const key = `${contractSymbol}:${timeframe}:${limit}`;

    if (cache.has(key)) return cache.get(key);

    const promise = fetchCandles(contractSymbol, timeframe, limit).catch(() => []);
    cache.set(key, promise);

    return promise;
  };
}

async function buildBtcContext({ universe, getCandles }) {
  const btcTicker =
    universe.find((row) => row.baseSymbol === 'BTC') ||
    parseTicker({ symbol: 'BTCUSDT', last: 0, quoteVolume: 0, change24h: 0 });

  const btcCandles15m = await getCandles('BTCUSDT', '15m', CONFIG.scanner.candleLimit);
  const btcChange1h = calcOneHourChange(btcCandles15m);
  const btcChange24h = safeNumber(btcTicker.change24h, 0);
  const btcState = classifyBtcState({
    change24: btcChange24h,
    change1h: btcChange1h
  });

  const btcAtrPct = calculateAtrPct(btcCandles15m, 14);
  const volRegime = classifyVolatilityRegime(btcCandles15m, btcAtrPct);

  const regime =
    volRegime === 'EXTREME_VOL' ? 'HIGH_VOL' :
    volRegime === 'HIGH_VOL' ? 'HIGH_VOL' :
    volRegime === 'LOW_VOL' ? 'LOW_VOL' :
    'NORMAL_VOL';

  return {
    btcState,
    regime,
    btcChange1h: Number(btcChange1h.toFixed(3)),
    btcChange24h: Number(btcChange24h.toFixed(3)),
    btcAtrPct: Number(btcAtrPct.toFixed(6))
  };
}

async function analyzeTickerCandidate({
  ticker,
  snapshotId,
  startedAt,
  btcState,
  getCandles
}) {
  const contractSymbol = normalizeContractSymbol(ticker.symbol);
  const baseSymbol = normalizeBaseSymbol(ticker.symbol);

  if (!contractSymbol || !baseSymbol) {
    return {
      candidate: null,
      skippedReason: 'INVALID_SYMBOL'
    };
  }

  const candles15m = await getCandles(contractSymbol, '15m', CONFIG.scanner.candleLimit);

  if (candles15m.length < 30) {
    return {
      candidate: null,
      skippedReason: 'INSUFFICIENT_CANDLES'
    };
  }

  const change1h = calcOneHourChange(candles15m);
  const change24h = safeNumber(ticker.change24h, 0);
  const side = inferSide({ change1h, change24h });

  if (!side) {
    return {
      candidate: null,
      skippedReason: 'NO_DIRECTION'
    };
  }

  const passesMoveFilter =
    Math.abs(change1h) >= CONFIG.scanner.minAbsChange1h ||
    Math.abs(change24h) >= CONFIG.scanner.minAbsChange24h;

  if (!passesMoveFilter) {
    return {
      candidate: null,
      skippedReason: 'MOVE_TOO_SMALL'
    };
  }

  const fakeRaw = detectFakeBreakout({
    side,
    candles15m,
    btcState,
    lookback: CONFIG.scanner.fakeBreakoutLookback
  });

  const fake = cleanFakeResult(fakeRaw);

  if (fake.fakeBreakout) {
    return {
      candidate: null,
      skippedReason: 'FAKE_BREAKOUT'
    };
  }

  const volumeExpansion = calcVolumeExpansion(candles15m, 20);

  const scannerScore = calcScannerScore({
    change1h,
    change24h,
    volume24h: ticker.volume24h,
    volumeExpansion,
    ...fake
  });

  const lastClose = safeNumber(candles15m.at(-1)?.close, 0);
  const price = lastClose > 0 ? lastClose : safeNumber(ticker.price, 0);

  return {
    candidate: {
      snapshotId,

      symbol: baseSymbol,
      contractSymbol,
      side,

      price,

      scannerScore,
      moveScore: scannerScore,

      change1h: Number(change1h.toFixed(3)),
      change24h: Number(change24h.toFixed(3)),
      volume24h: safeNumber(ticker.volume24h, 0),
      volumeExpansion: Number(volumeExpansion.toFixed(3)),

      ...fake,

      scannerReason: scannerReasonFrom({
        fake,
        volumeExpansion
      }),

      scannerTs: startedAt
    },
    skippedReason: null
  };
}

function countSkipped(results) {
  return results.reduce((acc, row) => {
    const reason = row?.skippedReason;

    if (reason) {
      acc[reason] = (acc[reason] || 0) + 1;
    }

    return acc;
  }, {});
}

export async function runScanner() {
  const redis = getVolatileRedis();
  const startedAt = Date.now();
  const snapshotId = randomId('scan');
  const getCandles = await createCandleCache();

  const rawTickers = await fetchBitgetTickers();
  const universe = buildTickerUniverse(rawTickers);

  const btcContext = await buildBtcContext({
    universe,
    getCandles
  });

  const results = await mapConcurrent(
    universe,
    CONFIG.scanner.dataConcurrency || CONFIG.trade.dataConcurrency || 5,
    async (ticker) => analyzeTickerCandidate({
      ticker,
      snapshotId,
      startedAt,
      btcState: btcContext.btcState,
      getCandles
    })
  );

  const cleanCandidates = results
    .map((row) => row?.candidate)
    .filter(Boolean)
    .sort((a, b) => b.scannerScore - a.scannerScore);

  const snapshot = {
    snapshotId,
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,

    btcState: btcContext.btcState,
    regime: btcContext.regime,
    btcChange1h: btcContext.btcChange1h,
    btcChange24h: btcContext.btcChange24h,
    btcAtrPct: btcContext.btcAtrPct,

    rawCount: Array.isArray(rawTickers) ? rawTickers.length : 0,
    filteredUniverse: universe.length,
    candidatesCount: cleanCandidates.length,
    skippedCounts: countSkipped(results),

    topSymbols: cleanCandidates.slice(0, 20).map((candidate) => candidate.symbol),

    candidates: cleanCandidates
  };

  await setJson(
    redis,
    KEYS.scan.snapshot(snapshotId),
    snapshot,
    { ex: CONFIG.scanner.snapshotTtlSec }
  );

  await setJson(
    redis,
    KEYS.scan.latest,
    {
      snapshotId,
      createdAt: startedAt,
      durationMs: snapshot.durationMs,
      candidatesCount: cleanCandidates.length,
      btcState: btcContext.btcState,
      regime: btcContext.regime,
      topSymbols: snapshot.topSymbols
    },
    { ex: CONFIG.scanner.snapshotTtlSec }
  );

  return snapshot;
}