export function computeCapacity(regime, dispersionScore) {
  if (regime === "EXPANSION" && dispersionScore > 0.6) return 4
  if (regime === "TREND") return 2
  return 1
}