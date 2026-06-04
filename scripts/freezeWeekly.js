// ================= FILE: scripts/freezeWeekly.js =================

import { freezeWeeklyRotation } from '../src/analyze/rotationEngine.js';
console.log(JSON.stringify(await freezeWeeklyRotation(), null, 2));
