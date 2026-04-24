import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";
import { calculateRisk } from "./riskManager.js";
import { logTrade, logSystemEvent } from "./logger.js";
import { getVolatility, getVolatilityRegime } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";
import { buildTimeframeContext, multiTFScore } from "./timeframe.js";

import { getLiquidityZones } from "./liquidityEngine.js";
import { getLiquidationZones } from "./liquidationEngine.js";
import { calculateConfluence } from "./confluenceEngine.js";
import { fetchFunding } from "./funding.js";

import {
  sendEntry,
  sendHold,
  sendExit
} from "./discordNotifier.js";

const memory = new Map();
const notifyState = new Map();
const cooldownMap = new Map();

// ================= DUPLICATE PROTECTION =================
const symbolCooldownMap = new Map();
const processingLocks = new Set();

// ================= QUALITY MODE =================
const MAX_OPEN_TRADES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 45 * 60 * 1000;

// ================= EXECUTION QUALITY =================
const MAX_SPREAD_PCT = 0.0035;
const MIN_DEPTH_USD_1P = 100000;
const MIN_RR_FLOOR = 0.80; // verlaagd van 0.85

// ================= NEUTRAL OB TUNING =================
const NEUTRAL_OB_ENTRY_A_MIN_CONF = 74;
const NEUTRAL_OB_ENTRY_A_MIN_SNIPER = 72;
const NEUTRAL_OB_ENTRY_A_MIN_RR = 0.95;

const NEUTRAL_OB_ENTRY_B_MIN_CONF = 79;
const NEUTRAL_OB_ENTRY_B_MIN_SNIPER = 78;
const NEUTRAL_OB_ENTRY_B_MIN_SCORE = 80;
const NEUTRAL_OB_ENTRY_B_MIN_RR = 1.0;

const NEUTRAL_OB_ALMOST_A_MIN_CONF = 84;
const NEUTRAL_OB_ALMOST_A_MIN_SNIPER = 82;
const NEUTRAL_OB_ALMOST_MIN_RR = 1.05;

// ================= BUILDUP ELITE ENTRY =================
const BUILDUP_ELITE_MIN_CONF = 88;
const BUILDUP_ELITE_MIN_SNIPER = 78;
const BUILDUP_ELITE_MIN_SCORE = 76;
const BUILDUP_ELITE_MIN_RR = 1.0;
const BUILDUP_ELITE_MIN_TF = 2;

// ================= DEFAULT OB =================
const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  fetchFailed: true
};


// ================= HELPERS =================
function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function normalizeSpread(spreadPct){
  let s = Number(spreadPct || 0);
  if(!Number.isFinite(s) || s < 0) return 0.001;
  if(s > 0.05) s = s / 100;
  return s;
}

function calculateFallbackRR(c, risk, isBull){
  const price = Number(c.price || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);
  if(!price || !sl || !tp) return 0;
  const raw = isBull ? (tp - price) / (price - sl) : (price - tp) / (sl - price);
  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

function getOpenTradeCount(){
  return memory.size;
}

function cleanExpiredGuards(){
  const now = Date.now();
  for(const [key, until] of cooldownMap.entries()) if(now >= until) cooldownMap.delete(key);
  for(const [symbol, until] of symbolCooldownMap.entries()) if(now >= until) symbolCooldownMap.delete(symbol);
}

function hasAnyOpenPositionForSymbol(symbol){
  const s = String(symbol || "").toUpperCase();
  for(const key of memory.keys()) if(key.startsWith(`${s}_`)) return true;
  return false;
}

function getOpenPositionSideForSymbol(symbol){
  const s = String(symbol || "").toUpperCase();
  for(const key of memory.keys()) if(key.startsWith(`${s}_`)) return key.split("_")[1] || "unknown";
  return null;
}

function stageRank(stage){
  if(stage === "entry") return 4;
  if(stage === "almost") return 3;
  if(stage === "buildup") return 2;
  if(stage === "radar") return 1;
  return 0;
}

function getSniperScore(sniper){
  return Number(sniper?.score || 0);
}

function getRegimeKey(regimeObj, scannerRegime){
  const raw = regimeObj?.level || regimeObj || scannerRegime || "NORMAL";
  return String(raw).toUpperCase();
}

function getTimeframeMeta(c){
  let ctx = null;
  let tfScore = 0;
  try{ ctx = buildTimeframeContext(c) || {}; }catch{ ctx = {}; }
  if(Number.isFinite(Number(ctx?.score))) tfScore = Number(ctx.score);
  else if(Number.isFinite(Number(c?.tfScore))) tfScore = Number(c.tfScore);
  else tfScore = Number(multiTFScore(c) || 0);
  const tfStrength = Math.abs(tfScore);
  return { ctx, tfScore, tfStrength, tfAlignment: String(ctx?.alignment || c?.tfAlignment || "UNKNOWN") };
}

function isObWithSide(ob, isBull){
  return (isBull && ob?.bias === "BULLISH") || (!isBull && ob?.bias === "BEARISH");
}
function isObAgainstSide(ob, isBull){
  return (isBull && ob?.bias === "BEARISH") || (!isBull && ob?.bias === "BULLISH");
}

function getRegimeValueForConfluence(regime, scannerRegime){
  return regime?.level || regime || scannerRegime || "NORMAL";
}

// ================= AANGEPASTE buildCommonPayload =================
function buildCommonPayload(c, flow, sniper, funding, ob){
  return {
    symbol: c.symbol,
    side: c.side,
    stage: c.stage,
    stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly),
    bitgetSymbol: c.bitgetSymbol || null,
    productType: c.productType || null,
    score: c.moveScore,
    price: c.price,
    flow: flow?.type || "NEUTRAL",
    sniper: sniper?.type || "NONE",
    sniperScore: sniper?.score || 0,
    funding: funding?.rate || 0,
    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null,
    tfScore: Number(c?.tfScore || 0),
    tfStrength: Number(c?.tfStrength || 0),
    tfAlignment: c?.tfAlignment || "UNKNOWN",
    ts: Date.now()
  };
}


