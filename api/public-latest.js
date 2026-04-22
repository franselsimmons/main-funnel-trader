import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers
} from "../lib/_main_shared.js";

import { detectRegime } from "../lib/regime.js";
import { classifyMarket } from "../lib/marketClassifier.js";

const UI_CACHE_TTL = 12 * 1000;
let uiCache = null;

const STAGES = ["entry", "almost", "buildup", "radar"];

function emptySide(){
  return {
    entry: [],
    almost: [],
    buildup: [],
    radar: []
  };
}

function emptyFunnel(){
  return {
    bull: emptySide(),
    bear: emptySide()
  };
}

function normalizeFunnel(funnel){

  return {
    bull: {
      entry: Array.isArray(funnel?.bull?.entry) ? funnel.bull.entry : [],
      almost: Array.isArray(funnel?.bull?.almost) ? funnel.bull.almost : [],
      buildup: Array.isArray(funnel?.bull?.buildup) ? funnel.bull.buildup : [],
      radar: Array.isArray(funnel?.bull?.radar) ? funnel.bull.radar : []
    },
    bear: {
      entry: Array.isArray(funnel?.bear?.entry) ? funnel.bear.entry : [],
      almost: Array.isArray(funnel?.bear?.almost) ? funnel.bear.almost : [],
      buildup: Array.isArray(funnel?.bear?.buildup) ? funnel.bear.buildup : [],
      radar: Array.isArray(funnel?.bear?.radar) ? funnel.bear.radar : []
    }
  };
}

function countSide(funnel, side){

  const f = normalizeFunnel(funnel);

  let total = 0;

  for(const stage of STAGES){
    total += Array.isArray(f?.[side]?.[stage])
      ? f[side][stage].length
      : 0;
  }

  return total;
}

function countFunnel(funnel){
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

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

function normalizeCoin(raw){

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

function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1 && ch24 > 5) return "TREND";
  if(ch1 > 0.6) return "BUILDING";
  if(ch24 > 3) return "EARLY";

  return "NEUTRAL";
}

function calculateScore(c, side){

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

  return Math.max(0, Math.min(score, 100));
}

function fallbackStage(score, flow){

  if(flow === "TREND" && score >= 75) return "almost";
  if(flow === "TREND" && score >= 60) return "buildup";
  if(flow === "TREND" && score >= 35) return "radar";
  if(flow === "BUILDING" && score >= 25) return "radar";

  return "radar";
}

function sortFunnel(funnel){

  for(const side of ["bull", "bear"]){
    for(const stage of STAGES){
      funnel[side][stage].sort((a,b) => {
        return Number(b.moveScore || 0) - Number(a.moveScore || 0);
      });
    }
  }
}

function withSafeShape(payload, source){

  const funnel = normalizeFunnel(payload?.funnel);

  return {
    ...(payload || {}),
    ok: payload?.ok !== false,
    source,
    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),
    trades: Array.isArray(payload?.trades) ? payload.trades : [],
    btc: payload?.btc || { state: "UNKNOWN", chg24: 0 },
    regime: payload?.regime || "UNKNOWN",
    market: payload?.market || null,
    analytics: payload?.analytics || {},
    advice: payload?.advice || {},
    servedAt: Date.now()
  };
}

function hasGoodFunnel(payload){
  return Boolean(payload?.ok && countFunnel(payload?.funnel) > 0);
}

function mergeUiFreshWithCached(fresh, cached){

  const cachedTrades = Array.isArray(cached?.trades)
    ? cached.trades
    : [];

  const freshTrades = Array.isArray(fresh?.trades)
    ? fresh.trades
    : [];

  return {
    ...fresh,
    trades: cachedTrades.length ? cachedTrades : freshTrades,
    lastBullScan: cached?.lastBullScan || fresh?.lastBullScan || null,
    lastBearScan: cached?.lastBearScan || fresh?.lastBearScan || null,
    cachedAt: cached?.storedAt || cached?.updatedAt || null,
    previousCacheHadData: Boolean(cached?.ok),
    previousFunnelCount: countFunnel(cached?.funnel)
  };
}


