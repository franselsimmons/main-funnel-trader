import fs from 'fs/promises';
import path from 'path';

import {
  buildWeeklyRotation,
  getRotationDecisionText,
} from './weeklySelector.js';

const DEFAULT_PATHS = {
  rootDir: process.cwd(),

  // Hier leest hij microfamily-analyse uit.
  // Eerste bestaande bestand wint.
  candidateInputs: [
    'data/analyze/microfamilies.json',
    'data/analyze/microFamilies.json',
    'data/microfamilies.json',
    'data/family-micro-analysis.json',
    'data/analyzer/microfamilies.json',
    'data/analysis/microfamilies.json',
  ],

  rotationDir: 'data/rotation',
  activeFile: 'data/rotation/activeRotation.json',
  historyFile: 'data/rotation/rotationHistory.jsonl',
  lastPreviewFile: 'data/rotation/lastRotationPreview.json',
};

const DEFAULT_OPTIONS = {
  dryRun: false,
  force: false,

  lookbackDays: 7,
  minClosed: 6,
  minAvgR: 0.05,
  minProfitFactor: 1.15,
  maxPerSide: 3,
};

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function resolveProjectPath(rootDir, filePath) {
  if (path.isAbsolute(filePath)) return filePath;

  return path.join(rootDir, filePath);
}

async function readJsonFile(filePath, fallback = null) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = safeJsonParse(raw, fallback);

  return parsed;
}

