const memory = new Map();

export function updateLifecycle(symbol, stage, score){

  const prev = memory.get(symbol);

  let newStage = stage;

  if(prev){

    if(prev.stage === "ENTRY" && stage !== "ENTRY"){
      newStage = "ALMOST";
    }

    if(prev.stage === "ALMOST" && stage === "RADAR"){
      newStage = "BUILDUP";
    }

    if(score > prev.score + 10){
      if(prev.stage === "RADAR") newStage = "BUILDUP";
      else if(prev.stage === "BUILDUP") newStage = "ALMOST";
      else if(prev.stage === "ALMOST") newStage = "ENTRY";
    }
  }

  memory.set(symbol, {
    stage: newStage,
    score,
    ts: Date.now()
  });

  return newStage;
}