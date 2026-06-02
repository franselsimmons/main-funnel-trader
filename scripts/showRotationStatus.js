// scripts/showRotationStatus.js

import { getActiveWeeklyGate } from "../lib/rotation/getActiveWeeklyGate.js";
import { getRotationStorageStatus } from "../lib/rotation/rotationStore.js";

const [gate, storage] = await Promise.all([
  getActiveWeeklyGate(),
  getRotationStorageStatus()
]);

console.log(JSON.stringify({ gate, storage }, null, 2));
