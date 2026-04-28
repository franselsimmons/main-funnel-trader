// ================= ORDERBOOK MEMORY (WALL TRACKING) =================
const memory = new Map();

export function updateOrderbookMemory(symbol, ob) {
  if (!ob?.bids || !ob?.asks) return;

  const prev = memory.get(symbol) || [];

  prev.push({
    ts: Date.now(),
    bids: ob.bids.slice(0, 10),   // top 10 levels
    asks: ob.asks.slice(0, 10)
  });

  // max 20 snapshots (genoeg voor laatste ~10-20 seconden bij 1s update)
  if (prev.length > 20) prev.shift();

  memory.set(symbol, prev);
}

export function getOrderbookHistory(symbol) {
  return memory.get(symbol) || [];
}