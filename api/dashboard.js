import { kv } from "@vercel/kv"

export default async function handler(req, res) {

  const bullScanner = await kv.get("bull:scanner:candidates") || []
  const bearScanner = await kv.get("bear:scanner:candidates") || []

  const bullApproved = await kv.get("bull:approved") || []
  const bearApproved = await kv.get("bear:approved") || []

  const bullLastScan = await kv.get("bull:scanner:lastScan")
  const bearLastScan = await kv.get("bear:scanner:lastScan")

  res.json({
    bull: {
      scanner: bullScanner,
      approved: bullApproved.length,
      lastScan: bullLastScan
    },
    bear: {
      scanner: bearScanner,
      approved: bearApproved.length,
      lastScan: bearLastScan
    }
  })
}