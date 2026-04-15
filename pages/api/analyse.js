import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const mode = req.query.mode || "bull";

  const flow = (await kv.get(`flow:${mode}`)) || {};
  const state = (await kv.get(`state:${mode}`)) || {};

  res.json({
    ok: true,
    flow,
    entry: state?.funnel?.entry_ready?.length || 0,
  });
}