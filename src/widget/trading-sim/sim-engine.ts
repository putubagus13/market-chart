// The trading simulator's order book: market orders with a stop loss and a take profit,
// closed by the bars a replay reveals. Pure data — no DOM, no chart.

export type TradeSide = 'long' | 'short';
/** How a trade ended: its take profit, its stop loss, or the user. */
export type TradeOutcome = 'tp' | 'sl' | 'manual';

export interface SimTrade {
    id: string;
    symbol: string;
    timeframe: string;
    side: TradeSide;
    entry: number;
    sl: number;
    tp: number;
    /** Time of the bar the order was placed on; only bars opening after it can close it. */
    openTime: number;
    /** One pip in price units (the symbol's tick size). */
    pip: number;
    /** Furthest the price moved in the trade's favor, in price units (≥ 0). */
    mfe: number;
    /** Furthest the price moved against the trade, in price units (≥ 0). */
    mae: number;
    closeTime?: number;
    exit?: number;
    outcome?: TradeOutcome;
}

export interface BarLike {
    time: number;
    high: number;
    low: number;
    close: number;
}

export interface OpenOrder {
    symbol: string;
    timeframe: string;
    side: TradeSide;
    entry: number;
    sl: number;
    tp: number;
    openTime: number;
    pip: number;
}

const dir = (side: TradeSide): 1 | -1 => (side === 'long' ? 1 : -1);

/** Reward over risk the levels were planned with. */
export function plannedRR(t: Pick<SimTrade, 'entry' | 'sl' | 'tp'>): number {
    const risk = Math.abs(t.entry - t.sl);
    return risk > 0 ? Math.abs(t.tp - t.entry) / risk : 0;
}

/** Result of a closed trade in multiples of its risk (+2 = won twice the risk). */
export function resultR(t: SimTrade): number {
    const risk = Math.abs(t.entry - t.sl);
    if (t.exit === undefined || risk <= 0) return 0;
    return ((t.exit - t.entry) * dir(t.side)) / risk;
}

/** Result of a closed trade in pips of `pip` price units (the trade's own tick size by default). */
export function resultPips(t: SimTrade, pip?: number): number {
    const size = pip !== undefined && pip > 0 ? pip : t.pip;
    if (t.exit === undefined || !(size > 0)) return 0;
    return ((t.exit - t.entry) * dir(t.side)) / size;
}

/** Whether the levels sit on the right sides of the entry for the side. */
export function validLevels(o: Pick<OpenOrder, 'side' | 'entry' | 'sl' | 'tp'>): boolean {
    const d = dir(o.side);
    return (o.tp - o.entry) * d > 0 && (o.entry - o.sl) * d > 0;
}

export class SimulationEngine {
    private open: SimTrade[] = [];
    private closed: SimTrade[] = [];
    private seq = 0;
    private readonly listeners = new Set<() => void>();

    get openTrades(): readonly SimTrade[] {
        return this.open;
    }

    /** Closed trades, oldest first. */
    get history(): readonly SimTrade[] {
        return this.closed;
    }

    /** Open a market order. Returns the trade, or null when the levels are on the wrong side. */
    place(order: OpenOrder): SimTrade | null {
        if (!validLevels(order)) return null;
        this.seq += 1;
        const trade: SimTrade = { ...order, id: `t${Date.now().toString(36)}-${this.seq}`, mfe: 0, mae: 0 };
        this.open = [...this.open, trade];
        this.emit();
        return trade;
    }

    /**
     * Run one revealed bar of `symbol`/`timeframe` through the open trades. A bar that reaches
     * both levels closes at the stop: a bar does not say which came first, and assuming the
     * worse one keeps the statistics honest. Returns the trades it closed.
     */
    onBar(symbol: string, timeframe: string, bar: BarLike): SimTrade[] {
        const done: SimTrade[] = [];
        let touched = false;
        this.open = this.open.map((t) => {
            if (t.symbol !== symbol || t.timeframe !== timeframe || bar.time <= t.openTime) return t;
            touched = true;
            const d = dir(t.side);
            const favorable = Math.max(0, ((t.side === 'long' ? bar.high : bar.low) - t.entry) * d);
            const adverse = Math.max(0, (t.entry - (t.side === 'long' ? bar.low : bar.high)) * d);
            const slHit = t.side === 'long' ? bar.low <= t.sl : bar.high >= t.sl;
            const tpHit = t.side === 'long' ? bar.high >= t.tp : bar.low <= t.tp;
            if (slHit) {
                // The bar's favorable extreme may have come after the stop: it does not count.
                const c: SimTrade = { ...t, mae: Math.max(t.mae, Math.abs(t.entry - t.sl)), closeTime: bar.time, exit: t.sl, outcome: 'sl' };
                done.push(c);
                return c;
            }
            if (tpHit) {
                const c: SimTrade = { ...t, mfe: Math.max(t.mfe, Math.abs(t.tp - t.entry)), mae: Math.max(t.mae, adverse), closeTime: bar.time, exit: t.tp, outcome: 'tp' };
                done.push(c);
                return c;
            }
            return { ...t, mfe: Math.max(t.mfe, favorable), mae: Math.max(t.mae, adverse) };
        });
        if (done.length) {
            const ids = new Set(done.map((t) => t.id));
            this.open = this.open.filter((t) => !ids.has(t.id));
            this.closed = [...this.closed, ...done];
        }
        if (touched) this.emit();
        return done;
    }

    /** Close an open trade at `price` (the user's market exit). */
    close(id: string, price: number, time: number): SimTrade | null {
        const t = this.open.find((o) => o.id === id);
        if (!t) return null;
        const c: SimTrade = { ...t, closeTime: time, exit: price, outcome: 'manual' };
        this.open = this.open.filter((o) => o.id !== id);
        this.closed = [...this.closed, c];
        this.emit();
        return c;
    }

    /** Drop every open trade without recording it (the replay they lived in ended or moved). */
    cancelOpen(): SimTrade[] {
        const dropped = this.open;
        if (dropped.length === 0) return [];
        this.open = [];
        this.emit();
        return dropped;
    }

    removeFromHistory(id: string): void {
        const next = this.closed.filter((t) => t.id !== id);
        if (next.length === this.closed.length) return;
        this.closed = next;
        this.emit();
    }

    clearHistory(): void {
        if (this.closed.length === 0) return;
        this.closed = [];
        this.emit();
    }

    /** Replace the history with saved trades (untrusted: malformed entries are skipped). */
    restoreHistory(payload: unknown): void {
        const raw = (payload as { trades?: unknown } | null)?.trades;
        if (!Array.isArray(raw)) return;
        this.closed = raw.filter(isClosedTrade).map((t) => ({ ...t }));
        this.emit();
    }

    toJSON(): { trades: SimTrade[] } {
        return { trades: this.closed.map((t) => ({ ...t })) };
    }

    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private emit(): void {
        for (const cb of [...this.listeners]) cb();
    }
}

function isClosedTrade(v: unknown): v is SimTrade {
    const t = v as Partial<SimTrade> | null;
    const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
    return (
        !!t &&
        typeof t.id === 'string' &&
        typeof t.symbol === 'string' &&
        typeof t.timeframe === 'string' &&
        (t.side === 'long' || t.side === 'short') &&
        num(t.entry) && num(t.sl) && num(t.tp) && num(t.openTime) && num(t.pip) && num(t.mfe) && num(t.mae) &&
        num(t.closeTime) && num(t.exit) &&
        (t.outcome === 'tp' || t.outcome === 'sl' || t.outcome === 'manual')
    );
}
