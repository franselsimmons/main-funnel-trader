import { getLiquidityZones } from "./liquidityEngine.js";

export function calculateRisk(c, ob){

  const price = c.price;
  const side = c.side;

  const liq = getLiquidityZones(c, ob);

  let sl = side === "bull"
    ? liq.supportSweep
    : liq.resistanceSweep;

  let tp = side === "bull"
    ? liq.resistance
    : liq.support;

  const minSL = price * 0.01;

  if(Math.abs(price - sl) < minSL){
    sl = side === "bull"
      ? price - minSL
      : price + minSL;
  }

  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);
  const rr = reward / (risk || 1);

  return { entry: price, sl, tp, rr };
}