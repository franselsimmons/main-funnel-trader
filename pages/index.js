import Link from "next/link";

export default function Home() {
  return (
    <div className="homeWrap">
      <div className="homeHero">
        <h1>FUNNEL TRADER</h1>
        <p>Institutional AI Market Scanner</p>
      </div>

      <div className="homeGrid">
        <Link href="/bull">
          <div className="homeCard">
            <h2>BULL MARKET</h2>
            <p>Long side opportunities</p>
          </div>
        </Link>

        <Link href="/bear">
          <div className="homeCard">
            <h2>BEAR MARKET</h2>
            <p>Short side opportunities</p>
          </div>
        </Link>

        <Link href="/analyse">
          <div className="homeCard">
            <h2>ANALYSE</h2>
            <p>Heatmaps & Equity</p>
          </div>
        </Link>

        <Link href="/trade">
          <div className="homeCard">
            <h2>TRADE ENGINE</h2>
            <p>Live Positions</p>
          </div>
        </Link>
      </div>
    </div>
  );
}