// ================= FUNDING DATA =================

// Zet alleen op true als Binance funding endpoint bij jou echt werkt.
// Nu standaard uit om 451-spam te stoppen.
const BINANCE_FUNDING_ENABLED = false;

function normalizeSymbol(symbol){
  const clean = String(symbol || "")
    .toUpperCase()
    .trim()
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

export async function fetchFunding(symbol){
  if(!BINANCE_FUNDING_ENABLED){
    return { rate: 0 };
  }

  try{
    const clean = normalizeSymbol(symbol);

    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${clean}`
    );

    if(!res.ok){
      return { rate: 0 };
    }

    const data = await res.json();

    return {
      rate: Number(data?.lastFundingRate || 0)
    };

  }catch{
    return { rate: 0 };
  }
}