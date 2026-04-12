export default async function handler(req, res) {

  await fetch(process.env.BASE_URL + "/api/analyse")

  res.json({ ok: true, job: "analyse" })
}