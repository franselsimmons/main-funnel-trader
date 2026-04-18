import { multiTFScore } from "./timeframe.js";

export function bullFilter(c){

  const tf = multiTFScore(c);

  // ================= RADAR =================
  if(
    tf >= -1 &&
    c.vm > 0.03
  ){
    return "RADAR";
  }

  // ================= BUILDUP =================
  if(
    tf >= 0 &&
    c.change24 > 0.5 &&
    c.vm > 0.05
  ){
    return "BUILDUP";
  }

  // ================= ALMOST =================
  if(
    tf >= 1 &&
    c.change24 > 1.5 &&
    c.vm > 0.1
  ){
    return "ALMOST";
  }

  // ================= ENTRY =================
  if(
    tf >= 2 &&
    c.change24 > 3 &&
    c.vm > 0.15
  ){
    return "ENTRY";
  }

  return false;
}