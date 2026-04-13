import Link from "next/link";

export default function Home() {
  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">Funnel Trader</div>
          <div className="sub">
            Institutional AI Crypto Execution System
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
        <div className="heroTitle fadeUp">
          Institutional Funnel Engine
        </div>

        <div className="heroSub fadeUp delay1">
          Regime detection • Adaptive thresholds • Orderbook gating • AI ranking • Live execution
        </div>
      </section>
    </>
  );
}