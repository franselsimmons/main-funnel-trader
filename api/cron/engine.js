let lastRun = 0

export default async function handler(req, res) {

  const now = Date.now()

  if (now - lastRun < 15000) {
    return res.json({ skipped: true })
  }

  lastRun = now

  await fetch(process.env.BASE_URL + "/api/bull/engine")
  await fetch(process.env.BASE_URL + "/api/bear/engine")

  res.json({ ok: true })
}