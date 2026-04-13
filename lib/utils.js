export function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}