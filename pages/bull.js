import Navbar from "../components/Navbar"

export default function Bull() {

  const regime = "TREND" // later dynamic
  const scannerCount = 0
  const approvedCount = 0
  const openPositions = 0

  function getBadgeClass() {
    if (regime === "EXPANSION" || regime === "TREND")
      return "badge badge-bull"
    if (regime === "NEUTRAL")
      return "badge badge-neutral"
    return "badge badge-bear"
  }

  return (
    <>
      <Navbar />

      <div className="container">

        <h1>Bull Dashboard</h1>

        <div style={{ marginTop: 20 }}>
          <span className={getBadgeClass()}>
            {regime}
          </span>
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