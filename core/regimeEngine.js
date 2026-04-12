export function computeRegime(btc) {

  const change = btc.change24h
  const range = btc.range24h
  const vol = btc.volatility

  if (range > 6 && Math.abs(change) > 2)
    return "EXPANSION"

  if (range > 3 && Math.abs(change) > 1)
    return "TREND"

  if (range < 1.5)
    return "CHOP"

  if (change < -3)
    return "RISK_OFF"

  return "NEUTRAL"
}