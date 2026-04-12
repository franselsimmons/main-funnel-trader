import { getKey } from "../../storage/kv.js"

export default async function handler(req, res) {
  const data = await getKey("portfolio:bear") || []
  res.json(data)
}