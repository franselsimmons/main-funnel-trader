import { kv } from "@vercel/kv"

async function fetchPrice(symbol) {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`
  )
  if (!res.ok) return null
  const data = await res.json()
  return parseFloat(data.price)
}

export default async function handler(req, res) {

  const trades = await kv.get("trade:active") || []

  const updated = []

  for (const t of trades) {

    const currentPrice = await fetchPrice(t.symbol)

    if (!currentPrice) {
      updated.push(t)
      continue
    }

    if (t.direction === "LONG") {

      if (currentPrice >= t.takeProfit) {
        updated.push({ ...t, status: "WIN" })
        continue
      }

      if (currentPrice <= t.stopLoss) {
        updated.push({ ...t, status: "LOSS" })
        continue
      }
    }

    updated.push(t)
  }

  await kv.set("trade:active", updated)

  res.json({ ok: true })
}