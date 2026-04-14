import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

function n(x, d = null) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function fmtUsd(v, digits = 2) {
  const x = n(v, null);
  if (x === null) return "—";
  if (x >= 1e12) return `$${(x / 1e12).toFixed(2)}T`;
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(2)}K`;
  return `$${x.toFixed(digits)}`;
}
function fmtPct(v, digits = 2) {
  const x = n(v, null);
  if (x === null) return "—";
  const s = x >= 0 ? "+" : "";
  return `${s}${x.toFixed(digits)}%`;
}
function safeNum(v, digits = 6) {
  const x = n(v, null);
  if (x === null) return "—";
  return x.toFixed(digits);
}
function confColor(v) {
  const x = Math.max(0, Math.min(100, n(v, 0)));
  if (x >= 80) return "#22C55E";
  if (x >= 60) return "#3B82F6";
  if (x >= 40) return "#F59E0B";
  return "#EF4444";
}
function obOf(c) {
  return c?.ob || c?.orderbook || c?.orderBook || null;
}

function normalizeFunnel(payload) {
  if (payload?.funnel && typeof payload.funnel === "object") return payload.funnel;
  const sample = Array.isArray(payload?.stateSample) ? payload.stateSample[0] : null;
  if (sample && typeof sample === "object") return sample;
  return { entry_ready: [], setup: [], warmup: [], radar: [] };
}

async function fetchCgDetailsBySymbol(symbol) {
  const q = encodeURIComponent(String(symbol || "").toLowerCase());
  const r1 = await fetch(`https://api.coingecko.com/api/v3/search?query=${q}`);
  const j1 = await r1.json();
  const first = Array.isArray(j1?.coins) ? j1.coins[0] : null;
  if (!first?.id) return null;

  const id = encodeURIComponent(first.id);
  const r2 = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&sparkline=false&price_change_percentage=24h`
  );
  const j2 = await r2.json();
  const row = Array.isArray(j2) ? j2[0] : null;
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    image: row.image,
    marketCap: row.market_cap,
    volume: row.total_volume,
    high24: row.high_24h,
    low24: row.low_24h,
    change24: row.price_change_percentage_24h,
    ath: row.ath,
    atl: row.atl,
  };
}

export default function Bear() {
  const mode = "bear";
  const [data, setData] = useState(null);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [extraBySym, setExtraBySym] = useState({});
  const [loadingExtra, setLoadingExtra] = useState(false);

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  const funnel = useMemo(() => normalizeFunnel(data), [data]);

  function scoreOf(c) {
    const ai = n(c?.aiScore, null);
    if (ai !== null) return Math.max(0, Math.min(100, Math.round(ai)));
    const conf = n(c?.confidence, null);
    if (conf === null) return 0;
    return Math.max(0, Math.min(100, Math.round(conf)));
  }

  function openModal(c) {
    setSelected(c);
    setOpen(true);

    const sym = String(c?.symbol || "").toUpperCase();
    if (!sym) return;
    if (extraBySym[sym]) return;

    setLoadingExtra(true);
    fetchCgDetailsBySymbol(sym)
      .then((extra) => {
        if (extra) setExtraBySym((prev) => ({ ...prev, [sym]: extra }));
      })
      .finally(() => setLoadingExtra(false));
  }

  function closeModal() {
    setOpen(false);
    setSelected(null);
  }

  function Stage({ title, items }) {
    const arr = Array.isArray(items) ? items : [];
    return (
      <section className="stagePanel">
        <div className="stageHeader">
          <div className="stageTitle">{title}</div>
          <div className="stageCount">{arr.length}</div>
        </div>

        {!arr.length && <div className="empty">Geen coins</div>}

        <div className="coinList">
          {arr.map((c) => {
            const sym = String(c.symbol || "").toUpperCase();
            const conf = scoreOf(c);
            const mom = n(c?.momentum, n(c?.change24h, n(c?.change24, null)));
            const price = n(c?.price, n(c?.current_price, null));
            const e = extraBySym[sym];
            const name = e?.name || c?.name || "";

            return (
              <button
                type="button"
                key={`${title}:${sym}`}
                className="coinCard"
                onClick={() => openModal(c)}
              >
                <div className="coinRow">
                  <div className="coinLeft">
                    <div className="symbol">{sym || "—"}</div>
                    <div className="subLine">
                      <span className="muted">{name}</span>
                    </div>
                    <div className="price">{price === null ? "—" : `$${safeNum(price, 6)}`}</div>
                  </div>

                  <div className="coinRight">
                    <div className="confText">{conf}/100</div>
                    <div className={`mom ${mom === null ? "" : mom >= 0 ? "pos" : "neg"}`}>
                      {mom === null ? "—" : fmtPct(mom, 2)}
                    </div>
                  </div>
                </div>

                <div className="confBarWrap">
                  <div
                    className="confBar"
                    style={{ width: `${conf}%`, background: confColor(conf) }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  const ts = n(data?.ts, n(data?.scannedAt, null));
  const regimeLabel = data?.regime?.label || data?.regime || "NEUTRAL";
  const regimeScoreRaw = n(data?.regime?.score, 0);
  const regimeFill = Math.max(0, Math.min(100, Math.abs(regimeScoreRaw)));

  const symSel = String(selected?.symbol || "").toUpperCase();
  const extra = symSel ? extraBySym[symSel] : null;
  const ob = selected ? obOf(selected) : null;

  const priceSel = n(selected?.price, n(selected?.current_price, null));
  const momSel = n(selected?.momentum, n(selected?.change24h, n(selected?.change24, null)));
  const volSel = n(selected?.volume, n(extra?.volume, null));
  const mcSel = n(selected?.marketCap, n(extra?.marketCap, null));

  const spreadSel = n(ob?.spreadPct, null);
  const bestBid = n(ob?.bestBid, null);
  const bestAsk = n(ob?.bestAsk, null);
  const depth1p = n(ob?.depthMinUsd1p, n(ob?.depthMin, null));
  const obScore = n(ob?.score, n(ob?.imbalance, null));

  const plan = selected?.tradePlan || null;

  return (
    <>
      <header className="scannerHeader">
        <div className="headerLeft">
          <div className="scannerTitle">SCANNER</div>
          <div className="scannerSub">
            Last scan: {ts ? new Date(ts).toLocaleString() : "—"} · Regime:{" "}
            <span className="pill">{String(regimeLabel).toUpperCase()}</span>
          </div>

          <div className="regimeWrap">
            <div className="regimeBar">
              <div
                className="regimeFill"
                style={{
                  width: `${regimeFill}%`,
                  background: regimeScoreRaw >= 0 ? "#22C55E" : "#EF4444",
                }}
              />
            </div>
            <div className="regimeHint">
              score {Number.isFinite(regimeScoreRaw) ? regimeScoreRaw.toFixed(2) : "—"}
            </div>
          </div>
        </div>

        <div className="navButtons">
          <Link href="/bull">
            <button className="navBtn">Bull</button>
          </Link>
          <Link href="/bear">
            <button className="navBtn active">Bear</button>
          </Link>
          <Link href="/analyse">
            <button className="navBtn">Analyse</button>
          </Link>
          <Link href="/trade">
            <button className="navBtn">Trade</button>
          </Link>
        </div>
      </header>

      <main className="scannerGrid">
        <Stage title="ENTRY READY" items={funnel?.entry_ready} />
        <Stage title="SETUP" items={funnel?.setup} />
        <Stage title="WARMUP" items={funnel?.warmup} />
        <Stage title="RADAR" items={funnel?.radar} />
      </main>

      <div className={`modal ${open ? "" : "hidden"}`} onClick={closeModal}>
        <div className="modalCard" onClick={(e) => e.stopPropagation()}>
          <div className="modalTop">
            <div>
              <div className="modalTitle">
                {symSel || "—"} <span className="muted">· {mode.toUpperCase()}</span>
              </div>
              <div className="modalSub">
                {extra?.name ? extra.name : selected?.name || ""}{" "}
                {loadingExtra ? <span className="muted">· laden…</span> : null}
              </div>
            </div>
            <button className="navBtn" onClick={closeModal}>
              Sluiten
            </button>
          </div>

          <div className="modalGrid">
            <section className="modalSection">
              <div className="sectionLabel">Market</div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">Price</div>
                  <div className="kvVal">{priceSel === null ? "—" : `$${safeNum(priceSel, 6)}`}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Momentum (24h)</div>
                  <div className={`kvVal ${momSel === null ? "" : momSel >= 0 ? "pos" : "neg"}`}>
                    {momSel === null ? "—" : fmtPct(momSel, 2)}
                  </div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Volume</div>
                  <div className="kvVal">{fmtUsd(volSel, 0)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Market cap</div>
                  <div className="kvVal">{fmtUsd(mcSel, 0)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">24h High / Low</div>
                  <div className="kvVal">
                    {extra?.high24 != null && extra?.low24 != null
                      ? `${safeNum(extra.high24, 6)} / ${safeNum(extra.low24, 6)}`
                      : "—"}
                  </div>
                </div>
              </div>
            </section>

            <section className="modalSection">
              <div className="sectionLabel">Liquidity</div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">Spread</div>
                  <div className="kvVal">{spreadSel === null ? "—" : `${safeNum(spreadSel, 3)}%`}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Best bid</div>
                  <div className="kvVal">{bestBid === null ? "—" : safeNum(bestBid, 6)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Best ask</div>
                  <div className="kvVal">{bestAsk === null ? "—" : safeNum(bestAsk, 6)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">Depth 1%</div>
                  <div className="kvVal">{depth1p === null ? "—" : fmtUsd(depth1p, 0)}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">OB score</div>
                  <div className="kvVal">{obScore === null ? "—" : safeNum(obScore, 4)}</div>
                </div>
              </div>
            </section>

            <section className="modalSection">
              <div className="sectionLabel">Trade plan</div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">Entry</div>
                  <div className="kvVal">{plan?.entry != null ? `$${safeNum(plan.entry, 6)}` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">SL</div>
                  <div className="kvVal">{plan?.sl != null ? `$${safeNum(plan.sl, 6)}` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">TP</div>
                  <div className="kvVal">{plan?.tp != null ? `$${safeNum(plan.tp, 6)}` : "—"}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">R:R</div>
                  <div className="kvVal">{plan?.rr != null ? safeNum(plan.rr, 2) : "—"}</div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}