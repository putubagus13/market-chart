// Per-symbol pip sizes the user set for the trading simulator. Without one, a trade's
// pips use the tick size it was placed with. Pure data — no DOM.
import type { SimTrade } from './sim-engine';

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export class PipSizes {
    private sizes = new Map<string, number>();
    private readonly listeners = new Set<() => void>();

    get(symbol: string): number | undefined {
        return this.sizes.get(symbol.toUpperCase());
    }

    /** Set a symbol's pip size, or clear it with `null`. A size that is not a positive number is refused. */
    set(symbol: string, size: number | null): boolean {
        const key = symbol.toUpperCase();
        if (size === null) {
            if (this.sizes.delete(key)) this.emit();
            return true;
        }
        if (!valid(size)) return false;
        if (this.sizes.get(key) === size) return true;
        this.sizes.set(key, size);
        this.emit();
        return true;
    }

    /** The pip size a trade's results use: its symbol's setting, else the tick size it was placed with. */
    pipOf(t: SimTrade): number {
        return this.get(t.symbol) ?? t.pip;
    }

    toJSON(): Record<string, number> {
        return Object.fromEntries(this.sizes);
    }

    /** Load saved sizes. They come from storage: entries that are not a positive number are skipped. */
    restore(payload: unknown): void {
        if (!payload || typeof payload !== 'object') return;
        const next = new Map<string, number>();
        for (const [symbol, size] of Object.entries(payload as Record<string, unknown>)) {
            if (valid(size)) next.set(symbol.toUpperCase(), size);
        }
        this.sizes = next;
        this.emit();
    }

    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private emit(): void {
        for (const cb of [...this.listeners]) cb();
    }
}
