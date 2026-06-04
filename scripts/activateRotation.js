// ================= FILE: scripts/activateRotation.js =================

import { activateNextRotation } from '../src/analyze/rotationEngine.js';
console.log(JSON.stringify(await activateNextRotation(), null, 2));
