const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.001,
  depthMinUsd1p: 200000,
  bidDepthUsd1p: 100000,
  askDepthUsd1p: 100000,
  bias: "NEUTRAL",
  spoof: false,
  supportLevels: [],
  resistanceLevels: [],
  nearestBidWallPrice: null,
  nearestAskWallPrice: null,
  nearestBidWallUsd: 0,
  nearestAskWallUsd: 0,
  liveSupport: null,
  liveResistance: null
};

// ================= NIEUWE HELPERS (symbol variants) =================
function buildSymbolVariants(symbol){
  const raw = String(symbol || "").toUpperCase().trim();

  const normalizedExact = raw
    .replace(/-UMCBL$/, "_UMCBL")
    .replace(/-DMCBL$/, "_DMCBL")
    .replace(/-CMCBL$/, "_CMCBL");

  const hasExactContractSuffix =
    /_(UMCBL|DMCBL|CMCBL)$/.test(normalizedExact);

  const base = normalizedExact
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "");

  const linearBase = base.endsWith("USDT")
    ? base
    : `${base}USDT`;

  return {
    raw,
    linearBase,
    exactV1Candidates: [
      hasExactContractSuffix ? normalizedExact : null,
      `${linearBase}_UMCBL`,
      `${linearBase}_DMCBL`,
      `${linearBase}_CMCBL`
    ].filter(Boolean)
  };
}

async function readJson(url){
  const res = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  const text = await res.text();

  let json = null;

  try{
    json = JSON.parse(text);
  }catch{
    json = null;
  }

  if(!res.ok){
    const msg =
      json?.msg ||
      json?.message ||
      text ||
      `http_${res.status}`;

    throw new Error(`HTTP_${res.status}:${msg}`);
  }

  return json;
}

// ================= AANGEPASTE fetchOrderBook =================
export async function fetchOrderBook(symbol){
  const variants = buildSymbolVariants(symbol);

  const endpoints = [];

  for(const exact of variants.exactV1Candidates){
    endpoints.push(
      `https://api.bitget.com/api/mix/v1/market/depth?symbol=${encodeURIComponent(exact)}&limit=100`
    );
  }

  endpoints.push(
    `https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${encodeURIComponent(variants.linearBase)}&productType=USDT-FUTURES&limit=100`
  );

  let lastError = null;

  for(const url of endpoints){
    try{
      const json = await readJson(url);

      if(
        Array.isArray(json?.data?.bids) &&
        Array.isArray(json?.data?.asks) &&
        (json.data.bids.length || json.data.asks.length)
      ){
        return json.data;
      }

      if(
        Array.isArray(json?.bids) &&
        Array.isArray(json?.asks) &&
        (json.bids.length || json.asks.length)
      ){
        return json;
      }

      lastError = new Error(`EMPTY_BOOK:${url}`);
    }catch(err){
      lastError = err;
    }
  }

  throw lastError || new Error("ORDERBOOK_FETCH_FAILED");
}

// ================= OVERIGE HELPERS (ongewijzigd) =================
function normalizeRows(rows){

  if(!Array.isArray(rows)) return [];

  return rows
    .map(r => {

      if(Array.isArray(r)){
        return {
          price: Number(r[0]),
          qty: Number(r[1])
        };
      }

      return {
        price: Number(r?.price || r?.p || 0),
        qty: Number(r?.size || r?.qty || r?.amount || r?.q || 0)
      };
    })
    .filter(r => r.price > 0 && r.qty > 0)
    .map(r => ({
      ...r,
      usd: r.price * r.qty
    }));
}

function calcDepthUsdWithinPct(rows, mid, pct, side){

  if(!mid || !rows.length) return 0;

  const lower = mid * (1 - pct);
  const upper = mid * (1 + pct);

  return rows.reduce((sum, r) => {

    if(side === "bid"){
      if(r.price >= lower && r.price <= mid){
        return sum + r.usd;
      }
    }

    if(side === "ask"){
      if(r.price <= upper && r.price >= mid){
        return sum + r.usd;
      }
    }

    return sum;
  }, 0);
}

function getNearRows(rows, mid, pct, side){

  if(!mid || !Array.isArray(rows)) return [];

  const lower = mid * (1 - pct);
  const upper = mid * (1 + pct);

  return rows.filter(r => {

    if(side === "bid"){
      return r.price >= lower && r.price <= mid;
    }

    return r.price <= upper && r.price >= mid;
  });
}

