import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookDepth
} from "./orderbook.js";

import { calculateRisk } from "./riskManager.js";
import { getAdaptiveSettings } from "./learning.js";
import { logTrade } from "./logger.js";

const memory = new Map();

export async function processTrades(coins, btc, mode, regime){

  const actions = [];

  const adaptive = getAdaptiveSettings();

  for(const c of coins){

    const key = c.symbol + "_" + c.side;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);

    const obRaw = await fetchOrderBook(c.symbol + "USDT");
    const ob = analyzeOrderBookDepth(obRaw);

    const risk = calculateRisk(c);

    let action = "WATCH";
    let reason = "default";

    // ================= ENTRY =================
    if(!prev){

      if(
        sniper.valid &&
        flow.type === "TREND" &&
        c.moveScore >= adaptive.scoreMin &&
        risk.rr >= adaptive.rrMin &&
        (
          (c.side === "bull" && ob.bias !== "BEARISH") ||
          (c.side === "bear" && ob.bias !== "BULLISH")
        )
      ){
        action = "ENTRY";
        reason = "adaptive_entry";

        memory.set(key,{
          entry: risk.entry,
          sl: risk.sl,
          tp: risk.tp
        });
      }
      else{
        action = "WAIT";
      }
    }

    // ================= OPEN =================
    else{

      const pos = prev;

      // 🔥 TP HIT
      if(
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp)
      ){
        action = "EXIT";
        reason = "TP_HIT";

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

      // 🔥 SL HIT
      else if(
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl)
      ){
        action = "EXIT";
        reason = "SL_HIT";

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
      entry:risk.entry,
      sl:risk.sl,
      tp:risk.tp,
      ob:ob.bias,
      winrate: adaptive.winrate.toFixed(1)
    });
  }

  return actions;
}