// lib/_main_shared.js

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBitgetUniverseSymbol(symbol){
  let clean = String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if(!clean){
    return "";
  }

  if(clean.endsWith("USDC")){
    return "";
  }

  if(clean.endsWith("USDT")){
    return clean;
  }

  return `${clean}USDT`;
}

function extractBitgetTickerRows(json){
  if(Array.isArray(json?.data?.list)){
    return json.data.list;
  }

  if(Array.isArray(json?.data)){
    return json.data;
  }

  if(Array.isArray(json?.list)){
    return json.list;
  }

  return [];
}


// ================= BTC CONTEXT =================
export async function fetchBTCGateFromUniverse(){
  try{
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h",
      {
        headers: {
          accept: "application/json"
        }
      }
    );

    if(!res.ok){
      throw new Error(`btc_gate_http_${res.status}`);
    }

    const data = await res.json();
    const btc = Array.isArray(data) ? data[0] : null;
    const chg24 = safeNumber(btc?.price_change_percentage_24h, 0);

    return {
      state: chg24 > 0 ? "BULLISH" : chg24 < 0 ? "BEARISH" : "NEUTRAL",
      chg24
    };
  }catch{
    return {
      state: "UNKNOWN",
      chg24: 0
    };
  }
}


// ================= COINGECKO =================
export async function fetchCoinGeckoTopCached(){
  const buildUrl = (page) =>
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=1h,24h`;

  const pages = [1, 2, 3, 4];

  try{
    const results = await Promise.allSettled(
      pages.map(async (page) => {
        const res = await fetch(buildUrl(page), {
          headers: {
            accept: "application/json"
          }
        });

        if(!res.ok){
          throw new Error(`coingecko_http_${res.status}`);
        }

        const json = await res.json();
        return Array.isArray(json) ? json : [];
      })
    );

    const flat = [];
    for(const result of results){
      if(result.status === "fulfilled"){
        flat.push(...result.value);
      }
    }

    if(!flat.length){
      return [];
    }

    const bestBySymbol = new Map();

    for(const coin of flat){
      const symbol = String(coin?.symbol || "").toUpperCase().trim();
      if(!symbol) continue;

      const prev = bestBySymbol.get(symbol);
      const prevVol = safeNumber(prev?.total_volume, 0);
      const currVol = safeNumber(coin?.total_volume, 0);

      if(!prev || currVol > prevVol){
        bestBySymbol.set(symbol, coin);
      }
    }

    return Array.from(bestBySymbol.values());
  }catch{
    return [];
  }
}


// ================= BITGET FUTURES =================
export async function fetchFuturesTickers(){
  const endpoints = [
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES",
    "https://api.bitget.com/api/mix/v1/market/tickers?productType=umcbl"
  ];

  let lastError = null;

  for(const url of endpoints){
    try{
      const res = await fetch(url, {
        headers: {
          accept: "application/json"
        }
      });

      if(!res.ok){
        throw new Error(`bitget_http_${res.status}`);
      }

      const json = await res.json();
      const rows = extractBitgetTickerRows(json);

      if(!rows.length){
        continue;
      }

      const map = new Map();

      for(const row of rows){
        const rawSymbol =
          row?.symbol ||
          row?.instId ||
          row?.ticker ||
          row?.symbolName ||
          "";

        const symbol = normalizeBitgetUniverseSymbol(rawSymbol);
        if(!symbol) continue;

        const price = safeNumber(
          row?.lastPr ??
          row?.last ??
          row?.close ??
          row?.markPrice,
          0
        );

        const volume = safeNumber(
          row?.baseVolume ??
          row?.baseVol ??
          row?.usdtVolume ??
          row?.quoteVolume ??
          row?.turnover ??
          row?.volume,
          0
        );

        if(price <= 0){
          continue;
        }

        map.set(symbol, {
          symbol,
          rawSymbol,
          price,
          volume
        });
      }

      if(map.size > 0){
        return map;
      }
    }catch(err){
      lastError = err;
    }
  }

  if(lastError){
    console.error("BITGET ERROR:", lastError.message);
  }

  return new Map();
}


// ================= SHALLOW OB =================
export function generateShallowOb(){
  return {
    spreadPct: 0.07,
    depthMinUsd1p: 200000
  };
}