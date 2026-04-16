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

const memory = new Map();

export async function processTrades(coins, btc, mode, regime){

  const actions = [];
  const adaptive = getAdaptiveSettings();
  const market = await getMarketContext();

  for(const c of coins){

    const key = c.symbol + "_" + c.side;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);
    const risk = calculateRisk(c);
    const vol = getVolatility(c);

    // 🔥 ORDERBOOK PRO
    const obRaw = await fetchOrderBook(c.symbol + "USDT");
    const ob = analyzeOrderBookAdvanced(obRaw);

    const liq = getLiquidityZones(c);

    let action = "WATCH";
    let reason = "default";

    // ================= FILTER =================
    if(vol === "LOW"){
      action = "SKIP";
      reason = "low_volatility";
    }

    // ================= ENTRY =================
    else if(!prev){

      const macroOK =
        (c.side === "bull" && market.trend !== "BTC_STRONG") ||
        (c.side === "bear" && market.trend !== "ALTS_STRONG");

      if(
        sniper.valid &&
        flow.type === "TREND" &&
        c.moveScore >= adaptive.scoreMin &&
        risk.rr >= adaptive.rrMin &&
        !ob.spoof &&
        macroOK
      ){
        action = "ENTRY";
        reason = "full_confluence";

        memory.set(key,{
          entry:risk.entry,
          sl:risk.sl,
          tp:risk.tp
        });
      }
      else{
        action = "WAIT";
      }
    }

    // ================= OPEN =================
    else{

      const pos = prev;

      if(
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp)
      ){
        action = "EXIT";
        reason = "TP";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result:"WIN",
          rr:risk.rr
        });

        memory.delete(key);
      }

      else if(
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl)
      ){
        action = "EXIT";
        reason = "SL";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result:"LOSS",
          rr:risk.rr
        });

        memory.delete(key);
      }

      else{
        action = "HOLD";
      }
    }

    actions.push({
      symbol:c.symbol,
      side:c.side,
      action,
      reason,
      rr:risk.rr.toFixed(2),
      ob:ob.bias,
      spoof:ob.spoof,
      volatility:vol,
      macro:market.trend
    });
  }

  return actions;
}