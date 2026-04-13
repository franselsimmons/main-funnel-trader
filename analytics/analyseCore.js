export function calculateStats(trades) {
  const wins = trades.filter(t => t.rMultiple > 0)
  const losses = trades.filter(t => t.rMultiple <= 0)

  const expectancy =
    trades.reduce((a, b) => a + b.rMultiple, 0) / trades.length

  return {
    winrate: wins.length / trades.length,
    expectancy,
    avgWin: wins.reduce((a, b) => a + b.rMultiple, 0) / wins.length || 0,
    avgLoss: losses.reduce((a, b) => a + b.rMultiple, 0) / losses.length || 0
  }
}