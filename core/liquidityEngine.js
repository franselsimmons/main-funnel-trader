export function detectSweep(candles, lookback = 20) {
  const latest = candles[candles.length - 1]
  const prev = candles.slice(-lookback - 1, -1)

  const pivotLow = Math.min(...prev.map(c => c.low))

  const swept = latest.low < pivotLow && latest.close > pivotLow

  return {
    swept,
    pivotLow
  }
}

export function calculateSVI(latestCandle, avgVolume, atr) {
  const normalizedVolume = latestCandle.volume / avgVolume
  const volatilityFactor = atr > 0 ? atr : 1

  return normalizedVolume / volatilityFactor
}

export function deltaDivergence(candles) {
  const latest = candles[candles.length - 1]
  const prev = candles[candles.length - 2]

  const priceLowerLow = latest.low < prev.low
  const volumeDrop = latest.volume < prev.volume

  return priceLowerLow && volumeDrop
}

export function computeEdgeProbability({ svi, divergence }) {
  let score = 0

  score += Math.min(svi / 3, 1) * 0.6
  if (divergence) score += 0.4

  return Math.min(score, 1)
}