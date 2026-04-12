import Link from "next/link"

export default function Navbar() {
  return (
    <div className="navbar">
      <div><strong>MAIN V6</strong></div>
      <div className="nav-links">
        <Link href="/">Home</Link>
        <Link href="/bull">Bull</Link>
        <Link href="/bear">Bear</Link>
        <Link href="/analyse">Analyse</Link>
      </div>
    </div>
  )
}