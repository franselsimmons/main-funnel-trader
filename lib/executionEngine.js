import { recordTrade } from "./learning.js";
import { logTrade } from "./logger.js";
import { getRiskProfile } from "./riskManager.js";

export function executeTrade(c, strategy){

  const risk = getRiskProfile(strategy);

  let winChance =
    strategy==="SCALP_FAST" ? 0.52 :
    strategy==="SCALP" ? 0.56 :
    strategy==="AGGRESSIVE" ? 0.62 :
    strategy==="SWING" ? 0.60 :
    0.5;

  const result = Math.random() < winChance ? "WIN" : "LOSS";

  recordTrade(result,{
    symbol:c.symbol,
    strategy,
    risk:risk.risk
  });

  logTrade(c,strategy,result);

  return result;
}