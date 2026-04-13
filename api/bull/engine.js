import { kv } from "@vercel/kv"

async function fetchCandles(symbol) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=50`
  )
  if (!res.ok) return null
  return await res.json()
}

export default async function handler(req, res) {

  const stage1 = await kv.get("bull:stage1") || []
  const stage2 = await kv.get("bull:stage2") || []

  const stage2Map = new Map(stage2.map(c => [c.symbol, c]))

  for (const coin of stage1) {

    const candles = await fetchCandles(coin.symbol)
    if (!candles) continue

    const closes = candles.map(c => parseFloat(c[4]))
    const change = (closes[closes.length - 1] - closes[0]) / closes[0]

    if (change > 0.03) {
      stage2Map.set(coin.symbol, {
        ...coin,
        stage: 2,
        momentumConfirmed: true
      })
    }
  }

  await kv.set("bull:stage2", Array.from(stage2Map.values()))

  res.json({ ok: true, promoted: stage2Map.size })
}