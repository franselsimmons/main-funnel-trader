import { getLatestScan, setLatestScan } from "../lib/scanStore.js";

const STAGES = ["entry", "almost", "buildup", "radar"];

// ================= SAFE HELPERS =================
const safeArray = v => Array.isArray(v) ? v : [];
const safeNumber = (v, f=0) => Number.isFinite(Number(v)) ? Number(v) : f;

// ================= HARD FIX: FORCE TRADE STRUCTURE =================
function normalizeTrades(trades){
  return safeArray(trades).map(t => ({
    symbol: t.symbol || "UNKNOWN",
    side: t.side || "unknown",
    action: t.action || "WAIT",
    stage: t.stage || "entry",
    score: safeNumber(t.score),
    confluence: safeNumber(t.confluence),
    rr: safeNumber(t.rr),
    entry: safeNumber(t.entry),
    sl: safeNumber(t.sl),
    tp: safeNumber(t.tp),
    rsiZone: t.rsiZone || "UNKNOWN",
    grade: t.grade || "C",
    flow: t.flow || "-",
    obBias: t.obBias || "-",
    tfStrength: t.tfStrength || "-",
    scanTs: safeNumber(t.scanTs, Date.now()),

    // 🔥 CRUCIAAL VOOR EXPECTANCY
    result: t.result === "WIN" || t.result === "LOSS"
      ? t.result
      : null
  }));
}

// ================= FUNNEL =================
function emptySide(){
  return { entry: [], almost: [], buildup: [], radar: [] };
}

function emptyFunnel(){
  return { bull: emptySide(), bear: emptySide() };
}

function normalizeFunnel(funnel){
  return {
    bull: STAGES.reduce((o,s)=>({...o,[s]:safeArray(funnel?.bull?.[s])}),{}),
    bear: STAGES.reduce((o,s)=>({...o,[s]:safeArray(funnel?.bear?.[s])}),{})
  };
}

// ================= STATS =================
function emptyStats(now){
  return {
    startedAt: now,
    lastResetAt: now,
    lastScanAt: 0,

    totalScans: 0,
    totalEntries: 0,
    totalRejected: 0,
    totalOtherTrades: 0,

    entryRows: [],
    rejectedRows: [],
    tradeRows: []
  };
}

function normalizeStats(stats){
  const now = Date.now();
  return {
    ...emptyStats(now),
    ...(stats || {}),
    entryRows: normalizeTrades(stats?.entryRows),
    rejectedRows: normalizeTrades(stats?.rejectedRows),
    tradeRows: normalizeTrades(stats?.tradeRows)
  };
}

// ================= SAFE PAYLOAD =================
function safePayload(payload){
  const funnel = normalizeFunnel(payload?.funnel);

  return {
    ok: true,
    funnel,
    trades: normalizeTrades(payload?.trades),
    dashboardStats: normalizeStats(payload?.dashboardStats),
    updatedAt: safeNumber(payload?.updatedAt, Date.now()),
    btc: payload?.btc || { state: "UNKNOWN" },
    regime: payload?.regime || "UNKNOWN",
    servedAt: Date.now()
  };
}

// ================= RESET =================
async function resetStats(){
  const latest = await getLatestScan();
  const now = Date.now();

  const updated = {
    ...latest,
    dashboardStats: emptyStats(now),
    updatedAt: now
  };

  await setLatestScan(updated);
  return safePayload(updated);
}

// ================= HANDLER =================
export default async function handler(req, res){
  try{
    res.setHeader("Cache-Control", "no-store");

    const action = String(req.query?.action || "").toLowerCase();

    if(req.method === "POST" && action === "resetstats"){
      return res.json(await resetStats());
    }

    const latest = await getLatestScan();

    if(!latest){
      return res.json(safePayload({
        trades: [],
        funnel: emptyFunnel(),
        dashboardStats: emptyStats(Date.now())
      }));
    }

    return res.json(safePayload(latest));

  }catch(err){
    console.error(err);

    return res.json({
      ok: true, // 🔥 NOOIT false → voorkomt frontend crash
      trades: [],
      funnel: emptyFunnel(),
      dashboardStats: emptyStats(Date.now())
    });
  }
}