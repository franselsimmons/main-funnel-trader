import { buildScanPayload } from "./scanner.js";

function normalizeSide(side){

  const s = String(side || "").toLowerCase();

  if(s === "bull") return "bull";
  if(s === "bear") return "bear";
  if(s === "both") return "both";

  return null;
}


// fallback als Vercel query soms niet meekomt
function inferSideFromMinute(){

  const minute = new Date().getUTCMinutes();

  // bull schema: 0,15,30,45
  if([0, 15, 30, 45].includes(minute)){
    return "bull";
  }

  // bear schema: 7,22,37,52
  if([7, 22, 37, 52].includes(minute)){
    return "bear";
  }

  return "both";
}


export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const querySide = normalizeSide(req?.query?.side);
    const side = querySide || inferSideFromMinute();

    console.log("CRON RUN:", {
      side,
      querySide,
      at: new Date().toISOString()
    });

    // Cron draait altijd met notify=true:
    // Discord mag dus alleen vanuit cron/triggers gestuurd worden.
    const data = await buildScanPayload({
      side,
      notify: true
    });

    return res.status(200).json({
      ok: true,
      source: "cron",
      side,
      ranAt: Date.now(),

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
    });

  }catch(err){

    console.error("CRON ERROR:", err);

    return res.status(500).json({
      ok: false,
      source: "cron",
      error: err?.message || "cron_failed",
      ranAt: Date.now()
    });
  }
}