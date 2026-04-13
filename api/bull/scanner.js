import { kv } from "@vercel/kv"

async function fetchUniverse() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=200&page=1"
  )
  return await res.json()
}

export default async function handler(req, res) {

  const raw = await fetchUniverse()
  const existing = await kv.get("bull:stage1") || []

  const map = new Map(existing.map(c => [c.symbol, c]))

  for (const c of raw) {
    if (c.total_volume < 1000000) continue

    if (!map.has(c.symbol.toUpperCase())) {
      map.set(c.symbol.toUpperCase(), {
        symbol: c.symbol.toUpperCase(),
        stage: 1,
        history: [],
        created: Date.now()
      })
    }
  }

  await kv.set("bull:stage1", Array.from(map.values()))
  await kv.set("bull:lastScan", Date.now())

  res.json({ ok: true, total: map.size })
}