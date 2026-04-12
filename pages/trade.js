import useSWR from "swr"
import Layout from "../components/Layout"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Trade() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const bullApproved = data?.bull?.approved || 0
  const bearApproved = data?.bear?.approved || 0

  return (
    <Layout title="Trade Overview">

      <div className="section-header">Approved Trades</div>

      <div style={{
        display:"grid",
        gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",
        gap:"20px",
        marginTop:"20px"
      }}>
        <div style={{
          background:"#121826",
          padding:"20px",
          borderRadius:"12px",
          border:"1px solid #1f2636"
        }}>
          <div style={{color:"#94a3b8"}}>Bull Approved</div>
          <div style={{fontSize:"32px", marginTop:"10px"}}>
            {bullApproved}
          </div>
        </div>

        <div style={{
          background:"#121826",
          padding:"20px",
          borderRadius:"12px",
          border:"1px solid #1f2636"
        }}>
          <div style={{color:"#94a3b8"}}>Bear Approved</div>
          <div style={{fontSize:"32px", marginTop:"10px"}}>
            {bearApproved}
          </div>
        </div>
      </div>

    </Layout>
  )
}