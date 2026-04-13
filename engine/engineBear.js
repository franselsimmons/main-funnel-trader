import { kv } from "@vercel/kv"
import { buildPosition } from "./positionLogic.js"

export async function runBearEngine() {
  const trades =
    await kv.get("trade:approved:bear") || []

  const portfolio =
    await kv.get("state:bear") || []

  for (const trade of trades) {
    const position =
      buildPosition(trade.entry, trade.atr, "SHORT")

    portfolio.push({
      symbol: trade.symbol,
      size: trade.positionSize,
      entry: trade.entry,
      stop: position.stop,
      target: position.target,
      opened: Date.now()
    })
  }

  await kv.set("state:bear", portfolio)
  return portfolio
}