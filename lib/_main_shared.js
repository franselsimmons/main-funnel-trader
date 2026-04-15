export async function fetchCoinGeckoTopCached() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h";

  const res = await fetch(url);
  const data = await res.json();

  return data;
}