import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const state = (await kv.get(`state:${mode}`)) || {};
  const auto = (await kv.get(`scan:auto:${mode}`)) || {};
  const account = (await kv.get("account:global")) || {};

  res.setHeader("cache-control", "no-store");

  res.json({
    ok: true,
    mode,
    lastScan: auto?.lastRun || state?.ts || 0,
    nextScan: auto?.nextDue || 0,
    account,
    state,
  });
}