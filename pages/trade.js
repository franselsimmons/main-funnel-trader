import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

export default function Trade() {
  const [trades, setTrades] = useState([]);

  useEffect(() => {
    fetch("/api/dashboard?side=bull")
      .then(res => res.json())
      .then(bull => {
        fetch("/api/dashboard?side=bear")
          .then(res => res.json())
          .then(bear => {
            setTrades([
              ...(bull.trades || []),
              ...(bear.trades || [])
            ]);
          });
      });
  }, []);

  return (
    <div className="container">
      <header>
        <h1>Live Trade Signals</h1>
      </header>

      <Navbar />

      <div className="section-title">Open Trades</div>

      <div className="bucket-grid">
        {trades.map(t => (
          <div key={t.symbol} className="card">
            <div className="title">
              {t.symbol} {t.side?.toUpperCase()}
            </div>
            <div className="meta">Entry: {t.entry}</div>
          </div>
        ))}
      </div>
    </div>
  );
}