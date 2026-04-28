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

// ================= SMART SELECTOR (BUCKETS) =================
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
      score: Number(coin.moveScore || 0)
    });
  }

  // ================= BUCKETS =================
  const trend = [];
  const pullback = [];
  const volatility = [];

  for(const c of clean){
    // 🔥 TREND = entry stage + hoge score
    if(c.stage === "entry" && c.score >= 70){
      trend.push(c);
      continue;
    }

    // 🎯 PULLBACK = almost stage + goede score
    if(c.stage === "almost" && c.score >= 55){
      pullback.push(c);
      continue;
    }

    // ⚡ VOLATILITY = volume/mcap spike of snelle move
    if(c.vm > 0.12 || Math.abs(c.change1h) > 1.2){
      volatility.push(c);
      continue;
    }
  }

  const sortByScore = arr =>
    arr.sort((a, b) => Number(b.score) - Number(a.score));

  sortByScore(trend);
  sortByScore(pullback);
  sortByScore(volatility);

  // ================= LIMIET PER BUCKET (max 4 per soort) =================
  const selected = [
    ...trend.slice(0, 4),
    ...pullback.slice(0, 4),
    ...volatility.slice(0, 4)
  ];

  // ================= FALLBACK (als er te weinig geselecteerd zijn) =================
  if(selected.length < 8){
    const fallback = clean
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    // dedupe fallback
    const fallbackMap = new Map();
    for(const coin of fallback){
      const key = `${coin.symbol}_${coin.side}`;
      if(!fallbackMap.has(key)) fallbackMap.set(key, coin);
    }
    return Array.from(fallbackMap.values()).slice(0, 12);
  }

  // ================= DEDUPE (voorkom dubbele symbol_side) =================
  const map = new Map();
  for(const coin of selected){
    const key = `${coin.symbol}_${coin.side}`;
    if(!map.has(key)){
      map.set(key, coin);
    }
  }

  // max 12 coins terug (tradeSystem bepaalt uiteindelijk max 8)
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

  const trades = candidates.length
    ? await processTrades(
        candidates,
        latest?.btc || null,
        "auto",
        latest?.regime || null,
        {
          notify,
          log: true
        }
      )
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