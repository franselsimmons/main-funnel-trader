export function analyseMomentumBuckets(buckets) {

  for (const key in buckets.momentum) {

    const trades = buckets.momentum[key]
    if (trades.length < 10) continue

    const winrate =
      trades.filter(t => t.pnl > 0).length /
      trades.length

    if (winrate > 0.7) {
      return {
        type: "Momentum Threshold Suggestion",
        message:
          `Trades met 1H momentum >= ${key}% hebben ${Math.round(winrate * 100)}% winrate.`,
        suggestedChange:
          `Verhoog momentumThreshold naar ${key}`,
        confidence: winrate
      }
    }
  }

  return null
}

export function analyseSpreadBuckets(buckets) {

  for (const key in buckets.spread) {

    const trades = buckets.spread[key]
    if (trades.length < 10) continue

    const avgPnl =
      trades.reduce((a, b) => a + b.pnl, 0) /
      trades.length

    if (avgPnl < 0) {
      return {
        type: "Spread Stability Suggestion",
        message:
          `Spread bucket ${key}% toont negatieve expectancy.`,
        suggestedChange:
          `Verlaag maxSpreadMean onder ${key}`,
        confidence: Math.abs(avgPnl)
      }
    }
  }

  return null
}

export function analyseBetaClusters(buckets) {

  for (const key in buckets.beta) {

    const trades = buckets.beta[key]
    if (trades.length < 10) continue

    const maxClusterDD =
      computeClusterDD(trades)

    if (maxClusterDD > 3) {
      return {
        type: "Beta Exposure Suggestion",
        message:
          `Beta ${key} cluster veroorzaakte ${maxClusterDD}R drawdown.`,
        suggestedChange:
          `Verlaag maxBetaExposure onder ${key}`,
        confidence: maxClusterDD
      }
    }
  }

  return null
}

function computeClusterDD(trades) {

  let equity = 0
  let peak = 0
  let dd = 0

  for (const t of trades) {
    equity += t.pnl
    if (equity > peak) peak = equity
    const d = peak - equity
    if (d > dd) dd = d
  }

  return dd
}