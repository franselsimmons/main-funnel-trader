import { kv } from "@vercel/kv";

const KEY = "stage-memory-v1";

// 🔥 LOAD MEMORY
export async function loadStageMemory(){
  try{
    const data = await kv.get(KEY);
    return data || {};
  }catch(e){
    console.error("KV LOAD ERROR:", e);
    return {};
  }
}

// 🔥 SAVE MEMORY
export async function saveStageMemory(memory){
  try{
    await kv.set(KEY, memory);
  }catch(e){
    console.error("KV SAVE ERROR:", e);
  }
}

// 🔥 CLEAN (alleen actieve coins houden)
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