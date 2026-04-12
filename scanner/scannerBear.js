import { BEAR_CONFIG } from "../config/bear.js"
import { SHARED_CONFIG } from "../config/shared.js"
import { runScanner } from "./scannerCore.js"

export async function runBearScanner(marketData, btcData) {
  return await runScanner({
    mode: "bear",
    config: BEAR_CONFIG,
    sharedConfig: SHARED_CONFIG,
    marketData,
    btcData
  })
}