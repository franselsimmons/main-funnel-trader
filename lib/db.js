import fs from "fs";
import path from "path";

function isVercel(){
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

function getDbFile(){

  // Lokaal: project/data/trades.json
  // Vercel: alleen /tmp is schrijfbaar
  if(isVercel()){
    return path.join("/tmp", "trades.json");
  }

  return path.join(process.cwd(), "data", "trades.json");
}

const file = getDbFile();

function ensureFile(){

  const dir = path.dirname(file);

  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
  }

  if(!fs.existsSync(file)){
    fs.writeFileSync(file, JSON.stringify([], null, 2), "utf-8");
  }
}

export function getDBMeta(){
  return {
    file,
    runtime: isVercel() ? "vercel_tmp" : "local_disk"
  };
}

export function readDB(){

  try{
    ensureFile();

    const raw = fs.readFileSync(file, "utf-8");

    if(!raw || !raw.trim()){
      return [];
    }

    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed
      : [];

  }catch(e){
    console.error("DB READ ERROR:", e);
    return [];
  }
}

export function writeDB(data){

  try{
    ensureFile();

    const safeData = Array.isArray(data)
      ? data
      : [];

    const tempFile = `${file}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(safeData, null, 2),
      "utf-8"
    );

    fs.renameSync(tempFile, file);

    return true;

  }catch(e){
    console.error("DB WRITE ERROR:", e);
    return false;
  }
}