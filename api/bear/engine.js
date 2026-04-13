import { kv } from "@vercel/kv"

function calculateSignal(coin) {

  const strongMomentum = coin.change24h < -2
  const strongVolume = coin.volume > 5000000

  if (!strongMomentum || !strongVolume) return null

  const entry = coin.price
  const stopLoss = entry * 1.03
  const takeProfit = entry * 0.94

  return {
    symbol: coin.symbol,
    direction: "SHORT",
    entry,
    stopLoss,
    takeProfit,
    rr: ((entry - takeProfit) / (stopLoss - entry)).toFixed(2),
    volume: coin.volume,
    change24h: coin.change24h,
    timestamp: Date.now()
  }
}

export default async function handler(req, res) {

  const scanner = await kv.get("bear:scanner:candidates") || []

  const signals = scanner
    .map(calculateSignal)
    .filter(Boolean)
    .slice(0, 5)

  await kv.set("bear:engine:signals", signals)

  res.json({ ok: true, signals })
}