import { kv } from "@vercel/kv"

export default async function handler(req, res) {

  const scanner = await kv.get("bear:scanner:candidates") || []

  const signals = scanner
    .filter(c => c.change24h < -1.5)
    .slice(0, 10)

  await kv.set("bear:engine:signals", signals)

  res.json({ ok: true, signals: signals.length })
}