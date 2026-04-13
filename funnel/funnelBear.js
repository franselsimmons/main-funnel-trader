import { kv } from "@vercel/kv"
import {
  checkExposure,
  applyKelly
} from "./funnelCore.js"

export async function runBearFunnel() {
  const candidates =
    await kv.get("edge:candidates:bear") || []

  const portfolio =
    await kv.get("state:bear") || []

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

  await kv.set("trade:approved:bear", approved)
  return approved
}