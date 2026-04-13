import { useEffect, useState } from "react";

export default function Home() {
  const [coins, setCoins] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    load();
    const i = setInterval(load, 20000);
    return () => clearInterval(i);
  }, []);

  function load() {
    fetch("/api/overview")
      .then(r => r.json())
      .then(data => setCoins(data.coins || []))
      .catch(() => {});
  }

  function pctColor(v) {
    if (v > 0) return "#22C55E";
    if (v < 0) return "#EF4444";
    return "#94A3B8";
  }

  return (
    <>
      {/* ===== HEADER ===== */}
      <header className="overviewHeader">
        <div className="overviewTitle">MARKET OVERVIEW</div>
        <div className="overviewSub">Live crypto snapshot</div>
      </header>

      {/* ===== SIMPLE LIST ===== */}
      <main className="overviewList">
        {coins.map(c => (
          <div
            key={c.symbol}
            className="coinRowSimple"
            onClick={() => setSelected(c)}
          >
            <div className="coinLeft">
              <img src={c.logo} className="coinLogo" />
              <div className="coinNameWrap">
                <div className="coinSymbol">{c.symbol}</div>
                <div className="coinName">{c.name}</div>
              </div>
            </div>

            <div className="coinRight">
              <div className="coinPrice">${c.price}</div>
              <div
                className="coinPct"
                style={{ color: pctColor(c.change24) }}
              >
                {c.change24 > 0 ? "+" : ""}
                {c.change24.toFixed(2)}%
              </div>
            </div>
          </div>
        ))}
      </main>

      {/* ===== MODAL ===== */}
      {selected && (
        <div
          className="modalOverlay"
          onClick={() => setSelected(null)}
        >
          <div
            className="modalCard"
            onClick={e => e.stopPropagation()}
          >
            <div className="modalHeader">
              <div>
                <div className="modalTitle">
                  {selected.name} ({selected.symbol})
                </div>
                <div className="modalPrice">
                  ${selected.price}
                </div>
              </div>

              <button
                className="modalClose"
                onClick={() => setSelected(null)}
              >
                ✕
              </button>
            </div>

            <div className="modalStats">
              <div>
                <span>24h Change</span>
                <strong
                  style={{
                    color: pctColor(selected.change24)
                  }}
                >
                  {selected.change24 > 0 ? "+" : ""}
                  {selected.change24.toFixed(2)}%
                </strong>
              </div>

              <div>
                <span>Market Cap</span>
                <strong>
                  ${selected.marketCap.toLocaleString()}
                </strong>
              </div>

              <div>
                <span>Volume 24h</span>
                <strong>
                  ${selected.volume.toLocaleString()}
                </strong>
              </div>
            </div>

            {/* Chart placeholder */}
            <div className="modalChart">
              <canvas id="chartCanvas"></canvas>
            </div>

            <div className="modalDescription">
              {selected.description || "No description available."}
            </div>
          </div>
        </div>
      )}
    </>
  );
}