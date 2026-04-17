import { getFilters } from "./filterState.js";

function calcFlowRate(current, next){
  if(!current || current === 0) return 0;
  return (next / current) * 100;
}

function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

export function generateAdvice(analytics){

  const filters = getFilters();

  const advice = {
    bull: {},
    bear: {},
    global: []
  };

  // huidige tabel -> volgende tabel
  const nextStageMap = {
    radar: "buildup",
    buildup: "almost",
    almost: "entry"
  };

  for(const side of ["bull","bear"]){

    advice[side] = {};

    for(const stage of ["entry","almost","buildup","radar"]){

      const currentStats = analytics[side]?.[stage];

      if(!currentStats){
        advice[side][stage] = [];
        continue;
      }

      const stageAdvice = [];

      // ================= ENTRY -> TRADE =================
      if(stage === "entry"){
        const entryTotal = analytics[side]?.entry?.total || 0;
        const tradeScoreMin = Number(filters.trade?.scoreMin || 60);
        const tradeRrMin = Number(filters.trade?.rrMin || 1.5);
        const requireTrend = !!filters.trade?.requireTrend;
        const blockSpoof = !!filters.trade?.blockSpoof;

        if(entryTotal > 0){
          if(entryTotal < 3){
            stageAdvice.push({
              type: "tradeScore",
              action: "SOEPELER",
              message: "Trade score verlagen zodat ENTRY coins doorstromen naar TRADE",
              current: tradeScoreMin,
              recommended: clamp(tradeScoreMin - 5, 20, 95)
            });

            stageAdvice.push({
              type: "tradeRR",
              action: "SOEPELER",
              message: "Trade RR iets verlagen zodat meer ENTRY coins trade-klaar worden",
              current: tradeRrMin,
              recommended: Number(clamp(tradeRrMin - 0.2, 1, 4).toFixed(2))
            });

            if(requireTrend){
              stageAdvice.push({
                type: "tradeTrend",
                action: "SOEPELER",
                message: "Trend-verplichting uitzetten voor meer doorstroom naar TRADE",
                current: "REQUIRE",
                recommended: "OPTIONAL"
              });
            }
          } else if(entryTotal > 15){
            stageAdvice.push({
              type: "tradeScore",
              action: "STRENGER",
              message: "Trade score verhogen zodat alleen de beste ENTRY coins doorgaan",
              current: tradeScoreMin,
              recommended: clamp(tradeScoreMin + 5, 20, 95)
            });

            stageAdvice.push({
              type: "tradeRR",
              action: "STRENGER",
              message: "Trade RR verhogen om kwaliteit te verhogen",
              current: tradeRrMin,
              recommended: Number(clamp(tradeRrMin + 0.2, 1, 4).toFixed(2))
            });

            if(!blockSpoof){
              stageAdvice.push({
                type: "tradeSpoof",
                action: "STRENGER",
                message: "Spoof-block aanzetten voor schonere trade selectie",
                current: "OFF",
                recommended: "ON"
              });
            }
          }
        }

        if(stageAdvice.length === 0){
          stageAdvice.push({
            type: "info",
            action: "OK",
            message: "ENTRY → TRADE doorstroom is gezond",
            current: "",
            recommended: ""
          });
        }

        advice[side][stage] = stageAdvice;
        continue;
      }

      // ================= RADAR/BUILDUP/ALMOST -> volgende stage =================
      const nextStage = nextStageMap[stage];
      const nextStats = analytics[side]?.[nextStage];
      const nextFilters = filters[side]?.[nextStage];

      if(!nextStats || !nextFilters){
        advice[side][stage] = [];
        continue;
      }

      const currentTotal = currentStats.total || 0;
      const nextTotal = nextStats.total || 0;
      const flowRate = calcFlowRate(currentTotal, nextTotal);

      const nextLowScore = Number(nextStats.reasons?.lowScore || 0);
      const nextLowVolume = Number(nextStats.reasons?.lowVolume || 0);
      const nextWeakFlow = Number(nextStats.reasons?.weakFlow || 0);

      // Te weinig coins stromen door -> volgende tabel soepeler maken
      if(flowRate < 5){

        const newScore = clamp(nextFilters.scoreMin - 15, 20, 95);
        const newVolume = Number(clamp(nextFilters.volumeMin - 0.15, 0.05, 1).toFixed(2));

        if(newScore !== nextFilters.scoreMin){
          stageAdvice.push({
            type: "score",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} score verlagen zodat ${stage.toUpperCase()} coins kunnen doorstromen`,
            current: nextFilters.scoreMin,
            recommended: newScore
          });
        }

        if(newVolume !== nextFilters.volumeMin){
          stageAdvice.push({
            type: "volume",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} volume verlagen zodat meer coins doorstromen`,
            current: nextFilters.volumeMin,
            recommended: newVolume
          });
        }

        if(nextFilters.allowNeutral === false){
          stageAdvice.push({
            type: "flow",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} flow soepeler maken`,
            current: "BLOCK",
            recommended: "ALLOW"
          });
        }
      }

      // Matig lage doorstroom -> lichte versoepeling
      else if(flowRate < 15){

        const newScore = clamp(nextFilters.scoreMin - 5, 20, 95);
        const newVolume = Number(clamp(nextFilters.volumeMin - 0.05, 0.05, 1).toFixed(2));

        if(newScore !== nextFilters.scoreMin){
          stageAdvice.push({
            type: "score",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} score iets verlagen voor betere doorstroom`,
            current: nextFilters.scoreMin,
            recommended: newScore
          });
        }

        if(newVolume !== nextFilters.volumeMin){
          stageAdvice.push({
            type: "volume",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} volume iets verlagen`,
            current: nextFilters.volumeMin,
            recommended: newVolume
          });
        }

        if(nextWeakFlow > 50 && nextFilters.allowNeutral === false){
          stageAdvice.push({
            type: "flow",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} flow openzetten, weak flow blokkeert te veel coins`,
            current: "BLOCK",
            recommended: "ALLOW"
          });
        }
      }

      // Te hoge doorstroom -> volgende tabel strenger maken
      else if(flowRate > 40){

        const newScore = clamp(nextFilters.scoreMin + 5, 20, 95);
        const newVolume = Number(clamp(nextFilters.volumeMin + 0.05, 0.05, 1).toFixed(2));

        if(newScore !== nextFilters.scoreMin){
          stageAdvice.push({
            type: "score",
            action: "STRENGER",
            message: `${nextStage.toUpperCase()} score verhogen, te veel coins stromen door`,
            current: nextFilters.scoreMin,
            recommended: newScore
          });
        }

        if(newVolume !== nextFilters.volumeMin){
          stageAdvice.push({
            type: "volume",
            action: "STRENGER",
            message: `${nextStage.toUpperCase()} volume verhogen om kwaliteit te verbeteren`,
            current: nextFilters.volumeMin,
            recommended: newVolume
          });
        }

        if(nextWeakFlow < 10 && nextFilters.allowNeutral === true){
          stageAdvice.push({
            type: "flow",
            action: "STRENGER",
            message: `${nextStage.toUpperCase()} flow strenger maken`,
            current: "ALLOW",
            recommended: "BLOCK"
          });
        }
      }

      // Extra tuning op basis van problemen in volgende tabel
      if(flowRate > 0 && flowRate < 40){

        if(nextLowScore > 60){
          const newScore = clamp(nextFilters.scoreMin - 10, 20, 95);
          if(newScore !== nextFilters.scoreMin){
            stageAdvice.push({
              type: "score",
              action: "SOEPELER",
              message: `${nextStage.toUpperCase()} blokkeert vooral op score`,
              current: nextFilters.scoreMin,
              recommended: newScore
            });
          }
        } else if(nextLowScore < 10){
          const newScore = clamp(nextFilters.scoreMin + 5, 20, 95);
          if(newScore !== nextFilters.scoreMin){
            stageAdvice.push({
              type: "score",
              action: "STRENGER",
              message: `${nextStage.toUpperCase()} score is mogelijk te los`,
              current: nextFilters.scoreMin,
              recommended: newScore
            });
          }
        }

        if(nextLowVolume > 60){
          const newVolume = Number(clamp(nextFilters.volumeMin - 0.1, 0.05, 1).toFixed(2));
          if(newVolume !== nextFilters.volumeMin){
            stageAdvice.push({
              type: "volume",
              action: "SOEPELER",
              message: `${nextStage.toUpperCase()} blokkeert vooral op volume`,
              current: nextFilters.volumeMin,
              recommended: newVolume
            });
          }
        } else if(nextLowVolume < 10){
          const newVolume = Number(clamp(nextFilters.volumeMin + 0.05, 0.05, 1).toFixed(2));
          if(newVolume !== nextFilters.volumeMin){
            stageAdvice.push({
              type: "volume",
              action: "STRENGER",
              message: `${nextStage.toUpperCase()} volume kan strenger`,
              current: nextFilters.volumeMin,
              recommended: newVolume
            });
          }
        }

        if(nextWeakFlow > 50 && nextFilters.allowNeutral === false){
          stageAdvice.push({
            type: "flow",
            action: "SOEPELER",
            message: `${nextStage.toUpperCase()} flow blokkeert te veel coins`,
            current: "BLOCK",
            recommended: "ALLOW"
          });
        } else if(nextWeakFlow < 10 && nextFilters.allowNeutral === true){
          stageAdvice.push({
            type: "flow",
            action: "STRENGER",
            message: `${nextStage.toUpperCase()} flow kan strenger`,
            current: "ALLOW",
            recommended: "BLOCK"
          });
        }
      }

      if(stageAdvice.length === 0){
        stageAdvice.push({
          type: "info",
          action: "OK",
          message: `${stage.toUpperCase()} → ${nextStage.toUpperCase()} doorstroom is gezond`,
          current: "",
          recommended: ""
        });
      }

      advice[side][stage] = stageAdvice;
    }
  }

  const bullRadar = analytics.bull?.radar?.total || 0;
  const bullEntry = analytics.bull?.entry?.total || 0;
  const bearRadar = analytics.bear?.radar?.total || 0;
  const bearEntry = analytics.bear?.entry?.total || 0;

  if((bullRadar > 0 && bullEntry === 0) || (bearRadar > 0 && bearEntry === 0)){
    advice.global.push("⚠️ Funnel bottleneck: coins komen niet diep genoeg door. Versoepel de volgende tabellen, niet de huidige.");
  }

  const entryCount = bullEntry + bearEntry;

  if(entryCount < 3){
    advice.global.push("⚠️ Te weinig entries → volgende filters in de funnel zijn te streng");
  } else if(entryCount > 15){
    advice.global.push("⚠️ Te veel entries → volgende filters in de funnel zijn te los");
  } else {
    advice.global.push("✅ Goede funnel balans");
  }

  return advice;
}