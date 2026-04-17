import { getFilters, setFilters } from "./filterState.js";
import { getWinrate } from "./aiMemory.js";

let lastRun = 0;

export function autoAdjustV4(advice, market){

  const now = Date.now();

  // 🔥 cooldown
  if(now - lastRun < 15 * 60 * 1000){
    return { skipped:true };
  }

  const filters = getFilters();
  const updated = JSON.parse(JSON.stringify(filters));

  for(const side of ["bull","bear"]){

    const winrate = getWinrate(side);

    for(const stage of ["radar","buildup","almost","entry"]){

      const f = updated?.[side]?.[stage];
      const advices = advice?.[side]?.[stage] || [];

      if(!f) continue;

      // ===== BASE ADVICE =====
      for(const a of advices){

        if(a.type === "score"){
          f.scoreMin = clamp(a.recommended, 20, 95);
        }

        if(a.type === "volume"){
          f.volumeMin = clamp(a.recommended, 0.05, 1);
        }

        if(a.type === "flow"){
          f.allowNeutral = a.recommended === "ALLOW";
        }
      }

      // ===== MARKET MODE =====
      if(market === "TRENDING"){
        f.scoreMin -= 5;
        f.volumeMin -= 0.03;
      }

      if(market === "CHOPPY"){
        f.scoreMin += 5;
        f.volumeMin += 0.05;
      }

      // ===== WINRATE =====
      if(winrate < 40){
        f.scoreMin += 5;
      }

      if(winrate > 65){
        f.scoreMin -= 5;
      }

      // ===== LIMITS =====
      f.scoreMin = clamp(f.scoreMin, 20, 95);
      f.volumeMin = clamp(f.volumeMin, 0.05, 1);
    }
  }

  setFilters(updated);
  lastRun = now;

  return {
    success:true,
    market,
    winrates:{
      bull:getWinrate("bull"),
      bear:getWinrate("bear")
    }
  };
}

function clamp(v,min,max){
  return Math.max(min, Math.min(max, Number(v)));
}