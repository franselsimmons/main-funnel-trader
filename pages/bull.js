import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

export default function Bull() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/dashboard?side=bull")
      .then(res => res.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  return (
    <div className="container">
      <header>
        <h1>Bull Dashboard</h1>
      </header>

      <Navbar />

      <div className="section-title">Scanner Buckets</div>

      {!data ? (
        <p>Loading...</p>
      ) : (
        <div className="bucket-grid">
          <div className="card">
            <div className="title">Trade Ready</div>
            {data.tradeReady?.map(c => (
              <div key={c.symbol} className="meta">
                {c.symbol} — {(c.score * 100).toFixed(1)}%
              </div>
            ))}
          </div>

          <div className="card">
            <div className="title">Setup</div>
            {data.setup?.map(c => (
              <div key={c.symbol} className="meta">
                {c.symbol} — {(c.score * 100).toFixed(1)}%
              </div>
            ))}
          </div>

          <div className="card">
            <div className="title">Warmup</div>
            {data.warmup?.map(c => (
              <div key={c.symbol} className="meta">
                {c.symbol} — {(c.score * 100).toFixed(1)}%
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}