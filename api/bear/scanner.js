import { runBearScanner } from "../../scanner/scannerBear.js"
import { setKey } from "../../storage/kv.js"
import { scannerKey } from "../../storage/stateManager.js"

export default async function handler(req, res) {

  const marketData = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&price_change_percentage=1h,24h"
  ).then(r => r.json())

  const btcData = {
    change24h: marketData[0]?.price_change_percentage_24h || 0,
    volatility: 1.1
  }

  const formatted = marketData.map(c => ({
    symbol: c.symbol.toUpperCase(),
    change1h: c.price_change_percentage_1h,
    change24h: c.price_change_percentage_24h,
    spreadMean: 0.5,
    spreadVariance: 0.1,
    beta: 0.6
  }))

  const result = await runBearScanner(formatted, btcData)

  await setKey(scannerKey("bear"), result)

  res.json(result)
}