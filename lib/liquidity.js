// ================= LIQUIDITY ENGINE (UPGRADED) =================

export function getLiquidityZones(c, ob){

  const price = c.price;

  const vol = Math.abs(c.change24 || 5) / 100;
  const strength = c.moveScore || 0;

  const spread = ob?.spreadPct || 0.05;
  const depth = ob?.depthMinUsd1p || 100000;

  // ================= BASE RANGE =================
  let range = vol * 1.2;

  // sterke coins → grotere moves
  if(strength > 85) range *= 1.2;

  // lage liquidity → grotere spikes
  if(depth < 150000) range *= 1.3;

  // hoge liquidity → minder ruimte
  if(depth > 400000) range *= 0.8;

  // ================= LIQUIDITY SWEEP =================
  const sweep = spread * 2;

  const support = price * (1 - range);
  const resistance = price * (1 + range);

  // 🔥 zones waar stops liggen (belangrijk!)
  const supportSweep = support * (1 - sweep);
  const resistanceSweep = resistance * (1 + sweep);

  return {
    support,
    resistance,
    supportSweep,
    resistanceSweep,
    mid: price
  };
}