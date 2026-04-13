export function buildPosition(entry, atr) {
  const stop = entry - (1.2 * atr)
  const target = entry + (2 * atr)

  return {
    stop,
    target,
    rr: (target - entry) / (entry - stop)
  }
}