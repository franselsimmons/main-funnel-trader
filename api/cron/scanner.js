export default async function handler(req, res) {

  await fetch(process.env.BASE_URL + "/api/bull/scanner")
  await fetch(process.env.BASE_URL + "/api/bear/scanner")

  res.json({ ok: true, job: "scanner" })
}