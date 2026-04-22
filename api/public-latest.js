import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

function countFunnel(funnel){

  if(!funnel) return 0;

  let total = 0;

  for(const side of ["bull", "bear"]){
    for(const stage of ["entry", "almost", "buildup", "radar"]){
      total += Array.isArray(funnel?.[side]?.[stage])
        ? funnel[side][stage].length
        : 0;
    }
  }

  return total;
}


export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const cached = getLatestScan();
    const cachedFunnelCount = countFunnel(cached?.funnel);

    // Cache met zichtbare coins teruggeven.
    if(cached && cached.ok && cachedFunnelCount > 0){
      return res.status(200).json({
        ...cached,
        source: "cache",
        funnelCount: cachedFunnelCount,
        servedAt: Date.now()
      });
    }

    // Cache leeg of cache heeft 0 coins:
    // Bouw UI-data zonder Discord en zonder latestScan overwrite.
    const fresh = await buildScanPayload({
      side: "both",
      notify: false,
      store: false
    });

    const freshFunnelCount = countFunnel(fresh?.funnel);

    return res.status(200).json({
      ...fresh,
      source: cached?.ok ? "silent_scan_cache_empty" : "silent_scan_no_cache",
      previousCacheHadData: Boolean(cached?.ok),
      previousFunnelCount: cachedFunnelCount,
      funnelCount: freshFunnelCount,
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