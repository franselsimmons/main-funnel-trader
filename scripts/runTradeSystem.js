// ================= FILE: scripts/runTradeSystem.js =================

import { runTradeSystem } from '../src/trade/tradeSystem.js';
console.log(JSON.stringify(await runTradeSystem({ forceProcessSnapshot: process.argv.includes('--force') }), null, 2));
