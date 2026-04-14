import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtUSD(x, dec = 6) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(dec)}`;
}

function fmtPct(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(2)}%`;
}

function confColor(v) {
  const x = n(v, 0);
  if (x >= 80) return "var(--green)";
  if (x >= 60) return "var(--blue)";
  if (x >= 40) return "var(--amber)";
  return "var(--red)";
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(n(v, 0))));
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return fallback;
}

function normalizeCoin(c) {
  const symbol = String(c?.symbol || "").toUpperCase();
  const name = pick(c, ["name", "projectName"], "") || "";
  const price = pick(c, ["price", "current_price"], null);
  const change24 = pick(c, ["change24", "change24h", "price_change_percentage_24h", "momentum"], null);
  const volume = pick(c, ["volume", "total_volume", "volUsd", "volumeUsd"], null);
  const marketCap = pick(c, ["marketCap", "market_cap"], null);
  const vm = pick(c, ["vm"], null);
  const volAcc = pick(c, ["volAcc", "volumeAcceleration", "volume_acceleration"], null);

  const ob = pick(c, ["ob", "orderbook"], null) || null;
  const spreadPct = ob ? pick(ob, ["spreadPct", "spread_pct"], null) : null;
  const depth1p = ob ? pick(ob, ["depthMinUsd1p", "depthMin", "depth1p"], null) : null;
  const obScore = ob ? pick(ob, ["score", "imbalance", "obScore"], null) : null;
  const bestBid = ob ? pick(ob, ["bestBid"], null) : null;
  const bestAsk = ob ? pick(ob, ["bestAsk"], null) : null;

  const tradePlan = pick(c, ["tradePlan", "plan"], null) || null;
  const aiScore = pick(c, ["aiScore"], null);
  const confidence = pick(c, ["confidence", "entryQuality"], null);

  const score = clampPct(
    Number.isFinite(Number(aiScore)) ? aiScore : Number.isFinite(Number(confidence)) ? confidence : 0
  );

  return {
    raw: c, symbol, name, price, change24, volume, marketCap, vm, volAcc, score,
    ob: ob ? { spreadPct, depth1p, obScore, bestBid, bestAsk } : null,
    tradePlan,
  };
}

