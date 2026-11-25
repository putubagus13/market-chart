// The trading simulator's order book: market orders with a stop loss and a take profit,
// closed by the bars a replay reveals. Pure data — no DOM, no chart.
import { MAX_NOTE_LENGTH, isTags } from './trade-labels';

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
    /** The stop the trade was placed with; `sl` moves when the user tightens it or a trail follows the price. */
    initialSl?: number;
    /** Percent of price the stop trails the best price by; absent when trailing is off. */
    trailPct?: number;
    /** Best price since the fill: the highest high for a long, the lowest low for a short. */
    peak?: number;
    /** Time of the bar the order was placed on; a limit order that fills later has a later `openTime`. */
    placedAt?: number;
    /** The user's setup labels and note. */
    tags?: string[];
    note?: string;
    closeTime?: number;
    exit?: number;
    outcome?: TradeOutcome;
}

/** An order that never became a trade: the user cancelled it, or the replay ended before its price came. */
export type OrderEnd = 'cancelled' | 'unfilled';
export type OrderEndReason = 'user' | 'replay';

export interface SimOrderRecord {
    id: string;
    symbol: string;
    timeframe: string;
    side: TradeSide;
    entry: number;
    sl: number;
    tp: number;
    pip: number;
    trailPct?: number;
    placedAt: number;
    endedAt: number;
    outcome: OrderEnd;
    reason: OrderEndReason;
    tags?: string[];
    note?: string;
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
    trailPct?: number;
    tags?: string[];
    note?: string;
}

/** The stop a trade was placed with (saved trades from before stops moved have only `sl`). */
export function initialStop(t: Pick<SimTrade, 'sl' | 'initialSl'>): number {
    return t.initialSl ?? t.sl;
}

/** The price distance risked at the start: results in R are measured against it. */
export function riskOf(t: Pick<SimTrade, 'entry' | 'sl' | 'initialSl'>): number {
    return Math.abs(t.entry - initialStop(t));
}

/** How a request to move a stop ended. Only `'moved'` changed the trade. */
export type StopMove = 'moved' | 'unchanged' | 'loosens' | 'past-price' | 'unknown';

/**
 * The stop after trailing: `peak` less (more, for a short) `trailPct` percent. It applies only
 * when it is tighter than `sl` and still strictly beyond `close`, so a trail never loosens a
 * stop and never moves it onto the price.
 */
export function trailedStop(t: Pick<SimTrade, 'side' | 'sl' | 'peak' | 'trailPct'>, close: number): number {
    if (t.trailPct === undefined || t.peak === undefined) return t.sl;
    const gap = (t.peak * t.trailPct) / 100;
    if (t.side === 'long') {
        const candidate = t.peak - gap;
        return candidate > t.sl && candidate < close ? candidate : t.sl;
    }
    const candidate = t.peak + gap;
    return candidate < t.sl && candidate > close ? candidate : t.sl;
}

/** An order waiting for its price (its `openTime` is the bar it was placed on). */
export type PendingKind = 'limit' | 'stop';
export type PendingOrder = OpenOrder & { id: string; kind: PendingKind };

/** A buy below the price (or a sell above it) is a limit order; the other side waits for a breakout: a stop order. */
export function pendingKind(side: TradeSide, entry: number, price: number): PendingKind {
    return (side === 'long' ? entry < price : entry > price) ? 'limit' : 'stop';
}

const dir = (side: TradeSide): 1 | -1 => (side === 'long' ? 1 : -1);

/** Reward over risk the levels were planned with. */
export function plannedRR(t: Pick<SimTrade, 'entry' | 'sl' | 'initialSl' | 'tp'>): number {
    const risk = riskOf(t);
    return risk > 0 ? Math.abs(t.tp - t.entry) / risk : 0;
}

