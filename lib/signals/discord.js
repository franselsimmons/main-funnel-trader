// lib/signals/discord.js
// Discord signaling via webhook (recommended) or bot token (optional)
//
// Supports:
// - sendSignal(payload): posts rich embed + compact content
// - buildDiscordPayload(payload): transforms into Discord webhook JSON
//
// Env:
// - DISCORD_WEBHOOK_URL (required for webhook mode)
// Optional:
// - DISCORD_USERNAME (default: "Main Funnel Bot")
// - DISCORD_AVATAR_URL (optional)
// - DISCORD_MIN_LEVEL ("debug"|"info"|"warn"|"error") default: "info"
// - DISCORD_WEBHOOK_TIMEOUT_MS (default: 8000)

import { n } from "../utils/numbers.js";
import { nowIso } from "../utils/time.js";

const LEVELS = ["debug", "info", "warn", "error"];
function levelOk(level) {
  const min = String(process.env.DISCORD_MIN_LEVEL || "info").toLowerCase();
  const a = LEVELS.indexOf(min);
  const b = LEVELS.indexOf(String(level || "info").toLowerCase());
  return b >= a;
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function trim(s, max = 1900) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

function pickColor(kind) {
  const k = String(kind || "").toUpperCase();
  if (k.includes("TRADE_CLOSED") || k.includes("EXIT")) return 0xff4d4d; // red
  if (k.includes("TRADE_OPENED") || k.includes("ENTRY")) return 0x4dff88; // green
  if (k.includes("ELITE")) return 0x6f7cff; // blue-ish
  if (k.includes("WARN")) return 0xffc14d; // orange
  return 0x9aa0a6; // gray
}

function compactCoinLine(coin) {
  if (!coin) return "";
  const sym = coin.symbol ? String(coin.symbol).toUpperCase() : "?";
  const p = n(coin.price, 0);
  const ch1 = n(coin.change1h, 0);
  const ch24 = n(coin.change24, 0);
  const st = coin.stage ? String(coin.stage) : "";
  return `${sym} $${p ? p.toFixed(p < 1 ? 6 : 2) : "?"} | 1h ${ch1.toFixed(
    2
  )}% | 24h ${ch24.toFixed(2)}% | ${st}`;
}

export function buildDiscordPayload(payload) {
  const username = process.env.DISCORD_USERNAME || "Main Funnel Bot";
  const avatar_url = process.env.DISCORD_AVATAR_URL || undefined;

  const kind = String(payload?.kind || payload?.type || "signal");
  const mode = String(payload?.mode || "").toLowerCase() || "bull";
  const stage = String(payload?.stage || "").toUpperCase();
  const btcState = String(payload?.btcState || "NEUTRAL").toUpperCase();
  const reason = payload?.reason ? String(payload.reason) : "";
  const source = payload?.source ? String(payload.source) : "main";

  const coin = payload?.coin || null;
  const titleParts = [
    `[${source.toUpperCase()}]`,
    stage ? stage : kind.toUpperCase(),
    `(${mode.toUpperCase()})`,
  ];
  const title = titleParts.filter(Boolean).join(" ");

  const fields = [];

  if (coin) {
    fields.push({
      name: "Coin",
      value: trim(compactCoinLine(coin), 1024),
      inline: false,
    });

    if (coin.tradePlan) {
      const tp = coin.tradePlan;
      fields.push({
        name: "TradePlan",
        value: trim(
          `Entry: ${tp.entry}\nSL: ${tp.sl} (${tp.slPct}%)\nTP: ${tp.tp} (${tp.tpPct}%)\nRR: ${tp.rr}`,
          1024
        ),
        inline: true,
      });
    }

    const scores = [
      ["Perfect", coin.perfectCandidateScore],
      ["Quality", coin.qualityScore],
      ["Timing", coin.timingScore],
      ["Liquidity", coin.liquidityScore],
      ["Market", coin.marketScore],
      ["BTC Align", coin.btcAlignmentScore],
    ]
      .filter(([, v]) => Number.isFinite(Number(v)))
      .map(([k, v]) => `${k}: ${Number(v).toFixed(0)}`)
      .join(" | ");

    if (scores) {
      fields.push({
        name: "Scores",
        value: trim(scores, 1024),
        inline: false,
      });
    }

    if (coin.ob) {
      const ob = coin.ob;
      fields.push({
        name: "Orderbook",
        value: trim(
          `Spread: ${n(ob.spreadPct, 0).toFixed(3)}% | DepthMin1p: $${Math.round(
            n(ob.depthMinUsd1p, 0)
          )} | OB score: ${n(ob.score, 0).toFixed(5)} | fresh: ${String(
            !!ob.fresh
          )}`,
          1024
        ),
        inline: false,
      });
    }
  }

  fields.push({
    name: "Context",
    value: trim(`BTC: ${btcState}\nMode: ${mode}\nTime: ${nowIso()}`, 1024),
    inline: true,
  });

  if (reason) {
    fields.push({ name: "Reason", value: trim(reason, 1024), inline: false });
  }

  // Compact content line for quick scanning in notifications
  const content = trim(
    `${title} • BTC:${btcState}${coin?.symbol ? ` • ${coin.symbol}` : ""}${
      reason ? ` • ${reason}` : ""
    }`,
    1900
  );

  return {
    username,
    avatar_url,
    content,
    embeds: [
      {
        title,
        color: pickColor(kind),
        fields,
        footer: { text: "Main Funnel" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function sendSignal(payload, { level = "info" } = {}) {
  if (!levelOk(level)) return { ok: true, skipped: true, reason: "min_level" };

  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn("[discord] DISCORD_WEBHOOK_URL missing; signal skipped");
    return { ok: false, skipped: true, reason: "missing_webhook" };
  }

  const timeoutMs = n(process.env.DISCORD_WEBHOOK_TIMEOUT_MS, 8000);
  const body = buildDiscordPayload(payload);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: safeJson(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("[discord] webhook failed", res.status, trim(txt, 500));
      return { ok: false, status: res.status, error: trim(txt, 500) };
    }
    return { ok: true };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    console.error("[discord] sendSignal error:", msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(id);
  }
}