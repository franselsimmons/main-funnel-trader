export function detectVolatility(coins){

  if(!coins?.length) return "LOW";

  const avgMove = coins.reduce((a,c)=>
    a + Math.abs(c.price_change_percentage_24h || 0),0
  ) / coins.length;

  if(avgMove > 9) return "EXTREME";
  if(avgMove > 6) return "HIGH";
  if(avgMove > 3) return "NORMAL";

  return "LOW";
}