// pages/bull.js

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);

  async function loadState() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  useEffect(() => {
    loadState();

    // Alleen state refresh
    const t = setInterval(loadState, 15000);

    return () => clearInterval(t);
  }, []);

  const lastScan = useMemo(() => {
    const ts = n(data?.ts || data?.scannedAt || 0);
    return ts ? new Date(ts).toLocaleString() : "—";
  }, [data]);

  const regimeLabel = useMemo(() => {
    const r = data?.regime || {};
    return String(r.label || r.regime || "NEUTRAL");
  }, [data]);

  const regimeScore = n(data?.regime?.score, 0);
  const funnel = data?.funnel || {};

  return (
    <div className="pageShell">
      <header className="topbar">
        <div>
          <div className="brandTitle">BULL SCANNER</div>
          <div className="brandMeta">Last scan: {lastScan}</div>
          <div>Regime: {regimeLabel} ({regimeScore.toFixed(2)})</div>
        </div>

        <nav>
          <Link href="/bull">Bull</Link>
          <Link href="/bear">Bear</Link>
          <Link href="/analyse">Analyse</Link>
          <Link href="/trade">Trade</Link>
        </nav>
      </header>

      <main>
        <pre>{JSON.stringify(funnel, null, 2)}</pre>
      </main>
    </div>
  );
}