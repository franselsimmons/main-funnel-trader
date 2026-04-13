import { useEffect, useState } from "react";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/analyse?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) return <div className="container">Loading...</div>;

  return (
    <div className="container">
      <h1>System Analyse</h1>

      <h2>Performance</h2>
      <div className="card">
        <div>Trades: {data.perf.trades}</div>
        <div>Winrate: {data.perf.winrate}%</div>
        <div>Avg PnL: {data.perf.avgPnL}%</div>
      </div>

      <h2>Suggestions</h2>
      <div className="card">
        {data.perf.suggestions.map((s, i) => (
          <div key={i}>{s}</div>
        ))}
      </div>

      <h2>Funnel Flow (Last 5)</h2>
      <div className="card">
        <pre>
          {JSON.stringify(data.flow.history?.slice(-5), null, 2)}
        </pre>
      </div>
    </div>
  );
}