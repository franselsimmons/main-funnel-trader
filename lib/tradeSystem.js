import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";
import { calculateRisk } from "./riskManager.js";
import { logTrade } from "./logger.js";
import { getVolatility } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";
import { getFilters } from "./filterState.js";

import {
  sendEntry,
  sendHold,
  sendExit,
  sendPartial
} from "./discordNotifier.js";

const memory = new Map();
const notifyState = new Map();

export async function processTrades(coins, btc, mode, regime){

  const actions = [];
  const market = await getMarketContext();
  const filters = getFilters().trade;

  const obMap = {};
  await Promise.all(
    coins.map(async c=>{
      try{
        const raw = await fetchOrderBook(c.symbol+"USDT");
        obMap[c.symbol] = analyzeOrderBookAdvanced(raw);
      }catch{
        obMap[c.symbol] = { bias:"NEUTRAL", spoof:false };
      }
    })
  );

  for(const c of coins){

    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);
    const ob = obMap[c.symbol];

    // 🔥 BELANGRIJK: OB meegeven
    const risk = calculateRisk(c, ob);

    const vol = getVolatility(c);

    let state = notifyState.get(key) || {
      entry:false,
      hold:false,
      partial:false,
      exit:false
    };

    let action = "WATCH";

    // ================= FILTER =================
    if(vol === "LOW") continue;
    if(flow.type === "NEUTRAL") continue;
    if(c.moveScore < 75) continue;

    // ================= ENTRY =================
    if(!prev){

      if(
        c.stage === "entry" &&
        sniper.valid &&
        sniper.score >= 75 &&
        !ob.spoof &&
        risk.rr >= 1.2
      ){

        const position = {
          entry: risk.entry,
          sl: risk.sl,
          tp: risk.tp,

          // dynamic partial
          partialTP: risk.entry + (risk.tp - risk.entry) * 0.3,

          trailingActive:false,
          maxPrice:c.price,
          sizeLeft:1
        };

        memory.set(key, position);

        action = "ENTRY";

        if(!state.entry){
          await sendEntry({
            symbol:c.symbol,
            side:c.side,
            entry:position.entry,
            sl:position.sl,
            tp:position.tp,
            rr:Number(risk.rr).toFixed(2),
            sniper:sniper.type
          });
          state.entry = true;
        }
      }
    }

    // ================= MANAGE =================
    else{

      const pos = prev;

      if(c.side === "bull"){
        pos.maxPrice = Math.max(pos.maxPrice, c.price);
      } else {
        pos.maxPrice = Math.min(pos.maxPrice, c.price);
      }

      // ===== PARTIAL =====
      const hitPartial =
        (c.side === "bull" && c.price >= pos.partialTP) ||
        (c.side === "bear" && c.price <= pos.partialTP);

      if(hitPartial && pos.sizeLeft === 1){

        pos.sizeLeft = 0.5;
        pos.trailingActive = true;

        pos.sl = pos.entry;

        if(!state.partial){
          await sendPartial({ symbol:c.symbol });
          state.partial = true;
        }
      }

      // ===== TRAILING =====
      if(pos.trailingActive){

        const trailPerc = 0.35;

        if(c.side === "bull"){
          const newSL = pos.maxPrice * (1 - trailPerc/100);
          if(newSL > pos.sl) pos.sl = newSL;
        } else {
          const newSL = pos.maxPrice * (1 + trailPerc/100);
          if(newSL < pos.sl) pos.sl = newSL;
        }
      }

      // ===== EXIT =====
      const hitTP =
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp);

      const hitSL =
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl);

      const weakFlow = flow.type === "NEUTRAL";

      if(hitTP || hitSL){

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result: hitTP ? "WIN" : "LOSS"
        });

        if(!state.exit){
          await sendExit({
            symbol:c.symbol,
            side:c.side,
            reason: hitTP ? "TP" : "SL",
            rr:Number(risk.rr).toFixed(2)
          });
          state.exit = true;
        }

        memory.delete(key);
        notifyState.delete(key);
        continue;
      }

      else if(weakFlow && pos.sizeLeft < 1){

        if(!state.exit){
          await sendExit({
            symbol:c.symbol,
            side:c.side,
            reason:"WEAK_FLOW",
            rr:Number(risk.rr).toFixed(2)
          });
        }

        memory.delete(key);
        notifyState.delete(key);
        continue;
      }

      if(!state.hold){
        await sendHold({
          symbol:c.symbol,
          side:c.side,
          flow:flow.type,
          score:c.moveScore
        });
        state.hold = true;
      }

      memory.set(key, pos);
    }

    notifyState.set(key, state);

    actions.push({
      symbol:c.symbol,
      action,
      score:c.moveScore
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}