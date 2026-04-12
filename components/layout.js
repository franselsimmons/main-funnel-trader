import Navbar from "./Navbar"

export default function Layout({ title, lastScan, children }) {

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
            <h1>{title}</h1>
            {lastScan && (
              <div className="scan-time">
                Last Scan: {formatTime(lastScan)}
              </div>
            )}
          </div>

          {children}

        </div>
      </div>
    </>
  )
}