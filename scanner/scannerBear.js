import { kv } from "@vercel/kv"
import { scanSymbol } from "./scannerCore.js"

export async function runBearScanner(universe) {
  const results = []

  for (const symbolData of universe) {
    const candidate =
      scanSymbol(symbolData, "SHORT")
    if (candidate) results.push(candidate)
  }

  await kv.set("edge:candidates:bear", results)
  return results
}