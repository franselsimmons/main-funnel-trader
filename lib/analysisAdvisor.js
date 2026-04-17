import { getFilters } from "./filterState.js";

function calcFlowRate(current, next){
  if(!current || current === 0) return 0;
  return (next / current) * 100;
}

export function generateAdvice(analytics){

  const filters = getFilters();

  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  const nextStageMap = {
    radar: "buildup",
    buildup: "almost",
    almost: "entry"
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

      const stageAdvice = [];

      const currentTotal = s.total || 0;
      const nextStage = nextStageMap[stage];
      const nextTotal = analytics[side]?.[nextStage]?.total || 0;

      const flowRate = calcFlowRate(currentTotal, nextTotal);

      // ================= 🔥 FLOW → FILTER TUNING =================
      if(stage !== "entry"){

        if(flowRate < 5){

          // 🔥 sterke versoepeling
          const newScore = Math.max(20, f.scoreMin - 15);
          const newVolume = Number(Math.max(0.05, f.volumeMin - 0.15).toFixed(2));

          stageAdvice.push({
            type:"score",
            action:"SOEPELER",
            message:"Score verlagen (flow blokkeert)",
            current:f.scoreMin,
            recommended:newScore
          });

          stageAdvice.push({
            type:"volume",
            action:"SOEPELER",
            message:"Volume verlagen (te weinig coins)",
            current:f.volumeMin,
            recommended:newVolume
          });

          if(!f.allowNeutral){
            stageAdvice.push({
              type:"flow",
              action:"SOEPELER",
              message:"Flow openzetten",
              current:"BLOCK",
              recommended:"ALLOW"
            });
          }
        }

        else if(flowRate < 15){

          // 🔥 lichte versoepeling
          const newScore = f.scoreMin - 5;
          const newVolume = Number((f.volumeMin - 0.05).toFixed(2));

          stageAdvice.push({
            type:"score",
            action:"SOEPELER",
            message:"Score iets verlagen",
            current:f.scoreMin,
            recommended:newScore
          });

          stageAdvice.push({
            type:"volume",
            action:"SOEPELER",
            message:"Volume iets verlagen",
            current:f.volumeMin,
            recommended:newVolume
          });
        }

        else if(flowRate > 40){

          // 🔥 te veel rommel → strenger
          const newScore = f.scoreMin + 5;
          const newVolume = Number((f.volumeMin + 0.05).toFixed(2));

          stageAdvice.push({
            type:"score",
            action:"STRENGER",
            message:"Score verhogen (te veel doorstroom)",
            current:f.scoreMin,
            recommended:newScore
          });

          stageAdvice.push({
            type:"volume",
            action:"STRENGER",
            message:"Volume verhogen",
            current:f.volumeMin,
            recommended:newVolume
          });
        }
      }

      // fallback
      if(stageAdvice.length === 0){
        stageAdvice.push({
          type:"info",
          action:"OK",
          message:"Flow is gezond",
          current:"",
          recommended:""
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  return advice;
}