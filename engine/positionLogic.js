export function createPosition(candidate, regime) {

  const risk = 1
  const reward = 1.4

  return {
    symbol: candidate.symbol,
    entry: candidate.entry || 100,
    sl: candidate.entry * 0.99,
    tp: candidate.entry * (1 + reward * 0.01),
    beta: candidate.beta,
    regime,
    risk,
    breakEvenActivated: false,
    trailingActivated: false,
    hwm: candidate.entry,
    closed: false
  }
}

export function managePosition(pos, live, regime) {

  const price = live.price
  const rMove = (price - pos.entry) / (pos.entry - pos.sl)

  // 1️⃣ Hard stop
  if (price <= pos.sl)
    return { ...pos, closed: true, reason: "SL" }

  // 2️⃣ Take profit
  if (price >= pos.tp)
    return { ...pos, closed: true, reason: "TP" }

  // 3️⃣ Break-even
  if (!pos.breakEvenActivated && rMove >= 0.8) {
    pos.sl = pos.entry
    pos.breakEvenActivated = true
  }

  // 4️⃣ Trailing
  if (!pos.trailingActivated && rMove >= 1.2) {
    pos.trailingActivated = true
  }

  if (pos.trailingActivated) {
    pos.hwm = Math.max(pos.hwm, price)
    pos.sl = pos.hwm * 0.985
  }

  // 5️⃣ Spread Spike Abort
  if (live.spreadMean > 1.5)
    return { ...pos, closed: true, reason: "SpreadSpike" }

  // 6️⃣ Liquidity Collapse Abort
  if (live.depthVelocity < -0.6)
    return { ...pos, closed: true, reason: "LiquidityDrop" }

  return pos
}