import { kv } from "@vercel/kv"
import {
  checkExposure,
  applyKelly
} from "./funnelCore.js"

export async function runBullFunnel() {
  const candidates =
    await kv.get("edge:candidates:bull") || []

  const portfolio =
    await kv.get("state:bull") || []

  const approved = []

  for (const c of candidates) {
    if (!checkExposure(portfolio)) continue

    const rr = 2
    const size =
      applyKelly(c.probability, rr)

    if (size <= 0) continue

    approved.push({
      ...c,
      positionSize: size
    })
  }

  await kv.set("trade:approved:bull", approved)
  return approved
}