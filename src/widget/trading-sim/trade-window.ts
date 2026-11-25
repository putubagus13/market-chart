// The candles saved with a trade: the bars before the order and every bar until it ends.
// Pure data. Keeping the window free of later candles is what makes a dataset built from it
// safe to learn from: the context never contains a candle the user could not have seen.
import type { OHLCV } from '../../core/model/ohlcv';

export type Candle = [time: number, open: number, high: number, low: number, close: number, volume: number];

/** Candles saved before the placement bar, the placement bar included. */
export const LOOKBACK_BARS = 200;
export const MAX_WINDOW_CANDLES = 5000;

/** A provider without volume saves 0. */
export function toCandle(bar: OHLCV): Candle {
    return [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume ?? 0];
}

/** The last `limit` candles of `bars` that are not later than `placedAt`, oldest first, one per time. */
export function contextWindow(bars: readonly OHLCV[], placedAt: number, limit: number = LOOKBACK_BARS): Candle[] {
    const byTime = new Map<number, Candle>();
    for (const bar of bars) if (bar.time <= placedAt) byTime.set(bar.time, toCandle(bar));
    return [...byTime.values()].sort((a, b) => a[0] - b[0]).slice(-limit);
}

/** The window with `candle` added: the same time as the last candle replaces it, an older time is ignored. */
export function appendCandle(window: readonly Candle[], candle: Candle): Candle[] {
    const last = window[window.length - 1];
    if (last && candle[0] < last[0]) return [...window];
    const next = last && candle[0] === last[0] ? [...window.slice(0, -1), candle] : [...window, candle];
    return next.length > MAX_WINDOW_CANDLES ? next.slice(next.length - MAX_WINDOW_CANDLES) : next;
}

/** The candles up to the placement bar (inclusive) and the ones after it. */
export function splitWindow(window: readonly Candle[], placedAt: number): { context: Candle[]; trade: Candle[] } {
    return { context: window.filter((c) => c[0] <= placedAt), trade: window.filter((c) => c[0] > placedAt) };
}

/** Untrusted input: rows of six finite numbers with strictly ascending times, within the cap. */
export function isWindow(v: unknown): v is Candle[] {
    if (!Array.isArray(v) || v.length > MAX_WINDOW_CANDLES) return false;
    let prev = -Infinity;
    for (const row of v) {
        if (!Array.isArray(row) || row.length !== 6 || !row.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
        if (row[0] <= prev) return false;
        prev = row[0];
    }
    return true;
}
