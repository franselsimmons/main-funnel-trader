let portfolio = {
  balance: 10000,
  equity: 10000,
  drawdown: 0,
  peak: 10000
};

export function getPortfolio(){
  return portfolio;
}

export function updateEquity(pnl){

  portfolio.balance += pnl;

  if(portfolio.balance > portfolio.peak){
    portfolio.peak = portfolio.balance;
  }

  portfolio.drawdown =
    ((portfolio.peak - portfolio.balance) / portfolio.peak) * 100;
}

export function getRiskAmount(riskPct){
  return portfolio.balance * (riskPct/100);
}