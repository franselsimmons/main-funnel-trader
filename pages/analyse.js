import { useEffect, useState } from "react";
import Link from "next/link";

export default function Analyse(){
  const [data,setData]=useState(null);

  useEffect(()=>{
    fetch("/api/metrics").then(r=>r.json()).then(setData);
  },[]);

  return(
    <>
      <header className="topbar">
        <div>
          <div className="brand">ANALYSE</div>
          <div className="sub">Funnel leaks & performance</div>
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
          <div className="panelTitle">FUNNEL LEAKS</div>

          <div className={`kvRow ${(data?.conversion?.r2w||0)<20?"leakBad":"leakGood"}`}>
            <span>Radar → Warmup</span>
            <span>{data?.conversion?.r2w||0}%</span>
          </div>

          <div className={`kvRow ${(data?.conversion?.w2s||0)<20?"leakBad":"leakGood"}`}>
            <span>Warmup → Setup</span>
            <span>{data?.conversion?.w2s||0}%</span>
          </div>

          <div className={`kvRow ${(data?.conversion?.s2e||0)<20?"leakBad":"leakGood"}`}>
            <span>Setup → Entry</span>
            <span>{data?.conversion?.s2e||0}%</span>
          </div>
        </section>
      </main>
    </>
  )
}