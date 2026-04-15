import { getStats } from "../lib/learning.js";

let SYSTEM_ON = true;

export function isSystemOn(){
  return SYSTEM_ON;
}

export default function handler(req,res){

  const stats = getStats();

  // Auto shutdown
  if(stats.total > 20 && stats.winrate < 40){
    SYSTEM_ON = false;
  }

  // Manual override
  if(req.query.force === "on") SYSTEM_ON = true;
  if(req.query.force === "off") SYSTEM_ON = false;

  res.json({
    system: SYSTEM_ON ? "ON" : "OFF",
    winrate: stats.winrate
  });
}