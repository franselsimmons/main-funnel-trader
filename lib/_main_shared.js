// ================= BTC CONTEXT =================
export async function fetchBTCGateFromUniverse(){
  return {
    state: "BULLISH",
    chg24: 2.3
  };
}


// ================= COINGECKO =================
export async function fetchCoinGeckoTopCached(){

  const url = (p) =>
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${p}&price_change_percentage=1h,24h`;

  try{

    const pages = [1,2,3,4];

    const res = await Promise.all(
      pages.map(p => fetch(url(p)).then(r=>r.json()))
    );

    const flat = res.flat();
    const seen = new Set();

    return flat.filter(c=>{
      const sym = c?.symbol?.toUpperCase();
      if(!sym) return false;
      if(seen.has(sym)) return false;
      seen.add(sym);
      return true;
    });

  }catch{
    return [];
  }
}


// ================= BITGET FUTURES =================
export async function fetchFuturesTickers(){

  try{
    const res = await fetch(
      "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl"
    );

    const json = await res.json();
    const map = new Map();

    for(const t of json?.data || []){
      if(!t.symbol?.endsWith("USDT")) continue;

      map.set(t.symbol, {
        price: Number(t.last),
        volume: Number(t.baseVolume)
      });
    }

    return map;

  }catch(e){
    console.error("BITGET ERROR:", e.message);
    return new Map();
  }
}


// ================= SHALLOW OB =================
export function generateShallowOb(){
  return {
    spreadPct: 0.07,
    depthMinUsd1p: 200000
  };
}