// The two files the simulator exports. The backup restores everything (trades, orders that never
// filled, candles, screenshots, pip sizes) and is read back with the same guards the saved
// document uses. The dataset is one JSON object per line for a notebook or a training script.
// Pure functions: building, parsing, and validating text; nothing here touches the browser.
import { initialStop, isClosedTrade, isOrderRecord, plannedRR, resultR, riskOf, type SimOrderRecord, type SimTrade } from './sim-engine';
import { isWindow, splitWindow, type Candle } from './trade-window';

export const ARCHIVE_FORMAT = 'vela.tradingSim';
export const ARCHIVE_VERSION = 1;
export const DATASET_SCHEMA = 1;
export const MAX_IMAGE_CHARS = 3 * 1024 * 1024;

/** Every key of a trade and of an order record. The record types make a new key a compile error here,
 *  so adding one forces a decision on how the backup and the dataset carry it. */
const TRADE_KEYS: Record<keyof SimTrade, true> = {
    id: true, symbol: true, timeframe: true, side: true, entry: true, sl: true, tp: true, openTime: true, pip: true, mfe: true, mae: true,
    initialSl: true, trailPct: true, peak: true, placedAt: true, tags: true, note: true, closeTime: true, exit: true, outcome: true,
};
const ORDER_KEYS: Record<keyof SimOrderRecord, true> = {
    id: true, symbol: true, timeframe: true, side: true, entry: true, sl: true, tp: true, pip: true, trailPct: true,
    placedAt: true, endedAt: true, outcome: true, reason: true, tags: true, note: true,
};
export const TRADE_FIELDS = Object.keys(TRADE_KEYS) as Array<keyof SimTrade>;
export const ORDER_FIELDS = Object.keys(ORDER_KEYS) as Array<keyof SimOrderRecord>;

export interface ShotPair {
    open?: string;
    close?: string;
}

export interface Backup {
    format: typeof ARCHIVE_FORMAT;
    version: number;
    exportedAt: number;
    pipSizes: Record<string, number>;
    trades: SimTrade[];
    orders: SimOrderRecord[];
    windows: Record<string, Candle[]>;
    images: Record<string, ShotPair>;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const IMAGE_PREFIXES = ['data:image/webp;base64,', 'data:image/png;base64,', 'data:image/jpeg;base64,'];

/** A screenshot data URL of a kind the simulator writes, no larger than the limit. */
export function isImageUrl(v: unknown): v is string {
    return typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMAGE_PREFIXES.some((p) => v.startsWith(p));
}

export function buildBackup(input: {
    trades: readonly SimTrade[];
    orders: readonly SimOrderRecord[];
    pipSizes: Record<string, number>;
    windows: Record<string, Candle[]>;
    images: Record<string, ShotPair>;
    includeImages: boolean;
    now: number;
}): Backup {
    return {
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        exportedAt: input.now,
        pipSizes: { ...input.pipSizes },
        trades: input.trades.map((t) => ({ ...t })),
        orders: input.orders.map((o) => ({ ...o })),
        windows: { ...input.windows },
        images: input.includeImages ? { ...input.images } : {},
    };
}

export type ParsedBackup = { ok: true; backup: Backup; invalid: number; droppedMedia: number } | { ok: false; reason: 'json' | 'format' | 'version' };

/** Copy only the known keys, so an unknown key in a file never reaches the engine. */
function pick<T extends object>(source: T, keys: ReadonlyArray<keyof T>): T {
    const out: Partial<T> = {};
    for (const k of keys) if (source[k] !== undefined) out[k] = source[k];
    return out as T;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const usableId = (id: string): boolean => !FORBIDDEN_KEYS.has(id);

/** Read a backup file's text. Wrong files change nothing: the caller only merges an `ok` result. */
export function parseBackup(text: string): ParsedBackup {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'json' };
    }
    if (!isRecord(raw) || raw.format !== ARCHIVE_FORMAT) return { ok: false, reason: 'format' };
    if (typeof raw.version !== 'number' || raw.version > ARCHIVE_VERSION) return { ok: false, reason: 'version' };

    let invalid = 0;
    let droppedMedia = 0;
    const trades: SimTrade[] = [];
    for (const t of Array.isArray(raw.trades) ? raw.trades : []) {
        if (isClosedTrade(t) && usableId(t.id)) trades.push(pick(t, TRADE_FIELDS));
        else invalid += 1;
    }
    const orders: SimOrderRecord[] = [];
    for (const o of Array.isArray(raw.orders) ? raw.orders : []) {
        if (isOrderRecord(o) && usableId(o.id)) orders.push(pick(o, ORDER_FIELDS));
        else invalid += 1;
    }
    const known = new Set([...trades, ...orders].map((x) => x.id));

