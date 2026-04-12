export function buildBuckets(trades) {

  const buckets = {
    momentum: {},
    spread: {},
    beta: {}
  }

  for (const t of trades) {

    const momKey = Math.round(t.change1h)
    const spreadKey = Math.round(t.spreadMean)
    const betaKey = Math.round(t.beta * 10) / 10

    if (!buckets.momentum[momKey])
      buckets.momentum[momKey] = []

    if (!buckets.spread[spreadKey])
      buckets.spread[spreadKey] = []

    if (!buckets.beta[betaKey])
      buckets.beta[betaKey] = []

    buckets.momentum[momKey].push(t)
    buckets.spread[spreadKey].push(t)
    buckets.beta[betaKey].push(t)
  }

  return buckets
}