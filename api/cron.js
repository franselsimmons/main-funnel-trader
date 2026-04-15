export default async function handler(req, res) {
  try {
    const url = process.env.APP_URL || "https://jouw-site.vercel.app";

    await fetch(`${url}/api/public-latest?mode=bull`);
    await fetch(`${url}/api/public-latest?mode=bear`);

    return res.status(200).json({
      ok: true,
      time: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}