import { useEffect, useState } from "react"
import Layout from "../components/layout"

export default function Dashboard() {

  const [data, setData] = useState(null)

  useEffect(() => {
    fetch("/api/dashboard")
      .then(r => r.json())
      .then(setData)
  }, [])

  if (!data) return null

  const lastScan =
    data.lastScan
      ? new Date(data.lastScan).toLocaleTimeString()
      : "N/A"

  return (
    <Layout>
      <h1>Institutional Control Center</h1>

      <div className="card-grid">

        <div className="card">
          <h3>Regime</h3>
          <div className="metric">{data.regime}</div>
        </div>

        <div className="card">
          <h3>Bull Scanner</h3>
          <div className="metric">{data.scanner.bull}</div>
        </div>

        <div className="card">
          <h3>Bear Scanner</h3>
          <div className="metric">{data.scanner.bear}</div>
        </div>

        <div className="card">
          <h3>Approved Bull</h3>
          <div className="metric">{data.funnel.bull}</div>
        </div>

        <div className="card">
          <h3>Approved Bear</h3>
          <div className="metric">{data.funnel.bear}</div>
        </div>

        <div className="card">
          <h3>Total Exposure</h3>
          <div className="metric">
            {(data.portfolio.exposure * 100).toFixed(2)}%
          </div>
        </div>

        <div className="card">
          <h3>Expectancy</h3>
          <div className="metric">
            {data.edge.expectancy.toFixed(4)}
          </div>
        </div>

        <div className="card">
          <h3>Monte Carlo Median</h3>
          <div className="metric">
            {data.monte.median.toFixed(2)}
          </div>
        </div>

        <div className="card">
          <h3>Monte Worst Case</h3>
          <div className="metric">
            {data.monte.worst.toFixed(2)}
          </div>
        </div>

        <div className="card">
          <h3>Last Scan</h3>
          <div className="metric">
            {lastScan}
          </div>
        </div>

      </div>
    </Layout>
  )
}