import { buildScanPayload } from "./scanner.js";

function normalizeSide(side){

  const s = String(side || "").toLowerCase();

  if(s === "bull") return "bull";
  if(s === "bear") return "bear";

  return null;
}

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

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const querySide = normalizeSide(req?.query?.side);
    const side = querySide || inferSideFromMinute();

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
      candidates: data?.candidates || 0,
      candidatesBull: data?.candidatesBull || 0,
      candidatesBear: data?.candidatesBear || 0,
      trades: Array.isArray(data?.trades) ? data.trades.length : 0,
      lastBullScan: data?.lastBullScan || null,
      lastBearScan: data?.lastBearScan || null
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