export function hasEdge(c){

  let score = 0;

  // momentum stacking
  if(c.price_change_percentage_1h > 1) score++;
  if(c.price_change_percentage_24h > 5) score++;

  // volume spike
  if(c.total_volume > 2_000_000) score++;

  // strong move
  if(Math.abs(c.price_change_percentage_24h) > 7) score++;

  return score >= 3;
}