import { useEffect, useState } from "react"

export default function BearDashboard() {

  const [scanner, setScanner] = useState(null)
  const [funnel, setFunnel] = useState(null)
  const [portfolio, setPortfolio] = useState([])

  useEffect(() => {
    fetch("/api/bear/scanner").then(r => r.json()).then(setScanner)
    fetch("/api/bear/funnel").then(r => r.json()).then(setFunnel)
    fetch("/api/bear/engine").then(r => r.json()).then(() => {
      fetch("/api/state/bearPortfolio")
        .then(r => r.json())
        .then(setPortfolio)
    })
  }, [])

  return (
    <div style={{ padding: 30 }}>
      <h1>Bear Dashboard</h1>

      <section>
        <h2>Regime</h2>
        <div>{scanner?.regime}</div>
      </section>

      <section>
        <h2>Scanner Candidates</h2>
        <div>{scanner?.candidates?.length || 0}</div>
      </section>

      <section>
        <h2>Approved Trades</h2>
        <div>{funnel?.approved?.length || 0}</div>
      </section>

      <section>
        <h2>Open Positions</h2>
        {portfolio.map(p => (
          <div key={p.symbol}>
            {p.symbol} | Entry: {p.entry} | SL: {p.sl}
          </div>
        ))}
      </section>
    </div>
  )
}