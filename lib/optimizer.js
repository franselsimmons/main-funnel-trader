import { getConfig,setConfig } from "./configStore";
import { analyze } from "./teacherEngine";

export async function optimize() {
  const a = await analyze();
  const c = await getConfig();

  if (a.winrate < 50)
    c.thresholds.confMin += 2;

  await setConfig(c);

  return c;
}