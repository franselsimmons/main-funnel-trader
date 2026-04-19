import { kv } from "@vercel/kv";

const KEY = "scanner:stageMemory";

// LOAD
export async function loadStageMemory(){
  try{
    const data = await kv.get(KEY);
    return data || {};
  }catch(e){
    console.error("LOAD MEMORY ERROR:", e);
    return {};
  }
}

// SAVE
export async function saveStageMemory(memory){
  try{
    await kv.set(KEY, memory);
  }catch(e){
    console.error("SAVE MEMORY ERROR:", e);
  }
}

// CLEAN (verwijder coins die niet meer bestaan)
export function cleanMemory(memory, activeSymbols){

  const cleaned = {};

  for(const key in memory){
    const symbol = key.split("_")[0];
    if(activeSymbols.includes(symbol)){
      cleaned[key] = memory[key];
    }
  }

  return cleaned;
}