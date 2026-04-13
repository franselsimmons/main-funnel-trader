import { useEffect, useState } from "react";

export default function Trade() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull")
      .then(r => r.json())
      .then(setData);
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">TRADE DESK</div>
      </header>

      <main style={{padding:40}}>
        <div className="panel">
          <h3>Active Entry Candidates</h3>
          {data?.funnel?.entry_ready?.map(c => (
            <div key={c.symbol} className="coin">
              {c.symbol} — Entry ${c.tradePlan?.entry}
            </div>
          )) || <div className="empty">Geen entries</div>}
        </div>
      </main>
    </>
  );
}