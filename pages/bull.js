import useSWR from "swr"
import Navbar from "../components/Navbar"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Bull() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const coins = data?.bull?.coins || []

  return (
    <>
      <Navbar />
      <div className="container">

        <h1>Bull Dashboard</h1>

        <h2 style={{marginTop:40}}>Scanner Candidates ({coins.length})</h2>

        <div className="table">
          <div className="table-header">
            <div>Symbol</div>
            <div>Price</div>
            <div>Volume</div>
            <div>24h %</div>
          </div>

          {coins.map(c => (
            <div key={c.symbol} className="table-row">
              <div>{c.symbol}</div>
              <div>${c.price?.toLocaleString()}</div>
              <div>${c.volume?.toLocaleString()}</div>
              <div style={{color: c.change24h > 0 ? "#1e7f3f" : "#8a2a2a"}}>
                {c.change24h?.toFixed(2)}%
              </div>
            </div>
          ))}

        </div>

      </div>
    </>
  )
}