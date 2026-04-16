export function multiTFScore(c){

  let score = 0;

  if(c.change1h > 1) score += 2;
  else if(c.change1h > 0.5) score += 1;

  if(c.change24 > 5) score += 3;
  else if(c.change24 > 3) score += 2;

  if(c.change1h < -1) score -= 2;
  if(c.change24 < -5) score -= 3;

  return score;
}