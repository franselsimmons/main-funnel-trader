export default async function handler(req, res) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL

  await fetch(`${base}/api/bull/scanner`)
  await fetch(`${base}/api/bear/scanner`)

  res.json({ ok: true, job: "scanner" })
}