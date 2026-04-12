import Link from "next/link"
import { useRouter } from "next/router"

export default function Navbar() {
  const router = useRouter()

  const linkStyle = (path) => ({
    marginLeft: 20,
    textDecoration: "none",
    color: router.pathname === path ? "#fff" : "#888",
    fontWeight: 500
  })

  return (
    <div className="navbar">
      <div><strong>MAIN V6</strong></div>
      <div className="nav-links">
        <Link href="/" style={linkStyle("/")}>Home</Link>
        <Link href="/bull" style={linkStyle("/bull")}>Bull</Link>
        <Link href="/bear" style={linkStyle("/bear")}>Bear</Link>
        <Link href="/analyse" style={linkStyle("/analyse")}>Analyse</Link>
      </div>
    </div>
  )
}