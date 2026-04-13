import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

export default function Bear() {
  const [data, setData] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/dashboard");
        const json = await res.json();

        // Filter bearish coins (negatieve change)
        const bearish = {
          lastScan: json.lastScan,
          warmup: json.warmup?.filter(c => c.change < 0),
          setup: json.setup?.filter(c => c.change < 0),
          tradeReady: json.tradeReady?.filter(c => c.change < 0),
        };

        setData(bearish);
      } catch (e) {
        console.error("Bear fetch error:", e);
      }
    };

    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div className="container">
        <h1>Bear Dashboard</h1>
        <Navbar />
        <p>Loading scanner...</p>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>Bear Dashboard</h1>
      <Navbar />

      <p>
        Last Scan:{" "}
        {data.lastScan
          ? new Date(data.lastScan).toLocaleTimeString()
          : "Waiting..."}
      </p>

      <div className="bucket-grid">
        <Bucket title="Trade Ready" items={data.tradeReady} />
        <Bucket title="Setup" items={data.setup} />
        <Bucket title="Warmup" items={data.warmup} />
      </div>
    </div>
  );
}

function Bucket({ title, items }) {
  if (!items || items.length === 0) return null;

  return (
    <div className="card">
      <div className="title">{title}</div>
      {items.map((coin) => {
        const strength =
          typeof coin.strength === "number"
            ? (coin.strength * 100).toFixed(1)
            : "0.0";

        return (
          <div key={coin.symbol} className="meta">
            {coin.symbol} — {strength}%
          </div>
        );
      })}
    </div>
  );
}