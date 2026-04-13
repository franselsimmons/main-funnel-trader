import { useEffect, useState } from "react";

export default function Analyse() {
  const [bull, setBull] = useState(null);
  const [bear, setBear] = useState(null);

  useEffect(() => {
    fetch("/api/state?mode=bull").then(r=>r.json()).then(setBull);
    fetch("/api/state?mode=bear").then(r=>r.json()).then(setBear);
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">SYSTEM ANALYSE</div>
      </header>

      <main style={{padding:40}}>
        <div className="panel">
          <h3>Bull</h3>
          <p>Entry: {bull?.funnel?.entry_ready?.length}</p>
          <p>Setup: {bull?.funnel?.setup?.length}</p>
        </div>

        <div className="panel" style={{marginTop:20}}>
          <h3>Bear</h3>
          <p>Entry: {bear?.funnel?.entry_ready?.length}</p>
          <p>Setup: {bear?.funnel?.setup?.length}</p>
        </div>
      </main>
    </>
  );
}