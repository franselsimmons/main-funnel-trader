// ================= REAL + SIMULATED LIQUIDATIONS =================

export async function fetchLiquidations(symbol){

  try{
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&limit=50`
    );

    const data = await res.json();

    if(!Array.isArray(data)) return [];

    return data.map(l => ({
      price: Number(l.ap),
      qty: Number(l.q),
      side: l.S // BUY = short liquidated, SELL = long liquidated
    }));

  }catch{
    return [];
  }
}


// ================= CLUSTER ENGINE =================

export function buildLiquidationClusters(liqs){

  const clusters = {};

  for(const l of liqs){

    const key = Math.round(l.price / 10) * 10; // group levels

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
      clusters[key].longs += l.qty; // longs liquidated
    }else{
      clusters[key].shorts += l.qty;
    }
  }

  return Object.values(clusters)
    .sort((a,b)=>b.volume - a.volume)
    .slice(0,5); // top clusters
}


// ================= SCORE =================

export function getLiquidationScore(c, clusters){

  if(!clusters.length) return 0;

  let score = 0;

  for(const cl of clusters){

    const dist = Math.abs(c.price - cl.price) / c.price;

    // dichtbij = belangrijk
    if(dist < 0.01){

      if(c.side === "bull" && cl.shorts > cl.longs){
        score += 15; // short squeeze fuel
      }

      if(c.side === "bear" && cl.longs > cl.shorts){
        score += 15; // long squeeze fuel
      }
    }
  }

  return Math.min(score, 30);
}