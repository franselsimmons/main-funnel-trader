import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

const STAGE_ORDER = [
  { key: "radar", title: "RADAR" },
  { key: "warmup", title: "WARMUP" },
  { key: "setup", title: "SETUP" },
  { key: "entry_ready", title: "ENTRY READY" },
];

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function scoreOf(c) {
  const raw = n(c?.aiScore ?? c?.confidence ?? 0, 0);
  return raw <= 1 ? raw * 100 : raw;
}

function avg(items, getter) {
  const list = arr(items);
  if (!list.length) return 0;
  return list.reduce((sum, item) => sum + n(getter(item), 0), 0) / list.length;
}

function fmtPct(v) {
  return `${n(v, 0).toFixed(1)}%`;
}

function fmtNum(v) {
  return n(v, 0).toFixed(2);
}

function getStageStats(state, key) {
  const items = arr(state?.funnel?.[key]);

  return {
    key,
    count: items.length,
    avgScore: avg(items, (c) => scoreOf(c)),
    avgSpread: avg(items, (c) => c?.ob?.spreadPct),
    avgDepth: avg(items, (c) => c?.ob?.depthMinUsd1p),
    avgVolAcc: avg(items, (c) => c?.volumeAcceleration ?? c?.volAcc?.short ?? c?.volAcc),
    avgChange: avg(items, (c) => c?.change24 ?? c?.momentum ?? c?.change1h),
  };
}

