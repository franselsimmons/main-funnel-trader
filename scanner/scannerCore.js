import { processEdge } from "../engine/engineCore.js"

export function scanSymbol(symbolData) {
  const result = processEdge(symbolData.candles, symbolData.metrics)

  if (!result) return null

  return {
    symbol: symbolData.symbol,
    ...result
  }
}