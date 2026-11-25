// Number fields of the trade simulator take plain positive decimals typed with a dot: text that
// is anything else (a sign, a comma, an exponent, zero) is not a number the user meant to set.

/** The positive number in `text`, or null when the text is not a plain positive decimal. */
export function parsePositiveNumber(text: string): number | null {
    const t = text.trim();
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const n = Number(t);
    return n > 0 ? n : null;
}
