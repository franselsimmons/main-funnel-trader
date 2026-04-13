import { useEffect, useState } from "react";

export default function Analyse() {

  const [bull, setBull] = useState(null);
  const [bear, setBear] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull").then(r => r.json()).then(setBull);
    fetch("/api/state?mode=bear").then(r => r.json()).then(setBear);
  }, []);

  if (!bull || !bear) return <div style={{padding:40}}>Loading...</div>;

  function block(title, data) {
    const f = data.funnel;

    const conv = (a, b) =>
      a.length ? ((b.length / a.length) * 100).toFixed(1) : 0;

    return (
      <div style={{ marginBottom: 40 }}>
        <h2>{title}</h2>
        <p>Regime: {data.regime?.regime} ({data.regime?.score})</p>

        <p>Radar: {f.radar.length}</p>
        <p>Warmup: {f.warmup.length}</p>
        <p>Setup: {f.setup.length}</p>
        <p>Entry: {f.entry_ready.length}</p>

        <h4>Conversion</h4>
        <p>Radar → Warmup: {conv(f.radar, f.warmup)}%</p>
        <p>Warmup → Setup: {conv(f.warmup, f.setup)}%</p>
        <p>Setup → Entry: {conv(f.setup, f.entry_ready)}%</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 40, fontFamily: "Inter" }}>
      <h1>Funnel Analysis</h1>
      {block("BULL SYSTEM", bull)}
      {block("BEAR SYSTEM", bear)}
    </div>
  );
}