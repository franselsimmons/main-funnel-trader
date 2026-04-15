const stats = {
  wins:0,
  losses:0,
  history:[]
};

export function recordTrade(result,meta){

  if(result==="WIN") stats.wins++;
  else stats.losses++;

  stats.history.push({
    result,
    meta,
    ts:Date.now()
  });

  if(stats.history.length > 500){
    stats.history.shift();
  }
}

export function getStats(){

  const total = stats.wins + stats.losses;

  return {
    total,
    winrate: total ? (stats.wins/total)*100 : 0
  };
}