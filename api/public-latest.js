import { getLatestScan } from "../lib/scanStore.js";

const STAGES = ["entry", "almost", "buildup", "radar"];

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


function safePayload(payload, source){

  const funnel = normalizeFunnel(payload?.funnel);

  return {
    ...(payload || {}),
    ok: payload?.ok !== false,
    source,
    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),
    trades: Array.isArray(payload?.trades) ? payload.trades : [],
    btc: payload?.btc || { state: "UNKNOWN", chg24: 0 },
    regime: payload?.regime || "UNKNOWN",
    market: payload?.market || null,
    analytics: payload?.analytics || {},
    advice: payload?.advice || {},
    servedAt: Date.now()
  };
}


export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

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
      servedAt: Date.now()
    });
  }
}