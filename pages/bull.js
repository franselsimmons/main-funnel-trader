import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

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

function confColor(v) {
  const x = n(v, 0);
  if (x >= 80) return "#22C55E";
  if (x >= 60) return "#3B82F6";
  if (x >= 40) return "#F59E0B";
  return "#EF4444";
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(n(v, 0))));
}

function pick(obj, keys, fallback = undefined) {
  for (const k of keys) {
    const val = obj?.[k];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return fallback;
}

function normalizeCoin(c) {
  const symbol = String(c?.symbol || "").toUpperCase();

  // Probeer meerdere mogelijke backend keys (jij hebt verschillende iteraties gehad)
  const name = pick(c, ["name", "projectName"], "") || "";
  const price = pick(c, ["price", "current_price"], null);

  const change24 =
    pick(c, ["change24", "change24h", "price_change_percentage_24h", "momentum"], null);

  const volume =
    pick(c, ["volume", "total_volume", "volUsd", "volumeUsd"], null);

  const marketCap =
    pick(c, ["marketCap", "market_cap"], null);

  const vm = pick(c, ["vm"], null);

  const volAcc =
    pick(c, ["volAcc", "volumeAcceleration", "volume_acceleration"], null);

  const ob = pick(c, ["ob", "orderbook"], null) || null;
  const spreadPct = ob ? pick(ob, ["spreadPct", "spread_pct", "spreadPct"], null) : null;
  const depth1p = ob ? pick(ob, ["depthMinUsd1p", "depthMin", "depth1p", "depthMinUsd"], null) : null;
  const obScore = ob ? pick(ob, ["score", "imbalance", "obScore"], null) : null;
  const bestBid = ob ? pick(ob, ["bestBid"], null) : null;
  const bestAsk = ob ? pick(ob, ["bestAsk"], null) : null;

  const tradePlan = pick(c, ["tradePlan", "plan"], null) || null;

  // score: aiScore > confidence > entryQuality
  const aiScore = pick(c, ["aiScore"], null);
  const confidence = pick(c, ["confidence", "entryQuality"], null);

  const score = clampPct(
    Number.isFinite(Number(aiScore)) ? aiScore : Number.isFinite(Number(confidence)) ? confidence : 0
  );

  return {
    raw: c,
    symbol,
    name,
    price,
    change24,
    volume,
    marketCap,
    vm,
    volAcc,
    score,
    ob: ob
      ? {
          spreadPct,
          depth1p,
          obScore,
          bestBid,
          bestAsk,
        }
      : null,
    tradePlan,
  };
}

function Modal({ open, onClose, coin, mode }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !coin) return null;

  const c = coin;
  const plan = c.tradePlan || {};
  const side = mode === "bear" ? "SHORT" : "LONG";

  const spreadTxt =
    c.ob?.spreadPct !== null && c.ob?.spreadPct !== undefined
      ? `${n(c.ob.spreadPct, 0).toFixed(3)}%`
      : "—";

  const depthTxt =
    c.ob?.depth1p !== null && c.ob?.depth1p !== undefined
      ? `$${Math.round(n(c.ob.depth1p, 0)).toLocaleString()}`
      : "—";

  const obScoreTxt =
    c.ob?.obScore !== null && c.ob?.obScore !== undefined
      ? n(c.ob.obScore, 0).toFixed(4)
      : "—";

  const bestBidTxt =
    c.ob?.bestBid !== null && c.ob?.bestBid !== undefined ? n(c.ob.bestBid, 0).toFixed(8) : "—";
  const bestAskTxt =
    c.ob?.bestAsk !== null && c.ob?.bestAsk !== undefined ? n(c.ob.bestAsk, 0).toFixed(8) : "—";

  const entry = pick(plan, ["entry"], null);
  const sl = pick(plan, ["sl"], null);
  const tp = pick(plan, ["tp"], null);
  const rr = pick(plan, ["rr"], null);

  return (
    <div
      className="ccModalOverlay"
      onMouseDown={(e) => {
        if (e.target.classList.contains("ccModalOverlay")) onClose?.();
      }}
    >
      <div className="ccModalCard">
        <div className="ccModalTop">
          <div>
            <div className="ccModalTitle">
              {c.symbol} <span className="ccPill">{side}</span>
            </div>
            <div className="ccModalSub">
              {c.name ? c.name + " • " : ""}
              {fmtUSD(c.price, 6)} • 24h {fmtPct(c.change24)} • Score {c.score}/100
            </div>
          </div>
          <button className="ccBtn" onClick={onClose}>
            Sluiten
          </button>
        </div>

        <div className="ccModalGrid">
          <section className="ccPanel">
            <div className="ccPanelTitle">Market</div>
            <div className="ccKV">
              <div className="ccKVRow">
                <div className="ccKVKey">Price</div>
                <div className="ccKVVal">{fmtUSD(c.price, 8)}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">24h</div>
                <div className="ccKVVal">{fmtPct(c.change24)}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">Volume</div>
                <div className="ccKVVal">
                  {c.volume !== null && c.volume !== undefined ? `$${Math.round(n(c.volume, 0)).toLocaleString()}` : "—"}
                </div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">Market cap</div>
                <div className="ccKVVal">
                  {c.marketCap !== null && c.marketCap !== undefined ? `$${Math.round(n(c.marketCap, 0)).toLocaleString()}` : "—"}
                </div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">VM</div>
                <div className="ccKVVal">{c.vm !== null && c.vm !== undefined ? n(c.vm, 4).toFixed(4) : "—"}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">VolAcc</div>
                <div className="ccKVVal">{c.volAcc !== null && c.volAcc !== undefined ? n(c.volAcc, 0).toFixed(2) : "—"}</div>
              </div>
            </div>
          </section>

          <section className="ccPanel">
            <div className="ccPanelTitle">Liquidity (Orderbook)</div>
            <div className="ccKV">
              <div className="ccKVRow">
                <div className="ccKVKey">Spread</div>
                <div className="ccKVVal">{spreadTxt}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">Depth 1%</div>
                <div className="ccKVVal">{depthTxt}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">OB score</div>
                <div className="ccKVVal">{obScoreTxt}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">Best bid</div>
                <div className="ccKVVal">{bestBidTxt}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">Best ask</div>
                <div className="ccKVVal">{bestAskTxt}</div>
              </div>
            </div>
          </section>

          <section className="ccPanel">
            <div className="ccPanelTitle">Trade plan</div>
            <div className="ccKV">
              <div className="ccKVRow">
                <div className="ccKVKey">Entry</div>
                <div className="ccKVVal">{entry !== null && entry !== undefined ? fmtUSD(entry, 8) : "—"}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">SL</div>
                <div className="ccKVVal">{sl !== null && sl !== undefined ? fmtUSD(sl, 8) : "—"}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">TP</div>
                <div className="ccKVVal">{tp !== null && tp !== undefined ? fmtUSD(tp, 8) : "—"}</div>
              </div>
              <div className="ccKVRow">
                <div className="ccKVKey">R:R</div>
                <div className="ccKVVal">{rr !== null && rr !== undefined ? n(rr, 0).toFixed(2) : "—"}</div>
              </div>
              <div className="ccHint">
                Tip: als hier “—” staat, dan bouwt de scanner nog geen plan voor deze coin (backend-key ontbreekt).
              </div>
            </div>
          </section>

          <section className="ccPanel ccPanelWide">
            <div className="ccPanelTitle">Raw object</div>
            <pre className="ccPre">{JSON.stringify(c.raw, null, 2)}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}

function StagePanel({ title, items, onSelect }) {
  const arr = Array.isArray(items) ? items : [];
  return (
    <section className="ccStage">
      <div className="ccStageTop">
        <div className="ccStageTitle">{title}</div>
        <div className="ccStageCount">{arr.length}</div>
      </div>

      {arr.length === 0 ? (
        <div className="ccEmpty">Geen coins</div>
      ) : (
        <div className="ccGrid">
          {arr.map((raw) => {
            const c = normalizeCoin(raw);
            const score = c.score;

            return (
              <button
                key={c.symbol || Math.random()}
                className="ccCoin"
                onClick={() => onSelect?.(c)}
                type="button"
              >
                <div className="ccCoinTop">
                  <div className="ccSym">{c.symbol || "—"}</div>
                  <div className="ccScore">{score}/100</div>
                </div>

                <div className="ccName">{c.name || " "}</div>

                <div className="ccPriceRow">
                  <div className="ccPrice">{fmtUSD(c.price, 6)}</div>
                  <div className={`ccChg ${n(c.change24, 0) >= 0 ? "pos" : "neg"}`}>
                    {fmtPct(c.change24)}
                  </div>
                </div>

                <div className="ccBarWrap">
                  <div className="ccBarBg">
                    <div
                      className="ccBarFill"
                      style={{ width: `${score}%`, background: confColor(score) }}
                    />
                  </div>
                </div>

                <div className="ccMini">
                  <span>volAcc {c.volAcc !== null && c.volAcc !== undefined ? n(c.volAcc, 0).toFixed(2) : "—"}</span>
                  <span>spr {c.ob?.spreadPct !== null && c.ob?.spreadPct !== undefined ? `${n(c.ob.spreadPct, 0).toFixed(2)}%` : "—"}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function Bull() {
  const mode = "bull";
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  async function loadState() {
    try {
      const r = await fetch(`/api/state?mode=${mode}`, { cache: "no-store" });
      const j = await r.json();
      setData(j);
    } catch {}
  }

  // Auto scan trigger (stil) + state refresh
  async function tickScan() {
    try {
      await fetch(`/api/scan?mode=${mode}`, { cache: "no-store" });
    } catch {}
  }

  useEffect(() => {
    loadState();
    tickScan();

    const t1 = setInterval(loadState, 15000);
    const t2 = setInterval(tickScan, 60000);

    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const lastScan = useMemo(() => {
    const ts = n(data?.ts || data?.lastScanTs || data?.scannedAt, 0);
    return ts ? new Date(ts).toLocaleString() : "—";
  }, [data]);

  const regimeLabel = useMemo(() => {
    // Fix “[OBJECT OBJECT]”
    const r = data?.regime;
    return String(r?.label || r?.regime || r?.state || "NEUTRAL");
  }, [data]);

  const regimeScore = useMemo(() => {
    const r = data?.regime;
    return n(r?.score, 0);
  }, [data]);

  const funnel = data?.funnel || {};

  return (
    <>
      <header className="ccHeader">
        <div className="ccHeaderLeft">
          <div className="ccH1">BULL SCANNER</div>
          <div className="ccSub">
            Last scan: {lastScan} • Regime: <b>{regimeLabel}</b> • score{" "}
            <b>{n(regimeScore, 0).toFixed(2)}</b>
          </div>

          <div className="ccRegimeBar">
            <div className="ccRegimeBg">
              <div
                className="ccRegimeFill"
                style={{
                  width: `${Math.min(100, Math.abs(regimeScore))}%`,
                  background: regimeScore >= 0 ? "#22C55E" : "#EF4444",
                }}
              />
            </div>
          </div>
        </div>

        <div className="ccNav">
          <Link href="/bull" className="ccNavBtn active">
            Bull
          </Link>
          <Link href="/bear" className="ccNavBtn">
            Bear
          </Link>
          <Link href="/analyse" className="ccNavBtn">
            Analyse
          </Link>
          <Link href="/trade" className="ccNavBtn">
            Trade
          </Link>
        </div>
      </header>

      <main className="ccMain">
        <StagePanel title="ENTRY READY" items={funnel.entry_ready} onSelect={setSelected} />
        <StagePanel title="SETUP" items={funnel.setup} onSelect={setSelected} />
        <StagePanel title="WARMUP" items={funnel.warmup} onSelect={setSelected} />
        <StagePanel title="RADAR" items={funnel.radar} onSelect={setSelected} />
      </main>

      <Modal open={!!selected} coin={selected} mode={mode} onClose={() => setSelected(null)} />
    </>
  );
}