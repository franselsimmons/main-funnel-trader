export function calculateRisk(c){

  const price = c.price;

  // 🔥 volatility proxy
  const vol = Math.abs(c.change24 || 5) / 100;

  // ===== STOP LOSS =====
  const sl =
    c.side === "bull"
      ? price * (1 - vol * 0.5)
      : price * (1 + vol * 0.5);

  // ===== TAKE PROFIT =====
  const tp =
    c.side === "bull"
      ? price * (1 + vol * 1.5)
      : price * (1 - vol * 1.5);

  // ===== RR =====
  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);

  const rr = reward / (risk || 1);

  return {
    entry: price,
    sl,
    tp,
    rr
  };
}