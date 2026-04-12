import Link from "next/link"

export default function Home() {
  return (
    <div style={{ padding: 40 }}>
      <h1>MAIN V6 Control Center</h1>

      <div style={{ marginTop: 30 }}>
        <Link href="/bull">
          <button>Open Bull Dashboard</button>
        </Link>
      </div>

      <div style={{ marginTop: 20 }}>
        <Link href="/bear">
          <button>Open Bear Dashboard</button>
        </Link>
      </div>

      <div style={{ marginTop: 20 }}>
        <Link href="/analyse">
          <button>Open Analyse Meester</button>
        </Link>
      </div>
    </div>
  )
}