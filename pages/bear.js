// IDENTIEK aan bull, alleen:
// - mode = "bear"
// - bearish kleur
// - labels

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/* helpers hetzelfde */

export default function Bear() {
  const mode = "bear";
  const [data, setData] = useState(null);
  const [activeCoin, setActiveCoin] = useState(null);

  async function loadState() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  useEffect(() => {
    loadState();
    const t = setInterval(loadState, 30000);
    return () => clearInterval(t);
  }, []);

  const funnel =
    data?.state?.funnel ||
    data?.funnel || {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

  const lastScan = useMemo(() => {
    const ts = n(data?.lastScan || data?.state?.ts, 0);
    return ts
      ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "—";
  }, [data]);

  const regimeLabel = data?.state?.regime?.label || "NEUTRAL";
  const regimeScore = n(data?.state?.regime?.score, 0);

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">BEAR SCANNER</div>
          <div className="brandMeta">Laatste scan: {lastScan}</div>

          <div className="regimeBlock">
            <div className="regimeMeta">
              <span>Huidig Regime</span>
              <strong>{regimeLabel} ({regimeScore.toFixed(1)})</strong>
            </div>

            <div className="regimeMeter">
              <div
                className="regimeFill bearish"
                style={{ width: `${Math.min(Math.max(regimeScore, 0), 100)}%` }}
              />
            </div>
          </div>
        </div>

        <nav className="navRow">
          <Link href="/" className="navBtn">Home</Link>
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn active">Bear</Link>
          <Link href="/analyse" className="navBtn">Analyse</Link>
          <Link href="/trade" className="navBtn">Trade</Link>
        </nav>
      </header>

      <main className="panels">
        <FunnelBlock title="ENTRY READY" items={funnel.entry_ready} onOpenModal={setActiveCoin} />
        <FunnelBlock title="SETUP" items={funnel.setup} onOpenModal={setActiveCoin} />
        <FunnelBlock title="WARMUP" items={funnel.warmup} onOpenModal={setActiveCoin} />
        <FunnelBlock title="RADAR" items={funnel.radar} onOpenModal={setActiveCoin} />
      </main>
    </div>
  );
}