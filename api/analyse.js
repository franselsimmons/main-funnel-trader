import { getStats } from "../lib/learning.js";

export default function handler(req,res){

  const stats = getStats();

  let advice = [];

  if(stats.total < 10){
    advice.push("📊 Te weinig trades → wacht op data");
  }

  if(stats.winrate < 50){
    advice.push("⚠️ Winrate laag → verlaag risico");
    advice.push("👉 Pas riskManager.js aan");
  }

  if(stats.winrate > 65){
    advice.push("🔥 Sterke strategie → verhoog risico licht");
  }

  if(stats.winrate < 40){
    advice.push("🚨 STOP trading → systeem slecht");
  }

  res.json({
    stats,
    advice
  });
}