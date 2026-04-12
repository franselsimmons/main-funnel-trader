export function computeBetaExposure(openPositions) {
  return openPositions.reduce((sum, p) => sum + p.beta, 0)
}

export function betaAllowed(totalBeta, candidateBeta, limit) {
  return totalBeta + candidateBeta <= limit
}