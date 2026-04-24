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
    majorAbove: null,
    majorBelow: null,
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
    .slice(0, 12);
}


function pickNearestCluster(clusters, price, side){

  const list = Array.isArray(clusters)
    ? clusters
    : [];

  if(side === "above"){
    const above = list
      .map(c => Number(c.price || 0))
      .filter(p => p > price)
      .sort((a, b) => a - b);

    return above[0] || null;
  }

  const below = list
    .map(c => Number(c.price || 0))
    .filter(p => p < price)
    .sort((a, b) => b - a);

  return below[0] || null;
}


function pickMajorCluster(clusters, price, side){

  const list = Array.isArray(clusters)
    ? clusters
    : [];

  const filtered = list.filter(c => {
    const p = Number(c?.price || 0);

    if(side === "above"){
      return p > price;
    }

    return p < price;
  });

  if(!filtered.length){
    return null;
  }

  const maxUsd = Math.max(
    ...filtered.map(c => Number(c?.usd || 0)),
    0
  );

  const minMajorUsd = Math.max(maxUsd * 0.35, 25000);

  const majorCandidates = filtered
    .filter(c => {
      const usd = Number(c?.usd || 0);
      const count = Number(c?.count || 0);

      return usd >= minMajorUsd || count >= 2;
    })
    .sort((a, b) => {
      if(side === "above"){
        return Number(a.price || 0) - Number(b.price || 0);
      }

      return Number(b.price || 0) - Number(a.price || 0);
    });

  if(majorCandidates.length){
    return Number(majorCandidates[0]?.price || 0) || null;
  }

  const densest = [...filtered]
    .sort((a, b) => Number(b.usd || 0) - Number(a.usd || 0))[0];

  return Number(densest?.price || 0) || null;
}


// ================= ZONES =================
function buildZones(clusters, price){

  const longZones = [];
  const shortZones = [];

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
  }

  const nearestAbove = pickNearestCluster(clusters, price, "above");
  const nearestBelow = pickNearestCluster(clusters, price, "below");

  const majorAbove = pickMajorCluster(clusters, price, "above");
  const majorBelow = pickMajorCluster(clusters, price, "below");

  return {
    clusters,
    longZones,
    shortZones,
    nearestAbove,
    nearestBelow,
    majorAbove,
    majorBelow,
    top: clusters[0] || null
  };
}