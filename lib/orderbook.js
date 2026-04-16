export async function fetchOrderBook(symbol){
  try{
    const res = await fetch(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`
    );
    return await res.json();
  }catch{
    return null;
  }
}

// ================= WALL DETECTIE =================
export function detectWalls(ob){

  if(!ob?.bids || !ob?.asks){
    return { support:0, resistance:0 };
  }

  const bids = ob.bids.map(b=>({
    price:Number(b[0]),
    size:Number(b[1])
  }));

  const asks = ob.asks.map(a=>({
    price:Number(a[0]),
    size:Number(a[1])
  }));

  const maxBid = Math.max(...bids.map(b=>b.size));
  const maxAsk = Math.max(...asks.map(a=>a.size));

  const support = bids.find(b=>b.size === maxBid)?.price || 0;
  const resistance = asks.find(a=>a.size === maxAsk)?.price || 0;

  return { support, resistance };
}

// ================= SPOOF DETECTIE =================
export function detectSpoofing(ob){

  if(!ob?.bids || !ob?.asks){
    return false;
  }

  const sizes = [
    ...ob.bids.map(b=>Number(b[1])),
    ...ob.asks.map(a=>Number(a[1]))
  ];

  const avg = sizes.reduce((a,b)=>a+b,0) / sizes.length;
  const max = Math.max(...sizes);

  // 🔥 grote afwijking = mogelijk spoof
  return max > avg * 6;
}

// ================= COMPLETE ANALYSE =================
export function analyzeOrderBookAdvanced(ob){

  if(!ob){
    return { bias:"NEUTRAL", spoof:false };
  }

  const bidVol = ob.bids.reduce((a,b)=>a+Number(b[1]),0);
  const askVol = ob.asks.reduce((a,b)=>a+Number(b[1]),0);

  const ratio = bidVol / (askVol || 1);

  let bias = "NEUTRAL";

  if(ratio > 1.3) bias = "BULLISH";
  if(ratio < 0.7) bias = "BEARISH";

  return {
    bias,
    spoof: detectSpoofing(ob),
    ...detectWalls(ob)
  };
}