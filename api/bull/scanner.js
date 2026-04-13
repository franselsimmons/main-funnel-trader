import { kv } from "@vercel/kv"

async function fetchUniverse() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1"
  )

  if (!res.ok) throw new Error("Fetch failed")

  return await res.json()
}

export default async function handler(req, res) {
  try {
    const raw = await fetchUniverse()

    const universe = raw
      .filter(c => c.total_volume > 1000000)
      .map(c => ({
        symbol: c.symbol.toUpperCase(),
        price: c.current_price,
        change24h: c.price_change_percentage_24h || 0,
        volume: c.total_volume,
        marketCap: c.market_cap
      }))

    await kv.set("bull:universe", universe)
    await kv.set("bull:lastScan", Date.now())

    res.json({ ok: true, total: universe.length })

  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}