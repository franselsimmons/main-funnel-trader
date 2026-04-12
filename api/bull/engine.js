import { getKey, setKey } from "../../storage/kv.js"
import { funnelKey } from "../../storage/stateManager.js"
import { runBullEngine } from "../../engine/engineBull.js"

export default async function handler(req, res) {

  const funnelOutput = await getKey(funnelKey("bull")) || { approved: [] }
  const openPositions = await getKey("portfolio:bull") || []

  const marketLiveData = {} // replace with websocket later

  const result = runBullEngine({
    funnelOutput,
    openPositions,
    marketLiveData
  })

  await setKey("portfolio:bull", [
    ...result.updatedPositions,
    ...result.newPositions
  ])

  res.json(result)
}