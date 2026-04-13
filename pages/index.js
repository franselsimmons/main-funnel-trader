import Link from "next/link";

export default function Home() {
  return (
    <div className="page">
      <h1 className="headline">CryptoCroc V5</h1>
      <p className="sub">Quant Trading System</p>

      <div className="navGrid">
        <Link href="/bull" className="navCard">Bull Market</Link>
        <Link href="/bear" className="navCard">Bear Market</Link>
        <Link href="/analyse" className="navCard">System Analyse</Link>
      </div>
    </div>
  );
}