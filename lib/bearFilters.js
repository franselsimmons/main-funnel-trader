import { multiTFScore } from "./timeframe.js";

export function bearFilter(c){

  const tf = multiTFScore(c);

  if(tf > -3) return false;
  if(c.change24 > -4) return false;
  if(c.volume < 1_000_000) return false;
  if(c.marketCap < 50_000_000) return false;

  return true;
}