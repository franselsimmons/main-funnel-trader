import { getLatestScan } from "../lib/scanStore.js";
import scanner from "./scanner.js";

export default async function handler(req, res) {
  try {
    const cached = getLatestScan();

    // ✅ ALS WE DATA HEBBEN → RETURN
    if (cached) {
      return res.status(200).json(cached);
    }

    // 🔥 GEEN DATA → FORCE SCAN
    console.log("NO CACHE → RUN SCANNER");

    let resultData = null;

    const fakeRes = {
      status(code) {
        return {
          json(data) {
            resultData = data;
          }
        };
      }
    };

    await scanner(req, fakeRes);

    if (!resultData) {
      throw new Error("Scanner returned empty");
    }

    return res.status(200).json(resultData);

  } catch (err) {
    console.error("PUBLIC-LATEST ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}