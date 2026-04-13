import { useEffect, useState, useRef } from "react";
import Link from "next/link";

export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    fetch(`/api/state?mode=${mode}`).then(r=>r.json()).then(setData);
  }, []);

  useEffect(() => {
    if (!selected || !canvasRef.current) return;

    const ctx = canvasRef.current.getContext("2d");
    ctx.clearRect(0,0,600,300);

    const bids = selected.ob?.bids || [];
    const asks = selected.ob?.asks || [];

    ctx.strokeStyle = "#22C55E";
    ctx.beginPath();
    bids.forEach((b,i)=>{
      ctx.lineTo(i*10,300-b[1]);
    });
    ctx.stroke();

    ctx.strokeStyle = "#EF4444";
    ctx.beginPath();
    asks.forEach((a,i)=>{
      ctx.lineTo(i*10,300-a[1]);
    });
    ctx.stroke();

  }, [selected]);

  function renderStage(arr){
    if(!arr?.length) return <div className="empty">Geen coins</div>;

    return arr.map(c=>{
      const conf = Math.round(c.aiScore||0);
      return(
        <div className="coin fadeUp" key={c.symbol} onClick={()=>setSelected(c)}>
          <div className="coinTop">
            <div>
              <div className="symbol">{c.symbol}</div>
              <div className="price">${c.price}</div>
            </div>
            <div>{conf}/100</div>
          </div>

          <div className="confBarWrap">
            <div className="confBar animateWidth"
              style={{
                width:conf+"%",
                background:conf>70?"#22C55E":"#F59E0B"
              }}
            />
          </div>
        </div>
      )
    })
  }

  return(
    <>
      <header className="topbar">
        <div>
          <div className="brand">BULL SCANNER</div>
          <div className="sub">
            Last scan: {data?.ts?new Date(data.ts).toLocaleString():"—"}
          </div>

          <div className="regimeBar">
            <div className="regimeFill animateWidth"
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
      </main>

      {selected && (
        <div className="modalBackdrop" onClick={()=>setSelected(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modalTitle">{selected.symbol} Orderbook</div>
            <canvas ref={canvasRef} width={600} height={300} />
            <button className="btn closeBtn" onClick={()=>setSelected(null)}>
              Sluiten
            </button>
          </div>
        </div>
      )}
    </>
  )
}