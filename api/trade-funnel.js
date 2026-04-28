import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;


// ================= GENERIC HELPERS =================
function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeText(value, fallback = ""){
  if(value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeNotify(value){
  const v = String(value || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

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

// ================= ADAPTIVE SMART SELECTOR =================
function getTradeFunnelCandidates(latest){

  const bullEntry = safeArray(latest?.funnel?.bull?.entry);
  const bearEntry = safeArray(latest?.funnel?.bear?.entry);

  const bullAlmost = safeArray(latest?.funnel?.bull?.almost);
  const bearAlmost = safeArray(latest?.funnel?.bear?.almost);

  const bullBuildup = safeArray(latest?.funnel?.bull?.buildup);
  const bearBuildup = safeArray(latest?.funnel?.bear?.buildup);

  const raw = [
    ...bullEntry,
    ...bearEntry,
    ...bullAlmost,
    ...bearAlmost,
    ...bullBuildup,
    ...bearBuildup
  ];

  const clean = [];

  for(const coin of raw){
    if(!coin) continue;
    if(Boolean(coin.uiOnly)) continue;

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = String(coin.side || "").toLowerCase().trim();

    if(!symbol) continue;
    if(side !== "bull" && side !== "bear") continue;

    clean.push({
      ...coin,
      symbol,
      side,
      vm: Number(coin.vm || 0),
      score: Number(coin.moveScore || 0),
      ch1: Math.abs(Number(coin.change1h || 0))
    });
  }

  // ================= MARKT LEZEN =================
  const regime = String(latest?.regime || "NORMAL").toUpperCase();
  const btcState = String(latest?.btc?.state || "NEUTRAL").toUpperCase();

  let trendWeight = 4;
  let pullbackWeight = 4;
  let volWeight = 4;

  if(regime === "HIGH_VOL"){
    trendWeight = 2;
    pullbackWeight = 4;
    volWeight = 6;
  }
  else if(regime === "LOW_VOL"){
    trendWeight = 5;
    pullbackWeight = 5;
    volWeight = 2;
  }
  else if(btcState === "BULLISH" || btcState === "BEARISH"){
    trendWeight = 6;
    pullbackWeight = 3;
    volWeight = 3;
  }

  // ================= BUCKETS =================
  const trend = [];
  const pullback = [];
  const volatility = [];

  for(const c of clean){
    // 🔥 TREND: entry + hoge score
    if(c.stage === "entry" && c.score >= 65){
      trend.push(c);
      continue;
    }

    // 🎯 PULLBACK: almost + goede score
    if(c.stage === "almost" && c.score >= 50){
      pullback.push(c);
      continue;
    }

    // ⚡ VOLATILITY: hoge vm of snelle 1h move
    if(c.vm > 0.12 || c.ch1 > 1.2){
      volatility.push(c);
      continue;
    }
  }

  const sortByScore = arr =>
    arr.sort((a, b) => Number(b.score) - Number(a.score));

  sortByScore(trend);
  sortByScore(pullback);
  sortByScore(volatility);

  // ================= SELECTIE PER BUCKET =================
  const selected = [
    ...trend.slice(0, trendWeight),
    ...pullback.slice(0, pullbackWeight),
    ...volatility.slice(0, volWeight)
  ];

  // ================= FALLBACK (als te weinig) =================
  if(selected.length < 8){
    const fallback = clean
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    const fallbackMap = new Map();
    for(const coin of fallback){
      const key = `${coin.symbol}_${coin.side}`;
      if(!fallbackMap.has(key)) fallbackMap.set(key, coin);
    }
    return Array.from(fallbackMap.values()).slice(0, 12);
  }

  // ================= DEDUPE =================
  const map = new Map();
  for(const coin of selected){
    const key = `${coin.symbol}_${coin.side}`;
    if(!map.has(key)){
      map.set(key, coin);
    }
  }

  return Array.from(map.values()).slice(0, 12);
}


// ================= CORE =================
export async function runTradeFunnel(options = {}){
  const notify = options.notify !== false;
  const store = options.store !== false;
  const resetStats = options.resetStats === true;

  const latest = await getLatestScan();

  if(!latest?.ok){
    throw new Error("no_latest_scan_available");
  }

  const candidates = getTradeFunnelCandidates(latest);
  const now = Date.now();

  // 🔥 DIRECTE CANDIDATES (geen fake funnel meer)
  const trades = candidates.length
    ? await processTrades(candidates, {
        notify,
        log: true
      })
    : [];

  const updated = {
    ...latest,
    ok: true,

    trades,

    tradeFunnelInputCount: candidates.length,
    tradeFunnelInputSymbols: candidates.map(c => `${c.symbol}_${c.side}`),

    tradeFunnelUpdatedAt: now,
    updatedAt: now
  };

  if(store){
    await setLatestScan(updated);
  }

  return updated;
}


// ================= HANDLER =================
export default async function handler(req, res){
  try{
    const notify = normalizeNotify(req?.query?.notify);
    const store = normalizeStore(req?.query?.store, true);

    const data = await runTradeFunnel({
      notify,
      store
    });

    return res.status(200).json(data);

  }catch(e){
    console.error("TRADE-FUNNEL ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}