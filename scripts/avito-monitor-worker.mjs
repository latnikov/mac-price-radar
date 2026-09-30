import { resolve } from 'node:path';
import { runApifyWorker } from './avito-apify-worker.mjs';
import { openMasterStore } from './master-store.mjs';
import { calculateAvitoOpportunities } from './avito-opportunities.mjs';
import { sendAvitoAlerts } from './avito-alerts.mjs';

const root = process.cwd(), env = process.env;
const state = await runApifyWorker({ root, env });
const store = openMasterStore(resolve(root, 'data/private/master.sqlite'));
let opportunities;
try { opportunities = calculateAvitoOpportunities(store.getOffers({ includeRejected: true, summary: true })); }
finally { store.close(); }
const notifications = await sendAvitoAlerts({ opportunities, env, dir: resolve(root, env.AVITO_DATA_DIR || 'data/private/avito') });
console.log(JSON.stringify({ state: state.state, message: state.message, counts: state.counts, notifications }));
if (['error', 'needs_attention'].includes(state.state)) process.exitCode = 1;
