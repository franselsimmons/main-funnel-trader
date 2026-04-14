import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safe(x, d = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(d);
}
function fmtUSD(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1e12) return `$${(x / 1e12).toFixed(2)}T`;
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(2)}K`;
  return `$${x.toFixed(2)}`;
}
function fmtPrice(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1000) return x.toFixed(2);
  if (x >= 1) return x.toFixed(4);
  if (x >= 0.01) return x.toFixed(6);
  return x.toFixed(8);
}
function fmtPct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  const s = x >= 0 ? "+" : "";
  return `${s}${x.toFixed(2)}%`;
}
function confColor(v) {
  const x = n(v, 0);
  if (x >= 80) return "#22C55E";
  if (x >= 60) return "#3B82F6";
  if (x >= 40) return "#F59E0B";
  return "#EF4444";
}
function clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function pickOB(c) {
  return c?.ob || c?.orderbook || c?.orderBook || null;
}
function pickPlan(c) {
  return c?.tradePlan || c?.plan || null;
}
function pickRegime(data) {
  const r = data?.regime || {};
  const label =
    typeof r === "string"
      ? r
      : String(r?.label || r?.regime || r?.state || "NEUTRAL");
  const score = n(r?.score, 0);
  return { label, score };
}

function Modal({ coin, mode, onClose }) {
  if (!coin) return null;

  const ob = pickOB(coin);
  const plan = pickPlan(coin);

  const sym = coin.symbol || "—";
  const name = coin.name || "";
  const img = coin.image || coin.logo || "";

  const price = n(coin.price ?? coin.current_price, 0);
  const chg24 =
    n(coin.change24 ?? coin.change24h ?? coin.price_change_percentage_24h, 0) ||
    n(coin.momentum, 0);

  const mcap = n(coin.marketCap ?? coin.market_cap, 0);
  const vol = n(coin.volume ?? coin.total_volume, 0);

  const spreadPct = n(ob?.spreadPct ?? ob?.spread ?? coin?.spreadPct, NaN);
  const depth1p = n(ob?.depthMinUsd1p ?? ob?.depthMin ?? ob?.depth1p ?? ob?.depth, NaN);
  const bestBid = n(ob?.bestBid, NaN);
  const bestAsk = n(ob?.bestAsk, NaN);
  const obScore = n(ob?.score ?? ob?.imbalance ?? ob?.obScore, NaN);

  const rr = Number.isFinite(n(plan?.rr, NaN))
    ? n(plan.rr, NaN)
    : (() => {
        const sl = n(plan?.sl, NaN);
        const tp = n(plan?.tp, NaN);
        if (!(price > 0) || !Number.isFinite(sl) || !Number.isFinite(tp)) return NaN;
        return Math.abs((tp - price) / ((price - sl) || 1e-9));
      })();

  const stageLabel =
    coin.stageLegacy || coin.stage || coin.pipelineStage || coin.stageName || "—";
  const aiScore = n(coin.aiScore, NaN);
  const confidence =
    Number.isFinite(n(coin.confidence, NaN)) ? n(coin.confidence, NaN) : NaN;

  const scoreShown = Number.isFinite(aiScore)
    ? Math.round(aiScore)
    : Number.isFinite(confidence)
      ? Math.round(confidence > 100 ? confidence : confidence * (confidence <= 1 ? 100 : 1))
      : 0;

  return (
    <div className="modalOverlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modalCard">
        <div className="modalTop">
          <div className="modalTitleRow">
            {img ? <img className="modalLogo" src={img} alt="" /> : <div className="modalLogo ph" />}
            <div>
              <div className="modalTitle">
                {sym} <span className="muted">• {mode.toUpperCase()}</span>
              </div>
              <div className="modalSub">
                {name ? `${name} • ` : ""}
                Price <b>${fmtPrice(price)}</b> • 24h{" "}
                <span className={chg24 >= 0 ? "pos" : "neg"}>{fmtPct(chg24)}</span> • Stage{" "}
                <b>{String(stageLabel).toUpperCase()}</b>
              </div>
            </div>
          </div>

          <button className="btn ghost" onClick={onClose}>
            Sluiten
          </button>
        </div>

        <div className="modalBody">
          <div className="sectionGrid">
            <div className="section">
              <div className="sectionTitle">Market</div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">Price</div>
                  <div className="kvVal">${fmtPrice(price)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">24h</div>
                  <div className={"kvVal " + (chg24 >= 0 ? "pos" : "neg")}>{fmtPct(chg24)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Volume</div>
                  <div className="kvVal">{fmtUSD(vol)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Market cap</div>
                  <div className="kvVal">{fmtUSD(mcap)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">VM</div>
                  <div className="kvVal">{safe(coin.vm, 3)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">VolAcc</div>
                  <div className="kvVal">{safe(coin.volAcc?.short ?? coin.volAcc ?? coin.volumeAcceleration, 3)}</div>
                </div>
              </div>
            </div>

            <div className="section">
              <div className="sectionTitle">Liquidity (Orderbook)</div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">Spread</div>
                  <div className="kvVal">{Number.isFinite(spreadPct) ? `${safe(spreadPct, 4)}%` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Depth 1%</div>
                  <div className="kvVal">{Number.isFinite(depth1p) ? fmtUSD(depth1p) : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Best bid</div>
                  <div className="kvVal">{Number.isFinite(bestBid) ? safe(bestBid, 8) : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Best ask</div>
                  <div className="kvVal">{Number.isFinite(bestAsk) ? safe(bestAsk, 8) : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">OB score</div>
                  <div className="kvVal">{Number.isFinite(obScore) ? safe(obScore, 6) : "—"}</div>
                </div>
              </div>
            </div>

            <div className="section">
              <div className="sectionTitle">Trade plan</div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">Entry</div>
                  <div className="kvVal">{plan?.entry ? `$${fmtPrice(plan.entry)}` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">SL</div>
                  <div className="kvVal">{plan?.sl ? `$${fmtPrice(plan.sl)}` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">TP</div>
                  <div className="kvVal">{plan?.tp ? `$${fmtPrice(plan.tp)}` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">R:R</div>
                  <div className="kvVal">{Number.isFinite(rr) ? safe(rr, 2) : "—"}</div>
                </div>
              </div>
            </div>

            <div className="section">
              <div className="sectionTitle">Execution</div>
              <div className="pillRow">
                <div className="pill">mode: {mode}</div>
                <div className="pill">stage: {String(coin.stage ?? coin.pipelineStage ?? "—")}</div>
                <div className="pill">gate: {String(coin.tradeDeskStatus ?? coin.deskGate ?? coin.engineGate ?? "—")}</div>
              </div>

              <div className="sectionTitle" style={{ marginTop: 14 }}>
                Score
              </div>
              <div className="scoreRow">
                <div className="scoreNum">{scoreShown}/100</div>
                <div className="scoreBar">
                  <div
                    className="scoreFill"
                    style={{
                      width: `${Math.max(0, Math.min(100, scoreShown))}%`,
                      background: confColor(scoreShown),
                    }}
                  />
                </div>
              </div>

              <details className="debug">
                <summary>Debug JSON</summary>
                <pre>{JSON.stringify(coin, null, 2)}</pre>
              </details>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        .modalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
          z-index: 50;
        }
        .modalCard {
          width: min(980px, 100%);
          max-height: 86vh;
          overflow: auto;
          border-radius: 22px;
          background: linear-gradient(180deg, rgba(18, 33, 60, 0.95), rgba(10, 18, 34, 0.95));
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
        }
        .modalTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          padding: 16px 16px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .modalTitleRow {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .modalLogo {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          object-fit: cover;
          background: rgba(255, 255, 255, 0.06);
        }
        .modalLogo.ph {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.06);
        }
        .modalTitle {
          font-size: 18px;
          font-weight: 800;
          letter-spacing: 0.2px;
          color: #eaf1ff;
        }
        .modalSub {
          margin-top: 2px;
          font-size: 12px;
          color: rgba(234, 241, 255, 0.72);
          line-height: 1.35;
        }
        .muted {
          color: rgba(234, 241, 255, 0.55);
          font-weight: 600;
        }
        .modalBody {
          padding: 14px 16px 18px;
        }
        .sectionGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }
        @media (max-width: 860px) {
          .sectionGrid {
            grid-template-columns: 1fr;
          }
        }
        .section {
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          padding: 14px;
        }
        .sectionTitle {
          font-size: 12px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: rgba(234, 241, 255, 0.62);
          margin-bottom: 10px;
        }
        .kv {
          display: grid;
          gap: 8px;
        }
        .kvRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .kvKey {
          font-size: 12px;
          color: rgba(234, 241, 255, 0.62);
        }
        .kvVal {
          font-size: 13px;
          font-weight: 700;
          color: #eaf1ff;
        }
        .pos {
          color: #22c55e;
        }
        .neg {
          color: #ef4444;
        }
        .pillRow {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pill {
          font-size: 12px;
          padding: 8px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: rgba(234, 241, 255, 0.8);
          font-weight: 700;
        }
        .scoreRow {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .scoreNum {
          font-size: 18px;
          font-weight: 900;
          color: #eaf1ff;
          min-width: 84px;
        }
        .scoreBar {
          height: 10px;
          flex: 1;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .scoreFill {
          height: 100%;
          border-radius: 999px;
        }
        .debug {
          margin-top: 12px;
          color: rgba(234, 241, 255, 0.75);
        }
        .debug pre {
          margin-top: 8px;
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-wrap;
          word-break: break-word;
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 14px;
          padding: 10px;
          color: rgba(234, 241, 255, 0.85);
        }
        .btn {
          border: 0;
          cursor: pointer;
          border-radius: 14px;
          padding: 10px 12px;
          font-weight: 800;
          background: #2f66ff;
          color: #fff;
        }
        .btn.ghost {
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
      `}</style>
    </div>
  );
}

