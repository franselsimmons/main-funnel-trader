import { kv } from "@vercel/kv";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function key(regime) {
  return `performance:${regime || "global"}`;
}

export async function getPerformance(regime) {
  const data = (await kv.get(key(regime))) || {
    trades: 0,
    wins: 0,
    losses: 0,
    totalWinR: 0,
    totalLossR: 0
  };

  const trades = n(data.trades);
  const wins = n(data.wins);
  const losses = n(data.losses);

  const avgWinR = wins > 0 ? n(data.totalWinR) / wins : 0;
  const avgLossR = losses > 0 ? n(data.totalLossR) / losses : 1;

  const winrate = trades > 0 ? wins / trades : 0;
  const expectancy =
    (winrate * avgWinR) - ((1 - winrate) * avgLossR);

  return {
    trades,
    wins,
    losses,
    avgWinR,
    avgLossR,
    winrate,
    expectancy
  };
}

export async function updatePerformance(regime, rMultiple) {
  const perf = await getPerformance(regime);

  const trades = perf.trades + 1;
  const wins = rMultiple > 0 ? perf.wins + 1 : perf.wins;
  const losses = rMultiple <= 0 ? perf.losses + 1 : perf.losses;

  const totalWinR =
    rMultiple > 0
      ? perf.avgWinR * perf.wins + rMultiple
      : perf.avgWinR * perf.wins;

  const totalLossR =
    rMultiple <= 0
      ? perf.avgLossR * perf.losses + Math.abs(rMultiple)
      : perf.avgLossR * perf.losses;

  await kv.set(key(regime), {
    trades,
    wins,
    losses,
    totalWinR,
    totalLossR
  });
}