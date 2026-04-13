import { kv } from "@vercel/kv"
import {
  checkExposure,
  applyKelly,
  correlationBlock
} from "./funnelCore.js"

export async function runBullFunnel() {
  const candidates =
    (await kv.get("edge:candidates")) || []

  const portfolio =
    (await kv.get("state:bull")) || []

  const approved = []

  for (const candidate of candidates) {

    const exposureOK =
      checkExposure(portfolio)

    const correlationOK =
      correlationBlock(portfolio, candidate.symbol)

    if (!exposureOK || !correlationOK)
      continue

    const rr = 2
    const size =
      applyKelly(candidate.probability, rr)

    if (size <= 0) continue

    approved.push({
      ...candidate,
      positionSize: size
    })
  }

  await kv.set("trade:approved", approved)

  return approved
}