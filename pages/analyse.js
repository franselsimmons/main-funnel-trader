import Navbar from "../components/Navbar"

export default function Analyse() {

  const stats = {
    winrate: "67%",
    avgRR: "1.42",
    expectancy: "+0.38R"
  }

  const suggestions = [
    "Increase minimum confidence to 0.74 in Chop regime",
    "Reduce risk to 0.5% when portfolio beta > 1.5",
    "Tighten spread stability threshold by 10%"
  ]

  return (
    <>
      <Navbar />
      <div className="container">

        <h1>Analyse Meester</h1>

        <div className="card-grid">

          <div className="card">
            <h3>Winrate</h3>
            <div className="metric">{stats.winrate}</div>
          </div>

          <div className="card">
            <h3>Average RR</h3>
            <div className="metric">{stats.avgRR}</div>
          </div>

          <div className="card">
            <h3>Expectancy</h3>
            <div className="metric">{stats.expectancy}</div>
          </div>

        </div>

        <div style={{ marginTop: 40 }}>
          <h2>Suggestions</h2>

          <div className="card" style={{ marginTop: 20 }}>
            {suggestions.map((s, i) => (
              <p key={i} style={{ marginBottom: 12 }}>{s}</p>
            ))}
          </div>
        </div>

      </div>
    </>
  )
}