import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

function emptySide(){
  return {
    entry: [],
    almost: [],
    buildup: [],
    radar: []
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

  for(const stage of ["entry", "almost", "buildup", "radar"]){
    total += Array.isArray(f?.[side]?.[stage])
      ? f[side][stage].length
      : 0;
  }

  return total;
}


function countFunnel(funnel){
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}


function withSafeShape(payload, source){

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

    const cached = getLatestScan();
    const cachedFunnelCount = countFunnel(cached?.funnel);

    // Cache alleen gebruiken als hij echt frontend-data heeft.
    if(cached && cached.ok && cachedFunnelCount > 0){
      return res.status(200).json(
        withSafeShape(cached, "cache")
      );
    }

    // Cache leeg of cache heeft 0 coins:
    // Bouw UI-data zonder Discord en zonder latestScan overwrite.
    const fresh = await buildScanPayload({
      side: "both",
      notify: false,
      store: false
    });

    return res.status(200).json(
      withSafeShape(
        {
          ...fresh,
          previousCacheHadData: Boolean(cached?.ok),
          previousFunnelCount: cachedFunnelCount
        },
        cached?.ok ? "silent_scan_cache_empty" : "silent_scan_no_cache"
      )
    );

  }catch(err){

    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "public_latest_failed",
      funnel: {
        bull: emptySide(),
        bear: emptySide()
      },
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