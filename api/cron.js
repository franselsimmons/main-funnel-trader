export default async function handler(req, res) {
  console.log("CRON RUN", new Date().toISOString());
  res.json({ ok: true });
}