function buildSideAnalysis(label, state, positions) {
  const stages = STAGE_ORDER.map((s) => ({
    ...s,
    ...getStageStats(state, s.key),
  }));

  const radar = stages[0];
  const warmup = stages[1];
  const setup = stages[2];
  const entry = stages[3];

  const conversions = [
    {
      from: "RADAR",
      to: "WARMUP",
      rate: radar.count ? (warmup.count / radar.count) * 100 : 0,
    },
    {
      from: "WARMUP",
      to: "SETUP",
      rate: warmup.count ? (setup.count / warmup.count) * 100 : 0,
    },
    {
      from: "SETUP",
      to: "ENTRY READY",
      rate: setup.count ? (entry.count / setup.count) * 100 : 0,
    },
  ];

  let bottleneck = conversions[0];
  for (const step of conversions) {
    if (step.rate < bottleneck.rate) bottleneck = step;
  }

  const advice = [];

  if (radar.count > 0 && warmup.count === 0) {
    advice.push("RADAR → WARMUP is dicht. Waarschijnlijk is volume acceleration te streng. Verlaag warmup-drempel iets of maak radar selectiever.");
  }

  if (warmup.count > 0 && setup.count === 0) {
    advice.push("WARMUP → SETUP is dicht. Confidence of compressie is waarschijnlijk te streng. Verlaag setup confidence licht of laat iets meer prijsruimte toe.");
  }

  if (setup.count > 0 && entry.count === 0) {
    advice.push("SETUP → ENTRY READY is dicht. Orderbook gate is waarschijnlijk te streng. Kijk naar spreadMax, depthMin en OB-score.");
  }

  if (entry.count > 0 && positions.length === 0) {
    advice.push("Trade tunnel opent niets terwijl er entry-ready signalen zijn. Entry trigger of execution tolerance is waarschijnlijk te streng.");
  }

  const avgPnl = positions.length
    ? avg(positions, (p) => p?.pnlPct ?? p?.pnl)
    : 0;

  if (positions.length > 0 && avgPnl < 0) {
    advice.push("Open trade performance is zwak. Kijk naar entry timing, SL/TP afstand en spread reject bij live execution.");
  }

  if (entry.avgSpread > 1.2) {
    advice.push("Entry-ready spread ligt hoog. Tighten spread filter of vermijd lage-liquiditeit coins in entry stage.");
  }

  if (!advice.length) {
    advice.push("Op dit snapshot zie ik geen harde blokkade. Blijf vooral ENTRY READY → OPEN monitoren.");
  }

  return {
    label,
    stages,
    conversions,
    bottleneck,
    advice,
    entryCount: entry.count,
    positionsCount: positions.length,
    avgPnl,
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

export default function Analyse() {
  const [bull, setBull] = useState(null);
  const [bear, setBear] = useState(null);
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/state?mode=bull", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/state?mode=bear", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/positions", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => j?.positions || [])
        .catch(() => []),
    ]).then(([b1, b2, p]) => {
      setBull(b1);
      setBear(b2);
      setPositions(p);
    });
  }, []);

  const bullAnalysis = useMemo(
    () => buildSideAnalysis("Bull funnel", bull, splitPositionsByMode(positions, "bull")),
    [bull, positions]
  );

  const bearAnalysis = useMemo(
    () => buildSideAnalysis("Bear funnel", bear, splitPositionsByMode(positions, "bear")),
    [bear, positions]
  );

  const sections = [bullAnalysis, bearAnalysis];

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">ANALYSE</div>
          <div className="brandMeta">
            Bull en bear apart • bottlenecks • funnel advies • trade tunnel advies
          </div>
        </div>

        <nav className="navRow">
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn">Bear</Link>
          <Link href="/analyse" className="navBtn active">Analyse</Link>
          <Link href="/trade" className="navBtn">Trade</Link>
        </nav>
      </header>

      <main className="analysisPage">
        <div className="compareGrid">
          {sections.map((side) => (
            <div className="compareCard" key={side.label}>
              <div className="compareTitle">{side.label}</div>
              <div className="compareMeta">
                Entry ready <strong>{side.entryCount}</strong> • Open positions{" "}
                <strong>{side.positionsCount}</strong> • Avg PnL{" "}
                <strong className={side.avgPnl > 0 ? "positive" : side.avgPnl < 0 ? "negative" : "neutral"}>
                  {side.avgPnl > 0 ? "+" : ""}
                  {side.avgPnl.toFixed(2)}%
                </strong>
              </div>
              <div className="bottleneckBanner">
                Grootste bottleneck: {side.bottleneck.from} → {side.bottleneck.to} ({fmtPct(side.bottleneck.rate)})
              </div>
            </div>
          ))}
        </div>

        <div className="analysisTwoCol">
          {sections.map((side) => (
            <section className="analysisSection" key={side.label}>
              <div className="analysisSectionTitle">{side.label}</div>

              {side.stages.map((stage) => {
                const maxCount = Math.max(...side.stages.map((s) => s.count), 1);
                const width = (stage.count / maxCount) * 100;

                let bottleneckText = "Geen directe blokkade op dit niveau.";
                if (stage.key === "radar" && stage.count > 0 && side.stages[1].count === 0) {
                  bottleneckText = "Veel instroom, maar niets groeit door naar warmup.";
                }
                if (stage.key === "warmup" && stage.count > 0 && side.stages[2].count === 0) {
                  bottleneckText = "Warmup blijft hangen en wordt geen setup.";
                }
                if (stage.key === "setup" && stage.count > 0 && side.stages[3].count === 0) {
                  bottleneckText = "Setup haalt entry gate niet.";
                }
                if (stage.key === "entry_ready" && stage.count > 0 && side.positionsCount === 0) {
                  bottleneckText = "Signals zijn klaar, maar trade tunnel opent niets.";
                }

                return (
                  <div className="analysisStageCard" key={stage.key}>
                    <div className="stageBarHeader">
                      <div>{stage.title}</div>
                      <strong>{stage.count}</strong>
                    </div>

                    <div className="stageBar">
                      <div className="stageBarFill" style={{ width: `${width}%` }} />
                    </div>

                    <div className="stageBarStats">
                      <span>avg score {fmtNum(stage.avgScore)}</span>
                      <span>avg spread {fmtNum(stage.avgSpread)}%</span>
                      <span>avg depth {fmtNum(stage.avgDepth)}</span>
                      <span>avg volAcc {fmtNum(stage.avgVolAcc)}</span>
                    </div>

                    <div className="adviceBox">
                      <div className="adviceItem">{bottleneckText}</div>
                    </div>
                  </div>
                );
              })}

              <div className="analysisStageCard">
                <div className="stageBarHeader">
                  <div>Conversies</div>
                </div>

                <div className="funnelTable">
                  {side.conversions.map((c) => (
                    <div className="funnelRow" key={`${c.from}-${c.to}`}>
                      <span>{c.from} → {c.to}</span>
                      <strong>{fmtPct(c.rate)}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="analysisStageCard">
                <div className="stageBarHeader">
                  <div>Wat verbeteren</div>
                </div>

                <div className="adviceBox">
                  {side.advice.map((line, idx) => (
                    <div className="adviceItem" key={idx}>
                      {line}
                    </div>
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
