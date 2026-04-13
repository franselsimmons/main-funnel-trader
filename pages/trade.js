import { useEffect, useState } from "react";

export default function Trade() {
  const [data, setData] = useState({ open: [] });

  useEffect(() => {
    fetch("/api/trade?mode=bull")
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div className="layout">
      <h1>Open Trades</h1>

      <div className="grid">
        {data.open?.map((t, i) => (
          <div key={i} className="card">
            <h3>{t.symbol}</h3>
            <div>Side: {t.side}</div>
            <div>Entry: {t.entry}</div>
          </div>
        ))}
      </div>
    </div>
  );
}