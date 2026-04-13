import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const mode = req.query.mode === "bear" ? "bear" : "bull";
  const data = await kv.get(`funnel:${mode}`);

  res.json(data || {
    funnel: { radar: [], warmup: [], setup: [], entry_ready: [] }
  });
}