const FUNDING_CACHE = new Map();
const FUNDING_CACHE_MS = 60 * 1000;

function normalizeSymbol(symbol){
  const clean = String(symbol || "")
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  return clean.endsWith("USDT")
    ? clean
    : `${clean}USDT`;
}


// ================= FUNDING DATA =================
export async function fetchFunding(symbol){
  try{
    const clean = normalizeSymbol(symbol);
    const now = Date.now();

    const cached = FUNDING_CACHE.get(clean);
    if(cached && now - cached.ts < FUNDING_CACHE_MS){
      return cached.data;
    }

    const res = await fetch(
      `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${encodeURIComponent(clean)}&productType=usdt-futures`,
      {
        headers: {
          "Accept": "application/json"
        }
      }
    );

    const json = await res.json().catch(() => null);

    if(!res.ok || !json || (json.code !== undefined && json.code !== "00000")){
      return { rate: 0 };
    }

    const rawRate =
      json?.data?.fundingRate ??
      json?.data?.currentFundRate ??
      json?.data?.fundRate ??
      0;

    const data = {
      rate: Number(rawRate || 0)
    };

    FUNDING_CACHE.set(clean, {
      ts: now,
      data
    });

    return data;

  }catch{
    return { rate: 0 };
  }
}