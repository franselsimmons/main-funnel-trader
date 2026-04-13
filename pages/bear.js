import { useEffect, useState } from "react";

export default function Bear() {
  const [data, setData] = useState(null);

  async function load() {
    try {
      const res = await fetch("/api/state?mode=bear");
      const json = await res.json();
      setData(json);
    } catch {
      setData({ error: true });
    }
  }

  useEffect(() => {
    load();
    const i = setInterval(load, 8000);
    return () => clearInterval(i);
  }, []);

  if (!data) return <div className="page">Loading market data...</div>;
  if (data.error) return <div className="page error">Scanner offline</div>;

  return (
    <MarketView title="Bear Market" funnel={data.funnel} />
  );
}

function MarketView({ title, funnel }) {
  return (
    <div className="page">
      <h1 className="headline">{title}</h1>

      <Stage title="ENTRY READY" coins={funnel.entry_ready} />
      <Stage title="SETUP" coins={funnel.setup} />
      <Stage title="WARMUP" coins={funnel.warmup} />
      <Stage title="RADAR" coins={funnel.radar} />
    </div>
  );
}

function Stage({ title, coins }) {
  return (
    <section className="section">
      <div className="sectionHeader">
        <h2>{title}</h2>
        <span>{coins.length}</span>
      </div>

      <div className="table">
        {coins.map(c => (
          <div key={c.symbol} className="row">
            <div className="symbol">{c.symbol}</div>
            <div>${c.price}</div>
            <div>{c.confidence}</div>
            <div>{c.aiScore}</div>
          </div>
        ))}
      </div>
    </section>
  );
}