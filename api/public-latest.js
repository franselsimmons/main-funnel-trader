import { getLatestScan, setLatestScan } from "../lib/scanStore.js";

const STAGES = ["entry", "almost", "buildup", "radar"];

function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCounterMap(map){
  const out = {};

  for(const [key, value] of Object.entries(map || {})){
    const n = Math.round(Number(value || 0));
    if(n > 0) out[String(key)] = n;
  }

  return out;
}

function emptySide(){
  return {
    entry: [],
    almost: [],
    buildup: [],
    radar: []
  };
}

function emptyFunnel(){
  return {
    bull: emptySide(),
    bear: emptySide()
  };
}

function emptyDashboardStats(now = Date.now()){
  return {
    startedAt: now,
    lastResetAt: now,
    lastScanAt: 0,

    totalScans: 0,
    totalEntries: 0,
    totalRejected: 0,
    totalOtherTrades: 0,
    totalFunnelCoins: 0,
    totalCandidates: 0,

    lastEntries: 0,
    lastRejected: 0,
    lastOtherTrades: 0,
    lastFunnelCoins: 0,
    lastCandidates: 0,

    rejectReasonCounts: {},
    actionCounts: {},

    entryRows: [],
    rejectedRows: [],
    tradeRows: []
  };
}

function normalizeDashboardStats(stats, fallbackPayload = null){
  const now = Date.now();

  const trades = safeArray(fallbackPayload?.trades);
  const entries = trades.filter(t => String(t?.action || "").toUpperCase() === "ENTRY");
  const waits = trades.filter(t => String(t?.action || "").toUpperCase() === "WAIT");
  const otherTrades = trades.filter(t => {
    const a = String(t?.action || "").toUpperCase();
    return a !== "WAIT" && a !== "ENTRY";
  });

  const base = stats
    ? { ...stats }
    : {
        ...emptyDashboardStats(now),
        lastScanAt: safeNumber(fallbackPayload?.updatedAt, 0),
        lastEntries: entries.length,
        lastRejected: waits.length,
        lastOtherTrades: otherTrades.length,
        lastFunnelCoins: safeNumber(fallbackPayload?.funnelCount, 0),
        lastCandidates: safeNumber(fallbackPayload?.candidates, 0)
      };

  return {
    startedAt: safeNumber(base?.startedAt, now),
    lastResetAt: safeNumber(base?.lastResetAt, base?.startedAt || now),
    lastScanAt: safeNumber(base?.lastScanAt, fallbackPayload?.updatedAt || 0),

    totalScans: safeNumber(base?.totalScans, 0),
    totalEntries: safeNumber(base?.totalEntries, 0),
    totalRejected: safeNumber(base?.totalRejected, 0),
    totalOtherTrades: safeNumber(base?.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(base?.totalFunnelCoins, 0),
    totalCandidates: safeNumber(base?.totalCandidates, 0),

    lastEntries: safeNumber(base?.lastEntries, entries.length),
    lastRejected: safeNumber(base?.lastRejected, waits.length),
    lastOtherTrades: safeNumber(base?.lastOtherTrades, otherTrades.length),
    lastFunnelCoins: safeNumber(base?.lastFunnelCoins, fallbackPayload?.funnelCount || 0),
    lastCandidates: safeNumber(base?.lastCandidates, fallbackPayload?.candidates || 0),

    rejectReasonCounts: normalizeCounterMap(base?.rejectReasonCounts),
    actionCounts: normalizeCounterMap(base?.actionCounts),

    entryRows: safeArray(base?.entryRows),
    rejectedRows: safeArray(base?.rejectedRows),
    tradeRows: safeArray(base?.tradeRows)
  };
}

function normalizeFunnel(funnel){
  return {
    bull: {
      entry: safeArray(funnel?.bull?.entry),
      almost: safeArray(funnel?.bull?.almost),
      buildup: safeArray(funnel?.bull?.buildup),
      radar: safeArray(funnel?.bull?.radar)
    },
    bear: {
      entry: safeArray(funnel?.bear?.entry),
      almost: safeArray(funnel?.bear?.almost),
      buildup: safeArray(funnel?.bear?.buildup),
      radar: safeArray(funnel?.bear?.radar)
    }
  };
}

function countSide(funnel, side){
  const f = normalizeFunnel(funnel);
  return STAGES.reduce((acc, s) => acc + safeArray(f?.[side]?.[s]).length, 0);
}

function countFunnel(funnel){
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function hasStoredScanSinceReset(stats){
  return (
    safeNumber(stats?.totalScans) > 0 &&
    safeNumber(stats?.lastScanAt) >= safeNumber(stats?.lastResetAt)
  );
}

function safePayload(payload, source){
  const funnel = normalizeFunnel(payload?.funnel);

  const normalizedPayload = {
    ...(payload || {}),
    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),
    trades: safeArray(payload?.trades),
    btc: payload?.btc || { state: "UNKNOWN", chg24: 0 },
    regime: payload?.regime || "UNKNOWN",
    market: payload?.market || null,
    analytics: payload?.analytics || {},
    advice: payload?.advice || {}
  };

  const dashboardStats = normalizeDashboardStats(
    payload?.dashboardStats,
    normalizedPayload
  );

  return {
    ...normalizedPayload,
    ok: payload?.ok !== false,
    source,
    dashboardStats,
    hasStoredScanSinceReset: hasStoredScanSinceReset(dashboardStats),
    servedAt: Date.now()
  };
}

async function resetStoredStats(){
  const latest = await getLatestScan();

  if(!latest?.ok){
    return { ok: true, message: "Geen opgeslagen scan om te resetten." };
  }

  const now = Date.now();

  const updated = {
    ...latest,
    dashboardStats: emptyDashboardStats(now),
    statsResetAt: now,
    servedAt: now
  };

  await setLatestScan(updated);

  return safePayload(updated, "stats_reset");
}

// ================= HANDLER =================
export default async function handler(req, res){
  try{
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const action =
      String(req?.query?.action || req?.body?.action || "")
        .trim()
        .toLowerCase();

    if(req.method === "POST" && action === "resetstats"){
      const resetResult = await resetStoredStats();
      return res.status(200).json(resetResult);
    }

    const latest = await getLatestScan();

    // ✅ FIX: alleen gebruiken als er ECHT data is
    if(latest?.ok && Array.isArray(latest.trades) && latest.trades.length > 0){
      return res.status(200).json(
        safePayload(latest, "latest_locked")
      );
    }

    // 🔥 FALLBACK → dashboard blijft werken
    return res.status(200).json(
      safePayload({
        ok: true,
        scanReady: false,
        message: "Fallback live mode",
        funnel: latest?.funnel || emptyFunnel(),
        trades: latest?.trades || [],
        btc: latest?.btc || { state: "UNKNOWN", chg24: 0 },
        regime: latest?.regime || "UNKNOWN",
        dashboardStats: latest?.dashboardStats || emptyDashboardStats(Date.now()),
        updatedAt: Date.now()
      }, "fallback_live")
    );

  }catch(err){
    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "public_latest_failed",
      funnel: emptyFunnel(),
      trades: [],
      dashboardStats: emptyDashboardStats(Date.now()),
      servedAt: Date.now()
    });
  }
}