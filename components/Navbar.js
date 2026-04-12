import Link from "next/link"

export default function Navbar() {
  return (
    <div style={{
      display: "flex",
      gap: 20,
      padding: 20,
      borderBottom: "1px solid #222"
    }}>
      <Link href="/bull">Bull</Link>
      <Link href="/bear">Bear</Link>
    </div>
  )
}