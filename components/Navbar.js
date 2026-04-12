import Link from "next/link"

export default function Navbar() {
  return (
    <nav className="navbar">
      <div className="nav-inner">
        <div className="logo">MAIN V6</div>
        <div className="links">
          <Link href="/bull">Bull</Link>
          <Link href="/bear">Bear</Link>
        </div>
      </div>
    </nav>
  )
}