import { kv } from "@vercel/kv"

function calculateSignal(coin) {

  // Trend filter
  const strongMomentum = coin.change24h > 2
  const strongVolume = coin.volume > 5000000

  if (!strongMomentum || !strongVolume) return null

  const entry = coin.price
  const stopLoss = entry * 0.97
  const takeProfit = entry * 1.06

  return {
    symbol: coin.symbol,
    direction: "LONG",
    entry,
    stopLoss,
    takeProfit,
    rr: ((takeProfit - entry) / (entry - stopLoss)).toFixed(2),
    volume: coin.volume,
    change24h: coin.change24h,
    timestamp: Date.now()
  }
}

export default async function handler(req, res) {

  const scanner = await kv.get("bull:scanner:candidates") || []

  const signals = scanner
    .map(calculateSignal)
    .filter(Boolean)
    .slice(0, 5)

  await kv.set("bull:engine:signals", signals)

  res.json({ ok: true, signals })
}