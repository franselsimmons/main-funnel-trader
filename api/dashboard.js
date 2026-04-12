import { kv } from "@vercel/kv"

export default async function handler(req, res) {
  try {

    const bullScanner = await kv.get("bull:scanner:candidates")
    const bearScanner = await kv.get("bear:scanner:candidates")

    const bullLastScan = await kv.get("bull:scanner:lastScan")
    const bearLastScan = await kv.get("bear:scanner:lastScan")

    return res.json({
      bull: {
        scanner: bullScanner || [],
        approved: 0,
        lastScan: bullLastScan || null
      },
      bear: {
        scanner: bearScanner || [],
        approved: 0,
        lastScan: bearLastScan || null
      }
    })

  } catch (e) {
    console.error("Dashboard error:", e)
    return res.status(500).json({ error: e.message })
  }
}