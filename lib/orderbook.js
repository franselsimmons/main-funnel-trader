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
  liveResistance: null,
  fetchFailed: true
};

const ORDERBOOK_CACHE = new Map();
const BAD_SYMBOL_CACHE = new Map();

const ORDERBOOK_CACHE_MS = 15 * 1000;
const BAD_SYMBOL_CACHE_MS = 10 * 60 * 1000;

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


// ================= FETCH ORDERBOOK =================
export async function fetchOrderBook(symbol){
  const clean = normalizeSymbol(symbol);
  const now = Date.now();

  const cached = ORDERBOOK_CACHE.get(clean);
  if(cached && now - cached.ts < ORDERBOOK_CACHE_MS){
    return cached.data;
  }

  const badUntil = BAD_SYMBOL_CACHE.get(clean) || 0;
  if(now < badUntil){
    throw new Error(`orderbook bad-symbol cooldown: ${clean}`);
  }

  const url =
    `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${encodeURIComponent(clean)}&productType=usdt-futures&limit=15`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  const json = await res.json().catch(() => null);

  const bids = Array.isArray(json?.data?.bids) ? json.data.bids : [];
  const asks = Array.isArray(json?.data?.asks) ? json.data.asks : [];

  const ok =
    res.ok &&
    json &&
    (json.code === undefined || json.code === "00000") &&
    bids.length > 0 &&
    asks.length > 0;

  if(!ok){
    if(res.status === 400){
      BAD_SYMBOL_CACHE.set(clean, now + BAD_SYMBOL_CACHE_MS);
    }

    throw new Error(
      `orderbook failed ${res.status} ${clean} ${json?.msg || json?.code || ""}`.trim()
    );
  }

  const data = {
    bids,
    asks,
    ts: json?.data?.ts || now
  };

  ORDERBOOK_CACHE.set(clean, {
    ts: now,
    data
  });

  return data;
}


// ================= HELPERS =================
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

  const avgUsd =
    nearRows.reduce((sum, r) => sum + Number(r.usd || 0), 0) /
    nearRows.length;

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


// ================= ANALYZE ORDERBOOK =================
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
      liveResistance: nearestAskWall?.price || resistanceLevels[0]?.price || null,

      fetchFailed: false
    };

  }catch{
    return { ...DEFAULT_OB };
  }
}