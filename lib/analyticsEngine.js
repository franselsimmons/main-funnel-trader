const stats = {
  bull: createSide(),
  bear: createSide()
};

function createSide(){
  return {
    entry:createStage(),
    almost:createStage(),
    buildup:createStage(),
    radar:createStage()
  };
}

function createStage(){
  return {
    total:0,
    reasons:{
      lowScore:0,
      weakFlow:0,
      lowVolume:0,
      badOB:0,
      neutral:0
    }
  };
}


// ================= LOG =================
export function logAnalytics(c){

  const side = c.side;
  const stage = c.stage.toLowerCase();

  if(!stats[side] || !stats[side][stage]) return;

  const s = stats[side][stage];

  s.total++;

  // ===== REASONS =====

  if(c.moveScore < 55){
    s.reasons.lowScore++;
  }

  if(c.flow === "NEUTRAL"){
    s.reasons.weakFlow++;
  }

  if(c.vm < 0.35){
    s.reasons.lowVolume++;
  }

  if(c.ob?.score < 0.04){
    s.reasons.badOB++;
  }

  if(
    c.moveScore >= 55 &&
    c.flow !== "NEUTRAL" &&
    c.vm >= 0.35
  ){
    s.reasons.neutral++;
  }
}


// ================= GET =================
export function getAnalytics(){

  const result = {};

  for(const side of ["bull","bear"]){

    result[side] = {};

    for(const stage of ["entry","almost","buildup","radar"]){

      const s = stats[side][stage];

      const total = s.total || 1;

      result[side][stage] = {
        total:s.total,
        reasons:{
          lowScore: pct(s.reasons.lowScore,total),
          weakFlow: pct(s.reasons.weakFlow,total),
          lowVolume: pct(s.reasons.lowVolume,total),
          badOB: pct(s.reasons.badOB,total),
          neutral: pct(s.reasons.neutral,total)
        }
      };
    }
  }

  return result;
}


function pct(v,t){
  return ((v/t)*100).toFixed(1)+"%";
}