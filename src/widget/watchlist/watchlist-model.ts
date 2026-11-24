// The watchlist's symbols as data: an ordered list without duplicates, edited by the panel
// and saved into the shell's document. No DOM here.

/** Most symbols a watchlist keeps; adds beyond it are refused. */
export const WATCHLIST_MAX = 200;

/** What the shell's document stores for a watchlist. */
export interface WatchlistPayload {
    symbols: string[];
}

const same = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

export class WatchlistModel {
    private list: string[] = [];
    /** The list came from a saved document or a user edit — the panel seeds defaults only when not. */
    touched = false;
    private readonly listeners = new Set<() => void>();

    get symbols(): readonly string[] {
        return this.list;
    }

    has(symbol: string): boolean {
        return this.list.some((s) => same(s, symbol));
    }

    /** Append `symbol` (trimmed). Returns false for an empty, duplicate or over-limit add. */
    add(symbol: string): boolean {
        const s = symbol.trim();
        if (!s || this.has(s) || this.list.length >= WATCHLIST_MAX) return false;
        this.list = [...this.list, s];
        this.changed();
        return true;
    }

    remove(symbol: string): boolean {
        const next = this.list.filter((s) => !same(s, symbol));
        if (next.length === this.list.length) return false;
        this.list = next;
        this.changed();
        return true;
    }

    /** Move the symbol at `from` to index `to` (both clamped to the list). */
    move(from: number, to: number): void {
        if (from < 0 || from >= this.list.length) return;
        const target = Math.max(0, Math.min(this.list.length - 1, to));
        if (target === from) return;
        const next = [...this.list];
        const [item] = next.splice(from, 1);
        next.splice(target, 0, item!);
        this.list = next;
        this.changed();
    }

    /** Replace the list without marking it as a user edit (the panel's first-run defaults). */
    seed(symbols: readonly string[]): void {
        this.list = dedupe(symbols);
        this.emit();
    }

    toJSON(): WatchlistPayload {
        return { symbols: [...this.list] };
    }

    /** Load a saved payload. It comes from storage: anything malformed is ignored. */
    restore(payload: unknown): void {
        const raw = (payload as Partial<WatchlistPayload> | null)?.symbols;
        if (!Array.isArray(raw)) return;
        this.list = dedupe(raw.filter((s): s is string => typeof s === 'string')).slice(0, WATCHLIST_MAX);
        this.touched = true;
        this.emit();
    }

    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private changed(): void {
        this.touched = true;
        this.emit();
    }

    private emit(): void {
        for (const cb of [...this.listeners]) cb();
    }
}

function dedupe(symbols: readonly string[]): string[] {
    const out: string[] = [];
    for (const raw of symbols) {
        const s = raw.trim();
        if (s && !out.some((o) => same(o, s))) out.push(s);
    }
    return out;
}

/** Last price and its change against the previous daily close. */
export interface Quote {
    last: number;
    change: number;
    changePercent: number;
}

/** A quote from a symbol's last two daily bars (the forming day last); null without two. */
export function quoteFromDaily(bars: ReadonlyArray<{ close: number }>): Quote | null {
    if (bars.length < 2) return null;
    const prev = bars[bars.length - 2]!.close;
    const last = bars[bars.length - 1]!.close;
    const change = last - prev;
    return { last, change, changePercent: prev !== 0 ? (change / prev) * 100 : 0 };
}
