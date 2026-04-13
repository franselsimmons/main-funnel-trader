import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

export default function Bull() {
  const [data, setData] = useState(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/dashboard?side=bull")
        .then(res => res.json())
        .then(setData);
    };

    load();
    const interval = setInterval(load, 10000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="container">
      <h1>Bull Dashboard</h1>
      <Navbar />

      {!data ? (
        <p>Loading...</p>
      ) : (
        <>
          <p>Last Scan: {new Date(data.lastScan).toLocaleTimeString()}</p>

          <div className="bucket-grid">
            <Bucket title="Trade Ready" items={data.tradeReady} />
            <Bucket title="Setup" items={data.setup} />
            <Bucket title="Warmup" items={data.warmup} />
          </div>
        </>
      )}
    </div>
  );
}

function Bucket({ title, items }) {
  return (
    <div className="card">
      <div className="title">{title}</div>
      {items.map(c => (
        <div key={c.symbol} className="meta">
          {c.symbol} — {(c.score * 100).toFixed(1)}%
        </div>
      ))}
    </div>
  );
}