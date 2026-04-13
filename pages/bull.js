import { useEffect, useState } from "react";
import Link from "next/link";

export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    fetch(`/api/state?mode=${mode}`).then(r=>r.json()).then(setData);

    const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");
    ws.onmessage = () => {
      fetch(`/api/state?mode=${mode}`).then(r=>r.json()).then(setData);
    };
    return () => ws.close();
  }, []);

  function confColor(v){
    if(v>80) return "#22C55E";
    if(v>60) return "#3B82F6";
    if(v>40) return "#F59E0B";
    return "#EF4444";
  }

  function renderStage(arr){
    if(!arr?.length) return <div className="empty">Geen coins</div>;

    return arr.map(c=>{
      const conf = Math.round(c.aiScore||0);
      return (
        <div className="coin" key={c.symbol} onClick={()=>setSelected(c)}>
          <div className="coinTop">
            <div>
              <div className="symbol">{c.symbol}</div>
              <div className="price">${c.price}</div>
            </div>
            <div>{conf}/100</div>
          </div>

          <div className="confBarWrap">
            <div className="confBar" style={{
              width:conf+"%",
              background:confColor(conf)
            }} />
          </div>

          <div className="meta">
            <span>mom {c.momentum}%</span>
            <span>spread {c.ob?.spreadPct}%</span>
          </div>
        </div>
      )
    })
  }

  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">BULL SCANNER</div>
          <div className="sub">
            Last scan: {data?.ts?new Date(data.ts).toLocaleString():"—"}
          </div>

          <div className="regimeBar">
            <div className="regimeFill"
              style={{
                width:Math.abs(data?.regime?.score||0)+"%",
                background:(data?.regime?.score||0)>0?"#22C55E":"#EF4444"
              }}
            />
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

      {selected && (
        <div className="modalBackdrop" onClick={()=>setSelected(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modalTitle">{selected.symbol}</div>

            <div className="modalSection">
              <div className="kvRow"><span>Price</span><span>{selected.price}</span></div>
              <div className="kvRow"><span>Momentum</span><span>{selected.momentum}%</span></div>
              <div className="kvRow"><span>AI Score</span><span>{selected.aiScore}</span></div>
              <div className="kvRow"><span>Spread</span><span>{selected.ob?.spreadPct}%</span></div>
              <div className="kvRow"><span>Depth</span><span>{selected.ob?.depthMinUsd1p}</span></div>
            </div>

            <button className="btn closeBtn" onClick={()=>setSelected(null)}>
              Sluiten
            </button>
          </div>
        </div>
      )}
    </>
  )
}