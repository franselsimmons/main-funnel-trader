import { getFilters } from "./filterState.js";

// 🔥 NIEUW: flow berekening
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

  // mapping van funnel flow
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

      const weakFlow = Number(s.reasons?.weakFlow || 0);
      const lowScore = Number(s.reasons?.lowScore || 0);
      const lowVolume = Number(s.reasons?.lowVolume || 0);

      const stageAdvice = [];

      // ================= FLOW BETWEEN STAGES =================
      const currentTotal = s.total || 0;
      const nextStage = nextStageMap[stage];
      const nextTotal = analytics[side]?.[nextStage]?.total || 0;

      const flowRate = calcFlowRate(currentTotal, nextTotal);

      if(stage !== "entry"){

        if(flowRate < 5){
          stageAdvice.push({
            type:"flowRate",
            action:"SOEPELER",
            message:`Te weinig doorstroom (${flowRate.toFixed(1)}%)`,
            current:`${flowRate.toFixed(1)}%`,
            recommended:"Meer coins laten doorstromen"
          });
        }

        else if(flowRate > 40){
          stageAdvice.push({
            type:"flowRate",
            action:"STRENGER",
            message:`Te hoge doorstroom (${flowRate.toFixed(1)}%)`,
            current:`${flowRate.toFixed(1)}%`,
            recommended:"Kwaliteit verhogen"
          });
        }
      }

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

      // ================= FLOW (FILTER) =================
      let newFlow = f.allowNeutral;

      if(weakFlow > 50) newFlow = true;
      else if(weakFlow < 10) newFlow = false;

      if(newFlow !== f.allowNeutral){
        stageAdvice.push({
          type:"flow",
          action: newFlow ? "SOEPELER" : "STRENGER",
          message:"Flow filter aanpassen",
          current: f.allowNeutral ? "ALLOW" : "BLOCK",
          recommended: newFlow ? "ALLOW" : "BLOCK"
        });
      }

      // fallback als niks gevonden
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