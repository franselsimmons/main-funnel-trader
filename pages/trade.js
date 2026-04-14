import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function arr(v) { return Array.isArray(v) ? v : []; }
function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function fmtPrice(v) {
  const x = n(v, 0);
  if (x >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (x >= 1) return x.toFixed(2);
  if (x >= 0.01) return x.toFixed(4);
  return x.toFixed(6);
}
function pnlClass(v) {
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "neutral";
}
function splitPositionsByMode(positions, mode) {
  return arr(positions).filter((p) => {
    const m = String(p?.mode || "").toLowerCase();
    const side = String(p?.side || "").toUpperCase();
    if (m) return m === mode;
    if (mode === "bull") return side === "LONG";
    if (mode === "bear") return side === "SHORT";
    return false;
  });
}

export default function Trade() {
  const [positions, setPositions] = useState([]);
  const [bull, setBull] = useState(null);
  const [bear, setBear] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/positions", { cache: "no-store" }).then((r) => r.json()).then((j) => j?.positions || []).catch(() => []),
      fetch("/api/state?mode=bull", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/state?mode=bear", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([p, b1, b2]) => {
      setPositions(p); setBull(b1); setBear(b2);
    });
  }, []);

  const bullPositions = useMemo(() => splitPositionsByMode(positions, "bull"), [positions]);
  const bearPositions = useMemo(() => splitPositionsByMode(positions, "bear"), [positions]);

  const bullEntry = bull?.funnel?.entry_ready?.length || 0;
  const bearEntry = bear?.funnel?.entry_ready?.length || 0;

  const bullAvgPnl = bullPositions.length
    ? bullPositions.reduce((a, p) => a + n(p?.pnlPct ?? p?.pnl, 0), 0) / bullPositions.length : 0;
  const bearAvgPnl = bearPositions.length
    ? bearPositions.reduce((a, p) => a + n(p?.pnlPct ?? p?.pnl, 0), 0) / bearPositions.length : 0;

  let improvement = "Trade tunnel ziet er gezond uit. Geen directe actie vereist.";
  if (bullEntry + bearEntry > 0 && positions.length === 0) {
    improvement = "Entry-ready signals gespot, maar geen open trades. Controleer je spread of execution websockets.";
  } else if (positions.length > 0 && bullAvgPnl + bearAvgPnl < 0) {
    improvement = "Gemiddelde PnL staat negatief. Controleer entry timing (te laat?) of je SL/TP afstanden.";
  } else if (bullEntry === 0 && bearEntry === 0) {
    improvement = "Geen entry-ready flow. Focus momenteel op Setup → Entry conversie (OB thresholds).";
  }

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">TRADE TUNNEL</div>
          <div className="brandMeta">Monitor open posities en execution health</div>
        </div>
        <nav className="navRow">
          <Link href="/" className="navBtn">Home</Link>
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/analyse" className="navBtn">Analyse</Link>
          <Link href="/trade" className="navBtn active">Trade</Link>
        </nav>
      </header>

      <main className="analysisPage">
        <div className="compareGrid">
          <div className="compareCard">
            <div className="compareTitle">Bull Tunnel</div>
            <div className="compareMeta">
              Ready: <strong>{bullEntry}</strong> • Open: <strong>{bullPositions.length}</strong><br/>
              Avg PnL: <strong className={pnlClass(bullAvgPnl)}>{bullAvgPnl > 0 ? "+" : ""}{bullAvgPnl.toFixed(2)}%</strong>
            </div>
          </div>

          <div className="compareCard">
            <div className="compareTitle">Bear Tunnel</div>
            <div className="compareMeta">
              Ready: <strong>{bearEntry}</strong> • Open: <strong>{bearPositions.length}</strong><br/>
              Avg PnL: <strong className={pnlClass(bearAvgPnl)}>{bearAvgPnl > 0 ? "+" : ""}{bearAvgPnl.toFixed(2)}%</strong>
            </div>
          </div>
        </div>

        <section className="analysisSection">
          <div className="analysisSectionTitle">Status & Advies</div>
          <div className="adviceBox">
            <div className="adviceItem">{improvement}</div>
          </div>
        </section>

        <section className="analysisSection">
          <div className="analysisSectionTitle">Actieve Posities</div>
          <div className="tradeCardList">
            {!positions.length && <div className="emptyState">Momenteel geen open posities.</div>}

            {positions.map((p, idx) => {
              const pnl = n(p?.pnlPct ?? p?.pnl, 0);
              return (
                <div className="tradeRow" key={`${p.symbol || "pos"}-${idx}`}>
                  <div>
                    <div className="coinSymbol">{p.symbol || "—"}</div>
                    <div className="coinName" style={{color: p.side === "LONG" ? "var(--green)" : "var(--red)"}}>
                      {String(p?.side || "").toUpperCase()}
                    </div>
                  </div>
                  <div className="tradeMid">
                    <span className="chip">In: ${fmtPrice(p?.entry)}</span>
                    <span className="chip">SL: ${fmtPrice(p?.sl)}</span>
                    <span className="chip">TP: ${fmtPrice(p?.tp)}</span>
                  </div>
                  <div className={`tradePnl ${pnlClass(pnl)}`}>
                    {pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%
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
