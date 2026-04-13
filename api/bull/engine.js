import { kv } from "@vercel/kv"

function scoreMomentum(c) {
  let s = 0
  if (c.change24h > 2) s++
  if (c.change24h > 5) s++
  if (c.change24h > 8) s++
  return s
}

function scoreVolume(c) {
  let s = 0
  if (c.volume > 5000000) s++
  if (c.volume > 15000000) s++
  if (c.volume > 30000000) s++
  return s
}

function scoreStructure(c) {
  let s = 0
  if (Math.abs(c.change24h) > 3) s++
  if (Math.abs(c.change24h) > 6) s++
  return s
}

export default async function handler(req, res) {

  const universe = await kv.get("bull:universe") || []

  const qualified = universe
    .map(c => {
      const momentumScore = scoreMomentum(c)
      const volumeScore = scoreVolume(c)
      const structureScore = scoreStructure(c)

      return {
        ...c,
        momentumScore,
        volumeScore,
        structureScore
      }
    })
    .filter(c =>
      c.momentumScore >= 2 &&
      c.volumeScore >= 2 &&
      c.structureScore >= 2
    )

  await kv.set("bull:qualified", qualified)

  res.json({
    ok: true,
    qualified: qualified.length
  })
}