export default async function handler(req, res) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL

  await fetch(`${base}/api/bull/funnel`)
  await fetch(`${base}/api/bear/funnel`)

  res.json({ ok: true, job: "funnel" })
}