export function generateAdvice(analytics){
  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  for(const side of ["bull","bear"]){
    advice[side] = {};

    for(const stage of ["entry","almost","buildup","radar"]){
      const s = analytics[side][stage];
      if (!s) continue;

      const weakFlow = parseFloat(s.reasons.weakFlow) || 0;
      const lowScore = parseFloat(s.reasons.lowScore) || 0;
      const lowVolume = parseFloat(s.reasons.lowVolume) || 0;
      const badOB = parseFloat(s.reasons.badOB) || 0;

      const stageAdvice = [];

      // ================= FLOW =================
      if(weakFlow > 40) stageAdvice.push({ action: "STRENGER", message: "Blokkeer NEUTRAL flow" });
      if(weakFlow < 15) stageAdvice.push({ action: "SOEPELER", message: "Sta meer NEUTRAL flow toe" });

      // ================= SCORE =================
      if(lowScore > 35) stageAdvice.push({ action: "STRENGER", message: "Verhoog de minimum score" });
      if(lowScore < 10) stageAdvice.push({ action: "SOEPELER", message: "Verlaag de minimum score" });

      // ================= VOLUME =================
      if(lowVolume > 30) stageAdvice.push({ action: "STRENGER", message: "Verhoog het volume filter" });
      if(lowVolume < 10) stageAdvice.push({ action: "SOEPELER", message: "Verlaag het volume filter" });

      // ================= ORDERBOOK =================
      if(badOB > 25) stageAdvice.push({ action: "STRENGER", message: "Voeg strengere OB confirmatie toe" });

      advice[side][stage] = stageAdvice;
    }
  }

  // ================= GLOBAL FLOW =================
  const entryCount = (analytics.bull?.entry?.total || 0) + (analytics.bear?.entry?.total || 0);

  if(entryCount < 3) {
    advice.global.push("⚠️ TE WEINIG ENTRIES → Filters staan te streng. Verlaag je eisen om meer flow door te laten.");
  } else if(entryCount > 15) {
    advice.global.push("⚠️ TE VEEL ENTRIES → Kwaliteit gaat omlaag. Verhoog je eisen om ruis weg te filteren.");
  } else {
    advice.global.push("✅ GEZONDE FUNNEL → Het aantal actieve signalen ziet er stabiel uit.");
  }

  return advice;
}
