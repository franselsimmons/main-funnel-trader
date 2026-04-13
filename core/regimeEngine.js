export function detectVolatilityRegime(atrPercentile) {
  if (atrPercentile > 0.8) return { regime: 3, weight: 0.5 }
  if (atrPercentile > 0.5) return { regime: 2, weight: 1 }
  return { regime: 1, weight: 1.2 }
}