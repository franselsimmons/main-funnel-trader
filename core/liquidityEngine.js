export function spreadStable(mean, variance, maxMean, maxVar) {
  if (mean > maxMean) return false
  if (variance > maxVar) return false
  return true
}