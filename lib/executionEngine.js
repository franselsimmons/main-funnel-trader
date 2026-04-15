import { openPosition } from "./position.js";
import { getRiskAmount } from "./portfolio.js";
import { getRiskProfile } from "./riskManager.js";

export function executeTrade(c, strategy){

  const risk = getRiskProfile(strategy);

  const entry = c.current_price;

  const sl = entry * 0.97;
  const tp = entry * 1.06;

  const riskAmount = getRiskAmount(risk.risk);

  const size = riskAmount / (entry - sl);

  openPosition({
    symbol:c.symbol,
    entry,
    sl,
    tp,
    size,
    currentPrice:entry
  });

  return "OPENED";
}