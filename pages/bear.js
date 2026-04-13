import { useEffect, useState } from "react";

export default function Bear() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/scan?mode=bear")
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) return <div className="container">Loading...</div>;

  const renderStage = (title, arr) => (
    <div>
      <h2>{title} ({arr.length})</h2>
      <div className="grid">
        {arr.map(c => (
          <div key={c.symbol} className="card">
            <h3>{c.symbol}</h3>
            <div>Price: ${c.price}</div>
            <div>Confidence: {c.confidence}</div>
            <div>AI Score: {c.aiScore}</div>
            <div>Stage: {c.stage}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="container">
      <h1>Bear Funnel</h1>
      {renderStage("Entry Ready", data.funnel.entry_ready)}
      {renderStage("Setup", data.funnel.setup)}
      {renderStage("Warmup", data.funnel.warmup)}
      {renderStage("Radar", data.funnel.radar)}
    </div>
  );
}