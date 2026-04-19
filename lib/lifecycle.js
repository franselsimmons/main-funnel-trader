// ================= LIFECYCLE ENGINE =================

export function getLifecycleStage(stage, action){

  // 🔥 TRADE ENGINE PRIORITY (belangrijkste)
  if(action === "ENTRY") return "ENTRY";
  if(action === "HOLD") return "HOLD";
  if(action === "PARTIAL_TP") return "PARTIAL";
  if(action === "EXIT") return "EXIT";

  // ================= FUNNEL FALLBACK =================

  if(stage === "entry") return "READY";
  if(stage === "almost") return "SETUP";
  if(stage === "buildup") return "BUILDING";
  if(stage === "radar") return "SCANNING";

  return "IDLE";
}