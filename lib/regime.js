export function detectRegime(coins){

  const avg =
    coins.reduce((a,c)=>a+Math.abs(c.price_change_percentage_24h||0),0)
    / coins.length;

  if(avg < 3) return "LOW_VOL";
  if(avg < 6) return "MID_VOL";
  return "HIGH_VOL";
}