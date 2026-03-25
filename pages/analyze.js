// pages/analyze.js
import React, { useEffect, useMemo, useState } from "react";

/**
 * Analyze page (100% complete)
 * - Calls /api/analyze-all (expects the shape from your api/analyze-all.js)
 * - Shows Main + Moon (if Moon is absent in your MAIN-only repo, it gracefully shows empty)
 * - Token can be passed as ?token=... OR via input (it appends token query param)
 */

const DEFAULT_MODE = "bull";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function fmtInt(x) {
  return Intl.NumberFormat().format(Math.round(n(x, 0)));
}
function fmtNum(x, digits = 2) {
  return n(x, 0).toFixed(digits);
}
function fmtPct(x, digits = 1) {
  return `${n(x, 0).toFixed(digits)}%`;
}
function fmtDate(ts) {
  const t = n(ts, 0);
  if (!t) return "-";
  return new Date(t).toLocaleString();
}

function pillStyle(bg = "rgba(255,255,255,0.08)") {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    background: bg,
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#fff",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
}

function cardStyle(extra = {}) {
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
    fontWeight: isTh ? 700 : 400,
    verticalAlign: "top",
  };
}

function severityLabel(expectedGainPct) {
  const v = n(expectedGainPct, 0);
  if (v >= 25) return { label: "High", bg: "rgba(255,0,0,0.22)" };
  if (v >= 15) return { label: "Med", bg: "rgba(255,165,0,0.20)" };
  return { label: "Low", bg: "rgba(0,200,255,0.18)" };
}

function pickBlock(data, system, mode) {
  const root = data?.[system] || {};
  return mode === "bear" ? root.bear : root.bull;
}

function TopFixCard({ title, block }) {
  const top = block?.topFix || null;

  if (!top) {
    return (
      <div style={cardStyle()}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>{title}</div>
        <div style={{ opacity: 0.75 }}>No bottlenecks detected.</div>
      </div>
    );
  }

  const sev = severityLabel(top.expectedGainPct);
  return (
    <div style={cardStyle()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
        <span style={pillStyle(sev.bg)}>
          <span style={{ opacity: 0.8 }}>Expected gain</span>
          <b>{fmtInt(top.expectedGainPct)}%</b>
          <span style={{ opacity: 0.8 }}>{sev.label}</span>
        </span>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Primary bottleneck</div>
          <div style={{ fontSize: 16, fontWeight: 900, marginTop: 2 }}>{top.filter}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Hits / Impact</div>
          <div style={{ fontWeight: 800, marginTop: 2 }}>
            {fmtInt(top.hits)} / {fmtNum(top.impact, 2)}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
        Interpretation: this is the most common reason coins fail thresholds. Improving this area typically increases signal quality the fastest.
      </div>
    </div>
  );
}

function BottlenecksTable({ title, block }) {
  const rows = safeArr(block?.table);

  return (
    <div style={cardStyle()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
        <span style={pillStyle("rgba(255,255,255,0.08)")}>
          <span style={{ opacity: 0.8 }}>Coins</span>
          <b>{fmtInt(block?.totalCoins || 0)}</b>
        </span>
      </div>

      <table style={tableStyle()}>
        <thead>
          <tr>
            <th style={thtd(true)}>Filter</th>
            <th style={thtd(true)}>Hits</th>
            <th style={thtd(true)}>Impact</th>
            <th style={thtd(true)}>Expected gain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const sev = severityLabel(r.expectedGainPct);
            return (
              <tr key={idx}>
                <td style={thtd(false)}>{r.filter}</td>
                <td style={thtd(false)}>{fmtInt(r.hits)}</td>
                <td style={thtd(false)}>{fmtNum(r.impact, 2)}</td>
                <td style={thtd(false)}>
                  <span style={pillStyle(sev.bg)}>
                    <b>{fmtInt(r.expectedGainPct)}%</b>
                    <span style={{ opacity: 0.8 }}>{sev.label}</span>
                  </span>
                </td>
              </tr>
            );
          })}

          {!rows.length && (
            <tr>
              <td style={thtd(false)} colSpan={4}>
                <span style={{ opacity: 0.75 }}>No rows.</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
        “Impact” is a heuristic based on how far scores miss thresholds and how often that happens.
      </div>
    </div>
  );
}

function AdaptiveExplain({ title, block }) {
  const exp = block?.explain || null;
  const meta = block?.meta || null;

  if (!exp) {
    return (
      <div style={cardStyle()}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>{title}</div>
        <div style={{ opacity: 0.75 }}>No adaptive explanation available.</div>
      </div>
    );
  }

  const why = exp?.why || {};
  const adaptive = exp?.adaptive || {};
  const meaning = exp?.meaning || {};

  return (
    <div style={cardStyle()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
        <span style={pillStyle("rgba(255,255,255,0.08)")}>
          <span style={{ opacity: 0.8 }}>Scanned</span>
          <b>{fmtDate(meta?.scannedAt)}</b>
        </span>
      </div>

      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 10 }}>
        <span style={pillStyle("rgba(0,200,255,0.18)")}>
          <span style={{ opacity: 0.85 }}>Regime</span>
          <b>{String(why.regime || "TREND")}</b>
        </span>
        <span style={pillStyle()}>
          <span style={{ opacity: 0.85 }}>WinRate</span>
          <b>{fmtPct(why.winRate, 1)}</b>
        </span>
        <span style={pillStyle()}>
          <span style={{ opacity: 0.85 }}>Drawdown</span>
          <b>{fmtPct(why.drawdown, 1)}</b>
        </span>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <div style={cardStyle({ padding: 12 })}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Timing threshold</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{fmtInt(adaptive.timing)}</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{meaning.timing}</div>
        </div>
        <div style={cardStyle({ padding: 12 })}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Quality threshold</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{fmtInt(adaptive.quality)}</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{meaning.quality}</div>
        </div>
        <div style={cardStyle({ padding: 12 })}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Market threshold</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{fmtInt(adaptive.market)}</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{meaning.market}</div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
        These thresholds are recalculated from performance (winrate/drawdown) and regime (e.g. HEADWIND increases Market strictness).
      </div>
    </div>
  );
}

