// ================= BTC CONTEXT =================
export async function fetchBTCGateFromUniverse(){
  return {
    state: "BULLISH",
    chg24: 2.3
  };
}


// ================= COINGECKO MULTI FETCH =================
export async function fetchCoinGeckoTopCached(){

  const urlForPage = (page) =>
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${page}&price_change_percentage=1h,24h`;

  const dedupeBySymbol = (items) => {
    const seen = new Set();

    return items.filter((c) => {
      if(!c?.symbol) return false;

      const key = String(c.symbol).toUpperCase();
      if(seen.has(key)) return false;

      seen.add(key);
      return true;
    });
  };

  try{
    const pages = [1, 2, 3, 4];

    const results = await Promise.all(
      pages.map(async (p) => {
        const res = await fetch(urlForPage(p));
        if(!res.ok){
          throw new Error(`CoinGecko page ${p} failed: ${res.status}`);
        }
        return res.json();
      })
    );

    const flat = results.flat();
    return dedupeBySymbol(flat);

  }catch(err){

    console.error("COINGECKO ERROR:", err);

    try{
      const res = await fetch(urlForPage(1));
      if(!res.ok){
        throw new Error(`CoinGecko fallback failed: ${res.status}`);
      }

      const data = await res.json();
      return dedupeBySymbol(Array.isArray(data) ? data : []);
    }catch(fallbackErr){
      console.error("COINGECKO FALLBACK ERROR:", fallbackErr);
      return [];
    }
  }
}


// ================= BITGET FUTURES TICKERS =================
export async function fetchFuturesTickers(){

  const endpoints = [
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES",
    "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl"
  ];

  let lastError = null;

  for(const url of endpoints){
    try{
      const res = await fetch(url);

      if(!res.ok){
        throw new Error(`Bitget ticker request failed: ${res.status}`);
      }

      const json = await res.json();
      const rows = Array.isArray(json?.data) ? json.data : [];

      const map = new Map();

      for(const row of rows){
        const rawSymbol =
          row?.symbol ||
          row?.instId ||
          row?.ticker ||
          "";

        if(!rawSymbol) continue;

        map.set(String(rawSymbol).toUpperCase(), row);
      }

      if(map.size > 0){
        return map;
      }

    }catch(err){
      lastError = err;
      console.error("BITGET FUTURES ERROR:", err.message);
    }
  }

  throw lastError || new Error("Unable to fetch Bitget futures tickers");
}


// ================= SHALLOW ORDERBOOK =================
export function generateShallowOb(){
  return {
    spreadPct: 0.07,
    score: 0.06,
    depthMinUsd1p: 200000
  };
}