import { getPerformance } from "./performanceEngine.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export async function validateSignal({
  coin,
  regime,
  aiScore,
  tradePlan
}) {
  const perf = await getPerformance(regime);

  const MIN_TRADES = 25;
  const BASELINE_EXPECTANCY = 0.2;

  let expectancy = perf.expectancy;
  let winrate = perf.winrate;

  if (perf.trades < MIN_TRADES) {
    expectancy = BASELINE_EXPECTANCY;
  }

  const approved =
    expectancy > 0 &&
    aiScore >= 70 &&
    n(tradePlan?.rr) >= 1.8;

  const capitalPct =
    expectancy > 0.5 ? 3 :
    expectancy > 0.3 ? 2 :
    1;

  return {
    coin: coin.symbol,
    timestamp: Date.now(),
    signal_quality: {
      approved,
      ai_score: aiScore,
      expectancy_r: expectancy,
      historical_winrate: winrate,
      regime
    },
    execution_parameters: {
      action: coin.side === "SHORT" ? "SELL" : "BUY",
      order_type: "MARKET",
      capital_allocation_pct: capitalPct,
      entry_price_tolerance: coin.price * 1.01,
      stop_loss_price: tradePlan?.sl,
      take_profit_price: tradePlan?.tp
    }
  };
}