function buildWait(c, reason, flow, sniper, confluence, rr, funding, ob, risk, setupGrade){
  return {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "WAIT",
    reason,
    grade: setupGrade?.grade || "C",
    gradePoints: setupGrade?.points || 0,
    recommendedRisk: setupGrade?.recommendedRisk || "watch",
    confluence,
    rr: Number(rr || 0).toFixed(2),
    entry: risk?.entry ?? c.price ?? null,
    sl: risk?.sl ?? null,
    tp: risk?.tp ?? null,
    slSource: risk?.slSource || "liquidity/orderbook",
    tpSource: risk?.tpSource || "liquidity/liquidation"
  };
}

function isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend }){
  const sniperScore = getSniperScore(sniper);
  if(c.stage !== "entry") return false;
  if(flow.type !== "TREND") return false;
  if(counterTrend) return false;
  if(setupGrade.grade === "A" && confluence >= NEUTRAL_OB_ENTRY_A_MIN_CONF && rr >= NEUTRAL_OB_ENTRY_A_MIN_RR && sniper?.valid && sniperScore >= NEUTRAL_OB_ENTRY_A_MIN_SNIPER)
    return true;
  if(setupGrade.grade === "B" && confluence >= NEUTRAL_OB_ENTRY_B_MIN_CONF && rr >= NEUTRAL_OB_ENTRY_B_MIN_RR && sniper?.valid && sniperScore >= NEUTRAL_OB_ENTRY_B_MIN_SNIPER && Number(c.moveScore || 0) >= NEUTRAL_OB_ENTRY_B_MIN_SCORE)
    return true;
  return false;
}

function isNeutralObAlmostException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend }){
  const sniperScore = getSniperScore(sniper);
  return (c.stage === "almost" && flow.type === "TREND" && !counterTrend && rr >= NEUTRAL_OB_ALMOST_MIN_RR && setupGrade.grade === "A" && confluence >= NEUTRAL_OB_ALMOST_A_MIN_CONF && sniper?.valid && sniperScore >= NEUTRAL_OB_ALMOST_A_MIN_SNIPER);
}

async function logAction(actionPayload, regimeLevel, btcState, shouldLog){
  if(!shouldLog || !actionPayload) return;
  await logSystemEvent({ ...actionPayload, regime: regimeLevel, btcState });
}

