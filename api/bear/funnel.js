import { kv } from "@vercel/kv"

export default async function handler(req, res) {

  const signals = await kv.get("bear:engine:signals") || []

  const approved = signals.slice(0, 3).map(c => ({
    symbol: c.symbol,
    price: c.price,
    change24h: c.change24h,
    volume: c.volume,
    direction: "SHORT",
    timestamp: Date.now()
  }))

  await kv.set("bear:approved", approved)

  res.json({ ok: true, approved })
}