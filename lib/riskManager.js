import { getLiquidityZones } from "./liquidityEngine.js";

function normalizeSpread(spreadPct){

  let s = Number(spreadPct || 0);

  if(!Number.isFinite(s) || s < 0){
    return 0.001;
  }

  // 0.07 wordt gezien als 0.07% en dus 0.0007.
  if(s > 0.05){
    s = s / 100;
  }

  return s;
}


function isValidPrice(n){
  return Number.isFinite(Number(n)) && Number(n) > 0;
}


function nearestClusterAbove(liquidation, price){

  if(liquidation?.nearestAbove && liquidation.nearestAbove > price){
    return Number(liquidation.nearestAbove);
  }

  const clusters = liquidation?.clusters || [];

  const above = clusters
    .map(c => Number(c.price || 0))
    .filter(p => p > price)
    .sort((a,b) => a - b);

  return above[0] || null;
}


function nearestClusterBelow(liquidation, price){

  if(liquidation?.nearestBelow && liquidation.nearestBelow < price){
    return Number(liquidation.nearestBelow);
  }

  const clusters = liquidation?.clusters || [];

  const below = clusters
    .map(c => Number(c.price || 0))
    .filter(p => p < price)
    .sort((a,b) => b - a);

  return below[0] || null;
}


export function calculateRisk(c, ob = {}, liquidity = null, liquidation = null){

  const price = Number(c.price || 0);
  const side = c.side;
  const isBull = side === "bull";

  if(!price || !side){
    return {
      entry: price || 0,
      sl: price || 0,
      tp: price || 0,
      rr: 0,
      slSource: "invalid",
      tpSource: "invalid"
    };
  }

  const liq = liquidity || getLiquidityZones(c, ob);

  const spread = normalizeSpread(ob?.spreadPct);
  const buffer = Math.max(spread * 1.5, 0.001);

  const ch24 = Math.abs(Number(c.change24 || 5)) / 100;

  const minDist = price * Math.max(buffer, 0.004);
  const maxDistPct = Math.min(
    Math.max(ch24 * 0.65, 0.018),
    0.07
  );

  const maxDist = price * maxDistPct;

  let sl;
  let tp;
  let slSource = "liquidity/orderbook";
  let tpSource = "liquidity/liquidation";

  const above = nearestClusterAbove(liquidation, price);
  const below = nearestClusterBelow(liquidation, price);

  // ================= SL =================
  if(isBull){

    sl = isValidPrice(liq?.supportSweep)
      ? Number(liq.supportSweep)
      : price - price * 0.015;

    slSource = "liquidity support sweep";

    if(below && below < price){
      const liqSL = below * (1 - buffer);

      if(liqSL < price){
        sl = Math.max(sl, liqSL);
        slSource = "liquidation cluster below";
      }
    }

  }else{

    sl = isValidPrice(liq?.resistanceSweep)
      ? Number(liq.resistanceSweep)
      : price + price * 0.015;

    slSource = "liquidity resistance sweep";

    if(above && above > price){
      const liqSL = above * (1 + buffer);

      if(liqSL > price){
        sl = Math.min(sl, liqSL);
        slSource = "liquidation cluster above";
      }
    }
  }

  // ================= TP =================
  if(isBull){

    tp = isValidPrice(liq?.resistance)
      ? Number(liq.resistance)
      : price + price * 0.025;

    tpSource = "liquidity resistance";

    if(above && above > price){
      const liqTP = above * (1 - buffer);

      if(liqTP > price){
        tp = liqTP;
        tpSource = "short liquidation target";
      }
    }

    if(c.moveScore > 85 && isValidPrice(liq?.resistance)){
      tp = Math.max(tp, Number(liq.resistance));
      tpSource = `${tpSource} + momentum extension`;
    }

  }else{

    tp = isValidPrice(liq?.support)
      ? Number(liq.support)
      : price - price * 0.025;

    tpSource = "liquidity support";

    if(below && below < price){
      const liqTP = below * (1 + buffer);

      if(liqTP < price){
        tp = liqTP;
        tpSource = "long liquidation target";
      }
    }

    if(c.moveScore > 85 && isValidPrice(liq?.support)){
      tp = Math.min(tp, Number(liq.support));
      tpSource = `${tpSource} + momentum extension`;
    }
  }

  // ================= VALIDATION =================
  if(isBull){

    if(!isValidPrice(sl) || sl >= price){
      sl = price - minDist;
      slSource = "fallback min distance";
    }

    if(!isValidPrice(tp) || tp <= price){
      tp = price + minDist * 1.5;
      tpSource = "fallback target";
    }

    if(price - sl < minDist){
      sl = price - minDist;
      slSource = `${slSource} + min distance`;
    }

    if(price - sl > maxDist){
      sl = price - maxDist;
      slSource = `${slSource} + max risk cap`;
    }

    if(tp - price < minDist){
      tp = price + minDist * 1.5;
      tpSource = `${tpSource} + min reward`;
    }

  }else{

    if(!isValidPrice(sl) || sl <= price){
      sl = price + minDist;
      slSource = "fallback min distance";
    }

    if(!isValidPrice(tp) || tp >= price){
      tp = price - minDist * 1.5;
      tpSource = "fallback target";
    }

    if(sl - price < minDist){
      sl = price + minDist;
      slSource = `${slSource} + min distance`;
    }

    if(sl - price > maxDist){
      sl = price + maxDist;
      slSource = `${slSource} + max risk cap`;
    }

    if(price - tp < minDist){
      tp = price - minDist * 1.5;
      tpSource = `${tpSource} + min reward`;
    }
  }

  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);
  const rr = reward / (risk || 1);

  return {
    entry: price,
    sl,
    tp,
    rr: Math.max(0, rr),
    slSource,
    tpSource
  };
}