export function getVolatility(c){

  const vol = Math.abs(c.change24 || 0);

  if(vol < 2) return "LOW";
  if(vol < 6) return "MEDIUM";
  return "HIGH";
}