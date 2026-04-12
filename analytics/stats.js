export function computeStats(trades) {

  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)

  const winrate = wins.length / trades.length

  const avgWin = avg(wins.map(t => t.pnl))
  const avgLoss = avg(losses.map(t => t.pnl))

  const expectancy =
    winrate * avgWin +
    (1 - winrate) * avgLoss

  const maxDrawdown = computeMaxDrawdown(trades)

  return {
    winrate,
    avgWin,
    avgLoss,
    expectancy,
    maxDrawdown
  }
}

function avg(arr) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function computeMaxDrawdown(trades) {

  let peak = 0
  let equity = 0
  let maxDD = 0

  for (const t of trades) {
    equity += t.pnl
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDD) maxDD = dd
  }

  return maxDD
}