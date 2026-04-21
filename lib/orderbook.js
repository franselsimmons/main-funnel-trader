const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.001,
  depthMinUsd1p: 200000,
  bidDepthUsd1p: 100000,
  askDepthUsd1p: 100000,
  bias: "NEUTRAL",
  spoof: false
};


function normalizeSymbol(symbol){

  return String(symbol || "")
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");
}


// ================= FETCH ORDERBOOK =================
export async function fetchOrderBook(symbol){

  const clean = normalizeSymbol(symbol);

  const endpoints = [
    // Bitget v2 USDT futures
    `https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${clean}&productType=USDT-FUTURES&limit=50`,

    // Bitget v1 USDT futures fallback
    `https://api.bitget.com/api/mix/v1/market/depth?symbol=${clean}_UMCBL&limit=50`,

    // Bitget v1 without suffix fallback
    `https://api.bitget.com/api/mix/v1/market/depth?symbol=${clean}&limit=50`,

    // Binance spot fallback
    `https://api.binance.com/api/v3/depth?symbol=${clean}&limit=50`
  ];

  let lastError = null;

  for(const url of endpoints){

    try{
      const res = await fetch(url);

      if(!res.ok){
        throw new Error(`orderbook failed ${res.status}`);
      }

      const json = await res.json();

      if(json?.data?.bids || json?.data?.asks){
        return json.data;
      }

      if(json?.bids || json?.asks){
        return json;
      }

    }catch(err){
      lastError = err;
    }
  }

  throw lastError || new Error("orderbook fetch failed");
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
        price: Number(r.price || r.p || 0),
        qty: Number(r.size || r.qty || r.amount || r.q || 0)
      };
    })
    .filter(r => r.price > 0 && r.qty > 0);
}


function calcDepthUsdWithinPct(rows, mid, pct, side){

  if(!mid || !rows.length) return 0;

  const lower = mid * (1 - pct);
  const upper = mid * (1 + pct);

  return rows.reduce((sum, r) => {

    if(side === "bid"){
      if(r.price >= lower && r.price <= mid){
        return sum + (r.price * r.qty);
      }
    }

    if(side === "ask"){
      if(r.price <= upper && r.price >= mid){
        return sum + (r.price * r.qty);
      }
    }

    return sum;
  }, 0);
}


// ================= ANALYZE ORDERBOOK =================
export function analyzeOrderBookAdvanced(ob){

  try{

    const bids = normalizeRows(ob?.bids || []);
    const asks = normalizeRows(ob?.asks || []);

    if(!bids.length || !asks.length){
      return { ...DEFAULT_OB };
    }

    bids.sort((a,b) => b.price - a.price);
    asks.sort((a,b) => a.price - b.price);

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;

    if(!bestBid || !bestAsk || bestAsk <= bestBid){
      return { ...DEFAULT_OB };
    }

    const mid = (bestBid + bestAsk) / 2;

    const spreadPct = mid > 0
      ? (bestAsk - bestBid) / mid
      : 0.001;

    const bidDepthUsd1p = calcDepthUsdWithinPct(bids, mid, 0.01, "bid");
    const askDepthUsd1p = calcDepthUsdWithinPct(asks, mid, 0.01, "ask");

    const depthMinUsd1p = Math.min(
      bidDepthUsd1p || DEFAULT_OB.bidDepthUsd1p,
      askDepthUsd1p || DEFAULT_OB.askDepthUsd1p
    );

    const bidVolUsd = bids.reduce((sum, r) => {
      return sum + (r.price * r.qty);
    }, 0);

    const askVolUsd = asks.reduce((sum, r) => {
      return sum + (r.price * r.qty);
    }, 0);

    const ratio = bidVolUsd / (askVolUsd || 1);

    let bias = "NEUTRAL";

    if(ratio > 1.25) bias = "BULLISH";
    if(ratio < 0.80) bias = "BEARISH";

    const allUsdSizes = [
      ...bids.map(r => r.price * r.qty),
      ...asks.map(r => r.price * r.qty)
    ];

    const avgUsd =
      allUsdSizes.reduce((a,b) => a + b, 0) / (allUsdSizes.length || 1);

    const maxUsd = Math.max(...allUsdSizes);

    const spoof =
      avgUsd > 0 &&
      maxUsd > avgUsd * 8 &&
      maxUsd > 25000;

    return {
      mid,
      bestBid,
      bestAsk,
      spreadPct,
      bidDepthUsd1p,
      askDepthUsd1p,
      depthMinUsd1p,
      bias,
      spoof
    };

  }catch{
    return { ...DEFAULT_OB };
  }
}