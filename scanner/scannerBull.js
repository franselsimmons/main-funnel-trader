import { scanUniverse } from "./scannerCore";
import { processBullCoin } from "../engine/engineBull";

export async function runBullScan(state) {
  const { btc, coins, regime } = await scanUniverse("bull");

  const results = [];

  for (const coin of coins) {
    const prev = state[coin.symbol] || {};
    const processed = await processBullCoin(coin, prev, regime, btc);
    results.push(processed);
  }

  return { btc, regime, results };
}