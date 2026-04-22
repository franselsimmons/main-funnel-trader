import { getLatestScan } from "../lib/scanStore.js";

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

    // BELANGRIJK:
    // Hier GEEN buildScanPayload() meer.
    // De site mag nooit scanner triggeren, anders krijg je Discord pas bij openen.
    return res.status(200).json({
      ok: false,
      source: "cache",
      error: "no_cached_scan",
      message: "Geen scan in runtime memory. Wacht op cron of trigger /api/cron?side=bull en /api/cron?side=bear handmatig.",
      servedAt: Date.now()
    });

  }catch(err){

    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      source: "cache",
      error: err?.message || "public_latest_failed",
      servedAt: Date.now()
    });
  }
}