function StagePanel({ title, items, onPick }) {
  const count = items?.length || 0;

  return (
    <section className="panel">
      <div className="panelTop">
        <div className="panelTitle">{title}</div>
        <div className="panelCount">{count}</div>
      </div>

      {!count ? (
        <div className="empty">Geen coins</div>
      ) : (
        <div className="grid">
          {items.map((c) => {
            const img = c.image || c.logo || "";
            const sym = c.symbol || "—";
            const name = c.name || "";
            const price = n(c.price ?? c.current_price, 0);

            const chg24 =
              n(c.change24 ?? c.change24h ?? c.price_change_percentage_24h, 0) ||
              n(c.momentum, 0);

            const aiScore = n(c.aiScore, NaN);
            const conf = Number.isFinite(aiScore) ? Math.round(aiScore) : Math.round(n(c.confidence, 0));

            return (
              <button key={sym} className="coin" onClick={() => onPick(c)}>
                <div className="coinTop">
                  <div className="left">
                    {img ? <img className="logo" src={img} alt="" /> : <div className="logo ph" />}
                    <div>
                      <div className="sym">{sym}</div>
                      <div className="name">{name}</div>
                    </div>
                  </div>
                  <div className="right">
                    <div className="score">{conf}/100</div>
                    <div className={"chg " + (chg24 >= 0 ? "pos" : "neg")}>{fmtPct(chg24)}</div>
                  </div>
                </div>

                <div className="coinMid">
                  <div className="price">${fmtPrice(price)}</div>
                  <div className="bar">
                    <div className="fill" style={{ width: `${Math.max(0, Math.min(100, conf))}%`, background: confColor(conf) }} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <style jsx>{`
        .panel {
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          padding: 14px;
        }
        .panelTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .panelTitle {
          font-size: 12px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: rgba(234, 241, 255, 0.62);
        }
        .panelCount {
          font-weight: 900;
          color: rgba(234, 241, 255, 0.9);
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 6px 10px;
          border-radius: 999px;
        }
        .empty {
          color: rgba(234, 241, 255, 0.55);
          padding: 12px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px dashed rgba(255, 255, 255, 0.08);
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        @media (max-width: 860px) {
          .grid {
            grid-template-columns: 1fr;
          }
        }
        .coin {
          cursor: pointer;
          text-align: left;
          border: 0;
          width: 100%;
          border-radius: 18px;
          padding: 12px;
          background: rgba(10, 18, 34, 0.35);
          border: 1px solid rgba(255, 255, 255, 0.07);
          transition: transform 0.08s ease, border-color 0.08s ease, background 0.08s ease;
        }
        .coin:active {
          transform: scale(0.99);
        }
        .coin:hover {
          border-color: rgba(61, 124, 255, 0.35);
          background: rgba(10, 18, 34, 0.45);
        }
        .coinTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .left {
          display: flex;
          gap: 10px;
          align-items: center;
          min-width: 0;
        }
        .logo {
          width: 34px;
          height: 34px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.06);
          object-fit: cover;
          flex: 0 0 auto;
        }
        .logo.ph {
          background: rgba(255, 255, 255, 0.06);
        }
        .sym {
          font-size: 14px;
          font-weight: 900;
          color: #eaf1ff;
          line-height: 1.1;
        }
        .name {
          font-size: 12px;
          color: rgba(234, 241, 255, 0.6);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
        }
        .right {
          text-align: right;
          flex: 0 0 auto;
        }
        .score {
          font-size: 12px;
          font-weight: 900;
          color: rgba(234, 241, 255, 0.9);
        }
        .chg {
          font-size: 12px;
          font-weight: 800;
          margin-top: 2px;
        }
        .pos {
          color: #22c55e;
        }
        .neg {
          color: #ef4444;
        }
        .coinMid {
          margin-top: 10px;
          display: grid;
          gap: 8px;
        }
        .price {
          font-size: 14px;
          font-weight: 900;
          color: rgba(234, 241, 255, 0.92);
        }
        .bar {
          height: 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .fill {
          height: 100%;
          border-radius: 999px;
        }
      `}</style>
    </section>
  );
}

export default function Bear() {
  const mode = "bear";
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        setData(j);
      } catch {
        // keep old
      }
    }

    load();
    const i = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  const regime = useMemo(() => pickRegime(data), [data]);
  const ts = n(data?.ts ?? data?.scannedAt ?? data?.lastScanTs, 0);
  const lastScan = ts ? new Date(ts).toLocaleString() : "—";

  const funnel = data?.funnel || {};
  const entry = Array.isArray(funnel.entry_ready) ? funnel.entry_ready : [];
  const setup = Array.isArray(funnel.setup) ? funnel.setup : [];
  const warmup = Array.isArray(funnel.warmup) ? funnel.warmup : [];
  const radar = Array.isArray(funnel.radar) ? funnel.radar : [];

  const scoreAbs = Math.min(100, Math.abs(n(regime.score, 0)));
  const scorePos = clamp01(scoreAbs / 100);
  const scoreColor = n(regime.score, 0) >= 0 ? "#22C55E" : "#EF4444";

  return (
    <>
      <div className="page">
        <header className="top">
          <div className="headLeft">
            <div className="title">SCANNER</div>
            <div className="sub">
              Last scan: <b>{lastScan}</b> • Regime: <b>{regime.label}</b>{" "}
              {Number.isFinite(n(regime.score, NaN)) ? <span className="muted">• score {safe(regime.score, 2)}</span> : null}
            </div>

            <div className="regimeBar">
              <div className="regimeFill" style={{ width: `${scorePos * 100}%`, background: scoreColor }} />
            </div>
          </div>

          <div className="nav">
            <Link href="/bull"><button className="navBtn">Bull</button></Link>
            <Link href="/bear"><button className="navBtn active">Bear</button></Link>
            <Link href="/analyse"><button className="navBtn">Analyse</button></Link>
            <Link href="/trade"><button className="navBtn">Trade</button></Link>
          </div>
        </header>

        <main className="mainGrid">
          <StagePanel title="ENTRY READY" items={entry} onPick={setSelected} />
          <StagePanel title="SETUP" items={setup} onPick={setSelected} />
          <StagePanel title="WARMUP" items={warmup} onPick={setSelected} />
          <StagePanel title="RADAR" items={radar} onPick={setSelected} />
        </main>
      </div>

      <Modal coin={selected} mode={mode} onClose={() => setSelected(null)} />

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: radial-gradient(1200px 700px at 20% 0%, rgba(61, 124, 255, 0.18), transparent 60%),
            radial-gradient(900px 600px at 90% 20%, rgba(0, 255, 240, 0.08), transparent 55%),
            linear-gradient(180deg, #061028, #050a16);
          color: #eaf1ff;
          padding: 18px;
        }
        .top {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          padding: 14px 14px 16px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          backdrop-filter: blur(10px);
        }
        .headLeft {
          min-width: 0;
        }
        .title {
          font-size: 24px;
          font-weight: 900;
          letter-spacing: 0.04em;
        }
        .sub {
          margin-top: 6px;
          font-size: 13px;
          color: rgba(234, 241, 255, 0.7);
          line-height: 1.35;
        }
        .muted {
          color: rgba(234, 241, 255, 0.52);
          font-weight: 700;
        }
        .regimeBar {
          margin-top: 10px;
          height: 10px;
          width: min(420px, 100%);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .regimeFill {
          height: 100%;
          border-radius: 999px;
        }
        .nav {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .navBtn {
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.05);
          color: rgba(234, 241, 255, 0.88);
          font-weight: 900;
          border-radius: 16px;
          padding: 12px 14px;
          cursor: pointer;
        }
        .navBtn.active {
          background: rgba(47, 102, 255, 0.85);
          border-color: rgba(47, 102, 255, 0.9);
          color: #fff;
        }
        .mainGrid {
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }
        @media (max-width: 980px) {
          .top {
            flex-direction: column;
            align-items: stretch;
          }
          .mainGrid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </>
  );
}