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

const STAGES = ["entry", "almost", "buildup", "radar"];


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


// ================= STAGE SAFETY =================
function safeStage(stage){

  return STAGES.includes(stage)
    ? stage
    : "radar";
}


// ================= STRICT SIDE LOGIC FOR REAL TRADES =================
// Breder dan vroeger zodat scanner meer uitvoerbare mid-caps doorlaat.
// TradeSystem blijft de laatste kwaliteitslaag.
function strictDirectionAllowed(c, btc, side){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  if(side === "bull"){

    if(btc.state === "BULLISH"){
      return ch24 > 2 && ch1 > 0.30;
    }

    if(btc.state === "BEARISH"){
      return ch24 > 6.5 && ch1 > 1.0;
    }

    return false;
  }

  if(side === "bear"){

    if(btc.state === "BEARISH"){
      return ch24 < -2 && ch1 < -0.30;
    }

    if(btc.state === "BULLISH"){
      return ch24 < -4 && ch1 < -0.8;
    }

    return false;
  }

  return false;
}


// ================= DISPLAY LOGIC FOR UI/FUNNEL =================
function displayDirectionAllowed(c, side){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);
  const vm = Number(c.vm || 0);

  if(side === "bull"){
    return (
      ch24 > 0.15 ||
      ch1 > 0.02 ||
      (vm > 0.03 && ch24 > 0)
    );
  }

  if(side === "bear"){
    return (
      ch24 < -0.15 ||
      ch1 < -0.02 ||
      (vm > 0.03 && ch24 < 0)
    );
  }

  return false;
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1 && ch24 > 4) return "TREND";
  if(ch1 > 0.45) return "BUILDING";
  if(ch24 > 2.5) return "EARLY";

  return "NEUTRAL";
}


// ================= FRESHNESS =================
// Beloont verse uitbraken meer dan oude 24h pumps.
function calculateFreshness(c, side){

  const dir = side === "bear" ? -1 : 1;

  const ch24 = Math.max(0, Number(c.change24 || 0) * dir);
  const ch1 = Math.max(0, Number(c.change1h || 0) * dir);

  let freshness = 0;

  if(ch1 > 1.5) freshness += 18;
  else if(ch1 > 0.9) freshness += 13;
  else if(ch1 > 0.45) freshness += 9;
  else if(ch1 > 0.2) freshness += 5;

  if(ch24 > 0){
    const ratio = ch1 / Math.max(ch24, 0.01);

    if(ratio > 0.45) freshness += 8;
    else if(ratio > 0.25) freshness += 5;
    else if(ratio > 0.12) freshness += 2;
  }

  // Straf voor laat achter de pump aan rennen
  if(ch24 > 8 && ch1 < 0.25) freshness -= 8;
  if(ch24 > 12 && ch1 < 0.10) freshness -= 10;

  return Math.max(0, Math.min(freshness, 30));
}


// ================= DIRECTIONAL SCORE =================
// Minder gewicht op oude 24h move, meer op 1h/freshness.
// Daardoor vang je eerder verse uitbrekende munten.
function calculateScore(c, regime, side){

  let score = 0;

  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;
  const vm = Number(c.vm || 0);
  const freshness = calculateFreshness(c, side);

  if(ch24 > 10) score += 22;
  else if(ch24 > 6) score += 16;
  else if(ch24 > 3) score += 10;
  else if(ch24 > 1) score += 5;
  else if(ch24 > 0.25) score += 2;

  if(ch1 > 2) score += 32;
  else if(ch1 > 1.1) score += 24;
  else if(ch1 > 0.55) score += 15;
  else if(ch1 > 0.2) score += 7;
  else if(ch1 > 0.03) score += 3;

  if(vm > 0.40) score += 20;
  else if(vm > 0.20) score += 12;
  else if(vm > 0.10) score += 7;
  else if(vm > 0.04) score += 3;

  score += freshness;

  if(regime === "LOW_VOL") score -= 8;
  if(regime === "HIGH_VOL") score += 4;

  return Math.max(0, Math.min(score, 100));
}


