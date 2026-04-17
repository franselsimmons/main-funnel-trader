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

    const stages = ["radar","buildup","almost","entry"];

    for(let i = 0; i < stages.length; i++){

      const stage = stages[i];
      const nextStage = stages[i+1];

      const s = analytics[side]?.[stage];
      const next = analytics[side]?.[nextStage];

      const f = filters[side]?.[nextStage];

      if(!s || !nextStage || !f){
        advice[side][stage] = [];
        continue;
      }

      const currentCount = s.total || 0;
      const nextCount = next?.total || 0;

      let flowPerc = 0;

      if(currentCount > 0){
        flowPerc = (nextCount / currentCount) * 100;
      }

      const stageAdvice = [];

      // 🔥 DOEL FLOW
      const targetMin = 10;
      const targetMax = 30;

      // ================= TE WEINIG FLOW =================
      if(flowPerc < targetMin){

        const newScore = Math.max(20, f.scoreMin - 10);
        const newVolume = Math.max(0.05, f.volumeMin - 0.05);

        stageAdvice.push({
          action: "SOEPELER",
          message: `${nextStage.toUpperCase()} krijgt te weinig coins (${flowPerc.toFixed(1)}%)`,
          current: `${flowPerc.toFixed(1)}%`,
          recommended: `${targetMin}%+`
        });

        stageAdvice.push({
          action: "SOEPELER",
          message: `${nextStage.toUpperCase()} score verlagen`,
          current: f.scoreMin,
          recommended: newScore
        });

        stageAdvice.push({
          action: "SOEPELER",
          message: `${nextStage.toUpperCase()} volume verlagen`,
          current: f.volumeMin,
          recommended: newVolume
        });
      }

      // ================= TE VEEL FLOW =================
      if(flowPerc > targetMax){

        const newScore = Math.min(95, f.scoreMin + 5);
        const newVolume = Math.min(1, f.volumeMin + 0.05);

        stageAdvice.push({
          action: "STRENGER",
          message: `${nextStage.toUpperCase()} krijgt te veel coins (${flowPerc.toFixed(1)}%)`,
          current: `${flowPerc.toFixed(1)}%`,
          recommended: `${targetMax}%`
        });

        stageAdvice.push({
          action: "STRENGER",
          message: `${nextStage.toUpperCase()} score verhogen`,
          current: f.scoreMin,
          recommended: newScore
        });

        stageAdvice.push({
          action: "STRENGER",
          message: `${nextStage.toUpperCase()} volume verhogen`,
          current: f.volumeMin,
          recommended: newVolume
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  return advice;
}