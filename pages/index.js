// pages/index.js
// Main Funnel Web UI (Next.js pages router)
// - Shows latest scan snapshot (bull/bear), funnel buckets, candidates, BTC, portfolio
// - Quick actions: refresh, view open/closed positions, exec positions (paper/live), analyze-all
//
// ENV (client):
// - NEXT_PUBLIC_API_BASE (optional) e.g. "" or "https://your-vercel-domain"
// - NEXT_PUBLIC_DASH_TOKEN (optional) if you want to auto-attach ?token=... for protected endpoints
//
// Server endpoints expected:
// - /api/latest?mode=bull|bear
// - /api/analyze-all
// - /api/main/scan?mode=bull|bear (protected)
// - /api/exec/status?mode=bull|bear (optional; if you add exec endpoints later)
//
// This file is self-contained and works without extra UI libs.

import React, { useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
const DASH_TOKEN = process.env.NEXT_PUBLIC_DASH_TOKEN || "";

function qs(obj = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { ok: false, error: "invalid_json", raw: txt };
  }
  return { ok: res.ok, status: res.status, data };
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function fmtNum(x, digits = 2) {
  const v = n(x, NaN);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}
function fmtInt(x) {
  const v = Math.round(n(x, NaN));
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString();
}
function fmtUsd(x) {
  const v = n(x, NaN);
  if (!Number.isFinite(v)) return "-";
  return `$${v.toFixed(2)}`;
}
function fmtPct(x) {
  const v = n(x, NaN);
  if (!Number.isFinite(v)) return "-";
  return `${v.toFixed(2)}%`;
}
function up(s) {
  return String(s || "").toUpperCase();
}
function tsToLocal(ts) {
  const t = n(ts, 0);
  if (!t) return "-";
  return new Date(t).toLocaleString();
}

function badgeStyle(kind = "default") {
  const base = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid rgba(255,255,255,0.12)",
    marginRight: 6,
  };
  const map = {
    default: { background: "rgba(255,255,255,0.06)" },
    green: { background: "rgba(0,255,170,0.10)", border: "1px solid rgba(0,255,170,0.22)" },
    red: { background: "rgba(255,80,80,0.10)", border: "1px solid rgba(255,80,80,0.22)" },
    yellow: { background: "rgba(255,205,80,0.10)", border: "1px solid rgba(255,205,80,0.22)" },
    blue: { background: "rgba(120,160,255,0.12)", border: "1px solid rgba(120,160,255,0.22)" },
  };
  return { ...base, ...(map[kind] || map.default) };
}

function stageColor(stage) {
  const s = up(stage);
  if (s.includes("ELITE")) return "blue";
  if (s === "ALMOST") return "yellow";
  if (s === "BUILDUP") return "default";
  return "default";
}

function scoreColor(score) {
  const v = n(score, 0);
  if (v >= 76) return "green";
  if (v >= 66) return "yellow";
  return "default";
}

function regimeColor(regime) {
  const r = up(regime);
  if (r === "EXPANSION") return "green";
  if (r === "CONTRACTION") return "red";
  if (r === "HEADWIND") return "yellow";
  return "default";
}

function btcColor(state) {
  const s = up(state);
  if (s === "BULL") return "green";
  if (s === "BEAR") return "red";
  return "default";
}

