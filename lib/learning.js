import { getPerformance } from "./performance.js";

export function getAdaptiveSettings(){

  const perf = getPerformance();

  let rrMin = 1.5;
  let scoreMin = 60;

  if(perf.winrate < 50){
    rrMin = 2.0;
    scoreMin = 70;
  }

  if(perf.winrate > 65){
    rrMin = 1.3;
    scoreMin = 55;
  }

  return {
    rrMin,
    scoreMin,
    winrate: perf.winrate,
    totalTrades: perf.total
  };
}