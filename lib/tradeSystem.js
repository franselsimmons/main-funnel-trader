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
    const risk = calculateRisk(c);
    const vol = getVolatility(c);
    const ob = obMap[c.symbol];

    let state = notifyState.get(key) || {
      entry:false,
      hold:false,
      partial:false,
      exit:false
    };

    let action = "WATCH";
    let reason = "default";

    // ================= SKIP =================
    if(vol === "LOW" || vol === "HIGH"){
      actions.push({ ...c, action:"SKIP", reason:"bad_vol" });
      continue;
    }

    // ================= ENTRY =================
    if(!prev){

      // 🔥 HARD FILTER → winrate boost
      if(flow.type !== "TREND") continue;

      const trendOK = !filters.requireTrend || flow.type === "TREND";
      const spoofOK = !filters.blockSpoof || !ob.spoof;
      const stageOK = c.stage === "entry";

      if(
        stageOK &&
        sniper.valid &&
        sniper.score >= 80 &&        // 🔥 strenger
        trendOK &&
        spoofOK &&
        c.moveScore >= 70 &&         // 🔥 strenger
        risk.rr >= 1.3
      ){

        const position = {
          entry: risk.entry,
          sl: risk.sl,

          // 🔥 WINRATE MODE
          tp: risk.entry + (risk.tp - risk.entry) * 0.6,
          partialTP: risk.entry + (risk.tp - risk.entry) * 0.3,

          trailingActive: false,
          openedAt: Date.now(),
          maxPrice: c.price,
          sizeLeft: 1
        };

        memory.set(key, position);

        action = "ENTRY";
        reason = sniper.type;

        if(!state.entry){
          await sendEntry({
            symbol:c.symbol,
            side:c.side,
            entry:position.entry,
            sl:position.sl,
            tp:position.tp,
            rr:"~1.8",
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

      // ================= PARTIAL =================
      const hitPartial =
        (c.side === "bull" && c.price >= pos.partialTP) ||
        (c.side === "bear" && c.price <= pos.partialTP);

      if(hitPartial && pos.sizeLeft === 1){

        pos.sizeLeft = 0.4;
        pos.trailingActive = true;

        // 🔥 BREAK EVEN → HUGE winrate boost
        pos.sl = pos.entry;

        action = "PARTIAL_TP";

        if(!state.partial){
          await sendPartial({ symbol:c.symbol });
          state.partial = true;
        }
      }

      // ================= TRAILING =================
      if(pos.trailingActive){

        const trailPerc = 0.3;

        if(c.side === "bull"){
          const newSL = pos.maxPrice * (1 - trailPerc/100);
          if(newSL > pos.sl) pos.sl = newSL;
        } else {
          const newSL = pos.maxPrice * (1 + trailPerc/100);
          if(newSL < pos.sl) pos.sl = newSL;
        }
      }

      // ================= EXIT =================
      const hitTP =
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp);

      const hitSL =
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl);

      const weakFlow = flow.type !== "TREND";

      if(hitTP || hitSL){

        action = "EXIT";
        reason = hitTP ? "TP" : "SL";

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
            reason,
            rr:"~1.8"
          });
          state.exit = true;
        }

        memory.delete(key);
        notifyState.delete(key);
        continue;
      }

      else if(weakFlow && pos.sizeLeft < 1){

        action = "EXIT";
        reason = "WEAK";

        if(!state.exit){
          await sendExit({
            symbol:c.symbol,
            side:c.side,
            reason:"WEAK_FLOW",
            rr:"~1.2"
          });
        }

        memory.delete(key);
        notifyState.delete(key);
        continue;
      }

      else{

        action = "HOLD";

        if(c.moveScore > 85 && !state.hold){
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
    }

    notifyState.set(key, state);

    actions.push({
      symbol:c.symbol,
      side:c.side,
      action,
      reason,
      stage:c.stage,
      score:c.moveScore,
      flow:flow.type,
      sniper: sniper.type,
      rr:"~1.8"
    });
  }

  return actions.sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}