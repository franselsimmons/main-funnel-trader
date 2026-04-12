import { getKey, setKey } from "../../storage/kv.js"
import { scannerKey, funnelKey } from "../../storage/stateManager.js"
import { runBullFunnel } from "../../funnel/funnelBull.js"

export default async function handler(req, res) {

  const scannerOutput = await getKey(scannerKey("bull")) || { candidates: [] }
  const openPositions = await getKey("portfolio:bull") || []

  const result = runBullFunnel({
    scannerOutput,
    openPositions,
    portfolioState: {}
  })

  await setKey(funnelKey("bull"), result)

  res.json(result)
}