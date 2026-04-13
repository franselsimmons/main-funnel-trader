import useSWR from "swr"
import Navbar from "../components/Navbar"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Trade() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const bullTrades = data?.bull?.approved || []
  const bearTrades = data?.bear?.approved || []

  const allTrades = [...bullTrades, ...bearTrades]

  return (
    <>
      <Navbar />

      <div className="page">
        <div className="page-inner">

          <h1>Live Trade Signals</h1>

          <div className="table-wrapper" style={{marginTop:30}}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Direction</th>
                  <th>Entry</th>
                  <th>24h %</th>
                  <th>Volume</th>
                </tr>
              </thead>
              <tbody>
                {allTrades.map((trade, i) => (
                  <tr key={i}>
                    <td>{trade.symbol}</td>
                    <td style={{
                      color: trade.direction === "LONG" ? "#22c55e" : "#ef4444",
                      fontWeight:600
                    }}>
                      {trade.direction}
                    </td>
                    <td>${trade.price}</td>
                    <td className={trade.change24h >= 0 ? "pos" : "neg"}>
                      {trade.change24h.toFixed(2)}%
                    </td>
                    <td>${trade.volume.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>
      </div>
    </>
  )
}