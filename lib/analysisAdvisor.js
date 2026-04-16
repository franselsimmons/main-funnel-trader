export function generateAdvice(analytics) {
  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  for (const side of ["bull", "bear"]) {
    advice[side] = {};

    for (const stage of ["entry", "almost", "buildup", "radar"]) {
      const s = analytics[side][stage];
      if (!s) continue;

      const weakFlow = parseFloat(s.reasons.weakFlow) || 0;
      const lowScore = parseFloat(s.reasons.lowScore) || 0;
      const lowVolume = parseFloat(s.reasons.lowVolume) || 0;
      const badOB = parseFloat(s.reasons.badOB) || 0;

      const stageAdvice = [];

      // ================= FLOW =================
      if (weakFlow > 40) {
        stageAdvice.push({
          type: "FLOW",
          action: "STRENGER",
          message: "Te veel zwakke flow. Overweeg NEUTRAL uit te schakelen voor hogere kwaliteit."
        });
      } else if (weakFlow < 15) {
        stageAdvice.push({
          type: "FLOW",
          action: "SOEPELER",
          message: "Flow filter is erg strak. Je kunt NEUTRAL flow toestaan om meer kansen te zien."
        });
      }

      // ================= SCORE =================
      if (lowScore > 35) {
        stageAdvice.push({
          type: "SCORE",
          action: "STRENGER",
          message: "Veel munten hebben een lage score. Verhoog de minimale AI/Confidence score."
        });
      } else if (lowScore < 10) {
        stageAdvice.push({
          type: "SCORE",
          action: "SOEPELER",
          message: "Score filter is dominant. Je kunt deze iets verlagen om de funnel breder te maken."
        });
      }

      // ================= VOLUME =================
      if (lowVolume > 30) {
        stageAdvice.push({
          type: "VOLUME",
          action: "STRENGER",
          message: "Er komt te veel illiquide troep doorheen. Verhoog je minimale volume/liquiditeit eisen."
        });
      } else if (lowVolume < 10) {
        stageAdvice.push({
          type: "VOLUME",
          action: "SOEPELER",
          message: "Volume filter blokkeert veel potentie. Je kunt iets minder volume toestaan."
        });
      }

      // ================= ORDERBOOK =================
      if (badOB > 25) {
        stageAdvice.push({
          type: "ORDERBOOK",
          action: "STRENGER",
          message: "Orderbook spread/depth is te zwak. Zet de orderbook filters strakker (minder spread)."
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  // ================= GLOBAL FLOW =================
  const entryCount = (analytics.bull?.entry?.total || 0) + (analytics.bear?.entry?.total || 0);

  if (entryCount < 3) {
    advice.global.push("⚠️ TE WEINIG ENTRIES: Je filters staan momenteel erg streng afgesteld. Er komt weinig door de funnel heen.");
  } else if (entryCount > 15) {
    advice.global.push("⚠️ TE VEEL ENTRIES: Je krijgt mogelijk 'information overload'. Overweeg de kwaliteitseisen te verhogen.");
  } else {
    advice.global.push("✅ GEZONDE FUNNEL: Het aantal actieve entries ziet er goed en behapbaar uit.");
  }

  return advice;
}
