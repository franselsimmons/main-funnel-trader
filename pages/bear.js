import { useEffect, useState } from "react";

export default function Bear() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const r = await fetch("/api/state?mode=bear", {
        cache: "no-store",
      });

      const j = await r.json();

      if (!r.ok) {
        throw new Error(j?.error || "API error");
      }

      setData(j);
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  function renderStage(arr) {
    if (!arr || arr.length === 0) {
      return <div className="empty">Geen coins</div>;
    }

    return arr.map((c) => (
      <div className="coin" key={c.symbol}>
        <div className="coinTop">
          <div>
            <div className="symbol">{c.symbol}</div>
            <div className="price">
              ${Number(c.price || 0).toFixed(6)}
            </div>
          </div>

          <div className="score">
            {Math.round(Number(c.aiScore || 0))}/100
          </div>
        </div>

        <div className="meta">
          <span>mom {Number(c.momentum || 0).toFixed(2)}%</span>
          <span>volAcc {Number(c.volAcc || 0).toFixed(2)}</span>
          <span>spread {Number(c.ob?.spreadPct || 0).toFixed(2)}%</span>
        </div>

        {c.tradePlan && (
          <div className="plan">
            Entry ${Number(c.tradePlan.entry).toFixed(6)}
            {" • "}
            SL ${Number(c.tradePlan.sl).toFixed(6)}
            {" • "}
            TP ${Number(c.tradePlan.tp).toFixed(6)}
          </div>
        )}
      </div>
    ));
  }

  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">BEAR MARKET</div>
          <div className="sub">
            Regime: {data?.regime?.regime || "—"}{" "}
            ({data?.regime?.score || 0})
          </div>
        </div>
      </header>

      {error && (
        <div style={{ padding: 40, color: "#EF4444" }}>
          Error: {error}
        </div>
      )}

      {!data && !error && (
        <div style={{ padding: 40 }}>Laden…</div>
      )}

      {data && (
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
      )}
    </>
  );
}