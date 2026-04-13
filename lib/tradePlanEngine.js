function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export function buildTradePlan({
  price,
  range24,
  regime,
  side
}) {
  const baseSL = 2.8 + (range24 * 0.08);
  const baseTP = 5.5 + (range24 * 0.15);

  let slPct = baseSL;
  let tpPct = baseTP;

  if (regime === "RISK_ON") {
    tpPct *= 1.2;
  }

  if (regime === "RISK_OFF") {
    slPct *= 0.9;
    tpPct *= 0.8;
  }

  slPct = Math.max(2.2, Math.min(6, slPct));
  tpPct = Math.max(4, Math.min(12, tpPct));

  if (side === "SHORT") {
    return {
      entry: price,
      sl: price * (1 + slPct / 100),
      tp: price * (1 - tpPct / 100),
      rr: tpPct / slPct
    };
  }

  return {
    entry: price,
    sl: price * (1 - slPct / 100),
    tp: price * (1 + tpPct / 100),
    rr: tpPct / slPct
  };
}