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


// ================= ADAPTIVE CLUSTER ENGINE =================

export function buildLiquidationClusters(liqs){

  const clusters = {};

  // 🔥 adaptive grouping (werkt voor BTC + alts)
  for(const l of liqs){

    const step = getClusterStep(l.price);
    const key = Math.round(l.price / step) * step;

    if(!clusters[key]){
      clusters[key] = {
        price: key,
        volume: 0,
        longs: 0,
        shorts: 0,
        count: 0
      };
    }

    clusters[key].volume += l.qty;
    clusters[key].count++;

    if(l.side === "SELL"){
      clusters[key].longs += l.qty;
    }else{
      clusters[key].shorts += l.qty;
    }
  }

  return Object.values(clusters)
    .sort((a,b)=>b.volume - a.volume)
    .slice(0,7); // iets meer context
}


// ================= STEP SIZE =================

function getClusterStep(price){

  if(price > 50000) return 100;     // BTC
  if(price > 10000) return 50;
  if(price > 1000) return 10;
  if(price > 100) return 1;
  if(price > 10) return 0.1;
  if(price > 1) return 0.01;

  return 0.001; // micro caps
}


// ================= ZONES =================

function buildZonesFromClusters(clusters){

  const longZones = [];   // downside liquidity
  const shortZones = [];  // upside liquidity

  for(const cl of clusters){

    // 🔥 dominance filter
    const total = cl.longs + cl.shorts;
    if(total === 0) continue;

    const longRatio = cl.longs / total;
    const shortRatio = cl.shorts / total;

    // duidelijke bias nodig
    if(longRatio > 0.6){
      longZones.push(cl.price);
    }

    if(shortRatio > 0.6){
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

    // 🔥 dichterbij = belangrijker
    if(dist < 0.015){

      const total = cl.longs + cl.shorts;
      if(total === 0) continue;

      const longRatio = cl.longs / total;
      const shortRatio = cl.shorts / total;

      // ================= BULL =================
      if(c.side === "bull"){

        // short squeeze fuel boven prijs
        if(cl.price > c.price && shortRatio > 0.55){
          score += 15;
        }

        // downside protection (liquidity onder)
        if(cl.price < c.price && longRatio > 0.55){
          score += 5;
        }
      }

      // ================= BEAR =================
      if(c.side === "bear"){

        // long squeeze fuel onder prijs
        if(cl.price < c.price && longRatio > 0.55){
          score += 15;
        }

        // upside resistance
        if(cl.price > c.price && shortRatio > 0.55){
          score += 5;
        }
      }
    }
  }

  return Math.max(0, Math.min(score, 30));
}