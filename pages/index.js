import Link from "next/link";

export default function Home() {
  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">Funnel Trader</div>
          <div className="sub">
            AI-Driven Multi-Layer Crypto Execution System
          </div>
        </div>
        <div className="nav">
          <Link href="/bull"><button className="btn">Bull</button></Link>
          <Link href="/bear"><button className="btn">Bear</button></Link>
          <Link href="/analyse"><button className="btn">Analyse</button></Link>
          <Link href="/trade"><button className="btn">Trade</button></Link>
        </div>
      </header>

      <section className="hero">
        <div className="heroTitle">
          Institutional Crypto Funnel Engine
        </div>

        <div className="heroSub">
          Macro regime detection, adaptive scoring, orderbook gating,
          AI ranking and automated execution — gebouwd als
          een professioneel trading systeem.
        </div>

        <div className="heroGrid">
          <Link href="/bull">
            <div className="heroCard">
              <h3>Bull Market Scanner</h3>
              <p>Long setups met momentum-gebaseerde filtering en orderboek controle.</p>
            </div>
          </Link>

          <Link href="/bear">
            <div className="heroCard">
              <h3>Bear Market Scanner</h3>
              <p>Short bias detectie met spread & depth gating.</p>
            </div>
          </Link>

          <Link href="/analyse">
            <div className="heroCard">
              <h3>Performance Analyse</h3>
              <p>Meet conversieratio’s, leaks en optimaliseer je filters.</p>
            </div>
          </Link>

          <Link href="/trade">
            <div className="heroCard">
              <h3>Execution Engine</h3>
              <p>Live trade management, SL/TP tracking en positie overzicht.</p>
            </div>
          </Link>
        </div>
      </section>
    </>
  );
}