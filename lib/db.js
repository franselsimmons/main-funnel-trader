import fs from "fs";
import path from "path";

const file = path.join(process.cwd(), "data", "trades.json");

// 🔥 init file
function ensureFile(){
  if(!fs.existsSync(file)){
    fs.writeFileSync(file, JSON.stringify([]));
  }
}

export function readDB(){
  try{
    ensureFile();
    const data = fs.readFileSync(file, "utf-8");
    return JSON.parse(data);
  }catch(e){
    return [];
  }
}

export function writeDB(data){
  try{
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }catch(e){
    console.error("DB WRITE ERROR:", e);
  }
}