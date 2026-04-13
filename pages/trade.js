import { useEffect, useState } from "react";
import Link from "next/link";

export default function Trade(){
  const [positions,setPositions]=useState([]);

  useEffect(()=>{
    function load(){
      fetch("/api/positions").then(r=>r.json()).then(j=>{
        setPositions(j.positions||[]);
      });
    }

    load();
    const t=setInterval(load,5000);
    return()=>clearInterval(t);
  },[]);

  return(
    <>
      <header className="topbar">
        <div>
          <div className="brand">TRADE ENGINE</div>
          <div className="sub">Live positions</div>
        </div>

        <div className="nav">
          <Link href="/bull"><button className="btn">Bull</button></Link>
          <Link href="/bear"><button className="btn">Bear</button></Link>
          <Link href="/analyse"><button className="btn">Analyse</button></Link>
          <Link href="/trade"><button className="btn active">Trade</button></Link>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">OPEN POSITIONS</div>

          {positions.map(p=>{
            const pnlClass = p.pnlPct>=0?"pnlPos":"pnlNeg";
            return(
              <div className="coin" key={p.symbol}>
                <div className="coinTop">
                  <div>
                    <div className="symbol">{p.symbol}</div>
                    <div className="price">Entry {p.entry}</div>
                  </div>
                  <div className={pnlClass}>{p.pnlPct}%</div>
                </div>

                <div className="meta">
                  <span>SL {p.sl}</span>
                  <span>TP {p.tp}</span>
                  <span>Status {p.status}</span>
                </div>
              </div>
            )
          })}
        </section>
      </main>
    </>
  )
}