// scripts/runWeeklyRotation.js

import { runWeeklyRotation } from "../lib/rotation/rotationRunner.js";

const forceActivate = process.argv.includes("--activate") || process.argv.includes("--force");

const result = await runWeeklyRotation({
  activate: forceActivate,
  config: {
    topPerSide: 2,
    minCompletedSequence: [10, 5, 3, 1]
  }
});

console.log(JSON.stringify(result, null, 2));
