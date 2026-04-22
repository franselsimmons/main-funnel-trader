import {
  getTradeStats,
  getStatsBy
} from "../lib/logger.js";

export default async function handler(req, res){

  try{

    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.status(200).json({
      ok: true,

      overall: getTradeStats(),

      byGrade: getStatsBy("grade"),
      bySide: getStatsBy("side"),
      bySniper: getStatsBy("sniper"),
      byFlow: getStatsBy("flow"),
      byObBias: getStatsBy("obBias"),
      byRegime: getStatsBy("regime"),
      byBtcState: getStatsBy("btcState")
    });

  }catch(err){

    console.error("TRADE STATS ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "trade_stats_failed"
    });
  }
}