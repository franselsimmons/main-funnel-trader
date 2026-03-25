// pages/positions.js
import React, { useEffect, useMemo, useState } from "react";

/**
 * Positions page (100% complete)
 * - Reads positions from /api/positions?mode=bull|bear&token=...
 * - Also reads latest snapshot from /api/latest?mode=...&token=... (optional) to show BTC/regime header
 * - Shows OPEN + CLOSED positions with sorting, summary, and quick links
 *
 * Expected API shapes:
 * 1) /api/positions:
 *    {
 *      ok: true,
 *      mode: "bull"|"bear",
 *      positions: { open: [...], closed: [...] },
 *      portfolio: {...} // optional
 *    }
 *
 * 2) /api/latest:
 *    { ok: true, mode, regime, btc:{...}, positions:{open,closed}, portfolio:{...}, ... }
 */

const DEFAULT_MODE = "bull";

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
function fmtNum(x, digits = 2) {
  return n(x, 0).toFixed(digits);
}
function fmtPct(x, digits = 2) {
  return `${n(x, 0).toFixed(digits)}%`;
}
function fmtUsd(x, digits = 2) {
  return `$${n(x, 0).toFixed(digits)}`;
}
function fmtInt(x) {
  return Intl.NumberFormat().format(Math.round(n(x, 0)));
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
function pnlColor(pnlPct) {
  const v = n(pnlPct, 0);
  if (v > 0.01) return "rgba(0,255,160,0.20)";
  if (v < -0.01) return "rgba(255,80,80,0.18)";
  return "rgba(255,255,255,0.08)";
}

function sortOpen(a, b) {
  // by pnlPct desc, then entryAt desc
  return n(b.pnlPct, 0) - n(a.pnlPct, 0) || n(b.entryAt, 0) - n(a.entryAt, 0);
}
function sortClosed(a, b) {
  // by closedAt desc
  return n(b.closedAt, 0) - n(a.closedAt, 0);
}

function calcRRFromSlTp(entry, sl, tp, mode) {
  const e = n(entry, 0);
  const s = n(sl, 0);
  const t = n(tp, 0);
  if (!(e > 0 && s > 0 && t > 0)) return 0;
  if (mode === "bear") {
    // short: risk = sl - entry, reward = entry - tp
    const risk = Math.max(1e-9, s - e);
    const reward = Math.max(0, e - t);
    return reward / risk;
  }
  // long: risk = entry - sl, reward = tp - entry
  const risk = Math.max(1e-9, e - s);
  const reward = Math.max(0, t - e);
  return reward / risk;
}

export default function PositionsPage() {
  const [mode, setMode] = useState(DEFAULT_MODE);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [positionsPayload, setPositionsPayload] = useState(null);
  const [latestPayload, setLatestPayload] = useState(null);

  // init token/mode from URL
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get("token") || "";
      const m = (url.searchParams.get("mode") || "").toLowerCase();
      if (t) setToken(t);
      if (m === "bear") setMode("bear");
    } catch {}
  }, []);

  const positionsUrl = useMemo(() => {
    const qs = [`mode=${encodeURIComponent(mode)}`];
    if (token) qs.push(`token=${encodeURIComponent(token)}`);
    return `/api/positions?${qs.join("&")}`;
  }, [mode, token]);

  const latestUrl = useMemo(() => {
    const qs = [`mode=${encodeURIComponent(mode)}`];
    if (token) qs.push(`token=${encodeURIComponent(token)}`);
    return `/api/latest?${qs.join("&")}`;
  }, [mode, token]);

  async function refresh() {
    setLoading(true);
    setErr("");
    try {
      const [posRes, latRes] = await Promise.all([
        fetch(positionsUrl, { headers: { accept: "application/json" } }),
        fetch(latestUrl, { headers: { accept: "application/json" } }),
      ]);

      const posJson = await posRes.json().catch(() => ({}));
      const latJson = await latRes.json().catch(() => ({}));

      if (!posRes.ok) throw new Error(posJson?.error || `positions HTTP ${posRes.status}`);
      if (!latRes.ok) {
        // latest is optional; do not fail page
        console.warn("latest fetch failed", latJson?.error || latRes.status);
      }

      setPositionsPayload(posJson);
      setLatestPayload(latRes.ok ? latJson : null);
    } catch (e) {
      setErr(e?.message || "Failed to load");
      setPositionsPayload(null);
      setLatestPayload(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsUrl, latestUrl]);

  const open = useMemo(() => safeArr(positionsPayload?.positions?.open).slice().sort(sortOpen), [positionsPayload]);
  const closed = useMemo(() => safeArr(positionsPayload?.positions?.closed).slice().sort(sortClosed), [positionsPayload]);

  const summary = useMemo(() => {
    const openCount = open.length;
    const closedCount = closed.length;
    const openPnlUsd = open.reduce((a, p) => a + n(p.pnlUsd, 0), 0);
    const openPnlPctAvg = openCount ? open.reduce((a, p) => a + n(p.pnlPct, 0), 0) / openCount : 0;

    const realizedUsd =
      positionsPayload?.portfolio?.realizedUsd ??
      closed.reduce((a, p) => a + n(p.pnlUsd, 0), 0);

    const avgRealizedPct =
      positionsPayload?.portfolio?.avgRealizedPct ??
      (closedCount ? closed.reduce((a, p) => a + n(p.pnlPct, 0), 0) / closedCount : 0);

    return {
      openCount,
      closedCount,
      openPnlUsd,
      openPnlPctAvg,
      realizedUsd,
      avgRealizedPct,
    };
  }, [open, closed, positionsPayload]);

  const header = useMemo(() => {
    const btc = latestPayload?.btc || null;
    const regime = latestPayload?.regime || null;
    return { btc, regime };
  }, [latestPayload]);

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
            <div style={{ fontSize: 22, fontWeight: 950, letterSpacing: -0.2 }}>Positions</div>
            <div style={{ opacity: 0.75, marginTop: 4 }}>
              Open + closed trades for <b>{mode}</b> mode.
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

            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token (optional)"
              style={{
                width: 260,
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
              href="/analyze"
              style={{
                ...pill("rgba(255,255,255,0.06)"),
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              Analyze →
            </a>
          </div>
        </div>

        {/* Regime / BTC */}
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>Regime</span>
            <b>{header.regime ? String(header.regime) : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>BTC</span>
            <b>{header.btc?.price ? fmtUsd(header.btc.price, 0) : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>BTC 24h</span>
            <b>{header.btc ? fmtPct(header.btc.chg24, 2) : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>BTC range24</span>
            <b>{header.btc ? fmtPct(header.btc.range24, 2) : "-"}</b>
          </span>
          <span style={pill("rgba(255,255,255,0.08)")}>
            <span style={{ opacity: 0.85 }}>BTC state</span>
            <b>{header.btc?.state ? String(header.btc.state) : "-"}</b>
          </span>
        </div>

        {/* Error */}
        {err && (
          <div style={card({ marginTop: 14, borderColor: "rgba(255,0,0,0.35)", background: "rgba(255,0,0,0.10)" })}>
            <b>Error:</b> {err}
          </div>
        )}

        {/* Summary */}
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <div style={card({ padding: 12 })}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Open</div>
            <div style={{ fontSize: 22, fontWeight: 950, marginTop: 2 }}>{fmtInt(summary.openCount)}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>Current PnL avg</div>
            <div style={{ fontWeight: 900 }}>{fmtPct(summary.openPnlPctAvg, 2)}</div>
          </div>

          <div style={card({ padding: 12 })}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Open PnL</div>
            <div style={{ fontSize: 22, fontWeight: 950, marginTop: 2 }}>{fmtUsd(summary.openPnlUsd, 2)}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>Unrealized</div>
            <div style={{ fontWeight: 900 }}>{summary.openPnlUsd >= 0 ? "↗" : "↘"}</div>
          </div>

          <div style={card({ padding: 12 })}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Closed</div>
            <div style={{ fontSize: 22, fontWeight: 950, marginTop: 2 }}>{fmtInt(summary.closedCount)}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>Avg realized</div>
            <div style={{ fontWeight: 900 }}>{fmtPct(summary.avgRealizedPct, 2)}</div>
          </div>

          <div style={card({ padding: 12 })}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Realized PnL</div>
            <div style={{ fontSize: 22, fontWeight: 950, marginTop: 2 }}>{fmtUsd(summary.realizedUsd, 2)}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>Closed sum</div>
            <div style={{ fontWeight: 900 }}>{summary.realizedUsd >= 0 ? "↗" : "↘"}</div>
          </div>
        </div>

        {/* Open positions */}
        <div style={{ marginTop: 14, ...card() }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 950 }}>Open positions</div>
            <span style={pill("rgba(0,200,255,0.16)")}>
              <span style={{ opacity: 0.85 }}>Count</span>
              <b>{fmtInt(open.length)}</b>
            </span>
          </div>

          <table style={tableStyle()}>
            <thead>
              <tr>
                <th style={thtd(true)}>Symbol</th>
                <th style={thtd(true)}>Entry</th>
                <th style={thtd(true)}>Last</th>
                <th style={thtd(true)}>PnL</th>
                <th style={thtd(true)}>TP / SL</th>
                <th style={thtd(true)}>RR</th>
                <th style={thtd(true)}>Opened</th>
                <th style={thtd(true)}>Meta</th>
              </tr>
            </thead>
            <tbody>
              {open.map((p) => {
                const rr = p.rr ?? calcRRFromSlTp(p.entryPrice, p.sl, p.tp, p.mode);
                const pnlPct = n(p.pnlPct, 0);
                const tagBg = pnlColor(pnlPct);
                return (
                  <tr key={p.id}>
                    <td style={thtd(false)}>
                      <b>{up(p.symbol)}</b>
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{p.mode}</div>
                    </td>
                    <td style={thtd(false)}>{fmtNum(p.entryPrice, 8)}</td>
                    <td style={thtd(false)}>{fmtNum(p.lastPrice, 8)}</td>
                    <td style={thtd(false)}>
                      <span style={pill(tagBg)}>
                        <b>{fmtPct(pnlPct, 2)}</b>
                        <span style={{ opacity: 0.85 }}>{fmtUsd(p.pnlUsd, 2)}</span>
                      </span>
                    </td>
                    <td style={thtd(false)}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>TP</div>
                      <div style={{ fontWeight: 800 }}>{fmtNum(p.tp, 8)}</div>
                      <div style={{ height: 6 }} />
                      <div style={{ fontSize: 12, opacity: 0.7 }}>SL</div>
                      <div style={{ fontWeight: 800 }}>{fmtNum(p.sl, 8)}</div>
                    </td>
                    <td style={thtd(false)}>
                      <span style={pill("rgba(255,255,255,0.08)")}>
                        <b>{fmtNum(rr, 2)}</b>
                      </span>
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                        tpPct {fmtNum(p.tpPct, 2)} / slPct {fmtNum(p.slPct, 2)}
                      </div>
                    </td>
                    <td style={thtd(false)}>{fmtDate(p.entryAt)}</td>
                    <td style={thtd(false)}>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        stage <b>{p.stage || "-"}</b>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        regime <b>{p.regime || "-"}</b>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        eq <b>{fmtInt(p.entryQuality || 0)}</b> · ps <b>{fmtInt(p.persistenceScore || 0)}</b>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!open.length && (
                <tr>
                  <td style={thtd(false)} colSpan={8}>
                    <span style={{ opacity: 0.75 }}>No open positions.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Closed positions */}
        <div style={{ marginTop: 14, ...card() }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 950 }}>Closed positions</div>
            <span style={pill("rgba(255,255,255,0.08)")}>
              <span style={{ opacity: 0.85 }}>Count</span>
              <b>{fmtInt(closed.length)}</b>
            </span>
          </div>

          <table style={tableStyle()}>
            <thead>
              <tr>
                <th style={thtd(true)}>Symbol</th>
                <th style={thtd(true)}>Entry → Exit</th>
                <th style={thtd(true)}>PnL</th>
                <th style={thtd(true)}>Exit kind</th>
                <th style={thtd(true)}>Opened</th>
                <th style={thtd(true)}>Closed</th>
                <th style={thtd(true)}>Meta</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((p) => {
                const pnlPct = n(p.pnlPct, 0);
                const tagBg = pnlColor(pnlPct);
                return (
                  <tr key={p.id}>
                    <td style={thtd(false)}>
                      <b>{up(p.symbol)}</b>
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{p.mode}</div>
                    </td>
                    <td style={thtd(false)}>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>Entry</div>
                      <div style={{ fontWeight: 800 }}>{fmtNum(p.entryPrice, 8)}</div>
                      <div style={{ height: 6 }} />
                      <div style={{ fontSize: 12, opacity: 0.7 }}>Exit</div>
                      <div style={{ fontWeight: 800 }}>{fmtNum(p.exitPrice, 8)}</div>
                    </td>
                    <td style={thtd(false)}>
                      <span style={pill(tagBg)}>
                        <b>{fmtPct(pnlPct, 2)}</b>
                        <span style={{ opacity: 0.85 }}>{fmtUsd(p.pnlUsd, 2)}</span>
                      </span>
                    </td>
                    <td style={thtd(false)}>
                      <span style={pill("rgba(255,255,255,0.08)")}>
                        <b>{p.exitKind || "-"}</b>
                      </span>
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>{p.exitReason || ""}</div>
                    </td>
                    <td style={thtd(false)}>{fmtDate(p.entryAt)}</td>
                    <td style={thtd(false)}>{fmtDate(p.closedAt)}</td>
                    <td style={thtd(false)}>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        stage <b>{p.stage || "-"}</b>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        exitRegime <b>{p.regimeAtExit || "-"}</b>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        eq <b>{fmtInt(p.entryQuality || 0)}</b> · ps <b>{fmtInt(p.persistenceScore || 0)}</b>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!closed.length && (
                <tr>
                  <td style={thtd(false)} colSpan={7}>
                    <span style={{ opacity: 0.75 }}>No closed positions.</span>
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
            {JSON.stringify({ positionsPayload, latestPayload }, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}