import Link from "next/link";

export default function Home() {
  return (
    <>
      <header className="topbar">
        <div>
          <div className="brand">Funnel Intelligence</div>
          <div className="sub">Institutional Market Scanner</div>
        </div>
      </header>

      <div style={{padding:40}}>
        <div className="panel">
          <h2 style={{marginBottom:20}}>Navigation</h2>
          <Link href="/bull"><button className="btn">Bull Scanner</button></Link>
          <Link href="/bear"><button className="btn">Bear Scanner</button></Link>
          <Link href="/analyse"><button className="btn">Analyse</button></Link>
          <Link href="/trade"><button className="btn">Trade Desk</button></Link>
        </div>
      </div>
    </>
  );
}