export function detectSweepLong(candles, lookback = 20) {
  const latest = candles[candles.length - 1]
  const prev = candles.slice(-lookback - 1, -1)

  const pivotLow = Math.min(...prev.map(c => c.low))

  const swept =
    latest.low < pivotLow &&
    latest.close > pivotLow

  return { swept, pivotLow }
}

export function detectSweepShort(candles, lookback = 20) {
  const latest = candles[candles.length - 1]
  const prev = candles.slice(-lookback - 1, -1)

  const pivotHigh = Math.max(...prev.map(c => c.high))

  const swept =
    latest.high > pivotHigh &&
    latest.close < pivotHigh

  return { swept, pivotHigh }
}

export function calculateSVI(latest, avgVolume, atr) {
  if (!avgVolume || !atr) return 0
  const normalizedVolume = latest.volume / avgVolume
  return normalizedVolume / atr
}

export function computeEdgeProbability({ svi }) {
  return Math.min(svi / 3, 1)
}