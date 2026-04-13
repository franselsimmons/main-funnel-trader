import { useEffect, useState } from "react";
import Link from "next/link";

export default function Trade() {
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    fetch("/api/positions")
      .then(r => r.json())
      .then(d => setPositions(d.positions || []));
  }, []);

  function pnlColor(v) {
    if (v > 0) return "#22C55E";
    if (v < 0) return "#EF4444";
    return "#94A3B8";
  }

  return (
    <>
      <header className="scannerHeader">
        <div>
          <div className="scannerTitle">TRADE ENGINE</div>
          <div className="scannerSub">Live Positions</div>
        </div>

        <div className="navButtons">
          <Link href="/bull"><button className="navBtn">Bull</button></Link>
          <Link href="/bear"><button className="navBtn">Bear</button></Link>
          <Link href="/analyse"><button className="navBtn">Analyse</button></Link>
          <Link href="/trade"><button className="navBtn active">Trade</button></Link>
        </div>
      </header>

      <div className="tradeGrid">
        {!positions.length && (
          <div className="empty">No active positions</div>
        )}

        {positions.map(p => (
          <div key={p.symbol} className="tradeCard">
            <div className="tradeHeader">
              <strong>{p.symbol}</strong>
              <span style={{ color: pnlColor(p.pnl) }}>
                {p.pnl}%
              </span>
            </div>

            <div className="tradeMeta">
              <span>Entry {p.entry}</span>
              <span>SL {p.sl}</span>
              <span>TP {p.tp}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}