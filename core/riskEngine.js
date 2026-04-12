export function calculateSize(entry, stop, riskUsd) {
  const riskPerUnit = Math.abs(entry - stop)
  if (!riskPerUnit) return 0
  return riskUsd / riskPerUnit
}