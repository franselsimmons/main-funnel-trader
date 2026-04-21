// ================= REAL LIQUIDATIONS =================

export async function getLiquidationZones(symbol, price){

  try{
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&limit=50`
    );

    if(!res.ok) return empty(price);

    const data = await res.json();

    if(!Array.isArray(data)) return empty(price);

    const liqs = data.map(l => ({
      price: Number(l.ap),
      qty: Number(l.q),
      side: l.S // BUY = short liq, SELL = long liq
    }))
    .filter(l => l.price > 0 && l.qty > 0);

    if(liqs.length === 0) return empty(price);

    const clusters = buildClusters(liqs);

    return buildZones(clusters, price);

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
    nearestBelow: null
  };
}


// ================= CLUSTERS =================

function buildClusters(liqs){

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
    .slice(0,6);
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

function buildZones(clusters, price){

  const longZones = [];
  const shortZones = [];

  let nearestAbove = null;
  let nearestBelow = null;

  for(const cl of clusters){

    const total = cl.longs + cl.shorts;
    if(total === 0) continue;

    const longRatio = cl.longs / total;
    const shortRatio = cl.shorts / total;

    // LONG liquidaties (bear fuel)
    if(longRatio > 0.6){
      longZones.push(cl.price);
    }

    // SHORT liquidaties (bull fuel)
    if(shortRatio > 0.6){
      shortZones.push(cl.price);
    }

    // dichtstbijzijnde boven
    if(cl.price > price){
      if(!nearestAbove || cl.price < nearestAbove){
        nearestAbove = cl.price;
      }
    }

    // dichtstbijzijnde onder
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
    nearestBelow
  };
}