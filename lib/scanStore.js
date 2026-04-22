// ================= SCAN STORE =================
// Doel:
// - /api/cron of /api/scanner?notify=true&store=true schrijft latest scan
// - /api/public-latest leest alleen latest scan
// - Pagina wisselen / refresh maakt GEEN nieuwe scan
// - Met KV/Upstash blijft latest vast staan tussen Vercel cold starts

const STORE_KEY = "tradeSystem:latestScan:v1";

const globalStore = globalThis.__TRADE_SYSTEM_SCAN_STORE__ || {
  latestScan: null,
  stageMemory: {}
};

globalThis.__TRADE_SYSTEM_SCAN_STORE__ = globalStore;


// ================= KV / UPSTASH CONFIG =================
function getRedisUrl(){

  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}


function getRedisToken(){

  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}


function hasRedis(){
  return Boolean(getRedisUrl() && getRedisToken());
}


async function redisCommand(command){

  const url = getRedisUrl();
  const token = getRedisToken();

  if(!url || !token){
    throw new Error("Redis env missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const json = await res.json().catch(() => null);

  if(!res.ok || json?.error){
    throw new Error(json?.error || `Redis error ${res.status}`);
  }

  return json?.result;
}


// ================= LATEST SCAN =================

export async function setLatestScan(data){

  const payload = {
    ...(data || {}),
    storedAt: Date.now()
  };

  // Warme runtime cache
  globalStore.latestScan = payload;

  // Durable cache als KV/Upstash env bestaat
  if(hasRedis()){
    try{
      await redisCommand([
        "SET",
        STORE_KEY,
        JSON.stringify(payload)
      ]);
    }catch(e){
      console.error("SCAN STORE SET ERROR:", e.message);
    }
  }

  return payload;
}


export async function getLatestScan(){

  // Eerst durable store lezen, zodat elke Vercel instance dezelfde latest krijgt
  if(hasRedis()){
    try{
      const result = await redisCommand([
        "GET",
        STORE_KEY
      ]);

      if(result){
        const parsed = typeof result === "string"
          ? JSON.parse(result)
          : result;

        if(parsed?.ok){
          globalStore.latestScan = parsed;
          return parsed;
        }
      }

    }catch(e){
      console.error("SCAN STORE GET ERROR:", e.message);
    }
  }

  // Fallback voor lokale dev of wanneer KV nog niet ingesteld is
  return globalStore.latestScan;
}


export async function clearLatestScan(){

  globalStore.latestScan = null;

  if(hasRedis()){
    try{
      await redisCommand([
        "DEL",
        STORE_KEY
      ]);
    }catch(e){
      console.error("SCAN STORE CLEAR ERROR:", e.message);
    }
  }
}


// ================= STAGE MEMORY =================
// Deze blijft sync, zodat je bestaande stageMemory.js niet breekt.

export function getStageMemory(){
  return globalStore.stageMemory || {};
}


export function setStageMemory(newMemory){
  globalStore.stageMemory = newMemory || {};
  return globalStore.stageMemory;
}


export function clearStageMemory(){
  globalStore.stageMemory = {};
}