export function calculateBetaExposure(openPositions) {
  return openPositions.reduce(
    (sum, p) => sum + (p.beta || 0),
    0
  )
}

export function betaLimitPass(
  currentExposure,
  candidateBeta,
  maxBeta
) {
  return currentExposure + candidateBeta <= maxBeta
}

export function dynamicThresholdPass(
  candidate,
  regime,
  config
) {
  let threshold = config.momentumThreshold

  if (regime === "CHOP") threshold += 0.5
  if (regime === "EXPANSION") threshold -= 0.3

  return Math.abs(candidate.change1h) >= threshold
}

export function spreadQualityPass(candidate, shared) {
  if (candidate.spreadMean > shared.maxSpreadMean) return false
  if (candidate.spreadVar > shared.maxSpreadVariance) return false
  return true
}

export function computeFinalScore(c) {
  return (
    c.momentumScore * 0.6 +
    (1 / (c.spreadMean + 0.01)) * 20 +
    (1 - c.beta) * 10
  )
}