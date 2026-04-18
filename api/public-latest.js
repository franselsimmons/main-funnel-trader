import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

export default async function handler(req, res) {
  try {
    const cached = getLatestScan();

    // ✅ CACHE BESTAAT → DIRECT RETURN
    if (cached && cached.ok) {
      return res.status(200).json(cached);
    }

    // 🔥 GEEN CACHE → NIEUWE SCAN
    console.log("NO CACHE → RUN SCANNER");

    const fresh = await buildScanPayload();

    if (!fresh || !fresh.ok) {
      throw new Error("Scanner returned invalid data");
    }

    return res.status(200).json(fresh);

  } catch (err) {
    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}