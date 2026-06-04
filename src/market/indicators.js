// ================= FILE: src/market/indicators.js =================

import { safeNumber } from '../utils.js';

export function parseBitgetCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [ts, open, high, low, close, volume, quoteVolume] = row.map(Number);
  if (![ts, open, high, low, close].every(Number.isFinite)) return null;
  return {
    ts,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    quoteVolume: Number.isFinite(quoteVolume) ? quoteVolume : 0
  };
}

export function calculateRsi(candles, period = 14) {
  const closes = (Array.isArray(candles) ? candles : [])
    .map(c => safeNumber(c.close, NaN))
    .filter(Number.isFinite);
  if (closes.length < period + 2) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

export function calculateAtrPct(candles, period = 14) {
  const rows = Array.isArray(candles) ? candles.slice(-(period + 1)) : [];
  if (rows.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const h = safeNumber(rows[i].high);
    const l = safeNumber(rows[i].low);
    const pc = safeNumber(rows[i - 1].close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const price = safeNumber(rows.at(-1)?.close);
  return price > 0 ? atr / price : 0;
}

export function getRsiZone(rsi) {
  const n = safeNumber(rsi, 50);
  if (n <= 26) return 'LOWER_3';
  if (n <= 33) return 'LOWER_2';
  if (n <= 40) return 'LOWER_1';
  if (n >= 74) return 'UPPER_3';
  if (n >= 67) return 'UPPER_2';
  if (n >= 60) return 'UPPER_1';
  return 'MID';
}

export function getRsiSlope(candles) {
  const rsiNow = calculateRsi(candles, 14);
  const rsiPrev = calculateRsi(Array.isArray(candles) ? candles.slice(0, -3) : [], 14);
  if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) return 0;
  return Number((rsiNow - rsiPrev).toFixed(3));
}

export function getRecentRange(candles, lookback = 24) {
  const rows = (Array.isArray(candles) ? candles : []).slice(-lookback);
  if (!rows.length) return { recentHigh: 0, recentLow: 0, rangePct: 0 };
  const recentHigh = Math.max(...rows.map(r => safeNumber(r.high)));
  const recentLow = Math.min(...rows.map(r => safeNumber(r.low)));
  return {
    recentHigh,
    recentLow,
    rangePct: recentHigh > 0 ? (recentHigh - recentLow) / recentHigh : 0
  };
}

export function classifyFlow({ side, change1h, change24h, candles15m }) {
  const s = String(side || '').toLowerCase();
  const ch1 = safeNumber(change1h);
  const ch24 = safeNumber(change24h);
  const rows = Array.isArray(candles15m) ? candles15m.slice(-8) : [];
  const first = safeNumber(rows[0]?.close);
  const last = safeNumber(rows.at(-1)?.close);
  const shortMovePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const directional = s === 'bull'
    ? ch1 > 0 && shortMovePct > 0
    : ch1 < 0 && shortMovePct < 0;
  const strong = s === 'bull'
    ? ch1 > 0.8 || ch24 > 3
    : ch1 < -0.8 || ch24 < -3;

  if (directional && strong) return 'TREND';
  if (directional) return 'BUILDING';
  return 'NEUTRAL';
}

export function calcVolumeExpansion(candles, lookback = 20) {
  const rows = Array.isArray(candles) ? candles.slice(-(lookback + 1)) : [];
  if (rows.length < 6) return 1;
  const last = safeNumber(rows.at(-1)?.quoteVolume || rows.at(-1)?.volume);
  const prev = rows.slice(0, -1).map(r => safeNumber(r.quoteVolume || r.volume)).filter(n => n > 0);
  if (!prev.length) return 1;
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  return avg > 0 ? last / avg : 1;
}
