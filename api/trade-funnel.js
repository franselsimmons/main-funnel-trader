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
  if(value === undefined || value === null) return fallback;
  const v = String(value || "").toLowerCase();
  if(v === "false" || v === "0" || v === "no") return false;
  if(v === "true" || v === "1" || v === "yes") return true;
  return fallback;
}

// ================= ADAPTIVE SMART SELECTOR (met debug + catch‑all) =================
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

  // ================= DEBUG LOGGING =================
  console.log("FUNNEL DEBUG raw length:", raw.length);
  console.log("FUNNEL DEBUG clean length:", clean.length);
  if(clean.length > 0){
    console.log("Eerste clean coin:", {
      symbol: clean[0].symbol,
      stage: clean[0].stage,
      score: clean[0].score,
      vm: clean[0].vm,
      ch1: clean[0].ch1
    });
  }

  // ================= CATCH‑ALL FALLBACK (forceer output) =================
  // 1. Zonder uiOnly – stuur nu 40 coins i.p.v. 12
  const withoutUiOnly = clean.filter(c => !c.uiOnly);
  if(withoutUiOnly.length >= 3) {
    console.log("🔧 USING NON-UI-ONLY candidates:", withoutUiOnly.length);
    return withoutUiOnly.slice(0, 40);   // 🔥 VERHOOGD naar 40
  }
  // 2. Gewoon eerste 40 (ook uiOnly)
  if(clean.length > 0) {
    console.log("🔧 FALLBACK: taking first 40 clean coins");
    return clean.slice(0, 40);            // 🔥 VERHOOGD naar 40
  }

  return [];
}

// ================= CORE =================
export async function runTradeFunnel(options = {}){
  const notify = options.notify !== false;
  const store = options.store !== false;
  const latest = await getLatestScan();

  if(!latest?.ok){
    throw new Error("no_latest_scan_available");
  }

  const candidates = getTradeFunnelCandidates(latest);
  const now = Date.now();

  const result = candidates.length
    ? await processTrades(candidates, { notify, log: true })
    : { actions: [], candidatesCount: 0 };

  // Zet de actions om naar een array voor de frontend
  const trades = Array.isArray(result)
    ? result
    : Array.isArray(result?.actions)
      ? result.actions
      : [];

  const updated = {
    ...latest,
    ok: true,
    trades,
    tradeSystemResult: result,
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
    const data = await runTradeFunnel({ notify, store });
    return res.status(200).json(data);
  }catch(e){
    console.error("TRADE-FUNNEL ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}