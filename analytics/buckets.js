export function monteCarlo(trades, iterations = 500) {
  const curves = []

  for (let i = 0; i < iterations; i++) {
    let equity = 1
    const shuffled =
      [...trades].sort(() => Math.random() - 0.5)

    for (const trade of shuffled) {
      equity *= (1 + trade.pnl)
    }

    curves.push(equity)
  }

  curves.sort((a, b) => a - b)

  return {
    median: curves[Math.floor(iterations / 2)],
    worst: curves[0],
    best: curves[iterations - 1]
  }
}