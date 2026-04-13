import { runBullEngine } from "../../engine/engineBull.js"

export default async function handler(req, res) {
  const result = await runBullEngine()

  res.json({
    ok: true,
    positions: result.length
  })
}