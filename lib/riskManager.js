export function calculateRisk(c){

  const price = c.price;
  const vol = Math.abs(c.change24 || 5) / 100;

  const sl = c.side === "bull"
    ? price * (1 - vol * 0.6)
    : price * (1 + vol * 0.6);

  const tp = c.side === "bull"
    ? price * (1 + vol * 1.8)
    : price * (1 - vol * 1.8);

  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);

  const rr = reward / (risk || 1);

  return { entry:price, sl, tp, rr };
}