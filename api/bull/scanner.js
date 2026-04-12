import { kv } from "@vercel/kv"

async function fetchUniverse() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=150&page=1"
  )

  if (!res.ok) throw new Error("CoinGecko fetch failed")

  const data = await res.json()

  return data.map(c => ({
    symbol: c.symbol.toUpperCase(),
    price: c.current_price,
    volume: c.total_volume,
    marketCap: c.market_cap,
    change24h: c.price_change_percentage_24h || 0
  }))
}

export default async function handler(req, res) {
  try {
    const universe = await fetchUniverse()

    const filtered = universe
      .filter(c => c.marketCap > 20000000 && c.volume > 2000000)
      .slice(0, 100)

    await kv.set("bull:scanner:candidates", filtered)
    await kv.set("bull:scanner:lastScan", Date.now())

    res.json({ ok: true, count: filtered.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}