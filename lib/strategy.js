export function chooseStrategy(c){

  if(c.moveScore > 90) return "AGGRESSIVE";
  if(c.moveScore > 75) return "TREND";
  return "SAFE";
}