async function writeJsonFile(filePath, data) {
  await ensureDir(path.dirname(filePath));

  const tmpPath = `${filePath}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  await fs.writeFile(tmpPath, payload, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function appendJsonLine(filePath, data) {
  await ensureDir(path.dirname(filePath));

  const line = `${JSON.stringify(data)}\n`;

  await fs.appendFile(filePath, line, 'utf8');
}

function extractArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;

  if (!isObject(payload)) return [];

  const candidates = [
    payload.microFamilies,
    payload.microfamilies,
    payload.micro,
    payload.rows,
    payload.data,
    payload.result,
    payload.results,
    payload.families,
    payload.allowlist,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  if (isObject(payload.mainMicrofamilyAnalyzer)) {
    return extractArrayFromPayload(payload.mainMicrofamilyAnalyzer);
  }

  if (isObject(payload.microfamilyAnalysis)) {
    return extractArrayFromPayload(payload.microfamilyAnalysis);
  }

  if (isObject(payload.analysis)) {
    return extractArrayFromPayload(payload.analysis);
  }

  return [];
}

async function findFirstInputFile(paths) {
  const { rootDir, candidateInputs } = paths;

  for (const candidate of candidateInputs) {
    const resolved = resolveProjectPath(rootDir, candidate);

    if (await pathExists(resolved)) {
      return resolved;
    }
  }

  return null;
}

async function loadMicroFamiliesFromFile(inputFile) {
  const payload = await readJsonFile(inputFile, null);
  const rows = extractArrayFromPayload(payload);

  return {
    inputFile,
    payload,
    rows,
  };
}

async function loadActiveRotation(paths) {
  const activePath = resolveProjectPath(paths.rootDir, paths.activeFile);

  if (!(await pathExists(activePath))) return null;

  return readJsonFile(activePath, null);
}

function rotationIsStillActive(rotation, now = new Date()) {
  if (!rotation?.expiresAt) return false;

  const expiresAt = new Date(rotation.expiresAt);

  if (Number.isNaN(expiresAt.getTime())) return false;

  return expiresAt > now;
}

function shouldSkipRotation({ activeRotation, options, now }) {
  if (options.force) return false;
  if (!activeRotation) return false;

  return rotationIsStillActive(activeRotation, now);
}

function buildRunnerPaths(customPaths = {}) {
  return {
    ...DEFAULT_PATHS,
    ...customPaths,
    candidateInputs:
      customPaths.candidateInputs ||
      DEFAULT_PATHS.candidateInputs,
  };
}

function buildRunnerOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  };
}

function buildRotationMeta({ inputFile, activeRotation, options, dryRun }) {
  return {
    runner: 'rotationRunner',
    inputFile,
    dryRun,
    forced: Boolean(options.force),
    previousRotationId: activeRotation?.rotationId || null,
  };
}

async function persistRotation({ rotation, paths, dryRun }) {
  const activePath = resolveProjectPath(paths.rootDir, paths.activeFile);
  const previewPath = resolveProjectPath(paths.rootDir, paths.lastPreviewFile);
  const historyPath = resolveProjectPath(paths.rootDir, paths.historyFile);

  if (dryRun) {
    await writeJsonFile(previewPath, rotation);

    return {
      persisted: false,
      previewPath,
      activePath,
      historyPath,
    };
  }

  await writeJsonFile(activePath, rotation);
  await appendJsonLine(historyPath, rotation);

  return {
    persisted: true,
    previewPath: null,
    activePath,
    historyPath,
  };
}

export async function runWeeklyRotation(customOptions = {}, customPaths = {}) {
  const options = buildRunnerOptions(customOptions);
  const paths = buildRunnerPaths(customPaths);
  const now = options.now ? new Date(options.now) : new Date();

  const inputFile = options.inputFile
    ? resolveProjectPath(paths.rootDir, options.inputFile)
    : await findFirstInputFile(paths);

  if (!inputFile) {
    return {
      ok: false,
      status: 'NO_INPUT_FILE',
      message: 'Geen microfamily input gevonden.',
      checked: paths.candidateInputs,
    };
  }

  const activeRotation = await loadActiveRotation(paths);

  if (shouldSkipRotation({ activeRotation, options, now })) {
    return {
      ok: true,
      status: 'SKIPPED_ACTIVE_ROTATION',
      message: 'Er is al een actieve rotatie. Gebruik force=true om te overschrijven.',
      activeRotation,
      decision: getRotationDecisionText(activeRotation),
    };
  }

  const loaded = await loadMicroFamiliesFromFile(inputFile);

  if (!loaded.rows.length) {
    return {
      ok: false,
      status: 'NO_MICRO_ROWS',
      message: 'Inputbestand gevonden, maar geen microfamily rows gevonden.',
      inputFile,
    };
  }

  const rotation = buildWeeklyRotation(loaded.rows, {
    lookbackDays: options.lookbackDays,
    minClosed: options.minClosed,
    minAvgR: options.minAvgR,
    minProfitFactor: options.minProfitFactor,
    maxPerSide: options.maxPerSide,
    now,
  });

  rotation.meta = buildRotationMeta({
    inputFile,
    activeRotation,
    options,
    dryRun: options.dryRun,
  });

  const persistence = await persistRotation({
    rotation,
    paths,
    dryRun: options.dryRun,
  });

  return {
    ok: true,
    status: options.dryRun ? 'PREVIEW_CREATED' : 'ROTATION_CREATED',
    decision: getRotationDecisionText(rotation),
    rotation,
    persistence,
  };
}

export async function previewWeeklyRotation(customOptions = {}, customPaths = {}) {
  return runWeeklyRotation(
    {
      ...customOptions,
      dryRun: true,
      force: true,
    },
    customPaths
  );
}

export async function forceWeeklyRotation(customOptions = {}, customPaths = {}) {
  return runWeeklyRotation(
    {
      ...customOptions,
      dryRun: false,
      force: true,
    },
    customPaths
  );
}

export async function getActiveRotation(customPaths = {}) {
  const paths = buildRunnerPaths(customPaths);

  return loadActiveRotation(paths);
}

export function isFamilyAllowedByRotation(rotation, familyId, side = null) {
  if (!rotation?.allowlist?.length) return false;
  if (!familyId) return false;

  const wantedFamilyId = String(familyId).trim();
  const wantedSide = side ? String(side).trim().toUpperCase() : null;

  return rotation.allowlist.some(item => {
    if (item.familyId !== wantedFamilyId) return false;
    if (!wantedSide) return true;

    return item.side === wantedSide;
  });
}

export function getAllowedFamilyIds(rotation, side = null) {
  if (!rotation?.allowlist?.length) return [];

  const wantedSide = side ? String(side).trim().toUpperCase() : null;

  return rotation.allowlist
    .filter(item => {
      if (!wantedSide) return true;

      return item.side === wantedSide;
    })
    .map(item => item.familyId);
}

export async function readRotationStatus(customPaths = {}) {
  const rotation = await getActiveRotation(customPaths);

  if (!rotation) {
    return {
      ok: true,
      status: 'NO_ACTIVE_ROTATION',
      active: false,
      decision: 'NO_ROTATION',
    };
  }

  const active = rotationIsStillActive(rotation, new Date());

  return {
    ok: true,
    status: active ? 'ACTIVE' : 'EXPIRED',
    active,
    rotation,
    decision: getRotationDecisionText(rotation),
  };
}

async function runFromCli() {
  const args = new Set(process.argv.slice(2));

  const dryRun = args.has('--dry-run') || args.has('--preview');
  const force = args.has('--force');

  const result = await runWeeklyRotation({
    dryRun,
    force,
  });

  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(result.decision);
  console.log(JSON.stringify({
    status: result.status,
    persisted: result.persistence?.persisted || false,
    activePath: result.persistence?.activePath || null,
    previewPath: result.persistence?.previewPath || null,
    totalAllowed: result.rotation?.summary?.totalAllowed || 0,
  }, null, 2));
}

const isCliRun = process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;

if (isCliRun) {
  runFromCli().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default {
  runWeeklyRotation,
  previewWeeklyRotation,
  forceWeeklyRotation,
  getActiveRotation,
  readRotationStatus,
  isFamilyAllowedByRotation,
  getAllowedFamilyIds,
};