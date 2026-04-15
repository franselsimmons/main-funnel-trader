export async function fetchBTCGateFromUniverse() {
  return {
    state: "BULLISH",
    chg24: 2.1,
    range24: 4.2
  };
}

export async function fetchCoinGeckoTopCached() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h"
  );

  return await res.json();
}

export async function fetchFuturesTickers() {
  return new Map();
}

export function generateShallowOb() {
  return {
    spreadPct: 0.05,
    score: 0.05,
    depthMinUsd1p: 100000
  };
}