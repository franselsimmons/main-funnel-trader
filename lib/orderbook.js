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

export function analyzeOrderBookAdvanced(ob){

  if(!ob?.bids || !ob?.asks){
    return { bias:"NEUTRAL", spoof:false };
  }

  const bidVol = ob.bids.reduce((a,b)=>a+Number(b[1]),0);
  const askVol = ob.asks.reduce((a,b)=>a+Number(b[1]),0);

  const ratio = bidVol / (askVol || 1);

  let bias = "NEUTRAL";

  if(ratio > 1.3) bias = "BULLISH";
  if(ratio < 0.7) bias = "BEARISH";

  // spoof detectie
  const sizes = [
    ...ob.bids.map(b=>Number(b[1])),
    ...ob.asks.map(a=>Number(a[1]))
  ];

  const avg = sizes.reduce((a,b)=>a+b,0)/sizes.length;
  const max = Math.max(...sizes);

  const spoof = max > avg * 6;

  return { bias, spoof };
}