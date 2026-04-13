import { kv } from "@vercel/kv"
import { scanSymbol } from "./scannerCore.js"

export async function runBullScanner(universe) {
  const candidates = []

  for (const symbolData of universe) {
    const result = scanSymbol(symbolData)
    if (result) candidates.push(result)
  }

  await kv.set("edge:candidates", candidates)

  return candidates
}