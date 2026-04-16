import { useEffect, useState } from "react";
import Link from "next/link";

/* ================= HELPERS ================= */
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
  const avatarLetters = (c.symbol || "XX").substring(0, 2).toUpperCase();
  return (
    <button className="coinButton" onClick={() => onOpenModal(c)}>
      <div className="coinCore">
        <div className="coinLeft">
          <div className="coinAvatarText" style={{ background: "rgba(34, 197, 94, 0.2)", borderColor: "var(--green)" }}>
            {avatarLetters}
          </div>
          <div className="coinText">
            <div className="coinSymbol">{c.symbol}</div>
            <div className="coinName">Flow: {c.flow || "—"}</div>
          </div>
        </div>
        <div className="coinMarket">
          <div className="coinPrice">${fmtPrice(c.price)}</div>
          <div className="coinChange" style={{ color: "var(--green)" }}>
            Score: {c.moveScore || "0"}
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
        <div className="emptyState">Geen coins in deze fase.</div>
      )}
    </div>
  );
}

/* ================= PAGE ================= */
export default function Bull() {
  const [data, setData] = useState(null);
  const [activeCoin, setActiveCoin] = useState(null);

  async function loadState() {
    try {
      const res = await fetch(`/api/public-latest`, { cache: "no-store" });
      const j = await res.json();
      setData(j);
    } catch {}
  }

  useEffect(() => {
    loadState();
    const t = setInterval(loadState, 15000);
    return () => clearInterval(t);
  }, []);

  const btcState = data?.btc?.state || "Laden...";
  const regime = data?.regime || "Laden...";
  const funnel = data?.funnel?.bull || {};

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle" style={{ color: "var(--green)" }}>🟢 BULL FUNNEL</div>
          <div className="brandMeta">BTC: <strong>{btcState}</strong> | Regime: <strong>{regime}</strong></div>
        </div>
        <nav className="navRow">
          <Link href="/" className="navBtn">Home</Link>
          <Link href="/bull" className="navBtn active" style={{ background: "var(--green)", color: "#000" }}>Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/signals" className="navBtn">Trades</Link>
        </nav>
      </header>

      <main className="panels">
        <FunnelBlock title="ENTRY" items={funnel.entry} onOpenModal={setActiveCoin} />
        <FunnelBlock title="ALMOST" items={funnel.almost} onOpenModal={setActiveCoin} />
        <FunnelBlock title="BUILDUP" items={funnel.buildup} onOpenModal={setActiveCoin} />
        <FunnelBlock title="RADAR" items={funnel.radar} onOpenModal={setActiveCoin} />
      </main>

      {/* POP-UP MODAL */}
      {activeCoin && (
        <div className="modalBackdrop" onClick={() => setActiveCoin(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalTop">
              <div>
                <div className="modalTitle">{activeCoin.symbol}</div>
                <div className="modalSubtitle">Long Analyse</div>
              </div>
              <button className="closeBtn" onClick={() => setActiveCoin(null)}>✕</button>
            </div>
            <div className="modalGrid">
              <div className="metricBox">
                <div className="metricLabel">Prijs</div>
                <div className="metricValue">${fmtPrice(activeCoin.price)}</div>
              </div>
              <div className="metricBox">
                <div className="metricLabel">Move Score</div>
                <div className="metricValue">{activeCoin.moveScore}</div>
              </div>
              <div className="metricBox">
                <div className="metricLabel">Flow</div>
                <div className="metricValue">{activeCoin.flow}</div>
              </div>
              <div className="metricBox">
                <div className="metricLabel">24h Change</div>
                <div className="metricValue">{activeCoin.change24?.toFixed(2)}%</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
