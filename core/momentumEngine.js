export function continuationMomentum(change1h, min, max) {
  if (change1h >= min && change1h <= max) return true
  return false
}