export function calculateRisk(c, ob){

  const price = c.price;
  const side = c.side;

  // ================= BASIS =================
  const vol = Math.abs(c.change24 || 5) / 100;
  const strength = c.moveScore || 0;

  // ================= ORDERBOOK =================
  const spread = ob?.spreadPct || 0.05;
  const depth = ob?.depthMinUsd1p || 100000;

  // ================= VOL FACTOR =================
  const volFactor = Math.max(0.8, Math.min(2, vol * 10));

  // ================= SL =================
  let slDistance = vol * 0.5 * volFactor;

  // sterke coins → strakkere SL
  if(strength > 85) slDistance *= 0.75;

  // diepe liquidity → stabiel → strakker
  if(depth > 300000) slDistance *= 0.8;

  // spread / fake moves buffer
  const liqBuffer = spread * 1.5;

  let sl;

  if(side === "bull"){
    sl = price * (1 - (slDistance + liqBuffer));
  } else {
    sl = price * (1 + (slDistance + liqBuffer));
  }

  // ================= TP =================
  let tpDistance = slDistance * 1.6;

  // sterke momentum → iets meer ruimte
  if(strength > 85) tpDistance *= 1.2;

  // hoge volatility → grotere move mogelijk
  if(vol > 0.08) tpDistance *= 1.2;

  let tp;

  if(side === "bull"){
    tp = price * (1 + tpDistance);
  } else {
    tp = price * (1 - tpDistance);
  }

  // ================= RR =================
  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);
  const rr = reward / (risk || 1);

  return {
    entry: price,
    sl,
    tp,
    rr
  };
}