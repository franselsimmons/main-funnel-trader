import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const cached = getLatestScan();

    if(cached && cached.ok){
      return res.status(200).json({
        ...cached,
        source: "cache",
        servedAt: Date.now()
      });
    }

    // Cache leeg door Vercel cold start.
    // Dan wel data bouwen voor UI, maar:
    // - GEEN Discord
    // - GEEN latestScan overschrijven
    const fresh = await buildScanPayload({
      side: "both",
      notify: false,
      store: false
    });

    return res.status(200).json({
      ...fresh,
      source: "silent_scan",
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