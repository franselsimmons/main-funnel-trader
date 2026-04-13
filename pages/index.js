import Link from "next/link";

export default function Home() {
  return (
    <div className="container">
      <h1>CryptoCroc V5</h1>
      <p>Self-Optimizing Trading System</p>

      <div className="grid">
        <Link href="/bull" className="card">
          <h2>Bull Scanner</h2>
          <p>View bull market funnel</p>
        </Link>

        <Link href="/bear" className="card">
          <h2>Bear Scanner</h2>
          <p>View bear market funnel</p>
        </Link>

        <Link href="/trade" className="card">
          <h2>Open Trades</h2>
          <p>See active positions</p>
        </Link>

        <Link href="/analyse" className="card">
          <h2>System Analyse</h2>
          <p>Performance & optimization</p>
        </Link>
      </div>
    </div>
  );
}