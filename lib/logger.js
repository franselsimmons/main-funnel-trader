const history = [];

export function logTrade(trade){

  history.push({
    symbol: trade.symbol,
    side: trade.side,
    entry: trade.entry,
    exit: trade.exit || null,
    result: trade.result || null,
    rr: trade.rr,
    timestamp: Date.now()
  });

  if(history.length > 500){
    history.shift();
  }
}

export function getHistory(){
  return history;
}