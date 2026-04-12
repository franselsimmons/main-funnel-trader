export function runAnalyse(tradeHistory) {

  const buckets = buildBuckets(tradeHistory)

  const stats = computeStats(tradeHistory)

  const suggestions = []

  const momentumInsight = analyseMomentumBuckets(buckets)
  if (momentumInsight)
    suggestions.push(momentumInsight)

  const spreadInsight = analyseSpreadBuckets(buckets)
  if (spreadInsight)
    suggestions.push(spreadInsight)

  const betaInsight = analyseBetaClusters(buckets)
  if (betaInsight)
    suggestions.push(betaInsight)

  return {
    stats,
    suggestions
  }
}