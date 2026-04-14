import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
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

function fmtBigUSD(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(0)}`;
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(n(v, 0))));
}

function confColor(v) {
  const x = clampPct(v);
  if (x >= 80) return "var(--green)";
  if (x >= 60) return "var(--blue)";
  if (x >= 40) return "var(--amber)";
  return "var(--red)";
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return fallback;
}

/**
 * Normaliseer coin zodat modal nooit “0” toont door mismatch.
 * Past op jouw state payloads (momentum24/momentum1h, ob.depthMin, ob.depthMinUsd1p, etc).
 */
function normalizeCoin(raw) {
  const c = raw || {};

  const symbol = up(c?.symbol);
  const name = String(pick(c, ["name"], "") || "");
  const image = String(pick(c, ["image"], "") || "");

  const price = pick(c, ["price", "current_price"], null);

  const change24 = pick(c, ["change24", "change24h", "momentum24", "momentum", "price_change_percentage_24h"], null);
  const change1h = pick(c, ["change1h", "momentum1h", "price_change_percentage_1h"], null);

  const volume = pick(c, ["volume", "total_volume", "volUsd", "volumeUsd"], null);
  const marketCap = pick(c, ["marketCap", "market_cap"], null);

  const volAcc = pick(c, ["volAcc", "volumeAcceleration", "volume_acceleration"], null);

  const ob = pick(c, ["ob", "orderbook", "orderBook"], null);
  const spreadPct = ob ? pick(ob, ["spreadPct", "spread", "spread_pct"], null) : null;
  const depth1p = ob ? pick(ob, ["depthMinUsd1p", "depthMinUsd", "depthMin", "depth1p", "depth"], null) : null;
  const obScore = ob ? pick(ob, ["score", "imbalance", "obScore"], null) : null;
  const bestBid = ob ? pick(ob, ["bestBid"], null) : null;
  const bestAsk = ob ? pick(ob, ["bestAsk"], null) : null;

  const plan = pick(c, ["tradePlan", "plan"], null);
  const entry = plan ? pick(plan, ["entry"], null) : null;
  const sl = plan ? pick(plan, ["sl"], null) : null;
  const tp = plan ? pick(plan, ["tp"], null) : null;
  const rr = plan ? pick(plan, ["rr"], null) : null;

  const aiScore = pick(c, ["aiScore"], null);
  const confidence = pick(c, ["confidence", "entryQuality"], null);

  const score = clampPct(
    Number.isFinite(Number(aiScore))
      ? Number(aiScore)
      : Number.isFinite(Number(confidence))
        ? Number(confidence) <= 1
          ? Number(confidence) * 100
          : Number(confidence)
        : 0
  );

  return {
    raw: c,
    symbol,
    name,
    image,
    price: Number(price),
    change24: Number(change24),
    change1h: Number(change1h),
    volume: Number(volume),
    marketCap: Number(marketCap),
    volAcc: Number.isFinite(Number(volAcc)) ? Number(volAcc) : null,
    score,
    ob: ob
      ? {
          spreadPct: Number.isFinite(Number(spreadPct)) ? Number(spreadPct) : null,
          depth1p: Number.isFinite(Number(depth1p)) ? Number(depth1p) : null,
          obScore: Number.isFinite(Number(obScore)) ? Number(obScore) : null,
          bestBid: Number.isFinite(Number(bestBid)) ? Number(bestBid) : null,
          bestAsk: Number.isFinite(Number(bestAsk)) ? Number(bestAsk) : null,
        }
      : null,
    tradePlan: plan
      ? {
          entry: Number.isFinite(Number(entry)) ? Number(entry) : null,
          sl: Number.isFinite(Number(sl)) ? Number(sl) : null,
          tp: Number.isFinite(Number(tp)) ? Number(tp) : null,
          rr: Number.isFinite(Number(rr)) ? Number(rr) : null,
        }
      : null,
  };
}

function Modal({ open, onClose, coin, mode }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !coin) return null;

  const side = mode === "bear" ? "SHORT" : "LONG";
  const c = coin;

  return (
    <div
      className="modalBackdrop"
      onMouseDown={(e) => {
        if (e.target.classList.contains("modalBackdrop")) onClose?.();
      }}
    >
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalTop">
          <div>
            <div className="modalTitle">
              {c.symbol}{" "}
              <span className={`chip ${mode === "bear" ? "negative" : "positive"}`}>
                {side}
              </span>
            </div>
            <div className="modalSubtitle">
              {c.name ? `${c.name} • ` : ""}
              {fmtUSD(c.price, 6)} • 24h{" "}
              <span className={n(c.change24, 0) >= 0 ? "positive" : "negative"}>
                {fmtPct(c.change24)}
              </span>
            </div>
          </div>
          <button className="closeBtn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* SCORE */}
        <div style={{ marginBottom: 16 }}>
          <div className="regimeMeta">
            <span>Score</span>
            <strong style={{ color: "var(--text)" }}>{c.score}/100</strong>
          </div>
          <div className="regimeMeter">
            <div
              className="regimeFill bullish"
              style={{
                width: `${c.score}%`,
                background: `linear-gradient(90deg, ${confColor(c.score)}, rgba(255,255,255,0.25))`,
              }}
            />
          </div>
        </div>

        <div className="modalGrid">
          <div className="metricBox">
            <div className="metricLabel">24h</div>
            <div className={`metricValue ${n(c.change24, 0) >= 0 ? "positive" : "negative"}`}>
              {fmtPct(c.change24)}
            </div>
          </div>

          <div className="metricBox">
            <div className="metricLabel">1h</div>
            <div className={`metricValue ${n(c.change1h, 0) >= 0 ? "positive" : "negative"}`}>
              {fmtPct(c.change1h)}
            </div>
          </div>

          <div className="metricBox">
            <div className="metricLabel">Spread</div>
            <div className="metricValue">
              {c.ob?.spreadPct !== null ? `${n(c.ob.spreadPct, 0).toFixed(3)}%` : "—"}
            </div>
          </div>

          <div className="metricBox">
            <div className="metricLabel">Depth 1%</div>
            <div className="metricValue">
              {c.ob?.depth1p !== null ? fmtBigUSD(c.ob.depth1p) : "—"}
            </div>
          </div>
        </div>

        <div className="modalSection">
          <div className="sectionHeading">MARKET</div>
          <div className="detailsGrid">
            <div className="detailItem">
              <span className="detailLabel">Volume</span>
              <span className="detailValue">{c.volume ? fmtBigUSD(c.volume) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">Market cap</span>
              <span className="detailValue">{c.marketCap ? fmtBigUSD(c.marketCap) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">VolAcc</span>
              <span className="detailValue">{c.volAcc !== null ? n(c.volAcc, 0).toFixed(2) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">OB score</span>
              <span className="detailValue">{c.ob?.obScore !== null ? n(c.ob.obScore, 0).toFixed(4) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">Best bid</span>
              <span className="detailValue">{c.ob?.bestBid !== null ? fmtUSD(c.ob.bestBid, 8) : "—"}</span>
            </div>
            <div className="detailItem">
              <span className="detailLabel">Best ask</span>
              <span className="detailValue">{c.ob?.bestAsk !== null ? fmtUSD(c.ob.bestAsk, 8) : "—"}</span>
            </div>
          </div>
        </div>

        <div className="modalSection">
          <div className="sectionHeading">TRADE PLAN</div>
          {c.tradePlan ? (
            <div className="detailsGrid">
              <div className="detailItem">
                <span className="detailLabel">Entry</span>
                <span className="detailValue">{c.tradePlan.entry !== null ? fmtUSD(c.tradePlan.entry, 8) : "—"}</span>
              </div>
              <div className="detailItem">
                <span className="detailLabel">SL</span>
                <span className="detailValue">{c.tradePlan.sl !== null ? fmtUSD(c.tradePlan.sl, 8) : "—"}</span>
              </div>
              <div className="detailItem">
                <span className="detailLabel">TP</span>
                <span className="detailValue">{c.tradePlan.tp !== null ? fmtUSD(c.tradePlan.tp, 8) : "—"}</span>
              </div>
              <div className="detailItem">
                <span className="detailLabel">R:R</span>
                <span className="detailValue">{c.tradePlan.rr !== null ? n(c.tradePlan.rr, 0).toFixed(2) : "—"}</span>
              </div>
            </div>
          ) : (
            <div className="emptyState">Nog geen trade plan beschikbaar (alleen bij ENTRY READY).</div>
          )}
        </div>

        <div className="modalSection">
          <div className="sectionHeading">DEBUG</div>
          <pre className="codeBox">{JSON.stringify(c.raw, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

function StagePanel({ title, items, onSelect }) {
  const list = Array.isArray(items) ? items : [];

  return (
    <section className="panel">
      <div className="panelHead">
        <div>
          <div className="panelTitle">{title}</div>
          <div className="panelHint">
            Basis info hier. Klik voor details.
          </div>
        </div>
        <div className="panelCount">{list.length}</div>
      </div>

      {list.length === 0 ? (
        <div className="emptyState">Geen coins in deze fase</div>
      ) : (
        <div className="coinGrid">
          {list.map((raw) => {
            const c = normalizeCoin(raw);

            return (
              <button
                key={`${c.symbol}-${Math.random()}`}
                className="coinButton"
                onClick={() => onSelect?.(c)}
              >
                <div className="coinCore">
                  <div className="coinLeft">
                    {c.image ? (
                      <img className="coinAvatar" src={c.image} alt={c.symbol} />
                    ) : (
                      <div className="coinAvatarText">{c.symbol ? c.symbol[0] : "?"}</div>
                    )}

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
                  <span
                    className="scorePill"
                    style={{ color: confColor(c.score) }}
                  >
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

  // client-side scan call blijft OK als “manual assist”,
  // maar echte auto-scan moet via Vercel Cron (zie uitleg onderaan).
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
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const lastScan = useMemo(() => {
    const ts = n(data?.ts || data?.scannedAt || data?.lastScanTs, 0);
    return ts ? new Date(ts).toLocaleString() : "—";
  }, [data]);

  const regimeLabel = useMemo(() => {
    // FIX: nooit object printen
    const r = data?.regime || {};
    return String(r.label || r.state || r.regime || "NEUTRAL");
  }, [data]);

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
              <span>
                Regime: <strong>{regimeLabel}</strong>
              </span>
              <span>
                Score: <strong>{regimeScore.toFixed(2)}</strong>
              </span>
            </div>
            <div className="regimeMeter">
              <div
                className={`regimeFill ${regimeScore >= 0 ? "bullish" : "bearish"}`}
                style={{ width: `${Math.min(100, Math.abs(regimeScore))}%` }}
              />
            </div>
          </div>
        </div>

        <nav className="navRow">
          <Link href="/bull" className="navBtn active">
            Bull
          </Link>
          <Link href="/bear" className="navBtn">
            Bear
          </Link>
          <Link href="/analyse" className="navBtn">
            Analyse
          </Link>
          <Link href="/trade" className="navBtn">
            Trade
          </Link>
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