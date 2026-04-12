import Navbar from "../components/Navbar"
import { kv } from "@vercel/kv"

export async function getServerSideProps() {
  const candidates = await kv.get("bear:scanner:candidates") || []
  const approved = await kv.get("bear:funnel:approved") || []
  const positions = await kv.get("positions:open") || []

  return {
    props: {
      scannerCount: candidates.length,
      approvedCount: approved.length,
      openPositions: positions.length,
      regime: "NEUTRAL"
    }
  }
}

export default function Bear({ regime, scannerCount, approvedCount, openPositions }) {

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