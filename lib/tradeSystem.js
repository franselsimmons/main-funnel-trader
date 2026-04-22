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
const cooldownMap = new Map();

// ================= DUPLICATE PROTECTION =================
// Blokkeert dubbele entries per coin binnen dezelfde runtime.
const symbolCooldownMap = new Map();
const processingLocks = new Set();

// ================= QUALITY MODE =================
// Minder trades, hogere kwaliteit
const MAX_OPEN_TRADES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;

// Extra cooldown per symbol na entry/exit.
// Voorkomt dubbele RUNE/MET/etc. entries kort achter elkaar.
const SYMBOL_REENTRY_COOLDOWN_MS = 45 * 60 * 1000;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.001,
  depthMinUsd1p: 200000,
  bias: "NEUTRAL",
  spoof: false
};


// ================= HELPERS =================
function normalizeSpread(spreadPct){

  let s = Number(spreadPct || 0);

  if(!Number.isFinite(s) || s < 0){
    return 0.001;
  }

  // Als spread als 0.07 komt, bedoelen veel systemen 0.07%.
  // Dan maken we er 0.0007 van.
  if(s > 0.05){
    s = s / 100;
  }

  return s;
}


function calculateFallbackRR(c, risk, isBull){

  const price = Number(c.price || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);

  if(!price || !sl || !tp) return 0;

  const raw = isBull
    ? (tp - price) / (price - sl)
    : (price - tp) / (sl - price);

  return Number.isFinite(raw)
    ? Math.max(0, raw)
    : 0;
}


function getOpenTradeCount(){
  return memory.size;
}


function cleanExpiredGuards(){

  const now = Date.now();

  for(const [key, until] of cooldownMap.entries()){
    if(now >= until){
      cooldownMap.delete(key);
    }
  }

  for(const [symbol, until] of symbolCooldownMap.entries()){
    if(now >= until){
      symbolCooldownMap.delete(symbol);
    }
  }
}


function hasAnyOpenPositionForSymbol(symbol){

  const s = String(symbol || "").toUpperCase();

  for(const key of memory.keys()){
    if(key.startsWith(`${s}_`)){
      return true;
    }
  }

  return false;
}


function getOpenPositionSideForSymbol(symbol){

  const s = String(symbol || "").toUpperCase();

  for(const key of memory.keys()){
    if(key.startsWith(`${s}_`)){
      return key.split("_")[1] || "unknown";
    }
  }

  return null;
}


function stageRank(stage){

  if(stage === "entry") return 4;
  if(stage === "almost") return 3;
  if(stage === "buildup") return 2;
  if(stage === "radar") return 1;

  return 0;
}


