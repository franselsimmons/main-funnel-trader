export default async function handler(req, res) {

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.VERCEL_URL

  const url = base.startsWith("http")
    ? base
    : `https://${base}`

  await fetch(`${url}/api/bull/scanner`)
  await fetch(`${url}/api/bear/scanner`)

  res.json({ ok: true })
}