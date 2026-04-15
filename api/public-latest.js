import scanner from "./scanner.js";

export default async function handler(req, res) {
  return scanner(req, res);
}