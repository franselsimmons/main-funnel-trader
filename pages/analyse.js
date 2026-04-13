import { useEffect, useState } from "react";

export default function Analyse() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) return <div>Loading...</div>;

  const f = data.funnel;

  const total = Object.values(f)
    .reduce((a, b) => a + b.length, 0);

  const conv = (a, b) =>
    a && b ? ((b.length / a.length) * 100).toFixed(1) : 0;

  return (
    <div style={{ padding: 40, fontFamily: "Inter" }}>
      <h1>Funnel Analysis</h1>

      <p>Radar: {f.radar.length}</p>
      <p>Warmup: {f.warmup.length}</p>
      <p>Setup: {f.setup.length}</p>
      <p>Entry Ready: {f.entry_ready.length}</p>

      <h2>Conversion</h2>
      <p>Radar → Warmup: {conv(f.radar, f.warmup)}%</p>
      <p>Warmup → Setup: {conv(f.warmup, f.setup)}%</p>
      <p>Setup → Entry: {conv(f.setup, f.entry_ready)}%</p>
    </div>
  );
}