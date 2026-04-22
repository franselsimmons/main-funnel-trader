import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

const UI_CACHE_TTL = 12 * 1000;
let uiCache = null;

const STAGES = ["entry", "almost", "buildup", "radar"];

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


function hasGoodFunnel(payload){

  return Boolean(
    payload?.ok &&
    countFunnel(payload?.funnel) > 0
  );
}


function mergeUiFreshWithCached(fresh, cached){

  const cachedTrades = Array.isArray(cached?.trades)
    ? cached.trades
    : [];

  const freshTrades = Array.isArray(fresh?.trades)
    ? fresh.trades
    : [];

  return {
    ...fresh,

    // Funnel komt altijd uit fresh UI-safe scan.
    funnel: fresh?.funnel,

    // Trades liever uit cron-cache houden als die er zijn.
    trades: cachedTrades.length ? cachedTrades : freshTrades,

    // Laatste cron metadata bewaren waar nuttig.
    lastBullScan: cached?.lastBullScan || fresh?.lastBullScan || null,
    lastBearScan: cached?.lastBearScan || fresh?.lastBearScan || null,

    cachedAt: cached?.storedAt || cached?.updatedAt || null,
    previousCacheHadData: Boolean(cached?.ok),
    previousFunnelCount: countFunnel(cached?.funnel)
  };
}


export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const now = Date.now();

    // Zelfde tab / snelle navigatie: gebruik korte UI-cache.
    if(
      uiCache?.data &&
      now - uiCache.createdAt < UI_CACHE_TTL &&
      hasGoodFunnel(uiCache.data)
    ){
      return res.status(200).json(
        withSafeShape(uiCache.data, "ui_cache")
      );
    }

    const cached = getLatestScan();

    // Bouw altijd een UI-safe scan voor pagina's.
    // Geen Discord, geen latestScan overwrite.
    const fresh = await buildScanPayload({
      side: "both",
      notify: false,
      store: false
    });

    if(hasGoodFunnel(fresh)){

      const merged = mergeUiFreshWithCached(fresh, cached);

      uiCache = {
        createdAt: now,
        data: merged
      };

      return res.status(200).json(
        withSafeShape(merged, cached?.ok ? "silent_scan_merged" : "silent_scan")
      );
    }

    // Als fresh faalt/leeg is, val terug op cron-cache.
    if(hasGoodFunnel(cached)){
      return res.status(200).json(
        withSafeShape(cached, "cache_fallback")
      );
    }

    // Laatste fallback: veilige lege shape, zodat frontend niet crasht.
    return res.status(200).json(
      withSafeShape(
        {
          ok: true,
          funnel: {
            bull: emptySide(),
            bear: emptySide()
          },
          trades: [],
          btc: { state: "UNKNOWN", chg24: 0 },
          regime: "UNKNOWN"
        },
        "empty_safe_shape"
      )
    );

  }catch(err){

    console.error("PUBLIC-LATEST ERROR:", err);

    const cached = getLatestScan();

    if(hasGoodFunnel(cached)){
      return res.status(200).json(
        withSafeShape(cached, "cache_after_error")
      );
    }

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