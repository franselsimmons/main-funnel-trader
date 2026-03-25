# Main Funnel Trader (Vercel + Next.js)

Main Funnel + Trade System:
- Iedere 30 min scan (bull + bear) via Vercel Cron
- Funnel buckets: radar, buildup, almost, elite_ignition, elite_expansion
- TradeDesk: IGNORE / WATCH / OPEN
- Positions: open/closed, PnL update, exits (TP/SL/TIMEOUT/EARLY_EXIT)
- Adaptive thresholds op basis van performance
- Discord signals (webhook)
- Bitget Spot order executie (market/limit) — default UIT

## 1) Install
```bash
npm i
npm run dev