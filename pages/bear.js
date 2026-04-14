// pages/bear.js

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/* ===== helpers ===== */

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtUSD(x, dec = 6) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(dec)}`;
}

function fmtPct(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(2)}%`;
}

/* ===== component ===== */

export default function Bear() {
  const mode = "bear";
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

    // Alleen state refresh, GEEN scan
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
          <div className="brandTitle">BEAR SCANNER</div>
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