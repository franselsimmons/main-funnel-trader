// ================= BTC CONTEXT =================
export async function fetchBTCGateFromUniverse(){
  return {
    state:"BULLISH",
    chg24:2.3
  };
}


// ================= COINGECKO MULTI FETCH =================
export async function fetchCoinGeckoTopCached(){

  try{

    const pages = [1,2,3,4]; // 🔥 1000 coins

    const results = await Promise.all(
      pages.map(p =>
        fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${p}&price_change_percentage=1h,24h`
        ).then(r=>r.json())
      )
    );

    // flatten
    const flat = results.flat();

    // 🔥 dedupe symbols
    const seen = new Set();

    const cleaned = flat.filter(c=>{
      if(!c?.symbol) return false;

      const key = c.symbol.toUpperCase();

      if(seen.has(key)) return false;

      seen.add(key);
      return true;
    });

    return cleaned;

  }catch(err){

    console.error("COINGECKO ERROR:", err);

    // fallback → 1 page
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=1h,24h"
    );

    return await res.json();
  }
}


// ================= SHALLOW ORDERBOOK =================
export function generateShallowOb(){
  return {
    spreadPct:0.07,
    score:0.06,
    depthMinUsd1p:200000
  };
}