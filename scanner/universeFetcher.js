function chunkArray(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

async function fetchCandles(symbol) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`
  )

  const candlesRaw = await res.json()

  const candles = candlesRaw.map(c => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  }))

  const avgVolume =
    candles.reduce((a, b) => a + b.volume, 0) / candles.length

  const atr =
    candles
      .slice(1)
      .map((c, i) =>
        Math.max(
          c.high - c.low,
          Math.abs(c.high - candles[i].close),
          Math.abs(c.low - candles[i].close)
        )
      )
      .reduce((a, b) => a + b, 0) / (candles.length - 1)

  return {
    candles,
    metrics: { avgVolume, atr }
  }
}

export async function fetchUniverse() {

  const res = await fetch(
    "https://api.binance.com/api/v3/ticker/24hr"
  )

  const data = await res.json()

  const filtered =
    data
      .filter(c => c.symbol.endsWith("USDT"))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 120) // 🔥 nu 120 coins

  const chunks = chunkArray(filtered, 20) // 20 tegelijk

  const results = []

  for (const batch of chunks) {
    const batchResults = await Promise.all(
      batch.map(async (coin) => {
        const candleData =
          await fetchCandles(coin.symbol)

        return {
          symbol: coin.symbol,
          ...candleData
        }
      })
    )

    results.push(...batchResults)
  }

  return results
}