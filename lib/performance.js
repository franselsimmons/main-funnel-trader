import { readDB } from "./db.js";

export function getPerformance(){

  const trades = readDB();

  if(trades.length === 0){
    return {
      winrate: 0,
      avgRR: 0,
      total: 0
    };
  }

  let wins = 0;
  let rrTotal = 0;

  for(const t of trades){

    if(t.result === "WIN") wins++;

    rrTotal += Number(t.rr || 0);
  }

  return {
    winrate: (wins / trades.length) * 100,
    avgRR: rrTotal / trades.length,
    total: trades.length
  };
}