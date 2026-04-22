import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers
} from "../lib/_main_shared.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { processTrades } from "../lib/tradeSystem.js";
import { setLatestScan, getLatestScan } from "../lib/scanStore.js";

import {
  resetAnalytics,
  logAnalytics,
  getAnalytics
} from "../lib/analyticsEngine.js";

import { generateAdvice } from "../lib/analysisAdvisor.js";
import { classifyMarket } from "../lib/marketClassifier.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import {
  loadStageMemory,
  saveStageMemory,
  cleanMemory
} from "../lib/stageMemory.js";

import { initDefaultFilters } from "../lib/filterState.js";


// ================= SIDE NORMALIZER =================
function normalizeScanSide(side){

  const s = String(side || "both").toLowerCase();

  if(s === "bull") return "bull";
  if(s === "bear") return "bear";

  return "both";
}


// ================= NOTIFY NORMALIZER =================
function normalizeNotify(value){

  const v = String(value || "").toLowerCase();

  return v === "true" || v === "1" || v === "yes";
}


// ================= STORE NORMALIZER =================
function normalizeStore(value, fallback = true){

  if(value === undefined || value === null){
    return fallback;
  }

  const v = String(value || "").toLowerCase();

  if(v === "false" || v === "0" || v === "no"){
    return false;
  }

  if(v === "true" || v === "1" || v === "yes"){
    return true;
  }

  return fallback;
}


// ================= STRICT SIDE LOGIC FOR REAL TRADES =================
// Alleen deze logic mag echte tradeCandidates maken.
function strictDirectionAllowed(c, btc, side){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  if(side === "bull"){

    if(btc.state === "BULLISH"){
      return ch24 > 3 && ch1 > 0.5;
    }

    if(btc.state === "BEARISH"){
      return ch24 > 8 && ch1 > 1.5;
    }

    return false;
  }

  if(side === "bear"){

    if(btc.state === "BEARISH"){
      return ch24 < -3 && ch1 < -0.5;
    }

    if(btc.state === "BULLISH"){
      return ch24 < -5 && ch1 < -1;
    }

    return false;
  }

  return false;
}


// ================= DISPLAY LOGIC FOR UI/FUNNEL =================
// Ruimer dan trade logic, zodat frontend coins blijft tonen.
// Deze logic maakt GEEN extra Discord/trades.
function displayDirectionAllowed(c, side){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);
  const vm = Number(c.vm || 0);

  if(side === "bull"){
    return (
      ch24 > 0.3 ||
      ch1 > 0.05 ||
      (vm > 0.05 && ch24 > 0)
    );
  }

  if(side === "bear"){
    return (
      ch24 < -0.3 ||
      ch1 < -0.05 ||
      (vm > 0.05 && ch24 < 0)
    );
  }

  return false;
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1 && ch24 > 5) return "TREND";
  if(ch1 > 0.6) return "BUILDING";
  if(ch24 > 3) return "EARLY";

  return "NEUTRAL";
}


// ================= DIRECTIONAL SCORE =================
function calculateScore(c, regime, side){

  let score = 0;

  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;
  const vm = Number(c.vm || 0);

  // momentum richting trade
  if(ch24 > 8) score += 35;
  else if(ch24 > 5) score += 25;
  else if(ch24 > 2) score += 15;
  else if(ch24 > 1) score += 8;
  else if(ch24 > 0.25) score += 4;

  if(ch1 > 1.2) score += 25;
  else if(ch1 > 0.5) score += 15;
  else if(ch1 > 0.2) score += 7;
  else if(ch1 > 0.03) score += 3;

  // volume / marketcap
  if(vm > 0.5) score += 25;
  else if(vm > 0.3) score += 15;
  else if(vm > 0.15) score += 8;
  else if(vm > 0.04) score += 4;

  if(regime === "LOW_VOL") score -= 15;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}


// ================= UI FALLBACK STAGE =================
// Bestaat alleen voor frontend zichtbaarheid.
function fallbackStage(score, flow){

  if(flow === "TREND" && score >= 75) return "almost";
  if(flow === "TREND" && score >= 60) return "buildup";
  if(flow === "TREND" && score >= 35) return "radar";
  if(flow === "BUILDING" && score >= 25) return "radar";
  if(flow === "EARLY") return "radar";

  return "radar";
}


