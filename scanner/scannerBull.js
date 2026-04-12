import { fetchUniverse } from "./universeFetcher.js"
import { runScanner } from "./scannerCore.js"
import { BULL_CONFIG } from "../config/bull.js"
import { SHARED_CONFIG } from "../config/shared.js"

export async function runBullScanner(btcData) {

  const universe = await fetchUniverse()

  return await runScanner({
    mode: "bull",
    config: BULL_CONFIG,
    sharedConfig: SHARED_CONFIG,
    marketData: universe,
    btcData
  })
}