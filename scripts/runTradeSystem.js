// ================= FILE: scripts/runTradeSystem.js =================

import { runTradeSystem } from '../src/trade/tradeSystem.js';

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const startedAt = Date.now();

  const forceProcessSnapshot =
    hasFlag('--force') ||
    hasFlag('--forceProcessSnapshot');

  try {
    const result = await runTradeSystem({
      forceProcessSnapshot
    });

    console.log(JSON.stringify({
      ok: result?.ok !== false,
      source: 'CLI_RUN_TRADE_SYSTEM',
      forceProcessSnapshot,
      durationMs: Date.now() - startedAt,
      result
    }, null, 2));

    process.exitCode = result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      source: 'CLI_RUN_TRADE_SYSTEM',
      forceProcessSnapshot,
      error: error?.message || String(error),
      stack: error?.stack,
      durationMs: Date.now() - startedAt
    }, null, 2));

    process.exitCode = 1;
  }
}

await main();