// ================= STAGE MERGE =================
function mergeStage(prevStage, filterStage){

  const order = ["radar", "buildup", "almost", "entry"];

  const prevIndex = order.indexOf(prevStage || "radar");
  const newIndex = order.indexOf(filterStage || "radar");

  if(newIndex >= prevIndex){
    return filterStage;
  }

  return order[Math.max(0, prevIndex - 1)];
}


// ================= SYMBOL NORMALIZER =================
function normalizeBitgetKey(symbolKey){

  return String(symbolKey || "")
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "");
}


// ================= NORMALIZE =================
function normalize(raw){

  const marketCap = Number(raw?.market_cap || 0);
  const totalVolume = Number(raw?.total_volume || 0);

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: Number(raw?.current_price || 0),
    change24: Number(raw?.price_change_percentage_24h || 0),
    change1h: Number(raw?.price_change_percentage_1h_in_currency || 0),
    volume: totalVolume,
    marketCap,
    vm: marketCap > 0 ? totalVolume / marketCap : 0,
    ob: generateShallowOb()
  };
}


// ================= EMPTY FUNNEL =================
function emptyFunnel(){
  return {
    bull: { entry: [], almost: [], buildup: [], radar: [] },
    bear: { entry: [], almost: [], buildup: [], radar: [] }
  };
}


// ================= COUNT HELPERS =================
function countSide(funnel, side){

  if(!funnel?.[side]) return 0;

  let total = 0;

  for(const stage of ["entry", "almost", "buildup", "radar"]){
    total += Array.isArray(funnel[side][stage])
      ? funnel[side][stage].length
      : 0;
  }

  return total;
}


function countFunnel(funnel){
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}


function hasSymbolInSide(funnel, side, symbol){

  for(const stage of ["entry", "almost", "buildup", "radar"]){

    if(
      Array.isArray(funnel?.[side]?.[stage]) &&
      funnel[side][stage].some(c => c.symbol === symbol)
    ){
      return true;
    }
  }

  return false;
}


function sortFunnel(funnel){

  for(const side of ["bull", "bear"]){
    for(const stageKey of ["entry", "almost", "buildup", "radar"]){
      funnel[side][stageKey].sort((a, b) => {
        return Number(b.moveScore || 0) - Number(a.moveScore || 0);
      });
    }
  }
}


// ================= UI FALLBACK FILL =================
// Vult alleen de frontend-funnel.
// Stuurt GEEN Discord en maakt GEEN tradeCandidate.
function fillUiFallback({
  rawCoins,
  validSymbols,
  regime,
  funnel,
  side,
  max = 30
}){

  const currentSideCount = countSide(funnel, side);
  const targetMinimum = 12;

  if(currentSideCount >= targetMinimum) return;

  const list = [];

  for(const raw of rawCoins){

    const base = normalize(raw);

    if(!base.symbol || base.price <= 0) continue;

    if(validSymbols.size > 0 && !validSymbols.has(base.symbol)) continue;

    if(hasSymbolInSide(funnel, side, base.symbol)) continue;

    if(base.vm < 0.025) continue;

    const ch24 = Number(base.change24 || 0);
    const ch1 = Number(base.change1h || 0);

    if(side === "bull"){
      if(ch24 <= 0 && ch1 <= 0) continue;
    }

    if(side === "bear"){
      if(ch24 >= 0 && ch1 >= 0) continue;
    }

    const flow = detectFlow(base);
    const score = calculateScore(base, regime, side);
    const edge = calculateEdge(base, regime) || 0;

    if(score < 8) continue;

    list.push({
      ...base,
      side,
      flow,
      moveScore: score,
      edge,
      stage: fallbackStage(score, flow),
      stageSource: "ui_fallback",
      uiOnly: true
    });
  }

  list.sort((a,b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));

  let added = 0;
  let seededEntry = funnel[side].entry.length > 0 ? 1 : 0;

  for(const coin of list){

    if(added >= max) break;
    if(countSide(funnel, side) >= targetMinimum) break;

    let stage = coin.stage || "radar";

    // Belangrijk voor bestaande frontends/indexen die alleen entry tellen:
    // als entry leeg is, seed 1 UI-only coin in entry.
    // Dit maakt géén echte tradeCandidate.
    if(seededEntry === 0){
      stage = "entry";
      seededEntry = 1;
    }

    funnel[side][stage].push({
      ...coin,
      stage
    });

    added++;
  }
}


