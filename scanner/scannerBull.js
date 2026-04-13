import { kv } from "@vercel/kv"
import { scanSymbol } from "./scannerCore.js"

export async function runBullScanner(universe) {
  const results = []

  for (const symbolData of universe) {
    const candidate =
      scanSymbol(symbolData, "LONG")
    if (candidate) results.push(candidate)
  }

  await kv.set("edge:candidates:bull", results)
  return results
}