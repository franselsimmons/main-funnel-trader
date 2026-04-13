import { useEffect, useState } from "react";
import Link from "next/link";

export default function Analyse() {
  const [data, setData] = useState(null);

  async function load() {
    const r = await fetch("/api/metrics", { cache: "no-store" });
    const j = await r.json();
    setData(j);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">ANALYSE</div>
          <div className="sub">
            Funnel conversie & performance metrics
          </div>
        </div>
        <div className="nav">
          <Link href="/bull"><button className="btn">Bull</button></Link>
          <Link href="/bear"><button className="btn">Bear</button></Link>
          <Link href="/analyse"><button className="btn active">Analyse</button></Link>
          <Link href="/trade"><button className="btn">Trade</button></Link>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">TRADE PERFORMANCE</div>
          <div className="kvRow"><span>Total Trades</span><span>{data?.trades?.total || 0}</span></div>
          <div className="kvRow"><span>Winrate</span><span>{data?.trades?.winrate || 0}%</span></div>
          <div className="kvRow"><span>Avg PnL</span><span>{data?.trades?.avgPnlPct || 0}%</span></div>
        </section>

        <section className="panel">
          <div className="panelTitle">FUNNEL CONVERSION</div>
          <div className="kvRow"><span>Radar → Warmup</span><span>{data?.conversion?.r2w || 0}%</span></div>
          <div className="kvRow"><span>Warmup → Setup</span><span>{data?.conversion?.w2s || 0}%</span></div>
          <div className="kvRow"><span>Setup → Entry</span><span>{data?.conversion?.s2e || 0}%</span></div>
        </section>
      </main>
    </>
  );
}