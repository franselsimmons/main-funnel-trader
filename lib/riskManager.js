import { getLiquidityZones } from "./liquidityEngine.js";

const MARKET_CONTEXT_TTL_MS = 45 * 1000;
const marketContextCache = new Map();

const PROFILE_VALUE_AREA_PCT = 0.70;
const ATR_PERIOD = 14;
const PROFILE_BINS = 48;


// ================= BASIC HELPERS =================
function normalizeSpread(spreadPct){

  let s = Number(spreadPct || 0);

  if(!Number.isFinite(s) || s < 0){
    return 0.001;
  }

  if(s > 0.05){
    s = s / 100;
  }

  return s;
}


function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}


function isValidPrice(n){
  return Number.isFinite(Number(n)) && Number(n) > 0;
}


function normalizeSymbol(symbol){

  const clean = String(symbol || "")
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  return clean.endsWith("USDT")
    ? clean
    : `${clean}USDT`;
}


function sortByTimeAsc(list){
  return [...list].sort((a, b) => Number(a.openTime || 0) - Number(b.openTime || 0));
}


function uniqByOpenTime(list){

  const map = new Map();

  for(const row of list){
    if(Number.isFinite(Number(row?.openTime))){
      map.set(Number(row.openTime), row);
    }
  }

  return sortByTimeAsc(Array.from(map.values()));
}


function lastValue(list, field, fallback = 0){

  if(!Array.isArray(list) || list.length === 0){
    return fallback;
  }

  const v = Number(list[list.length - 1]?.[field]);

  return Number.isFinite(v)
    ? v
    : fallback;
}


// ================= CANDLES FETCH =================
function parseCandleRows(rows){

  if(!Array.isArray(rows)) return [];

  return rows
    .map(r => {

      if(Array.isArray(r)){
        return {
          openTime: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5] || 0)
        };
      }

      return {
        openTime: Number(r?.openTime || r?.ts || r?.timestamp || 0),
        open: Number(r?.open || r?.o || 0),
        high: Number(r?.high || r?.h || 0),
        low: Number(r?.low || r?.l || 0),
        close: Number(r?.close || r?.c || 0),
        volume: Number(r?.volume || r?.v || 0)
      };
    })
    .filter(r => {
      return (
        r.openTime > 0 &&
        r.open > 0 &&
        r.high > 0 &&
        r.low > 0 &&
        r.close > 0 &&
        r.volume >= 0
      );
    });
}


async function fetchJson(url){

  const res = await fetch(url);

  if(!res.ok){
    throw new Error(`request failed ${res.status}`);
  }

  return await res.json();
}


async function fetchKlinesBitget(symbol, interval, limit){

  const clean = normalizeSymbol(symbol);

  const granularityMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H"
  };

  const granularity = granularityMap[interval] || interval;

  const urls = [
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`,
    `https://api.bitget.com/api/mix/v1/market/candles?symbol=${clean}_UMCBL&granularity=${granularity}&limit=${limit}`
  ];

  for(const url of urls){

    try{
      const json = await fetchJson(url);

      if(Array.isArray(json?.data)){
        const parsed = parseCandleRows(json.data);
        if(parsed.length) return sortByTimeAsc(parsed);
      }

      if(Array.isArray(json)){
        const parsed = parseCandleRows(json);
        if(parsed.length) return sortByTimeAsc(parsed);
      }

    }catch{
      // try next
    }
  }

  return [];
}


