import { fetchJsonWithTimeout } from "../core/fetcher.js"

export async function fetchUniverse() {

  const cg = await fetchJsonWithTimeout(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=1h,24h"
  )

  const bitgetContracts = await fetchJsonWithTimeout(
    "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES"
  )

  const futuresSet = new Set(
    bitgetContracts?.data?.map(c => c.symbol.replace("USDT", "")) || []
  )

  return cg
    .filter(c =>
      c.market_cap > 20000000 &&
      c.total_volume > 2000000 &&
      futuresSet.has(c.symbol.toUpperCase())
    )
    .map(c => ({
      symbol: c.symbol.toUpperCase(),
      price: c.current_price,
      change1h: c.price_change_percentage_1h || 0,
      change24h: c.price_change_percentage_24h || 0,
      marketcap: c.market_cap,
      volume: c.total_volume
    }))
}