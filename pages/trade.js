import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function fmtPrice(v) {
  const x = n(v);
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

export default function Trade() {
  const [positions, setPositions] = useState([]);

  async function load() {
    try {
      const r = await fetch("/api/positions", { cache: "no-store" });
      const j = await r.json();
      setPositions(j?.positions || []);
    } catch {}
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 10000); // live refresh
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => {
    if (!positions.length) return { avg: 0 };

    const avg =
      positions.reduce((a, p) => {
        const pnl =
          ((p.side === "LONG"
            ? p.lastPrice - p.entry
            : p.entry - p.lastPrice) /
            p.entry) *
          100;

        return a + pnl;
      }, 0) / positions.length;

    return { avg };
  }, [positions]);

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">TRADE TUNNEL</div>
          <div className="brandMeta">
            Open trades: {positions.length} • Avg PnL{" "}
            <span className={pnlClass(stats.avg)}>
              {stats.avg > 0 ? "+" : ""}
              {stats.avg.toFixed(2)}%
            </span>
          </div>
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
        <section className="analysisSection">
          <div className="analysisSectionTitle">Open trades</div>

          <div className="tradeCardList">
            {!positions.length && (
              <div className="emptyState">Geen open trades</div>
            )}

            {positions.map((p, idx) => {
              const pnl =
                ((p.side === "LONG"
                  ? p.lastPrice - p.entry
                  : p.entry - p.lastPrice) /
                  p.entry) *
                100;

              return (
                <div className="tradeRow" key={`${p.symbol}-${idx}`}>
                  <div>
                    <div className="coinSymbol">{p.symbol}</div>
                    <div className="coinName">
                      {p.side} • {p.mode}
                    </div>
                  </div>

                  <div className="tradeMid">
                    <span>entry ${fmtPrice(p.entry)}</span>
                    <span>sl ${fmtPrice(p.sl)}</span>
                    <span>tp ${fmtPrice(p.tp)}</span>
                  </div>

                  <div className={`tradePnl ${pnlClass(pnl)}`}>
                    {pnl > 0 ? "+" : ""}
                    {pnl.toFixed(2)}%
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