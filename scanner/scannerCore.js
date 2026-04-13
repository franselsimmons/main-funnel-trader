import {
  detectSweep,
  calculateSVI,
  deltaDivergence,
  computeEdgeProbability
} from "../core/liquidityEngine.js"

export function scanSymbol(symbolData) {
  const { candles, metrics } = symbolData

  const { swept } = detectSweep(candles)

  if (!swept) return null

  const svi = calculateSVI(
    candles[candles.length - 1],
    metrics.avgVolume,
    metrics.atr
  )

  const divergence = deltaDivergence(candles)

  const probability =
    computeEdgeProbability({ svi, divergence })

  if (probability < 0.6) return null

  return {
    symbol: symbolData.symbol,
    edgeType: "LiquiditySweep",
    probability,
    svi,
    timestamp: Date.now()
  }
}