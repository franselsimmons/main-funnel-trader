import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

export default function Trade() {
  const [trades, setTrades] = useState([]);

  useEffect(() => {
    const load = async () => {
      const bull = await fetch("/api/dashboard?side=bull").then(r => r.json());
      const bear = await fetch("/api/dashboard?side=bear").then(r => r.json());

      setTrades([
        ...(bull.trades || []),
        ...(bear.trades || [])
      ]);
    };

    load();
    const interval = setInterval(load, 10000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="container">
      <h1>Live Trade Signals</h1>
      <Navbar />

      <div className="bucket-grid">
        {trades.map(t => (
          <div key={t.symbol} className="card">
            <div className="title">
              {t.symbol} {t.side.toUpperCase()}
            </div>
            <div className="meta">
              Entry: {t.entry}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}