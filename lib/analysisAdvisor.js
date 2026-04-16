export function generateAdvice(analytics){

  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  for(const side of ["bull","bear"]){

    advice[side] = {};

    for(const stage of ["entry","almost","buildup","radar"]){

      const s = analytics[side][stage];

      const total = s.total || 1;

      const weakFlow = parseFloat(s.reasons.weakFlow);
      const lowScore = parseFloat(s.reasons.lowScore);
      const lowVolume = parseFloat(s.reasons.lowVolume);
      const badOB = parseFloat(s.reasons.badOB);

      const stageAdvice = [];

      // ================= FLOW =================
      if(weakFlow > 40){
        stageAdvice.push({
          type:"FLOW",
          action:"STRIKTER",
          message:"Blokkeer NEUTRAL flow",
          change:"flow !== NEUTRAL"
        });
      }

      if(weakFlow < 15){
        stageAdvice.push({
          type:"FLOW",
          action:"LOOSER",
          message:"Sta meer NEUTRAL flow toe",
          change:"allow NEUTRAL"
        });
      }

      // ================= SCORE =================
      if(lowScore > 35){
        stageAdvice.push({
          type:"SCORE",
          action:"STRIKTER",
          message:"Verhoog minimum score",
          change:"scoreMin +5"
        });
      }

      if(lowScore < 10){
        stageAdvice.push({
          type:"SCORE",
          action:"LOOSER",
          message:"Score kan lager",
          change:"scoreMin -5"
        });
      }

      // ================= VOLUME =================
      if(lowVolume > 30){
        stageAdvice.push({
          type:"VOLUME",
          action:"STRIKTER",
          message:"Verhoog volume filter",
          change:"vm +0.05"
        });
      }

      if(lowVolume < 10){
        stageAdvice.push({
          type:"VOLUME",
          action:"LOOSER",
          message:"Volume filter te streng",
          change:"vm -0.05"
        });
      }

      // ================= ORDERBOOK =================
      if(badOB > 25){
        stageAdvice.push({
          type:"ORDERBOOK",
          action:"ADD FILTER",
          message:"Voeg OB confirmatie toe",
          change:"require OB bias"
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  // ================= GLOBAL FLOW =================

  const entryCount = analytics.bull.entry.total + analytics.bear.entry.total;

  if(entryCount < 3){
    advice.global.push("⚠️ TE WEINIG ENTRIES → filters te streng");
  }

  if(entryCount > 15){
    advice.global.push("⚠️ TE VEEL ENTRIES → kwaliteit omlaag");
  }

  return advice;
}