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
function displayDirectionAllowed(c, side){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);
  const vm = Number(c.vm || 0);

  if(side === "bull"){
    return (
      ch24 > 0.25 ||
      ch1 > 0.03 ||
      (vm > 0.04 && ch24 > 0)
    );
  }

  if(side === "bear"){
    return (
      ch24 < -0.25 ||
      ch1 < -0.03 ||
      (vm > 0.04 && ch24 < 0)
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

  if(ch24 > 8) score += 35;
  else if(ch24 > 5) score += 25;
  else if(ch24 > 2) score += 15;
  else if(ch24 > 1) score += 8;
  else if(ch24 > 0.25) score += 4;

  if(ch1 > 1.2) score += 25;
  else if(ch1 > 0.5) score += 15;
  else if(ch1 > 0.2) score += 7;
  else if(ch1 > 0.03) score += 3;

  if(vm > 0.5) score += 25;
  else if(vm > 0.3) score += 15;
  else if(vm > 0.15) score += 8;
  else if(vm > 0.04) score += 4;

  if(regime === "LOW_VOL") score -= 15;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}


// ================= UI FALLBACK STAGE =================
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

    if(score < 6) continue;

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
    LOW_CONFLUENCE: "Setup mist bevestiging. Confluence niet versoepelen.",
    FAKE_BREAKOUT: "Fake breakout bescherming werkt.",
    OB_AGAINST: "Orderboek staat tegen trade. Correct geblokkeerd.",
    NO_LIQUIDATION_ROOM: "Te weinig ruimte naar liquidation/TP-zone.",
    BAD_MARKET_QUALITY: "Spread/depth slecht. Correct geblokkeerd.",
    OB_NEUTRAL_LOW_CONF: "Orderboek neutraal. Alleen doorlaten bij hoge confluence.",
    EXTREME_FUNDING: "Funding-risico. Correct geblokkeerd.",
    BULL_CROWDED_FUNDING: "Long te crowded. Correct geblokkeerd.",
    BEAR_CROWDED_FUNDING: "Short te crowded. Correct geblokkeerd.",
    BTC_BULL_BLOCK_SHORT: "Short tegen bullish BTC geblokkeerd.",
    BTC_BEAR_BLOCK_LONG: "Long tegen bearish BTC geblokkeerd.",
    COUNTERTREND_NOT_ELITE: "Countertrend is niet elite genoeg. Correct.",
    ENTRY_FILTERED: "Entry kwam niet door laatste kwaliteitscheck."
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
      "Scanner stuurt geen echte tradeCandidates. Meer trades krijg je via scanner-input, niet door TradeSystem filters los te gooien."
    );
    recommendations.moreTrades.push(
      "Veilige test: almost candidate threshold van 88 naar 85, terwijl TradeSystem de eindfilter blijft."
    );
  }

  if(total >= 8 && entryRate < 5){
    recommendations.moreTrades.push(
      "Entry-rate is laag. Stuur iets meer candidates naar TradeSystem in plaats van OB/confluence filters te versoepelen."
    );
  }

  if(topReason === "MAX_OPEN_TRADES"){
    recommendations.moreTrades.push(
      "Max open trades blokkeert entries. Overweeg MAX_OPEN_TRADES van 3 naar 4, maar alleen als gesloten trade-history positief blijft."
    );
  }

  if(topReason === "SYMBOL_COOLDOWN" || topReason === "COOLDOWN"){
    recommendations.moreTrades.push(
      "Cooldown blokkeert herentries. Verlaag cooldown pas na minimaal 30 gesloten trades."
    );
  }

  if(topReason === "ENTRY_FILTERED" && avgConfluence >= 78){
    recommendations.moreTrades.push(
      "Veel setups halen bijna de eindcheck. Test almost iets ruimer, maar alleen bij confluence ≥ 85."
    );
  }

  if(topReason === "OB_NEUTRAL_LOW_CONF" && avgConfluence >= 80){
    recommendations.moreTrades.push(
      "OB is vaak neutraal. Laat neutrale OB alleen door bij A-grade + confluence ≥ 88."
    );
  }

  // ================= HOGERE WINRATE =================
  if(topReason === "LOW_CONFLUENCE"){
    recommendations.higherWinrate.push(
      "Veel setups missen bevestiging. Confluence niet versoepelen; scanner moet betere candidates sturen."
    );
  }

  if(topReason === "OB_AGAINST"){
    recommendations.higherWinrate.push(
      "Orderboek staat vaak tegen de trade. Dit filter behouden voor hogere winrate."
    );
  }

  if(topReason === "BAD_MARKET_QUALITY"){
    recommendations.higherWinrate.push(
      "Slechte spread/depth wordt correct geblokkeerd. Dit verhoogt betrouwbaarheid."
    );
  }

  if(topReason === "NO_FLOW" || topReason === "LOW_VOL"){
    recommendations.higherWinrate.push(
      "Markt heeft te weinig flow/volatiliteit. Niet versoepelen; dit voorkomt chop trades."
    );
  }

  if(topReason === "COUNTERTREND_NOT_ELITE"){
    recommendations.higherWinrate.push(
      "Countertrend trades worden streng gefilterd. Dit is goed voor blind volgen."
    );
  }

  if(entries.length > 0 && avgConfluence < 75){
    recommendations.higherWinrate.push(
      "Entries hebben lage gemiddelde confluence. Maak entry alleen geldig bij confluence ≥ 78 of A-grade."
    );
  }

  if(entries.length > 0 && avgConfluence >= 80){
    recommendations.higherWinrate.push(
      "Entry kwaliteit is gezond. Niet strenger maken zonder verliesdata."
    );
  }

  // ================= HOGERE PNL =================
  if(entries.length > 0 && avgRR < 1){
    recommendations.higherPnl.push(
      "Gemiddelde RR is laag. Laat lage RR alleen toe bij A-grade en hoge confluence."
    );
  }

  if(entries.length > 0 && avgRR >= 1.2){
    recommendations.higherPnl.push(
      "RR is gezond. PnL verbeteren zit dan vooral in trailing/partials, niet in entries."
    );
  }

  if(topReason === "NO_LIQUIDATION_ROOM"){
    recommendations.higherPnl.push(
      "Te weinig ruimte naar liquidatie/TP-zone. Dit filter behouden; het beschermt PnL."
    );
  }

  if(entries.length > 0 && avgConfluence >= 85){
    recommendations.higherPnl.push(
      "Sterke confluence. Voor A-grade trades kun je partial iets later houden om meer upside te pakken."
    );
  }

  // ================= DEFAULTS =================
  if(recommendations.moreTrades.length === 0){
    recommendations.moreTrades.push(
      "Meer trades nu niet forceren. Eerst huidige kwaliteit meten tot minimaal 20-30 gesloten trades."
    );
  }

  if(recommendations.higherWinrate.length === 0){
    recommendations.higherWinrate.push(
      "Winrate-filtering ziet er normaal uit. Houd OB, confluence, funding en countertrend guards actief."
    );
  }

  if(recommendations.higherPnl.length === 0){
    recommendations.higherPnl.push(
      "PnL-advies wordt sterker zodra trade-history gesloten WIN/LOSS trades bevat."
    );
  }

  let advice = "TradeSystem gezond. Geen directe wijziging nodig.";

  if(total === 0){
    advice = "Geen echte tradeCandidates deze scan. Meer trades krijg je via scanner-input, niet door TradeSystem losser te maken.";
  }else if(entries.length === 0 && waits.length > 0){
    advice = `Geen entries. Grootste blokkade: ${topReason || "UNKNOWN"}. Bekijk advies hieronder.`;
  }else if(entryRate > 25){
    advice = "Veel entries. Let op overtrading; kwaliteit eventueel iets strenger.";
  }else if(entryRate < 3 && total >= 10){
    advice = "Weinig entries uit veel candidates. Alleen versoepelen als grootste blokkade geen kwaliteitsfilter is.";
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

      const newStage = safeStage(
        realFilterStage
          ? mergeStage(prev.stage, realFilterStage)
          : uiStage
      );

      coin.stage = newStage;
      coin.stageSource = realFilterStage ? "filter" : "fallback";
      coin.uiOnly = !realFilterStage;

      funnel[direction][newStage].push(coin);

      if(!coin.uiOnly && coin.stageSource === "filter"){
        logAnalytics(coin);
      }

      if(
        symbolTradable &&
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