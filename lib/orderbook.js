export async function fetchOrderBook(symbol){

  try{
    const res = await fetch(
      `https://api.bitget.com/api/mix/v1/market/depth?symbol=${symbol}&limit=15`
    );

    const json = await res.json();
    return json?.data || null;

  }catch{
    return null;
  }
}


export function analyzeOrderBookAdvanced(ob){

  if(!ob?.bids || !ob?.asks){
    return { bias:"NEUTRAL", spoof:false };
  }

  const bids = ob.bids;
  const asks = ob.asks;

  const bestBid = Number(bids[0][0] || 0);
  const bestAsk = Number(asks[0][0] || 0);

  const mid = (bestBid + bestAsk) / 2;

  // volume
  const bidVol = bids.reduce((a,b)=>a+Number(b[1]),0);
  const askVol = asks.reduce((a,b)=>a+Number(b[1]),0);

  const ratio = bidVol / (askVol || 1);

  let bias = "NEUTRAL";
  if(ratio > 1.3) bias = "BULLISH";
  if(ratio < 0.7) bias = "BEARISH";

  // spoof detectie
  const sizes = [...bids, ...asks].map(x=>Number(x[1]));
  const avg = sizes.reduce((a,b)=>a+b,0) / sizes.length;
  const max = Math.max(...sizes);

  const spoof = max > avg * 6;

  const spreadPct = mid > 0
    ? (bestAsk - bestBid) / mid
    : 0.001;

  return {
    mid,
    spreadPct,
    depthMinUsd1p: 200000,
    bias,
    spoof
  };
}