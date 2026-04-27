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
  getAdvancedRSIContext,
  isType1RSIEntry
} from "./rsiEngine.js";

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
const COOLDOWN_MS = 45 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;

// ================= EXECUTION QUALITY (ULTRA ELITE) =================
const MAX_SPREAD_PCT = 0.0025;
const MIN_DEPTH_USD_1P = 200000;
const MIN_RR_FLOOR = 1.05;

// ================= DYNAMIC RR FLOOR =================
const GRADE_A_MIN_RR_FLOOR = 1.0;
const GRADE_B_MIN_RR_FLOOR = 1.15;
const GRADE_C_MIN_RR_FLOOR = 1.25;
const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.2;

// ================= NEUTRAL OB TUNING =================
const NEUTRAL_OB_ENTRY_A_MIN_CONF = 77;
const NEUTRAL_OB_ENTRY_A_MIN_SNIPER = 75;
const NEUTRAL_OB_ENTRY_A_MIN_RR = 1.0;

const NEUTRAL_OB_ENTRY_B_MIN_CONF = 82;
const NEUTRAL_OB_ENTRY_B_MIN_SNIPER = 80;
const NEUTRAL_OB_ENTRY_B_MIN_SCORE = 82;
const NEUTRAL_OB_ENTRY_B_MIN_RR = 1.1;

const NEUTRAL_OB_ALMOST_A_MIN_CONF = 86;
const NEUTRAL_OB_ALMOST_A_MIN_SNIPER = 84;
const NEUTRAL_OB_ALMOST_MIN_RR = 1.1;

// ================= BUILDUP ELITE ENTRY =================
const BUILDUP_ELITE_MIN_CONF = 90;
const BUILDUP_ELITE_MIN_SNIPER = 80;
const BUILDUP_ELITE_MIN_SCORE = 78;
const BUILDUP_ELITE_MIN_RR = 1.1;
const BUILDUP_ELITE_MIN_TF = 2;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  fetchFailed: true
};

async function fetchCandles(symbol, timeframe = "1h", limit = 150){
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();

  if(!Array.isArray(data)) return [];

  return data.map(c => ({
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4])
  }));
}

