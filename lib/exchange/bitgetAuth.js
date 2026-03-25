// exchange/bitgetAuth.js
// Bitget API auth + request signing helpers (v2 endpoints)
//
// ✅ Supports:
// - signBitget({ method, path, query, body, timestamp, apiKey, apiSecret, passphrase })
// - buildBitgetHeaders(...)
// - bitgetFetch({ method, path, query, body, auth, baseUrl, timeoutMs })
//
// Env (recommended usage elsewhere):
// - BITGET_API_KEY
// - BITGET_API_SECRET
// - BITGET_API_PASSPHRASE
// - BITGET_BASE_URL (default: https://api.bitget.com)
// - BITGET_TIMEOUT_MS (default: 8000)
//
// Notes:
// - Bitget signature generally uses: base64(hmac_sha256(secret, prehash))
// - prehash = timestamp + method + requestPath + bodyString
// - requestPath includes querystring (e.g. /api/v2/spot/trade/place-order?foo=bar)
// - timestamp expected in milliseconds as string (most common in Bitget examples).
//
// This module is safe for Node 18+ (Next.js / Vercel). Uses crypto.webcrypto.

import { n } from "../lib/utils/numbers.js";

/** @returns {string} */
export function nowMsString() {
  return String(Date.now());
}

/** stable querystring builder */
export function toQueryString(query) {
  if (!query) return "";
  const entries = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [String(k), String(v)]);

  if (!entries.length) return "";

  // Sort keys to ensure deterministic signature
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

/** @returns {Promise<string>} base64(hmac_sha256(secret, message)) */
async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  // base64 encode
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function safeJsonStringify(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    // If stringify fails, fallback to empty body to avoid crashing
    return "";
  }
}

/**
 * Build signature and return headers
 * @param {object} args
 * @param {"GET"|"POST"|"PUT"|"DELETE"} args.method
 * @param {string} args.path - e.g. "/api/v2/spot/trade/place-order"
 * @param {object} [args.query]
 * @param {object|string} [args.body]
 * @param {string} [args.timestamp] - ms string; if omitted uses Date.now()
 * @param {string} args.apiKey
 * @param {string} args.apiSecret
 * @param {string} args.passphrase
 */
export async function signBitget({
  method,
  path,
  query,
  body,
  timestamp,
  apiKey,
  apiSecret,
  passphrase,
}) {
  const m = String(method || "GET").toUpperCase();
  const ts = String(timestamp || nowMsString());
  const qs = toQueryString(query);
  const requestPath = `${path}${qs}`;

  // For GET typically body is empty string
  const bodyStr = m === "GET" ? "" : safeJsonStringify(body);
  const prehash = `${ts}${m}${requestPath}${bodyStr}`;

  const sign = await hmacSha256Base64(apiSecret, prehash);

  // Common Bitget headers
  const headers = {
    "Content-Type": "application/json",
    "ACCESS-KEY": apiKey,
    "ACCESS-SIGN": sign,
    "ACCESS-TIMESTAMP": ts,
    "ACCESS-PASSPHRASE": passphrase,
    // Some setups also include locale:
    "locale": "en-US",
  };

  return { headers, requestPath, bodyStr, timestamp: ts, sign, prehash };
}

/**
 * Convenience: build headers from env or passed auth
 */
export async function buildBitgetHeaders({
  method,
  path,
  query,
  body,
  timestamp,
  auth,
}) {
  const apiKey = auth?.apiKey || process.env.BITGET_API_KEY || "";
  const apiSecret = auth?.apiSecret || process.env.BITGET_API_SECRET || "";
  const passphrase = auth?.passphrase || process.env.BITGET_API_PASSPHRASE || "";

  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error("Missing Bitget credentials (apiKey/apiSecret/passphrase)");
  }

  return await signBitget({
    method,
    path,
    query,
    body,
    timestamp,
    apiKey,
    apiSecret,
    passphrase,
  });
}

/**
 * Fetch helper with signing + timeout.
 * Returns parsed JSON and includes status + raw text for debugging.
 */
export async function bitgetFetch({
  method = "GET",
  path,
  query,
  body,
  auth,
  baseUrl,
  timeoutMs,
}) {
  const BASE = baseUrl || process.env.BITGET_BASE_URL || "https://api.bitget.com";
  const tms = n(timeoutMs, n(process.env.BITGET_TIMEOUT_MS, 8000));

  if (!path || !path.startsWith("/")) {
    throw new Error(`bitgetFetch: path must start with "/" (got: ${path})`);
  }

  const { headers, requestPath, bodyStr } = await buildBitgetHeaders({
    method,
    path,
    query,
    body,
    auth,
  });

  const url = `${BASE}${requestPath}`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), tms);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : bodyStr,
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      ok: res.ok,
      status: res.status,
      url,
      json,
      text,
    };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    return {
      ok: false,
      status: 0,
      url,
      json: null,
      text: msg,
      error: msg,
    };
  } finally {
    clearTimeout(id);
  }
}