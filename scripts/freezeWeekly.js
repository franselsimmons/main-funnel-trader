// ================= FILE: scripts/freezeWeekly.js =================

import { CONFIG } from '../src/config.js';
import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

async function main() {
  const startedAt = Date.now();

  const weekKey =
    getArgValue('weekKey') ||
    getArgValue('week') ||
    undefined;

  const mode =
    getArgValue('mode') ||
    CONFIG.rotation?.mode ||
    'balanced';

  try {
    const result = await freezeWeeklyRotation({
      weekKey,
      mode
    });

    console.log(JSON.stringify({
      ok: result?.ok !== false,
      source: 'CLI_FREEZE_WEEKLY_ROTATION',
      weekKey: weekKey || result?.weekKey || null,
      mode,
      durationMs: Date.now() - startedAt,
      result
    }, null, 2));

    process.exitCode = result?.ok === false ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      source: 'CLI_FREEZE_WEEKLY_ROTATION',
      weekKey: weekKey || null,
      mode,
      error: error?.message || String(error),
      stack: error?.stack,
      durationMs: Date.now() - startedAt
    }, null, 2));

    process.exitCode = 1;
  }
}

await main();