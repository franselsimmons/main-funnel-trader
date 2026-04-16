import { getLatestScan } from "../lib/scanStore.js";
import scanner from "./scanner.js";

export default async function handler(req, res) {
  try {
    const latest = getLatestScan();

    if (latest) {
      return res.status(200).json(latest);
    }

    return scanner(req, res);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "public_latest_failed"
    });
  }
}