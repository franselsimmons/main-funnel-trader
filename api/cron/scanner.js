export default async function handler(req, res) {
  try {
    const base =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : process.env.NEXT_PUBLIC_BASE_URL

    await fetch(`${base}/api/bull/scanner`)
    await fetch(`${base}/api/bear/scanner`)

    return res.json({ ok: true, job: "scanner" })

  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}