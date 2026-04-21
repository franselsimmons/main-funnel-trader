// ================= REAL LIQUIDATIONS =================

export async function fetchLiquidations(symbol){

  try{
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&limit=50`
    );

    if(!res.ok) return empty();

    const data = await res.json();

    if(!Array.isArray(data)) return empty();

    const liqs = data.map(l => ({
      price: Number(l.ap),
      qty: Number(l.q),
      side: l.S
    }))
    .filter(l => l.price > 0 && l.qty > 0);

    if(liqs.length === 0) return empty();

    const clusters = buildLiquidationClusters(liqs);

    return buildZonesFromClusters(clusters);

  }catch{
    return empty();
  }
}


// ================= EMPTY =================

function empty(){
  return {
    clusters: [],
    longZones: [],
    shortZones: [],
    top: null
  };
}


// ================= CLUSTERS =================

function buildLiquidationClusters(liqs){

  const clusters = {};

  for(const l of liqs){

    const step = getStep(l.price);
    const key = Math.round(l.price / step) * step;

    if(!clusters[key]){
      clusters[key] = {
        price:key,
        volume:0,
        longs:0,
        shorts:0
      };
    }

    clusters[key].volume += l.qty;

    if(l.side === "SELL"){
      clusters[key].longs += l.qty;
    }else{
      clusters[key].shorts += l.qty;
    }
  }

  return Object.values(clusters)
    .sort((a,b)=>b.volume - a.volume)
    .slice(0,5);
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


// ================= ZONES =================

function buildZonesFromClusters(clusters){

  const longZones = [];
  const shortZones = [];

  for(const cl of clusters){

    if(cl.longs > cl.shorts){
      longZones.push(cl.price);
    }

    if(cl.shorts > cl.longs){
      shortZones.push(cl.price);
    }
  }

  return {
    clusters,
    longZones,
    shortZones,
    top: clusters[0] || null
  };
}