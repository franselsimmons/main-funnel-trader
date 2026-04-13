export function buildPosition(entryPrice, atr) {
  const stop = entryPrice - (1.2 * atr)
  const target = entryPrice + (2 * atr)

  return {
    stop,
    target,
    rr: (target - entryPrice) / (entryPrice - stop)
  }
}