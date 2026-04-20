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
    coins.map(async (c) => {
      try{
        const raw = await fetchOrderBook(c.symbol + "USDT");
        obMap[c.symbol] = analyzeOrderBookAdvanced(raw);
      }catch{
        obMap[c.symbol] = {
          mid: 0,
          spreadPct: 0.001,
          depthMinUsd1p: 200000,
          bias: "NEUTRAL",
          spoof: false
        };
      }
    })
  );

  for(const originalCoin of coins){

    const c = { ...originalCoin };
    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const ob = obMap[c.symbol];

    // ================= 🔥 EXCHANGE PRICE =================
    if(ob?.mid && ob.mid > 0){
      c.price = ob.mid;
    }

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c, ob);
    const risk = calculateRisk(c, ob);
    const vol = getVolatility(c);

    let state = notifyState.get(key) || {
      entry:false,
      hold:false,
      partial:false,
      exit:false
    };

    let action = "WATCH";
    let reason = "watch";

    // ================= BASE FILTER =================
    if(vol === "LOW") continue;
    if(flow.type === "NEUTRAL") continue;
    if(c.moveScore < 75) continue;

    // ================= 🔥 MARKET BIAS =================

    // BEAR MARKET → block weak longs
    if(
      btc.state === "BEARISH" &&
      c.side === "bull" &&
      c.moveScore < 90
    ){
      continue;
    }

    // BULL MARKET → block weak shorts
    if(
      btc.state === "BULLISH" &&
      c.side === "bear" &&
      c.moveScore < 85
    ){
      continue;
    }

    // 🔥 dynamic thresholds
    const sniperMin = c.side === "bear" ? 70 : 75;
    const rrMin = c.side === "bear" ? 1.1 : 1.2;

    // ================= ENTRY =================
    if(!prev){

      if(
        c.stage === "entry" &&
        sniper?.valid &&
        sniper.score >= sniperMin &&
        !ob.spoof &&
        risk.rr >= rrMin
      ){

        const position = {
          entry: c.price,
          sl: risk.sl,
          tp: risk.tp,
          partialTP: c.price + (risk.tp - c.price) * 0.3,
          trailingActive:false,
          maxPrice:c.price,
          sizeLeft:1
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
            rr:Number(risk.rr).toFixed(2),
            sniper:sniper.type
          });
          state.entry = true;
        }

      }else{
        action = "WAIT";
      }
    }

    // ================= MANAGE =================
    else{

      const pos = { ...prev };

      if(c.side === "bull"){
        pos.maxPrice = Math.max(pos.maxPrice, c.price);
      }else{
        pos.maxPrice = Math.min(pos.maxPrice, c.price);
      }

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

      if(pos.trailingActive){

        const trailPerc = 0.35;

        if(c.side === "bull"){
          const newSL = pos.maxPrice * (1 - trailPerc/100);
          if(newSL > pos.sl) pos.sl = newSL;
        }else{
          const newSL = pos.maxPrice * (1 + trailPerc/100);
          if(newSL < pos.sl) pos.sl = newSL;
        }
      }

      const hitTP =
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp);

      const hitSL =
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl);

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
      side:c.side,
      action,
      score:c.moveScore
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}