// ================= MERGE PARTIAL SIDE SCAN =================
function mergeWithPreviousSideScan(currentPayload, scanSide){

  if(scanSide === "both"){
    return currentPayload;
  }

  const previous = getLatestScan();

  if(!previous?.ok){
    return currentPayload;
  }

  const mergedFunnel = emptyFunnel();

  // huidige kant vervangen
  mergedFunnel[scanSide] =
    currentPayload.funnel?.[scanSide] || mergedFunnel[scanSide];

  // andere kant behouden
  const otherSide = scanSide === "bull" ? "bear" : "bull";

  mergedFunnel[otherSide] =
    previous.funnel?.[otherSide] || mergedFunnel[otherSide];

  const currentTrades = Array.isArray(currentPayload.trades)
    ? currentPayload.trades
    : [];

  const previousTrades = Array.isArray(previous.trades)
    ? previous.trades
    : [];

  const otherSideTrades = previousTrades.filter(t => t.side === otherSide);

  const mergedTrades = [...currentTrades, ...otherSideTrades]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const mergedAnalytics = {
    ...(previous.analytics || {}),
    [scanSide]: currentPayload.analytics?.[scanSide]
  };

  const mergedAdvice = {
    ...(previous.advice || {}),
    [scanSide]: currentPayload.advice?.[scanSide]
  };

  const candidatesBull =
    scanSide === "bull"
      ? currentPayload.candidatesBull
      : previous.candidatesBull || 0;

  const candidatesBear =
    scanSide === "bear"
      ? currentPayload.candidatesBear
      : previous.candidatesBear || 0;

  sortFunnel(mergedFunnel);

  return {
    ...previous,
    ...currentPayload,
    funnel: mergedFunnel,
    funnelCount: countFunnel(mergedFunnel),
    bullCount: countSide(mergedFunnel, "bull"),
    bearCount: countSide(mergedFunnel, "bear"),
    trades: mergedTrades,
    analytics: mergedAnalytics,
    advice: mergedAdvice,
    candidatesBull,
    candidatesBear,
    candidates: candidatesBull + candidatesBear,
    lastBullScan:
      scanSide === "bull"
        ? Date.now()
        : previous.lastBullScan || null,
    lastBearScan:
      scanSide === "bear"
        ? Date.now()
        : previous.lastBearScan || null,
    lastSideScan: scanSide,
    scanMode: "merged",
    updatedAt: Date.now()
  };
}


