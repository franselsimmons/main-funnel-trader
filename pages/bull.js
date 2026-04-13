import { useEffect, useState } from "react";

export default function Bull() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch("/api/scan?mode=bull", {
        signal: controller.signal
      });

      clearTimeout(timeout);

      const json = await res.json();
      if (!json.ok) throw new Error("API error");

      setData(json);
    } catch (e) {
      setError("Scanner tijdelijk niet bereikbaar");
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, []);

  if (error)
    return <div className="layout error">{error}</div>;

  if (!data)
    return <div className="layout">Loading scanner...</div>;

  const funnel = data.funnel || {
    entry_ready: [],
    setup: [],
    warmup: [],
    radar: []
  };

  const renderStage = (title, arr) => (
    <div className="stage">
      <h2>{title} ({arr.length})</h2>
      <div className="grid">
        {arr.map(c => (
          <div key={c.symbol} className="card">
            <h3>{c.symbol}</h3>
            <div>Price: ${c.price}</div>
            <div>Conf: {c.confidence}</div>
            <div>AI: {c.aiScore}</div>
            <div className="stageTag">{c.stage}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="layout">
      <h1>Bull Market Funnel</h1>
      {renderStage("Entry Ready", funnel.entry_ready)}
      {renderStage("Setup", funnel.setup)}
      {renderStage("Warmup", funnel.warmup)}
      {renderStage("Radar", funnel.radar)}
    </div>
  );
}