// ================= FILE: scripts/activateRotation.js =================

import { activateNextRotation } from '../src/analyze/rotationEngine.js';

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const startedAt = Date.now();

  const options = {
    force: hasFlag('force'),
    weekKey: getArgValue('weekKey') || getArgValue('week') || undefined
  };

  try {
    const result = await activateNextRotation(options);

    console.log(JSON.stringify({
      ok: result?.ok !== false,
      source: 'CLI_ACTIVATE_NEXT_ROTATION',
      force: options.force,
      weekKey: options.weekKey || result?.weekKey || result?.activeRotation?.activeWeekKey || null,
      durationMs: Date.now() - startedAt,
      result
    }, null, 2));

    process.exitCode = result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      source: 'CLI_ACTIVATE_NEXT_ROTATION',
      force: options.force,
      weekKey: options.weekKey || null,
      error: error?.message || String(error),
      stack: error?.stack,
      durationMs: Date.now() - startedAt
    }, null, 2));

    process.exitCode = 1;
  }
}

await main();