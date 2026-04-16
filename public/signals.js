import { useEffect, useState } from "react";
import Link from "next/link";

/* ================= HELPERS ================= */
function fmtPrice(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (x >= 1) return x.toFixed(2);
  if (x >= 0.01) return x.toFixed(4);
  return x.toFixed(6);
}

// Bepaal de kleur van het signaal op basis van de actie
function getActionColor(action) {
  const a = String(action).toLowerCase();
  if (a === "entry") return "var(--green)";
  if (a === "add") return "#16a34a";
  if (a === "hold") return "var(--blue)";
  if (a === "exit") return "var(--red)";
  return "var(--muted)";
}

export default function Signals() {
  const [data, setData] = useState(null);

  async function loadState() {
    try {
      const res = await fetch(`/api/public-latest`, { cache: "no-store" });
      const j = await res.json();
      setData(j);
    } catch {}
  }

  useEffect(() => {
    loadState();
    const t = setInterval(loadState, 10000);
    return () => clearInterval(t);
  }, []);

  const trades = data?.trades || [];
  const tradeCount = trades.length;

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle" style={{ color: "var(--amber)" }}>⚡ TRADE SIGNALS</div>
          <div className="brandMeta">Actieve Trades: <strong>{tradeCount}</strong></div>
        </div>
        <nav className="navRow">
          <Link href="/" className="navBtn">Home</Link>
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/signals" className="navBtn active" style={{ background: "var(--amber)", color: "#000" }}>Trades</Link>
        </nav>
      </header>

      <main className="analysisPage">
        <section className="analysisSection">
          <div className="analysisSectionTitle">Signal Overzicht</div>
          <div className="tradeCardList">
            {!trades.length && <div className="emptyState">Geen actieve trades op dit moment.</div>}

            {trades.map((t, idx) => {
              const actionColor = getActionColor(t.action);
              const isLong = t.side?.toUpperCase() === "LONG";

              return (
                <div 
                  className="tradeRow" 
                  key={`${t.symbol}-${idx}`} 
                  style={{ borderLeft: `4px solid ${actionColor}` }}
                >
                  <div>
                    <div className="coinSymbol">{t.symbol || "—"}</div>
                    <div className="coinName" style={{ color: isLong ? "var(--green)" : "var(--red)" }}>
                      {t.side}
                    </div>
                  </div>
                  
                  <div className="tradeMid">
                    <span className="chip">Entry: ${fmtPrice(t.entry)}</span>
                    <span className="chip">SL: ${fmtPrice(t.sl)}</span>
                    <span className="chip">TP: ${fmtPrice(t.tp)}</span>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <div className="tradePnl" style={{ color: actionColor, fontSize: "18px" }}>
                      {t.action}
                    </div>
                    <div className="coinName">RR: {t.rr || "—"} | Flow: {t.flow || "—"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
