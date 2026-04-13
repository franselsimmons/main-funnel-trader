import { useEffect, useState } from "react"
import Layout from "../components/layout"

function Bucket({ title, subtitle, coins }) {
  return (
    <div className="bucket-card">
      <div className="bucket-header">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      <div className="bucket-inner">
        {coins.length === 0 ? (
          <div className="empty">Geen coins.</div>
        ) : (
          coins.map(c => (
            <div key={c.symbol} className="coin-row">
              <div className="coin-left">
                <strong>{c.symbol}</strong>
                <span>{(c.score * 100).toFixed(1)}%</span>
              </div>
              <div className="coin-right">
                {c.entry?.toFixed?.(4) || "-"}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default function Bull() {
  const [data, setData] = useState(null)

  useEffect(() => {
    fetch("/api/dashboard?side=bull")
      .then(r => r.json())
      .then(setData)
  }, [])

  if (!data) return null

  const lastScan =
    data.lastScan
      ? new Date(data.lastScan).toLocaleTimeString()
      : "Never"

  return (
    <Layout>
      <div className="dashboard-header">
        <h1>Bull Dashboard</h1>
        <div className="status">
          Last Scan: {lastScan}
        </div>
      </div>

      <Bucket
        title="TRADE READY"
        subtitle="Scanner-signalen die entry-ready zijn."
        coins={data.tradeReady}
      />

      <Bucket
        title="SETUP"
        subtitle="Bijna trade-ready — mist nog 1–2 gates."
        coins={data.setup}
      />

      <Bucket
        title="WARMUP"
        subtitle="Momentum bouwt op."
        coins={data.warmup}
      />
    </Layout>
  )
}