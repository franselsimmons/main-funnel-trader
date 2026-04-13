import {
  detectSweepLong,
  detectSweepShort,
  calculateSVI,
  computeEdgeProbability
} from "../core/liquidityEngine.js"

export function scanSymbol(symbolData, side = "LONG") {
  const { candles, metrics } = symbolData

  const detection =
    side === "LONG"
      ? detectSweepLong(candles)
      : detectSweepShort(candles)

  if (!detection.swept) return null

  const svi = calculateSVI(
    candles[candles.length - 1],
    metrics.avgVolume,
    metrics.atr
  )

  const probability =
    computeEdgeProbability({ svi })

  if (probability < 0.6) return null

  return {
    symbol: symbolData.symbol,
    side,
    probability,
    svi,
    atr: metrics.atr,
    entry: candles[candles.length - 1].close,
    timestamp: Date.now()
  }
}