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

// ================= 🔥 FIXED TRADE INPUT =================
function getTradeFunnelCandidates(latest){

  const bullEntry = safeArray(latest?.funnel?.bull?.entry);
  const bearEntry = safeArray(latest?.funnel?.bear?.entry);

  const bullAlmost = safeArray(latest?.funnel?.bull?.almost);
  const bearAlmost = safeArray(latest?.funnel?.bear?.almost);

  // 🔥 combineer meerdere stages
  const raw = [
    ...bullEntry,
    ...bearEntry,
    ...bullAlmost,
    ...bearAlmost
  ];

  const map = new Map();

  for(const coin of raw){
    if(!coin) continue;
    if(Boolean(coin.uiOnly)) continue;

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = String(coin.side || "").toLowerCase().trim();

    if(!symbol) continue;
    if(side !== "bull" && side !== "bear") continue;

    const bitgetSymbol = String(
      coin.bitgetSymbol ||
      coin.rawBitgetSymbol ||
      `${symbol}USDT`
    ).toUpperCase();

    const productType = String(
      coin.productType || "USDT-FUTURES"
    ).toUpperCase();

    const key = `${symbol}_${side}`;

    // 🔥 priority systeem
    const priority =
      coin.stage === "entry" ? 3 :
      coin.stage === "almost" ? 2 :
      coin.stage === "buildup" ? 1 : 0;

    const prev = map.get(key);

    if(!prev || priority > prev.priority){
      map.set(key, {
        ...coin,
        symbol,
        side,
        stage: coin.stage,
        priority,
        bitgetSymbol,
        productType,
        rawBitgetSymbol: String(
          coin.rawBitgetSymbol || bitgetSymbol
        ).toUpperCase()
      });
    }
  }

  // 🔥 beste coins eerst + limit
  return Array.from(map.values())
    .sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0))
    .slice(0, 12); // 👈 MAX COINS NAAR TRADESYSTEM
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