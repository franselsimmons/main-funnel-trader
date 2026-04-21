import { getLiquidityZones } from "./liquidity.js";

export function calculateRisk(c, ob){

  const price = Number(c.price || 0);
  const side = c.side;

  if(!price || !side){
    return {
      entry: price,
      sl: price,
      tp: price,
      rr: 0
    };
  }

  // ================= LIQUIDITY =================
  let liq;

  try{
    liq = getLiquidityZones(c, ob);
  }catch{
    liq = null;
  }

  const spread = ob?.spreadPct || 0.001;
  const depth = ob?.depthMinUsd1p || 100000;

  // ================= FALLBACK =================
  if(!liq){
    const fallbackRange = 0.02;

    const sl = side === "bull"
      ? price * (1 - fallbackRange)
      : price * (1 + fallbackRange);

    const tp = side === "bull"
      ? price * (1 + fallbackRange * 2)
      : price * (1 - fallbackRange * 2);

    return {
      entry: price,
      sl,
      tp,
      rr: 2
    };
  }

  // ================= SL =================
  let sl;

  if(side === "bull"){
    sl = liq.supportSweep;
  }else{
    sl = liq.resistanceSweep;
  }

  // ================= TP =================
  let tp;

  if(side === "bull"){
    tp = liq.resistance;
  }else{
    tp = liq.support;
  }

  // ================= BOOST LOGIC =================

  // sterke coins → grotere moves
  if(c.moveScore > 85){
    tp = side === "bull"
      ? tp * 1.1
      : tp * 0.9;
  }

  // lage liquidity → grotere spikes
  if(depth < 150000){
    tp = side === "bull"
      ? tp * 1.1
      : tp * 0.9;
  }

  // ================= SPREAD BUFFER =================
  const buffer = price * spread * 1.5;

  if(side === "bull"){
    sl -= buffer;
  }else{
    sl += buffer;
  }

  // ================= MIN SL DISTANCE =================
  const minSL = price * 0.01;

  if(Math.abs(price - sl) < minSL){
    sl = side === "bull"
      ? price - minSL
      : price + minSL;
  }

  // ================= VALIDATION =================
  if(!isFinite(sl) || sl <= 0){
    sl = side === "bull"
      ? price * 0.99
      : price * 1.01;
  }

  if(!isFinite(tp) || tp <= 0){
    tp = side === "bull"
      ? price * 1.02
      : price * 0.98;
  }

  // ================= RR =================
  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);

  const rr = reward / (risk || 1);

  return {
    entry: price,
    sl,
    tp,
    rr: Math.max(0, rr)
  };
}