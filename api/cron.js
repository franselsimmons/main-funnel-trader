import scanner from "./scanner.js";

export default async function handler(req, res) {
  try {
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

    await scanner({ query: {} }, fakeRes);

    return res.status(200).json({
      ok: true,
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