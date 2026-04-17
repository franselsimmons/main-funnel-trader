import { getFilters } from "./filterState.js";

export function generateAdvice(analytics){

  const filters = getFilters();

  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  for(const side of ["bull","bear"]){

    const f = filters[side];

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

      const stageAdvice = [];

      // SCORE
      let newScore = f.scoreMin;

      if(lowScore > 35) newScore += 5;
      if(lowScore < 10) newScore -= 5;

      if(newScore !== f.scoreMin){
        stageAdvice.push({
          action: newScore > f.scoreMin ? "STRENGER" : "SOEPELER",
          message: "Score aanpassen",
          current: f.scoreMin,
          recommended: newScore
        });
      }

      // VOLUME
      let newVol = f.volumeMin;

      if(lowVolume > 30) newVol += 0.05;
      if(lowVolume < 10) newVol -= 0.05;

      if(newVol !== f.volumeMin){
        stageAdvice.push({
          action: newVol > f.volumeMin ? "STRENGER" : "SOEPELER",
          message: "Volume aanpassen",
          current: f.volumeMin,
          recommended: Number(newVol.toFixed(2))
        });
      }

      // FLOW
      let newFlow = f.allowNeutral;

      if(weakFlow > 40) newFlow = false;
      if(weakFlow < 15) newFlow = true;

      if(newFlow !== f.allowNeutral){
        stageAdvice.push({
          action: newFlow ? "SOEPELER" : "STRENGER",
          message: "Flow aanpassen",
          current: f.allowNeutral ? "ALLOW" : "BLOCK",
          recommended: newFlow ? "ALLOW" : "BLOCK"
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  return advice;
}