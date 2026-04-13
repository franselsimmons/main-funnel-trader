import { useEffect, useState } from "react";
import Link from "next/link";

export default function Trade() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/trades")
      .then(r => r.json())
      .then(setData);
  }, []);

  function pnlColor(v) {
    if (v > 0) return "#22C55E";
    if (v < 0) return "#EF4444";
    return "#94A3B8";
  }

  return (
    <>
      <header className="scannerHeader">
        <div className="scannerTitle">TRADE DESK</div>

        <div className="navButtons">
          <Link href="/bull"><button className="navBtn">Bull</button></Link>
          <Link href="/bear"><button className="navBtn">Bear</button></Link>
          <Link href="/analyse"><button className="navBtn">Analyse</button></Link>
          <Link href="/trade"><button className="navBtn active">Trade</button></Link>
        </div>
      </header>

      <main className="tradeGrid">
        {data?.positions?.map(p => (
          <div key={p.id} className="tradeCard">
            <div className="tradeTop">
              <div>{p.symbol}</div>
              <div style={{ color: pnlColor(p.pnlPct) }}>
                {p.pnlPct}%
              </div>
            </div>

            <div className="tradeMeta">
              Entry {p.entry}
              <br />
              SL {p.sl}
              <br />
              TP {p.tp}
            </div>
          </div>
        ))}
      </main>
    </>
  );
}