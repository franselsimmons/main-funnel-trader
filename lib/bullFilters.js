import { multiTFScore } from "./timeframe.js";

export function bullFilter(c){

  const tf = multiTFScore(c);

  // 🔥 ENTRY (strenger)
  if(tf >= 2 && c.change24 > 4 && c.vm > 0.2){
    return "entry";
  }

  // 🔥 ALMOST
  if(tf >= 1 && c.change24 > 2 && c.vm > 0.15){
    return "almost";
  }

  // 🔥 BUILDUP
  if(tf >= 0 && c.change24 > 1 && c.vm > 0.1){
    return "buildup";
  }

  // 🔥 RADAR (strenger dan eerst)
  if(c.vm > 0.05){
    return "radar";
  }

  return false;
}