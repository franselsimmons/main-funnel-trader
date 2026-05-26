#!/usr/bin/env node

/**
 * Native weekly scheduler.
 *
 * Doel:
 * - Laat het tradesysteem deze week draaien op de active weekly winners.
 * - Draait op de achtergrond 1x per week de rotation-engine.
 * - Geen extra dependency nodig zoals node-cron.
 *
 * Default schedule:
 * - Maandag 00:05 UTC
 *
 * Env overrides:
 * - WEEKLY_ROTATION_CRON_DAY=1        // 0=zo, 1=ma, ..., 6=za
 * - WEEKLY_ROTATION_CRON_HOUR=0
 * - WEEKLY_ROTATION_CRON_MINUTE=5
 * - WEEKLY_ROTATION_CRON_DRY_RUN=1
 * - WEEKLY_ROTATION_CRON_FORCE=1
 * - WEEKLY_ROTATION_CRON_RUN_ON_START=1
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const ROOT = process.cwd();

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const CRON_DAY = clamp(toInt(process.env.WEEKLY_ROTATION_CRON_DAY, 1), 0, 6);
const CRON_HOUR = clamp(toInt(process.env.WEEKLY_ROTATION_CRON_HOUR, 0), 0, 23);
const CRON_MINUTE = clamp(toInt(process.env.WEEKLY_ROTATION_CRON_MINUTE, 5), 0, 59);

const DRY_RUN = process.env.WEEKLY_ROTATION_CRON_DRY_RUN === '1';
const FORCE = process.env.WEEKLY_ROTATION_CRON_FORCE === '1';
const RUN_ON_START = process.env.WEEKLY_ROTATION_CRON_RUN_ON_START === '1';

const MAX_TIMER_MS = 2_147_000_000; // Node setTimeout veilige grens: ±24.8 dagen.

let running = false;
let stopped = false;
let timer = null;

function log(message, payload = null) {
  const line = `[weekly-rotation-cron] ${new Date().toISOString()} ${message}`;

  if (!payload) {
    console.log(line);
    return;
  }

  console.log(line, payload);
}

function getNextRunDate(now = new Date()) {
  const next = new Date(now);

  next.setUTCHours(CRON_HOUR, CRON_MINUTE, 0, 0);

  const currentDay = next.getUTCDay();
  let daysUntil = CRON_DAY - currentDay;

  if (daysUntil < 0) daysUntil += 7;

  const isTodayButPassed = daysUntil === 0 && next <= now;
  if (isTodayButPassed) daysUntil = 7;

  next.setUTCDate(next.getUTCDate() + daysUntil);

  return next;
}

function getRunArgs() {
  const args = ['scripts/runWeeklyRotation.js'];

  if (DRY_RUN) args.push('--dry-run');
  if (FORCE) args.push('--force');

  return args;
}

function runWeeklyRotation(reason = 'scheduled') {
  if (running) {
    log(`skip: rotation already running (${reason})`);
    return Promise.resolve({ ok: false, skipped: true });
  }

  running = true;

  const args = getRunArgs();

  log(`start rotation (${reason})`, {
    command: `node ${args.join(' ')}`,
    dryRun: DRY_RUN,
    force: FORCE,
  });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      running = false;

      log('rotation process error', {
        message: error?.message ?? String(error),
      });

      resolve({ ok: false, error });
    });

    child.on('close', (code, signal) => {
      running = false;

      if (code === 0) {
        log(`rotation finished (${reason})`);
        resolve({ ok: true, code, signal });
        return;
      }

      log(`rotation failed (${reason})`, {
        code,
        signal,
      });

      resolve({ ok: false, code, signal });
    });
  });
}

function scheduleNext() {
  if (stopped) return;

  const now = new Date();
  const next = getNextRunDate(now);
  const delayMs = Math.max(0, next.getTime() - now.getTime());

  log('next run scheduled', {
    nextRunUtc: next.toISOString(),
    delayMs,
    day: CRON_DAY,
    hour: CRON_HOUR,
    minute: CRON_MINUTE,
  });

  scheduleWithLongTimeout(delayMs, async () => {
    await runWeeklyRotation('scheduled');
    scheduleNext();
  });
}

function scheduleWithLongTimeout(delayMs, callback) {
  if (timer) clearTimeout(timer);

  if (delayMs <= MAX_TIMER_MS) {
    timer = setTimeout(callback, delayMs);
    return;
  }

  timer = setTimeout(() => {
    scheduleWithLongTimeout(delayMs - MAX_TIMER_MS, callback);
  }, MAX_TIMER_MS);
}

async function start() {
  log('cron started', {
    scheduleUtc: {
      day: CRON_DAY,
      hour: CRON_HOUR,
      minute: CRON_MINUTE,
    },
    runOnStart: RUN_ON_START,
    dryRun: DRY_RUN,
    force: FORCE,
  });

  if (RUN_ON_START) {
    await runWeeklyRotation('startup');
  }

  scheduleNext();
}

function shutdown(signal) {
  stopped = true;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  log(`cron stopped by ${signal}`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  log('uncaught exception', {
    message: error?.message ?? String(error),
    stack: error?.stack,
  });

  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('unhandled rejection', {
    message: reason?.message ?? String(reason),
    stack: reason?.stack,
  });

  process.exit(1);
});

await start();