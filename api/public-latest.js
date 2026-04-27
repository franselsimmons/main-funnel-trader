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

    if(n > 0){
      out[String(key)] = n;
    }
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
    const action = String(t?.action || "").toUpperCase();
    return action !== "WAIT" && action !== "ENTRY";
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
    lastResetAt: safeNumber(base?.lastResetAt, safeNumber(base?.startedAt, now)),
    lastScanAt: safeNumber(base?.lastScanAt, safeNumber(fallbackPayload?.updatedAt, 0)),

    totalScans: safeNumber(base?.totalScans, 0),
    totalEntries: safeNumber(base?.totalEntries, 0),
    totalRejected: safeNumber(base?.totalRejected, 0),
    totalOtherTrades: safeNumber(base?.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(base?.totalFunnelCoins, 0),
    totalCandidates: safeNumber(base?.totalCandidates, 0),

    lastEntries: safeNumber(base?.lastEntries, entries.length),
    lastRejected: safeNumber(base?.lastRejected, waits.length),
    lastOtherTrades: safeNumber(base?.lastOtherTrades, otherTrades.length),
    lastFunnelCoins: safeNumber(base?.lastFunnelCoins, safeNumber(fallbackPayload?.funnelCount, 0)),
    lastCandidates: safeNumber(base?.lastCandidates, safeNumber(fallbackPayload?.candidates, 0)),

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
      entry: Array.isArray(funnel?.bull?.entry) ? funnel.bull.entry : [],
      almost: Array.isArray(funnel?.bull?.almost) ? funnel.bull.almost : [],
      buildup: Array.isArray(funnel?.bull?.buildup) ? funnel.bull.buildup : [],
      radar: Array.isArray(funnel?.bull?.radar) ? funnel.bull.radar : []
    },
    bear: {
      entry: Array.isArray(funnel?.bear?.entry) ? funnel.bear.entry : [],
      almost: Array.isArray(funnel?.bear?.almost) ? funnel.bear.almost : [],
      buildup: Array.isArray(funnel?.bear?.buildup) ? funnel.bear.buildup : [],
      radar: Array.isArray(funnel?.bear?.radar) ? funnel.bear.radar : []
    }
  };
}

function countSide(funnel, side){
  const f = normalizeFunnel(funnel);

  let total = 0;

  for(const stage of STAGES){
    total += Array.isArray(f?.[side]?.[stage])
      ? f[side][stage].length
      : 0;
  }

  return total;
}

function countFunnel(funnel){
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function hasStoredScanSinceReset(stats){
  const totalScans = safeNumber(stats?.totalScans, 0);
  const lastScanAt = safeNumber(stats?.lastScanAt, 0);
  const lastResetAt = safeNumber(stats?.lastResetAt, 0);

  return totalScans > 0 && lastScanAt > 0 && lastScanAt >= lastResetAt;
}

function safePayload(payload, source){
  const funnel = normalizeFunnel(payload?.funnel);

  const normalizedPayload = {
    ...(payload || {}),
    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),
    trades: Array.isArray(payload?.trades) ? payload.trades : [],
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
    return {
      ok: true,
      message: "Geen opgeslagen scan om te resetten."
    };
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

    if(latest?.ok){
      return res.status(200).json(
        safePayload(latest, "latest_locked")
      );
    }

    return res.status(200).json(
      safePayload({
        ok: true,
        scanReady: false,
        message: "Nog geen scan opgeslagen. Wacht tot /api/cron of /api/scanner?notify=true&store=true draait.",
        funnel: emptyFunnel(),
        trades: [],
        btc: { state: "UNKNOWN", chg24: 0 },
        regime: "UNKNOWN",
        dashboardStats: emptyDashboardStats(Date.now()),
        updatedAt: null
      }, "no_locked_scan")
    );

  }catch(err){
    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "public_latest_failed",
      funnel: emptyFunnel(),
      funnelCount: 0,
      bullCount: 0,
      bearCount: 0,
      trades: [],
      btc: { state: "UNKNOWN", chg24: 0 },
      regime: "UNKNOWN",
      dashboardStats: emptyDashboardStats(Date.now()),
      servedAt: Date.now()
    });
  }
}