function getNearestWall(rows, mid, side){

  const nearRows = getNearRows(rows, mid, 0.012, side);

  if(!nearRows.length){
    return null;
  }

  const avgUsd = nearRows.reduce((sum, r) => sum + Number(r.usd || 0), 0) / nearRows.length;
  const threshold = Math.max(avgUsd * 2.5, 25000);

  const candidates = nearRows
    .filter(r => Number(r.usd || 0) >= threshold)
    .sort((a, b) => {
      const distA = Math.abs(Number(a.price || 0) - mid);
      const distB = Math.abs(Number(b.price || 0) - mid);

      if(distA !== distB){
        return distA - distB;
      }

      return Number(b.usd || 0) - Number(a.usd || 0);
    });

  return candidates[0] || null;
}

function getTopLevels(rows, mid, side){

  const nearRows = getNearRows(rows, mid, 0.015, side);

  return nearRows
    .sort((a, b) => Number(b.usd || 0) - Number(a.usd || 0))
    .slice(0, 6)
    .sort((a, b) => {
      return side === "bid"
        ? Number(b.price || 0) - Number(a.price || 0)
        : Number(a.price || 0) - Number(b.price || 0);
    })
    .map(r => ({
      price: Number(r.price || 0),
      qty: Number(r.qty || 0),
      usd: Number(r.usd || 0)
    }));
}

// ================= ANALYZE ORDERBOOK (ongewijzigd) =================
export function analyzeOrderBookAdvanced(ob){

  try{

    const bids = normalizeRows(ob?.bids || []);
    const asks = normalizeRows(ob?.asks || []);

    if(!bids.length || !asks.length){
      return { ...DEFAULT_OB };
    }

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;

    if(!bestBid || !bestAsk || bestAsk <= bestBid){
      return { ...DEFAULT_OB };
    }

    const mid = (bestBid + bestAsk) / 2;

    const spreadPct = mid > 0
      ? (bestAsk - bestBid) / mid
      : 0.001;

    const bidDepthUsd05p = calcDepthUsdWithinPct(bids, mid, 0.005, "bid");
    const askDepthUsd05p = calcDepthUsdWithinPct(asks, mid, 0.005, "ask");

    const bidDepthUsd1p = calcDepthUsdWithinPct(bids, mid, 0.01, "bid");
    const askDepthUsd1p = calcDepthUsdWithinPct(asks, mid, 0.01, "ask");

    const depthMinUsd1p = Math.min(
      bidDepthUsd1p || DEFAULT_OB.bidDepthUsd1p,
      askDepthUsd1p || DEFAULT_OB.askDepthUsd1p
    );

    const ratio05 = bidDepthUsd05p / (askDepthUsd05p || 1);
    const ratio1 = bidDepthUsd1p / (askDepthUsd1p || 1);
    const ratio = (ratio05 * 0.60) + (ratio1 * 0.40);

    let bias = "NEUTRAL";

    if(ratio > 1.20) bias = "BULLISH";
    if(ratio < 0.83) bias = "BEARISH";

    const allUsdSizes = [
      ...bids.map(r => Number(r.usd || 0)),
      ...asks.map(r => Number(r.usd || 0))
    ];

    const avgUsd =
      allUsdSizes.reduce((a, b) => a + b, 0) / (allUsdSizes.length || 1);

    const maxUsd = Math.max(...allUsdSizes, 0);

    const spoof =
      avgUsd > 0 &&
      maxUsd > avgUsd * 8 &&
      maxUsd > 25000;

    const nearestBidWall = getNearestWall(bids, mid, "bid");
    const nearestAskWall = getNearestWall(asks, mid, "ask");

    const supportLevels = getTopLevels(bids, mid, "bid");
    const resistanceLevels = getTopLevels(asks, mid, "ask");

    return {
      mid,
      bestBid,
      bestAsk,
      spreadPct,
      bidDepthUsd05p,
      askDepthUsd05p,
      bidDepthUsd1p,
      askDepthUsd1p,
      depthMinUsd1p,
      bias,
      spoof,

      supportLevels,
      resistanceLevels,

      nearestBidWallPrice: nearestBidWall?.price || null,
      nearestAskWallPrice: nearestAskWall?.price || null,
      nearestBidWallUsd: Number(nearestBidWall?.usd || 0),
      nearestAskWallUsd: Number(nearestAskWall?.usd || 0),

      liveSupport: nearestBidWall?.price || supportLevels[0]?.price || null,
      liveResistance: nearestAskWall?.price || resistanceLevels[0]?.price || null
    };

  }catch{
    return { ...DEFAULT_OB };
  }
}