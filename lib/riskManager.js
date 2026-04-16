export function getRiskProfile(c, regime){

  let risk = "LOW";

  if(c.moveScore > 80 && c.vm > 0.4){
    risk = "HIGH";
  }
  else if(c.moveScore > 65){
    risk = "MEDIUM";
  }

  // 🔥 regime protectie
  if(regime === "LOW_VOL" && risk === "HIGH"){
    risk = "MEDIUM";
  }

  return {
    level:risk,
    allowEntry: risk !== "LOW",
    maxAdds: risk === "HIGH" ? 2 : 1
  };
}