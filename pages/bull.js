import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/* ================= HELPERS ================= */
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtPrice(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

/* ================= COMPONENTS ================= */
function CoinCard({ c, onOpenModal }) {
  const avatarLetters = (c.symbol || "CR").substring(0, 2).toUpperCase();
  return (
    <button className="coinButton" onClick={() => onOpenModal(c)}>
      <div className="coinCore">
        <div className="coinLeft">
          <div className="coinAvatarText">{avatarLetters}</div>
          <div className="coinText">
            <div className="coinSymbol">{c.symbol}</div>
            <div className="coinName">{c.name || "Crypto Asset"}</div>
          </div>
        </div>
        <div className="coinMarket">
          <div className="coinPrice">${fmtPrice(c.price)}</div>
          <div className="coinChange" style={{ color: "var(--muted)" }}>
            AI Score: {c.aiScore || "—"}
          </div>
        </div>
      </div>
    </button>
  );
}

function FunnelBlock({ title, items, onOpenModal }) {
  return (
    <div className="panel" style={{ marginBottom: "18px" }}>
      <div className="panelHead">
        <div>
          <div className="panelTitle">{title}</div>
          <div className="panelHint">Munten actief in deze fase</div>
        </div>
        <div className="panelCount">{items?.length || 0}</div>
      </div>

      {items?.length ? (
        <div className="coinGrid">
          {items.map((c) => (
            <CoinCard key={c.symbol} c={c} onOpenModal={onOpenModal} />
          ))}
        </div>
      ) : (
        <div className="emptyState">Geen data beschikbaar voor deze fase.</div>
      )}
    </div>
  );
}

/* ================= PAGE ================= */
export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);
  const [activeCoin, setActiveCoin] = useState(null);

  async function loadState() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  useEffect(() => {
    loadState();
    const t = setInterval(loadState, 30000);
    return () => clearInterval(t);
  }, []);

  const lastScan = useMemo(() => {
    const ts = n(data?.lastScan || data?.ts, 0);
    return ts ? new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "—";
  }, [data]);

  const regimeLabel = data?.regime?.label || "NEUTRAL";
  const regimeScore = n(data?.regime?.score, 0);
  const funnel = data?.funnel || {};

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">BULL SCANNER</div>
          <div className="brandMeta">Laatste scan: {lastScan}</div>
          <div className="regimeBlock">
            <div className="regimeMeta">
              <span>Huidig Regime</span>
              <strong>{regimeLabel} ({regimeScore.toFixed(1)})</strong>
            </div>
            <div className="regimeMeter">
              <div
                className="regimeFill bullish"
                style={{ width: `${Math.min(Math.max(regimeScore, 0), 100)}%` }}
              />
            </div>
          </div>
        </div>
        <nav className="navRow">
          <Link href="/" className="navBtn">Home</Link>
          <Link href="/bull" className="navBtn active">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/analyse" className="navBtn">Analyse</Link>
          <Link href="/trade" className="navBtn">Trade</Link>
        </nav>
      </header>

      <main className="panels">
        {/* Volgorde aangepast: Entry Ready bovenaan */}
        <FunnelBlock title="ENTRY READY" items={funnel.entry_ready} onOpenModal={setActiveCoin} />
        <FunnelBlock title="SETUP" items={funnel.setup} onOpenModal={setActiveCoin} />
        <FunnelBlock title="WARMUP" items={funnel.warmup} onOpenModal={setActiveCoin} />
        <FunnelBlock title="RADAR" items={funnel.radar} onOpenModal={setActiveCoin} />
      </main>

      {/* MODAL / POP-UP */}
      {activeCoin && (
        <div className="modalBackdrop" onClick={() => setActiveCoin(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalTop">
              <div>
                <div className="modalTitle">{activeCoin.symbol}</div>
                <div className="modalSubtitle">{activeCoin.name || "Long Setup Analyse"}</div>
              </div>
              <button className="closeBtn" onClick={() => setActiveCoin(null)}>✕</button>
            </div>

            <div className="modalGrid">
              <div className="metricBox">
                <div className="metricLabel">Prijs</div>
                <div className="metricValue">${fmtPrice(activeCoin.price)}</div>
              </div>
              <div className="metricBox">
                <div className="metricLabel">AI Score</div>
                <div className="metricValue">{activeCoin.aiScore || "—"}</div>
              </div>
              <div className="metricBox">
                <div className="metricLabel">24h Change</div>
                <div className="metricValue">{activeCoin.change24 ? `${activeCoin.change24.toFixed(2)}%` : "—"}</div>
              </div>
              <div className="metricBox">
                <div className="metricLabel">Spread</div>
                <div className="metricValue">{activeCoin?.ob?.spreadPct ? `${activeCoin.ob.spreadPct.toFixed(3)}%` : "—"}</div>
              </div>
            </div>

            <div className="modalSection">
              <div className="sectionHeading">ORDERBOOK DETAILS</div>
              <div className="detailsGrid">
                <div className="detailItem">
                  <span className="detailLabel">Vol. Acceleratie</span>
                  <span className="detailValue">{activeCoin.volAcc ? activeCoin.volAcc.toFixed(2) : "—"}</span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">Depth (USD)</span>
                  <span className="detailValue">{activeCoin?.ob?.depthMin ? activeCoin.ob.depthMin.toFixed(0) : "—"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