function GlobalSnapshot({ data }) {
  const perf = data?.performance || {};
  const main = perf?.main || {};
  const moon = perf?.moon || {};

  return (
    <div style={cardStyle()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 900 }}>Global snapshot</div>
        <span style={pillStyle()}>
          <span style={{ opacity: 0.85 }}>updatedAt</span>
          <b>{fmtDate(data?.updatedAt)}</b>
        </span>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={cardStyle({ padding: 12 })}>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>Performance (Main)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bull WR</span>
              <b>{fmtPct(main?.bull?.winRate, 1)}</b>
            </span>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bull DD</span>
              <b>{fmtPct(main?.bull?.drawdown, 1)}</b>
            </span>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bear WR</span>
              <b>{fmtPct(main?.bear?.winRate, 1)}</b>
            </span>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bear DD</span>
              <b>{fmtPct(main?.bear?.drawdown, 1)}</b>
            </span>
          </div>
        </div>

        <div style={cardStyle({ padding: 12 })}>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>Performance (Moon)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bull WR</span>
              <b>{fmtPct(moon?.bull?.winRate, 1)}</b>
            </span>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bull DD</span>
              <b>{fmtPct(moon?.bull?.drawdown, 1)}</b>
            </span>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bear WR</span>
              <b>{fmtPct(moon?.bear?.winRate, 1)}</b>
            </span>
            <span style={pillStyle()}>
              <span style={{ opacity: 0.85 }}>Bear DD</span>
              <b>{fmtPct(moon?.bear?.drawdown, 1)}</b>
            </span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
        Tip: If Expected gain is high for Liquidity, consider stricter spread/depth filters or better exchange-symbol filtering.
      </div>
    </div>
  );
}

export default function AnalyzePage() {
  const [mode, setMode] = useState(DEFAULT_MODE);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(null);

  // init token from URL (?token=...)
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get("token") || "";
      if (t) setToken(t);
      const m = (url.searchParams.get("mode") || "").toLowerCase();
      if (m === "bear") setMode("bear");
    } catch {}
  }, []);

  const apiUrl = useMemo(() => {
    const qs = [];
    if (token) qs.push(`token=${encodeURIComponent(token)}`);
    return qs.length ? `/api/analyze-all?${qs.join("&")}` : `/api/analyze-all`;
  }, [token]);

  async function refresh() {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(apiUrl, { headers: { accept: "application/json" } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  const mainBlock = useMemo(() => (data ? pickBlock(data, "main", mode) : null), [data, mode]);
  const moonBlock = useMemo(() => (data ? pickBlock(data, "moon", mode) : null), [data, mode]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0B0F19 0%, #05060A 70%)",
        color: "#fff",
        padding: 18,
      }}
    >
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 950, letterSpacing: -0.2 }}>Analyze</div>
            <div style={{ opacity: 0.75, marginTop: 4 }}>
              Diagnose bottlenecks for Main + Moon and understand adaptive thresholds (performance feedback).
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
                ...pillStyle("rgba(255,255,255,0.06)"),
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              ← Home
            </a>
          </div>
        </div>

        {/* Error */}
        {err && (
          <div style={cardStyle({ marginTop: 14, borderColor: "rgba(255,0,0,0.35)", background: "rgba(255,0,0,0.10)" })}>
            <b>Error:</b> {err}
          </div>
        )}

        {/* No data */}
        {!data && !err && <div style={cardStyle({ marginTop: 14 })}>No data yet.</div>}

        {/* Main content */}
        {data && (
          <>
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <TopFixCard title={`Main (${mode}) — top fix`} block={mainBlock} />
              <TopFixCard title={`Moon (${mode}) — top fix`} block={moonBlock} />
            </div>

            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <BottlenecksTable title={`Main (${mode}) — bottlenecks`} block={mainBlock} />
              <BottlenecksTable title={`Moon (${mode}) — bottlenecks`} block={moonBlock} />
            </div>

            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <AdaptiveExplain title={`Main (${mode}) — adaptive thresholds`} block={mainBlock} />
              <AdaptiveExplain title={`Moon (${mode}) — adaptive thresholds`} block={moonBlock} />
            </div>

            <div style={{ marginTop: 14 }}>
              <GlobalSnapshot data={data} />
            </div>

            {/* Raw debug (optional) */}
            <details style={{ marginTop: 14 }}>
              <summary style={{ cursor: "pointer", opacity: 0.85 }}>Debug: raw payload</summary>
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
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}