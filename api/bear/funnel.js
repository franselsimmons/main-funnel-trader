import { getKey, setKey } from "../../storage/kv.js"
import { scannerKey, funnelKey } from "../../storage/stateManager.js"
import { runBearFunnel } from "../../funnel/funnelBear.js"

export default async function handler(req, res) {

  const scannerOutput = await getKey(scannerKey("bear")) || { candidates: [] }
  const openPositions = await getKey("portfolio:bear") || []

  const result = runBearFunnel({
    scannerOutput,
    openPositions,
    portfolioState: {}
  })

  await setKey(funnelKey("bear"), result)

  res.json(result)
}