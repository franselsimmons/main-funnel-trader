import { useEffect, useState } from "react";
import Link from "next/link";

export default function Home() {
  const [bull, setBull] = useState(null);
  const [bear, setBear] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/state?mode=bull", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/state?mode=bear", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([b1, b2]) => {
      setBull(b1);
      setBear(b2);
    });
  }, []);

  const bullEntry = bull?.funnel?.entry_ready?.length || 0;
  const bearEntry = bear?.funnel?.entry_ready?.length || 0;
  const bullSetup = bull?.funnel?.setup?.length || 0;
  const bearSetup = bear?.funnel?.setup?.length || 0;

  const bullLast = bull?.ts || bull?.scannedAt || 0;
  const bearLast = bear?.ts || bear?.scannedAt || 0;

  return (
    <div className="pageShell homePage">
      <section className="heroCard">
        <div className="eyebrow">CRYPTOCROC</div>
        <h1 className="heroTitle">Scanner & Trade Desk</h1>
        <p className="heroText">
          Rustig overzicht bovenaan. Diepte pas als je klikt.
        </p>

        <div className="heroStats">
          <div className="heroStat">
            <span className="heroStatLabel">Bull entry ready</span>
            <span className="heroStatValue">{bullEntry}</span>
            <span className="heroStatSmall">
              Last scan: {bullLast ? new Date(bullLast).toLocaleString() : "—"}
            </span>
          </div>
          <div className="heroStat">
            <span className="heroStatLabel">Bear entry ready</span>
            <span className="heroStatValue">{bearEntry}</span>
            <span className="heroStatSmall">
              Last scan: {bearLast ? new Date(bearLast).toLocaleString() : "—"}
            </span>
          </div>
          <div className="heroStat">
            <span className="heroStatLabel">Bull setup</span>
            <span className="heroStatValue">{bullSetup}</span>
            <span className="heroStatSmall">Setup → Entry is OB gate</span>
          </div>
          <div className="heroStat">
            <span className="heroStatLabel">Bear setup</span>
            <span className="heroStatValue">{bearSetup}</span>
            <span className="heroStatSmall">Setup → Entry is OB gate</span>
          </div>
        </div>
      </section>

      <section className="homeGrid">
        <Link href="/bull" className="homeCard">
          <div className="homeCardTitle">Bull Scanner</div>
          <div className="homeCardText">Long kansen, funnel en coin modal detail.</div>
        </Link>

        <Link href="/bear" className="homeCard">
          <div className="homeCardTitle">Bear Scanner</div>
          <div className="homeCardText">Short kansen, funnel en coin modal detail.</div>
        </Link>

        <Link href="/analyse" className="homeCard">
          <div className="homeCardTitle">Analyse</div>
          <div className="homeCardText">Bull & bear apart, bottlenecks en verbeteradvies.</div>
        </Link>

        <Link href="/trade" className="homeCard">
          <div className="homeCardTitle">Trade Tunnel</div>
          <div className="homeCardText">Open posities, entry flow en execution health.</div>
        </Link>
      </section>
    </div>
  );
}