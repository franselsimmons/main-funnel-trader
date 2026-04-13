export function computeRegime(btc) {
  if (btc > 1.5) return "EXPANSION";
  if (btc > 0.5) return "TREND";
  if (btc < -1.5) return "HEADWIND";
  return "CHOP";
}