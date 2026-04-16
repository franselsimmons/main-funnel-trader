import { analyzeFlow } from "./flowEngine.js";

const memory = new Map();

export function processTrades(coins, btc, mode, regime){

  const actions = [];

  for(const c of coins){

    const key = c.symbol + "_" + c.side;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const flowType = flow.type;

    const dir = c.side === "bull" ? 1 : -1;
    const ch1 = c.change1h * dir;

    let action = "WATCH";
    let reason = "default";

    // ================= NO TRADE =================
    if(c.moveScore < 60){
      action = "WATCH";
      reason = "low_quality";
    }

    // ================= OVEREXTENDED =================
    else if(ch1 > 2.5){
      action = "WAIT";
      reason = "too_fast";
    }

    // ================= ENTRY =================
    else if(!prev){

      if(
        c.stage === "ENTRY" &&
        flowType === "TREND" &&
        c.moveScore >= 85
      ){
        action = "ENTRY";
        reason = "perfect_setup";

        memory.set(key,{
          state:"OPEN",
          adds:0
        });
      }
      else{
        action = "WAIT";
        reason = "not_ready";
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
        prev.adds < 2
      ){
        action = "ADD";
        reason = "strong_continuation";
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
      flow: flowType
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}