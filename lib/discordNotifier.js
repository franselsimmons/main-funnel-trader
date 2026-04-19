const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

async function send(message){

  if(!WEBHOOK) return;

  try{
    await fetch(WEBHOOK, {
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
      color: 0x00ff99,
      fields:[
        { name:"Side", value:t.side.toUpperCase(), inline:true },
        { name:"Entry", value:String(t.entry), inline:true },
        { name:"SL", value:String(t.sl), inline:true },
        { name:"TP", value:String(t.tp), inline:true },
        { name:"RR", value:String(t.rr), inline:true },
        { name:"Sniper", value:t.sniper, inline:true }
      ],
      footer:{ text:"Trade System v2" },
      timestamp: new Date()
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
        { name:"Side", value:t.side.toUpperCase(), inline:true },
        { name:"Flow", value:t.flow, inline:true },
        { name:"Score", value:String(t.score), inline:true }
      ],
      timestamp: new Date()
    }]
  });
}


// ================= PARTIAL =================
export async function sendPartial(t){

  await send({
    embeds:[{
      title:`💰 PARTIAL TP - ${t.symbol}`,
      color: 0xf1c40f,
      description:"50% gesloten, trailing actief",
      timestamp: new Date()
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
        { name:"Side", value:t.side.toUpperCase(), inline:true },
        { name:"Reason", value:t.reason, inline:true },
        { name:"RR", value:String(t.rr), inline:true }
      ],
      timestamp: new Date()
    }]
  });
}