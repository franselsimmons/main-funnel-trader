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
          Professioneel overzicht van de markt. Klik door voor diepgaande data.
        </p>

        <div className="heroStats">
          <div className="heroStat">
            <span className="heroStatLabel">Bull Entry Ready</span>
            <span className="heroStatValue">{bullEntry}</span>
            <span className="heroStatSmall">
              Scan: {bullLast ? new Date(bullLast).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "—"}
            </span>
          </div>
          <div className="heroStat">
            <span className="heroStatLabel">Bear Entry Ready</span>
            <span className="heroStatValue">{bearEntry}</span>
            <span className="heroStatSmall">
              Scan: {bearLast ? new Date(bearLast).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "—"}
            </span>
          </div>
          <div className="heroStat">
            <span className="heroStatLabel">Bull Setup</span>
            <span className="heroStatValue">{bullSetup}</span>
            <span className="heroStatSmall">Setup → Entry Flow</span>
          </div>
          <div className="heroStat">
            <span className="heroStatLabel">Bear Setup</span>
            <span className="heroStatValue">{bearSetup}</span>
            <span className="heroStatSmall">Setup → Entry Flow</span>
          </div>
        </div>
      </section>

      <section className="homeGrid">
        <Link href="/bull" className="homeCard">
          <div className="homeCardTitle">Bull Scanner</div>
          <div className="homeCardText">Vind long kansen, bekijk de funnel en analyseer coins via de detail pop-up.</div>
        </Link>

        <Link href="/bear" className="homeCard">
          <div className="homeCardTitle">Bear Scanner</div>
          <div className="homeCardText">Vind short kansen, bekijk de funnel en analyseer coins via de detail pop-up.</div>
        </Link>

        <Link href="/analyse" className="homeCard">
          <div className="homeCardTitle">Analyse Desk</div>
          <div className="homeCardText">Ontdek bottlenecks en bekijk verbeteradviezen voor beide marktrichtingen.</div>
        </Link>

        <Link href="/trade" className="homeCard">
          <div className="homeCardTitle">Trade Tunnel</div>
          <div className="homeCardText">Monitor open posities, entry flow en de algemene execution health.</div>
        </Link>
      </section>
    </div>
  );
}
