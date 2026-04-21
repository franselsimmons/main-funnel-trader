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

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.001,
  depthMinUsd1p: 200000,
  bias: "NEUTRAL",
  spoof: false
};

export async function processTrades(coins){

  const actions = [];
  const market = await getMarketContext();

  const obMap = {};
  const fundingMap = {};

  // ================= PARALLEL FETCH =================
  await Promise.all(
    coins.map(async (c) => {

      try{
        const raw = await fetchOrderBook(c.symbol + "USDT");
        obMap[c.symbol] = analyzeOrderBookAdvanced(raw);
      }catch{
        obMap[c.symbol] = { ...DEFAULT_OB };
      }

      try{
        fundingMap[c.symbol] = await fetchFunding(c.symbol + "USDT");
      }catch{
        fundingMap[c.symbol] = { rate: 0 };
      }

    })
  );

  // ================= LOOP =================
  for(const originalCoin of coins){

    const c = { ...originalCoin };
    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const ob = obMap[c.symbol] || { ...DEFAULT_OB };
    const funding = fundingMap[c.symbol] || { rate: 0 };

    // ================= EXCHANGE PRICE SYNC =================
    if(ob?.mid > 0){
      c.price = ob.mid;
    }

    const isBull = c.side === "bull";

    const flow = analyzeFlow(c);
    c.flow = flow.type; // belangrijk voor sniper + confluence

    const sniper = getSniperEntry(c, ob);
    const riskBase = calculateRisk(c, ob);
    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const liquidity = getLiquidityZones(c, ob);

    // ================= REAL LIQUIDATIONS AFTER PRICE SYNC =================
    let liquidation = null;

    try{
      liquidation = await getLiquidationZones(
        c.symbol + "USDT",
        c.price
      );
    }catch{
      liquidation = null;
    }

    const hasLiquidationData =
      Array.isArray(liquidation?.clusters) &&
      liquidation.clusters.length > 0;

    // ================= CONFLUENCE =================
    const confluence = calculateConfluence(
      c,
      ob,
      liquidity,
      funding,
      regime.level,
      hasLiquidationData ? liquidation : null
    );

    let state = notifyState.get(key) || {
      entry:false,
      hold:false,
      partial:false,
      exit:false
    };

    let action = "WATCH";
    let reason = "WATCH";

    // ================= RR =================
    const rrRaw = isBull
      ? (riskBase.tp - c.price) / (c.price - riskBase.sl)
      : (c.price - riskBase.tp) / (riskBase.sl - c.price);

    const rr = Number.isFinite(rrRaw)
      ? Math.max(0, rrRaw)
      : 0;

    // =====================================================
    // MANAGE EXISTING POSITION FIRST
    // Bestaande trades mogen niet verdwijnen door entry filters.
    // =====================================================
    if(prev){

      const pos = { ...prev };

      if(isBull){
        pos.maxPrice = Math.max(pos.maxPrice, c.price);
      }else{
        pos.maxPrice = Math.min(pos.maxPrice, c.price);
      }

      // ===== PARTIAL =====
      const hitPartial =
        (isBull && c.price >= pos.partialTP) ||
        (!isBull && c.price <= pos.partialTP);

      if(hitPartial && pos.sizeLeft === 1){

        pos.sizeLeft = 0.5;
        pos.trailingActive = true;
        pos.sl = pos.entry;

        action = "PARTIAL";
        reason = "TP1";

        if(!state.partial){
          await sendPartial({ symbol:c.symbol });
          state.partial = true;
        }
      }

      // ===== TRAILING =====
      if(pos.trailingActive){

        const trailPerc = regime.trailPerc || 0.3;

        if(isBull){
          const newSL = pos.maxPrice * (1 - trailPerc / 100);
          if(newSL > pos.sl) pos.sl = newSL;
        }else{
          const newSL = pos.maxPrice * (1 + trailPerc / 100);
          if(newSL < pos.sl) pos.sl = newSL;
        }
      }

      // ===== EXIT =====
      const hitTP =
        (isBull && c.price >= pos.tp) ||
        (!isBull && c.price <= pos.tp);

      const hitSL =
        (isBull && c.price <= pos.sl) ||
        (!isBull && c.price >= pos.sl);

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
            rr:Number(pos.rr || 0).toFixed(2)
          });
          state.exit = true;
        }

        memory.delete(key);
        notifyState.delete(key);

        actions.push({
          symbol:c.symbol,
          side:c.side,
          action,
          reason,
          stage:c.stage,
          score:c.moveScore,
          confluence,
          rr:Number(pos.rr || 0).toFixed(2),
          price:c.price,
          entry:pos.entry,
          sl:pos.sl,
          tp:pos.tp,
          flow:flow.type,
          sniper:sniper?.type || "NONE",
          sniperScore:sniper?.score || 0,
          funding:funding.rate || 0,
          obBias:ob.bias
        });

        continue;
      }

      if(action !== "PARTIAL"){
        action = "HOLD";
        reason = "RUNNING";
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
      notifyState.set(key, state);

      actions.push({
        symbol:c.symbol,
        side:c.side,
        action,
        reason,
        stage:c.stage,
        score:c.moveScore,
        confluence,
        rr:Number(pos.rr || 0).toFixed(2),
        price:c.price,
        entry:pos.entry,
        sl:pos.sl,
        tp:pos.tp,
        flow:flow.type,
        sniper:sniper?.type || "NONE",
        sniperScore:sniper?.score || 0,
        funding:funding.rate || 0,
        obBias:ob.bias
      });

      continue;
    }

    // ================= ENTRY FILTERS =================

    if(vol === "LOW"){
      actions.push(buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    if(flow.type === "NEUTRAL"){
      actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    // ================= FAKE BREAKOUT SOFT FILTER =================
    let fakeBreakout = false;

    if(hasLiquidationData){

      if(isBull && liquidation.nearestAbove && c.price > liquidation.nearestAbove * 1.002){
        fakeBreakout = true;
      }

      if(!isBull && liquidation.nearestBelow && c.price < liquidation.nearestBelow * 0.998){
        fakeBreakout = true;
      }
    }

    if(fakeBreakout && confluence < 75){
      actions.push(buildWait(c, "FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    // ================= BTC BIAS SOFT =================
    if(market?.trend === "BULLISH" && !isBull && c.moveScore < 70){
      actions.push(buildWait(c, "BTC_BULL_BLOCK_SHORT", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    if(market?.trend === "BEARISH" && isBull && c.moveScore < 70){
      actions.push(buildWait(c, "BTC_BEAR_BLOCK_LONG", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    // ================= CONFLUENCE FILTER =================
    const minConf = isBull ? 55 : 50;

    if(confluence < minConf){
      actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    // ================= RR FILTER =================
    const minRR = regime.level === "HIGH" ? 0.9 : 0.95;

    if(rr < minRR){
      actions.push(buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, ob, riskBase));
      continue;
    }

    // ================= ENTRY =================
    if(
      c.stage === "entry" &&
      (sniper?.valid || confluence >= 75) &&
      (sniper?.score || 0) >= 60 &&
      !ob.spoof
    ){

      const reasonEntry = sniper?.type || "CONFLUENCE_ENTRY";

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
      reason = reasonEntry;

      if(!state.entry){
        await sendEntry({
          symbol:c.symbol,
          side:c.side,
          entry:position.entry,
          sl:position.sl,
          tp:position.tp,
          rr:Number(position.rr).toFixed(2),
          sniper:reasonEntry
        });
        state.entry = true;
      }

      notifyState.set(key, state);

      actions.push({
        symbol:c.symbol,
        side:c.side,
        action,
        reason,
        stage:c.stage,
        score:c.moveScore,
        confluence,
        rr:Number(rr).toFixed(2),
        price:c.price,
        entry:position.entry,
        sl:position.sl,
        tp:position.tp,
        flow:flow.type,
        sniper:sniper?.type || "NONE",
        sniperScore:sniper?.score || 0,
        funding:funding.rate || 0,
        obBias:ob.bias
      });

      continue;
    }

    // ================= WAIT =================
    actions.push(
      buildWait(
        c,
        "ENTRY_FILTERED",
        flow,
        sniper,
        confluence,
        rr,
        funding,
        ob,
        riskBase
      )
    );
  }

  return actions.sort((a,b)=>Number(b.score || 0) - Number(a.score || 0));
}


// ================= HELPER =================
function buildWait(c, reason, flow, sniper, confluence, rr, funding, ob, risk){

  return {
    symbol:c.symbol,
    side:c.side,
    action:"WAIT",
    reason,
    stage:c.stage,
    score:c.moveScore,
    confluence,
    rr:Number(rr || 0).toFixed(2),
    price:c.price,
    entry:risk.entry,
    sl:risk.sl,
    tp:risk.tp,
    flow:flow.type,
    sniper:sniper?.type || "NONE",
    sniperScore:sniper?.score || 0,
    funding:funding?.rate || 0,
    obBias:ob?.bias || "NEUTRAL"
  };
}