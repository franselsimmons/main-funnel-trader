export function getLiquidityZones(c){

  const price = c.price;

  // simpele zone berekening (kan later uitgebreid)
  const range = Math.abs(c.change24 || 5) / 100;

  const support = price * (1 - range);
  const resistance = price * (1 + range);

  return {
    support,
    resistance,
    mid: price
  };
}