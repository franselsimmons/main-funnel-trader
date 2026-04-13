import { useEffect, useState } from "react";
import Link from "next/link";

export default function Trade(){
  const [positions,setPositions]=useState([]);

  useEffect(()=>{
    fetch("/api/positions").then(r=>r.json()).then(j=>{
      setPositions(j.positions||[]);
    });
  },[]);

  return(
    <>
      <header className="topbar">
        <div>
          <div className="brand">TRADE ENGINE</div>
          <div className="sub">Live Positions</div>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">OPEN POSITIONS</div>

          {positions.map(p=>{
            const pnlClass = p.pnlPct>=0?"pnlPos":"pnlNeg";
            return(
              <div className="coin fadeUp" key={p.symbol}>
                <div className="coinTop">
                  <div>
                    <div className="symbol">{p.symbol}</div>
                    <div className="price">Entry {p.entry}</div>
                  </div>
                  <div className={pnlClass}>{p.pnlPct}%</div>
                </div>
              </div>
            )
          })}
        </section>
      </main>
    </>
  )
}