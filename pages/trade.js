import { useEffect, useState } from "react";

export default function Trade() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/trade?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) return <div className="container">Loading...</div>;

  return (
    <div className="container">
      <h1>Open Trades</h1>

      <div className="grid">
        {data.open.map((t, i) => (
          <div key={i} className="card">
            <h3>{t.symbol}</h3>
            <div>Side: {t.side}</div>
            <div>Entry: {t.entry}</div>
            <div>Opened: {new Date(t.openedAt).toLocaleTimeString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}