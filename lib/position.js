const positions = new Map();

export function openPosition(symbol, price){
  positions.set(symbol,{
    symbol,
    entry:price,
    size:1,
    adds:0,
    state:"OPEN",
    created:Date.now()
  });
}

export function addPosition(symbol, price){
  const p = positions.get(symbol);
  if(!p) return;

  p.size += 0.5;
  p.adds += 1;
  p.lastAdd = price;
}

export function closePosition(symbol){
  positions.delete(symbol);
}

export function getPosition(symbol){
  return positions.get(symbol);
}

export function getAllPositions(){
  return Array.from(positions.values());
}