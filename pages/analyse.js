import { useEffect, useState } from "react";
import Link from "next/link";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  function analyze(stage) {
    const arr = data?.funnel?.[stage] || [];
    const count = arr.length;
    const avgConf =
      arr.reduce((a, b) => a + (b.aiScore || 0), 0) / (count || 1);

    return { count, avgConf };
  }

  const radar = analyze("radar");
  const warmup = analyze("warmup");
  const setup = analyze("setup");
  const entry = analyze("entry_ready");

  return (
    <>
      <header className="scannerHeader">
        <div className="scannerTitle">ANALYSE</div>

        <div className="navButtons">
          <Link href="/bull"><button className="navBtn">Bull</button></Link>
          <Link href="/bear"><button className="navBtn">Bear</button></Link>
          <Link href="/analyse"><button className="navBtn active">Analyse</button></Link>
          <Link href="/trade"><button className="navBtn">Trade</button></Link>
        </div>
      </header>

      <main className="analyseGrid">
        <AnalyseCard title="Radar" data={radar} />
        <AnalyseCard title="Warmup" data={warmup} />
        <AnalyseCard title="Setup" data={setup} />
        <AnalyseCard title="Entry Ready" data={entry} />
      </main>
    </>
  );
}

function AnalyseCard({ title, data }) {
  return (
    <div className="analyseCard">
      <h3>{title}</h3>
      <p>Coins: {data.count}</p>
      <p>Avg Confidence: {data.avgConf.toFixed(1)}</p>
    </div>
  );
}