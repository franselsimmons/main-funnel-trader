import useSWR from "swr"
import Navbar from "../components/Navbar"

const fetcher = (url) => fetch(url).then(res => res.json())

export default function Trade() {

  const { data } = useSWR("/api/dashboard", fetcher, {
    refreshInterval: 5000
  })

  const bullApproved = data?.bull?.approved || 0
  const bearApproved = data?.bear?.approved || 0

  return (
    <>
      <Navbar />

      <div className="page">
        <div className="page-inner">

          <h1>Trade Overview</h1>

          <div style={{
            display:"grid",
            gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",
            gap:"20px",
            marginTop:"30px"
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

        </div>
      </div>
    </>
  )
}