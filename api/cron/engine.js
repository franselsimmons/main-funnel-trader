export default async function handler(req, res) {

  await fetch(process.env.BASE_URL + "/api/bull/engine")
  await fetch(process.env.BASE_URL + "/api/bear/engine")

  res.json({ ok: true, job: "engine" })
}