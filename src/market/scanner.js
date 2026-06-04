// ================= FILE: src/market/scanner.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getVolatileRedis, setJson } from '../redis.js';
import { classifyBtcState, mapConcurrent, normalizeBaseSymbol, normalizeContractSymbol, randomId, safeNumber } from '../utils.js';
import { detectFakeBreakout } from './fakeBreakout.js';
import { fetchBitgetTickers, parseTicker, fetchCandles } from './bitgetClient.js';

function calcScannerScore({ change1h, change24h, volume24h, fakeBreakoutRisk, pullbackConfirmed, sweepConfirmed, retestConfirmed }) {
  let score = 0;
  score += Math.min(35, Math.abs(change1h) * 12);
  score += Math.min(25, Math.abs(change24h) * 3);
  score += Math.min(25, Math.log10(Math.max(10, volume24h)) * 2.2);
  if (pullbackConfirmed) score += 8;
  if (sweepConfirmed || retestConfirmed) score += 5;
  if (fakeBreakoutRisk) score -= 12;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function inferSide({ change1h, change24h }) {
  const ch1 = safeNumber(change1h);
  const ch24 = safeNumber(change24h);
  if (ch1 > 0 && ch24 > -0.5) return 'bull';
  if (ch1 < 0 && ch24 < 0.5) return 'bear';
  if (ch24 > CONFIG.scanner.minAbsChange24h) return 'bull';
  if (ch24 < -CONFIG.scanner.minAbsChange24h) return 'bear';
  return null;
}

export async function runScanner() {
  const redis = getVolatileRedis();
  const startedAt = Date.now();
  const snapshotId = randomId('scan');

  const rawTickers = await fetchBitgetTickers();
  const parsed = rawTickers
    .map(parseTicker)
    .filter(row => row.price > 0)
    .filter(row => row.volume24h >= CONFIG.scanner.minQuoteVolume24h)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, CONFIG.scanner.maxSymbols);

  const btcTicker = parsed.find(row => row.baseSymbol === 'BTC') || parseTicker(rawTickers.find(r => String(r.symbol || '').includes('BTC')) || {});
  const btcState = classifyBtcState({ change24: btcTicker.change24h, change1h: 0 });
  const regime = Math.abs(safeNumber(btcTicker.change24h)) >= 3 ? 'HIGH_VOL' : 'NORMAL';

  const candidates = await mapConcurrent(parsed, 8, async ticker => {
    const side = inferSide({ change1h: 0, change24h: ticker.change24h });
    if (!side) return null;

    const candles15m = await fetchCandles(ticker.symbol, '15m', CONFIG.scanner.candleLimit).catch(() => []);
    if (candles15m.length < 30) return null;

    const first = candles15m.at(-5)?.close || candles15m.at(-1)?.close;
    const last = candles15m.at(-1)?.close || ticker.price;
    const change1h = first > 0 ? ((last - first) / first) * 100 : 0;
    const liveSide = inferSide({ change1h, change24h: ticker.change24h }) || side;

    if (Math.abs(change1h) < CONFIG.scanner.minAbsChange1h && Math.abs(ticker.change24h) < CONFIG.scanner.minAbsChange24h) {
      return null;
    }

    const fake = detectFakeBreakout({
      side: liveSide,
      candles15m,
      btcState,
      lookback: CONFIG.scanner.fakeBreakoutLookback
    });

    if (fake.fakeBreakout) return null;

    const scannerScore = calcScannerScore({
      change1h,
      change24h: ticker.change24h,
      volume24h: ticker.volume24h,
      ...fake
    });

    return {
      snapshotId,
      symbol: normalizeBaseSymbol(ticker.symbol),
      contractSymbol: normalizeContractSymbol(ticker.symbol),
      side: liveSide,
      price: ticker.price,
      scannerScore,
      moveScore: scannerScore,
      change1h: Number(change1h.toFixed(3)),
      change24h: Number(ticker.change24h.toFixed(3)),
      volume24h: ticker.volume24h,
      ...fake,
      scannerReason: fake.pullbackConfirmed ? 'MOMENTUM_PULLBACK' : 'MOMENTUM_EXPANSION',
      scannerTs: startedAt
    };
  });

  const cleanCandidates = candidates
    .filter(Boolean)
    .sort((a, b) => b.scannerScore - a.scannerScore);

  const snapshot = {
    snapshotId,
    createdAt: startedAt,
    btcState,
    regime,
    rawCount: rawTickers.length,
    filteredUniverse: parsed.length,
    candidatesCount: cleanCandidates.length,
    candidates: cleanCandidates
  };

  await setJson(redis, KEYS.scan.snapshot(snapshotId), snapshot, { ex: CONFIG.scanner.snapshotTtlSec });
  await setJson(redis, KEYS.scan.latest, {
    snapshotId,
    createdAt: startedAt,
    candidatesCount: cleanCandidates.length,
    btcState,
    regime
  }, { ex: CONFIG.scanner.snapshotTtlSec });

  return snapshot;
}
