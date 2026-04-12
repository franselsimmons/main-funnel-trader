import useSWR from "swr"
import Navbar from "../components/Navbar"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Bear() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const scanner = data?.bear?.scanner || []
  const lastScan = data?.bear?.lastScan

  const formatTime = (timestamp) => {
    if (!timestamp) return "Never"
    return new Date(timestamp).toLocaleString()
  }

  return (
    <>
      <Navbar />

      <div className="page">
        <div className="page-inner">

          <div className="page-header">
            <h1>Bear Dashboard</h1>
            <div className="scan-time">
              Last Scan: {formatTime(lastScan)}
            </div>
          </div>

          <div className="section-header">
            Scanner Candidates ({scanner.length})
          </div>

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th>Volume</th>
                  <th>24h %</th>
                </tr>
              </thead>
              <tbody>
                {scanner.map((coin) => (
                  <tr key={coin.symbol}>
                    <td>{coin.symbol}</td>
                    <td>${coin.price}</td>
                    <td>${coin.volume.toLocaleString()}</td>
                    <td className={coin.change24h >= 0 ? "pos" : "neg"}>
                      {coin.change24h.toFixed(2)}%
                    </td>
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