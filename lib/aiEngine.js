export function aiScore({ confidence, depth, spread }) {
  let s = confidence * 1.1;
  s += Math.min(30, depth / 10000);
  s -= spread * 5;
  return Math.max(0, Math.min(100, Math.round(s)));
}