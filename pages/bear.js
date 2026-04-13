import { useEffect, useState } from "react";
import Link from "next/link";

export default function Bear() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  async function load() {
    try {
      const r = await fetch("/api/state?mode=bear", { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  function renderStage(arr) {
    if (!arr || !arr.length) {
      return <div className="empty">Geen coins</div>;
    }

    return arr.map((c) => (
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

        {c.tradePlan && (
          <div className="plan">
            SL ${c.tradePlan.sl?.toFixed(6)} •
            TP ${c.tradePlan.tp?.toFixed(6)}
          </div>
        )}
      </div>
    ));
  }

  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">BEAR SCANNER</div>
          <div className="sub">
            Last scan: {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
            {" • "}
            Regime: {data?.regime?.regime || "—"}
          </div>
        </div>

        <div className="nav">
          <Link href="/bull"><button className="btn">Bull</button></Link>
          <Link href="/bear"><button className="btn active">Bear</button></Link>
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

      {selected && (
        <div className="modalBackdrop" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalTitle">{selected.symbol}</div>

            <div className="modalSection">
              <div className="kvRow"><span>Price</span><span>${selected.price}</span></div>
              <div className="kvRow"><span>Momentum</span><span>{selected.momentum}%</span></div>
              <div className="kvRow"><span>Volume Accel</span><span>{selected.volAcc}</span></div>
              <div className="kvRow"><span>AI Score</span><span>{selected.aiScore}</span></div>
              <div className="kvRow"><span>Spread</span><span>{selected.ob?.spreadPct}%</span></div>
              <div className="kvRow"><span>Depth</span><span>${selected.ob?.depthMinUsd1p}</span></div>
              <div className="kvRow"><span>OB Score</span><span>{selected.ob?.score}</span></div>
            </div>

            {selected.tradePlan && (
              <div className="modalSection">
                <div className="kvRow"><span>Entry</span><span>${selected.tradePlan.entry}</span></div>
                <div className="kvRow"><span>SL</span><span>${selected.tradePlan.sl}</span></div>
                <div className="kvRow"><span>TP</span><span>${selected.tradePlan.tp}</span></div>
                <div className="kvRow"><span>RR</span><span>{selected.tradePlan.rr}</span></div>
              </div>
            )}

            <button className="btn closeBtn" onClick={() => setSelected(null)}>
              Sluiten
            </button>
          </div>
        </div>
      )}
    </>
  );
}