import { SHARED_CONFIG } from "../config/shared.js"
import { BULL_CONFIG } from "../config/bull.js"
import { BEAR_CONFIG } from "../config/bear.js"

export function runFunnel({
  mode,
  scannerOutput,
  openPositions,
  portfolioState
}) {

  const config = mode === "bull" ? BULL_CONFIG : BEAR_CONFIG
  const shared = SHARED_CONFIG

  const regime = scannerOutput.regime
  const candidates = scannerOutput.candidates || []

  const approved = []

  const currentBetaExposure = calculateBetaExposure(openPositions)
  const capacityLeft =
    shared.maxOpenPositions - openPositions.length

  if (capacityLeft <= 0) {
    return {
      approved: [],
      blockedReason: "capacity_full"
    }
  }

  for (const c of candidates) {

    if (!dynamicThresholdPass(c, regime, config)) continue

    if (!betaLimitPass(
      currentBetaExposure,
      c.beta,
      shared.maxBetaExposure
    )) continue

    if (!spreadQualityPass(c, shared)) continue

    approved.push({
      ...c,
      score: computeFinalScore(c)
    })
  }

  approved.sort((a, b) => b.score - a.score)

  return {
    regime,
    approved: approved.slice(0, capacityLeft),
    blockedReason: null
  }
}