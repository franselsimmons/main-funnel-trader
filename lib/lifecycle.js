// ================= LIFECYCLE ENGINE =================

export function getLifecycleStage(stage, action){

  // 🔥 ALLEEN TRADE ACTIONS ZIJN ECHTE SIGNALEN
  if(action === "ENTRY") return "ENTRY";
  if(action === "HOLD") return "HOLD";
  if(action === "PARTIAL_TP") return "PARTIAL";
  if(action === "EXIT") return "EXIT";

  // scanner is alleen info (NO SIGNALS)
  return "SCAN";
}