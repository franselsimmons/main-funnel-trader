import { getLatestScan } from "../lib/scanStore.js";
import { buildScanPayload } from "./scanner.js";

export default async function handler(req, res) {
  try {

    const cached = getLatestScan();

    if (cached && cached.ok) {
      return res.status(200).json(cached);
    }

    console.log("NO CACHE → RUN SCANNER");

    const fresh = await buildScanPayload();

    return res.status(200).json(fresh);

  } catch (err) {

    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}