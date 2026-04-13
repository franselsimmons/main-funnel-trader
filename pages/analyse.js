import { useEffect, useState } from "react";
import Link from "next/link";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  function count(stage) {
    return data?.funnel?.[stage]?.length || 0;
  }

  const total =
    count("radar") +
    count("warmup") +
    count("setup") +
    count("entry_ready");

  return (
    <>
      <header className="scannerHeader">
        <div>
          <div className="scannerTitle">ANALYSE</div>
          <div className="scannerSub">Full Funnel Breakdown</div>
        </div>

        <div className="navButtons">
          <Link href="/bull"><button className="navBtn">Bull</button></Link>
          <Link href="/bear"><button className="navBtn">Bear</button></Link>
          <Link href="/analyse"><button className="navBtn active">Analyse</button></Link>
          <Link href="/trade"><button className="navBtn">Trade</button></Link>
        </div>
      </header>

      <div className="analyseGrid">
        {["radar", "warmup", "setup", "entry_ready"].map(stage => {
          const c = count(stage);
          const pct = total ? Math.round((c / total) * 100) : 0;

          return (
            <div key={stage} className="analyseCard">
              <h3>{stage.toUpperCase()}</h3>
              <div className="bigNumber">{c}</div>
              <div className="analyseBarWrap">
                <div
                  className="analyseBar"
                  style={{ width: pct + "%" }}
                />
              </div>
              <span>{pct}% of total flow</span>
            </div>
          );
        })}
      </div>
    </>
  );
}