// ================= UI FALLBACK STAGE =================
function fallbackStage(score, flow, freshness = 0){

  if(flow === "TREND" && score >= 82) return "entry";
  if(flow === "TREND" && score >= 70) return "almost";
  if(flow === "TREND" && score >= 52) return "buildup";
  if(flow === "BUILDING" && score >= 34) return "buildup";
  if(flow === "BUILDING" && freshness >= 8) return "radar";
  if(flow === "EARLY" && score >= 22) return "radar";

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

  for(const stage of STAGES){
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

  for(const stage of STAGES){

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
    for(const stageKey of STAGES){
      funnel[side][stageKey].sort((a, b) => {
        return Number(b.moveScore || 0) - Number(a.moveScore || 0);
      });
    }
  }
}


// ================= UI FALLBACK FILL =================
function fillUiFallback({
  rawCoins,
  regime,
  funnel,
  side,
  max = 30
}){

  const targetMinimum = 12;

  if(countSide(funnel, side) >= targetMinimum) return;

  const list = [];

  for(const raw of rawCoins){

    const base = normalize(raw);

    if(!base.symbol || base.price <= 0) continue;
    if(hasSymbolInSide(funnel, side, base.symbol)) continue;
    if(base.vm < 0.02) continue;

    const ch24 = Number(base.change24 || 0);
    const ch1 = Number(base.change1h || 0);

    if(side === "bull" && ch24 <= 0 && ch1 <= 0) continue;
    if(side === "bear" && ch24 >= 0 && ch1 >= 0) continue;

    const flow = detectFlow(base);
    const score = calculateScore(base, regime, side);
    const edge = calculateEdge(base, regime) || 0;
    const freshness = calculateFreshness(base, side);

    if(score < 6) continue;

    list.push({
      ...base,
      side,
      flow,
      freshness,
      moveScore: score,
      edge,
      stage: fallbackStage(score, flow, freshness),
      stageSource: "ui_fallback",
      uiOnly: true
    });
  }

  list.sort((a,b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));

  let added = 0;
  let entrySeeded = funnel[side].entry.length > 0;

  for(const coin of list){

    if(added >= max) break;
    if(countSide(funnel, side) >= targetMinimum) break;

    let stage = safeStage(coin.stage);

    if(!entrySeeded){
      stage = "entry";
      entrySeeded = true;
    }

    funnel[side][stage].push({
      ...coin,
      stage
    });

    added++;
  }
}


// ================= TRADE SYSTEM ANALYSIS =================
function pct(count, total){

  if(!total) return 0;

  return Number(((count / total) * 100).toFixed(1));
}


function avg(list, field){

  const nums = list
    .map(x => Number(x?.[field] || 0))
    .filter(n => Number.isFinite(n));

  if(!nums.length) return 0;

  return Number((nums.reduce((a,b) => a + b, 0) / nums.length).toFixed(2));
}


function groupByCount(list, field){

  const out = {};

  for(const item of list){

    const key = String(item?.[field] || "UNKNOWN");

    if(!out[key]){
      out[key] = 0;
    }

    out[key]++;
  }

  return out;
}


function toRows(group, total){

  return Object.entries(group)
    .map(([key, count]) => ({
      key,
      count,
      pct: pct(count, total)
    }))
    .sort((a,b) => b.count - a.count);
}


function getReasonAdvice(reason){

  const map = {
    MAX_OPEN_TRADES: "Max open trades bereikt. Geen filterprobleem.",
    SYMBOL_COOLDOWN: "Cooldown voorkomt dubbele entries op dezelfde coin.",
    COOLDOWN: "Cooldown actief na vorige trade.",
    OPPOSITE_POSITION_OPEN: "Tegengestelde positie wordt correct geblokkeerd.",
    DUPLICATE_PROCESSING_LOCK: "Duplicate protection werkt.",
    LOW_VOL: "Te weinig volatiliteit. Correct geblokkeerd.",
    NO_FLOW: "Geen duidelijke flow. Correct geblokkeerd.",
    LOW_CONFLUENCE: "Setup mist bevestiging. Confluence niet zomaar versoepelen.",
    LOW_RR: "Risk/reward is te zwak. Dit voorkomt late entries.",
    FAKE_BREAKOUT: "Dynamische fake breakout-bescherming werkt.",
    OB_AGAINST: "Orderboek staat tegen trade. Correct geblokkeerd.",
    NO_LIQUIDATION_ROOM: "Te weinig ruimte naar liquidation/TP-zone.",
    BAD_MARKET_QUALITY: "Spread/depth slecht. Correct geblokkeerd.",
    OB_NEUTRAL_LOW_CONF: "Orderboek neutraal. Alleen sterke uitzonderingen mogen nog door.",
    EXTREME_FUNDING: "Funding-risico. Correct geblokkeerd.",
    BULL_CROWDED_FUNDING: "Long te crowded. Correct geblokkeerd.",
    BEAR_CROWDED_FUNDING: "Short te crowded. Correct geblokkeerd.",
    BTC_BULL_BLOCK_SHORT: "Short tegen bullish BTC geblokkeerd.",
    BTC_BEAR_BLOCK_LONG: "Long tegen bearish BTC geblokkeerd.",
    COUNTERTREND_NOT_ELITE: "Countertrend is niet elite genoeg. Correct.",
    ENTRY_FILTERED: "Entry kwam niet door de laatste kwaliteitscheck."
  };

  if(String(reason || "").startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Er staat al een positie open op deze coin. Correct geblokkeerd.";
  }

  return map[reason] || "Geen specifieke actie nodig.";
}


function buildTradeSystemAnalysis(trades){

  const list = Array.isArray(trades)
    ? trades
    : [];

  const total = list.length;

  const entries = list.filter(t => t.action === "ENTRY");
  const waits = list.filter(t => t.action === "WAIT");
  const holds = list.filter(t => t.action === "HOLD");
  const partials = list.filter(t => t.action === "PARTIAL");
  const exits = list.filter(t => t.action === "EXIT");

  const reasonGroup = groupByCount(waits, "reason");
  const gradeGroup = groupByCount(list, "grade");
  const actionGroup = groupByCount(list, "action");
  const obGroup = groupByCount(list, "obBias");
  const sideGroup = groupByCount(list, "side");

  const waitReasons = toRows(reasonGroup, waits.length).map(row => ({
    ...row,
    advice: getReasonAdvice(row.key)
  }));

  const entryRate = pct(entries.length, total);
  const waitRate = pct(waits.length, total);

  const avgConfluence = avg(list, "confluence");
  const avgRR = avg(list, "rr");
  const avgScore = avg(list, "score");

  const topReason = waitReasons[0]?.key || null;
  const topReasonPct = waitReasons[0]?.pct || 0;

  const recommendations = {
    moreTrades: [],
    higherWinrate: [],
    higherPnl: []
  };

  // ================= MEER TRADES =================
  if(total === 0){
    recommendations.moreTrades.push(
      "Scanner stuurde deze run geen echte tradeCandidates. Meer trades haal je nu vooral uit betere scanner-input."
    );
    recommendations.moreTrades.push(
      "Veilige test: almost candidate threshold stap voor stap iets omlaag, terwijl TradeSystem de laatste kwaliteitslaag blijft."
    );
  }

  if(total >= 8 && entryRate < 5){
    recommendations.moreTrades.push(
      "Entry-rate is laag. Eerst scanner-input verbeteren in plaats van TradeSystem guards los te gooien."
    );
  }

  if(topReason === "MAX_OPEN_TRADES"){
    recommendations.moreTrades.push(
      "MAX_OPEN_TRADES blokkeert trades. Verhoog alleen naar 4 als gesloten trade-history positief blijft."
    );
  }

  if(topReason === "SYMBOL_COOLDOWN" || topReason === "COOLDOWN"){
    recommendations.moreTrades.push(
      "Cooldown blokkeert herentries. Pas verlagen na voldoende gesloten trades."
    );
  }

  if(topReason === "ENTRY_FILTERED" && avgConfluence >= 78){
    recommendations.moreTrades.push(
      "Veel setups halen bijna de eindcheck. Test eerst iets meer almost candidates vanuit de scanner."
    );
  }

  if(topReason === "OB_NEUTRAL_LOW_CONF" && avgConfluence >= 80){
    recommendations.moreTrades.push(
      "Neutral orderboek is nog een bottleneck. Laat neutrale OB alleen door bij sterke confluence en hoge sniper."
    );
  }

  // ================= HOGERE WINRATE =================
  if(topReason === "LOW_CONFLUENCE"){
    recommendations.higherWinrate.push(
      "Confluence niet versoepelen. De scanner moet sterkere setups aanleveren."
    );
  }

  if(topReason === "OB_AGAINST"){
    recommendations.higherWinrate.push(
      "Orderboek tegen de trade moet geblokkeerd blijven."
    );
  }

  if(topReason === "BAD_MARKET_QUALITY"){
    recommendations.higherWinrate.push(
      "Spread/depth guards beschermen winrate en blind execution."
    );
  }

  if(topReason === "NO_FLOW" || topReason === "LOW_VOL"){
    recommendations.higherWinrate.push(
      "Flow/volatiliteit guards niet versoepelen; die voorkomen chop trades."
    );
  }

  if(topReason === "COUNTERTREND_NOT_ELITE"){
    recommendations.higherWinrate.push(
      "Countertrend filtering is gezond voor blind volgen."
    );
  }

  if(entries.length > 0 && avgConfluence < 75){
    recommendations.higherWinrate.push(
      "Gemiddelde confluence van entries is laag. Entry mag dan strakker."
    );
  }

  if(entries.length > 0 && avgConfluence >= 80){
    recommendations.higherWinrate.push(
      "Entry-kwaliteit is gezond. Niet strenger maken zonder closed-trade data."
    );
  }

  // ================= HOGERE PNL =================
  if(entries.length > 0 && avgRR < 1){
    recommendations.higherPnl.push(
      "Gemiddelde RR is laag. Filter lage RR harder of laat scanner frissere moves door."
    );
  }

  if(entries.length > 0 && avgRR >= 1.2){
    recommendations.higherPnl.push(
      "RR is gezond. Meer PnL haal je dan eerder uit trailing/partials dan uit soepelere entries."
    );
  }

  if(topReason === "NO_LIQUIDATION_ROOM"){
    recommendations.higherPnl.push(
      "Liquidation-room guard beschermt TP-potentieel. Niet losser zetten."
    );
  }

  if(entries.length > 0 && avgConfluence >= 85){
    recommendations.higherPnl.push(
      "Sterke confluence. Bij A-grade trades kun je later testen met iets later partial nemen."
    );
  }

  if(recommendations.moreTrades.length === 0){
    recommendations.moreTrades.push(
      "Meer trades nu niet forceren. Eerst de nieuwe scanner-output meten op gesloten trades."
    );
  }

  if(recommendations.higherWinrate.length === 0){
    recommendations.higherWinrate.push(
      "Winrate-filters ogen gezond. Houd OB, confluence, funding en countertrend guards actief."
    );
  }

  if(recommendations.higherPnl.length === 0){
    recommendations.higherPnl.push(
      "PnL-advies wordt sterker zodra er voldoende gesloten trades gelogd zijn."
    );
  }

  let advice = "TradeSystem gezond. Geen directe wijziging nodig.";

  if(total === 0){
    advice = "Geen echte tradeCandidates deze scan. Meer trades krijg je nu vooral via betere scanner-input.";
  }else if(entries.length === 0 && waits.length > 0){
    advice = `Geen entries. Grootste blokkade: ${topReason || "UNKNOWN"}.`;
  }else if(entryRate > 25){
    advice = "Veel entries. Let op overtrading; kwaliteit eventueel later iets strenger.";
  }else if(entryRate < 3 && total >= 10){
    advice = "Weinig entries uit veel candidates. Eerst scanner-output verbeteren.";
  }

  return {
    total,
    entries: entries.length,
    waits: waits.length,
    holds: holds.length,
    partials: partials.length,
    exits: exits.length,

    entryRate,
    waitRate,

    avgConfluence,
    avgRR,
    avgScore,

    topReason,
    topReasonPct,

    actions: toRows(actionGroup, total),
    grades: toRows(gradeGroup, total),
    obBias: toRows(obGroup, total),
    sides: toRows(sideGroup, total),
    waitReasons,

    recommendations,
    advice
  };
}


// ================= MERGE PARTIAL SIDE SCAN =================
async function mergeWithPreviousSideScan(currentPayload, scanSide){

  if(scanSide === "both"){
    return currentPayload;
  }

  const previous = await getLatestScan();

  if(!previous?.ok){
    return currentPayload;
  }

  const mergedFunnel = emptyFunnel();

  mergedFunnel[scanSide] =
    currentPayload.funnel?.[scanSide] || mergedFunnel[scanSide];

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
    tradeSystemAnalysis: buildTradeSystemAnalysis(mergedTrades),
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

  const notify = options.notify !== false;
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

    activeSymbols.push(base.symbol);

    const symbolTradable =
      validSymbols.size === 0 || validSymbols.has(base.symbol);

    if(base.vm < 0.02) continue;

    if(
      Math.abs(base.change24) < 0.2 &&
      Math.abs(base.change1h) < 0.02
    ){
      continue;
    }

    for(const direction of sidesToScan){

      if(!displayDirectionAllowed(base, direction)) continue;

      const flow = detectFlow(base);
      const score = calculateScore(base, regime, direction);
      const edge = calculateEdge(base, regime) || 0;
      const freshness = calculateFreshness(base, direction);

      const coin = {
        ...base,
        side: direction,
        flow,
        freshness,
        moveScore: score,
        edge
      };

      const key = `${base.symbol}_${direction}`;
      const prev = memory[key] || { stage: "radar" };

      const realFilterStage =
        direction === "bull"
          ? bullFilter(coin)
          : bearFilter(coin);

      const uiStage = realFilterStage || fallbackStage(score, flow, freshness);

      const newStage = safeStage(
        realFilterStage
          ? mergeStage(prev.stage, realFilterStage)
          : uiStage
      );

      coin.stage = newStage;
      coin.stageSource = realFilterStage ? "filter" : "fallback";
      coin.uiOnly = !realFilterStage;

      funnel[direction][newStage].push(coin);

      // Alleen echte filter-coins meenemen in analytics
      if(!coin.uiOnly && coin.stageSource === "filter"){
        logAnalytics(coin);
      }

      // ================= REAL TRADE CANDIDATES ONLY =================
      // Scanner nu iets breder zodat TradeSystem meer werkbare setups krijgt.
      if(
        symbolTradable &&
        realFilterStage &&
        strictDirectionAllowed(base, btc, direction) &&
        (
          (
            newStage === "entry" &&
            score >= 72 &&
            flow === "TREND"
          ) ||
          (
            newStage === "almost" &&
            score >= 84 &&
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

  // Zorg dat frontend niet leeg wordt
  if(scanSide === "both" || scanSide === "bull"){
    fillUiFallback({
      rawCoins,
      regime,
      funnel,
      side: "bull",
      max: 30
    });
  }

  if(scanSide === "both" || scanSide === "bear"){
    fillUiFallback({
      rawCoins,
      regime,
      funnel,
      side: "bear",
      max: 30
    });
  }

  memory = cleanMemory(memory, activeSymbols);

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
  const tradeSystemAnalysis = buildTradeSystemAnalysis(trades);

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
    tradeSystemAnalysis,
    total: rawCoins.length,
    candidates: tradeCandidates.length,
    candidatesBull,
    candidatesBear,
    bitgetSymbols: validSymbols.size,
    updatedAt: now,
    lastBullScan: scanSide === "bull" || scanSide === "both" ? now : null,
    lastBearScan: scanSide === "bear" || scanSide === "both" ? now : null
  };

  const finalPayload = await mergeWithPreviousSideScan(
    currentPayload,
    scanSide
  );

  if(store){
    await setLatestScan(finalPayload);
  }

  return finalPayload;
}


// ================= HANDLER =================
export default async function handler(req,res){

  try{
    const side = normalizeScanSide(req?.query?.side);

    const notify = normalizeNotify(req?.query?.notify);
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