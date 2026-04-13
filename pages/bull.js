import { useEffect, useState } from "react";
import Link from "next/link";

export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, []);

  function load() {
    fetch(`/api/state?mode=${mode}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }

  function confColor(v) {
    if (v >= 80) return "#22C55E";
    if (v >= 60) return "#3B82F6";
    if (v >= 40) return "#F59E0B";
    return "#EF4444";
  }

  function Stage({ title, items }) {
    const count = items?.length || 0;

    return (
      <section className="stagePanel">
        <div className="stageHeader">
          <div>{title}</div>
          <div className="stageCount">{count}</div>
        </div>

        {!count && <div className="empty">Geen coins</div>}

        {items?.map(c => {
          const conf = Math.round(c.aiScore || 0);

          return (
            <div key={c.symbol} className="coinCard">
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
                <span>mom {c.momentum}%</span>
                <span>volAcc {c.volumeAcceleration}</span>
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
      <header className="scannerHeader">
        <div>
          <div className="scannerTitle">SCANNER</div>
          <div className="scannerSub">
            Last scan: {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
          </div>

          <div className="regimeWrap">
            <div className="regimeBar">
              <div
                className="regimeFill"
                style={{
                  width: Math.abs(data?.regime?.score || 0) + "%",
                  background:
                    (data?.regime?.score || 0) >= 0
                      ? "#22C55E"
                      : "#EF4444"
                }}
              />
            </div>

            <div className="regimeLabel">
              {data?.regime?.label || "NEUTRAL"}
            </div>
          </div>
        </div>

        <div className="navButtons">
          <Link href="/bull"><button className="navBtn active">Bull</button></Link>
          <Link href="/bear"><button className="navBtn">Bear</button></Link>
          <Link href="/analyse"><button className="navBtn">Analyse</button></Link>
          <Link href="/trade"><button className="navBtn">Trade</button></Link>
        </div>
      </header>

      <main className="scannerGrid">
        <Stage title="ENTRY READY" items={data?.funnel?.entry_ready} />
        <Stage title="SETUP" items={data?.funnel?.setup} />
        <Stage title="WARMUP" items={data?.funnel?.warmup} />
        <Stage title="RADAR" items={data?.funnel?.radar} />
      </main>
    </>
  );
}