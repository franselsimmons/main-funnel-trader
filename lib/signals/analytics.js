// lib/analytics.js
// Minimal analytics layer with pluggable sinks.
//
// Exports:
// - pushEvent(name, payload, opts)
// - uid(prefix)
// - safePushEvent(name, payload, opts)
//
// Env (optional):
// - ANALYTICS_SINK = "console" | "webhook" (default: console)
// - ANALYTICS_WEBHOOK_URL (required if sink=webhook)
// - ANALYTICS_TIMEOUT_MS (default: 8000)
// - ANALYTICS_MIN_LEVEL ("debug"|"info"|"warn"|"error") default: "info"
//
// Notes:
// - Designed to be safe in serverless environments (no background flushing).

import { n } from "./utils/numbers.js";
import { nowIso } from "./utils/time.js";

const LEVELS = ["debug", "info", "warn", "error"];
function levelOk(level) {
  const min = String(process.env.ANALYTICS_MIN_LEVEL || "info").toLowerCase();
  const a = LEVELS.indexOf(min);
  const b = LEVELS.indexOf(String(level || "info").toLowerCase());
  return b >= a;
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ error: "json_stringify_failed" });
  }
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function sendWebhookEvent(name, payload, { level = "info" } = {}) {
  const url = process.env.ANALYTICS_WEBHOOK_URL;
  if (!url) return { ok: false, error: "ANALYTICS_WEBHOOK_URL missing" };

  const timeoutMs = n(process.env.ANALYTICS_TIMEOUT_MS, 8000);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    name,
    level,
    ts: Date.now(),
    iso: nowIso(),
    payload: payload ?? null,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: safeJson(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: txt?.slice(0, 500) || "" };
    }
    return { ok: true };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(id);
  }
}

export async function pushEvent(name, payload, { level = "info" } = {}) {
  if (!levelOk(level)) return { ok: true, skipped: true, reason: "min_level" };

  const sink = String(process.env.ANALYTICS_SINK || "console").toLowerCase();

  if (sink === "webhook") {
    return await sendWebhookEvent(name, payload, { level });
  }

  // default: console sink
  const line = {
    name,
    level,
    ts: Date.now(),
    iso: nowIso(),
    payload: payload ?? null,
  };
  // eslint-disable-next-line no-console
  console.log("[analytics]", safeJson(line));
  return { ok: true };
}

export async function safePushEvent(name, payload, opts) {
  try {
    return await pushEvent(name, payload, opts);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[analytics] pushEvent failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}