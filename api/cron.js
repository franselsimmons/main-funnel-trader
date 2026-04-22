import { buildScanPayload } from "./scanner.js";

function normalizeSide(side){

  const s = String(side || "").toLowerCase();

  if(s === "bull") return "bull";
  if(s === "bear") return "bear";
  if(s === "both") return "both";

  return null;
}


// ================= SIDE FROM MINUTE =================
// 00 / 15 / 30 / 45 = bull
// 07 / 22 / 37 / 52 = bear
function inferSideFromMinute(){

  const minute = new Date().getUTCMinutes();

  if([0, 15, 30, 45].includes(minute)){
    return "bull";
  }

  if([7, 22, 37, 52].includes(minute)){
    return "bear";
  }

  return "both";
}


export default async function handler(req, res){

  const startedAt = Date.now();

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    // Handmatig testen blijft mogelijk:
    // /api/cron?side=bull
    // /api/cron?side=bear
    // /api/cron?side=both
    const querySide = normalizeSide(req?.query?.side);

    // Echte Vercel cron gebruikt geen query meer.
    // Daarom bepalen we automatisch via UTC minuut.
    const side = querySide || inferSideFromMinute();

    const utcMinute = new Date().getUTCMinutes();

    console.log("CRON START:", {
      side,
      querySide,
      utcMinute,
      at: new Date().toISOString()
    });

    const data = await buildScanPayload({
      side,
      notify: true,
      store: true
    });

    const result = {
      ok: true,
      source: "cron",
      side,
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,

      scanSide: data?.scanSide || side,
      scanMode: data?.scanMode || side,

      btc: data?.btc || null,
      regime: data?.regime || null,

      candidates: data?.candidates || 0,
      candidatesBull: data?.candidatesBull || 0,
      candidatesBear: data?.candidatesBear || 0,

      trades: Array.isArray(data?.trades) ? data.trades.length : 0,
      bullTrades: Array.isArray(data?.trades)
        ? data.trades.filter(t => t.side === "bull").length
        : 0,
      bearTrades: Array.isArray(data?.trades)
        ? data.trades.filter(t => t.side === "bear").length
        : 0,

      lastBullScan: data?.lastBullScan || null,
      lastBearScan: data?.lastBearScan || null,
      updatedAt: data?.updatedAt || null
    };

    console.log("CRON DONE:", result);

    return res.status(200).json(result);

  }catch(err){

    console.error("CRON ERROR:", err);

    return res.status(500).json({
      ok: false,
      source: "cron",
      error: err?.message || "cron_failed",
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt
    });
  }
}