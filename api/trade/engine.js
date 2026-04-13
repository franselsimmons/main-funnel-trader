import { kv } from "@vercel/kv"

async function fetchOrderBook(symbol) {
  const res = await fetch(
    `https://api.binance.com/api/v3/depth?symbol=${symbol}USDT&limit=50`
  )
  if (!res.ok) return null
  return await res.json()
}

export default async function handler(req, res) {

  const queue = await kv.get("trade:queue") || []
  const active = []

  for (const coin of queue) {

    const book = await fetchOrderBook(coin.symbol)
    if (!book) continue

    const bidVol = book.bids.reduce((a,b)=>a+parseFloat(b[1]),0)
    const askVol = book.asks.reduce((a,b)=>a+parseFloat(b[1]),0)

    if (bidVol > askVol * 1.2) {

      active.push({
        symbol: coin.symbol,
        entryType: "pullback",
        status: "LIVE",
        created: Date.now()
      })
    }
  }

  await kv.set("trade:active", active)

  res.json({ ok: true, active: active.length })
}