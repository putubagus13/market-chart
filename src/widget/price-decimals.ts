/**
 * Fraction digits to show a price with: the symbol's tick size when the source gives one,
 * otherwise a guess from the price's magnitude (cheap coins need more digits).
 */
export function priceDecimals(price: number, mintick?: number): number {
    if (mintick && Number.isFinite(mintick) && mintick > 0) {
        return Math.min(10, Math.max(0, Math.round(-Math.log10(mintick))));
    }
    const abs = Math.abs(price);
    if (!Number.isFinite(abs) || abs >= 1000) return 2;
    if (abs >= 1) return 4;
    if (abs >= 0.01) return 6;
    return 8;
}
