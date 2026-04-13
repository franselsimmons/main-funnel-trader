import { detectSweep, calculateSVI, deltaDivergence, computeEdgeProbability } from "../core/liquidityEngine.js"
import { detectVolatilityRegime } from "../core/regimeEngine.js"
import { getRiskMultiplier } from "../core/riskEngine.js"

export function processEdge(candles, metrics) {
  const { swept } = detectSweep(candles)

  if (!swept) return null

  const svi = calculateSVI(
    candles[candles.length - 1],
    metrics.avgVolume,
    metrics.atr
  )

  const divergence = deltaDivergence(candles)

  const probability = computeEdgeProbability({ svi, divergence })

  if (probability < 0.65) return null

  const regime = detectVolatilityRegime(metrics.atrPercentile)

  const riskMultiplier = getRiskMultiplier()

  return {
    direction: "long",
    probability,
    regime: regime.regime,
    positionSizeFactor: regime.weight * riskMultiplier
  }
}