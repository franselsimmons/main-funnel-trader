export function analyzeFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));
  const vm = Number(c.vm || 0);

  if(ch1 > 1.2 && ch24 > 6 && vm > 0.35){
    return { type:"TREND", strength:"HIGH" };
  }

  if(ch1 < 0.2 && ch24 > 8){
    return { type:"EXHAUSTION", strength:"HIGH" };
  }

  if(ch1 > 0.5){
    return { type:"BUILDING", strength:"MID" };
  }

  return { type:"NEUTRAL", strength:"LOW" };
}