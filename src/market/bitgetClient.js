// ================= FILE: src/market/bitgetClient.js =================

import { CONFIG } from '../config.js';
import { normalizeContractSymbol, safeNumber } from '../utils.js';
import { parseBitgetCandle } from './indicators.js';

async function fetchJson(path, params = {}, timeoutMs = CONFIG.bitget.timeoutMs) {
  const url = new URL(path, CONFIG.bitget.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`BITGET_HTTP_${res.status}_${text.slice(0, 200)}`);
    if (json?.code && json.code !== '00000') throw new Error(`BITGET_API_${json.code}_${json.msg || 'UNKNOWN'}`);
    return json?.data ?? json;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBitgetTickers() {
  const data = await fetchJson('/api/v2/mix/market/tickers', {
    productType: CONFIG.bitget.productType
  });
  return Array.isArray(data) ? data : [];
}

export function parseTicker(row = {}) {
  const symbol = normalizeContractSymbol(row.symbol || row.instId || row.contractCode);
  const last = safeNumber(row.lastPr ?? row.last ?? row.close ?? row.markPrice);
  const quoteVolume = safeNumber(row.quoteVolume ?? row.quoteVol ?? row.usdtVolume ?? row.baseVolume);
  const change24h = safeNumber(row.change24h ?? row.changeUtc24h ?? row.priceChangePercent ?? row.priceChange24h);

  return {
    symbol,
    baseSymbol: symbol.replace(/USDT$|USDC$/g, ''),
    price: last,
    volume24h: quoteVolume,
    change24h: Math.abs(change24h) <= 1 ? change24h * 100 : change24h,
    raw: row
  };
}

export function normalizeGranularity(timeframe) {
  const tf = String(timeframe || '15m').toLowerCase();
  const map = {
    '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1H', '60m': '1H', '4h': '4H', '1d': '1D'
  };
  return map[tf] || timeframe;
}

export async function fetchCandles(symbol, timeframe = '15m', limit = 100) {
  const contractSymbol = normalizeContractSymbol(symbol);
  const granularity = normalizeGranularity(timeframe);
  const safeLimit = Math.max(1, Math.min(Number(limit || 100), 1000));

  const endpoints = [
    '/api/v2/mix/market/candles',
    '/api/v2/mix/market/history-candles'
  ];

  let lastError = null;
  for (const path of endpoints) {
    try {
      const raw = await fetchJson(path, {
        symbol: contractSymbol,
        productType: CONFIG.bitget.productType,
        granularity,
        limit: path.includes('history') ? Math.min(safeLimit, 200) : safeLimit,
        kLineType: 'MARKET'
      });
      const rows = (Array.isArray(raw) ? raw : [])
        .map(parseBitgetCandle)
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);
      if (rows.length) return rows.slice(-safeLimit);
    } catch (error) {
      lastError = error;
    }
  }

  console.warn('BITGET_CANDLES_FAILED', JSON.stringify({ symbol: contractSymbol, timeframe, error: lastError?.message || 'EMPTY' }));
  return [];
}

export async function fetchOrderBook(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);
  const data = await fetchJson('/api/v2/mix/market/merge-depth', {
    symbol: contractSymbol,
    productType: CONFIG.bitget.productType,
    precision: 'scale0',
    limit: 100
  });
  return data || null;
}

export function analyzeOrderBook(raw) {
  const bids = Array.isArray(raw?.bids) ? raw.bids : [];
  const asks = Array.isArray(raw?.asks) ? raw.asks : [];
  const bestBid = safeNumber(bids[0]?.[0]);
  const bestAsk = safeNumber(asks[0]?.[0]);
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : safeNumber(raw?.ts ? 0 : raw?.mid);

  if (!mid || !bestBid || !bestAsk) {
    return { bias: 'NEUTRAL', spreadPct: 0.001, depthMinUsd1p: 0, mid: 0, fetchFailed: true };
  }

  const spreadPct = Math.max(0, (bestAsk - bestBid) / mid);
  const bidDepth = bids.reduce((sum, [p, q]) => {
    const price = safeNumber(p);
    const qty = safeNumber(q);
    return price >= mid * 0.99 ? sum + price * qty : sum;
  }, 0);
  const askDepth = asks.reduce((sum, [p, q]) => {
    const price = safeNumber(p);
    const qty = safeNumber(q);
    return price <= mid * 1.01 ? sum + price * qty : sum;
  }, 0);

  const imbalance = (bidDepth - askDepth) / Math.max(1, bidDepth + askDepth);
  const bias = imbalance > 0.12 ? 'BULLISH' : imbalance < -0.12 ? 'BEARISH' : 'NEUTRAL';

  return {
    bias,
    spreadPct,
    depthMinUsd1p: Math.min(bidDepth, askDepth),
    bidDepthUsd1p: bidDepth,
    askDepthUsd1p: askDepth,
    imbalance,
    mid,
    fetchFailed: false
  };
}

export async function fetchFunding(symbol) {
  const contractSymbol = normalizeContractSymbol(symbol);
  try {
    const data = await fetchJson('/api/v2/mix/market/current-fund-rate', {
      symbol: contractSymbol,
      productType: CONFIG.bitget.productType
    });
    const row = Array.isArray(data) ? data[0] : data;
    return { rate: safeNumber(row?.fundingRate ?? row?.fundRate ?? row?.rate) };
  } catch {
    return { rate: 0 };
  }
}
