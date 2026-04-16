import { getHistory } from "./logger.js";

export function getPerformance(){

  const trades = getHistory();

  if(trades.length === 0){
    return {
      winrate: 0,
      avgRR: 0,
      total: 0
    };
  }

  let wins = 0;
  let totalRR = 0;

  for(const t of trades){

    if(t.result === "WIN") wins++;

    totalRR += Number(t.rr || 0);
  }

  return {
    winrate: (wins / trades.length) * 100,
    avgRR: totalRR / trades.length,
    total: trades.length
  };
}