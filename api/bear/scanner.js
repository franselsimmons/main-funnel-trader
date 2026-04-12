import { kv } from "@vercel/kv"

async function fetchUniverse() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=150&page=1",
    {
      headers: {
        "Accept": "application/json"
      }
    }
  )

  if (!res.ok) {
    throw new Error("CoinGecko fetch failed")
  }

  const data = await res.json()

  if (!Array.isArray(data)) return []

  return data.map(c => ({
    symbol: c.symbol.toUpperCase(),
    name: c.name,
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
      .filter(c =>
        c.marketCap > 20000000 &&
        c.volume > 2000000
      )
      // Bear = zwakke coins eerst
      .sort((a, b) => a.change24h - b.change24h)
      .slice(0, 100)

    await kv.set("bear:scanner:candidates", filtered)
    await kv.set("bear:scanner:lastScan", Date.now())

    return res.json({
      ok: true,
      count: filtered.length
    })

  } catch (e) {
    console.error("Bear scanner error:", e)
    return res.status(500).json({ error: e.message })
  }
}