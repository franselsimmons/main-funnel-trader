import { useEffect, useState } from "react";
import Nav from "../components/Nav";

export default function Trade() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/dashboard?side=bull")
      .then((res) => res.json())
      .then((bull) => {
        fetch("/api/dashboard?side=bear")
          .then((res) => res.json())
          .then((bear) => {
            setData({
              bull: bull.trades,
              bear: bear.trades,
            });
          });
      });
  }, []);

  return (
    <div className="container">
      <header>
        <h1>Live Trade Signals</h1>
      </header>

      <Nav active="trade" />

      <div className="section-title">Open Trades</div>

      {!data ? (
        <p>Loading…</p>
      ) : (
        <div className="bucket-grid">
          {data.bull.map((t) => (
            <div key={t.symbol} className="card">
              <div className="title">{t.symbol} LONG</div>
              <div className="meta">Entry: {t.entry}</div>
            </div>
          ))}
          {data.bear.map((t) => (
            <div key={t.symbol} className="card">
              <div className="title">{t.symbol} SHORT</div>
              <div className="meta">Entry: {t.entry}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}