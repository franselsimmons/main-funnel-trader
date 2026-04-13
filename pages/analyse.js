import { useEffect, useState } from "react";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/analyse?mode=bull")
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ error: true }));
  }, []);

  if (!data)
    return <div className="layout">Loading analyse...</div>;

  if (data.error)
    return <div className="layout error">Analyse tijdelijk niet beschikbaar</div>;

  const perf = data.perf || {};
  const flow = data.flow || {};

  return (
    <div className="layout">
      <h1>System Analyse</h1>

      <div className="card">
        <div>Trades: {perf.trades || 0}</div>
        <div>Winrate: {perf.winrate || 0}%</div>
        <div>Avg PnL: {perf.avgPnL || 0}%</div>
      </div>

      <div className="card">
        <h3>Suggestions</h3>
        {(perf.suggestions || []).map((s, i) => (
          <div key={i}>{s}</div>
        ))}
      </div>

      <div className="card">
        <h3>Flow Snapshot</h3>
        <pre>
          {JSON.stringify(flow.history?.slice(-5) || [], null, 2)}
        </pre>
      </div>
    </div>
  );
}