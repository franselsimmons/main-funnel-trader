import { getFilters, setFilters } from "../lib/filterState.js";

export default function handler(req, res){

  const token = req.headers["x-admin-token"];

  if(token !== process.env.ADMIN_TOKEN){
    return res.status(401).json({ error:"unauthorized" });
  }

  if(req.method === "GET"){
    return res.json(getFilters());
  }

  if(req.method === "POST"){
    const updated = setFilters(req.body);
    return res.json(updated);
  }

  return res.status(405).json({ error:"method not allowed" });
}