// Voorkomt dubbele candidates binnen dezelfde scan.
// Als dezelfde symbol_side meerdere keren voorkomt, pakt hij de beste.
function dedupeCandidates(coins){

  const map = new Map();

  for(const raw of Array.isArray(coins) ? coins : []){

    if(!raw?.symbol || !raw?.side) continue;

    const symbol = String(raw.symbol || "").toUpperCase();
    const side = String(raw.side || "").toLowerCase();

    if(side !== "bull" && side !== "bear") continue;

    const normalized = {
      ...raw,
      symbol,
      side
    };

    const key = `${symbol}_${side}`;
    const prev = map.get(key);

    if(!prev){
      map.set(key, normalized);
      continue;
    }

    const prevStage = stageRank(prev.stage);
    const newStage = stageRank(normalized.stage);

    const prevScore = Number(prev.moveScore || 0);
    const newScore = Number(normalized.moveScore || 0);

    if(
      newStage > prevStage ||
      (newStage === prevStage && newScore > prevScore)
    ){
      map.set(key, normalized);
    }
  }

  return Array.from(map.values())
    .sort((a,b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
}


function getSetupGrade({
  c,
  ob,
  flow,
  sniper,
  confluence,
  rr,
  hasLiquidationData,
  isBull
}){

  let points = 0;

  if(confluence >= 85) points += 4;
  else if(confluence >= 75) points += 3;
  else if(confluence >= 65) points += 2;
  else if(confluence >= 55) points += 1;

  if(flow.type === "TREND") points += 2;
  else if(flow.type === "BUILDING") points += 1;

  if(sniper?.valid) points += 2;
  if(Number(sniper?.score || 0) >= 75) points += 1;

  const obWith =
    (isBull && ob?.bias === "BULLISH") ||
    (!isBull && ob?.bias === "BEARISH");

  const obAgainst =
    (isBull && ob?.bias === "BEARISH") ||
    (!isBull && ob?.bias === "BULLISH");

  if(obWith) points += 2;
  if(obAgainst) points -= 2;

  if(hasLiquidationData) points += 1;

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  if(spread <= 0.003 && depth >= 150000) points += 1;
  if(spread > 0.01 || depth < 75000) points -= 2;

  if(c.stage === "entry") points += 1;

  if(rr >= 1.2) points += 1;
  else if(rr < 0.6) points -= 1;

  let grade = "C";
  let recommendedRisk = "watch";

  if(points >= 9){
    grade = "A";
    recommendedRisk = "normal";
  }else if(points >= 6){
    grade = "B";
    recommendedRisk = "small";
  }

  return {
    grade,
    points,
    recommendedRisk
  };
}


function buildWait(c, reason, flow, sniper, confluence, rr, funding, ob, risk, setupGrade){

  return {
    symbol: c.symbol,
    side: c.side,
    action: "WAIT",
    reason,
    grade: setupGrade?.grade || "C",
    gradePoints: setupGrade?.points || 0,
    recommendedRisk: setupGrade?.recommendedRisk || "watch",
    stage: c.stage,
    score: c.moveScore,
    confluence,
    rr: Number(rr || 0).toFixed(2),
    price: c.price,
    entry: risk.entry,
    sl: risk.sl,
    tp: risk.tp,
    slSource: risk.slSource || "liquidity/orderbook",
    tpSource: risk.tpSource || "liquidity/liquidation",
    flow: flow.type,
    sniper: sniper?.type || "NONE",
    sniperScore: sniper?.score || 0,
    funding: funding?.rate || 0,
    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null
  };
}


// ================= CORE =================
export async function processTrades(
  coins,
  btc = null,
  mode = "auto",
  scannerRegime = null,
  options = {}
){

  const notify = options.notify !== false;

  cleanExpiredGuards();

  const candidates = dedupeCandidates(coins);

  const actions = [];
  const market = await getMarketContext();

  const obMap = {};
  const fundingMap = {};

  // ================= PARALLEL FETCH =================
  await Promise.all(
    candidates.map(async (c) => {

      const symbol = String(c.symbol || "").toUpperCase();

      try{
        const raw = await fetchOrderBook(symbol + "USDT");
        obMap[symbol] = analyzeOrderBookAdvanced(raw);
      }catch{
        obMap[symbol] = { ...DEFAULT_OB };
      }

      try{
        fundingMap[symbol] = await fetchFunding(symbol + "USDT");
      }catch{
        fundingMap[symbol] = { rate: 0 };
      }

    })
  );

  // ================= LOOP =================
  for(const originalCoin of candidates){

    const c = { ...originalCoin };
    c.symbol = String(c.symbol || "").toUpperCase();
    c.side = String(c.side || "").toLowerCase();

    const key = `${c.symbol}_${c.side}`;
    const symbolLockKey = `LOCK_${c.symbol}`;
    const prev = memory.get(key);

    const ob = obMap[c.symbol] || { ...DEFAULT_OB };
    const funding = fundingMap[c.symbol] || { rate: 0 };

    // ================= EXCHANGE PRICE SYNC =================
    if(ob?.mid > 0){
      c.price = ob.mid;
    }

    const isBull = c.side === "bull";

    const flow = analyzeFlow(c);
    c.flow = flow.type;

    const sniper = getSniperEntry(c, ob);
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

    // ================= FINAL RISK =================
    const riskBase = calculateRisk(
      c,
      ob,
      liquidity,
      hasLiquidationData ? liquidation : null
    );

    const rr = Number.isFinite(Number(riskBase?.rr))
      ? Math.max(0, Number(riskBase.rr))
      : calculateFallbackRR(c, riskBase, isBull);

    // ================= CONFLUENCE =================
    const confluence = calculateConfluence(
      c,
      ob,
      liquidity,
      funding,
      regime.level,
      hasLiquidationData ? liquidation : null
    );

    const setupGrade = getSetupGrade({
      c,
      ob,
      flow,
      sniper,
      confluence,
      rr,
      hasLiquidationData,
      isBull
    });

    let state = notifyState.get(key) || {
      entry: false,
      hold: false,
      partial: false,
      exit: false
    };

    let action = "WATCH";
    let reason = "WATCH";

    // =====================================================
    // MANAGE EXISTING POSITION FIRST
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

        pos.sizeLeft = pos.sizeAfterPartial || 0.5;
        pos.trailingActive = true;
        pos.sl = pos.entry;

        action = "PARTIAL";
        reason = "TP1";

        if(!state.partial){
          if(notify){
            await sendPartial({ symbol: c.symbol });
            state.partial = true;
          }
        }
      }

      // ===== TRAILING =====
      if(pos.trailingActive){

        const trailPerc = pos.trailPerc || regime.trailPerc || 0.3;

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

        if(notify){
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
              rr: Number(pos.rr || 0).toFixed(2),
              grade: pos.grade || "N/A",
              recommendedRisk: pos.recommendedRisk || "N/A",
              slSource: pos.slSource || "N/A",
              tpSource: pos.tpSource || "N/A"
            });
            state.exit = true;
          }

          memory.delete(key);
          notifyState.delete(key);

          cooldownMap.set(key, Date.now() + COOLDOWN_MS);
          symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
        }

        actions.push({
          symbol: c.symbol,
          side: c.side,
          action,
          reason,
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          stage: c.stage,
          score: c.moveScore,
          confluence,
          rr: Number(pos.rr || 0).toFixed(2),
          price: c.price,
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A",
          flow: flow.type,
          sniper: sniper?.type || "NONE",
          sniperScore: sniper?.score || 0,
          funding: funding.rate || 0,
          obBias: ob.bias,
          spreadPct: ob.spreadPct ?? null,
          depthMinUsd1p: ob.depthMinUsd1p ?? null
        });

        continue;
      }

      if(action !== "PARTIAL"){
        action = "HOLD";
        reason = "RUNNING";
      }

      if(!state.hold){
        if(notify){
          await sendHold({
            symbol: c.symbol,
            side: c.side,
            flow: flow.type,
            score: c.moveScore,
            rr: Number(pos.rr || 0).toFixed(2),
            grade: pos.grade || "N/A",
            recommendedRisk: pos.recommendedRisk || "N/A",
            slSource: pos.slSource || "N/A",
            tpSource: pos.tpSource || "N/A"
          });
          state.hold = true;
        }
      }

      if(notify){
        memory.set(key, pos);
        notifyState.set(key, state);
      }

      actions.push({
        symbol: c.symbol,
        side: c.side,
        action,
        reason,
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        stage: c.stage,
        score: c.moveScore,
        confluence,
        rr: Number(pos.rr || 0).toFixed(2),
        price: c.price,
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp,
        slSource: pos.slSource || "N/A",
        tpSource: pos.tpSource || "N/A",
        flow: flow.type,
        sniper: sniper?.type || "NONE",
        sniperScore: sniper?.score || 0,
        funding: funding.rate || 0,
        obBias: ob.bias,
        spreadPct: ob.spreadPct ?? null,
        depthMinUsd1p: ob.depthMinUsd1p ?? null
      });

      continue;
    }

    // ================= ENTRY FILTERS =================

    if(getOpenTradeCount() >= MAX_OPEN_TRADES){
      actions.push(buildWait(c, "MAX_OPEN_TRADES", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // Blokkeer elke tweede positie op dezelfde coin, ongeacht bull/bear.
    if(hasAnyOpenPositionForSymbol(c.symbol)){
      const openSide = getOpenPositionSideForSymbol(c.symbol) || "unknown";
      actions.push(buildWait(c, `SYMBOL_ALREADY_OPEN_${openSide}`, flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // Blokkeer nieuwe entry op dezelfde coin kort na entry/exit.
    const symbolCooldownUntil = symbolCooldownMap.get(c.symbol) || 0;

    if(Date.now() < symbolCooldownUntil){
      actions.push(buildWait(c, "SYMBOL_COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // Blokkeer dubbele verwerking binnen dezelfde runtime.
    if(processingLocks.has(symbolLockKey)){
      actions.push(buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const cooldownUntil = cooldownMap.get(key) || 0;

    if(Date.now() < cooldownUntil){
      actions.push(buildWait(c, "COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const oppositeKey = `${c.symbol}_${isBull ? "bear" : "bull"}`;

    if(memory.has(oppositeKey)){
      actions.push(buildWait(c, "OPPOSITE_POSITION_OPEN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    if(vol === "LOW"){
      actions.push(buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    if(flow.type === "NEUTRAL"){
      actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
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
      actions.push(buildWait(c, "FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // ================= BTC BIAS SOFT =================
    const btcState = btc?.state || market?.trend || "NEUTRAL";

    if(btcState === "BULLISH" && !isBull && c.moveScore < 70){
      actions.push(buildWait(c, "BTC_BULL_BLOCK_SHORT", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    if(btcState === "BEARISH" && isBull && c.moveScore < 70){
      actions.push(buildWait(c, "BTC_BEAR_BLOCK_LONG", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // ================= CONFLUENCE FILTER =================
    const minConf = isBull ? 55 : 50;

    if(confluence < minConf){
      actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // ================= STRUCTURE QUALITY FILTER =================
    const obAgainst =
      (isBull && ob.bias === "BEARISH") ||
      (!isBull && ob.bias === "BULLISH");

    const hasLiquidationRoom = isBull
      ? !hasLiquidationData ||
        !liquidation?.nearestAbove ||
        c.price < liquidation.nearestAbove * 0.998
      : !hasLiquidationData ||
        !liquidation?.nearestBelow ||
        c.price > liquidation.nearestBelow * 1.002;

    if(obAgainst && confluence < 75){
      actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    if(!hasLiquidationRoom && confluence < 75){
      actions.push(buildWait(c, "NO_LIQUIDATION_ROOM", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // ================= MARKET QUALITY GUARD =================
    const spread = normalizeSpread(ob.spreadPct);
    const badSpread = spread > 0.01; // > 1%
    const badDepth = Number(ob.depthMinUsd1p || 0) < 75000;

    if((badSpread || badDepth) && confluence < 85){
      actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // ================= OB NEUTRAL GUARD - STRICTER =================
    if(ob.bias === "NEUTRAL" && confluence < 82){
      actions.push(buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    // ================= STAGE OK - QUALITY MODE =================
    const stageOK =
      c.stage === "entry" ||
      (
        c.stage === "almost" &&
        confluence >= 88 &&
        sniper?.valid &&
        Number(sniper.score || 0) >= 80 &&
        ob.bias !== "NEUTRAL"
      );

    const sniperOK =
      (
        sniper?.valid &&
        Number(sniper.score || 0) >= 65
      ) ||
      confluence >= 85;

    // ================= GRADE OK - QUALITY MODE =================
    const gradeOK =
      setupGrade.grade === "A" ||
      (
        setupGrade.grade === "B" &&
        confluence >= 78 &&
        ob.bias !== "NEUTRAL" &&
        Number(sniper?.score || 0) >= 75
      );

    // ================= ENTRY =================
    if(
      stageOK &&
      sniperOK &&
      gradeOK &&
      !ob.spoof
    ){

      const reasonEntry = sniper?.type || "CONFLUENCE_ENTRY";

      const isA = setupGrade.grade === "A";

      const partialRatio = isA ? 0.45 : 0.30;
      const sizeAfterPartial = isA ? 0.60 : 0.50;
      const trailPerc = isA
        ? (regime.trailPerc || 0.45)
        : (regime.trailPerc || 0.30);

      const position = {
        entry: c.price,
        sl: riskBase.sl,
        tp: riskBase.tp,
        partialTP: isBull
          ? c.price + (riskBase.tp - c.price) * partialRatio
          : c.price - (c.price - riskBase.tp) * partialRatio,
        trailingActive: false,
        maxPrice: c.price,
        sizeLeft: 1,
        sizeAfterPartial,
        trailPerc,
        rr,
        grade: setupGrade.grade,
        gradePoints: setupGrade.points,
        recommendedRisk: setupGrade.recommendedRisk,
        slSource: riskBase.slSource || "liquidity/orderbook",
        tpSource: riskBase.tpSource || "liquidity/liquidation"
      };

      action = "ENTRY";
      reason = reasonEntry;

      if(notify){

        // Zet lock + memory vóór Discord sturen.
        // Zo kan dezelfde runtime geen dubbele entry sturen.
        processingLocks.add(symbolLockKey);
        memory.set(key, position);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

        try{
          if(!state.entry){
            await sendEntry({
              symbol: c.symbol,
              side: c.side,
              entry: position.entry,
              sl: position.sl,
              tp: position.tp,
              rr: Number(position.rr).toFixed(2),
              sniper: reasonEntry,
              grade: position.grade,
              gradePoints: position.gradePoints,
              recommendedRisk: position.recommendedRisk,
              slSource: position.slSource,
              tpSource: position.tpSource,
              confluence,
              obBias: ob.bias
            });
            state.entry = true;
          }

          notifyState.set(key, state);

        }finally{
          processingLocks.delete(symbolLockKey);
        }
      }

      actions.push({
        symbol: c.symbol,
        side: c.side,
        action,
        reason,
        grade: position.grade,
        gradePoints: position.gradePoints,
        recommendedRisk: position.recommendedRisk,
        stage: c.stage,
        score: c.moveScore,
        confluence,
        rr: Number(rr).toFixed(2),
        price: c.price,
        entry: position.entry,
        sl: position.sl,
        tp: position.tp,
        slSource: position.slSource,
        tpSource: position.tpSource,
        flow: flow.type,
        sniper: sniper?.type || "NONE",
        sniperScore: sniper?.score || 0,
        funding: funding.rate || 0,
        obBias: ob.bias,
        spreadPct: ob.spreadPct ?? null,
        depthMinUsd1p: ob.depthMinUsd1p ?? null
      });

      continue;
    }

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
        riskBase,
        setupGrade
      )
    );
  }

  return actions.sort((a,b)=>Number(b.score || 0) - Number(a.score || 0));
}