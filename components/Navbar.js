export default function Nav({ active }) {
  return (
    <nav>
      <a href="/?mode=bull" className={active === "bull" ? "active" : ""}>Bull</a>
      <a href="/?mode=bear" className={active === "bear" ? "active" : ""}>Bear</a>
      <a href="/trade" className={active === "trade" ? "active" : ""}>Live Trades</a>
      <a href="/analyse" className={active === "analyse" ? "active" : ""}>Analyse</a>
    </nav>
  );
}