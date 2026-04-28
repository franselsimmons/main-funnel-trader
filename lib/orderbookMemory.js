const memory = new Map();

export function updateOrderbookMemory(symbol, ob) {
  if (!ob?.bids || !ob?.asks) return;

  const prev = memory.get(symbol) || [];

  prev.push({
    ts: Date.now(),
    bids: ob.bids.slice(0, 10),
    asks: ob.asks.slice(0, 10),
    mid: ob.mid || 0
  });

  if (prev.length > 20) prev.shift();
  memory.set(symbol, prev);
}

export function getOrderbookHistory(symbol) {
  return memory.get(symbol) || [];
}