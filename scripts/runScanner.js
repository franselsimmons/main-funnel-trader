// ================= FILE: scripts/runScanner.js =================

import { runScanner } from '../src/market/scanner.js';

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function buildSuccessPayload({
  result,
  startedAt
}) {
  return {
    ok: result?.ok !== false,
    source: 'CLI_RUN_SCANNER',
    argv: argv(),
    durationMs: now() - startedAt,
    result
  };
}

function buildErrorPayload({
  error,
  startedAt
}) {
  return {
    ok: false,
    source: 'CLI_RUN_SCANNER',
    argv: argv(),
    error: error?.message || String(error),
    stack: error?.stack,
    durationMs: now() - startedAt
  };
}

function exitCodeFromResult(result) {
  return result?.ok === false ? 1 : 0;
}

async function main() {
  const startedAt = now();

  try {
    const result = await runScanner();

    console.log(JSON.stringify(
      buildSuccessPayload({
        result,
        startedAt
      }),
      null,
      2
    ));

    process.exitCode = exitCodeFromResult(result);
  } catch (error) {
    console.error(JSON.stringify(
      buildErrorPayload({
        error,
        startedAt
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();