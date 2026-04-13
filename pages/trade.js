import { useEffect, useState } from "react"
import Layout from "../components/layout"

export default function Trade() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch("/api/dashboard?side=bull")
      .then(res => res.json())
      .then(bullData => {
        fetch("/api/dashboard?side=bear")
          .then(res => res.json())
          .then(bearData => {
            setData({
              bullTrades: bullData.trades || [],
              bearTrades: bearData.trades || []
            })
          })
      })
      .catch(() => setError("Fout bij laden trades"))
  }, [])

  if (error) {
    return (
      <Layout>
        <div className="dashboard-header">
          <h1>Live Trade Signals</h1>
          <div className="status error">{error}</div>
        </div>
      </Layout>
    )
  }

  if (!data) return null

  const allTrades = [
    ...data.bullTrades.map(t => ({ ...t, side: "LONG" })),
    ...data.bearTrades.map(t => ({ ...t, side: "SHORT" }))
  ]

  return (
    <Layout>
      <div className="dashboard-header">
        <h1>Live Trade Signals</h1>
        <div className="status">
          Actieve trades van de engine
        </div>
      </div>

      <div className="bucket-card">
        <div className="bucket-inner">
          {allTrades.length === 0 ? (
            <div className="empty">Geen actieve trades.</div>
          ) : (
            allTrades.map((trade, index) => (
              <div key={index} className="coin-row">
                <div className="coin-left">
                  <strong>{trade.symbol}</strong>
                  <span>{trade.side}</span>
                </div>
                <div className="coin-right">
                  Entry: {trade.entry?.toFixed(4)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  )
}