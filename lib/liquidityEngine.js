// ================= LIQUIDATION ENGINE =================

export function getLiquidationZones(c, ob){

  const price = c.price;

  const vol = Math.abs(c.change24 || 5) / 100;
  const spread = ob?.spreadPct || 0.001;

  // 🔥 leverage clusters simulatie
  const liqBase = vol * 2;

  const longLiq = price * (1 - liqBase);     // longs worden geliquideerd
  const shortLiq = price * (1 + liqBase);    // shorts worden geliquideerd

  // 🔥 sweep zones (waar echte moves starten)
  const longSweep = longLiq * (1 - spread * 2);
  const shortSweep = shortLiq * (1 + spread * 2);

  return {
    longLiq,
    shortLiq,
    longSweep,
    shortSweep
  };
}