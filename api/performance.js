import { getPerformance } from "../lib/performance.js";

export default function handler(req,res){

  const perf = getPerformance();

  res.status(200).json(perf);
}