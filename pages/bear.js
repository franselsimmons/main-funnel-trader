import Navbar from "../components/Navbar"

export default function Bear({ scannerCount }) {

  const regime = "NEUTRAL"

  function getBadgeClass() {
    if (regime === "TREND")
      return "badge badge-bull"
    if (regime === "NEUTRAL")
      return "badge badge-neutral"
    return "badge badge-bear"
  }

  return (
    <>
      <Navbar />
      <div className="container">

        <h1>Bear Dashboard</h1>

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
            <div className="metric">0</div>
          </div>

          <div className="card">
            <h3>Open Positions</h3>
            <div className="metric">0</div>
          </div>

        </div>

      </div>
    </>
  )
}

export async function getServerSideProps() {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "https://main-funnel-trader.vercel.app"

  const res = await fetch(base + "/api/debug")
  const data = await res.json()

  return {
    props: {
      scannerCount: data.bearCount || 0
    }
  }
}