import { getStats } from "../lib/learning.js";

export default function handler(req,res){

  const stats = getStats();

  res.json({
    totalTrades: stats.total,
    winrate: stats.winrate.toFixed(2)
  });
}