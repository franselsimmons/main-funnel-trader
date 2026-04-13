import { useEffect, useState } from "react";
import Link from "next/link";

export default function Bull() {
  return <ScannerPage mode="bull" />;
}

function ScannerPage({ mode }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, []);

  function load() {
    fetch(`/api/state?mode=${mode}`)
      .then(r => r.json())
      .then(setData);
  }

  function pctColor(v) {
    if (v > 0) return "#22C55E";
    if (v < 0) return "#EF4444";
    return "#94A3B8";
  }

  function confColor(v) {
    if (v >= 80) return "#22C55E";
    if (v >= 60) return "#3B82F6";
    if (v >= 40) return "#F59E0B";
    return "#EF4444";
  }

  function Stage({ title, items }) {
    return (
      <section className="stagePanel">
        <div className="stageHeader">
          <div>{title}</div>
          <div className="stageCount">{items?.length || 0}</div>
        </div>

        {!items?.length && <div className="empty">Geen coins</div>}

        {items?.map(c => {
          const conf = Math.round(c.aiScore || 0);

          return (
            <div
              key={c.symbol}
              className="coinCard"
              onClick={() => setSelected(c)}
            >
              <div className="coinRow">
                <div>
                  <div className="symbol">{c.symbol}</div>
                  <div className="price">${c.price}</div>
                </div>
                <div className="confText">{conf}/100</div>
              </div>

              <div className="confBarWrap">
                <div
                  className="confBar"
                  style={{
                    width: conf + "%",
                    background: confColor(conf)
                  }}
                />
              </div>

              <div className="coinMeta">
                <span style={{ color: pctColor(c.momentum) }}>
                  mom {c.momentum}%
                </span>
                <span>spread {c.ob?.spreadPct}%</span>
              </div>
            </div>
          );
        })}
      </section>
    );
  }

  return (
    <>
      <Header data={data} mode={mode} />

      <main className="scannerGrid">
        <Stage title="ENTRY READY" items={data?.funnel?.entry_ready} />
        <Stage title="SETUP" items={data?.funnel?.setup} />
        <Stage title="WARMUP" items={data?.funnel?.warmup} />
        <Stage title="RADAR" items={data?.funnel?.radar} />
      </main>

      {selected && (
        <Modal coin={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}