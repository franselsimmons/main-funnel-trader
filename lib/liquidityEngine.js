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
      side: l.S // BUY = short liq, SELL = long liq
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


// ================= CLUSTER ENGINE =================

export function buildLiquidationClusters(liqs){

  const clusters = {};

  for(const l of liqs){

    const key = Math.round(l.price / 10) * 10;

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


// ================= ZONES =================

function buildZonesFromClusters(clusters){

  const longZones = [];   // longs get liquidated (downside fuel)
  const shortZones = [];  // shorts get liquidated (upside fuel)

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


// ================= SCORE =================

export function getLiquidationScore(c, liq){

  if(!liq || !liq.clusters?.length) return 0;

  let score = 0;

  for(const cl of liq.clusters){

    const dist = Math.abs(c.price - cl.price) / c.price;

    if(dist < 0.01){

      // bull → short liquidations boven
      if(c.side === "bull" && cl.shorts > cl.longs){
        score += 15;
      }

      // bear → long liquidations onder
      if(c.side === "bear" && cl.longs > cl.shorts){
        score += 15;
      }
    }
  }

  return Math.min(score, 30);
}