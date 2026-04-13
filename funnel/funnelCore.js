export function checkExposure(portfolio, maxExposure = 0.2) {
  const totalExposure =
    portfolio.reduce((a, b) => a + b.size, 0)

  return totalExposure < maxExposure
}

export function applyKelly(probability, rr) {
  const edge = (probability * rr) - (1 - probability)
  const kelly = edge / rr

  return Math.max(0, Math.min(kelly, 0.02))
}

export function correlationBlock(portfolio, symbol) {
  const cluster = portfolio.filter(p =>
    p.symbol.slice(0, 3) === symbol.slice(0, 3)
  )

  return cluster.length < 2
}