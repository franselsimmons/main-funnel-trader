let stats = null;

function createEmpty(){
  return {
    bull: createSide(),
    bear: createSide()
  };
}


function createSide(){
  return {
    entry: createStage(),
    almost: createStage(),
    buildup: createStage(),
    radar: createStage()
  };
}


function createStage(){
  return {
    total: 0,
    reasons: {
      lowScore: 0,
      weakFlow: 0,
      lowVolume: 0,
      badOB: 0,
      good: 0
    }
  };
}


function safeNumber(v, fallback = 0){

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : fallback;
}


export function resetAnalytics(){
  stats = createEmpty();
}


export function logAnalytics(c){

  if(!stats) return;

  // Belangrijk:
  // UI-only / fallback coins mogen analyse niet vervuilen.
  if(c?.uiOnly) return;
  if(c?.stageSource === "fallback") return;
  if(c?.stageSource === "ui_fallback") return;

  const side = c.side === "bear" ? "bear" : "bull";
  const stage = ["entry", "almost", "buildup", "radar"].includes(c.stage)
    ? c.stage
    : "radar";

  const s = stats?.[side]?.[stage];
  if(!s) return;

  const moveScore = safeNumber(c.moveScore);
  const vm = safeNumber(c.vm);
  const obScore = safeNumber(c.ob?.score, 1);

  s.total++;

  if(moveScore < 55) s.reasons.lowScore++;
  if(c.flow === "NEUTRAL") s.reasons.weakFlow++;
  if(vm < 0.35) s.reasons.lowVolume++;
  if(obScore < 0.04) s.reasons.badOB++;

  if(
    moveScore >= 55 &&
    c.flow !== "NEUTRAL" &&
    vm >= 0.35 &&
    obScore >= 0.04
  ){
    s.reasons.good++;
  }
}


function pct(v, t){
  return t === 0 ? "0%" : ((v / t) * 100).toFixed(1) + "%";
}


export function getAnalytics(){

  if(!stats){
    stats = createEmpty();
  }

  const result = {};

  for(const side of ["bull", "bear"]){

    result[side] = {};

    for(const stage of ["entry", "almost", "buildup", "radar"]){

      const s = stats[side][stage];
      const t = s.total || 0;

      result[side][stage] = {
        total: s.total,
        reasons: {
          lowScore: pct(s.reasons.lowScore, t),
          weakFlow: pct(s.reasons.weakFlow, t),
          lowVolume: pct(s.reasons.lowVolume, t),
          badOB: pct(s.reasons.badOB, t),
          good: pct(s.reasons.good, t)
        },
        reasonCounts: {
          lowScore: s.reasons.lowScore,
          weakFlow: s.reasons.weakFlow,
          lowVolume: s.reasons.lowVolume,
          badOB: s.reasons.badOB,
          good: s.reasons.good
        }
      };
    }
  }

  return result;
}