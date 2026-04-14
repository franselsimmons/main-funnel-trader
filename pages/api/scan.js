// ALLEEN DIT STUK AANPASSEN IN JE SCAN:

for (const coin of funnel.entry_ready) {
  if (executed >= AUTO_MAX_PER_SCAN) break;

  try {
    const result = await executeTrade(mode, coin, {
      maxOpen: 5,
      maxSpreadPct: thresholds?.spreadMaxPct ?? 2,
      minDepthUsd1p: thresholds?.depthMinUsd ?? 800,
    });

    if (result?.opened) {
      executed++;
    }
  } catch (e) {
    console.error("TRADE_FAIL:", coin.symbol);
  }
}