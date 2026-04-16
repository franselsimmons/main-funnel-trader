export async function fetchOrderBook(symbol){

  try{

    const res = await fetch(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`
    );

    const data = await res.json();

    return data;

  }catch(e){
    return null;
  }
}


// ================= ANALYSE =================

export function analyzeOrderBookDepth(ob){

  if(!ob || !ob.bids || !ob.asks){
    return { bias:"NEUTRAL", strength:0 };
  }

  const bids = ob.bids.map(b=>Number(b[1]));
  const asks = ob.asks.map(a=>Number(a[1]));

  const bidVol = bids.reduce((a,b)=>a+b,0);
  const askVol = asks.reduce((a,b)=>a+b,0);

  const ratio = bidVol / (askVol || 1);

  if(ratio > 1.3){
    return { bias:"BULLISH", strength:ratio };
  }

  if(ratio < 0.7){
    return { bias:"BEARISH", strength:ratio };
  }

  return { bias:"NEUTRAL", strength:ratio };
}