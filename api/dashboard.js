import { kv } from "@vercel/kv"

export default async function handler(req, res) {

  const bullApproved = await kv.get("bull:approved") || []
  const bearApproved = await kv.get("bear:approved") || []

  res.json({
    bull: {
      approved: bullApproved
    },
    bear: {
      approved: bearApproved
    }
  })
}