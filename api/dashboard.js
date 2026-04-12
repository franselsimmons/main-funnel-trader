import { kv } from "@vercel/kv"

export default async function handler(req, res) {
  try {
    const bull = await kv.get("bull:scanner:candidates") || []
    const bear = await kv.get("bear:scanner:candidates") || []

    const bullApproved = await kv.get("bull:funnel:approved") || []
    const bearApproved = await kv.get("bear:funnel:approved") || []

    const bullOpen = await kv.get("bull:positions:open") || []
    const bearOpen = await kv.get("bear:positions:open") || []

    res.json({
      bull: {
        scanner: bull.length,
        approved: bullApproved.length,
        open: bullOpen.length
      },
      bear: {
        scanner: bear.length,
        approved: bearApproved.length,
        open: bearOpen.length
      }
    })

  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}