// ================= CORE =================
export async function buildScanPayload(options = {}){

  const scanSide = normalizeScanSide(options.side);

  // Cron/backend: notify true.
  // public-latest: notify false.
  const notify = options.notify !== false;

  // Cron/backend: store true.
  // public-latest: store false.
  const store = options.store !== false;

  initDefaultFilters();
  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();
  if(!Array.isArray(rawCoins)) throw new Error("API error");

  let futures = new Map();

  try{
    futures = await fetchFuturesTickers();
  }catch(e){
    console.error("BITGET FILTER ERROR:", e.message);
  }

  const validSymbols = new Set(
    Array.from(futures.keys())
      .map(normalizeBitgetKey)
      .filter(Boolean)
  );

  const btcRaw =
    rawCoins.find(c => String(c?.symbol || "").toUpperCase() === "BTC") ||
    rawCoins[0];

  const btc = {
    state: Number(btcRaw?.price_change_percentage_24h || 0) >= 0
      ? "BULLISH"
      : "BEARISH",
    chg24: Number(btcRaw?.price_change_percentage_24h || 0)
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = emptyFunnel();
  const tradeCandidates = [];

  let candidatesBull = 0;
  let candidatesBear = 0;

  let memory = await loadStageMemory();
  const activeSymbols = [];

  const sidesToScan =
    scanSide === "both"
      ? ["bull", "bear"]
      : [scanSide];

  for(const raw of rawCoins){

    const base = normalize(raw);

    if(!base.symbol || base.price <= 0) continue;

    // Bitget only, maar fallback als Bitget fetch faalt.
    if(validSymbols.size > 0 && !validSymbols.has(base.symbol)) continue;

    activeSymbols.push(base.symbol);

    // UI ruim houden.
    if(base.vm < 0.025) continue;

    if(
      Math.abs(base.change24) < 0.25 &&
      Math.abs(base.change1h) < 0.03
    ){
      continue;
    }

    for(const direction of sidesToScan){

      // UI/funnel gebruikt ruime logic.
      if(!displayDirectionAllowed(base, direction)) continue;

      const flow = detectFlow(base);
      const score = calculateScore(base, regime, direction);
      const edge = calculateEdge(base, regime) || 0;

      const coin = {
        ...base,
        side: direction,
        flow,
        moveScore: score,
        edge
      };

      const key = `${base.symbol}_${direction}`;
      const prev = memory[key] || { stage: "radar" };

      const realFilterStage =
        direction === "bull"
          ? bullFilter(coin)
          : bearFilter(coin);

      const uiStage = realFilterStage || fallbackStage(score, flow);

      if(!uiStage) continue;

      const newStage = realFilterStage
        ? mergeStage(prev.stage, realFilterStage)
        : uiStage;

      coin.stage = newStage;
      coin.stageSource = realFilterStage ? "filter" : "fallback";
      coin.uiOnly = !realFilterStage;

      funnel[direction][newStage].push(coin);
      logAnalytics(coin);

      // ================= REAL TRADE CANDIDATES ONLY =================
      // Alleen echte filterStage + strictDirection mag Discord/trade worden.
      if(
        realFilterStage &&
        strictDirectionAllowed(base, btc, direction) &&
        (
          (
            newStage === "entry" &&
            score >= 75 &&
            flow === "TREND"
          ) ||
          (
            newStage === "almost" &&
            score >= 88 &&
            flow === "TREND"
          )
        )
      ){
        tradeCandidates.push(coin);

        if(direction === "bull") candidatesBull++;
        if(direction === "bear") candidatesBear++;
      }

      memory[key] = {
        stage: newStage,
        prevStage: prev.stage || "radar"
      };
    }
  }

  // Zorg dat de frontend nooit lege arrays krijgt wanneer marktdata bestaat.
  if(scanSide === "both" || scanSide === "bull"){
    fillUiFallback({
      rawCoins,
      validSymbols,
      regime,
      funnel,
      side: "bull",
      max: 30
    });
  }

  if(scanSide === "both" || scanSide === "bear"){
    fillUiFallback({
      rawCoins,
      validSymbols,
      regime,
      funnel,
      side: "bear",
      max: 30
    });
  }

  memory = cleanMemory(memory, activeSymbols);

  // Silent scans mogen stageMemory niet overschrijven.
  if(store){
    await saveStageMemory(memory);
  }

  sortFunnel(funnel);

  const trades = await processTrades(
    tradeCandidates,
    btc,
    "auto",
    regime,
    { notify }
  );

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);

  const now = Date.now();

  const currentPayload = {
    ok: true,
    scanSide,
    scanMode: scanSide,
    notify,
    store,
    btc,
    regime,
    market,
    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),
    trades,
    analytics,
    advice,
    total: rawCoins.length,
    candidates: tradeCandidates.length,
    candidatesBull,
    candidatesBear,
    bitgetSymbols: validSymbols.size,
    updatedAt: now,
    lastBullScan: scanSide === "bull" || scanSide === "both" ? now : null,
    lastBearScan: scanSide === "bear" || scanSide === "both" ? now : null
  };

  const finalPayload = mergeWithPreviousSideScan(currentPayload, scanSide);

  // Alleen echte cron/backend scans mogen latestScan overschrijven.
  if(store){
    setLatestScan(finalPayload);
  }

  return finalPayload;
}


// ================= HANDLER =================
export default async function handler(req,res){

  try{
    const side = normalizeScanSide(req?.query?.side);

    // Direct /api/scanner is standaard stil.
    const notify = normalizeNotify(req?.query?.notify);

    // Alleen store wanneer expliciet of wanneer notify=true.
    const store = normalizeStore(req?.query?.store, notify);

    const data = await buildScanPayload({
      side,
      notify,
      store
    });

    return res.status(200).json(data);

  }catch(e){
    console.error("SCAN ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}