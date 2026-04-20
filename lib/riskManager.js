import { getLiquidityZones } from "./liquidityEngine.js";

export function calculateRisk(c, ob){

  const price = c.price;
  const side = c.side;

  const liq = getLiquidityZones(c, ob);

  const spread = ob?.spreadPct || 0.05;
  const depth = ob?.depthMinUsd1p || 100000;

  // ================= SL =================
  let sl;

  if(side === "bull"){
    // 🔥 SL onder liquidity sweep (niet random!)
    sl = liq.supportSweep;
  } else {
    sl = liq.resistanceSweep;
  }

  // ================= TP =================
  let tp;

  if(side === "bull"){
    tp = liq.resistance;
  } else {
    tp = liq.support;
  }

  // ================= EXTRA LOGIC =================

  // sterke coin → TP uitbreiden
  if(c.moveScore > 85){
    if(side === "bull"){
      tp *= 1.1;
    } else {
      tp *= 0.9;
    }
  }

  // lage liquidity → grotere spikes → grotere TP
  if(depth < 150000){
    if(side === "bull"){
      tp *= 1.1;
    } else {
      tp *= 0.9;
    }
  }

  // ================= MIN SL SAFETY =================
  const minSL = price * 0.01;

  if(Math.abs(price - sl) < minSL){
    sl = side === "bull"
      ? price - minSL
      : price + minSL;
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