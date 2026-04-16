import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import { analyzeOrderBook } from "./orderbook.js";

const memory = new Map();

export function processTrades(coins, btc, mode, regime){

  const actions = [];

  for(const c of coins){

    const key = c.symbol + "_" + c.side;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const flowType = flow.type;

    const sniper = getSniperEntry(c);
    const ob = analyzeOrderBook(c.ob, c.side);

    const dir = c.side === "bull" ? 1 : -1;
    const move1h = (c.change1h || 0) * dir;

    let action = "WATCH";
    let reason = "default";

    // ================= NO TRADE =================
    if(c.moveScore < 60){
      action = "WATCH";
      reason = "low_quality";
    }

    // ================= OVEREXTENDED =================
    else if(sniper.type === "OVEREXTENDED"){
      action = "WAIT";
      reason = "too_fast";
    }

    // ================= ENTRY =================
    else if(!prev){

      const bullOk =
        c.side === "bull" &&
        ob.bias !== "WEAK";

      const bearOk =
        c.side === "bear" &&
        ob.bias !== "RESISTANCE";

      if(
        c.stage === "ENTRY" &&
        flowType === "TREND" &&
        sniper.valid &&
        (bullOk || bearOk)
      ){
        action = "ENTRY";
        reason = "sniper_aligned";

        memory.set(key,{
          state:"OPEN",
          adds:0
        });
      }
      else{
        action = "WAIT";
        reason = "no_alignment";
      }
    }

    // ================= OPEN TRADE =================
    else{

      // EXIT
      if(flowType === "EXHAUSTION"){
        action = "EXIT";
        reason = "trend_end";
        memory.delete(key);
      }

      // ADD
      else if(
        c.moveScore > 90 &&
        prev.adds < 2 &&
        (
          (c.side === "bull" && ob.bias === "BULLISH") ||
          (c.side === "bear" && ob.bias === "BEARISH")
        )
      ){
        action = "ADD";
        reason = "liquidity_confirmed";
        prev.adds++;
      }

      // HOLD
      else{
        action = "HOLD";
        reason =
          flowType === "TREND"
            ? "trend_running"
            : "still_valid";
      }
    }

    actions.push({
      symbol: c.symbol,
      side: c.side,
      action,
      reason,
      stage: c.stage,
      score: c.moveScore,
      flow: flowType,
      sniper: sniper.reason,
      orderbook: ob.bias
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}