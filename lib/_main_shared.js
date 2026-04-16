export async function fetchBTCGateFromUniverse(){
  return {
    state:"BULLISH",
    chg24:2.3
  };
}

export async function fetchCoinGeckoTopCached(){

  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=1h,24h"
  );

  return await res.json();
}

export function generateShallowOb(){
  return {
    spreadPct:0.07,
    score:0.06,
    depthMinUsd1p:200000
  };
}