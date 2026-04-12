import useSWR from "swr"
import Navbar from "../components/Navbar"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Bear() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const regime = "NEUTRAL"

  const scannerCount = data?.bear?.scanner || 0
  const approvedCount = data?.bear?.approved || 0
  const openPositions = data?.bear?.open || 0

  function getBadgeClass() {
    if (regime === "TREND") return "badge badge-bull"
    if (regime === "NEUTRAL") return "badge badge-neutral"
    return "badge badge-bear"
  }

  return (
    <>
      <Navbar />

      <div className="container">
        <h1>Bear Dashboard</h1>

        <div style={{ marginTop: 20 }}>
          <span className={getBadgeClass()}>{regime}</span>
        </div>

        <div className="card-grid">
          <div className="card">
            <h3>Scanner Candidates</h3>
            <div className="metric">{scannerCount}</div>
          </div>

          <div className="card">
            <h3>Approved Trades</h3>
            <div className="metric">{approvedCount}</div>
          </div>

          <div className="card">
            <h3>Open Positions</h3>
            <div className="metric">{openPositions}</div>
          </div>
        </div>
      </div>
    </>
  )
}