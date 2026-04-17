import { getFilters } from "./filterState.js";

export function generateAdvice(analytics){

  const filters = getFilters();

  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  for(const side of ["bull","bear"]){

    advice[side] = {};

    for(const stage of ["entry","almost","buildup","radar"]){

      const s = analytics[side]?.[stage];
      const f = filters[side]?.[stage];

      if(!s || !f){
        advice[side][stage] = [];
        continue;
      }

      const weakFlow = Number(s.reasons?.weakFlow || 0);
      const lowScore = Number(s.reasons?.lowScore || 0);
      const lowVolume = Number(s.reasons?.lowVolume || 0);

      const stageAdvice = [];

      // ================= SCORE =================
      let newScore = f.scoreMin;

      if(lowScore > 60) newScore -= 10;
      else if(lowScore > 40) newScore -= 5;
      else if(lowScore < 10) newScore += 5;

      newScore = Math.max(20, Math.min(95, newScore));

      if(newScore !== f.scoreMin){
        stageAdvice.push({
          type:"score",
          action: newScore < f.scoreMin ? "SOEPELER" : "STRENGER",
          message:"Score aanpassen",
          current: f.scoreMin,
          recommended: newScore
        });
      }

      // ================= VOLUME =================
      let newVolume = f.volumeMin;

      if(lowVolume > 60) newVolume -= 0.1;
      else if(lowVolume > 40) newVolume -= 0.05;
      else if(lowVolume < 10) newVolume += 0.05;

      newVolume = Number(Math.max(0.05, Math.min(1, newVolume)).toFixed(2));

      if(newVolume !== f.volumeMin){
        stageAdvice.push({
          type:"volume",
          action: newVolume < f.volumeMin ? "SOEPELER" : "STRENGER",
          message:"Volume aanpassen",
          current: f.volumeMin,
          recommended: newVolume
        });
      }

      // ================= FLOW =================
      let newFlow = f.allowNeutral;

      if(weakFlow > 50) newFlow = true;     // teveel weak → soepeler
      else if(weakFlow < 10) newFlow = false; // weinig weak → strenger

      if(newFlow !== f.allowNeutral){
        stageAdvice.push({
          type:"flow",
          action: newFlow ? "SOEPELER" : "STRENGER",
          message:"Flow aanpassen",
          current: f.allowNeutral ? "ALLOW" : "BLOCK",
          recommended: newFlow ? "ALLOW" : "BLOCK"
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  // ================= GLOBAL =================

  const entryCount =
    (analytics.bull?.entry?.total || 0) +
    (analytics.bear?.entry?.total || 0);

  if(entryCount < 3){
    advice.global.push("⚠️ Te weinig entries → filters te streng");
  }
  else if(entryCount > 15){
    advice.global.push("⚠️ Te veel entries → kwaliteit omlaag");
  }
  else{
    advice.global.push("✅ Goede funnel balans");
  }

  return advice;
}