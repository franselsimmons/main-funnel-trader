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
      if(!s){
        advice[side][stage] = [];
        continue;
      }

      const weakFlow = parseFloat(s.reasons?.weakFlow) || 0;
      const lowScore = parseFloat(s.reasons?.lowScore) || 0;
      const lowVolume = parseFloat(s.reasons?.lowVolume) || 0;
      const badOB = parseFloat(s.reasons?.badOB) || 0;

      const stageAdvice = [];

      // ================= SCORE =================
      let newScore = filters.scoreMin;

      if(lowScore > 35) newScore += 5;
      if(lowScore < 10) newScore -= 5;

      if(newScore !== filters.scoreMin){
        stageAdvice.push({
          type: "score",
          action: newScore > filters.scoreMin ? "STRENGER" : "SOEPELER",
          message: "Minimum score aanpassen",
          current: filters.scoreMin,
          recommended: newScore
        });
      }

      // ================= VOLUME =================
      let newVolume = filters.volumeMin;

      if(lowVolume > 30) newVolume += 0.05;
      if(lowVolume < 10) newVolume -= 0.05;

      if(newVolume !== filters.volumeMin){
        stageAdvice.push({
          type: "volume",
          action: newVolume > filters.volumeMin ? "STRENGER" : "SOEPELER",
          message: "Volume filter aanpassen",
          current: filters.volumeMin,
          recommended: Number(newVolume.toFixed(2))
        });
      }

      // ================= FLOW =================
      let newFlow = filters.allowNeutral;

      if(weakFlow > 40) newFlow = false;
      if(weakFlow < 15) newFlow = true;

      if(newFlow !== filters.allowNeutral){
        stageAdvice.push({
          type: "flow",
          action: newFlow ? "SOEPELER" : "STRENGER",
          message: "Flow filter aanpassen",
          current: filters.allowNeutral ? "ALLOW" : "BLOCK",
          recommended: newFlow ? "ALLOW" : "BLOCK"
        });
      }

      // ================= ORDERBOOK =================
      if(badOB > 25){
        stageAdvice.push({
          type: "orderbook",
          action: "STRENGER",
          message: "Orderboek confirmatie toevoegen"
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
    advice.global.push("⚠️ TE WEINIG ENTRIES → filters te streng");
  } 
  else if(entryCount > 15){
    advice.global.push("⚠️ TE VEEL ENTRIES → kwaliteit omlaag");
  } 
  else{
    advice.global.push("✅ GEZONDE FUNNEL → goede doorstroming");
  }

  return advice;
}