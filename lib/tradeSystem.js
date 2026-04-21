import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";
import { calculateRisk } from "./riskManager.js";
import { logTrade } from "./logger.js";
import { getVolatility, getVolatilityRegime } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";

import { getLiquidityZones } from "./liquidityEngine.js";
import { getLiquidationZones } from "./liquidationEngine.js";
import { calculateConfluence } from "./confluenceEngine.js";
import { fetchFunding } from "./funding.js";

import {
  sendEntry,
  sendHold,
  sendExit,
  sendPartial
} from "./discordNotifier.js";

const memory = new Map();
const notifyState = new Map();

export async function processTrades(coins){

  const actions = [];
  const market = await getMarketContext();

  const obMap = {};
  const fundingMap = {};
  const liqMap = {};

  // ================= PARALLEL FETCH =================
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

      try{
        fundingMap[c.symbol] = await fetchFunding(c.symbol + "USDT");
      }catch{
        fundingMap[c.symbol] = { rate: 0 };
      }

      try{
        liqMap[c.symbol] = await getLiquidationZones(
          c.symbol + "USDT",
          c.price
        );
      }catch{
        liqMap[c.symbol] = null;
      }
    })
  );

  // ================= LOOP =================
  for(const originalCoin of coins){

    const c = { ...originalCoin };
    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const ob = obMap[c.symbol];
    const funding = fundingMap[c.symbol] || { rate: 0 };
    const liquidation = liqMap[c.symbol];

    if(ob?.mid > 0){
      c.price = ob.mid;
    }

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c, ob);
    const riskBase = calculateRisk(c, ob);
    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const liq = getLiquidityZones(c, ob);

    const isBull = c.side === "bull";

    // ================= FAKE BREAKOUT =================
    let fakeBreakout = false;

    if(liquidation){
      if(isBull && liquidation.nearestAbove && c.price > liquidation.nearestAbove){
        fakeBreakout = true;
      }

      if(!isBull && liquidation.nearestBelow && c.price < liquidation.nearestBelow){
        fakeBreakout = true;
      }
    }

    // ================= CONFLUENCE =================
    const confluence = calculateConfluence(
      c,
      ob,
      liquidation || liq,
      funding,
      regime.level
    );

    let state = notifyState.get(key) || {
      entry:false,
      hold:false,
      partial:false,
      exit:false
    };

    let action = "WATCH";

    // ================= HARD FILTER =================
    if(vol === "LOW") continue;
    if(flow.type === "NEUTRAL") continue;
    if(fakeBreakout && confluence < 75) continue;

    // ================= BTC BIAS (SOFT) =================
    if(market?.trend === "BULLISH" && !isBull && c.moveScore < 80){
      continue;
    }

    if(market?.trend === "BEARISH" && isBull && c.moveScore < 80){
      continue;
    }

    // ================= CONFLUENCE =================
    const minConf = isBull ? 60 : 55;
    if(confluence < minConf) continue;

    // ================= RR =================
    const rr = isBull
      ? (riskBase.tp - c.price) / (c.price - riskBase.sl)
      : (c.price - riskBase.tp) / (riskBase.sl - c.price);

    const minRR = regime.level === "HIGH" ? 1.0 : 1.1;

    if(rr < minRR) continue;

    // ================= ENTRY =================
    if(!prev){

      if(
        c.stage === "entry" &&
        sniper?.valid &&
        sniper.score >= 70 &&
        !ob.spoof
      ){

        const position = {
          entry: c.price,
          sl: riskBase.sl,
          tp: riskBase.tp,
          partialTP: isBull
            ? c.price + (riskBase.tp - c.price) * 0.3
            : c.price - (c.price - riskBase.tp) * 0.3,
          trailingActive:false,
          maxPrice:c.price,
          sizeLeft:1,
          rr
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
            rr:Number(rr).toFixed(2),
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

      if(isBull){
        pos.maxPrice = Math.max(pos.maxPrice, c.price);
      }else{
        pos.maxPrice = Math.min(pos.maxPrice, c.price);
      }

      const hitPartial =
        (isBull && c.price >= pos.partialTP) ||
        (!isBull && c.price <= pos.partialTP);

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

        const trailPerc = regime.trailPerc || 0.3;

        if(isBull){
          const newSL = pos.maxPrice * (1 - trailPerc/100);
          if(newSL > pos.sl) pos.sl = newSL;
        }else{
          const newSL = pos.maxPrice * (1 + trailPerc/100);
          if(newSL < pos.sl) pos.sl = newSL;
        }
      }

      const hitTP =
        (isBull && c.price >= pos.tp) ||
        (!isBull && c.price <= pos.tp);

      const hitSL =
        (isBull && c.price <= pos.sl) ||
        (!isBull && c.price >= pos.sl);

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
            rr:Number(pos.rr).toFixed(2)
          });
          state.exit = true;
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

      action = "HOLD";
      memory.set(key, pos);
    }

    notifyState.set(key, state);

    actions.push({
      symbol:c.symbol,
      side:c.side,
      action,
      score:c.moveScore,
      confluence,
      price:c.price
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}