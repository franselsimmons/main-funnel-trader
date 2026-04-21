export function getLiquidityZones(c, ob){

  const price = c.price;
  const spread = ob?.spreadPct || 0.001;
  const depth = ob?.depthMinUsd1p || 200000;

  const range = price * 0.02;

  const resistance = price + range;
  const support = price - range;

  const resistanceSweep = resistance * (1 + spread);
  const supportSweep = support * (1 - spread);

  let multiplier = depth < 150000 ? 1.3 : 1;

  return {
    resistance: resistance * multiplier,
    support: support * multiplier,
    resistanceSweep,
    supportSweep
  };
}