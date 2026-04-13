export function checkExposure(portfolio, maxExposure = 0.2) {
  const total =
    portfolio.reduce((a, b) => a + b.size, 0)
  return total < maxExposure
}

export function applyKelly(probability, rr) {
  const edge = (probability * rr) - (1 - probability)
  const kelly = edge / rr
  return Math.max(0, Math.min(kelly, 0.02))
}