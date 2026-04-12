import { kv } from "@vercel/kv"

export default async function handler(req, res) {
  const bullCoins = await kv.get("bull:scanner:candidates") || []
  const bearCoins = await kv.get("bear:scanner:candidates") || []

  const bullLast = await kv.get("bull:scanner:lastScan")
  const bearLast = await kv.get("bear:scanner:lastScan")

  res.json({
    bull: {
      coins: bullCoins.slice(0, 50),
      count: bullCoins.length,
      lastScan: bullLast
    },
    bear: {
      coins: bearCoins.slice(0, 50),
      count: bearCoins.length,
      lastScan: bearLast
    }
  })
}