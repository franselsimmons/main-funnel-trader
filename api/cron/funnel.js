import { runBullFunnel } from "../../funnel/funnelBull.js"

export default async function handler(req, res) {
  const result = await runBullFunnel()

  res.json({
    ok: true,
    approved: result.length
  })
}