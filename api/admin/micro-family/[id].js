import { getIsoWeekKey, apiOk, apiError, assertAdmin } from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/analyzeEngine.js';

export default async function handler(req, res) {
  try {
    assertAdmin(req);
    const url = new URL(req.url || '/', 'http://local');
    const weekKey = url.searchParams.get('weekKey') || getIsoWeekKey();
    const rawId = req.query?.id || decodeURIComponent(url.pathname.split('/').pop() || '');
    const id = decodeURIComponent(String(rawId || ''));
    const micros = await getWeekMicros(weekKey);
    const row = micros[id] || Object.values(micros).find((x) => x.microFamilyId === id || x.trueMicroFamilyId === id);

    if (!row) {
      apiOk(res, { ok: false, found: false, weekKey, id }, 404);
      return;
    }

    apiOk(res, { ok: true, found: true, weekKey, id, row });
  } catch (error) {
    apiError(res, error, error.statusCode || 500);
  }
}
