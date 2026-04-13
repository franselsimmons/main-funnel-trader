import { kv } from "@vercel/kv";
import { executeTrade } from "../../lib/tradeEngine";

export default async function handler(req,res){
  const mode=req.query.mode||"bull";
  const state=await kv.get(`state:${mode}`)||{};

  for(const sym in state){
    const c=state[sym];
    if(c.stage==="ENTRY_READY"){
      await executeTrade(mode,c);
    }
  }

  const open=await kv.get(`open:${mode}`)||[];
  res.json({ok:true,open});
}