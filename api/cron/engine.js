export default async function handler(req, res) {
  try {
    const protocol = req.headers["x-forwarded-proto"] || "https"
    const host = req.headers.host
    const base = `${protocol}://${host}`

    await fetch(base + "/api/bull/engine")
    await fetch(base + "/api/bear/engine")

    return res.json({ ok: true, job: "engine" })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}