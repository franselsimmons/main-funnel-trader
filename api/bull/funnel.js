import { kv } from "@vercel/kv"

async function fetchCandles(symbol) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=50`
  )
  if (!res.ok) return null
  return await res.json()
}

export default async function handler(req, res) {

  const stage2 = await kv.get("bull:stage2") || []
  const stage3 = await kv.get("bull:stage3") || []

  const stage3Map = new Map(stage3.map(c => [c.symbol, c]))

  for (const coin of stage2) {

    const candles = await fetchCandles(coin.symbol)
    if (!candles) continue

    const volumes = candles.map(c => parseFloat(c[5]))
    const avgVol = volumes.reduce((a,b)=>a+b,0)/volumes.length
    const latestVol = volumes[volumes.length-1]

    if (latestVol > avgVol * 1.5) {
      stage3Map.set(coin.symbol, {
        ...coin,
        stage: 3,
        volumeConfirmed: true
      })
    }
  }

  const qualified = Array.from(stage3Map.values())

  await kv.set("bull:stage3", qualified)

  // Handoff to trade engine
  await kv.set("trade:queue", qualified)

  res.json({ ok: true, qualified: qualified.length })
}