import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const mode = req.query.mode === "bear" ? "bear" : "bull";

  const state = await kv.get(`state:${mode}`);

  res.json({
    funnel: state?.funnel || {
      entry_ready: [],
      setup: [],
      warmup: [],
      radar: []
    }
  });
}