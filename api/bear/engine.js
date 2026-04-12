import { getKey, setKey } from "../../storage/kv.js"
import { funnelKey } from "../../storage/stateManager.js"
import { runBearEngine } from "../../engine/engineBear.js"

export default async function handler(req, res) {

  const funnelOutput = await getKey(funnelKey("bear")) || { approved: [] }
  const openPositions = await getKey("portfolio:bear") || []

  const marketLiveData = {}

  const result = runBearEngine({
    funnelOutput,
    openPositions,
    marketLiveData
  })

  await setKey("portfolio:bear", [
    ...result.updatedPositions,
    ...result.newPositions
  ])

  res.json(result)
}