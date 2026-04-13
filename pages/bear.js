import { useEffect, useState, useRef } from "react";
import Link from "next/link";

export default function Bear() {
  const mode = "bear";

  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const canvasRef = useRef(null);

  // ===== LOAD DATA =====
  useEffect(() => {
    load();

    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  function load() {
    fetch(`/api/state?mode=${mode}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }

  // ===== ORDERBOOK DEPTH DRAW =====
  useEffect(() => {
    if (!selected || !canvasRef.current) return;

    const ctx = canvasRef.current.getContext("2d");
    const w = 600;
    const h = 300;

    ctx.clearRect(0, 0, w, h);

    const bids = selected?.ob?.bids || [];
    const asks = selected?.ob?.asks || [];

    // Normalize
    const maxVol = Math.max(
      ...bids.map(b => b[1] || 0),
      ...asks.map(a => a[1] || 0),
      1
    );

    // Draw bids (green)
    ctx.beginPath();
    ctx.strokeStyle = "#22C55E";
    bids.forEach((b, i) => {
      const x = (i / bids.length) * w;
      const y = h - (b[1] / maxVol) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw asks (red)
    ctx.beginPath();
    ctx.strokeStyle = "#EF4444";
    asks.forEach((a, i) => {
      const x = (i / asks.length) * w;
      const y = h - (a[1] / maxVol) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

  }, [selected]);

  // ===== CONFIDENCE COLOR =====
  function confColor(v) {
    if (v > 80) return "#22C55E";
    if (v > 60) return "#3B82F6";
    if (v > 40) return "#F59E0B";
    return "#EF4444";
  }

  function renderStage(arr) {
    if (!arr?.length) return <div className="empty">Geen coins</div>;

    return arr.map(c => {
      const conf = Math.round(c.aiScore || 0);

      return (
        <div
          key={c.symbol}
          className="coin fadeUp"
          onClick={() => setSelected(c)}
        >
          <div className="coinTop">
            <div>
              <div className="symbol">{c.symbol}</div>
              <div className="price">${c.price}</div>
            </div>
            <div>{conf}/100</div>
          </div>

          <div className="confBarWrap">
            <div
              className="confBar animateWidth"
              style={{
                width: conf + "%",
                background: confColor(conf)
              }}
            />
          </div>

          <div className="meta">
            <span>mom {c.momentum}%</span>
            <span>spread {c.ob?.spreadPct}%</span>
          </div>

          {c.tradePlan && (
            <div className="plan">
              SL {c.tradePlan.sl} • TP {c.tradePlan.tp}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <>
      {/* ===== TOPBAR ===== */}
      <header className="topbar">
        <div>
          <div className="brand">BEAR SCANNER</div>
          <div className="sub">
            Last scan:{" "}
            {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
          </div>

          {/* Regime meter */}
          <div className="regimeBar">
            <div
              className="regimeFill animateWidth"
              style={{
                width: Math.abs(data?.regime?.score || 0) + "%",
                background:
                  (data?.regime?.score || 0) < 0
                    ? "#EF4444"
                    : "#22C55E"
              }}
            />
          </div>
        </div>

        <div className="nav">
          <Link href="/bull">
            <button className="btn">Bull</button>
          </Link>

          <Link href="/bear">
            <button className="btn active">Bear</button>
          </Link>

          <Link href="/analyse">
            <button className="btn">Analyse</button>
          </Link>

          <Link href="/trade">
            <button className="btn">Trade</button>
          </Link>
        </div>
      </header>

      {/* ===== GRID ===== */}
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

      {/* ===== MODAL ===== */}
      {selected && (
        <div
          className="modalBackdrop"
          onClick={() => setSelected(null)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modalTitle">
              {selected.symbol} • Bear Setup
            </div>

            <div className="modalSection">
              <div className="kvRow">
                <span>Price</span>
                <span>{selected.price}</span>
              </div>

              <div className="kvRow">
                <span>Momentum</span>
                <span>{selected.momentum}%</span>
              </div>

              <div className="kvRow">
                <span>AI Score</span>
                <span>{selected.aiScore}</span>
              </div>

              <div className="kvRow">
                <span>Spread</span>
                <span>{selected.ob?.spreadPct}%</span>
              </div>

              <div className="kvRow">
                <span>Depth</span>
                <span>{selected.ob?.depthMinUsd1p}</span>
              </div>
            </div>

            <div className="modalSection">
              <div className="panelTitle">ORDERBOOK DEPTH</div>
              <canvas
                ref={canvasRef}
                width={600}
                height={300}
              />
            </div>

            <button
              className="btn closeBtn"
              onClick={() => setSelected(null)}
            >
              Sluiten
            </button>
          </div>
        </div>
      )}
    </>
  );
}