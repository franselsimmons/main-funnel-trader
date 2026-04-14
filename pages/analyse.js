import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

const STAGES = [
  { key: "radar", title: "RADAR" },
  { key: "warmup", title: "WARMUP" },
  { key: "setup", title: "SETUP" },
  { key: "entry_ready", title: "ENTRY READY" },
];

function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function arr(v) { return Array.isArray(v) ? v : []; }
function scoreOf(c) {
  const raw = n(c?.aiScore ?? c?.confidence ?? c?.entryQuality ?? 0, 0);
  return raw <= 1 ? raw * 100 : raw;
}
function avg(items, getter) {
  const list = arr(items);
  if (!list.length) return 0;
  return list.reduce((sum, it) => sum + n(getter(it), 0), 0) / list.length;
}

function fmtPct(v) { return `${n(v, 0).toFixed(1)}%`; }
function fmtNum(v) { return n(v, 0).toFixed(2); }
function pnlClass(v) {
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "neutral";
}

function getStageItems(state, key) { return arr(state?.funnel?.[key]); }

function stageStats(state, key) {
  const items = getStageItems(state, key);
  return {
    key, count: items.length,
    avgScore: avg(items, (c) => scoreOf(c)),
    avgSpread: avg(items, (c) => c?.ob?.spreadPct ?? c?.orderbook?.spreadPct),
    avgDepth: avg(items, (c) => c?.ob?.depthMinUsd1p ?? c?.ob?.depthMin ?? c?.orderbook?.depthMin),
    avgVolAcc: avg(items, (c) => c?.volAcc ?? c?.volumeAcceleration),
    avgChg24: avg(items, (c) => c?.change24 ?? c?.momentum24 ?? c?.momentum),
  };
}

function splitPositionsByMode(positions, mode) {
  return arr(positions).filter((p) => {
    const m = String(p?.mode || "").toLowerCase();
    const side = String(p?.side || "").toUpperCase();
    if (m) return m === mode;
    if (mode === "bull") return side === "LONG";
    if (mode === "bear") return side === "SHORT";
    return false;
  });
}

function buildSide(label, state, positions) {
  const stats = STAGES.map((s) => ({ ...s, ...stageStats(state, s.key) }));
  const [radar, warmup, setup, entry] = stats;

  const conversions = [
    { from: "RADAR", to: "WARMUP", rate: radar.count ? (warmup.count / radar.count) * 100 : 0 },
    { from: "WARMUP", to: "SETUP", rate: warmup.count ? (setup.count / warmup.count) * 100 : 0 },
    { from: "SETUP", to: "ENTRY", rate: setup.count ? (entry.count / setup.count) * 100 : 0 },
  ];

  let bottleneck = conversions[0];
  for (const step of conversions) if (step.rate < bottleneck.rate) bottleneck = step;

  const avgPnl = positions.length ? avg(positions, (p) => p?.pnlPct ?? p?.pnl) : 0;
  const advice = [];

  if (radar.count > 0 && warmup.count === 0) advice.push("RADAR → WARMUP dicht: Warmup eisen te streng of radar te breed.");
  if (warmup.count > 0 && setup.count === 0) advice.push("WARMUP → SETUP dicht: Setup eisen (confidence/compressie) verlagen.");
  if (setup.count > 0 && entry.count === 0) advice.push("SETUP → ENTRY dicht: Orderbook eisen (spread/depth) te strak ingesteld.");
  if (entry.count > 0 && positions.length === 0) advice.push("ENTRY READY, maar geen trades open: Check live execution logic.");
  if (!advice.length) advice.push("Flow ziet er gezond uit. Blijf monitoren.");

  return { label, stats, conversions, bottleneck, entryCount: entry.count, positionsCount: positions.length, avgPnl, advice };
}

export default function Analyse() {
  const [bull, setBull] = useState(null);
  const [bear, setBear] = useState(null);
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/state?mode=bull", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/state?mode=bear", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/positions", { cache: "no-store" }).then((r) => r.json()).then((j) => j?.positions || []).catch(() => []),
    ]).then(([b1, b2, p]) => {
      setBull(b1); setBear(b2); setPositions(p);
    });
  }, []);

  const bullSide = useMemo(() => buildSide("Bull Flow", bull, splitPositionsByMode(positions, "bull")), [bull, positions]);
  const bearSide = useMemo(() => buildSide("Bear Flow", bear, splitPositionsByMode(positions, "bear")), [bear, positions]);
  const sections = [bullSide, bearSide];

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">ANALYSE</div>
          <div className="brandMeta">Spoor bottlenecks op en optimaliseer je instellingen</div>
        </div>
        <nav className="navRow">
          <Link href="/" className="navBtn">Home</Link>
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/analyse" className="navBtn active">Analyse</Link>
          <Link href="/trade" className="navBtn">Trade</Link>
        </nav>
      </header>

      <main className="analysisPage">
        <div className="compareGrid">
          {sections.map((s) => (
            <div className="compareCard" key={s.label}>
              <div className="compareTitle">{s.label}</div>
              <div className="compareMeta">
                Ready: <strong>{s.entryCount}</strong> • Open: <strong>{s.positionsCount}</strong><br/>
                Avg PnL: <strong className={pnlClass(s.avgPnl)}>{s.avgPnl > 0 ? "+" : ""}{s.avgPnl.toFixed(2)}%</strong>
              </div>
              <div className="bottleneckBanner">
                <strong>Bottleneck:</strong> {s.bottleneck.from} → {s.bottleneck.to} ({fmtPct(s.bottleneck.rate)})
              </div>
            </div>
          ))}
        </div>

        <div className="analysisTwoCol">
          {sections.map((s) => (
            <section className="analysisSection" key={s.label}>
              <div className="analysisSectionTitle">{s.label} Diepte Data</div>

              {s.stats.map((st) => {
                const maxCount = Math.max(...s.stats.map((x) => x.count), 1);
                const width = (st.count / maxCount) * 100;

                return (
                  <div className="analysisStageCard" key={st.key}>
                    <div className="stageBarHeader">
                      <div>{st.title}</div>
                      <strong>{st.count}</strong>
                    </div>
                    <div className="stageBar">
                      <div className="stageBarFill" style={{ width: `${width}%` }} />
                    </div>
                    <div className="stageBarStats">
                      <span>Score: {fmtNum(st.avgScore)}</span>
                      <span>Chg: {fmtNum(st.avgChg24)}%</span>
                      <span>Spread: {fmtNum(st.avgSpread)}%</span>
                    </div>
                  </div>
                );
              })}

              <div className="analysisStageCard">
                <div className="stageBarHeader"><div>Systeem Advies</div></div>
                <div className="adviceBox">
                  {s.advice.map((line, idx) => (
                    <div className="adviceItem" key={idx}>{line}</div>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
