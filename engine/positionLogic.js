export function buildPosition(entry, atr, side) {
  if (side === "LONG") {
    const stop = entry - 1.2 * atr
    const target = entry + 2 * atr
    return { stop, target }
  } else {
    const stop = entry + 1.2 * atr
    const target = entry - 2 * atr
    return { stop, target }
  }
}