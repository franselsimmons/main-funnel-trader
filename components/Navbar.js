import Link from "next/link"

export default function Navbar() {
  return (
    <div className="navbar">
      <div className="nav-inner">
        <div style={{fontWeight:600}}>MAIN V6</div>
        <div>
          <Link href="/bull">Bull</Link>
          <Link href="/bear">Bear</Link>
          <Link href="/trade">Trade</Link>
        </div>
      </div>
    </div>
  )
}