let latestScan = null;

// Persistente stage memory binnen actieve runtime
let stageMemory = {};

export function setLatestScan(data){

  latestScan = {
    ...data,
    storedAt: Date.now()
  };

  return latestScan;
}

export function getLatestScan(){
  return latestScan;
}

export function clearLatestScan(){
  latestScan = null;
}


// ================= STAGE MEMORY =================

export function getStageMemory(){
  return stageMemory;
}

export function setStageMemory(newMemory){
  stageMemory = newMemory || {};
}

export function clearStageMemory(){
  stageMemory = {};
}