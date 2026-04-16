export function calculateEdge(c, regime){

  let edge = 0;

  if(c.moveScore > 85) edge += 2;
  if(c.vm > 0.5) edge += 1;
  if(regime === "HIGH_VOL") edge += 1;

  return edge;
}