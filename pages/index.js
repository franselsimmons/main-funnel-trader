import Link from "next/link";

export default function Home() {
  return (
    <div className="layout">
      <h1 className="title">CryptoCroc V5</h1>
      <p className="subtitle">Self-Optimizing Trading Engine</p>

      <div className="grid">
        <Link href="/bull" className="card">
          <h2>🚀 Bull Scanner</h2>
          <p>Live bull funnel</p>
        </Link>

        <Link href="/bear" className="card">
          <h2>📉 Bear Scanner</h2>
          <p>Live bear funnel</p>
        </Link>

        <Link href="/trade" className="card">
          <h2>💰 Open Trades</h2>
          <p>Active positions</p>
        </Link>

        <Link href="/analyse" className="card">
          <h2>🧠 System Analyse</h2>
          <p>Performance & AI optimization</p>
        </Link>
      </div>
    </div>
  );
}