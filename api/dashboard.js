import { kv } from "@vercel/kv"

export default async function handler(req, res) {
  const bull = await kv.get("bull:scanner:candidates") || []
  const bear = await kv.get("bear:scanner:candidates") || []

  res.json({
    bull: {
      count: bull.length,
      coins: bull.slice(0, 50)
    },
    bear: {
      count: bear.length,
      coins: bear.slice(0, 50)
    }
  })
}