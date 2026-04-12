import { spreadStable } from "../core/liquidityEngine.js"
import { continuationMomentum } from "../core/momentumEngine.js"
import { computeRegime } from "../core/regimeEngine.js"

export async function runScanner({
  mode,
  config,
  sharedConfig,
  marketData,
  btcData
}) {
  const regime = computeRegime(
    btcData.change24h,
    btcData.volatility
  )

  const candidates = []

  for (const coin of marketData) {

    const spreadMean = coin.spreadMean || 0.5
    const spreadVar = coin.spreadVariance || 0.1

    const liquidityOk = spreadStable(
      spreadMean,
      spreadVar,
      sharedConfig.maxSpreadMean,
      sharedConfig.maxSpreadVariance
    )

    if (!liquidityOk) continue

    const momentumOk = continuationMomentum(
      coin.change1h,
      config.momentum1hMin,
      config.momentum1hMax
    )

    if (!momentumOk) continue

    const momentumScore =
      Math.abs(coin.change1h) * 30 +
      Math.abs(coin.change24h) * 5

    candidates.push({
      symbol: coin.symbol,
      regime,
      momentumScore,
      change1h: coin.change1h,
      change24h: coin.change24h,
      beta: coin.beta || 0.6,
      spreadMean,
      spreadVar
    })
  }

  return {
    regime,
    candidates
  }
}