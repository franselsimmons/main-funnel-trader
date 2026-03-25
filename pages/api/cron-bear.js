// pages/api/cron-bear.js
import mainScan from "./main/scan.js";
import { requireSecret } from "../../lib/core/settings.js";

/**
 * Vercel Cron endpoint for MAIN (bear).
 *
 * Security:
 * - Accepts ?token=... or Authorization: Bearer ...
 * - Token must match CRON_SECRET (or API_SECRET if you reuse that)
 *
 * Usage (Vercel Cron):
 * - Call: /api/cron-bear?token=YOUR_CRON_SECRET
 */
export const config = {
  maxDuration: 60,
};

export default async function cronBear(req, res) {
  // optional extra hardening: block non-cron calls unless token matches
  if (!requireSecret(req, res)) return;

  // Force bear mode, forward token so downstream remains protected.
  req.query = {
    ...req.query,
    mode: "bear",
    token: req.query?.token, // keep the same token
  };

  return mainScan(req, res);
}