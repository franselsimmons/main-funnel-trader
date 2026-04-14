// pages/bear.js

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/* ================= HELPERS ================= */

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtPrice(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) {
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return v.toFixed(4);
}

/* ================= COMPONENTS ================= */

function CoinCard({ c }) {
  return (
    <div className="coinCard">
      <div className="coinHeader">
        <div className="coinSymbol">{c.symbol}</div>
        <div className="coinScore">AI {c.aiScore}</div>
      </div>
      <div className="coinName">{c.name}</div>
      <div className="coinPrice">${fmtPrice(c.price)}</div>
    </div>
  );
}

function FunnelBlock({ title, items }) {
  return (
    <div className="funnelBlock">
      <div className="funnelHeader">
        <span>{title}</span>
        <span className="count">{items?.length || 0}</span>
      </div>

      {items?.length ? (
        <div className="coinGrid">
          {items.map((c) => (
            <CoinCard key={c.symbol} c={c} />
          ))}
        </div>
      ) : (
        <div className="emptyState">Geen coins in deze fase</div>
      )}
    </div>
  );
}

/* ================= PAGE ================= */

export default function Bear() {
  const mode = "bear";
  const [data, setData] = useState(null);

  async function loadState() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, {
        cache: "no-store",
      });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  useEffect(() => {
    loadState();
    const t = setInterval(loadState, 30000); // 30s refresh
    return () => clearInterval(t);
  }, []);

  const lastScan = useMemo(() => {
    const ts = n(data?.lastScan || data?.ts, 0);
    return ts ? new Date(ts).toLocaleString() : "—";
  }, [data]);

  const regimeLabel = data?.regime?.label || "NEUTRAL";
  const regimeScore = n(data?.regime?.score, 0);
  const funnel = data?.funnel || {};

  return (
    <div className="pageShell">
      {/* ===== HEADER CARD ===== */}
      <div className="topCard">
        <div className="topLeft">
          <div className="title">BEAR SCANNER</div>
          <div className="meta">Last scan: {lastScan}</div>
          <div className="regime">
            Regime: <strong>{regimeLabel}</strong> ({regimeScore.toFixed(2)})
          </div>

          <div className="progress">
            <div
              className="bar"
              style={{
                width: `${Math.min(regimeScore, 100)}%`,
              }}
            />
          </div>
        </div>

        <div className="nav">
          <Link href="/bull">Bull</Link>
          <Link href="/bear">Bear</Link>
          <Link href="/analyse">Analyse</Link>
          <Link href="/trade">Trade</Link>
        </div>
      </div>

      {/* ===== FUNNEL SECTIONS ===== */}
      <FunnelBlock title="RADAR" items={funnel.radar} />
      <FunnelBlock title="WARMUP" items={funnel.warmup} />
      <FunnelBlock title="SETUP" items={funnel.setup} />
      <FunnelBlock title="ENTRY READY" items={funnel.entry_ready} />
    </div>
  );
}