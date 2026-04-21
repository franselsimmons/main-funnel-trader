const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

const fetchFn = globalThis.fetch;

async function send(message){

  if(!WEBHOOK) return;

  if(!fetchFn){
    console.error("Discord error: fetch is not available in this Node runtime");
    return;
  }

  try{
    await fetchFn(WEBHOOK,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(message)
    });
  }catch(e){
    console.error("Discord error:", e.message);
  }
}


// ================= ENTRY =================
export async function sendEntry(t){

  await send({
    embeds:[{
      title:`🚀 ENTRY - ${t.symbol}`,
      color: t.grade === "A" ? 0x00ff99 : 0xf1c40f,
      fields:[
        { name:"Side", value:String(t.side || "").toUpperCase(), inline:true },
        { name:"Grade", value:String(t.grade || "N/A"), inline:true },
        { name:"Risk", value:String(t.recommendedRisk || "N/A"), inline:true },
        { name:"Entry", value:String(t.entry), inline:true },
        { name:"SL", value:String(t.sl), inline:true },
        { name:"TP", value:String(t.tp), inline:true },
        { name:"RR", value:String(t.rr), inline:true },
        { name:"Sniper", value:t.sniper || "N/A", inline:true },
        { name:"Confluence", value:String(t.confluence ?? "N/A"), inline:true },
        { name:"OB Bias", value:t.obBias || "N/A", inline:true },
        { name:"SL Source", value:t.slSource || "N/A", inline:true },
        { name:"TP Source", value:t.tpSource || "N/A", inline:true }
      ],
      footer:{ text:"Trade System v2" },
      timestamp: new Date().toISOString()
    }]
  });
}


// ================= HOLD =================
export async function sendHold(t){

  await send({
    embeds:[{
      title:`📈 HOLD - ${t.symbol}`,
      color: 0x3498db,
      fields:[
        { name:"Side", value:String(t.side || "").toUpperCase(), inline:true },
        { name:"Grade", value:String(t.grade || "N/A"), inline:true },
        { name:"Risk", value:String(t.recommendedRisk || "N/A"), inline:true },
        { name:"Flow", value:t.flow || "N/A", inline:true },
        { name:"Score", value:String(t.score || 0), inline:true },
        { name:"RR", value:String(t.rr || "N/A"), inline:true },
        { name:"SL Source", value:t.slSource || "N/A", inline:true },
        { name:"TP Source", value:t.tpSource || "N/A", inline:true }
      ],
      timestamp: new Date().toISOString()
    }]
  });
}


// ================= PARTIAL =================
export async function sendPartial(t){

  await send({
    embeds:[{
      title:`💰 PARTIAL TP - ${t.symbol}`,
      color: 0xf1c40f,
      description:"Partial gesloten, trailing actief",
      timestamp: new Date().toISOString()
    }]
  });
}


// ================= EXIT =================
export async function sendExit(t){

  let color = 0xe74c3c;
  if(t.reason === "TP") color = 0x2ecc71;

  await send({
    embeds:[{
      title:`❌ EXIT - ${t.symbol}`,
      color,
      fields:[
        { name:"Side", value:String(t.side || "").toUpperCase(), inline:true },
        { name:"Reason", value:t.reason || "N/A", inline:true },
        { name:"Grade", value:String(t.grade || "N/A"), inline:true },
        { name:"Risk", value:String(t.recommendedRisk || "N/A"), inline:true },
        { name:"RR", value:String(t.rr || "N/A"), inline:true },
        { name:"SL Source", value:t.slSource || "N/A", inline:true },
        { name:"TP Source", value:t.tpSource || "N/A", inline:true }
      ],
      timestamp: new Date().toISOString()
    }]
  });
}