let latestScan = null;

// 🔥 NIEUW: persistente stage memory
let stageMemory = {};

export function setLatestScan(data){
  latestScan = data;
}

export function getLatestScan(){
  return latestScan;
}

// ================= MEMORY =================

export function getStageMemory(){
  return stageMemory;
}

export function setStageMemory(newMemory){
  stageMemory = newMemory || {};
}