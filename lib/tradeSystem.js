import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookDepth
} from "./orderbook.js";

import { calculateRisk } from "./riskManager.js";

const memory = new Map();

export async function processTrades(coins, btc, mode, regime){

  const actions = [];

  for(const c of coins){

    const key = c.symbol + "_" + c.side;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);

    // 🔥 REAL ORDERBOOK
    const obRaw = await fetchOrderBook(c.symbol + "USDT");
    const ob = analyzeOrderBookDepth(obRaw);

    // 🔥 RISK
    const risk = calculateRisk(c);

    let action = "WATCH";
    let reason = "default";

    // ================= FILTER =================
    if(c.moveScore < 60){
      action = "WATCH";
      reason = "low_score";
    }

    // ================= ENTRY =================
    else if(!prev){

      if(
        sniper.valid &&
        flow.type === "TREND" &&
        risk.rr > 1.5 && // 🔥 BELANGRIJK
        (
          (c.side === "bull" && ob.bias !== "BEARISH") ||
          (c.side === "bear" && ob.bias !== "BULLISH")
        )
      ){
        action = "ENTRY";
        reason = "rr + sniper + ob";

        memory.set(key,{
          state:"OPEN"
        });
      }else{
        action = "WAIT";
        reason = "no_alignment";
      }
    }

    // ================= OPEN =================
    else{

      if(flow.type === "EXHAUSTION"){
        action = "EXIT";
        reason = "trend_end";
        memory.delete(key);
      }
      else{
        action = "HOLD";
        reason = "trend";
      }
    }

    actions.push({
      symbol:c.symbol,
      side:c.side,
      action,
      reason,
      rr: risk.rr.toFixed(2),
      entry: risk.entry,
      sl: risk.sl,
      tp: risk.tp,
      orderbook: ob.bias
    });
  }

  return actions;
}