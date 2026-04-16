import { analyzeFlow } from "./flowEngine.js";
import { getRiskProfile } from "./riskManager.js";
import {
  handleEntry,
  handleAdd,
  handleExit,
  getPositions
} from "./positionManager.js";

import {
  shouldEnter,
  shouldAdd,
  shouldExit
} from "./executionEngine.js";

const memory = new Map();

export function processTrades(coins, btc, mode, regime){

  const actions = [];

  for(const c of coins){

    const flow = analyzeFlow(c);
    const risk = getRiskProfile(c, regime);
    const pos = memory.get(c.symbol);

    let action = "NONE";
    let reason = "none";

    // ===== ENTRY =====
    if(!pos){

      if(shouldEnter(c, flow, risk)){
        handleEntry(c);

        memory.set(c.symbol,{
          state:"OPEN",
          adds:0
        });

        action = "ENTRY";
        reason = "strong_setup";
      } else {
        action = "WAIT";
        reason = "not_ready";
      }
    }

    // ===== OPEN POSITION =====
    else{

      if(shouldExit(c, flow)){
        handleExit(c);
        memory.delete(c.symbol);

        action = "EXIT";
        reason = "invalidation";
      }

      else if(shouldAdd(c, pos, risk)){
        handleAdd(c);

        pos.adds += 1;

        action = "ADD";
        reason = "continuation";
      }

      else{
        action = "HOLD";
        reason = flow.type === "TREND"
          ? "let_run"
          : "still_valid";
      }
    }

    actions.push({
      symbol:c.symbol,
      action,
      reason,
      stage:c.stage,
      score:c.moveScore,
      flow:flow.type
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}

export function getOpenTradeState(){
  return getPositions();
}