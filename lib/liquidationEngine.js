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

// ================= NIEUWE HELPER: MAJOR ZONE BEPALEN =================
function getMajorZone(clusters, price, direction){
  if (!Array.isArray(clusters) || clusters.length === 0) return null;

  const relevant = clusters
    .filter(cl => direction === "above"
      ? Number(cl.price || 0) > Number(price || 0)
      : Number(cl.price || 0) < Number(price || 0)
    )
    .sort((a, b) => {
      return direction === "above"
        ? Number(a.price || 0) - Number(b.price || 0)
        : Number(b.price || 0) - Number(a.price || 0);
    });

  if (!relevant.length) return null;

  const nearest = relevant[0];
  const nearestUsd = Number(nearest?.usd || 0);

  const major = relevant.find(cl => {
    const usd = Number(cl?.usd || 0);
    return usd >= Math.max(nearestUsd * 1.8, 50000);
  });

  return (major || nearest).price || null;
}

// ================= REAL LIQUIDATIONS =================
// Tijdelijk bewust uitgeschakeld:
// Binance publieke force-order route is niet bruikbaar zonder user/auth context.
// Hiermee voorkom je 451/foute data en blijft je trade funnel stabiel.
export async function getLiquidationZones(symbol, price){
  normalizeSymbol(symbol);
  return empty(price);
}

// ================= EMPTY (aangepast met major velden) =================
function empty(price){
  return {
    clusters: [],
    longZones: [],
    shortZones: [],
    nearestAbove: null,
    nearestBelow: null,
    majorAbove: null,   // nieuw
    majorBelow: null,   // nieuw
    top: null
  };
}