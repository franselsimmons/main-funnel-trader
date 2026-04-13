import { getPerformance } from "./performanceLogger";

export async function analyze() {
  const trades = await getPerformance();
  if (!trades.length) return { message:"No trades yet." };

  const wins = trades.filter(t=>t.pnl>0);
  const winrate = (wins.length/trades.length)*100;
  const avg = trades.reduce((a,b)=>a+b.pnl,0)/trades.length;

  const suggestions=[];
  if (winrate<55) suggestions.push("Increase confMin.");
  if (avg<1) suggestions.push("Lower spreadMax.");
  if (winrate<50) suggestions.push("Increase depthMin.");

  return {
    trades: trades.length,
    winrate: winrate.toFixed(2),
    avgPnL: avg.toFixed(2),
    suggestions
  };
}