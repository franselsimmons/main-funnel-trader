# Clean Micro-Rotation Trading System (v2 — net-aware)

A lean three-stage crypto-futures research+execution pipeline for Bitget USDT perps,
built around **micro-families**: deterministic, hash-defined trade archetypes whose
real and shadow outcomes are scored weekly so the best ones rotate into live trading.

```
Scanner      -> candidates (volatile snapshots)
TradeSystem  -> live validation + execution + position monitoring
Analyze      -> families + micro-families + NET scoring + weekly rotation
```

## What changed in v2 (and why it matters for real PnL)

The v1 baseline was structurally sound but learned from **gross** price moves and
fragmented its learning into billions of micro-families. v2 fixes the things that
sit between "runs cleanly" and "makes money":

1. **Net-of-cost learning (`src/trade/costModel.js`).**
   Every outcome - real and shadow - is converted from gross to **net R** using taker
   fees on both legs plus realistic slippage (long enters at the ask, exits at the bid,
   plus a market-impact buffer). `exitR`/`pnlPct` now carry net values, so the entire
   existing scoring stack (Wilson lower bound, Bayesian shrinkage, balancedScore,
   profit factor) learns net automatically. A family that shows +10R gross can be -42R
   net on tight stops; this is the difference between a logger and a trading system.

2. **Micro-family cardinality fix (`src/analyze/microFamilies.js`).**
   Continuous scores (confluence, sniper) are now coarse 3-tiers (LO/MID/HI) instead of
   20 buckets each, and the three confirmation booleans collapse into one `entryQuality`
   ordinal. Per-family dimensionality dropped ~474x, so families actually accumulate the
   samples `ROTATION_MIN_WEIGHTED_COMPLETED` requires.

3. **`directToSL` is now actually computed** from the trade's path (`mfeR`/`maeR`), so the
   `directSLPct` penalty in `balancedScore` stops being dead code.

4. **Snapshot staleness guard (`src/trade/tradeSystem.js`).**
   New entries are skipped if the scanner snapshot is older than `TRADE_MAX_SNAPSHOT_AGE_SEC`
   (default 8 min). Open-position monitoring always runs regardless.

5. **Position sizing + correlation caps (`src/trade/positionSizing.js`) - ENFORCED.**
   Risk-per-trade scales with family confidence (sample size x balancedScore). Portfolio
   caps bound total risk, per-side risk, and especially **counter-BTC risk**, because nearly
   every candidate is BTC-correlated and 30 "independent" longs can all lose on one candle.

6. **Breakeven/trailing - MEASURED, not yet executed.**
   `updatePathMetrics` records what a BE/trailing rule *would have* done
   (`beWouldExit`, `gaveBackAfterOneR`, `nearTpThenLoss`) per position. Analyze aggregates
   these per micro-family. Flip `MANAGE_APPLY_LIVE=true` only once the data shows BE helps
   a given family - some setups need room and BE would chop their winners.

## Install

1. Unzip into your repo root.
2. Copy `.env.example` to `.env` and fill Upstash + Discord + Bitget values.
3. `npm install`
4. Wire the `/api/*` handlers to your framework (Vercel routes included via `vercel.json`).

### Crons (Vercel `vercel.json` already set)

```
*/5 * * * *   /api/scanner/run               # scanner
*/2 * * * *   /api/trade/run                  # trade system
0 22 * * 0    /api/analyze/weekly-freeze      # Sunday 22:00 UTC freeze next rotation
0 0  * * 1    /api/analyze/activate-rotation  # Monday 00:00 UTC activate
```

Or via CLI: `npm run scanner:run`, `npm run trade:run`, `npm run analyze:freeze`, `npm run analyze:activate`.

Dashboard: `/public/admin.html`. The MicroFamilies table now shows
**Net AvgR, Net TotalR, CostR, GaveBack-1R, BE-Exit%**.

## Recommended go-live path

1. Run shadow-only for 1-2 weeks. Watch the MicroFamilies table.
2. Keep only families that are **net-positive** with `completed >= ROTATION_MIN_WEIGHTED_COMPLETED`.
3. Let sizing/correlation caps run from day one (they are safety, not optimization).
4. Once a family shows high `GaveBack-1R` with low `BE-Exit%`, enable live BE for it.

## Layout

```
src/
  market/    bitgetClient, indicators, scanner, fakeBreakout
  trade/     tradeSystem, positionEngine, riskEngine, costModel, positionSizing
  analyze/   analyzeEngine, microFamilies, scoring, rotationEngine
  shared:    config, keys, redis, lock, utils, discord
api/         scanner/ trade/ analyze/ admin/
scripts/     CLI entrypoints
public/      admin.html
```

## Important

This is a research+signal system with cost-aware learning. It does not place exchange
orders by itself - `TradeSystem` maintains virtual positions and Discord alerts. Wire your
own execution layer to the `ENTRY`/`EXIT` actions when you are satisfied with net results.
Nothing here is financial advice; validate on your own capital at your own risk.
