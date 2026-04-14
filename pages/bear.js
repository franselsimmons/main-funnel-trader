import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

const STAGES = [
  { key: "entry_ready", title: "ENTRY READY", hint: "Klaar voor short entry gate" },
  { key: "setup", title: "SETUP", hint: "Mist nog 1–2 checks" },
  { key: "warmup", title: "WARMUP", hint: "Flow bouwt op" },
  { key: "radar", title: "RADAR", hint: "Eerste instroom" },
];

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function fmtPrice(v) {
  const x = n(v, 0);
  if (x >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (x >= 1) return x.toFixed(2);
  if (x >= 0.01) return x.toFixed(4);
  return x.toFixed(6);
}

function fmtPct(v) {
  const x = n(v, 0);
  return `${x > 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function fmtUsd(v) {
  const x = n(v, 0);
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(2)}K`;
  return `$${x.toFixed(0)}`;
}

function scoreOf(c) {
  const raw = n(c?.aiScore ?? c?.confidence ?? 0, 0);
  return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
}

function changeOf(c) {
  return n(c?.change24 ?? c?.momentum ?? c?.change1h, 0);
}

function logoOf(c) {
  return c?.image || c?.logo || c?.icon || "";
}

function confColor(v) {
  if (v >= 80) return "#22c55e";
  if (v >= 60) return "#3b82f6";
  if (v >= 40) return "#f59e0b";
  return "#ef4444";
}

function changeClass(v) {
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "neutral";
}

function regimeLabel(data) {
  return (
    data?.regime?.label ||
    data?.regime?.state ||
    data?.btc?.state ||
    "NEUTRAL"
  );
}

function regimeScore(data) {
  return Math.min(100, Math.abs(n(data?.regime?.score ?? data?.btc?.chg24 ?? 0, 0) * 8));
}

export default function Bear() {
  const mode = "bear";
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  async function load() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, {
        cache: "no-store",
        headers: { pragma: "no-cache", "cache-control": "no-cache" },
      });
      const j = await r.json();
      setData(j);
    } catch {
      setData(null);
    }
  }

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summary = useMemo(() => {
    return STAGES.map((s) => ({
      ...s,
      count: arr(data?.funnel?.[s.key]).length,
    }));
  }, [data]);

  return (
    <div className="pageShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandTitle">BEAR SCANNER</div>
          <div className="brandMeta">
            Laatste scan: {data?.ts ? new Date(data.ts).toLocaleString() : "—"}
          </div>

          <div className="regimeBlock">
            <div className="regimeMeta">
              <span>Regime</span>
              <strong>{regimeLabel(data)}</strong>
            </div>
            <div className="regimeMeter">
              <div
                className="regimeFill bearish"
                style={{ width: `${regimeScore(data)}%` }}
              />
            </div>
          </div>

          <div className="summaryRow">
            {summary.map((s) => (
              <div key={s.key} className="summaryChip">
                <span>{s.title}</span>
                <strong>{s.count}</strong>
              </div>
            ))}
          </div>
        </div>

        <nav className="navRow">
          <Link href="/bull" className="navBtn">Bull</Link>
          <Link href="/bear" className="navBtn active">Bear</Link>
          <Link href="/analyse" className="navBtn">Analyse</Link>
          <Link href="/trade" className="navBtn">Trade</Link>
        </nav>
      </header>

      <main className="panels">
        {STAGES.map((stage) => {
          const items = arr(data?.funnel?.[stage.key]);

          return (
            <section key={stage.key} className="panel">
              <div className="panelHead">
                <div>
                  <div className="panelTitle">{stage.title}</div>
                  <div className="panelHint">{stage.hint}</div>
                </div>
                <div className="panelCount">{items.length}</div>
              </div>

              <div className="coinGrid">
                {!items.length && <div className="emptyState">Geen coins</div>}

                {items.map((coin) => {
                  const score = scoreOf(coin);
                  const change = changeOf(coin);

                  return (
                    <button
                      key={`${stage.key}-${coin.symbol}`}
                      type="button"
                      className="coinButton"
                      onClick={() => setSelected(coin)}
                    >
                      <div className="coinCore">
                        <div className="coinLeft">
                          {logoOf(coin) ? (
                            <img
                              src={logoOf(coin)}
                              alt={coin.symbol || "coin"}
                              className="coinAvatar"
                            />
                          ) : (
                            <div className="coinAvatarText">
                              {(coin.symbol || "?").slice(0, 2)}
                            </div>
                          )}

                          <div className="coinText">
                            <div className="coinSymbol">{coin.symbol || "—"}</div>
                            <div className="coinName">{coin.name || "Onbekend"}</div>
                          </div>
                        </div>

                        <div className="coinMarket">
                          <div className="coinPrice">${fmtPrice(coin.price)}</div>
                          <div className={`coinChange ${changeClass(change)}`}>
                            {fmtPct(change)}
                          </div>
                        </div>
                      </div>

                      <div className="coinFooter">
                        <div className="scorePill">{score}/100</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>

      {selected && (
        <div className="modalBackdrop" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalTop">
              <div>
                <div className="modalTitle">
                  {selected.name || selected.symbol} ({selected.symbol || "—"})
                </div>
                <div className="modalSubtitle">
                  Stage: {String(selected.stage || selected.pipelineStage || "—").toUpperCase()}
                </div>
              </div>

              <button
                type="button"
                className="closeBtn"
                onClick={() => setSelected(null)}
              >
                ✕
              </button>
            </div>

            <div className="modalGrid">
              <div className="metricBox">
                <div className="metricLabel">Prijs</div>
                <div className="metricValue">${fmtPrice(selected.price)}</div>
              </div>

              <div className="metricBox">
                <div className="metricLabel">24h</div>
                <div className={`metricValue ${changeClass(changeOf(selected))}`}>
                  {fmtPct(changeOf(selected))}
                </div>
              </div>

              <div className="metricBox">
                <div className="metricLabel">AI score</div>
                <div className="metricValue">{scoreOf(selected)}/100</div>
              </div>

              <div className="metricBox">
                <div className="metricLabel">Spread</div>
                <div className="metricValue">
                  {n(selected?.ob?.spreadPct, 0).toFixed(3)}%
                </div>
              </div>
            </div>

            <div className="modalSection">
              <div className="sectionHeading">Market</div>
              <div className="detailsGrid">
                <div className="detailItem">
                  <span className="detailLabel">Volume</span>
                  <span className="detailValue">{fmtUsd(selected.volume)}</span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">Market cap</span>
                  <span className="detailValue">{fmtUsd(selected.marketCap)}</span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">Momentum</span>
                  <span className={`detailValue ${changeClass(n(selected.momentum, 0))}`}>
                    {fmtPct(selected.momentum)}
                  </span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">VolAcc</span>
                  <span className="detailValue">
                    {n(selected.volumeAcceleration ?? selected?.volAcc?.short ?? selected?.volAcc, 0).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <div className="modalSection">
              <div className="sectionHeading">Liquidity</div>
              <div className="detailsGrid">
                <div className="detailItem">
                  <span className="detailLabel">Best bid</span>
                  <span className="detailValue">{fmtPrice(selected?.ob?.bestBid)}</span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">Best ask</span>
                  <span className="detailValue">{fmtPrice(selected?.ob?.bestAsk)}</span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">Depth 1%</span>
                  <span className="detailValue">{fmtUsd(selected?.ob?.depthMinUsd1p)}</span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">OB score</span>
                  <span className="detailValue">
                    {n(selected?.ob?.score, 0).toFixed(4)}
                  </span>
                </div>
              </div>
            </div>

            <div className="modalSection">
              <div className="sectionHeading">Trade plan</div>
              <div className="detailsGrid">
                <div className="detailItem">
                  <span className="detailLabel">Entry</span>
                  <span className="detailValue">
                    {selected?.tradePlan?.entry ? `$${fmtPrice(selected.tradePlan.entry)}` : "—"}
                  </span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">SL</span>
                  <span className="detailValue">
                    {selected?.tradePlan?.sl ? `$${fmtPrice(selected.tradePlan.sl)}` : "—"}
                  </span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">TP</span>
                  <span className="detailValue">
                    {selected?.tradePlan?.tp ? `$${fmtPrice(selected.tradePlan.tp)}` : "—"}
                  </span>
                </div>
                <div className="detailItem">
                  <span className="detailLabel">R:R</span>
                  <span className="detailValue">
                    {selected?.tradePlan?.rr ? n(selected.tradePlan.rr, 0).toFixed(2) : "—"}
                  </span>
                </div>
              </div>
            </div>

            <div className="modalSection">
              <div className="sectionHeading">Execution</div>
              <div className="chipRow">
                <span className="chip neutral">mode: bear</span>
                <span className="chip neutral">
                  gate: {String(selected.deskGate || selected.tradeDeskStatus || selected.engineGate || selected.scannerGate || "—").toUpperCase()}
                </span>
                <span className="chip neutral">
                  stage: {String(selected.stage || selected.pipelineStage || "—").toUpperCase()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}