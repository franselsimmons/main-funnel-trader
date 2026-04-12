export function computeRegime(btcChange24, btcVolatility) {
  if (btcChange24 > 2 && btcVolatility > 1.2) return "EXPANSION"
  if (btcVolatility < 0.8) return "CHOP"
  return "TREND"
}