export default async function handler(req, res) {

  await fetch(process.env.BASE_URL + "/api/bull/funnel")
  await fetch(process.env.BASE_URL + "/api/bear/funnel")

  res.json({ ok: true, job: "funnel" })
}