let memory = {
  trades: [],
  stats: {
    bull:{ win:0, loss:0 },
    bear:{ win:0, loss:0 }
  }
};

export function logAITrade(trade){

  memory.trades.push(trade);

  if(trade.result === "WIN"){
    memory.stats[trade.side].win++;
  } else {
    memory.stats[trade.side].loss++;
  }
}

export function getAIStats(){
  return memory.stats;
}

export function getWinrate(side){
  const s = memory.stats[side];
  const total = s.win + s.loss;

  if(total === 0) return 50;

  return (s.win / total) * 100;
}