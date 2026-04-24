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

    const leftVol = left > 0
      ? Number(bins[left - 1]?.volume || 0)
      : -1;

    const rightVol = right < bins.length - 1
      ? Number(bins[right + 1]?.volume || 0)
      : -1;

    if(rightVol >= leftVol && right < bins.length - 1){
      right++;
      valueAreaVol += Number(bins[right]?.volume || 0);
    }else if(left > 0){
      left--;
      valueAreaVol += Number(bins[left]?.volume || 0);
    }else{
      break;
    }
  }

  const hvns = [...bins]
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 6)
    .map(b => ({
      price: b.mid,
      volume: Number(b.volume || 0)
    }))
    .sort((a, b) => a.price - b.price);

  const hvnAbove = hvns
    .filter(h => Number(h.price || 0) > Number(currentPrice || 0))
    .sort((a, b) => a.price - b.price)[0]?.price || null;

  const hvnBelow = hvns
    .filter(h => Number(h.price || 0) < Number(currentPrice || 0))
    .sort((a, b) => b.price - a.price)[0]?.price || null;

  return {
    poc: bins[pocIndex]?.mid || null,
    vah: bins[right]?.high || null,
    val: bins[left]?.low || null,
    hvns,
    hvnAbove,
    hvnBelow,
    profileLow,
    profileHigh
  };
}


// ================= CACHE =================
async function getMarketContext(symbol, currentPrice){

  const clean = normalizeSymbol(symbol);
  const cacheKey = clean;

  const cached = marketContextCache.get(cacheKey);

  if(cached?.data && (Date.now() - cached.ts) < MARKET_CONTEXT_TTL_MS){
    return cached.data;
  }

  if(cached?.promise){
    return await cached.promise;
  }

  const promise = (async () => {

    const [candles5m, candles15m, candles1h] = await Promise.all([
      fetchKlines(clean, "5m", 180),
      fetchKlines(clean, "15m", 180),
      fetchKlines(clean, "1h", 180)
    ]);

    const atr5m = calculateATR(candles5m, ATR_PERIOD);
    const atr15m = calculateATR(candles15m, ATR_PERIOD);
    const atr1h = calculateATR(candles1h, ATR_PERIOD);

    const lastClose =
      lastValue(candles5m, "close") ||
      lastValue(candles15m, "close") ||
      lastValue(candles1h, "close") ||
      Number(currentPrice || 0);

    const weightedAtr =
      (atr5m * 0.20) +
      (atr15m * 0.35) +
      (atr1h * 0.45);

    const weightedAtrPct = lastClose > 0
      ? weightedAtr / lastClose
      : 0;

    const profileCandles = uniqByOpenTime([
      ...candles15m.slice(-120),
      ...candles5m.slice(-140)
    ]);

    const profile = buildVolumeProfile(profileCandles, currentPrice);
    const structure = getStructure(candles5m, candles15m, candles1h);

    return {
      candles5m,
      candles15m,
      candles1h,
      atr: {
        a5m: atr5m,
        a15m: atr15m,
        a1h: atr1h,
        weighted: weightedAtr,
        weightedPct: weightedAtrPct
      },
      profile,
      structure
    };
  })();

  marketContextCache.set(cacheKey, {
    promise,
    ts: Date.now()
  });

  try{
    const data = await promise;

    marketContextCache.set(cacheKey, {
      data,
      ts: Date.now()
    });

    return data;
  }catch(e){
    marketContextCache.delete(cacheKey);
    throw e;
  }
}


// ================= PICKERS =================
function pickBullStop(price, candidates, fallbackPrice, minRiskDist, maxRiskDist){

  const valid = candidates
    .filter(c => isValidPrice(c?.price) && Number(c.price) < price)
    .sort((a, b) => Number(b.price) - Number(a.price));

  for(const candidate of valid){
    const dist = price - Number(candidate.price);

    if(dist >= minRiskDist && dist <= maxRiskDist){
      return {
        price: Number(candidate.price),
        source: candidate.source
      };
    }
  }

  for(const candidate of valid){
    const dist = price - Number(candidate.price);

    if(dist >= minRiskDist){
      return {
        price: Math.max(price - maxRiskDist, Number(candidate.price)),
        source: `${candidate.source} + max risk cap`
      };
    }
  }

  return {
    price: fallbackPrice,
    source: "ATR fallback stop"
  };
}


