export function logTrade(c,strategy,result){

  console.log(`
=== TRADE ===
Symbol: ${c.symbol}
Strategy: ${strategy}
Result: ${result}
Price: ${c.current_price}
Time: ${new Date().toISOString()}
=============
  `);
}