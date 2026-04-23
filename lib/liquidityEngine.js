function normalizeSpread(spreadPct){

  let s = Number(spreadPct || 0);

  if(!Number.isFinite(s) || s < 0){
    return 0.001;
  }

  if(s > 0.05){
    s = s / 100;
  }

  return s;
}


function isValidPrice(value){
  return Number.isFinite(Number(value)) && Number(value) > 0;
}


function validBelow(price, value){
  return isValidPrice(value) && Number(value) < Number(price);
}


function validAbove(price, value){
  return isValidPrice(value) && Number(value) > Number(price);
}


// ================= LIQUIDITY ENGINE =================
export function getLiquidityZones(c, ob = {}){

  const price = Number(c?.price || 0);

  if(!price){
    return {
      support: 0,
      resistance: 0,
      supportSweep: 0,
      resistanceSweep: 0,
      mid: 0,
      rangePct: 0,
      sweepBuffer: 0,
      orderbookSupport: null,
      orderbookResistance: null,
      useWalls: false
    };
  }

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 200000);
  const strength = Number(c?.moveScore || 0);
  const ch24 = Math.abs(Number(c?.change24 || 5)) / 100;

  let rangePct = Math.max(0.012, Math.min(0.045, ch24 * 0.45));

  if(strength > 85){
    rangePct *= 1.10;
  }

  if(depth < 150000){
    rangePct *= 1.20;
  }

  if(depth > 400000){
    rangePct *= 0.85;
  }

  const sweepBuffer = Math.max(spread * 2.0, 0.0012);

  const fallbackSupport = price * (1 - rangePct);
  const fallbackResistance = price * (1 + rangePct);

  const orderbookSupport =
    validBelow(price, ob?.liveSupport)
      ? Number(ob.liveSupport)
      : validBelow(price, ob?.supportLevels?.[0]?.price)
        ? Number(ob.supportLevels[0].price)
        : null;

  const orderbookResistance =
    validAbove(price, ob?.liveResistance)
      ? Number(ob.liveResistance)
      : validAbove(price, ob?.resistanceLevels?.[0]?.price)
        ? Number(ob.resistanceLevels[0].price)
        : null;

  const support = orderbookSupport || fallbackSupport;
  const resistance = orderbookResistance || fallbackResistance;

  const supportSweep = support * (1 - sweepBuffer);
  const resistanceSweep = resistance * (1 + sweepBuffer);

  return {
    support,
    resistance,
    supportSweep,
    resistanceSweep,
    mid: price,
    rangePct,
    sweepBuffer,
    orderbookSupport,
    orderbookResistance,
    useWalls: Boolean(orderbookSupport || orderbookResistance)
  };
}