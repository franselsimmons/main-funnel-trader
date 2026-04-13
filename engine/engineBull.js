import { kv } from "@vercel/kv"
import { buildPosition } from "./positionLogic.js"

export async function runBullEngine() {
  const trades =
    await kv.get("trade:approved:bull") || []

  const portfolio =
    await kv.get("state:bull") || []

  for (const trade of trades) {
    const position =
      buildPosition(trade.entry, trade.atr, "LONG")

    portfolio.push({
      symbol: trade.symbol,
      size: trade.positionSize,
      entry: trade.entry,
      stop: position.stop,
      target: position.target,
      opened: Date.now()
    })
  }

  await kv.set("state:bull", portfolio)
  return portfolio
}