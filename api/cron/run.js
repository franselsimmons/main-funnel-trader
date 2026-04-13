import { runBullScanner } from "../../scanner/scannerBull.js"
import { runBearScanner } from "../../scanner/scannerBear.js"
import { runBullFunnel } from "../../funnel/funnelBull.js"
import { runBearFunnel } from "../../funnel/funnelBear.js"
import { runBullEngine } from "../../engine/engineBull.js"
import { runBearEngine } from "../../engine/engineBear.js"
import { fetchUniverse } from "../../scanner/universeFetcher.js"

export default async function handler(req, res) {

  const universe = await fetchUniverse()

  await runBullScanner(universe)
  await runBearScanner(universe)

  await runBullFunnel()
  await runBearFunnel()

  await runBullEngine()
  await runBearEngine()

  res.json({ ok: true })
}