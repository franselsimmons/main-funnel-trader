import { multiTFScore } from "./timeframe.js";

export function bearFilter(c){

  const tf = multiTFScore(c);

  if(tf > -3) return false;
  if(c.change24 > -4) return false;
  if(c.change1h > -0.3) return false;
  if(c.vm < 0.3) return false;
  if(c.volume < 1500000) return false;
  if(c.marketCap < 20000000) return false;

  return true;
}