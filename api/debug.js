import { kv } from "@vercel/kv"

export default async function handler(req, res) {
  const bull = await kv.get("bull:scanner:candidates")
  const bear = await kv.get("bear:scanner:candidates")

  res.json({
    bullCount: bull ? bull.length : 0,
    bearCount: bear ? bear.length : 0,
    sample: bull ? bull.slice(0, 3) : []
  })
}