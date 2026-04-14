import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function isAuthorized(req) {
  const token = process.env.CRON_SECRET;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const bull = (await kv.get("open:bull")) || [];
    const bear = (await kv.get("open:bear")) || [];

    // combine + normalize
    const positions = [
      ...bull.map((p) => ({ ...p, mode: "bull" })),
      ...bear.map((p) => ({ ...p, mode: "bear" })),
    ];

    return res.json({
      ok: true,
      positions,
      count: positions.length,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}