// lib/tradeSystem.js

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

const memory = new Map();

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

    let action = "WATCH";
    let reason = "default";

    // ================= SKIP =================
    if(vol === "LOW"){
      actions.push({ ...c, action:"SKIP", reason:"low_vol" });
      continue;
    }

    // ================= ENTRY =================
    if(!prev){

      const trendOK = !filters.requireTrend || flow.type === "TREND";
      const spoofOK = !filters.blockSpoof || !ob.spoof;

      if(
        sniper.valid &&
        sniper.score >= 75 &&
        trendOK &&
        spoofOK &&
        c.moveScore >= filters.scoreMin &&
        risk.rr >= filters.rrMin
      ){

        const position = {
          entry: risk.entry,
          sl: risk.sl,
          tp: risk.tp,

          partialTP: risk.entry + (risk.tp - risk.entry) * 0.5,
          trailingActive: false,

          openedAt: Date.now(),
          maxPrice: c.price,
          sizeLeft: 1
        };

        memory.set(key, position);

        action = "ENTRY";
        reason = sniper.type;

      } else {
        action = "WAIT";
        reason = sniper.type || "filters_not_met";
      }
    }

    // ================= MANAGE =================
    else{

      const pos = prev;

      // update max
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
        pos.sizeLeft = 0.5;
        pos.trailingActive = true;

        action = "PARTIAL_TP";
        reason = "secure_profit";
      }

      // ================= TRAIL =================
      if(pos.trailingActive){

        const trailPerc = 0.4;

        let trailSL;

        if(c.side === "bull"){
          trailSL = pos.maxPrice * (1 - trailPerc/100);
          if(trailSL > pos.sl){
            pos.sl = trailSL;
          }
        } else {
          trailSL = pos.maxPrice * (1 + trailPerc/100);
          if(trailSL < pos.sl){
            pos.sl = trailSL;
          }
        }
      }

      // ================= EXIT =================
      const hitTP =
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp);

      const hitSL =
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl);

      const weakFlow = flow.type === "NEUTRAL";
      const sniperWeak = !sniper.valid;

      if(hitTP){
        action = "EXIT";
        reason = "TP";
        memory.delete(key);
      }

      else if(hitSL){
        action = "EXIT";
        reason = "SL";
        memory.delete(key);
      }

      // 🔥 EXTRA SMART EXIT
      else if((weakFlow || sniperWeak) && pos.sizeLeft < 1){
        action = "EXIT";
        reason = "WEAK_STRUCTURE";
        memory.delete(key);
      }

      else{
        action = "HOLD";
        reason = "running";
        memory.set(key, pos);
      }
    }

    actions.push({
      symbol:c.symbol,
      side:c.side,
      action,
      reason,
      stage:c.stage,
      score:c.moveScore,
      flow:flow.type,
      sniper: sniper.type,
      sniperScore: sniper.score || 0,
      rr:Number(risk.rr).toFixed(2),
      entry:risk.entry,
      sl:risk.sl,
      tp:risk.tp,
      volatility:vol,
      macro:market.trend
    });
  }

  return actions.sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}