function Modal({ open, onClose, coin, mode }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !coin) return null;

  const c = coin;
  const plan = c.tradePlan || {};
  const side = mode === "bear" ? "SHORT" : "LONG";

  const entry = pick(plan, ["entry"], null);
  const sl = pick(plan, ["sl"], null);
  const tp = pick(plan, ["tp"], null);
  const rr = pick(plan, ["rr"], null);

  return (
    <div className="modalBackdrop" onMouseDown={(e) => { if (e.target.classList.contains("modalBackdrop")) onClose?.(); }}>
      <div className="modal">
        <div className="modalTop">
          <div>
            <div className="modalTitle">
              {c.symbol} <span className={`chip ${mode === 'bear' ? 'negative' : 'positive'}`}>{side}</span>
            </div>
            <div className="modalSubtitle">
              {c.name ? c.name + " • " : ""} {fmtUSD(c.price, 6)} • Score {c.score}/100
            </div>
          </div>
          <button className="closeBtn" onClick={onClose}>✕</button>
        </div>

        <div className="modalGrid">
          <div className="metricBox">
            <div className="metricLabel">24h Change</div>
            <div className={`metricValue ${c.change24 >= 0 ? "positive" : "negative"}`}>{fmtPct(c.change24)}</div>
          </div>
          <div className="metricBox">
            <div className="metricLabel">Spread</div>
            <div className="metricValue">{c.ob?.spreadPct !== null ? `${n(c.ob.spreadPct, 0).toFixed(3)}%` : "—"}</div>
          </div>
          <div className="metricBox">
            <div className="metricLabel">Depth 1%</div>
            <div className="metricValue">{c.ob?.depth1p !== null ? `$${Math.round(n(c.ob.depth1p, 0)).toLocaleString()}` : "—"}</div>
          </div>
          <div className="metricBox">
            <div className="metricLabel">VolAcc</div>
            <div className="metricValue">{c.volAcc !== null ? n(c.volAcc, 0).toFixed(2) : "—"}</div>
          </div>
        </div>

        <div className="modalSection">
          <div className="sectionHeading">TRADE PLAN</div>
          <div className="detailsGrid">
            <div className="detailItem">
              <span className="detailLabel">Entry</span>
              <span className="detailValue">{entry !== null ? fmtUSD(entry, 8) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">Stop Loss</span>
              <span className="detailValue">{sl !== null ? fmtUSD(sl, 8) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">Take Profit</span>
              <span className="detailValue">{tp !== null ? fmtUSD(tp, 8) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">Risk/Reward</span>
              <span className="detailValue">{rr !== null ? n(rr, 0).toFixed(2) : "—"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StagePanel({ title, items, onSelect }) {
  const arr = Array.isArray(items) ? items : [];
  return (
    <section className="panel">
      <div className="panelHead">
        <div className="panelTitle">{title}</div>
        <div className="panelCount">{arr.length}</div>
      </div>

      {arr.length === 0 ? (
        <div className="emptyState">Geen coins in deze fase</div>
      ) : (
        <div className="coinGrid">
          {arr.map((raw) => {
            const c = normalizeCoin(raw);
            return (
              <button key={c.symbol || Math.random()} className="coinButton" onClick={() => onSelect?.(c)}>
                <div className="coinCore">
                  <div className="coinLeft">
                    <div className="coinAvatarText">{c.symbol ? c.symbol.charAt(0) : "?"}</div>
                    <div className="coinText">
                      <div className="coinSymbol">{c.symbol || "—"}</div>
                      <div className="coinName">{c.name || " "}</div>
                    </div>
                  </div>
                  <div className="coinMarket">
                    <div className="coinPrice">{fmtUSD(c.price, 6)}</div>
                    <div className={`coinChange ${n(c.change24, 0) >= 0 ? "positive" : "negative"}`}>
                      {fmtPct(c.change24)}
                    </div>
                  </div>
                </div>
                <div className="coinFooter">
                  <span className="scorePill" style={{ color: confColor(c.score), borderColor: 'rgba(255,255,255,0.1)' }}>
                    Score: {c.score}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  async function loadState() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  async function tickScan() {
    try {
      await fetch(`/api/scan?mode=${mode}`, { cache: "no-store" });
    } catch {}
  }

  useEffect(() => {
    loadState();
    tickScan();
    const t1 = setInterval(loadState, 15000);
    const t2 = setInterval(tickScan, 60000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  const lastScan = useMemo(() => {
    const ts = n(data?.ts || data?.lastScanTs || data?.scannedAt, 0);
    return ts ? new Date(ts).toLocaleString() : "—";
  }, [data]);

  const regimeLabel = useMemo(() => String(data?.regime?.label || data?.regime?.state || "NEUTRAL"), [data]);
  const regimeScore = useMemo(() => n(data?.regime?.score, 0), [data]);
  const funnel = data?.funnel || {};

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">BULL SCANNER</div>
          <div className="brandMeta">Last scan: {lastScan}</div>

          <div className="regimeBlock">
            <div className="regimeMeta">
              <span>Regime: <strong>{regimeLabel}</strong></span>
              <span>Score: <strong>{regimeScore.toFixed(2)}</strong></span>
            </div>
            <div className="regimeMeter">
              <div 
                className={`regimeFill ${regimeScore >= 0 ? 'bullish' : 'bearish'}`} 
                style={{ width: `${Math.min(100, Math.abs(regimeScore))}%` }} 
              />
            </div>
          </div>
        </div>

        <nav className="navRow">
          <Link href="/bull" className="navBtn active">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/analyse" className="navBtn">Analyse</Link>
          <Link href="/trade" className="navBtn">Trade</Link>
        </nav>
      </header>

      <main className="panels">
        <StagePanel title="ENTRY READY" items={funnel.entry_ready} onSelect={setSelected} />
        <StagePanel title="SETUP" items={funnel.setup} onSelect={setSelected} />
        <StagePanel title="WARMUP" items={funnel.warmup} onSelect={setSelected} />
        <StagePanel title="RADAR" items={funnel.radar} onSelect={setSelected} />
      </main>

      <Modal open={!!selected} coin={selected} mode={mode} onClose={() => setSelected(null)} />
    </div>
  );
}
