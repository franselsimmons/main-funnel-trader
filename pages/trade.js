import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function arr(v) {
  return Array.isArray(v) ? v : [];
}
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
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
      fetch("/api/positions", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => j?.positions || [])
        .catch(() => []),
      fetch("/api/state?mode=bull", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/state?mode=bear", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([p, b1, b2]) => {
      setPositions(p);
      setBull(b1);
      setBear(b2);
    });
  }, []);

  const bullPositions = useMemo(() => splitPositionsByMode(positions, "bull"), [positions]);
  const bearPositions = useMemo(() => splitPositionsByMode(positions, "bear"), [positions]);

  const bullEntry = bull?.funnel?.entry_ready?.length || 0;
  const bearEntry = bear?.funnel?.entry_ready?.length || 0;

  const bullAvgPnl = bullPositions.length
    ? bullPositions.reduce((a, p) => a + n(p?.pnlPct ?? p?.pnl, 0), 0) / bullPositions.length
    : 0;

  const bearAvgPnl = bearPositions.length
    ? bearPositions.reduce((a, p) => a + n(p?.pnlPct ?? p?.pnl, 0), 0) / bearPositions.length
    : 0;

  let improvement = "Trade tunnel oogt gezond op dit snapshot.";
  if (bullEntry + bearEntry > 0 && positions.length === 0) {
    improvement =
      "Er zijn entry-ready signals maar geen open trades. Entry tolerance / live spread reject / websocket execution kunnen te streng zijn.";
  } else if (positions.length > 0 && bullAvgPnl + bearAvgPnl < 0) {
    improvement =
      "Trades staan gemiddeld negatief. Check entry timing (te laat), SL/TP afstand en spread reject.";
  } else if (bullEntry === 0 && bearEntry === 0) {
    improvement =
      "Geen entry-ready flow. Grootste winst zit nu in setup → entry conversie (OB thresholds).";
  }

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">TRADE TUNNEL</div>
          <div className="brandMeta">Entry flow, open posities en execution health</div>
        </div>

        <nav className="navRow">
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/analyse" className="navBtn">Analyse</Link>
          <Link href="/trade" className="navBtn active">Trade</Link>
        </nav>
      </header>

      <main className="analysisPage">
        <div className="compareGrid">
          <div className="compareCard">
            <div className="compareTitle">Bull trade tunnel</div>
            <div className="compareMeta">
              Entry ready <strong>{bullEntry}</strong> • Open <strong>{bullPositions.length}</strong> • Avg PnL{" "}
              <strong className={pnlClass(bullAvgPnl)}>
                {bullAvgPnl > 0 ? "+" : ""}{bullAvgPnl.toFixed(2)}%
              </strong>
            </div>
          </div>

          <div className="compareCard">
            <div className="compareTitle">Bear trade tunnel</div>
            <div className="compareMeta">
              Entry ready <strong>{bearEntry}</strong> • Open <strong>{bearPositions.length}</strong> • Avg PnL{" "}
              <strong className={pnlClass(bearAvgPnl)}>
                {bearAvgPnl > 0 ? "+" : ""}{bearAvgPnl.toFixed(2)}%
              </strong>
            </div>
          </div>
        </div>

        <section className="analysisSection">
          <div className="analysisSectionTitle">Wat verbeteren</div>
          <div className="adviceBox">
            <div className="adviceItem">{improvement}</div>
          </div>
        </section>

        <section className="analysisSection">
          <div className="analysisSectionTitle">Open posities</div>
          <div className="tradeCardList">
            {!positions.length && <div className="emptyState">Geen open posities</div>}

            {positions.map((p, idx) => {
              const pnl = n(p?.pnlPct ?? p?.pnl, 0);
              return (
                <div className="tradeRow" key={`${p.symbol || "pos"}-${idx}`}>
                  <div>
                    <div className="coinSymbol">{p.symbol || "—"}</div>
                    <div className="coinName">
                      {String(p?.side || "").toUpperCase()} • mode {String(p?.mode || "—").toUpperCase()}
                    </div>
                  </div>

                  <div className="tradeMid">
                    <span>entry ${fmtPrice(p?.entry)}</span>
                    <span>sl ${fmtPrice(p?.sl)}</span>
                    <span>tp ${fmtPrice(p?.tp)}</span>
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