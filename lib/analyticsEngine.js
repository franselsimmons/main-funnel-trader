let stats = null;

function createEmpty(){
  return {
    bull:createSide(),
    bear:createSide()
  };
}

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
      good:0
    }
  };
}

export function resetAnalytics(){
  stats = createEmpty();
}

export function logAnalytics(c){

  if(!stats) return;

  const s = stats[c.side]?.[c.stage];
  if(!s) return;

  s.total++;

  if(c.moveScore < 55) s.reasons.lowScore++;
  if(c.flow === "NEUTRAL") s.reasons.weakFlow++;
  if(c.vm < 0.35) s.reasons.lowVolume++;
  if(c.ob?.score < 0.04) s.reasons.badOB++;

  if(
    c.moveScore >= 55 &&
    c.flow !== "NEUTRAL" &&
    c.vm >= 0.35
  ){
    s.reasons.good++;
  }
}

function pct(v,t){
  return t === 0 ? "0%" : ((v/t)*100).toFixed(1)+"%";
}

export function getAnalytics(){

  const result = {};

  for(const side of ["bull","bear"]){

    result[side] = {};

    for(const stage of ["entry","almost","buildup","radar"]){

      const s = stats[side][stage];
      const t = s.total || 1;

      result[side][stage] = {
        total:s.total,
        reasons:{
          lowScore:pct(s.reasons.lowScore,t),
          weakFlow:pct(s.reasons.weakFlow,t),
          lowVolume:pct(s.reasons.lowVolume,t),
          badOB:pct(s.reasons.badOB,t),
          good:pct(s.reasons.good,t)
        }
      };
    }
  }

  return result;
}