/** Result of a closed trade in multiples of its risk (+2 = won twice the risk). */
export function resultR(t: SimTrade): number {
    const risk = riskOf(t);
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

/** Whether the bar reaches the trade's stop. */
function stopReached(t: SimTrade, bar: BarLike): boolean {
    return t.side === 'long' ? bar.low <= t.sl : bar.high >= t.sl;
}

/** The trade closed at its stop by `bar`. The bar's favorable extreme may have come after the stop, so it
 *  does not count; a stop tightened into profit risks nothing against the entry. */
function stopped(t: SimTrade, bar: BarLike): SimTrade {
    return { ...t, mae: Math.max(t.mae, Math.max(0, (t.entry - t.sl) * dir(t.side))), closeTime: bar.time, exit: t.sl, outcome: 'sl' };
}

export class SimulationEngine {
    private open: SimTrade[] = [];
    private pending: PendingOrder[] = [];
    private closed: SimTrade[] = [];
    private log: SimOrderRecord[] = [];
    private readonly removeListeners = new Set<(ids: string[]) => void>();
    private readonly fillListeners = new Set<(trade: SimTrade) => void>();
    private seq = 0;
    private readonly listeners = new Set<() => void>();

    get openTrades(): readonly SimTrade[] {
        return this.open;
    }

    /** Orders waiting for their price, oldest first. Not saved with the document. */
    get pendingOrders(): readonly PendingOrder[] {
        return this.pending;
    }

    /** Closed trades, oldest first. */
    get history(): readonly SimTrade[] {
        return this.closed;
    }

    /** Orders that never became trades, oldest first. Kept apart from `history`: no statistic reads them. */
    get orderLog(): readonly SimOrderRecord[] {
        return this.log;
    }

    /** Open a market order. Returns the trade, or null when the levels are on the wrong side. */
    place(order: OpenOrder): SimTrade | null {
        if (!validLevels(order)) return null;
        this.seq += 1;
        const { trailPct, ...levels } = order;
        const trade: SimTrade = { ...levels, id: `t${Date.now().toString(36)}-${this.seq}`, mfe: 0, mae: 0, initialSl: order.sl, peak: order.entry, placedAt: order.openTime, ...(trailPct !== undefined ? { trailPct } : {}) };
        this.open = [...this.open, trade];
        this.emit();
        return trade;
    }

    /**
     * Run one revealed bar of `symbol`/`timeframe` through the pending orders, then the open
     * trades. A bar that reaches both levels closes at the stop: a bar does not say which came
     * first, and assuming the worse one keeps the statistics honest. Returns the trades it closed.
     */
    onBar(symbol: string, timeframe: string, bar: BarLike): SimTrade[] {
        const done: SimTrade[] = [];
        let touched = false;
        // A pending order fills at its price when a later bar reaches it. The bar that fills it can
        // close it only at its stop: it does not say whether the fill or the target came first.
        const filled: SimTrade[] = [];
        const waiting = this.pending.filter((p) => {
            if (p.symbol !== symbol || p.timeframe !== timeframe || bar.time <= p.openTime) return true;
            // The order waits on the far side of its price (a buy limit and a sell stop wait for a fall, a
            // buy stop and a sell limit for a rise) and fills when a bar reaches it, or gaps past it.
            const waitsForFall = (p.side === 'long') === (p.kind === 'limit');
            if (waitsForFall ? bar.low > p.entry : bar.high < p.entry) return true;
            const { trailPct, kind: _kind, ...levels } = p;
            filled.push({ ...levels, openTime: bar.time, mfe: 0, mae: 0, initialSl: p.sl, peak: p.entry, placedAt: p.openTime, ...(trailPct !== undefined ? { trailPct } : {}) });
            return false;
        });
        if (filled.length) {
            touched = true;
            this.pending = waiting;
            for (const t of filled) {
                for (const cb of [...this.fillListeners]) cb(t);
                if (stopReached(t, bar)) done.push(stopped(t, bar));
                else this.open = [...this.open, t];
            }
        }
        this.open = this.open.map((t) => {
            if (t.symbol !== symbol || t.timeframe !== timeframe || bar.time <= t.openTime) return t;
            touched = true;
            const d = dir(t.side);
            const favorable = Math.max(0, ((t.side === 'long' ? bar.high : bar.low) - t.entry) * d);
            const adverse = Math.max(0, (t.entry - (t.side === 'long' ? bar.low : bar.high)) * d);
            const tpHit = t.side === 'long' ? bar.high >= t.tp : bar.low <= t.tp;
            if (stopReached(t, bar)) {
                const c = stopped(t, bar);
                done.push(c);
                return c;
            }
            if (tpHit) {
                const c: SimTrade = { ...t, mfe: Math.max(t.mfe, Math.abs(t.tp - t.entry)), mae: Math.max(t.mae, adverse), closeTime: bar.time, exit: t.tp, outcome: 'tp' };
                done.push(c);
                return c;
            }
            // The trail reads the extremes of bars already processed, this one included only from
            // the next bar on: the stop tested above is the one that stood before this bar.
            const best = t.peak ?? t.entry;
            const peak = t.side === 'long' ? Math.max(best, bar.high) : Math.min(best, bar.low);
            const sl = trailedStop({ ...t, peak }, bar.close);
            return { ...t, peak, sl, mfe: Math.max(t.mfe, favorable), mae: Math.max(t.mae, adverse) };
        });
        if (done.length) {
            const ids = new Set(done.map((t) => t.id));
            this.open = this.open.filter((t) => !ids.has(t.id));
            this.closed = [...this.closed, ...done];
        }
        if (touched) this.emit();
        return done;
    }

    /**
     * Wait for a price: open a trade when a later bar reaches `order.entry`. `reference` is the price
     * the order is placed against (the last close): it fixes whether the order is a limit or a stop.
     * Null when the levels are on the wrong side.
     */
    placePending(order: OpenOrder, reference: number): PendingOrder | null {
        if (!validLevels(order)) return null;
        this.seq += 1;
        const pending: PendingOrder = { ...order, id: `t${Date.now().toString(36)}-${this.seq}`, kind: pendingKind(order.side, order.entry, reference) };
        this.pending = [...this.pending, pending];
        this.emit();
        return pending;
    }

    /** Cancel a waiting order and log it (`time` is the replay's current bar). */
    cancelPending(id: string, time: number): boolean {
        const order = this.pending.find((p) => p.id === id);
        if (!order) return false;
        this.pending = this.pending.filter((p) => p.id !== id);
        this.log = [...this.log, recordOf(order, 'cancelled', 'user', time)];
        this.emit();
        return true;
    }

    /** Drop every pending order (the replay they waited in ended or moved) and log them. Returns the dropped ones. */
    cancelAllPending(time: number): PendingOrder[] {
        const dropped = this.pending;
        if (dropped.length === 0) return [];
        this.pending = [];
        this.log = [...this.log, ...dropped.map((p) => recordOf(p, 'unfilled', 'replay', time))];
        this.emit();
        return dropped;
    }

    /** Called with each pending order as it fills, before `onBar` returns. */
    onFill(cb: (trade: SimTrade) => void): () => void {
        this.fillListeners.add(cb);
        return () => this.fillListeners.delete(cb);
    }

    /**
     * Move an open trade's stop. It may only tighten (closer to the price) and must stay beyond
     * `lastClose`, or it would close the trade at once.
     */
    moveStop(id: string, sl: number, lastClose: number): StopMove {
        const t = this.open.find((o) => o.id === id);
        if (!t || !Number.isFinite(sl)) return 'unknown';
        if (sl === t.sl) return 'unchanged';
        const long = t.side === 'long';
        if (long ? sl < t.sl : sl > t.sl) return 'loosens';
        if (long ? sl >= lastClose : sl <= lastClose) return 'past-price';
        this.open = this.open.map((o) => (o.id === id ? { ...o, sl } : o));
        this.emit();
        return 'moved';
    }

    /** Turn trailing on at `pct` percent of price (above 0, below 100), or off with null. */
    setTrail(id: string, pct: number | null): boolean {
        const t = this.open.find((o) => o.id === id);
        if (!t) return false;
        if (pct !== null && !(Number.isFinite(pct) && pct > 0 && pct < 100)) return false;
        this.open = this.open.map((o) => {
            if (o.id !== id) return o;
            const { trailPct: _drop, ...rest } = o;
            return pct === null ? rest : { ...rest, trailPct: pct };
        });
        this.emit();
        return true;
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
        this.announceRemoved([id]);
        this.emit();
    }

    removeOrderRecord(id: string): void {
        const next = this.log.filter((r) => r.id !== id);
        if (next.length === this.log.length) return;
        this.log = next;
        this.announceRemoved([id]);
        this.emit();
    }

    /** Empty the history and the order log. */
    clearHistory(): void {
        if (this.closed.length === 0 && this.log.length === 0) return;
        const ids = [...this.closed, ...this.log].map((x) => x.id);
        this.closed = [];
        this.log = [];
        this.announceRemoved(ids);
        this.emit();
    }

    /** Called with the ids that leave the history or the order log, so stored candles and images can follow. */
    onRemove(cb: (ids: string[]) => void): () => void {
        this.removeListeners.add(cb);
        return () => this.removeListeners.delete(cb);
    }

    /** Set or clear the tags and note of any trade or order the engine holds. */
    setLabels(id: string, labels: { tags?: string[]; note?: string }): boolean {
        const apply = <T extends { id: string; tags?: string[]; note?: string }>(list: readonly T[]): T[] | null => {
            if (!list.some((x) => x.id === id)) return null;
            return list.map((x) => {
                if (x.id !== id) return x;
                const { tags: _t, note: _n, ...rest } = x;
                return { ...rest, ...(labels.tags?.length ? { tags: labels.tags } : {}), ...(labels.note ? { note: labels.note } : {}) } as T;
            });
        };
        const open = apply(this.open);
        if (open) this.open = open;
        const pending = apply(this.pending);
        if (pending) this.pending = pending;
        const closed = apply(this.closed);
        if (closed) this.closed = closed;
        const log = apply(this.log);
        if (log) this.log = log;
        if (!(open || pending || closed || log)) return false;
        this.emit();
        return true;
    }

    /**
     * Merge saved trades and order records into the history. An id the engine already holds is skipped,
     * never overwritten. Callers pass records that already passed `isClosedTrade` / `isOrderRecord`.
     */
    importRecords(data: { trades: readonly SimTrade[]; orders: readonly SimOrderRecord[] }): { addedTrades: number; addedOrders: number; present: number } {
        const held = new Set([...this.closed, ...this.log, ...this.open, ...this.pending].map((x) => x.id));
        let present = 0;
        const fresh = <T extends { id: string }>(list: readonly T[]): T[] =>
            list.filter((x) => {
                if (held.has(x.id)) {
                    present += 1;
                    return false;
                }
                held.add(x.id);
                return true;
            });
        const trades = fresh(data.trades);
        const orders = fresh(data.orders);
        if (trades.length) this.closed = [...this.closed, ...trades.map((t) => ({ ...t }))].sort((a, b) => (a.closeTime ?? 0) - (b.closeTime ?? 0));
        if (orders.length) this.log = [...this.log, ...orders.map((r) => ({ ...r }))];
        if (trades.length || orders.length) this.emit();
        return { addedTrades: trades.length, addedOrders: orders.length, present };
    }

    /** Replace the history with saved trades (untrusted: malformed entries are skipped). */
    restoreHistory(payload: unknown): void {
        const saved = payload as { trades?: unknown; orders?: unknown } | null;
        if (!Array.isArray(saved?.trades)) return;
        this.closed = saved.trades.filter(isClosedTrade).map((t) => ({ ...t }));
        this.log = Array.isArray(saved.orders) ? saved.orders.filter(isOrderRecord).map((r) => ({ ...r })) : [];
        this.emit();
    }

    toJSON(): { trades: SimTrade[]; orders: SimOrderRecord[] } {
        return { trades: this.closed.map((t) => ({ ...t })), orders: this.log.map((r) => ({ ...r })) };
    }

    private announceRemoved(ids: string[]): void {
        for (const cb of [...this.removeListeners]) cb(ids);
    }

    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private emit(): void {
        for (const cb of [...this.listeners]) cb();
    }
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const validNote = (x: unknown): boolean => x === undefined || (typeof x === 'string' && x.length <= MAX_NOTE_LENGTH);

/** The order as the log keeps it once it ends without filling. */
function recordOf(order: PendingOrder, outcome: OrderEnd, reason: OrderEndReason, endedAt: number): SimOrderRecord {
    const { id, symbol, timeframe, side, entry, sl, tp, pip, trailPct, tags, note } = order;
    return { id, symbol, timeframe, side, entry, sl, tp, pip, placedAt: order.openTime, endedAt, outcome, reason, ...(trailPct !== undefined ? { trailPct } : {}), ...(tags ? { tags } : {}), ...(note ? { note } : {}) };
}

/** Whether `v` has the shape of a saved closed trade (untrusted input: files and storage). */
export function isClosedTrade(v: unknown): v is SimTrade {
    const t = v as Partial<SimTrade> | null;
    return (
        !!t &&
        typeof t.id === 'string' &&
        typeof t.symbol === 'string' &&
        typeof t.timeframe === 'string' &&
        (t.side === 'long' || t.side === 'short') &&
        finite(t.entry) && finite(t.sl) && finite(t.tp) && finite(t.openTime) && finite(t.pip) && finite(t.mfe) && finite(t.mae) &&
        finite(t.closeTime) && finite(t.exit) &&
        (t.initialSl === undefined || finite(t.initialSl)) &&
        (t.peak === undefined || finite(t.peak)) &&
        (t.placedAt === undefined || finite(t.placedAt)) &&
        (t.trailPct === undefined || (finite(t.trailPct) && t.trailPct > 0)) &&
        (t.tags === undefined || isTags(t.tags)) &&
        validNote(t.note) &&
        (t.outcome === 'tp' || t.outcome === 'sl' || t.outcome === 'manual')
    );
}

/** Whether `v` has the shape of a saved order record. */
export function isOrderRecord(v: unknown): v is SimOrderRecord {
    const r = v as Partial<SimOrderRecord> | null;
    return (
        !!r &&
        typeof r.id === 'string' &&
        typeof r.symbol === 'string' &&
        typeof r.timeframe === 'string' &&
        (r.side === 'long' || r.side === 'short') &&
        finite(r.entry) && finite(r.sl) && finite(r.tp) && finite(r.pip) && finite(r.placedAt) && finite(r.endedAt) &&
        (r.trailPct === undefined || (finite(r.trailPct) && r.trailPct > 0)) &&
        (r.outcome === 'cancelled' || r.outcome === 'unfilled') &&
        (r.reason === 'user' || r.reason === 'replay') &&
        (r.tags === undefined || isTags(r.tags)) &&
        validNote(r.note)
    );
}
