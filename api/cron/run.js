export default async function handler(req, res) {

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    `https://${process.env.VERCEL_URL}`

  // 1️⃣ Scanner
  await fetch(`${base}/api/bull/scanner`)
  await fetch(`${base}/api/bear/scanner`)

  // 2️⃣ Engine
  await fetch(`${base}/api/bull/engine`)
  await fetch(`${base}/api/bear/engine`)

  // 3️⃣ Funnel
  await fetch(`${base}/api/bull/funnel`)
  await fetch(`${base}/api/bear/funnel`)

  res.json({ ok: true })
}