export default async function handler(req, res) {
  try {
    const base =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000"

    await fetch(base + "/api/bull/scanner")
    await fetch(base + "/api/bear/scanner")

    return res.json({ ok: true, job: "scanner" })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}