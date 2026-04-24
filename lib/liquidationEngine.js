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


// ================= REAL LIQUIDATIONS =================
// Tijdelijk bewust uitgeschakeld:
// Binance publieke force-order route is niet bruikbaar zonder user/auth context.
// Hiermee voorkom je 451/foute data en blijft je trade funnel stabiel.
export async function getLiquidationZones(symbol, price){
  normalizeSymbol(symbol);
  return empty(price);
}


// ================= EMPTY =================
function empty(price){
  return {
    clusters: [],
    longZones: [],
    shortZones: [],
    nearestAbove: null,
    nearestBelow: null,
    top: null
  };
}