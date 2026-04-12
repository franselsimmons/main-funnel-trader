import useSWR from "swr"
import Layout from "../components/Layout"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Bear() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const coins = data?.bear?.coins || []
  const lastScan = data?.bear?.lastScan

  return (
    <Layout title="Bear Dashboard" lastScan={lastScan}>

      <div className="section-header">
        Scanner Candidates ({coins.length})
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
            {coins.map(c => (
              <tr key={c.symbol}>
                <td>{c.symbol}</td>
                <td>${c.price?.toLocaleString()}</td>
                <td>${c.volume?.toLocaleString()}</td>
                <td className={c.change24h > 0 ? "pos" : "neg"}>
                  {c.change24h?.toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </Layout>
  )
}