function pickBearStop(price, candidates, fallbackPrice, minRiskDist, maxRiskDist){

  const valid = candidates
    .filter(c => isValidPrice(c?.price) && Number(c.price) > price)
    .sort((a, b) => Number(a.price) - Number(b.price));

  for(const candidate of valid){
    const dist = Number(candidate.price) - price;

    if(dist >= minRiskDist && dist <= maxRiskDist){
      return {
        price: Number(candidate.price),
        source: candidate.source
      };
    }
  }

  for(const candidate of valid){
    const dist = Number(candidate.price) - price;

    if(dist >= minRiskDist){
      return {
        price: Math.min(price + maxRiskDist, Number(candidate.price)),
        source: `${candidate.source} + max risk cap`
      };
    }
  }

  return {
    price: fallbackPrice,
    source: "ATR fallback stop"
  };
}


function pickBullTarget(price, candidates, fallbackPrice, minRewardDist){

  const valid = candidates
    .filter(c => isValidPrice(c?.price) && Number(c.price) > price)
    .sort((a, b) => Number(a.price) - Number(b.price));

  for(const candidate of valid){
    const dist = Number(candidate.price) - price;

    if(dist >= minRewardDist){
      return {
        price: Number(candidate.price),
        source: candidate.source
      };
    }
  }

  return {
    price: fallbackPrice,
    source: "ATR fallback target"
  };
}


function pickBearTarget(price, candidates, fallbackPrice, minRewardDist){

  const valid = candidates
    .filter(c => isValidPrice(c?.price) && Number(c.price) < price)
    .sort((a, b) => Number(b.price) - Number(a.price));

  for(const candidate of valid){
    const dist = price - Number(candidate.price);

    if(dist >= minRewardDist){
      return {
        price: Number(candidate.price),
        source: candidate.source
      };
    }
  }

  return {
    price: fallbackPrice,
    source: "ATR fallback target"
  };
}


// ================= LIQUIDATION HELPERS =================
function nearestClusterAbove(liquidation, price){

  if(liquidation?.nearestAbove && liquidation.nearestAbove > price){
    return Number(liquidation.nearestAbove);
  }

  const clusters = Array.isArray(liquidation?.clusters)
    ? liquidation.clusters
    : [];

  const above = clusters
    .map(c => Number(c.price || 0))
    .filter(p => p > price)
    .sort((a, b) => a - b);

  return above[0] || null;
}


function nearestClusterBelow(liquidation, price){

  if(liquidation?.nearestBelow && liquidation.nearestBelow < price){
    return Number(liquidation.nearestBelow);
  }

  const clusters = Array.isArray(liquidation?.clusters)
    ? liquidation.clusters
    : [];

  const below = clusters
    .map(c => Number(c.price || 0))
    .filter(p => p < price)
    .sort((a, b) => b - a);

  return below[0] || null;
}


