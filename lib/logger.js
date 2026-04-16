import { readDB, writeDB } from "./db.js";

export function logTrade(trade){

  const db = readDB();

  db.push({
    symbol: trade.symbol,
    side: trade.side,
    entry: trade.entry,
    exit: trade.exit,
    result: trade.result,
    rr: trade.rr,
    timestamp: Date.now()
  });

  // max 1000 trades
  if(db.length > 1000){
    db.shift();
  }

  writeDB(db);
}