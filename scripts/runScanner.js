// ================= FILE: scripts/runScanner.js =================

import { runScanner } from '../src/market/scanner.js';
console.log(JSON.stringify(await runScanner(), null, 2));
