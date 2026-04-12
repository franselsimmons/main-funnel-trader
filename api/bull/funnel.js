import { kv } from "@vercel/kv"

export default async function handler(req, res) {

  const signals = await kv.get("bull:engine:signals") || []

  const approved = signals.slice(0, 3)

  await kv.set("bull:approved", approved)

  res.json({ ok: true, approved: approved.length })
}