    const windows: Record<string, Candle[]> = {};
    if (isRecord(raw.windows)) {
        for (const [id, w] of Object.entries(raw.windows)) {
            if (FORBIDDEN_KEYS.has(id)) continue;
            if (known.has(id) && isWindow(w)) windows[id] = w.map((c) => [...c] as Candle);
            else droppedMedia += 1;
        }
    }
    const images: Record<string, ShotPair> = {};
    if (isRecord(raw.images)) {
        for (const [id, pair] of Object.entries(raw.images)) {
            if (FORBIDDEN_KEYS.has(id)) continue;
            const shots = isRecord(pair) ? pair : {};
            const kept: ShotPair = {};
            for (const kind of ['open', 'close'] as const) {
                if (shots[kind] === undefined) continue;
                const url = shots[kind];
                if (known.has(id) && isImageUrl(url)) kept[kind] = url;
                else droppedMedia += 1;
            }
            if (kept.open || kept.close) images[id] = kept;
        }
    }
    const pipSizes: Record<string, number> = {};
    if (isRecord(raw.pipSizes)) {
        for (const [symbol, pip] of Object.entries(raw.pipSizes)) {
            if (!FORBIDDEN_KEYS.has(symbol) && typeof pip === 'number' && Number.isFinite(pip) && pip > 0) pipSizes[symbol] = pip;
        }
    }
    const exportedAt = typeof raw.exportedAt === 'number' && Number.isFinite(raw.exportedAt) ? raw.exportedAt : 0;
    return { ok: true, backup: { format: ARCHIVE_FORMAT, version: raw.version, exportedAt, pipSizes, trades, orders, windows, images }, invalid, droppedMedia };
}

const windowOf = (windows: Record<string, Candle[]>, id: string): Candle[] | undefined => (Object.prototype.hasOwnProperty.call(windows, id) ? windows[id] : undefined);

/**
 * The dataset: one line per trade, then one per order that never filled. R values are measured against
 * the stop the trade started with. `context` ends at the placement bar and `trade` starts after it, so a
 * reader can build features from `context` without seeing anything the user could not have seen.
 */
export function buildDataset(input: { trades: readonly SimTrade[]; orders: readonly SimOrderRecord[]; windows: Record<string, Candle[]> }): string {
    const lines: string[] = [];
    for (const t of input.trades) {
        const w = windowOf(input.windows, t.id);
        const placed = t.placedAt ?? t.openTime;
        const { context, trade } = w ? splitWindow(w, placed) : { context: [], trade: [] };
        const risk = riskOf(t);
        lines.push(
            JSON.stringify({
                schema: DATASET_SCHEMA, id: t.id, symbol: t.symbol, timeframe: t.timeframe, side: t.side,
                entry: t.entry, initial_sl: initialStop(t), final_sl: t.sl, tp: t.tp, trail_pct: t.trailPct ?? null, pip: t.pip,
                placed_time: placed, open_time: t.openTime, close_time: t.closeTime ?? null,
                bars_held: w ? trade.filter((c) => c[0] > t.openTime && c[0] <= (t.closeTime ?? -Infinity)).length : null,
                planned_rr: plannedRR(t), outcome: t.outcome ?? null, result_r: resultR(t),
                mfe_r: risk > 0 ? t.mfe / risk : null, mae_r: risk > 0 ? t.mae / risk : null, stop_moved: t.sl !== initialStop(t),
                tags: t.tags ?? [], note: t.note ?? null, context, trade,
            }),
        );
    }
    for (const o of input.orders) {
        const w = windowOf(input.windows, o.id);
        const { context, trade } = w ? splitWindow(w, o.placedAt) : { context: [], trade: [] };
        lines.push(
            JSON.stringify({
                schema: DATASET_SCHEMA, id: o.id, symbol: o.symbol, timeframe: o.timeframe, side: o.side,
                entry: o.entry, initial_sl: o.sl, final_sl: o.sl, tp: o.tp, trail_pct: o.trailPct ?? null, pip: o.pip,
                placed_time: o.placedAt, open_time: null, close_time: o.endedAt, bars_held: null,
                planned_rr: plannedRR({ entry: o.entry, sl: o.sl, tp: o.tp }), outcome: o.outcome, result_r: null,
                mfe_r: null, mae_r: null, stop_moved: false, tags: o.tags ?? [], note: o.note ?? null, context, trade,
            }),
        );
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
}
