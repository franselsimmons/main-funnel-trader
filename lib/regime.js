export function detectVolatility(coins){

  if(!coins?.length) return "LOW";

  const avg = coins.reduce((a,c)=>a+Math.abs(c.change24||0),0)/coins.length;

  if(avg > 9) return "EXTREME";
  if(avg > 6) return "HIGH";
  if(avg > 3) return "NORMAL";
  return "LOW";
}