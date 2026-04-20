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

    const ob = obMap[c.symbol] || {
      mid: 0,
      spreadPct: 0.001,
      depthMinUsd1p: 200000,
      bias: "NEUTRAL",
      spoof: false
    };

    // ================= EXCHANGE PRICE SYNC =================
    if(ob?.mid && ob.mid > 0){
      c.price = ob.mid;
    }

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c, ob);
    const risk = calculateRisk(c, ob);
    const vol = getVolatility(c);

    let state = notifyState.get(key) || {
      entry: false,
      hold: false,
      partial: false,
      exit: false
    };

    let action = "WATCH";
    let reason = "watch";

    // ================= FILTER =================
    if(vol === "LOW"){
      actions.push({
        symbol: c.symbol,
        side: c.side,
        action: "SKIP",
        reason: "LOW_VOL",
        stage: c.stage,
        score: c.moveScore,
        flow: flow.type,
        sniper: sniper?.type || "NONE",
        rr: Number(risk.rr || 0).toFixed(2),
        price: c.price,
        entry: risk.entry,
        sl: risk.sl,
        tp: risk.tp,
        obBias: ob.bias,
        spoof: ob.spoof,
        volatility: vol,
        macro: market?.trend || "NEUTRAL"
      });
      continue;
    }

    if(flow.type === "NEUTRAL"){
      actions.push({
        symbol: c.symbol,
        side: c.side,
        action: "SKIP",
        reason: "NEUTRAL_FLOW",
        stage: c.stage,
        score: c.moveScore,
        flow: flow.type,
        sniper: sniper?.type || "NONE",
        rr: Number(risk.rr || 0).toFixed(2),
        price: c.price,
        entry: risk.entry,
        sl: risk.sl,
        tp: risk.tp,
        obBias: ob.bias,
        spoof: ob.spoof,
        volatility: vol,
        macro: market?.trend || "NEUTRAL"
      });
      continue;
    }

    if(c.moveScore < 75){
      actions.push({
        symbol: c.symbol,
        side: c.side,
        action: "SKIP",
        reason: "LOW_SCORE",
        stage: c.stage,
        score: c.moveScore,
        flow: flow.type,
        sniper: sniper?.type || "NONE",
        rr: Number(risk.rr || 0).toFixed(2),
        price: c.price,
        entry: risk.entry,
        sl: risk.sl,
        tp: risk.tp,
        obBias: ob.bias,
        spoof: ob.spoof,
        volatility: vol,
        macro: market?.trend || "NEUTRAL"
      });
      continue;
    }

    // ================= ENTRY =================
    if(!prev){

      if(
        c.stage === "entry" &&
        sniper?.valid &&
        sniper.score >= 75 &&
        !ob.spoof &&
        risk.rr >= 1.2
      ){

        const position = {
          entry: c.price,
          sl: risk.sl,
          tp: risk.tp,
          partialTP: c.price + (risk.tp - c.price) * 0.3,
          trailingActive: false,
          maxPrice: c.price,
          sizeLeft: 1
        };

        memory.set(key, position);

        action = "ENTRY";
        reason = sniper.type || "ENTRY_OK";

        if(!state.entry){
          await sendEntry({
            symbol: c.symbol,
            side: c.side,
            entry: position.entry,
            sl: position.sl,
            tp: position.tp,
            rr: Number(risk.rr).toFixed(2),
            sniper: sniper.type
          });
          state.entry = true;
        }

      }else{
        action = "WAIT";
        reason = !sniper?.valid
          ? (sniper?.type || "SNIPER_INVALID")
          : ob.spoof
            ? "SPOOF_DETECTED"
            : risk.rr < 1.2
              ? "RR_TOO_LOW"
              : "ENTRY_FILTERED";
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

      // ===== PARTIAL =====
      const hitPartial =
        (c.side === "bull" && c.price >= pos.partialTP) ||
        (c.side === "bear" && c.price <= pos.partialTP);

      if(hitPartial && pos.sizeLeft === 1){

        pos.sizeLeft = 0.5;
        pos.trailingActive = true;

        // break-even
        pos.sl = pos.entry;

        action = "PARTIAL_TP";
        reason = "PARTIAL_HIT";

        if(!state.partial){
          await sendPartial({ symbol: c.symbol });
          state.partial = true;
        }
      }

      // ===== TRAILING =====
      if(pos.trailingActive){

        const trailPerc = 0.35;

        if(c.side === "bull"){
          const newSL = pos.maxPrice * (1 - trailPerc / 100);
          if(newSL > pos.sl) pos.sl = newSL;
        }else{
          const newSL = pos.maxPrice * (1 + trailPerc / 100);
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

        action = "EXIT";
        reason = hitTP ? "TP" : "SL";

        logTrade({
          symbol: c.symbol,
          side: c.side,
          entry: pos.entry,
          exit: c.price,
          result: hitTP ? "WIN" : "LOSS"
        });

        if(!state.exit){
          await sendExit({
            symbol: c.symbol,
            side: c.side,
            reason,
            rr: Number(risk.rr).toFixed(2)
          });
          state.exit = true;
        }

        memory.delete(key);
        notifyState.delete(key);

        actions.push({
          symbol: c.symbol,
          side: c.side,
          action,
          reason,
          stage: c.stage,
          score: c.moveScore,
          flow: flow.type,
          sniper: sniper?.type || "NONE",
          rr: Number(risk.rr || 0).toFixed(2),
          price: c.price,
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          obBias: ob.bias,
          spoof: ob.spoof,
          volatility: vol,
          macro: market?.trend || "NEUTRAL"
        });

        continue;
      }

      if(weakFlow && pos.sizeLeft < 1){

        action = "EXIT";
        reason = "WEAK_FLOW";

        if(!state.exit){
          await sendExit({
            symbol: c.symbol,
            side: c.side,
            reason: "WEAK_FLOW",
            rr: Number(risk.rr).toFixed(2)
          });
          state.exit = true;
        }

        memory.delete(key);
        notifyState.delete(key);

        actions.push({
          symbol: c.symbol,
          side: c.side,
          action,
          reason,
          stage: c.stage,
          score: c.moveScore,
          flow: flow.type,
          sniper: sniper?.type || "NONE",
          rr: Number(risk.rr || 0).toFixed(2),
          price: c.price,
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          obBias: ob.bias,
          spoof: ob.spoof,
          volatility: vol,
          macro: market?.trend || "NEUTRAL"
        });

        continue;
      }

      if(action !== "PARTIAL_TP"){
        action = "HOLD";
        reason = "RUNNING";
      }

      if(!state.hold){
        await sendHold({
          symbol: c.symbol,
          side: c.side,
          flow: flow.type,
          score: c.moveScore
        });
        state.hold = true;
      }

      memory.set(key, pos);
    }

    notifyState.set(key, state);

    actions.push({
      symbol: c.symbol,
      side: c.side,
      action,
      reason,
      stage: c.stage,
      score: c.moveScore,
      flow: flow.type,
      sniper: sniper?.type || "NONE",
      rr: Number(risk.rr || 0).toFixed(2),
      price: c.price,
      entry: risk.entry,
      sl: risk.sl,
      tp: risk.tp,
      obBias: ob.bias,
      spoof: ob.spoof,
      volatility: vol,
      macro: market?.trend || "NEUTRAL"
    });
  }

  return actions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}