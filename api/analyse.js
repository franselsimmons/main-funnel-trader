import { getPortfolio } from "../lib/portfolio.js";
import { getStats } from "../lib/learning.js";

export default function handler(req,res){

  const stats = getStats();
  const pf = getPortfolio();

  let advice = [];

  if(pf.drawdown > 10){
    advice.push("🚨 Drawdown te hoog → risk omlaag");
  }

  if(stats.winrate > 60){
    advice.push("🔥 Strategie werkt → scale up");
  }

  if(stats.winrate < 45){
    advice.push("⚠️ Edge zwak → filters aanscherpen");
  }

  res.json({
    stats,
    portfolio:pf,
    advice
  });
}