// ================= CORE =================
export async function calculateRisk(c, ob = {}, liquidity = null, liquidation = null){

  const price = Number(c?.price || 0);
  const side = String(c?.side || "").toLowerCase();
  const isBull = side === "bull";

  if(!price || !side){
    return {
      entry: price || 0,
      sl: price || 0,
      tp: price || 0,
      rr: 0,
      slSource: "invalid",
      tpSource: "invalid",
      atr: {},
      profile: {}
    };
  }

  const liq = liquidity || getLiquidityZones(c, ob);

  let marketCtx = {
    atr: {
      a5m: 0,
      a15m: 0,
      a1h: 0,
      weighted: 0,
      weightedPct: 0
    },
    profile: {},
    structure: {}
  };

  try{
    marketCtx = await getMarketContext(c.symbol, price);
  }catch{
    marketCtx = {
      atr: {
        a5m: 0,
        a15m: 0,
        a1h: 0,
        weighted: 0,
        weightedPct: 0
      },
      profile: {},
      structure: {}
    };
  }

  const spread = normalizeSpread(ob?.spreadPct);

  const atrWeightedPct = Number(marketCtx?.atr?.weightedPct || 0);
  const fallbackVolPct = clamp(Math.abs(Number(c?.change1h || 0)) / 100 * 0.55, 0.004, 0.03);
  const atrPct = atrWeightedPct > 0
    ? atrWeightedPct
    : fallbackVolPct;

  const atrDist = price * Math.max(atrPct * 1.35, spread * 3.0, 0.0038);
  const minRiskDist = Math.max(atrDist, price * 0.0042);
  const maxRiskDist = Math.max(atrDist * 3.25, price * 0.032);

  const slBufferPct = Math.max(spread * 1.8, atrPct * 0.22, 0.0014);
  const tpBufferPct = Math.max(spread * 1.2, atrPct * 0.16, 0.0010);

  const structure = marketCtx?.structure || {};
  const profile = marketCtx?.profile || {};

  const aboveNearest = nearestClusterAbove(liquidation, price);
  const belowNearest = nearestClusterBelow(liquidation, price);
  // NIEUW: major zones
  const aboveMajor = liquidation?.majorAbove ? Number(liquidation.majorAbove) : null;
  const belowMajor = liquidation?.majorBelow ? Number(liquidation.majorBelow) : null;

  let slPick;
  let tpPick;

  if(isBull){

    const bullStopCandidates = [
      { price: liq?.supportSweep, source: "liquidity support sweep" },
      { price: liq?.support, source: "liquidity support" },
      { price: structure?.swingLow5m ? Number(structure.swingLow5m) * (1 - slBufferPct * 0.6) : null, source: "5m swing low" },
      { price: structure?.swingLow15m ? Number(structure.swingLow15m) * (1 - slBufferPct * 0.8) : null, source: "15m swing low" },
      { price: structure?.swingLow1h ? Number(structure.swingLow1h) * (1 - slBufferPct) : null, source: "1h swing low" },
      { price: profile?.val ? Number(profile.val) * (1 - slBufferPct * 0.45) : null, source: "value area low" },
      { price: profile?.hvnBelow ? Number(profile.hvnBelow) * (1 - slBufferPct * 0.30) : null, source: "HVN below" },
      { price: ob?.nearestBidWallPrice ? Number(ob.nearestBidWallPrice) * (1 - slBufferPct * 0.25) : null, source: "live bid wall" },
      { price: belowNearest ? Number(belowNearest) * (1 - slBufferPct) : null, source: "liquidation cluster below" }
    ];

    slPick = pickBullStop(
      price,
      bullStopCandidates,
      price - minRiskDist,
      minRiskDist,
      maxRiskDist
    );

    const riskDist = Math.max(price - Number(slPick.price || 0), minRiskDist);
    const minRewardDist = Math.max(riskDist * 1.05, atrDist * 1.65);

    const bullTargetCandidates = [
      // NIEUW: major liquidation zone eerst
      { price: aboveMajor ? Number(aboveMajor) * (1 - tpBufferPct) : null, source: "major liquidation above" },
      { price: ob?.nearestAskWallPrice ? Number(ob.nearestAskWallPrice) * (1 - tpBufferPct * 0.25) : null, source: "live ask wall" },
      { price: Array.isArray(ob?.resistanceLevels) ? Number(ob.resistanceLevels[0]?.price || 0) * (1 - tpBufferPct * 0.20) : null, source: "orderbook resistance level" },
      { price: profile?.vah ? Number(profile.vah) * (1 - tpBufferPct * 0.20) : null, source: "value area high" },
      { price: profile?.hvnAbove ? Number(profile.hvnAbove) * (1 - tpBufferPct * 0.18) : null, source: "HVN above" },
      { price: liq?.resistance, source: "liquidity resistance" },
      { price: structure?.swingHigh15m ? Number(structure.swingHigh15m) * (1 - tpBufferPct * 0.18) : null, source: "15m swing high" },
      { price: structure?.swingHigh1h ? Number(structure.swingHigh1h) * (1 - tpBufferPct * 0.12) : null, source: "1h swing high" },
      { price: aboveNearest ? Number(aboveNearest) * (1 - tpBufferPct) : null, source: "short liquidation target (nearest)" }
    ];

    tpPick = pickBullTarget(
      price,
      bullTargetCandidates,
      price + Math.max(minRewardDist, atrDist * 2.10),
      minRewardDist
    );

  }else{

    const bearStopCandidates = [
      { price: liq?.resistanceSweep, source: "liquidity resistance sweep" },
      { price: liq?.resistance, source: "liquidity resistance" },
      { price: structure?.swingHigh5m ? Number(structure.swingHigh5m) * (1 + slBufferPct * 0.6) : null, source: "5m swing high" },
      { price: structure?.swingHigh15m ? Number(structure.swingHigh15m) * (1 + slBufferPct * 0.8) : null, source: "15m swing high" },
      { price: structure?.swingHigh1h ? Number(structure.swingHigh1h) * (1 + slBufferPct) : null, source: "1h swing high" },
      { price: profile?.vah ? Number(profile.vah) * (1 + slBufferPct * 0.45) : null, source: "value area high" },
      { price: profile?.hvnAbove ? Number(profile.hvnAbove) * (1 + slBufferPct * 0.30) : null, source: "HVN above" },
      { price: ob?.nearestAskWallPrice ? Number(ob.nearestAskWallPrice) * (1 + slBufferPct * 0.25) : null, source: "live ask wall" },
      { price: aboveNearest ? Number(aboveNearest) * (1 + slBufferPct) : null, source: "liquidation cluster above" }
    ];

    slPick = pickBearStop(
      price,
      bearStopCandidates,
      price + minRiskDist,
      minRiskDist,
      maxRiskDist
    );

    const riskDist = Math.max(Number(slPick.price || 0) - price, minRiskDist);
    const minRewardDist = Math.max(riskDist * 1.05, atrDist * 1.65);

    const bearTargetCandidates = [
      // NIEUW: major liquidation zone eerst
      { price: belowMajor ? Number(belowMajor) * (1 + tpBufferPct) : null, source: "major liquidation below" },
      { price: ob?.nearestBidWallPrice ? Number(ob.nearestBidWallPrice) * (1 + tpBufferPct * 0.25) : null, source: "live bid wall" },
      { price: Array.isArray(ob?.supportLevels) ? Number(ob.supportLevels[0]?.price || 0) * (1 + tpBufferPct * 0.20) : null, source: "orderbook support level" },
      { price: profile?.val ? Number(profile.val) * (1 + tpBufferPct * 0.20) : null, source: "value area low" },
      { price: profile?.hvnBelow ? Number(profile.hvnBelow) * (1 + tpBufferPct * 0.18) : null, source: "HVN below" },
      { price: liq?.support, source: "liquidity support" },
      { price: structure?.swingLow15m ? Number(structure.swingLow15m) * (1 + tpBufferPct * 0.18) : null, source: "15m swing low" },
      { price: structure?.swingLow1h ? Number(structure.swingLow1h) * (1 + tpBufferPct * 0.12) : null, source: "1h swing low" },
      { price: belowNearest ? Number(belowNearest) * (1 + tpBufferPct) : null, source: "long liquidation target (nearest)" }
    ];

    tpPick = pickBearTarget(
      price,
      bearTargetCandidates,
      price - Math.max(minRewardDist, atrDist * 2.10),
      minRewardDist
    );
  }

  let sl = Number(slPick?.price || 0);
  let tp = Number(tpPick?.price || 0);
  let slSource = slPick?.source || "ATR fallback stop";
  let tpSource = tpPick?.source || "ATR fallback target";

  if(isBull){

    if(!isValidPrice(sl) || sl >= price){
      sl = price - minRiskDist;
      slSource = "ATR fallback stop";
    }

    if(!isValidPrice(tp) || tp <= price){
      tp = price + Math.max((price - sl) * 1.05, atrDist * 2.10);
      tpSource = "ATR fallback target";
    }

  }else{

    if(!isValidPrice(sl) || sl <= price){
      sl = price + minRiskDist;
      slSource = "ATR fallback stop";
    }

    if(!isValidPrice(tp) || tp >= price){
      tp = price - Math.max((sl - price) * 1.05, atrDist * 2.10);
      tpSource = "ATR fallback target";
    }
  }

  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);
  const rr = reward / (risk || 1);

  return {
    entry: price,
    sl,
    tp,
    rr: Math.max(0, rr),
    slSource,
    tpSource,
    atr: marketCtx?.atr || {},
    profile: marketCtx?.profile || {}
  };
}