// ================= EMERGENCY UI SCAN =================
// Deze draait alleen als scanner/cache leeg is.
// Maakt GEEN Discord.
// Maakt GEEN echte trades.
// Vult alleen funnel voor frontend.
async function buildEmergencyUiPayload(){

  const rawCoins = await fetchCoinGeckoTopCached();

  if(!Array.isArray(rawCoins)){
    throw new Error("emergency_rawcoins_failed");
  }

  let futures = new Map();

  try{
    futures = await fetchFuturesTickers();
  }catch{
    futures = new Map();
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

  for(const raw of rawCoins){

    const base = normalizeCoin(raw);

    if(!base.symbol || base.price <= 0) continue;

    // Voor UI mogen we coins tonen, ook als futures-fetch leeg/faalt.
    if(validSymbols.size > 0 && !validSymbols.has(base.symbol)) continue;

    if(base.vm < 0.015) continue;

    const ch24 = Number(base.change24 || 0);
    const ch1 = Number(base.change1h || 0);

    // Bull UI
    if(ch24 > 0 || ch1 > 0){

      const flow = detectFlow(base);
      const score = calculateScore(base, "bull");
      const stage = fallbackStage(score, flow);

      if(score >= 5){
        funnel.bull[stage].push({
          ...base,
          side: "bull",
          flow,
          moveScore: score,
          edge: 0,
          stage,
          uiOnly: true
        });
      }
    }

    // Bear UI
    if(ch24 < 0 || ch1 < 0){

      const flow = detectFlow(base);
      const score = calculateScore(base, "bear");
      const stage = fallbackStage(score, flow);

      if(score >= 5){
        funnel.bear[stage].push({
          ...base,
          side: "bear",
          flow,
          moveScore: score,
          edge: 0,
          stage,
          uiOnly: true
        });
      }
    }
  }

  // Als entry leeg is, seed één beste coin naar entry zodat home-counts niet 0 blijven.
  for(const side of ["bull", "bear"]){

    if(funnel[side].entry.length === 0){

      const all = [
        ...funnel[side].almost,
        ...funnel[side].buildup,
        ...funnel[side].radar
      ].sort((a,b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));

      const best = all[0];

      if(best){
        funnel[side].entry.push({
          ...best,
          stage: "entry",
          uiOnly: true
        });
      }
    }
  }

  sortFunnel(funnel);

  return {
    ok: true,
    source: "emergency_ui_scan",
    scanSide: "both",
    scanMode: "emergency_ui",
    notify: false,
    store: false,
    btc,
    regime,
    market,
    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),
    trades: [],
    analytics: {},
    advice: {},
    total: rawCoins.length,
    candidates: 0,
    candidatesBull: 0,
    candidatesBear: 0,
    bitgetSymbols: validSymbols.size,
    updatedAt: Date.now()
  };
}


export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const now = Date.now();

    if(
      uiCache?.data &&
      now - uiCache.createdAt < UI_CACHE_TTL &&
      hasGoodFunnel(uiCache.data)
    ){
      return res.status(200).json(
        withSafeShape(uiCache.data, "ui_cache")
      );
    }

    const cached = getLatestScan();

    let fresh = null;

    try{
      fresh = await buildScanPayload({
        side: "both",
        notify: false,
        store: false
      });
    }catch(e){
      console.error("PUBLIC-LATEST SCANNER BUILD ERROR:", e.message);
    }

    if(hasGoodFunnel(fresh)){

      const merged = mergeUiFreshWithCached(fresh, cached);

      uiCache = {
        createdAt: now,
        data: merged
      };

      return res.status(200).json(
        withSafeShape(merged, cached?.ok ? "silent_scan_merged" : "silent_scan")
      );
    }

    if(hasGoodFunnel(cached)){
      return res.status(200).json(
        withSafeShape(cached, "cache_fallback")
      );
    }

    const emergency = await buildEmergencyUiPayload();

    uiCache = {
      createdAt: now,
      data: emergency
    };

    return res.status(200).json(
      withSafeShape(emergency, "emergency_ui_scan")
    );

  }catch(err){

    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "public_latest_failed",
      funnel: emptyFunnel(),
      funnelCount: 0,
      bullCount: 0,
      bearCount: 0,
      trades: [],
      btc: { state: "UNKNOWN", chg24: 0 },
      regime: "UNKNOWN",
      servedAt: Date.now()
    });
  }
}