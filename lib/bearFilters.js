import { multiTFScore } from "./timeframe.js";

export function bearFilter(c){

  const tf = multiTFScore(c);

  if(tf > -3) return false;

  if(c.price_change_percentage_24h > -4) return false;

  if(c.total_volume < 1_000_000) return false;

  if(c.market_cap < 50_000_000) return false;

  return true;
}