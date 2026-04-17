export function classifyMarket(coins){

  let trending = 0;
  let choppy = 0;

  for(const c of coins){

    if(Math.abs(c.change24) > 6 && Math.abs(c.change1h) > 1){
      trending++;
    } else if(Math.abs(c.change1h) < 0.3){
      choppy++;
    }
  }

  const total = coins.length || 1;

  const trendPerc = (trending / total) * 100;
  const chopPerc = (choppy / total) * 100;

  if(trendPerc > 25) return "TRENDING";
  if(chopPerc > 40) return "CHOPPY";

  return "BALANCED";
}