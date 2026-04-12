import Navbar from "../components/Navbar"
import Link from "next/link"

export default function Home() {
  return (
    <>
      <Navbar />
      <div className="container">

        <h1>MAIN V6 Control Center</h1>

        <div className="card-grid">

          <div className="card">
            <h3>Bull Funnel</h3>
            <Link href="/bull">
              <button className="button">Open Bull Dashboard</button>
            </Link>
          </div>

          <div className="card">
            <h3>Bear Funnel</h3>
            <Link href="/bear">
              <button className="button">Open Bear Dashboard</button>
            </Link>
          </div>

          <div className="card">
            <h3>Analyse Meester</h3>
            <Link href="/analyse">
              <button className="button">Open Analyse</button>
            </Link>
          </div>

        </div>

      </div>
    </>
  )
}