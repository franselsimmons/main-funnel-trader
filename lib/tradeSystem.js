import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";
import { calculateRisk } from "./riskManager.js";
import { getAdaptiveSettings } from "./learning.js";
import { logTrade } from "./logger.js";
import { getLiquidityZones } from "./liquidity.js";
import { getVolatility } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";
import { getFilters } from "./filterState.js";

const memory = new Map();

export async function processTrades(coins, btc, mode, regime) {
  const actions = [];
  const adaptive = getAdaptiveSettings();
  const market = await getMarketContext();
  const filters = getFilters();
  const tradeF = filters.trade || {
    rrMin: 1.5,
    scoreMin: 60,
    requireTrend: true,
    blockSpoof: true
  };

  for (const c of coins) {
    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);
    const risk = calculateRisk(c);
    const vol = getVolatility(c);

    const obRaw = await fetchOrderBook(c.symbol + "USDT");
    const ob = analyzeOrderBookAdvanced(obRaw);

    const liq = getLiquidityZones(c);

    let action = "WATCH";
    let reason = "default";

    // ================= FILTER =================
    if (vol === "LOW") {
      action = "SKIP";
      reason = "low_volatility";
    }

    // ================= ENTRY =================
    else if (!prev) {
      const macroOK =
        (c.side === "bull" && market.trend !== "BTC_STRONG") ||
        (c.side === "bear" && market.trend !== "ALTS_STRONG") ||
        market.trend === "NEUTRAL";

      const trendOK = tradeF.requireTrend ? flow.type === "TREND" : true;
      const spoofOK = tradeF.blockSpoof ? !ob.spoof : true;

      if (
        sniper.valid &&
        trendOK &&
        macroOK &&
        spoofOK &&
        c.moveScore >= Number(tradeF.scoreMin || adaptive.scoreMin || 60) &&
        risk.rr >= Number(tradeF.rrMin || adaptive.rrMin || 1.5)
      ) {
        action = "ENTRY";
        reason = "full_confluence";

        memory.set(key, {
          entry: risk.entry,
          sl: risk.sl,
          tp: risk.tp,
          support: liq.support,
          resistance: liq.resistance,
          openedAt: Date.now()
        });
      } else {
        action = "WAIT";
        reason = "no_alignment";
      }
    }

    // ================= OPEN =================
    else {
      const pos = prev;

      if (
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp)
      ) {
        action = "EXIT";
        reason = "TP";

        logTrade({
          symbol: c.symbol,
          side: c.side,
          entry: pos.entry,
          exit: c.price,
          result: "WIN",
          rr: risk.rr
        });

        memory.delete(key);
      }

      else if (
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl)
      ) {
        action = "EXIT";
        reason = "SL";

        logTrade({
          symbol: c.symbol,
          side: c.side,
          entry: pos.entry,
          exit: c.price,
          result: "LOSS",
          rr: risk.rr
        });

        memory.delete(key);
      }

      else {
        action = "HOLD";
        reason = "position_open";
      }
    }

    actions.push({
      symbol: c.symbol,
      side: c.side,
      action,
      reason,
      stage: c.stage,
      score: c.moveScore,
      flow: flow.type,
      rr: Number(risk.rr).toFixed(2),
      entry: risk.entry,
      sl: risk.sl,
      tp: risk.tp,
      ob: ob.bias,
      spoof: ob.spoof,
      support: liq.support,
      resistance: liq.resistance,
      volatility: vol,
      macro: market.trend
    });
  }

  return actions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}