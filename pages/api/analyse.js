import { analyze } from "../../lib/teacherEngine";
import { kv } from "@vercel/kv";

export default async function handler(req,res){
  const mode=req.query.mode||"bull";
  const flow=await kv.get(`flow:${mode}`)||{};
  const perf=await analyze();

  res.json({ok:true,flow,perf});
}