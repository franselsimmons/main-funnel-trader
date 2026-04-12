import { BULL_CONFIG } from "../config/bull.js"
import { SHARED_CONFIG } from "../config/shared.js"
import { runScanner } from "./scannerCore.js"

export async function runBullScanner(marketData, btcData) {
  return await runScanner({
    mode: "bull",
    config: BULL_CONFIG,
    sharedConfig: SHARED_CONFIG,
    marketData,
    btcData
  })
}