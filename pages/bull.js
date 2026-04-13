import { useEffect, useState } from "react";
import Link from "next/link";

export default function Bull() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  async function load() {
    const r = await fetch("/api/state?mode=bull", { cache: "no-store" });
    const j = await r.json();
    setData(j);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  function renderStage(arr) {
    if (!arr || !arr.length) return <div className="empty">Geen coins</div>;

    return arr.map(c => (
      <div className="coin" key={c.symbol} onClick={() => setSelected(c)}>
        <div className="coinTop">
          <div>
            <div className="symbol">{c.symbol}</div>
            <div className="price">${Number(c.price).toFixed(6)}</div>
          </div>
          <div className="score">{Math.round(c.aiScore || 0)}/100</div>
        </div>

        <div className="meta">
          <span>mom {Number(c.momentum).toFixed(2)}%</span>
          <span>volAcc {Number(c.volAcc).toFixed(2)}</span>
          <span>spread {Number(c.ob?.spreadPct || 0).toFixed(2)}%</span>
        </div>
      </div>
    ));
  }

  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">BULL SCANNER</div>
          <div className="sub">
            Last scan: {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
          </div>
        </div>
        <div className="nav">
          <Link href="/bull"><button className="btn active">Bull</button></Link>
          <Link href="/bear"><button className="btn">Bear</button></Link>
          <Link href="/analyse"><button className="btn">Analyse</button></Link>
          <Link href="/trade"><button className="btn">Trade</button></Link>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">ENTRY READY</div>
          {renderStage(data?.funnel?.entry_ready)}
        </section>
        <section className="panel">
          <div className="panelTitle">SETUP</div>
          {renderStage(data?.funnel?.setup)}
        </section>
        <section className="panel">
          <div className="panelTitle">WARMUP</div>
          {renderStage(data?.funnel?.warmup)}
        </section>
        <section className="panel">
          <div className="panelTitle">RADAR</div>
          {renderStage(data?.funnel?.radar)}
        </section>
      </main>
    </>
  );
}