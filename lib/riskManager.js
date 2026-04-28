import { getLiquidityZones } from "./liquidityEngine.js";

const MARKET_CONTEXT_TTL_MS = 45 * 1000;
const marketContextCache = new Map();

const ATR_PERIOD = 14;

// ================= HELPERS =================
function clamp(v, min, max){
  return Math.max(min, Math.min(max, v));
}

function normalizeSpread(spreadPct){
  let s = Number(spreadPct || 0);
  if(!Number.isFinite(s) || s < 0) return 0.001;
  if(s > 0.05) s = s / 100;
  return s;
}

function normalizeBitgetSymbol(raw){
  return String(raw || "")
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "");
}

// ================= FETCH =================
async function fetchJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`req failed ${res.status}`);
  return await res.json();
}

async function fetchKlinesBitget(symbol, interval, limit){

  const clean = normalizeBitgetSymbol(symbol);

  const granularityMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H"
  };

  const granularity = granularityMap[interval] || interval;

  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

  try{
    const json = await fetchJson(url);

    if(Array.isArray(json?.data)){
      return json.data.map(c => ({
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4])
      }));
    }
  }catch{}

  return [];
}

// ================= ATR =================
function calculateATR(candles){

  if(!candles || candles.length < ATR_PERIOD + 1) return 0;

  let sum = 0;

  for(let i = 1; i < candles.length; i++){
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    sum += tr;
  }

  return sum / candles.length;
}

// ================= CONTEXT =================
async function getMarketContext(symbol, price, rawBitgetSymbol){

  const key = rawBitgetSymbol || symbol;

  const cached = marketContextCache.get(key);

  if(cached && Date.now() - cached.ts < MARKET_CONTEXT_TTL_MS){
    return cached.data;
  }

  const [c5m, c15m, c1h] = await Promise.all([
    fetchKlinesBitget(rawBitgetSymbol, "5m", 120),
    fetchKlinesBitget(rawBitgetSymbol, "15m", 120),
    fetchKlinesBitget(rawBitgetSymbol, "1h", 120)
  ]);

  if(c5m.length < 20 || c15m.length < 20){
    return null; // 🔥 skip slechte coins
  }

  const atr5m = calculateATR(c5m);
  const atr15m = calculateATR(c15m);
  const atr1h = calculateATR(c1h);

  const lastPrice = price || c5m[c5m.length - 1].close;

  const weightedATR =
    (atr5m * 0.2) +
    (atr15m * 0.4) +
    (atr1h * 0.4);

  const atrPct = lastPrice > 0
    ? weightedATR / lastPrice
    : 0;

  const data = {
    atr: {
      value: weightedATR,
      pct: atrPct
    }
  };

  marketContextCache.set(key, {
    data,
    ts: Date.now()
  });

  return data;
}

// ================= CORE =================
export async function calculateRisk(c, ob = {}, liquidity = null, liquidation = null){

  const price = Number(c.price || 0);
  const isBull = c.side === "bull";

  if(!price) return { entry: 0, sl: 0, tp: 0, rr: 0 };

  const ctx = await getMarketContext(
    c.symbol,
    price,
    c.rawBitgetSymbol
  );

  if(!ctx){
    return { entry: price, sl: price, tp: price, rr: 0 };
  }

  const atrPct = ctx.atr.pct || 0.01;
  const spread = normalizeSpread(ob.spreadPct);

  // 🔥 STRONGER RISK MODEL
  const atrDist = price * Math.max(atrPct * 1.8, spread * 4, 0.005);

  const minRisk = price * 0.006;
  const maxRisk = price * 0.045;

  const riskDist = clamp(atrDist, minRisk, maxRisk);

  let sl, tp;

  if(isBull){

    sl = price - riskDist;

    tp = price + (riskDist * 1.2);

  }else{

    sl = price + riskDist;

    tp = price - (riskDist * 1.2);
  }

  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);

  const rr = reward / (risk || 1);

  return {
    entry: price,
    sl,
    tp,
    rr,
    slSource: "ATR",
    tpSource: "ATR"
  };
}