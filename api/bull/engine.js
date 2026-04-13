import { kv } from "@vercel/kv"

async function fetchCandles(symbol) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=100`
  )
  if (!res.ok) return null
  return await res.json()
}

function calculateEMA(data, period) {
  const k = 2 / (period + 1)
  let ema = parseFloat(data[0][4])
  for (let i = 1; i < data.length; i++) {
    const close = parseFloat(data[i][4])
    ema = close * k + ema * (1 - k)
  }
  return ema
}

function calculateRSI(data, period = 14) {
  let gains = 0
  let losses = 0

  for (let i = data.length - period; i < data.length - 1; i++) {
    const diff =
      parseFloat(data[i + 1][4]) - parseFloat(data[i][4])
    if (diff > 0) gains += diff
    else losses -= diff
  }

  const rs = gains / (losses || 1)
  return 100 - 100 / (1 + rs)
}

function calculateATR(data, period = 14) {
  let sum = 0

  for (let i = data.length - period; i < data.length; i++) {
    const high = parseFloat(data[i][2])
    const low = parseFloat(data[i][3])
    sum += high - low
  }

  return sum / period
}

async function btcBullish() {
  const candles = await fetchCandles("BTC")
  if (!candles) return false
  const ema50 = calculateEMA(candles, 50)
  const ema200 = calculateEMA(candles, 200)
  return ema50 > ema200
}

export default async function handler(req, res) {

  const universe = await kv.get("bull:universe") || []
  const btcOk = await btcBullish()

  if (!btcOk) {
    return res.json({ ok: true, qualified: 0, reason: "BTC bearish" })
  }

  const qualified = []

  for (const coin of universe.slice(0, 40)) {

    const candles = await fetchCandles(coin.symbol)
    if (!candles) continue

    const ema50 = calculateEMA(candles, 50)
    const ema200 = calculateEMA(candles, 200)
    const rsi = calculateRSI(candles)
    const atr = calculateATR(candles)
    const price = parseFloat(candles[candles.length - 1][4])

    const trend = ema50 > ema200
    const momentum = rsi > 55
    const volatility = atr / price > 0.01

    if (trend && momentum && volatility) {
      qualified.push({
        symbol: coin.symbol,
        price,
        rsi,
        atr,
        created: Date.now()
      })
    }
  }

  await kv.set("bull:qualified", qualified)

  res.json({
    ok: true,
    qualified: qualified.length
  })
}