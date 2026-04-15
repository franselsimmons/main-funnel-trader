export function multiTFScore(c){

  let score = 0;

  if(c.price_change_percentage_1h > 0) score += 1;
  if(c.price_change_percentage_24h > 0) score += 3;

  if(c.price_change_percentage_1h < 0) score -= 1;
  if(c.price_change_percentage_24h < 0) score -= 3;

  return score;
}