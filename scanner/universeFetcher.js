import { fetchJsonWithTimeout } from "../core/fetcher.js"
import { computeRegime } from "../core/regimeEngine.js"

export async function fetchAdaptiveUniverse(btcData) {

  const regime = computeRegime(btcData)

  const sizeMap = {
    EXPANSION: 300,
    TREND: 200,
    NEUTRAL: 150,
    CHOP: 100,
    RISK_OFF: 80
  }

  const volumeMap = {
    EXPANSION: 1000000,
    TREND: 2000000,
    NEUTRAL: 3000000,
    CHOP: 5000000,
    RISK_OFF: 8000000
  }

  const limit = sizeMap[regime]
  const minVolume = volumeMap[regime]

  const cg = await fetchJsonWithTimeout(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${limit}&page=1&price_change_percentage=1h,24h`
  )

  const bitgetContracts = await fetchJsonWithTimeout(
    "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES"
  )

  const futuresSet = new Set(
    bitgetContracts?.data?.map(c =>
      c.symbol.replace("USDT", "")
    ) || []
  )

  const filtered = cg
    .filter(c =>
      c.total_volume > minVolume &&
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

  return {
    regime,
    universeSize: filtered.length,
    coins: filtered
  }
}