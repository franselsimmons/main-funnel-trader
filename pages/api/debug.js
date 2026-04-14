import { kv } from "@vercel/kv";

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function sampleFromState(stateObj, max = 5) {
  if (!stateObj || typeof stateObj !== "object") return [];
  const keys = Object.keys(stateObj);
  const out = [];
  for (let i = 0; i < keys.length && out.length < max; i++) {
    const c = stateObj[keys[i]];
    if (c && typeof c === "object") out.push(c);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    // Deze keys passen bij wat jij eerder gebruikte:
    // - state:bull / state:bear (pipeline state)
    // - bull:scanner:candidates / bear:scanner:candidates (simple scanner list)
    // - open:bull / open:bear (open trades)
    const [
      bullState,
      bearState,
      bullCandidates,
      bearCandidates,
      bullOpen,
      bearOpen,
    ] = await Promise.all([
      kv.get("state:bull"),
      kv.get("state:bear"),
      kv.get("bull:scanner:candidates"),
      kv.get("bear:scanner:candidates"),
      kv.get("open:bull"),
      kv.get("open:bear"),
    ]);

    const bullCandidatesArr = arr(bullCandidates);
    const bearCandidatesArr = arr(bearCandidates);
    const bullOpenArr = arr(bullOpen);
    const bearOpenArr = arr(bearOpen);

    // “last scan” proberen te pakken uit state payload (als jouw scanner het opslaat)
    const bullTs =
      Number(bullState?.ts || bullState?.scannedAt || bullState?.updatedAt || 0) || 0;
    const bearTs =
      Number(bearState?.ts || bearState?.scannedAt || bearState?.updatedAt || 0) || 0;

    res.status(200).json({
      ok: true,

      bull: {
        lastScanTs: bullTs,
        candidatesCount: bullCandidatesArr.length,
        openTradesCount: bullOpenArr.length,
        stateKeysCount:
          bullState && typeof bullState === "object" ? Object.keys(bullState).length : 0,
        candidatesSample: bullCandidatesArr.slice(0, 3),
        openTradesSample: bullOpenArr.slice(0, 3),
        stateSample: sampleFromState(bullState, 3),
      },

      bear: {
        lastScanTs: bearTs,
        candidatesCount: bearCandidatesArr.length,
        openTradesCount: bearOpenArr.length,
        stateKeysCount:
          bearState && typeof bearState === "object" ? Object.keys(bearState).length : 0,
        candidatesSample: bearCandidatesArr.slice(0, 3),
        openTradesSample: bearOpenArr.slice(0, 3),
        stateSample: sampleFromState(bearState, 3),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}