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

// 🔥 DISCORD
import {
  sendEntry,
  sendHold,
  sendExit,
  sendPartial
} from "./discordNotifier.js";

const memory = new Map();
const notified = new Set(); // anti spam


export async function processTrades(coins, btc, mode, regime){

  const actions = [];
  const market = await getMarketContext();
  const filters = getFilters().trade;

  // ================= ORDERBOOK =================
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
      const stageOK = c.stage === "entry";

      // 🔥 EXTRA EDGE FILTER (dit vervangt jouw risk limits)
      const strongStructure =
        c.moveScore > 70 &&
        flow.type !== "NEUTRAL" &&
        sniper.valid;

      if(
        stageOK &&
        strongStructure &&
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
          sizeLeft: 1,

          // 🔥 nieuwe intelligence
          entryScore: c.moveScore,
          entryFlow: flow.type
        };

        memory.set(key, position);

        action = "ENTRY";
        reason = sniper.type;

        // 🔥 DISCORD (no spam)
        if(!notified.has(key)){
          await sendEntry({
            symbol:c.symbol,
            side:c.side,
            entry:risk.entry,
            sl:risk.sl,
            tp:risk.tp,
            rr:Number(risk.rr).toFixed(2),
            sniper:sniper.type
          });
          notified.add(key);
        }

      } else {
        action = "WAIT";
        reason = sniper.type || "filters_not_met";
      }
    }

    // ================= MANAGE =================
    else{

      const pos = prev;

      // update max price
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

        await sendPartial({ symbol:c.symbol });
      }

      // ================= TRAILING =================
      if(pos.trailingActive){

        const trailPerc = 0.4;

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

      const weakFlow = flow.type === "NEUTRAL";
      const sniperWeak = !sniper.valid;

      // 🔥 NEW: structure breakdown
      const structureBreak =
        c.moveScore < pos.entryScore - 20;

      if(hitTP){

        action = "EXIT";
        reason = "TP";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result:"WIN"
        });

        await sendExit({
          symbol:c.symbol,
          side:c.side,
          reason:"TP",
          rr:Number(risk.rr).toFixed(2)
        });

        memory.delete(key);
        notified.delete(key);
      }

      else if(hitSL){

        action = "EXIT";
        reason = "SL";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result:"LOSS"
        });

        await sendExit({
          symbol:c.symbol,
          side:c.side,
          reason:"SL",
          rr:Number(risk.rr).toFixed(2)
        });

        memory.delete(key);
        notified.delete(key);
      }

      else if(structureBreak){

        action = "EXIT";
        reason = "STRUCTURE_BREAK";

        await sendExit({
          symbol:c.symbol,
          side:c.side,
          reason:"STRUCTURE_BREAK",
          rr:Number(risk.rr).toFixed(2)
        });

        memory.delete(key);
        notified.delete(key);
      }

      else if((weakFlow || sniperWeak) && pos.sizeLeft < 1){

        action = "EXIT";
        reason = "WEAK_STRUCTURE";

        await sendExit({
          symbol:c.symbol,
          side:c.side,
          reason:"WEAK_STRUCTURE",
          rr:Number(risk.rr).toFixed(2)
        });

        memory.delete(key);
        notified.delete(key);
      }

      else{

        action = "HOLD";
        reason = "running";

        // 🔥 HOLD alleen als het écht sterk is
        if(c.moveScore > 85 && flow.type === "TREND"){
          await sendHold({
            symbol:c.symbol,
            side:c.side,
            flow:flow.type,
            score:c.moveScore
          });
        }

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