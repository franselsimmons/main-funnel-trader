import { useEffect, useState } from "react";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/analyse?mode=bull")
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ error: true }));
  }, []);

  if (!data) return <div className="page">Loading analyse...</div>;
  if (data.error) return <div className="page error">Analyse offline</div>;

  const perf = data.perf || {};

  return (
    <div className="page">
      <h1 className="headline">System Analyse</h1>

      <div className="stats">
        <div>Trades: {perf.trades || 0}</div>
        <div>Winrate: {perf.winrate || 0}%</div>
        <div>Avg PnL: {perf.avgPnL || 0}%</div>
      </div>

      <div className="suggestions">
        {(perf.suggestions || []).map((s, i) => (
          <div key={i}>{s}</div>
        ))}
      </div>
    </div>
  );
}