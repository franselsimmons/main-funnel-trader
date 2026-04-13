import { runBullScanner } from "../../scanner/scannerBull.js"
import { fetchUniverse } from "../../scanner/universeFetcher.js"

export default async function handler(req, res) {
  const universe = await fetchUniverse()
  const result = await runBullScanner(universe)

  res.json({
    ok: true,
    count: result.length
  })
}