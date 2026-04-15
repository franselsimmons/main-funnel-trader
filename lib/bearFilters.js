import { multiTFScore } from "./timeframe.js";

export function bearFilter(c){

  const tf = multiTFScore(c);

  let score = 0;

  if(tf <= -3) score += 3;
  if(tf <= -2) score += 2;

  if(c.change24 <= -6) score += 3;
  else if(c.change24 <= -3) score += 2;

  if(c.vm > 0.5) score += 2;
  else if(c.vm > 0.3) score += 1;

  if(c.volume > 1_000_000) score += 1;

  if(score >= 6) return "ENTRY";
  if(score >= 4) return "ALMOST";
  if(score >= 2) return "BUILDUP";

  return "RADAR";
}