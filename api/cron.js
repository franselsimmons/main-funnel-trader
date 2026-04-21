import scanner from "./scanner.js";

function normalizeSide(side){

  const s = String(side || "both").toLowerCase();

  if(s === "bull") return "bull";
  if(s === "bear") return "bear";

  return "both";
}

export default async function handler(req, res) {

  try {

    const side = normalizeSide(req?.query?.side);

    const fakeReq = {
      query: {
        side
      }
    };

    const fakeRes = {
      _status: 200,
      _json: null,

      status(code) {
        this._status = code;
        return this;
      },

      json(payload) {
        this._json = payload;
        return this;
      }
    };

    await scanner(fakeReq, fakeRes);

    return res.status(200).json({
      ok: true,
      side,
      scannerStatus: fakeRes._status,
      scannerPayload: fakeRes._json || null,
      ranAt: Date.now()
    });

  } catch (err) {

    console.error("CRON ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "cron_failed"
    });
  }
}