function dedupeCandidates(coins){
  const map = new Map();
  for(const raw of Array.isArray(coins) ? coins : []){
    if(!raw?.symbol || !raw?.side) continue;
    const symbol = String(raw.symbol).toUpperCase();
    const side = String(raw.side).toLowerCase();
    if(side !== "bull" && side !== "bear") continue;
    const normalized = { ...raw, symbol, side };
    const key = `${symbol}_${side}`;
    const prev = map.get(key);
    if(!prev){ map.set(key, normalized); continue; }
    const prevStage = stageRank(prev.stage);
    const newStage = stageRank(normalized.stage);
    const prevScore = Number(prev.moveScore || 0);
    const newScore = Number(normalized.moveScore || 0);
    if(newStage > prevStage || (newStage === prevStage && newScore > prevScore))
      map.set(key, normalized);
  }
  return Array.from(map.values()).sort((a,b)=>Number(b.moveScore||0)-Number(a.moveScore||0));
}

function getDynamicBreakoutBufferPct(c, regimeObj, vol, ob){
  const ch1Abs = Math.abs(Number(c.change1h || 0));
  const ch24Abs = Math.abs(Number(c.change24 || 0));
  const spread = normalizeSpread(ob?.spreadPct);
  const regimeKey = getRegimeKey(regimeObj, null);
  let pct = 0.0025;
  pct += clamp((ch1Abs / 100) * 0.70, 0, 0.0050);
  pct += clamp((ch24Abs / 100) * 0.10, 0, 0.0030);
  pct += clamp(spread * 0.60, 0, 0.0015);
  if(vol === "HIGH") pct += 0.0010;
  if(regimeKey === "HIGH_VOL" || regimeKey === "HIGH") pct += 0.0010;
  if(regimeKey === "LOW_VOL" || regimeKey === "LOW") pct -= 0.0005;
  return clamp(pct, 0.0025, 0.0120);
}

function getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull }){
  let points = 0;
  const tfStrength = Number(c?.tfStrength || 0);
  if(confluence >= 85) points += 4;
  else if(confluence >= 75) points += 3;
  else if(confluence >= 65) points += 2;
  else if(confluence >= 55) points += 1;
  if(flow.type === "TREND") points += 2;
  else if(flow.type === "BUILDING") points += 1;
  if(sniper?.valid) points += 2;
  if(Number(sniper?.score || 0) >= 75) points += 1;
  if(tfStrength >= 2) points += 2;
  else if(tfStrength >= 1) points += 1;
  const obWith = isObWithSide(ob, isBull);
  const obAgainst = isObAgainstSide(ob, isBull);
  if(obWith) points += 2;
  if(obAgainst) points -= 2;
  if(hasLiquidationData) points += 1;
  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);
  if(spread <= 0.003 && depth >= 150000) points += 1;
  if(spread > MAX_SPREAD_PCT || depth < MIN_DEPTH_USD_1P) points -= 2;
  if(c.stage === "entry") points += 1;
  else if(c.stage === "buildup" && flow.type === "TREND" && tfStrength >= 2) points += 1;
  if(rr >= 1.2) points += 1;
  else if(rr < 0.6) points -= 1;
  let grade = "C", recommendedRisk = "watch";
  if(points >= 9){ grade = "A"; recommendedRisk = "normal"; }
  else if(points >= 6){ grade = "B"; recommendedRisk = "small"; }
  return { grade, points, recommendedRisk };
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
  const shouldLog = options.log !== false;

  cleanExpiredGuards();

  const candidates = dedupeCandidates(coins);

  const actions = [];
  const market = await getMarketContext();

  const obMap = {};
  const fundingMap = {};

  // Prefetch orderbooks en funding (geen batching, gewoon parallel)
  await Promise.all(
    candidates.map(async (c) => {
      const symbol = String(c.symbol || "").toUpperCase();
      const marketSymbol = String(c.bitgetSymbol || `${symbol}USDT`).toUpperCase();
      const productType = String(c.productType || "USDT-FUTURES").toUpperCase();

      try{
        const raw = await fetchOrderBook(marketSymbol, productType);
        const analyzed = analyzeOrderBookAdvanced(raw);
        obMap[symbol] = { ...DEFAULT_OB, ...(analyzed || {}), fetchFailed: false };
      }catch{
        obMap[symbol] = { ...DEFAULT_OB };
      }

      try{
        fundingMap[symbol] = await fetchFunding(marketSymbol);
      }catch{
        fundingMap[symbol] = { rate: 0 };
      }
    })
  );

  for(const originalCoin of candidates){
    const c = { ...originalCoin };
    c.symbol = String(c.symbol || "").toUpperCase();
    c.side = String(c.side || "").toLowerCase();

    const key = `${c.symbol}_${c.side}`;
    const symbolLockKey = `LOCK_${c.symbol}`;
    const prev = memory.get(key);

    const ob = obMap[c.symbol] || { ...DEFAULT_OB };
    const funding = fundingMap[c.symbol] || { rate: 0 };

    if(ob?.mid > 0) c.price = ob.mid;

    const isBull = c.side === "bull";

    const tfMeta = getTimeframeMeta(c);
    c.tfContext = tfMeta.ctx;
    c.tfScore = tfMeta.tfScore;
    c.tfStrength = tfMeta.tfStrength;
    c.tfAlignment = tfMeta.tfAlignment;
    c.atrPct15m = Number(tfMeta.ctx?.atrPct15m || 0);
    c.atrPct1h = Number(tfMeta.ctx?.atrPct1h || 0);
    c.atrPct4h = Number(tfMeta.ctx?.atrPct4h || 0);
    c.atrPct24h = Number(tfMeta.ctx?.atrPct24h || 0);

    const flow = analyzeFlow(c);
    c.flow = flow.type;

    const sniper = getSniperEntry(c, ob);
    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const regimeLevel = getRegimeKey(regime, scannerRegime);
    const regimeForConfluence = getRegimeValueForConfluence(regime, scannerRegime);

    const liquidity = getLiquidityZones(c, ob);
    const btcState = btc?.state || market?.trend || "NEUTRAL";

    if(ob.fetchFailed){
      const waitPayload = buildWait(c, "ORDERBOOK_FETCH_FAILED", flow, sniper, 0, 0, funding, ob, null, { grade: "C", points: 0, recommendedRisk: "watch" });
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    let liquidation = null;
    try{
      liquidation = await getLiquidationZones(
        c.bitgetSymbol || (c.symbol + "USDT"),
        c.price
      );
    }catch{
      liquidation = null;
    }

    const hasLiquidationData = Array.isArray(liquidation?.clusters) && liquidation.clusters.length > 0;

    const riskBase = calculateRisk(c, ob, liquidity, hasLiquidationData ? liquidation : null);
    const rr = Number.isFinite(Number(riskBase?.rr)) ? Math.max(0, Number(riskBase.rr)) : calculateFallbackRR(c, riskBase, isBull);
    const confluence = calculateConfluence(c, ob, liquidity, funding, regimeForConfluence, hasLiquidationData ? liquidation : null);
    const setupGrade = getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull });

    let state = notifyState.get(key) || { entry: false, hold: false, exit: false };
    let action = "WATCH";
    let reason = "WATCH";

    const counterTrend = (btcState === "BULLISH" && !isBull) || (btcState === "BEARISH" && isBull);
    const neutralObEntryException = isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend });
    const neutralObAlmostException = isNeutralObAlmostException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend });

    // ================= BESTAANDE POSITIE =================
    if(prev){
      const pos = { ...prev };
      const hitTP = (isBull && c.price >= pos.tp) || (!isBull && c.price <= pos.tp);
      const hitSL = (isBull && c.price <= pos.sl) || (!isBull && c.price >= pos.sl);

      if(hitTP || hitSL){
        action = "EXIT";
        reason = hitTP ? "TP" : "SL";
        const exitPayload = {
          ...buildCommonPayload(c, flow, sniper, funding, ob),
          action, reason,
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence,
          rr: Number(pos.rr || 0).toFixed(2),
          entry: pos.entry, sl: pos.sl, tp: pos.tp,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A"
        };
        if(shouldLog){
          await logTrade({ symbol: c.symbol, side: c.side, entry: pos.entry, exit: c.price, sl: pos.sl, tp: pos.tp, result: hitTP ? "WIN" : "LOSS", reason, rr: pos.rr, grade: pos.grade || "N/A", gradePoints: pos.gradePoints || 0, recommendedRisk: pos.recommendedRisk || "N/A", confluence, score: c.moveScore, flow: flow.type, sniper: sniper?.type || "NONE", sniperScore: sniper?.score || 0, obBias: ob.bias, funding: funding.rate || 0, slSource: pos.slSource || "N/A", tpSource: pos.tpSource || "N/A", regime: regimeLevel, btcState });
          await logAction(exitPayload, regimeLevel, btcState, true);
        }
        if(notify && !state.exit){
          await sendExit({ symbol: c.symbol, side: c.side, reason, rr: Number(pos.rr || 0).toFixed(2), grade: pos.grade || "N/A", recommendedRisk: pos.recommendedRisk || "N/A", slSource: pos.slSource || "N/A", tpSource: pos.tpSource || "N/A" });
          state.exit = true;
        }
        memory.delete(key);
        notifyState.delete(key);
        cooldownMap.set(key, Date.now() + COOLDOWN_MS);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
        actions.push(exitPayload);
        continue;
      }

      action = "HOLD";
      reason = "RUNNING";
      if(notify && !state.hold){
        await sendHold({ symbol: c.symbol, side: c.side, flow: flow.type, score: c.moveScore, rr: Number(pos.rr || 0).toFixed(2), grade: pos.grade || "N/A", recommendedRisk: pos.recommendedRisk || "N/A", slSource: pos.slSource || "N/A", tpSource: pos.tpSource || "N/A" });
        state.hold = true;
      }
      memory.set(key, pos);
      notifyState.set(key, state);
      const runningPayload = {
        ...buildCommonPayload(c, flow, sniper, funding, ob),
        action, reason,
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        confluence,
        rr: Number(pos.rr || 0).toFixed(2),
        entry: pos.entry, sl: pos.sl, tp: pos.tp,
        slSource: pos.slSource || "N/A",
        tpSource: pos.tpSource || "N/A"
      };
      await logAction(runningPayload, regimeLevel, btcState, shouldLog);
      actions.push(runningPayload);
      continue;
    }

    // ================= ENTRY FILTERS (verkort weergegeven, maar volledig) =================
    if(getOpenTradeCount() >= MAX_OPEN_TRADES){
      actions.push(buildWait(c, "MAX_OPEN_TRADES", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(hasAnyOpenPositionForSymbol(c.symbol)){
      actions.push(buildWait(c, `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol) || "unknown"}`, flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(Date.now() < (symbolCooldownMap.get(c.symbol) || 0)){
      actions.push(buildWait(c, "SYMBOL_COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(processingLocks.has(symbolLockKey)){
      actions.push(buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(Date.now() < (cooldownMap.get(key) || 0)){
      actions.push(buildWait(c, "COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(memory.has(`${c.symbol}_${isBull ? "bear" : "bull"}`)){
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
    if(rr < MIN_RR_FLOOR){
      actions.push(buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if((c.stage === "entry" && c.tfStrength < 1) || (c.stage === "almost" && c.tfStrength < 1) || (c.stage === "buildup" && c.tfStrength < BUILDUP_ELITE_MIN_TF)){
      actions.push(buildWait(c, "ENTRY_FILTERED", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    let fakeBreakout = false;
    const breakoutBufferPct = getDynamicBreakoutBufferPct(c, regime, vol, ob);
    if(hasLiquidationData){
      if(isBull && liquidation?.nearestAbove && c.price > liquidation.nearestAbove * (1 + breakoutBufferPct)) fakeBreakout = true;
      if(!isBull && liquidation?.nearestBelow && c.price < liquidation.nearestBelow * (1 - breakoutBufferPct)) fakeBreakout = true;
    }
    if(fakeBreakout && confluence < 78){
      actions.push(buildWait(c, "FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    if(btcState === "BULLISH" && !isBull && c.moveScore < 70){
      actions.push(buildWait(c, "BTC_BULL_BLOCK_SHORT", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(btcState === "BEARISH" && isBull && c.moveScore < 70){
      actions.push(buildWait(c, "BTC_BEAR_BLOCK_LONG", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const minConf = isBull ? 55 : 50;
    if(confluence < minConf){
      actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const obAgainst = isObAgainstSide(ob, isBull);
    const hasLiquidationRoom = isBull
      ? !hasLiquidationData || !liquidation?.nearestAbove || c.price < liquidation.nearestAbove * (1 - breakoutBufferPct)
      : !hasLiquidationData || !liquidation?.nearestBelow || c.price > liquidation.nearestBelow * (1 + breakoutBufferPct);
    if(obAgainst && confluence < 75){
      actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(!hasLiquidationRoom && confluence < 75){
      actions.push(buildWait(c, "NO_LIQUIDATION_ROOM", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const spread = normalizeSpread(ob.spreadPct);
    const badSpread = spread > MAX_SPREAD_PCT;
    const badDepth = Number(ob.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;
    if((badSpread || badDepth) && confluence < 85){
      actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    if(ob.bias === "NEUTRAL" && !neutralObEntryException && !neutralObAlmostException && c.stage !== "buildup"){
      actions.push(buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const fundingRate = Number(funding?.rate || 0);
    if(Math.abs(fundingRate) > 0.015 && confluence < 85){
      actions.push(buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(isBull && fundingRate > 0.012 && confluence < 85){
      actions.push(buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }
    if(!isBull && fundingRate < -0.012 && confluence < 85){
      actions.push(buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
      continue;
    }

    const directionalOb = isObWithSide(ob, isBull);
    const almostOK = c.stage === "almost" && ((confluence >= 82 && sniper?.valid && getSniperScore(sniper) >= 72 && c.tfStrength >= 1 && flow.type !== "NEUTRAL" && ob.bias !== "NEUTRAL") || neutralObAlmostException);
    const buildupOK = c.stage === "buildup" && !counterTrend && flow.type === "TREND" && directionalOb && setupGrade.grade === "A" && Number(c.moveScore || 0) >= BUILDUP_ELITE_MIN_SCORE && c.tfStrength >= BUILDUP_ELITE_MIN_TF && rr >= BUILDUP_ELITE_MIN_RR && confluence >= BUILDUP_ELITE_MIN_CONF && sniper?.valid && getSniperScore(sniper) >= BUILDUP_ELITE_MIN_SNIPER;
    const stageOK = c.stage === "entry" || almostOK || buildupOK;
    const sniperOK = (sniper?.valid && getSniperScore(sniper) >= 65) || confluence >= 85;
    const gradeOK = setupGrade.grade === "A" || (setupGrade.grade === "B" && !counterTrend && confluence >= 74 && (ob.bias !== "NEUTRAL" || neutralObEntryException) && getSniperScore(sniper) >= 68 && c.tfStrength >= 1 && c.stage !== "buildup");

    if(counterTrend){
      const obRequired = directionalOb;
      if(setupGrade.grade !== "A" || confluence < 85 || getSniperScore(sniper) < 80 || !obRequired){
        actions.push(buildWait(c, "COUNTERTREND_NOT_ELITE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
        continue;
      }
    }

    if(stageOK && sniperOK && gradeOK && !ob.spoof && rr >= MIN_RR_FLOOR){
      const reasonEntry = c.stage === "buildup" ? "BUILDUP_ELITE_ENTRY" : sniper?.type || "CONFLUENCE_ENTRY";
      const position = {
        symbol: c.symbol, side: c.side, stage: c.stage, stageSource: c.stageSource || "unknown",
        uiOnly: Boolean(c.uiOnly), entry: c.price, sl: riskBase.sl, initialSl: riskBase.sl,
        tp: riskBase.tp, rr, grade: setupGrade.grade, gradePoints: setupGrade.points,
        recommendedRisk: setupGrade.recommendedRisk, slSource: riskBase.slSource || "liquidity/orderbook",
        tpSource: riskBase.tpSource || "liquidity/liquidation", tfScore: c.tfScore, tfStrength: c.tfStrength,
        tfAlignment: c.tfAlignment, atrPct15m: c.atrPct15m, atrPct1h: c.atrPct1h, atrPct4h: c.atrPct4h,
        atrPct24h: c.atrPct24h, createdAt: Date.now()
      };
      action = "ENTRY";
      reason = reasonEntry;
      const entryPayload = {
        ...buildCommonPayload(c, flow, sniper, funding, ob),
        action, reason, grade: position.grade, gradePoints: position.gradePoints,
        recommendedRisk: position.recommendedRisk, confluence, rr: Number(rr).toFixed(2),
        entry: position.entry, sl: position.sl, tp: position.tp,
        slSource: position.slSource, tpSource: position.tpSource
      };
      processingLocks.add(symbolLockKey);
      try{
        memory.set(key, position);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
        await logAction(entryPayload, regimeLevel, btcState, shouldLog);
        if(notify && !state.entry){
          await sendEntry({ symbol: c.symbol, side: c.side, entry: position.entry, sl: position.sl, tp: position.tp, rr: Number(position.rr).toFixed(2), sniper: reasonEntry, grade: position.grade, gradePoints: position.gradePoints, recommendedRisk: position.recommendedRisk, slSource: position.slSource, tpSource: position.tpSource, confluence, obBias: ob.bias });
          state.entry = true;
        }
        notifyState.set(key, state);
      }finally{
        processingLocks.delete(symbolLockKey);
      }
      actions.push(entryPayload);
      continue;
    }

    actions.push(buildWait(c, "ENTRY_FILTERED", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade));
  }

  return actions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}