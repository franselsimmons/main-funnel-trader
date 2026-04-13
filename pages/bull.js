import { useEffect, useState } from "react";

export default function Bull() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  const renderStage = (arr) =>
    arr?.length
      ? arr.map(c => (
          <div className="coin" key={c.symbol}>
            <div className="coinTop">
              <div>
                <div className="symbol">{c.symbol}</div>
                <div className="price">${Number(c.price).toFixed(4)}</div>
              </div>
              <div className="score">{c.aiScore}/100</div>
            </div>
            <div className="meta">
              <span>mom {Number(c.momentum).toFixed(2)}%</span>
              <span>volAcc {Number(c.volAcc).toFixed(2)}</span>
            </div>
            {c.tradePlan && (
              <div className="plan">
                SL ${c.tradePlan.sl.toFixed(4)} • TP ${c.tradePlan.tp.toFixed(4)}
              </div>
            )}
          </div>
        ))
      : <div className="empty">Geen coins</div>;

  return (
    <>
      <header className="topbar">
        <div className="brand">BULL MARKET</div>
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