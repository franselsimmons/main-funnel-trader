export default async function handler(req, res) {
  try {
    const base =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000"

    await fetch(base + "/api/bull/funnel")
    await fetch(base + "/api/bear/funnel")

    return res.json({ ok: true, job: "funnel" })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}