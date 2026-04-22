import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

function countSide(funnel, side){

  if(!funnel?.[side]) return 0;

  let total = 0;

  for(const stage of ["entry", "almost", "buildup", "radar"]){
    total += Array.isArray(funnel[side][stage])
      ? funnel[side][stage].length
      : 0;
  }

  return total;
}


function countFunnel(funnel){

  return countSide(funnel, "bull") + countSide(funnel, "bear");
}


export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const cached = getLatestScan();

    const cachedBullCount = countSide(cached?.funnel, "bull");
    const cachedBearCount = countSide(cached?.funnel, "bear");
    const cachedFunnelCount = cachedBullCount + cachedBearCount;

    if(cached && cached.ok && cachedFunnelCount > 0){
      return res.status(200).json({
        ...cached,
        source: "cache",
        funnelCount: cachedFunnelCount,
        bullCount: cachedBullCount,
        bearCount: cachedBearCount,
        servedAt: Date.now()
      });
    }

    const fresh = await buildScanPayload({
      side: "both",
      notify: false,
      store: false
    });

    const freshBullCount = countSide(fresh?.funnel, "bull");
    const freshBearCount = countSide(fresh?.funnel, "bear");
    const freshFunnelCount = freshBullCount + freshBearCount;

    return res.status(200).json({
      ...fresh,
      source: cached?.ok ? "silent_scan_cache_empty" : "silent_scan_no_cache",
      previousCacheHadData: Boolean(cached?.ok),
      previousFunnelCount: cachedFunnelCount,
      funnelCount: freshFunnelCount,
      bullCount: freshBullCount,
      bearCount: freshBearCount,
      servedAt: Date.now()
    });

  }catch(err){

    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "public_latest_failed",
      servedAt: Date.now()
    });
  }
}