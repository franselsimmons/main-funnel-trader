import { useEffect, useState } from "react";
import Link from "next/link";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) return null;

  function analyzeStage(stage) {
    const arr = data.funnel?.[stage] || [];
    const count = arr.length;

    const avgConf =
      arr.reduce((a, b) => a + (b.aiScore || 0), 0) / (count || 1);

    const avgSpread =
      arr.reduce((a, b) => a + (b.ob?.spreadPct || 0), 0) / (count || 1);

    return { count, avgConf, avgSpread };
  }

  const radar = analyzeStage("radar");
  const warmup = analyzeStage("warmup");
  const setup = analyzeStage("setup");
  const entry = analyzeStage("entry_ready");

  function conversion(a, b) {
    if (!a.count) return 0;
    return ((b.count / a.count) * 100).toFixed(1);
  }

  return (
    <>
      <header className="scannerHeader">
        <div>
          <div className="scannerTitle">ANALYSE</div>
          <div className="scannerSub">
            Funnel Intelligence Dashboard
          </div>
        </div>

        <div className="navButtons">
          <Link href="/bull"><button className="navBtn">Bull</button></Link>
          <Link href="/bear"><button className="navBtn">Bear</button></Link>
          <Link href="/analyse"><button className="navBtn active">Analyse</button></Link>
          <Link href="/trade"><button className="navBtn">Trade</button></Link>
        </div>
      </header>

      <main className="analyseGrid">

        <div className="analyseCard">
          <h3>Radar</h3>
          <p>Coins: {radar.count}</p>
          <p>Avg Confidence: {radar.avgConf.toFixed(1)}</p>
          <p>Avg Spread: {radar.avgSpread.toFixed(3)}%</p>
        </div>

        <div className="analyseCard">
          <h3>Warmup</h3>
          <p>Coins: {warmup.count}</p>
          <p>Avg Confidence: {warmup.avgConf.toFixed(1)}</p>
          <p>Avg Spread: {warmup.avgSpread.toFixed(3)}%</p>
          <p>Conversion from Radar: {conversion(radar, warmup)}%</p>
        </div>

        <div className="analyseCard">
          <h3>Setup</h3>
          <p>Coins: {setup.count}</p>
          <p>Avg Confidence: {setup.avgConf.toFixed(1)}</p>
          <p>Avg Spread: {setup.avgSpread.toFixed(3)}%</p>
          <p>Conversion from Warmup: {conversion(warmup, setup)}%</p>
        </div>

        <div className="analyseCard">
          <h3>Entry Ready</h3>
          <p>Coins: {entry.count}</p>
          <p>Avg Confidence: {entry.avgConf.toFixed(1)}</p>
          <p>Avg Spread: {entry.avgSpread.toFixed(3)}%</p>
          <p>Conversion from Setup: {conversion(setup, entry)}%</p>
        </div>

      </main>
    </>
  );
}