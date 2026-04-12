import { getKey } from "../storage/kv.js"
import { runAnalyse } from "../analytics/analyseCore.js"

export default async function handler(req, res) {

  const trades =
    await getKey("analytics:tradeHistory") || []

  const result = runAnalyse(trades)

  res.json(result)
}