const positions = new Map();

export function updatePosition(symbol, action, price) {

  const existing = positions.get(symbol);

  if (action === "ENTRY") {
    positions.set(symbol, {
      entry: price,
      size: 1,
      adds: 0
    });
  }

  if (action === "ADD" && existing) {
    existing.size += 0.5;
    existing.adds += 1;
  }

  if (action === "EXIT") {
    positions.delete(symbol);
  }
}

export function getPositions() {
  return Array.from(positions.entries()).map(([symbol, p]) => ({
    symbol,
    ...p
  }));
}