let positions = [];

export function openPosition(p){

  positions.push({
    id: Date.now(),
    ...p,
    status:"OPEN"
  });
}

export function getPositions(){
  return positions;
}

export function closePosition(id, pnl){

  const pos = positions.find(p=>p.id===id);

  if(!pos) return;

  pos.status = "CLOSED";
  pos.pnl = pnl;
}