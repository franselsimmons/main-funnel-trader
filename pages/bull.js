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
          coins.map((coin) => (
            <div key={coin.symbol} className="coin-row">
              <div className="coin-left">
                <strong>{coin.symbol}</strong>
                <span>{(coin.score * 100).toFixed(1)}%</span>
              </div>
              <div className="coin-right">
                {coin.entry ? coin.entry.toFixed(4) : "-"}
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
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch("/api/dashboard?side=bull")
      .then(res => {
        if (!res.ok) throw new Error("API error")
        return res.json()
      })
      .then(setData)
      .catch(() => setError("Fout bij laden dashboard"))
  }, [])

  if (error) {
    return (
      <Layout>
        <div className="dashboard-header">
          <h1>Bull Dashboard</h1>
          <div className="status error">{error}</div>
        </div>
      </Layout>
    )
  }

  if (!data) return null

  const lastScan =
    data.lastScan
      ? new Date(data.lastScan).toLocaleTimeString()
      : "Never"

  return (
    <Layout>
      <div className="dashboard-header">
        <h1>Bull Dashboard</h1>
        <div className="status">Last Scan: {lastScan}</div>
      </div>

      <Bucket
        title="TRADE READY"
        subtitle="Scanner-signalen die entry-ready zijn."
        coins={data.tradeReady || []}
      />

      <Bucket
        title="SETUP"
        subtitle="Bijna trade-ready — mist nog 1–2 gates."
        coins={data.setup || []}
      />

      <Bucket
        title="WARMUP"
        subtitle="Momentum bouwt op."
        coins={data.warmup || []}
      />
    </Layout>
  )
}