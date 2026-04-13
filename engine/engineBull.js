import { kv } from "@vercel/kv"
import { buildPosition } from "./positionLogic.js"

export async function runBullEngine() {
  const trades =
    (await kv.get("trade:approved")) || []

  const portfolio =
    (await kv.get("state:bull")) || []

  for (const trade of trades) {

    const position =
      buildPosition(trade.entry || 100, 1)

    portfolio.push({
      symbol: trade.symbol,
      size: trade.positionSize,
      entry: trade.entry || 100,
      stop: position.stop,
      target: position.target,
      opened: Date.now()
    })
  }

  await kv.set("state:bull", portfolio)

  return portfolio
}