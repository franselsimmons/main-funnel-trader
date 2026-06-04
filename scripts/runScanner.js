// ================= FILE: scripts/runScanner.js =================

import { runScanner } from '../src/market/scanner.js';

async function main() {
  const startedAt = Date.now();

  try {
    const result = await runScanner();

    console.log(JSON.stringify({
      ok: result?.ok !== false,
      source: 'CLI_RUN_SCANNER',
      argv: process.argv.slice(2),
      durationMs: Date.now() - startedAt,
      result
    }, null, 2));

    process.exitCode = result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      source: 'CLI_RUN_SCANNER',
      argv: process.argv.slice(2),
      error: error?.message || String(error),
      stack: error?.stack,
      durationMs: Date.now() - startedAt
    }, null, 2));

    process.exitCode = 1;
  }
}

await main();