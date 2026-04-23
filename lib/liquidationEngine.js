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
export async function getLiquidationZones(symbol, price){

  try{
    const clean = normalizeSymbol(symbol);

    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${clean}&limit=50`
    );

    if(!res.ok) return empty(price);

    const data = await res.json();
    if(!Array.isArray(data)) return empty(price);

    const liqs = data.map(l => ({
      price: Number(l?.ap || 0),
      qty: Number(l?.q || 0),
      usd: Number(l?.ap || 0) * Number(l?.q || 0),
      side: String(l?.S || "")
    }))
    .filter(l => l.price > 0 && l.qty > 0 && l.usd > 0);

    if(liqs.length === 0) return empty(price);

    const clusters = buildClusters(liqs);
    return buildZones(clusters, Number(price || 0));

  }catch{
    return empty(price);
  }
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


// ================= STEP =================
function getStep(price){

  if(price > 50000) return 100;
  if(price > 10000) return 50;
  if(price > 1000) return 10;
  if(price > 100) return 1;
  if(price > 10) return 0.1;
  if(price > 1) return 0.01;

  return 0.001;
}


// ================= CLUSTER ENGINE =================
function buildClusters(liqs){

  const clusters = {};

  for(const l of liqs){

    const step = getStep(l.price);
    const key = Math.round(l.price / step) * step;

    if(!clusters[key]){
      clusters[key] = {
        price: key,
        volume: 0,
        usd: 0,
        longs: 0,
        shorts: 0,
        count: 0
      };
    }

    clusters[key].volume += l.qty;
    clusters[key].usd += l.usd;
    clusters[key].count++;

    if(l.side === "SELL"){
      clusters[key].longs += l.usd;
    }else{
      clusters[key].shorts += l.usd;
    }
  }

  return Object.values(clusters)
    .sort((a, b) => Number(b.usd || 0) - Number(a.usd || 0))
    .slice(0, 8);
}


// ================= ZONES =================
function buildZones(clusters, price){

  const longZones = [];
  const shortZones = [];

  let nearestAbove = null;
  let nearestBelow = null;

  for(const cl of clusters){

    const total = Number(cl.longs || 0) + Number(cl.shorts || 0);
    if(total <= 0) continue;

    const longRatio = Number(cl.longs || 0) / total;
    const shortRatio = Number(cl.shorts || 0) / total;

    if(longRatio > 0.6){
      longZones.push(cl.price);
    }

    if(shortRatio > 0.6){
      shortZones.push(cl.price);
    }

    if(cl.price > price){
      if(!nearestAbove || cl.price < nearestAbove){
        nearestAbove = cl.price;
      }
    }

    if(cl.price < price){
      if(!nearestBelow || cl.price > nearestBelow){
        nearestBelow = cl.price;
      }
    }
  }

  return {
    clusters,
    longZones,
    shortZones,
    nearestAbove,
    nearestBelow,
    top: clusters[0] || null
  };
}