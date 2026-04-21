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


// ================= LIQUIDITY ENGINE =================
export function getLiquidityZones(c, ob = {}){

  const price = Number(c.price || 0);

  if(!price){
    return {
      support: 0,
      resistance: 0,
      supportSweep: 0,
      resistanceSweep: 0,
      mid: 0,
      rangePct: 0,
      sweepBuffer: 0
    };
  }

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 200000);
  const strength = Number(c.moveScore || 0);
  const ch24 = Math.abs(Number(c.change24 || 5)) / 100;

  // Dynamische range, niet vast.
  let rangePct = Math.max(0.012, Math.min(0.045, ch24 * 0.45));

  if(strength > 85){
    rangePct *= 1.12;
  }

  if(depth < 150000){
    rangePct *= 1.25;
  }

  if(depth > 400000){
    rangePct *= 0.85;
  }

  const sweepBuffer = Math.max(spread * 2, 0.001);

  const support = price * (1 - rangePct);
  const resistance = price * (1 + rangePct);

  const supportSweep = support * (1 - sweepBuffer);
  const resistanceSweep = resistance * (1 + sweepBuffer);

  return {
    support,
    resistance,
    supportSweep,
    resistanceSweep,
    mid: price,
    rangePct,
    sweepBuffer
  };
}