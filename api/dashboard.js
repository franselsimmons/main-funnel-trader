import { kv } from "@vercel/kv"
import { calculateExpectancy } from "../analytics/stats.js"
import { monteCarlo } from "../analytics/buckets.js"

export default async function handler(req, res) {

  const bullPortfolio =
    await kv.get("state:bull") || []

  const bearPortfolio =
    await kv.get("state:bear") || []

  const bullCandidates =
    await kv.get("edge:candidates:bull") || []

  const bearCandidates =
    await kv.get("edge:candidates:bear") || []

  const approvedBull =
    await kv.get("trade:approved:bull") || []

  const approvedBear =
    await kv.get("trade:approved:bear") || []

  const closedTrades =
    await kv.get("state:closed") || []

  const expectancy =
    calculateExpectancy(closedTrades)

  const monte =
    monteCarlo(closedTrades)

  const totalExposure =
    [...bullPortfolio, ...bearPortfolio]
      .reduce((a, b) => a + b.size, 0)

  res.json({
    regime: "LIVE",
    scanner: {
      bull: bullCandidates.length,
      bear: bearCandidates.length
    },
    funnel: {
      bull: approvedBull.length,
      bear: approvedBear.length
    },
    portfolio: {
      bullOpen: bullPortfolio.length,
      bearOpen: bearPortfolio.length,
      exposure: totalExposure
    },
    edge: {
      expectancy
    },
    monte,
    lastScan:
      bullCandidates[0]?.timestamp || null
  })
}