function Card({ title, right, children }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>{title}</div>
        <div>{right}</div>
      </div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

function Table({ cols, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={styles.table}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={styles.th}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} style={styles.td}>
                <span style={{ opacity: 0.7 }}>No rows</span>
              </td>
            </tr>
          ) : (
            rows.map((r, idx) => (
              <tr key={idx} style={idx % 2 ? styles.trAlt : undefined}>
                {cols.map((c) => (
                  <td key={c.key} style={styles.td}>
                    {typeof c.render === "function" ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function CoinRow({ coin }) {
  const sym = up(coin?.symbol);
  const name = coin?.name || "";
  const stage = up(coin?.stage);
  const pc = n(coin?.perfectCandidateScore, 0);
  const eq = n(coin?.entryQuality, 0);

  return (
    <div style={styles.coinRow}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {coin?.image ? (
          <img src={coin.image} alt={sym} width={22} height={22} style={{ borderRadius: 6 }} />
        ) : (
          <div style={{ width: 22, height: 22, borderRadius: 6, background: "rgba(255,255,255,0.08)" }} />
        )}
        <div>
          <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>
            {sym} <span style={{ opacity: 0.65, fontWeight: 700, marginLeft: 6 }}>{name}</span>
          </div>
          <div style={{ marginTop: 4 }}>
            <span style={badgeStyle(stageColor(stage))}>{stage || "—"}</span>
            <span style={badgeStyle(scoreColor(pc))}>PC {fmtInt(pc)}</span>
            <span style={badgeStyle(scoreColor(eq))}>EQ {fmtInt(eq)}</span>
            <span style={badgeStyle("default")}>24h {fmtPct(coin?.change24)}</span>
            <span style={badgeStyle("default")}>1h {fmtPct(coin?.change1h)}</span>
            <span style={badgeStyle("default")}>VM {fmtNum(coin?.vm, 3)}</span>
          </div>
        </div>
      </div>

      <div style={{ textAlign: "right" }}>
        <div style={{ fontWeight: 800 }}>{fmtUsd(coin?.price)}</div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
          {coin?.tradeDeskStatus ? <span style={badgeStyle(up(coin.tradeDeskStatus) === "OPEN" ? "green" : up(coin.tradeDeskStatus) === "WATCH" ? "yellow" : "default")}>{up(coin.tradeDeskStatus)}</span> : null}
          {coin?.tradePlan ? (
            <span style={badgeStyle("blue")}>
              TP {fmtNum(coin.tradePlan.tpPct, 2)} • SL {fmtNum(coin.tradePlan.slPct, 2)} • RR {fmtNum(coin.tradePlan.rr, 2)}
            </span>
          ) : (
            <span style={badgeStyle("default")}>no tradePlan</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function IndexPage() {
  const [mode, setMode] = useState("bull");
  const [loading, setLoading] = useState(false);
  const [latest, setLatest] = useState(null);
  const [analyze, setAnalyze] = useState(null);
  const [error, setError] = useState(null);

  const tokenParam = DASH_TOKEN ? { token: DASH_TOKEN } : {};

  const latestUrl = useMemo(() => {
    return `${API_BASE}/api/latest?${qs({ mode, ...tokenParam })}`;
  }, [mode]);

  const analyzeUrl = useMemo(() => {
    return `${API_BASE}/api/analyze-all?${qs({ ...tokenParam })}`;
  }, []);

  async function loadAll({ withAnalyze = true } = {}) {
    setLoading(true);
    setError(null);

    const a = await fetchJson(latestUrl);
    if (!a.ok) {
      setLatest(a.data || null);
      setError(`latest failed (${a.status})`);
      setLoading(false);
      return;
    }
    setLatest(a.data);

    if (withAnalyze) {
      const b = await fetchJson(analyzeUrl);
      if (b.ok) setAnalyze(b.data);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadAll({ withAnalyze: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // auto refresh every 60s
  useEffect(() => {
    const id = setInterval(() => {
      loadAll({ withAnalyze: false });
    }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const funnel = latest?.funnel || {};
  const buckets = [
    { key: "elite_expansion", label: "Elite Expansion / Cascade" },
    { key: "elite_ignition", label: "Elite Ignition" },
    { key: "almost", label: "Almost" },
    { key: "buildup", label: "Buildup" },
    { key: "radar", label: "Radar" },
  ];

  const counts = latest?.counts || {};
  const btc = latest?.btc || {};
  const meta = latest?.meta || {};
  const perf = meta?.performance || null;
  const adaptive = meta?.adaptiveThresholds || null;

  const candidates = latest?.candidates || {};
  const portfolio = latest?.portfolio || null;

  const analyzeForMode = useMemo(() => {
    if (!analyze?.main) return null;
    return mode === "bear" ? analyze.main.bear : analyze.main.bull;
  }, [analyze, mode]);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 0.2 }}>Main Funnel</div>
          <span style={badgeStyle(regimeColor(latest?.regime))}>{up(latest?.regime || "—")}</span>
          <span style={badgeStyle(btcColor(btc?.state))}>
            BTC {up(btc?.state || "—")} • 24h {fmtPct(btc?.chg24)} • 1h {fmtPct(btc?.chg1h)} • range {fmtPct(btc?.range24)}
          </span>
          <span style={badgeStyle("default")}>scanned: {tsToLocal(latest?.scannedAt || latest?.ts)}</span>
          {loading ? <span style={badgeStyle("yellow")}>loading…</span> : <span style={badgeStyle("default")}>ready</span>}
          {error ? <span style={badgeStyle("red")}>{error}</span> : null}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={styles.segment}>
            <button
              onClick={() => setMode("bull")}
              style={{ ...styles.segBtn, ...(mode === "bull" ? styles.segBtnActive : null) }}
            >
              Bull
            </button>
            <button
              onClick={() => setMode("bear")}
              style={{ ...styles.segBtn, ...(mode === "bear" ? styles.segBtnActive : null) }}
            >
              Bear
            </button>
          </div>

          <button style={styles.btn} onClick={() => loadAll({ withAnalyze: true })}>
            Refresh
          </button>

          <a style={styles.btnLink} href={`/api/latest?${qs({ mode, ...tokenParam })}`} target="_blank" rel="noreferrer">
            Open latest JSON
          </a>
          <a style={styles.btnLink} href={`/api/analyze-all?${qs({ ...tokenParam })}`} target="_blank" rel="noreferrer">
            Open analyze JSON
          </a>
        </div>
      </header>

      <div style={styles.grid}>
        <Card
          title="Funnel Counts"
          right={<span style={badgeStyle("default")}>whaleFlow {fmtInt(latest?.whaleFlow)}</span>}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
            {buckets.map((b) => (
              <div key={b.key} style={styles.kpi}>
                <div style={{ opacity: 0.7, fontSize: 12 }}>{b.label}</div>
                <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtInt(counts?.[b.key])}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Portfolio"
          right={
            portfolio ? (
              <span style={badgeStyle("default")}>
                open {fmtInt(portfolio.openCount)} • closed {fmtInt(portfolio.closedCount)}
              </span>
            ) : null
          }
        >
          {!portfolio ? (
            <div style={{ opacity: 0.7 }}>No portfolio yet.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
              <div style={styles.kpi}>
                <div style={{ opacity: 0.7, fontSize: 12 }}>Realized</div>
                <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtUsd(portfolio.realizedUsd)}</div>
              </div>
              <div style={styles.kpi}>
                <div style={{ opacity: 0.7, fontSize: 12 }}>Avg realized %</div>
                <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtPct(portfolio.avgRealizedPct)}</div>
              </div>
              <div style={styles.kpi}>
                <div style={{ opacity: 0.7, fontSize: 12 }}>Position USD</div>
                <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtUsd(portfolio.posUsd)}</div>
              </div>
              <div style={styles.kpi}>
                <div style={{ opacity: 0.7, fontSize: 12 }}>Updated</div>
                <div style={{ fontWeight: 900, fontSize: 14 }}>{tsToLocal(portfolio.updatedAt)}</div>
              </div>
            </div>
          )}
        </Card>

        <Card title="Adaptive Thresholds" right={<span style={badgeStyle("default")}>from performance</span>}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
            <div style={styles.kpi}>
              <div style={{ opacity: 0.7, fontSize: 12 }}>Winrate</div>
              <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtPct(perf?.winRate)}</div>
            </div>
            <div style={styles.kpi}>
              <div style={{ opacity: 0.7, fontSize: 12 }}>Drawdown</div>
              <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtPct(perf?.drawdown)}</div>
            </div>
            <div style={styles.kpi}>
              <div style={{ opacity: 0.7, fontSize: 12 }}>Timing ≥</div>
              <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtInt(adaptive?.timing)}</div>
            </div>
            <div style={styles.kpi}>
              <div style={{ opacity: 0.7, fontSize: 12 }}>Quality ≥</div>
              <div style={{ fontWeight: 900, fontSize: 22 }}>{fmtInt(adaptive?.quality)}</div>
            </div>
          </div>
          <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
            Market ≥ {fmtInt(adaptive?.market)} • Regime {up(latest?.regime || "—")}
          </div>
        </Card>

        <Card title="Analyze (Top Fix)" right={<span style={badgeStyle("default")}>auto insight</span>}>
          {!analyzeForMode ? (
            <div style={{ opacity: 0.7 }}>Analyze data not loaded.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span style={badgeStyle("blue")}>{analyzeForMode.name}</span>
                <span style={badgeStyle("default")}>coins analyzed {fmtInt(analyzeForMode.totalCoins)}</span>
                {analyzeForMode.topFix ? (
                  <span style={badgeStyle("yellow")}>
                    top bottleneck: {analyzeForMode.topFix.filter} • gain ~{fmtInt(analyzeForMode.topFix.expectedGainPct)}%
                  </span>
                ) : (
                  <span style={badgeStyle("default")}>no bottlenecks</span>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                <Table
                  cols={[
                    { key: "filter", label: "Filter" },
                    { key: "hits", label: "Hits", render: (r) => fmtInt(r.hits) },
                    { key: "impact", label: "Impact", render: (r) => fmtNum(r.impact, 2) },
                    { key: "expectedGainPct", label: "Expected gain", render: (r) => `${fmtInt(r.expectedGainPct)}%` },
                  ]}
                  rows={(analyzeForMode.table || []).slice(0, 6)}
                />
              </div>
            </>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 18 }}>
        <Card
          title="Candidates"
          right={
            <span style={badgeStyle("default")}>
              premium {fmtInt((candidates.premium || []).length)} • open {fmtInt((candidates.tradeReady || []).length)} •
              watch {fmtInt((candidates.watch || []).length)}
            </span>
          }
        >
          <div style={styles.twoCol}>
            <div>
              <div style={styles.sectionTitle}>Premium</div>
              {(candidates.premium || []).slice(0, 12).map((c) => (
                <CoinRow key={`p_${c.symbol}`} coin={c} />
              ))}
            </div>
            <div>
              <div style={styles.sectionTitle}>Trade Ready (Desk OPEN)</div>
              {(candidates.tradeReady || []).slice(0, 20).map((c) => (
                <CoinRow key={`o_${c.symbol}`} coin={c} />
              ))}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={styles.sectionTitle}>Watch</div>
            {(candidates.watch || []).slice(0, 20).map((c) => (
              <CoinRow key={`w_${c.symbol}`} coin={c} />
            ))}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 18 }}>
        <Card title="Funnel Buckets" right={<span style={badgeStyle("default")}>sorted by score</span>}>
          {buckets.map((b) => {
            const list = Array.isArray(funnel[b.key]) ? funnel[b.key] : [];
            return (
              <div key={b.key} style={{ marginBottom: 16 }}>
                <div style={styles.sectionTitle}>
                  {b.label} <span style={{ opacity: 0.6 }}>({list.length})</span>
                </div>
                {list.length === 0 ? (
                  <div style={{ opacity: 0.65, padding: "8px 0" }}>No coins</div>
                ) : (
                  list.slice(0, b.key.includes("elite") ? 12 : 20).map((c) => <CoinRow key={`${b.key}_${c.symbol}`} coin={c} />)
                )}
              </div>
            );
          })}
        </Card>
      </div>

      <footer style={styles.footer}>
        <div style={{ opacity: 0.75 }}>
          Auto refresh: 60s • Scan schedule: every ~30 minutes via Vercel Cron (cron.js / cron-bull.js / cron-bear.js)
        </div>
      </footer>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 600px at 20% 0%, rgba(120,160,255,0.10), transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(0,255,170,0.06), transparent 55%), #0b0e14",
    color: "white",
    padding: "22px 18px 40px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    flexWrap: "wrap",
    paddingBottom: 12,
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    marginBottom: 18,
  },
  btn: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
  },
  btnLink: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.03)",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
    textDecoration: "none",
  },
  segment: {
    display: "inline-flex",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    overflow: "hidden",
  },
  segBtn: {
    padding: "10px 12px",
    background: "transparent",
    color: "white",
    border: "none",
    cursor: "pointer",
    fontWeight: 900,
    opacity: 0.75,
  },
  segBtnActive: {
    background: "rgba(255,255,255,0.10)",
    opacity: 1,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
  },
  card: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 16,
    padding: 14,
    backdropFilter: "blur(6px)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
  },
  kpi: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: 12,
  },
  sectionTitle: {
    fontWeight: 900,
    fontSize: 13,
    opacity: 0.9,
    marginBottom: 8,
    marginTop: 8,
  },
  coinRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "10px 10px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.03)",
    marginBottom: 8,
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
  },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    opacity: 0.8,
    fontWeight: 900,
  },
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    verticalAlign: "top",
  },
  trAlt: {
    background: "rgba(255,255,255,0.02)",
  },
  footer: {
    marginTop: 22,
    paddingTop: 14,
    borderTop: "1px solid rgba(255,255,255,0.10)",
    fontSize: 12,
  },
};

// Responsive tweak (simple)
if (typeof window !== "undefined") {
  const mq = window.matchMedia("(max-width: 980px)");
  const apply = () => {
    const root = document.documentElement;
    if (mq.matches) root.style.setProperty("--grid-cols", "1");
  };
  apply();
  mq.addEventListener?.("change", apply);
}