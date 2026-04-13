import { useEffect, useState, useRef } from "react";
import Link from "next/link";

export default function Analyse(){
  const [data,setData]=useState(null);
  const canvasRef = useRef(null);

  useEffect(()=>{
    fetch("/api/metrics").then(r=>r.json()).then(setData);
  },[]);

  useEffect(()=>{
    if(!data || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    ctx.clearRect(0,0,800,300);

    let equity = 100;
    ctx.beginPath();
    ctx.moveTo(0,150);

    (data.trades?.history||[]).forEach((p,i)=>{
      equity += p;
      ctx.lineTo(i*10,150 - equity);
    });

    ctx.strokeStyle="#3B82F6";
    ctx.stroke();
  },[data]);

  return(
    <>
      <header className="topbar">
        <div>
          <div className="brand">ANALYSE</div>
          <div className="sub">Heatmap & Equity Curve</div>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">FUNNEL HEATMAP</div>

          <div style={{
            display:"grid",
            gridTemplateColumns:"repeat(4,1fr)",
            gap:"8px"
          }}>
            {Object.entries(data?.conversion||{}).map(([k,v])=>(
              <div key={k}
                style={{
                  padding:"12px",
                  background:`rgba(59,130,246,${v/100})`,
                  borderRadius:"6px"
                }}>
                {k} {v}%
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panelTitle">EQUITY CURVE</div>
          <canvas ref={canvasRef} width={800} height={300}/>
        </section>
      </main>
    </>
  )
}