// ================= HELPERS =================
function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function normalizeSpread(spreadPct){
  let s = Number(spreadPct || 0);

  if(!Number.isFinite(s) || s < 0){
    return 0.001;
  }

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

function getSniperScore(sniper){
  return Number(sniper?.score || 0);
}

function getRegimeKey(regimeObj, scannerRegime){
  const raw =
    regimeObj?.level ||
    regimeObj ||
    scannerRegime ||
    "NORMAL";

  return String(raw).toUpperCase();
}

function getTimeframeMeta(c){
  let ctx = null;
  let tfScore = 0;

  try{
    ctx = buildTimeframeContext(c) || {};
  }catch{
    ctx = {};
  }

  if(Number.isFinite(Number(ctx?.score))){
    tfScore = Number(ctx.score);
  }else if(Number.isFinite(Number(c?.tfScore))){
    tfScore = Number(c.tfScore);
  }else{
    tfScore = Number(multiTFScore(c) || 0);
  }

  const tfStrength = Math.abs(tfScore);

  return {
    ctx,
    tfScore,
    tfStrength,
    tfAlignment: String(ctx?.alignment || c?.tfAlignment || "UNKNOWN")
  };
}

function isObWithSide(ob, isBull){
  return (
    (isBull && ob?.bias === "BULLISH") ||
    (!isBull && ob?.bias === "BEARISH")
  );
}

function isObAgainstSide(ob, isBull){
  return (
    (isBull && ob?.bias === "BEARISH") ||
    (!isBull && ob?.bias === "BULLISH")
  );
}

function getRegimeValueForConfluence(regime, scannerRegime){
  return regime?.level || regime || scannerRegime || "NORMAL";
}

function buildCommonPayload(c, flow, sniper, funding, ob){
  return {
    symbol: c.symbol,
    side: c.side,
    stage: c.stage,
    stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly),
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
    minRrRequired: Number(c?.minRrFloor || 0),
    ts: Date.now()
  };
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
    .sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
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

  if(spread <= 0.0025 && depth >= 200000) points += 1;
  if(spread > MAX_SPREAD_PCT || depth < MIN_DEPTH_USD_1P) points -= 2;

  if(c.stage === "entry"){
    points += 1;
  }else if(c.stage === "buildup" && flow.type === "TREND" && tfStrength >= 2){
    points += 1;
  }

  if(rr >= 1.4) points += 1;
  else if(rr < 0.8) points -= 1;

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

// ========== NIEUW: buildWait met requiredConfluence & reasonScore ==========
function buildWait(c, reason, flow, sniper, confluence, rr, funding, ob, risk, setupGrade, requiredConfluence, requiredRR){
  const base = {
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
    tpSource: risk?.tpSource || "liquidity/liquidation",
    requiredConfluence: requiredConfluence ?? null,
    requiredRR: requiredRR ?? null
  };

  // reasonScore: hoeveel miste de kandidaat (negatief = tekort)
  let reasonScore = null;
  if(reason === "LOW_CONFLUENCE" && requiredConfluence !== null && confluence !== null){
    reasonScore = confluence - requiredConfluence;
  }
  if(reason === "LOW_RR" && requiredRR !== null && rr !== null){
    reasonScore = rr - requiredRR;
  }
  base.reasonScore = reasonScore;

  return base;
}

// ========== NIEUW: dynamische minConf (wordt gebruikt voor requiredConfluence) ==========
function getDynamicMinConf({ c, ob, flow, vol, isBull }) {
  let minConf = 48;

  if(ob.bias === "NEUTRAL") minConf += 1;
  if(flow.type === "BUILDING") minConf += 1;
  if(c.tfStrength < 2) minConf += 1;
  if(vol === "HIGH") minConf += 1;

  if(
    flow.type === "TREND" &&
    isObWithSide(ob, isBull) &&
    (c.sniper?.valid ?? false) &&
    getSniperScore(c.sniper) >= 80
  ){
    minConf -= 8;
  }

  return Math.max(40, minConf);
}

function isNeutralObEntryException({
  c,
  flow,
  sniper,
  confluence,
  rr,
  setupGrade,
  counterTrend
}){
  const sniperScore = getSniperScore(sniper);

  if(c.stage !== "entry") return false;
  if(flow.type !== "TREND") return false;
  if(counterTrend) return false;

  if(
    setupGrade.grade === "A" &&
    confluence >= NEUTRAL_OB_ENTRY_A_MIN_CONF &&
    rr >= NEUTRAL_OB_ENTRY_A_MIN_RR &&
    sniper?.valid &&
    sniperScore >= NEUTRAL_OB_ENTRY_A_MIN_SNIPER
  ){
    return true;
  }

  if(
    setupGrade.grade === "B" &&
    confluence >= NEUTRAL_OB_ENTRY_B_MIN_CONF &&
    rr >= NEUTRAL_OB_ENTRY_B_MIN_RR &&
    sniper?.valid &&
    sniperScore >= NEUTRAL_OB_ENTRY_B_MIN_SNIPER &&
    Number(c.moveScore || 0) >= NEUTRAL_OB_ENTRY_B_MIN_SCORE
  ){
    return true;
  }

  return false;
}

function isNeutralObAlmostException({
  c,
  flow,
  sniper,
  confluence,
  rr,
  setupGrade,
  counterTrend
}){
  const sniperScore = getSniperScore(sniper);

  return (
    c.stage === "almost" &&
    flow.type === "TREND" &&
    !counterTrend &&
    rr >= NEUTRAL_OB_ALMOST_MIN_RR &&
    setupGrade.grade === "A" &&
    confluence >= NEUTRAL_OB_ALMOST_A_MIN_CONF &&
    sniper?.valid &&
    sniperScore >= NEUTRAL_OB_ALMOST_A_MIN_SNIPER
  );
}

function getDynamicMinRrFloor({
  c,
  setupGrade,
  flow,
  sniper,
  confluence,
  counterTrend
}){
  let floor = MIN_RR_FLOOR;

  if(setupGrade?.grade === "A"){
    floor = GRADE_A_MIN_RR_FLOOR;
  }else if(setupGrade?.grade === "B"){
    floor = GRADE_B_MIN_RR_FLOOR;
  }else{
    floor = GRADE_C_MIN_RR_FLOOR;
  }

  if(c.stage === "buildup"){
    floor = Math.max(floor, BUILDUP_MIN_RR_FLOOR);
  }

  if(counterTrend){
    floor = Math.max(floor, COUNTERTREND_MIN_RR_FLOOR);
  }

  if(
    c.stage === "entry" &&
    flow?.type === "TREND" &&
    !counterTrend &&
    setupGrade?.grade === "A" &&
    confluence >= 88 &&
    sniper?.valid &&
    getSniperScore(sniper) >= 80
  ){
    floor = Math.min(floor, 0.85);
  }

  return clamp(floor, 0.95, 1.50);
}

async function logAction(actionPayload, regimeLevel, btcState, shouldLog){
  if(!shouldLog || !actionPayload) return;

  await logSystemEvent({
    ...actionPayload,
    regime: regimeLevel,
    btcState
  });
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
  const rsiMap = {};

  await Promise.all(
    candidates.map(async (c) => {
      const symbol = String(c.symbol || "").toUpperCase();

      try{
        const raw = await fetchOrderBook(symbol + "USDT");
        const analyzed = analyzeOrderBookAdvanced(raw);

        obMap[symbol] = {
          ...DEFAULT_OB,
          ...(analyzed || {}),
          fetchFailed: false
        };
      }catch{
        obMap[symbol] = { ...DEFAULT_OB };
      }

      try{
        fundingMap[symbol] = await fetchFunding(symbol + "USDT");
      }catch{
        fundingMap[symbol] = { rate: 0 };
      }

      try{
        // Multi-timeframe RSI (15m + 1h)
        const [c15m, c1h] = await Promise.all([
          fetchCandles(symbol + "USDT", "15m", 150),
          fetchCandles(symbol + "USDT", "1h", 150)
        ]);

        rsiMap[symbol] = {
          m15: getAdvancedRSIContext(c15m),
          h1: getAdvancedRSIContext(c1h)
        };
      }catch{
        rsiMap[symbol] = null;
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

    if(ob?.mid > 0){
      c.price = ob.mid;
    }

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
      const waitPayload = buildWait(
        c,
        "ORDERBOOK_FETCH_FAILED",
        flow,
        sniper,
        0,
        0,
        funding,
        ob,
        null,
        {
          grade: "C",
          points: 0,
          recommendedRisk: "watch"
        },
        null,
        null
      );

      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

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

    const riskBase = await calculateRisk(
      c,
      ob,
      liquidity,
      hasLiquidationData ? liquidation : null
    );

    const rr = Number.isFinite(Number(riskBase?.rr))
      ? Math.max(0, Number(riskBase.rr))
      : calculateFallbackRR(c, riskBase, isBull);

    const rsiData = rsiMap[c.symbol];

    const confluence = calculateConfluence(
      c,
      ob,
      liquidity,
      funding,
      regimeForConfluence,
      hasLiquidationData ? liquidation : null,
      rsiData?.m15
    );

    // ================= 🔥 QUALITY GATE =================
    const qualityFails = [];

    if(ob.bias !== "NEUTRAL" && !isObWithSide(ob, isBull)){
      qualityFails.push("OB");
    }

    if(flow.type === "NEUTRAL"){
      qualityFails.push("FLOW");
    }

    if(!sniper?.valid || getSniperScore(sniper) < 70){
      qualityFails.push("SNIPER");
    }

    if(c.tfStrength < 1){
      qualityFails.push("TF");
    }

    if(qualityFails.length >= 3){
      const waitPayload = buildWait(
        c,
        "QUALITY_FAIL_" + qualityFails.join("_"),
        flow,
        sniper,
        confluence,
        rr,
        funding,
        ob,
        riskBase,
        { grade: "C", points: 0, recommendedRisk: "watch" },
        null,
        null
      );

      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

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

    // ================= 🔥 HARD FILTER: ALLEEN SCANNER ENTRY =================
    if(c.stage !== "entry"){
      const waitPayload = buildWait(
        c,
        "ONLY_SCANNER_ENTRY_ALLOWED",
        flow,
        sniper,
        confluence,
        rr,
        funding,
        ob,
        riskBase,
        setupGrade,
        null,
        null
      );

      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    let state = notifyState.get(key) || {
      entry: false,
      hold: false,
      exit: false
    };

    let action = "WATCH";
    let reason = "WATCH";

    const counterTrend =
      (btcState === "BULLISH" && !isBull) ||
      (btcState === "BEARISH" && isBull);

    const neutralObEntryException = isNeutralObEntryException({
      c,
      flow,
      sniper,
      confluence,
      rr,
      setupGrade,
      counterTrend
    });

    const neutralObAlmostException = isNeutralObAlmostException({
      c,
      flow,
      sniper,
      confluence,
      rr,
      setupGrade,
      counterTrend
    });

    const minRrFloor = getDynamicMinRrFloor({
      c,
      setupGrade,
      flow,
      sniper,
      confluence,
      counterTrend
    });

    c.minRrFloor = minRrFloor;

    // =====================================================
    // MANAGE EXISTING POSITION FIRST
    // =====================================================
    if(prev){

      const pos = { ...prev };

      const hitTP =
        (isBull && c.price >= pos.tp) ||
        (!isBull && c.price <= pos.tp);

      const hitSL =
        (isBull && c.price <= pos.sl) ||
        (!isBull && c.price >= pos.sl);

      if(hitTP || hitSL){

        action = "EXIT";
        reason = hitTP ? "TP" : "SL";

        const exitPayload = {
          ...buildCommonPayload(c, flow, sniper, funding, ob),
          action,
          reason,
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence,
          rr: Number(pos.rr || 0).toFixed(2),
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A",
          rsi: pos.rsi,
          rsiHTF: pos.rsiHTF,
          rsiZone: pos.rsiZone
        };

        if(shouldLog){
          await logTrade({
            symbol: c.symbol,
            side: c.side,
            entry: pos.entry,
            exit: c.price,
            sl: pos.sl,
            tp: pos.tp,
            result: hitTP ? "WIN" : "LOSS",
            reason,
            rr: pos.rr,
            grade: pos.grade || "N/A",
            gradePoints: pos.gradePoints || 0,
            recommendedRisk: pos.recommendedRisk || "N/A",
            confluence,
            score: c.moveScore,
            flow: flow.type,
            sniper: sniper?.type || "NONE",
            sniperScore: sniper?.score || 0,
            obBias: ob.bias,
            funding: funding.rate || 0,
            slSource: pos.slSource || "N/A",
            tpSource: pos.tpSource || "N/A",
            regime: regimeLevel,
            btcState,
            rsi: pos.rsi,
            rsiHTF: pos.rsiHTF,
            rsiZone: pos.rsiZone
          });

          await logAction(exitPayload, regimeLevel, btcState, true);
        }

        if(notify && !state.exit){
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

        actions.push(exitPayload);
        continue;
      }

      action = "HOLD";
      reason = "RUNNING";

      if(notify && !state.hold){
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

      memory.set(key, pos);
      notifyState.set(key, state);

      const runningPayload = {
        ...buildCommonPayload(c, flow, sniper, funding, ob),
        action,
        reason,
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        confluence,
        rr: Number(pos.rr || 0).toFixed(2),
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp,
        slSource: pos.slSource || "N/A",
        tpSource: pos.tpSource || "N/A",
        rsi: pos.rsi,
        rsiHTF: pos.rsiHTF,
        rsiZone: pos.rsiZone
      };

      await logAction(runningPayload, regimeLevel, btcState, shouldLog);
      actions.push(runningPayload);
      continue;
    }

    // ================= ENTRY FILTERS =================

    if(hasAnyOpenPositionForSymbol(c.symbol)){
      const openSide = getOpenPositionSideForSymbol(c.symbol) || "unknown";
      const waitPayload = buildWait(c, `SYMBOL_ALREADY_OPEN_${openSide}`, flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const symbolCooldownUntil = symbolCooldownMap.get(c.symbol) || 0;

    if(Date.now() < symbolCooldownUntil){
      const waitPayload = buildWait(c, "SYMBOL_COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(processingLocks.has(symbolLockKey)){
      const waitPayload = buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const cooldownUntil = cooldownMap.get(key) || 0;

    if(Date.now() < cooldownUntil){
      const waitPayload = buildWait(c, "COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const oppositeKey = `${c.symbol}_${isBull ? "bear" : "bull"}`;

    if(memory.has(oppositeKey)){
      const waitPayload = buildWait(c, "OPPOSITE_POSITION_OPEN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(vol === "LOW"){
      const waitPayload = buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(flow.type === "NEUTRAL"){
      const waitPayload = buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(rr < minRrFloor){
      const waitPayload = buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, minRrFloor);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(
      (c.stage === "entry" && c.tfStrength < 1) ||
      (c.stage === "almost" && c.tfStrength < 1) ||
      (c.stage === "buildup" && c.tfStrength < BUILDUP_ELITE_MIN_TF)
    ){
      const waitPayload = buildWait(c, "ENTRY_FILTERED", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    let fakeBreakout = false;
    const breakoutBufferPct = getDynamicBreakoutBufferPct(c, regime, vol, ob);

    if(hasLiquidationData){

      if(
        isBull &&
        liquidation?.nearestAbove &&
        c.price > liquidation.nearestAbove * (1 + breakoutBufferPct)
      ){
        fakeBreakout = true;
      }

      if(
        !isBull &&
        liquidation?.nearestBelow &&
        c.price < liquidation.nearestBelow * (1 - breakoutBufferPct)
      ){
        fakeBreakout = true;
      }
    }

    if(fakeBreakout && confluence < 78){
      const waitPayload = buildWait(c, "FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(btcState === "BULLISH" && !isBull && c.moveScore < 70){
      const waitPayload = buildWait(c, "BTC_BULL_BLOCK_SHORT", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(btcState === "BEARISH" && isBull && c.moveScore < 70){
      const waitPayload = buildWait(c, "BTC_BEAR_BLOCK_LONG", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    // ================= 🔥 DYNAMISCHE CONFLUENCE THRESHOLD =================
    const minConf = getDynamicMinConf({ c, ob, flow, vol, isBull });

    if(confluence < minConf){
      const waitPayload = buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, minConf, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const obAgainst = isObAgainstSide(ob, isBull);

    const hasLiquidationRoom = isBull
      ? !hasLiquidationData ||
        !liquidation?.nearestAbove ||
        c.price < liquidation.nearestAbove * (1 - breakoutBufferPct)
      : !hasLiquidationData ||
        !liquidation?.nearestBelow ||
        c.price > liquidation.nearestBelow * (1 + breakoutBufferPct);

    if(obAgainst && confluence < 75){
      const waitPayload = buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(!hasLiquidationRoom && confluence < 75){
      const waitPayload = buildWait(c, "NO_LIQUIDATION_ROOM", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const spread = normalizeSpread(ob.spreadPct);
    const badSpread = spread > MAX_SPREAD_PCT;
    const badDepth = Number(ob.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;

    if((badSpread || badDepth) && confluence < 85){
      const waitPayload = buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(
      ob.bias === "NEUTRAL" &&
      !neutralObEntryException &&
      !neutralObAlmostException &&
      c.stage !== "buildup"
    ){
      const waitPayload = buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const fundingRate = Number(funding?.rate || 0);

    if(Math.abs(fundingRate) > 0.015 && confluence < 85){
      const waitPayload = buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(isBull && fundingRate > 0.012 && confluence < 85){
      const waitPayload = buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    if(!isBull && fundingRate < -0.012 && confluence < 85){
      const waitPayload = buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
      await logAction(waitPayload, regimeLevel, btcState, shouldLog);
      actions.push(waitPayload);
      continue;
    }

    const directionalOb = isObWithSide(ob, isBull);

    // Alleen entry stage is toegestaan (geen almost/buildup meer)
    const stageOK = c.stage === "entry";

    const sniperOK =
      (
        sniper?.valid &&
        getSniperScore(sniper) >= 65
      ) ||
      confluence >= 85;

    const gradeOK =
      setupGrade.grade === "A" ||
      (
        setupGrade.grade === "B" &&
        !counterTrend &&
        confluence >= 74 &&
        (
          ob.bias !== "NEUTRAL" ||
          neutralObEntryException
        ) &&
        getSniperScore(sniper) >= 68 &&
        c.tfStrength >= 1 &&
        c.stage !== "buildup"
      );

    if(counterTrend){
      const obRequired = directionalOb;

      if(
        setupGrade.grade !== "A" ||
        confluence < 85 ||
        getSniperScore(sniper) < 80 ||
        !obRequired
      ){
        const waitPayload = buildWait(c, "COUNTERTREND_NOT_ELITE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null);
        await logAction(waitPayload, regimeLevel, btcState, shouldLog);
        actions.push(waitPayload);
        continue;
      }
    }

    // ================= RSI MULTI-TIMEFRAME CHECK =================
    const rsiOk = rsiData
      ? (
          isType1RSIEntry(rsiData.m15, c.side) ||
          isType1RSIEntry(rsiData.h1, c.side)
        )
      : true;

    if(
      stageOK &&
      sniperOK &&
      gradeOK &&
      !ob.spoof &&
      rr >= minRrFloor &&
      rsiOk
    ){

      const reasonEntry = sniper?.type || "CONFLUENCE_ENTRY";

      const position = {
        symbol: c.symbol,
        side: c.side,
        stage: c.stage,
        stageSource: c.stageSource || "unknown",
        uiOnly: Boolean(c.uiOnly),
        entry: c.price,
        sl: riskBase.sl,
        initialSl: riskBase.sl,
        tp: riskBase.tp,
        rr,
        grade: setupGrade.grade,
        gradePoints: setupGrade.points,
        recommendedRisk: setupGrade.recommendedRisk,
        slSource: riskBase.slSource || "liquidity/orderbook",
        tpSource: riskBase.tpSource || "liquidity/liquidation",
        tfScore: c.tfScore,
        tfStrength: c.tfStrength,
        tfAlignment: c.tfAlignment,
        atrPct15m: c.atrPct15m,
        atrPct1h: c.atrPct1h,
        atrPct4h: c.atrPct4h,
        atrPct24h: c.atrPct24h,
        createdAt: Date.now(),
        // RSI logging
        rsi: rsiData?.m15?.rsi || null,
        rsiHTF: rsiData?.h1?.rsi || null,
        rsiZone: rsiData?.m15?.zone || null
      };

      action = "ENTRY";
      reason = reasonEntry;

      const entryPayload = {
        ...buildCommonPayload(c, flow, sniper, funding, ob),
        action,
        reason,
        grade: position.grade,
        gradePoints: position.gradePoints,
        recommendedRisk: position.recommendedRisk,
        confluence,
        rr: Number(rr).toFixed(2),
        entry: position.entry,
        sl: position.sl,
        tp: position.tp,
        slSource: position.slSource,
        tpSource: position.tpSource,
        rsi: position.rsi,
        rsiHTF: position.rsiHTF,
        rsiZone: position.rsiZone
      };

      processingLocks.add(symbolLockKey);

      try{
        memory.set(key, position);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

        await logAction(entryPayload, regimeLevel, btcState, shouldLog);

        if(notify && !state.entry){
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
            obBias: ob.bias,
            rsi: position.rsi,
            rsiHTF: position.rsiHTF,
            rsiZone: position.rsiZone
          });
          state.entry = true;
        }

        notifyState.set(key, state);

      }finally{
        processingLocks.delete(symbolLockKey);
      }

      actions.push(entryPayload);
      continue;
    }

    const waitPayload = buildWait(
      c,
      "ENTRY_FILTERED",
      flow,
      sniper,
      confluence,
      rr,
      funding,
      ob,
      riskBase,
      setupGrade,
      null,
      null
    );

    await logAction(waitPayload, regimeLevel, btcState, shouldLog);
    actions.push(waitPayload);
  }

  return actions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}