async function fetchKlinesBinance(symbol, interval, limit){

  const clean = normalizeSymbol(symbol);

  const urls = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${clean}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${clean}&interval=${interval}&limit=${limit}`
  ];

  for(const url of urls){

    try{
      const json = await fetchJson(url);

      if(Array.isArray(json)){
        const parsed = parseCandleRows(json);
        if(parsed.length) return sortByTimeAsc(parsed);
      }

    }catch{
      // try next
    }
  }

  return [];
}


async function fetchKlines(symbol, interval, limit = 200){

  const bitget = await fetchKlinesBitget(symbol, interval, limit);
  if(bitget.length) return bitget;

  const binance = await fetchKlinesBinance(symbol, interval, limit);
  if(binance.length) return binance;

  return [];
}


// ================= ATR =================
function trueRange(curr, prevClose){

  const high = Number(curr?.high || 0);
  const low = Number(curr?.low || 0);

  if(!high || !low){
    return 0;
  }

  const tr1 = high - low;
  const tr2 = Math.abs(high - prevClose);
  const tr3 = Math.abs(low - prevClose);

  return Math.max(tr1, tr2, tr3);
}


function calculateATR(candles, period = ATR_PERIOD){

  if(!Array.isArray(candles) || candles.length < period + 1){
    return 0;
  }

  const trs = [];

  for(let i = 1; i < candles.length; i++){
    trs.push(
      trueRange(candles[i], Number(candles[i - 1]?.close || candles[i]?.close || 0))
    );
  }

  const recent = trs.slice(-period);

  if(!recent.length){
    return 0;
  }

  const avg = recent.reduce((sum, v) => sum + Number(v || 0), 0) / recent.length;

  return Number.isFinite(avg)
    ? avg
    : 0;
}


// ================= STRUCTURE =================
function getStructure(candles5m, candles15m, candles1h){

  const recent5m = Array.isArray(candles5m) ? candles5m.slice(-36) : [];
  const recent15m = Array.isArray(candles15m) ? candles15m.slice(-32) : [];
  const recent1h = Array.isArray(candles1h) ? candles1h.slice(-20) : [];

  const lows5m = recent5m.map(c => Number(c.low || 0)).filter(v => v > 0);
  const highs5m = recent5m.map(c => Number(c.high || 0)).filter(v => v > 0);

  const lows15m = recent15m.map(c => Number(c.low || 0)).filter(v => v > 0);
  const highs15m = recent15m.map(c => Number(c.high || 0)).filter(v => v > 0);

  const lows1h = recent1h.map(c => Number(c.low || 0)).filter(v => v > 0);
  const highs1h = recent1h.map(c => Number(c.high || 0)).filter(v => v > 0);

  return {
    swingLow5m: lows5m.length ? Math.min(...lows5m) : null,
    swingHigh5m: highs5m.length ? Math.max(...highs5m) : null,
    swingLow15m: lows15m.length ? Math.min(...lows15m) : null,
    swingHigh15m: highs15m.length ? Math.max(...highs15m) : null,
    swingLow1h: lows1h.length ? Math.min(...lows1h) : null,
    swingHigh1h: highs1h.length ? Math.max(...highs1h) : null
  };
}


// ================= VOLUME PROFILE =================
function buildBins(low, high, binsCount){

  const range = Math.max(high - low, low * 0.01, 0.0000001);
  const step = range / binsCount;

  return Array.from({ length: binsCount }).map((_, index) => {
    const bLow = low + (index * step);
    const bHigh = bLow + step;

    return {
      index,
      low: bLow,
      high: bHigh,
      mid: (bLow + bHigh) / 2,
      volume: 0
    };
  });
}


function distributeCandleVolume(candle, bins){

  const low = Number(candle?.low || 0);
  const high = Number(candle?.high || 0);
  const volume = Number(candle?.volume || 0);

  if(!low || !high || high < low || !volume || !Array.isArray(bins) || !bins.length){
    return;
  }

  const candleRange = Math.max(high - low, 0.0000001);

  for(const bin of bins){

    const overlapLow = Math.max(low, bin.low);
    const overlapHigh = Math.min(high, bin.high);
    const overlap = overlapHigh - overlapLow;

    if(overlap > 0){
      const ratio = overlap / candleRange;
      bin.volume += volume * ratio;
    }
  }
}


function buildVolumeProfile(candles, currentPrice){

  if(!Array.isArray(candles) || candles.length < 30){
    return {
      poc: null,
      vah: null,
      val: null,
      hvns: [],
      hvnAbove: null,
      hvnBelow: null,
      profileLow: null,
      profileHigh: null
    };
  }

  const lows = candles.map(c => Number(c.low || 0)).filter(v => v > 0);
  const highs = candles.map(c => Number(c.high || 0)).filter(v => v > 0);

  if(!lows.length || !highs.length){
    return {
      poc: null,
      vah: null,
      val: null,
      hvns: [],
      hvnAbove: null,
      hvnBelow: null,
      profileLow: null,
      profileHigh: null
    };
  }

  const profileLow = Math.min(...lows);
  const profileHigh = Math.max(...highs);

  const bins = buildBins(profileLow, profileHigh, PROFILE_BINS);

  for(const candle of candles){
    distributeCandleVolume(candle, bins);
  }

  const totalVolume = bins.reduce((sum, b) => sum + Number(b.volume || 0), 0);

  if(!totalVolume){
    return {
      poc: null,
      vah: null,
      val: null,
      hvns: [],
      hvnAbove: null,
      hvnBelow: null,
      profileLow,
      profileHigh
    };
  }

  const pocIndex = bins.reduce((bestIndex, bin, index, arr) => {
    return Number(bin.volume || 0) > Number(arr[bestIndex]?.volume || 0)
      ? index
      : bestIndex;
  }, 0);

  let left = pocIndex;
  let right = pocIndex;
  let valueAreaVol = Number(bins[pocIndex]?.volume || 0);
  const targetVol = totalVolume * PROFILE_VALUE_AREA_PCT;

  while(valueAreaVol < targetVol && (left > 0 || right < bins.length - 1)){

    const leftVol = left