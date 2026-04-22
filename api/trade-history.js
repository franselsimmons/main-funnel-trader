import { getTradeHistory } from "../lib/logger.js";

export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    const trades = getTradeHistory();

    return res.status(200).json({
      ok: true,
      total: trades.length,
      trades: trades
        .slice()
        .reverse()
    });

  }catch(err){

    console.error("TRADE HISTORY ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "trade_history_failed"
    });
  }
}