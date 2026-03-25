// pages/logs.js
import React, { useEffect, useMemo, useState } from "react";

/**
 * Logs page (100% complete)
 * - Reads logs from /api/logs?mode=bull|bear&limit=200&level=info|warn|error&token=...
 * - Optional: /api/latest?mode=...&token=... for header context
 *
 * Expected /api/logs response:
 * {
 *   ok: true,
 *   mode: "bull"|"bear",
 *   limit: 200,
 *   items: [
 *     { ts: 1712345678901, level:"info"|"warn"|"error", event:"trade_opened", msg:"...", data:{...} }
 *   ]
 * }
 */

const DEFAULT_MODE = "bull";
const DEFAULT_LIMIT = 200;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function up(x) {
  return String(x || "").toUpperCase();
}
function fmtDate(ts) {
  const t = n(ts, 0);
  if (!t) return "-";
  return new Date(t).toLocaleString();
}
function pill(bg = "rgba(255,255,255,0.08)") {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    background: bg,
    border: "1px solid rgba(255,255,255,0.10)",
    color: "#fff",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
}
function card(extra = {}) {
  return {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: 16,
    ...extra,
  };
}
function tableStyle() {
  return { width: "100%", borderCollapse: "collapse", fontSize: 13 };
}
function thtd(isTh = false) {
  return {
    textAlign: "left",
    padding: "10px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    color: isTh ? "rgba(255,255,255,0.7)" : "#fff",
    fontWeight: isTh ? 800 : 400,
    verticalAlign: "top",
  };
}
function levelColor(level) {
  const l = String(level || "info").toLowerCase();
  if (l === "error") return "rgba(255,80,80,0.18)";
  if (l === "warn" || l === "warning") return "rgba(255,190,80,0.16)";
  return "rgba(0,200,255,0.16)";
}
function stringifySafe(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export default function LogsPage() {
  const [mode, setMode] = useState(DEFAULT_MODE);
  const [token, setToken] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [level, setLevel] = useState("all"); // all|info|warn|error
  const [query, setQuery] = useState(""); // client-side search
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [logsPayload, setLogsPayload] = useState(null);
  const [latestPayload, setLatestPayload] = useState(null);

  // init from URL
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get("token") || "";
      const m = (url.searchParams.get("mode") || "").toLowerCase();
      const l = url.searchParams.get("level") || "";
      const lim = url.searchParams.get("limit") || "";
      if (t) setToken(t);
      if (m === "bear") setMode("bear");
      if (l) setLevel(String(l).toLowerCase());
      if (lim) setLimit(Math.max(10, Math.min(2000, Number(lim) || DEFAULT_LIMIT)));
    } catch {}
  }, []);

  const logsUrl = useMemo(() => {
    const qs = [`mode=${encodeURIComponent(mode)}`, `limit=${encodeURIComponent(String(limit))}`];
    if (token) qs.push(`token=${encodeURIComponent(token)}`);
    if (level && level !== "all") qs.push(`level=${encodeURIComponent(level)}`);
    return `/api/logs?${qs.join("&")}`;
  }, [mode, token, limit, level]);

  const latestUrl = useMemo(() => {
    const qs = [`mode=${encodeURIComponent(mode)}`];
    if (token) qs.push(`token=${encodeURIComponent(token)}`);
    return `/api/latest?${qs.join("&")}`;
  }, [mode, token]);

  async function refresh() {
    setLoading(true);
    setErr("");
    try {
      const [logsRes, latRes] = await Promise.all([
        fetch(logsUrl, { headers: { accept: "application/json" } }),
        fetch(latestUrl, { headers: { accept: "application/json" } }),
      ]);

      const logsJson = await logsRes.json().catch(() => ({}));
      const latJson = await latRes.json().catch(() => ({}));

      if (!logsRes.ok) throw new Error(logsJson?.error || `logs HTTP ${logsRes.status}`);
      if (!latRes.ok) console.warn("latest fetch failed", latJson?.error || latRes.status);

      setLogsPayload(logsJson);
      setLatestPayload(latRes.ok ? latJson : null);
    } catch (e) {
      setErr(e?.message || "Failed to load logs");
      setLogsPayload(null);
      setLatestPayload(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsUrl, latestUrl]);

  const header = useMemo(() => {
    const btc = latestPayload?.btc || null;
    const regime = latestPayload?.regime || null;
    const scannedAt = latestPayload?.scannedAt || latestPayload?.ts || null;
    return { btc, regime, scannedAt };
  }, [latestPayload]);

  const items = useMemo(() => safeArr(logsPayload?.items), [logsPayload]);

  const filtered = useMemo(() => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const s =
        `${it?.event || ""} ${it?.msg || ""} ${it?.level || ""} ${it?.source || ""} ${it?.symbol || ""} ${it?.mode || ""}`.toLowerCase() +
        " " +
        stringifySafe(it?.data || {}).toLowerCase();
      return s.includes(q);
    });
  }, [items, query]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const info = filtered.filter((x) => String(x.level || "info").toLowerCase() === "info").length;
    const warn = filtered.filter((x) => ["warn", "warning"].includes(String(x.level || "").toLowerCase())).length;
    const error = filtered.filter((x) => String(x.level || "").toLowerCase() === "error").length;
    return { total, info, warn, error };
  }, [filtered]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0B0F19 0%, #05060A 70%)",
        color: "#fff",
        padding: 18,
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 950, letterSpacing: -0.2 }}>Logs</div>
            <div style={{ opacity: 0.75, marginTop: 4 }}>
              System events, decisions, and trade lifecycle for <b>{mode}</b>.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#fff",
                padding: "10px 10px",
                borderRadius: 12,
              }}
            >
              <option value="bull">bull</option>
              <option value="bear">bear</option>
            </select>

            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#fff",
                padding: "10px 10px",
                borderRadius: 12,
              }}
            >
              <option value="all">all levels</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>

            <input
              value={limit}
              onChange={(e) => setLimit(Math.max(10, Math.min(2000, Number(e.target.value) || DEFAULT_LIMIT)))}
              type="number"
              min={10}
              max={2000}
              step={10}
              style={{
                width: 110,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#fff",
                padding: "10px 10px",
                borderRadius: 12,
                outline: "none",
              }}
              title="limit"
            />

            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token (optional)"
              style={{
                width: 220,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#fff",
                padding: "10px 10px",
                borderRadius: 12,
                outline: "none",
              }}
            />

            <button
              onClick={refresh}
              disabled={loading}
              style={{
                background: "rgba(0,200,255,0.18)",
                border: "1px solid rgba(0,200,255,0.35)",
                color: "#fff",
                padding: "10px 12px",
                borderRadius: 12,
                fontWeight: 900,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? "Loading..." : "Refresh"}
            </button>

            <a
              href="/"
              style={{
                ...pill("rgba(255,255,255,0.06)"),
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              ← Home
            </a>

            <a
              href="/positions"
              style={{
                ...pill("rgba(255,255,255,0.06)"),
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              Positions →
            </a>
          </div>
        </div>

        {/* Context */}
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>Regime</span>
            <b>{header.regime ? String(header.regime) : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>BTC</span>
            <b>{header.btc?.price ? `$${Math.round(n(header.btc.price, 0))}` : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>Scanned</span>
            <b>{header.scannedAt ? fmtDate(header.scannedAt) : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>Shown</span>
            <b>{stats.total}</b>
          </span>
          <span style={pill("rgba(0,200,255,0.16)")}>
            <span style={{ opacity: 0.85 }}>info</span>
            <b>{stats.info}</b>
          </span>
          <span style={pill("rgba(255,190,80,0.16)")}>
            <span style={{ opacity: 0.85 }}>warn</span>
            <b>{stats.warn}</b>
          </span>
          <span style={pill("rgba(255,80,80,0.18)")}>
            <span style={{ opacity: 0.85 }}>error</span>
            <b>{stats.error}</b>
          </span>
        </div>

        {/* Error */}
        {err && (
          <div style={card({ marginTop: 14, borderColor: "rgba(255,0,0,0.35)", background: "rgba(255,0,0,0.10)" })}>
            <b>Error:</b> {err}
          </div>
        )}

        {/* Search */}
        <div style={{ marginTop: 14, ...card({ padding: 12 }) }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 14, fontWeight: 950 }}>Search</div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter logs (client-side)"
              style={{
                width: 420,
                maxWidth: "100%",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#fff",
                padding: "10px 10px",
                borderRadius: 12,
                outline: "none",
              }}
            />
          </div>
          <div style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>
            Tip: search “trade_opened”, “TP”, “SL”, “cooldown”, “HEADWIND”, coin symbol, etc.
          </div>
        </div>

        {/* Table */}
        <div style={{ marginTop: 14, ...card() }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 950 }}>Events</div>
            <span style={pill("rgba(255,255,255,0.08)")}>
              <span style={{ opacity: 0.85 }}>Fetched</span>
              <b>{safeArr(logsPayload?.items).length}</b>
              <span style={{ opacity: 0.85 }}>· Filtered</span>
              <b>{filtered.length}</b>
            </span>
          </div>

          <table style={tableStyle()}>
            <thead>
              <tr>
                <th style={thtd(true)}>Time</th>
                <th style={thtd(true)}>Level</th>
                <th style={thtd(true)}>Event</th>
                <th style={thtd(true)}>Message</th>
                <th style={thtd(true)}>Data</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it, idx) => {
                const lvl = String(it?.level || "info").toLowerCase();
                const ev = it?.event || it?.name || "-";
                const msg = it?.msg || it?.message || "";
                const data = it?.data ?? it?.payload ?? null;

                return (
                  <tr key={`${n(it?.ts, 0)}_${idx}`}>
                    <td style={thtd(false)}>{fmtDate(it?.ts)}</td>
                    <td style={thtd(false)}>
                      <span style={pill(levelColor(lvl))}>
                        <b>{up(lvl)}</b>
                      </span>
                    </td>
                    <td style={thtd(false)}>
                      <b>{ev}</b>
                      {it?.symbol ? (
                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                          symbol <b>{up(it.symbol)}</b>
                        </div>
                      ) : null}
                    </td>
                    <td style={thtd(false)}>{msg || <span style={{ opacity: 0.6 }}>-</span>}</td>
                    <td style={thtd(false)}>
                      {data ? (
                        <details>
                          <summary style={{ cursor: "pointer", opacity: 0.9 }}>view</summary>
                          <pre
                            style={{
                              marginTop: 8,
                              padding: 10,
                              borderRadius: 12,
                              background: "rgba(0,0,0,0.35)",
                              border: "1px solid rgba(255,255,255,0.10)",
                              overflowX: "auto",
                              fontSize: 12,
                              lineHeight: 1.35,
                            }}
                          >
                            {stringifySafe(data)}
                          </pre>
                        </details>
                      ) : (
                        <span style={{ opacity: 0.6 }}>-</span>
                      )}
                    </td>
                  </tr>
                );
              })}

              {!filtered.length && (
                <tr>
                  <td style={thtd(false)} colSpan={5}>
                    <span style={{ opacity: 0.75 }}>No logs found for current filters.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Debug */}
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", opacity: 0.85 }}>Debug</summary>
          <pre
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: 12,
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.10)",
              overflowX: "auto",
              fontSize: 12,
              lineHeight: 1.35,
            }}
          >
            {JSON.stringify({ logsPayload, latestPayload }, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}