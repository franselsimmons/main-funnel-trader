export function detectRegime(coins) {
  try {
    if (!Array.isArray(coins) || coins.length === 0) {
      return "MID_VOL";
    }

    const avg =
      coins.reduce((sum, c) => {
        const v =
          c?.price_change_percentage_24h ??
          c?.change24 ??
          0;

        return sum + Math.abs(Number(v) || 0);
      }, 0) / coins.length;

    if (avg < 3) return "LOW_VOL";
    if (avg < 6) return "MID_VOL";
    return "HIGH_VOL";
  } catch {
    return "MID_VOL";
  }
}