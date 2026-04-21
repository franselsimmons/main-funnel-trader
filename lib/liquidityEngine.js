// ================= LIQUIDITY ENGINE =================

export function getLiquidityZones(c, ob){

  const price = c.price;

  const spread = ob?.spreadPct || 0.001;
  const depth = ob?.depthMinUsd1p || 200000;

  // ================= BASE RANGE =================

  const range = price * 0.02; // 2% zone

  const resistance = price + range;
  const support = price - range;

  // ================= SWEEP ZONES =================

  const resistanceSweep = resistance * (1 + spread);
  const supportSweep = support * (1 - spread);

  // ================= DEPTH ADJUST =================

  let multiplier = 1;

  if(depth < 150000){
    multiplier = 1.3; // low liquidity → grotere moves
  }

  return {
    resistance: resistance * multiplier,
    support: support * multiplier,
    resistanceSweep,
    supportSweep
  };
}