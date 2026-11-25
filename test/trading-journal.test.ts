// The trade journal's pure pieces: labels, candle windows, the backup and dataset files, and
// the evidence store.
import { describe, it, expect } from 'vitest';
import { parseTags, formatTags, cleanNote, isTags, MAX_TAGS, MAX_TAG_LENGTH, MAX_NOTE_LENGTH } from '../src/widget/trading-sim/trade-labels';

describe('trade labels', () => {
    it('parses tags: trims, drops empties and duplicates', () => {
        expect(parseTags(' breakout, pullback ,breakout,, ')).toEqual(['breakout', 'pullback']);
        expect(parseTags('')).toEqual([]);
    });

    it('caps the count and the length of tags', () => {
        const many = Array.from({ length: 12 }, (_, i) => `t${i}`).join(',');
        expect(parseTags(many)).toHaveLength(MAX_TAGS);
        expect(parseTags('x'.repeat(40))[0]).toHaveLength(MAX_TAG_LENGTH);
    });

    it('formats tags back into the field text', () => {
        expect(formatTags(['a', 'b'])).toBe('a, b');
        expect(formatTags(undefined)).toBe('');
    });

    it('cleans a note: empty becomes undefined, long text is cut', () => {
        expect(cleanNote('   ')).toBeUndefined();
        expect(cleanNote('  why  ')).toBe('why');
        expect(cleanNote('n'.repeat(600))).toHaveLength(MAX_NOTE_LENGTH);
    });

    it('isTags accepts only a short array of short strings', () => {
        expect(isTags(['a', 'b'])).toBe(true);
        expect(isTags(['a', 1])).toBe(false);
        expect(isTags(Array.from({ length: MAX_TAGS + 1 }, () => 'a'))).toBe(false);
        expect(isTags(['x'.repeat(MAX_TAG_LENGTH + 1)])).toBe(false);
        expect(isTags('a')).toBe(false);
    });
});

import { LOOKBACK_BARS, MAX_WINDOW_CANDLES, toCandle, contextWindow, appendCandle, splitWindow, isWindow, type Candle } from '../src/widget/trading-sim/trade-window';

const ohlc = (time: number) => ({ time, open: 10, high: 12, low: 9, close: 11, volume: 5 });
const candle = (time: number): Candle => [time, 10, 12, 9, 11, 5];

describe('candle windows', () => {
    it('keeps the last 200 candles up to the placement bar and nothing later', () => {
        const bars = Array.from({ length: 300 }, (_, i) => ohlc(i + 1));
        const w = contextWindow(bars, 250);
        expect(w).toHaveLength(LOOKBACK_BARS);
        expect(w[0]![0]).toBe(51);
        expect(w[w.length - 1]![0]).toBe(250);
    });

    it('returns what exists when fewer candles are available, and collapses repeated times', () => {
        expect(contextWindow([ohlc(1), ohlc(2), ohlc(2), ohlc(3)], 3).map((c) => c[0])).toEqual([1, 2, 3]);
    });

    it('appends in time order: same time replaces, older is ignored, the cap drops the oldest', () => {
        const w = [candle(1), candle(2)];
        expect(appendCandle(w, [2, 1, 1, 1, 1, 1])[1]).toEqual([2, 1, 1, 1, 1, 1]);
        expect(appendCandle(w, candle(1))).toEqual(w);
        expect(appendCandle(w, candle(3)).map((c) => c[0])).toEqual([1, 2, 3]);
        const full = Array.from({ length: MAX_WINDOW_CANDLES }, (_, i) => candle(i + 1));
        const next = appendCandle(full, candle(MAX_WINDOW_CANDLES + 1));
        expect(next).toHaveLength(MAX_WINDOW_CANDLES);
        expect(next[0]![0]).toBe(2);
    });

    it('splits at the placement bar, which belongs to the context', () => {
        const { context, trade } = splitWindow([candle(1), candle(2), candle(3)], 2);
        expect(context.map((c) => c[0])).toEqual([1, 2]);
        expect(trade.map((c) => c[0])).toEqual([3]);
    });

    it('validates a saved window', () => {
        expect(isWindow([candle(1), candle(2)])).toBe(true);
        expect(isWindow([[1, 2, 3, 4, 5, NaN]])).toBe(false);
        expect(isWindow([[1, 2, 3, 4, 5, Infinity]])).toBe(false);
        expect(isWindow([[1, 2, 3, 4, 5]])).toBe(false);
        expect(isWindow([candle(2), candle(1)])).toBe(false);
        expect(isWindow(Array.from({ length: MAX_WINDOW_CANDLES + 1 }, (_, i) => candle(i + 1)))).toBe(false);
        expect(isWindow('x')).toBe(false);
    });

    it('saves volume 0 when the provider has none', () => {
        expect(toCandle({ time: 1, open: 1, high: 2, low: 0, close: 1 })[5]).toBe(0);
    });
});

import type { SimTrade, SimOrderRecord } from '../src/widget/trading-sim/sim-engine';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, DATASET_SCHEMA, MAX_IMAGE_CHARS, TRADE_FIELDS, ORDER_FIELDS, isImageUrl, buildBackup, parseBackup, buildDataset } from '../src/widget/trading-sim/trade-archive';

const trade = (over: Partial<SimTrade> = {}): SimTrade => ({
    id: 'a', symbol: 'BTC', timeframe: '60', side: 'long', entry: 100, sl: 95, tp: 120, openTime: 12, pip: 1, mfe: 20, mae: 5,
    initialSl: 90, trailPct: 1, peak: 121, placedAt: 10, tags: ['x'], note: 'n', closeTime: 15, exit: 95, outcome: 'sl', ...over,
});
const order = (over: Partial<SimOrderRecord> = {}): SimOrderRecord => ({
    id: 'o', symbol: 'BTC', timeframe: '60', side: 'short', entry: 100, sl: 110, tp: 80, pip: 1, trailPct: 2,
    placedAt: 10, endedAt: 14, outcome: 'cancelled', reason: 'user', tags: ['y'], note: 'm', ...over,
});
const lastTime = (w: Candle[]): number => w[w.length - 1]![0];
const win = (from: number, to: number): Candle[] => Array.from({ length: to - from + 1 }, (_, i) => candle(from + i));
const PNG = 'data:image/png;base64,AAAA';
const WEBP = 'data:image/webp;base64,BBBB';

function fullInput() {
    const trades = [trade(), trade({ id: 'b', tags: undefined, note: undefined, initialSl: undefined, trailPct: undefined, peak: undefined, placedAt: undefined, closeTime: 20, exit: 120, outcome: 'tp' }), trade({ id: 'c', closeTime: 30, exit: 101, outcome: 'manual' })];
    for (const t of trades) for (const k of Object.keys(t) as Array<keyof SimTrade>) if (t[k] === undefined) delete t[k];
    return {
        trades, orders: [order(), order({ id: 'p', outcome: 'unfilled', reason: 'replay' })],
        pipSizes: { BTC: 0.5 }, windows: { a: win(1, 20), o: win(1, 14) } as Record<string, Candle[]>,
        images: { a: { open: PNG, close: WEBP } } as Record<string, { open?: string; close?: string }>, includeImages: true, now: 1_000,
    };
}

describe('backup file', () => {
    it('round-trips every field', () => {
        const input = fullInput();
        const parsed = parseBackup(JSON.stringify(buildBackup(input)));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.backup.format).toBe(ARCHIVE_FORMAT);
        expect(parsed.backup.version).toBe(ARCHIVE_VERSION);
        expect(parsed.backup.exportedAt).toBe(1_000);
        expect(parsed.backup.trades).toEqual(input.trades);
        expect(parsed.backup.orders).toEqual(input.orders);
        expect(parsed.backup.windows).toEqual(input.windows);
        expect(parsed.backup.images).toEqual(input.images);
        expect(parsed.backup.pipSizes).toEqual(input.pipSizes);
        expect(parsed.invalid).toBe(0);
        expect(parsed.droppedMedia).toBe(0);
    });

    it('leaves the images out when asked', () => {
        expect(buildBackup({ ...fullInput(), includeImages: false }).images).toEqual({});
    });

    it('lists every field of a trade and an order, so a new field forces an export decision', () => {
        // Adding a key to SimTrade or SimOrderRecord fails the typecheck of TRADE_FIELDS / ORDER_FIELDS in
        // trade-archive.ts; add it there, then decide how the dataset exports it.
        expect([...TRADE_FIELDS].sort()).toEqual(Object.keys(trade()).sort());
        expect([...ORDER_FIELDS].sort()).toEqual(Object.keys(order()).sort());
    });

    it('refuses a file it cannot read', () => {
        expect(parseBackup('not json')).toEqual({ ok: false, reason: 'json' });
        expect(parseBackup(JSON.stringify({ format: 'other', version: 1 }))).toEqual({ ok: false, reason: 'format' });
        expect(parseBackup('[]')).toEqual({ ok: false, reason: 'format' });
        expect(parseBackup(JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION + 1 }))).toEqual({ ok: false, reason: 'version' });
    });

    it('drops damaged entries and counts them', () => {
        const good = buildBackup(fullInput());
        const damaged = {
            ...good,
            trades: [...good.trades, { ...trade({ id: 'n' }), entry: null }, 5, { ...trade({ id: 'q' }), outcome: 'weird' }],
            orders: [...good.orders, { ...order({ id: 'r' }), outcome: undefined }],
            windows: { ...good.windows, b: [candle(3), candle(2)] },
            images: { ...good.images, b: { open: 'data:text/html;base64,AAAA' }, c: { open: 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_CHARS) }, ghost: { open: PNG } },
        };
        const parsed = parseBackup(JSON.stringify(damaged));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.invalid).toBe(4);
        expect(parsed.droppedMedia).toBe(4);
        expect(parsed.backup.trades).toHaveLength(3);
        expect(parsed.backup.orders).toHaveLength(2);
        expect(Object.keys(parsed.backup.windows)).toEqual(['a', 'o']);
        expect(Object.keys(parsed.backup.images)).toEqual(['a']);
    });

    it('ignores prototype keys and keeps only usable pip sizes', () => {
        const good = buildBackup(fullInput());
        const text = JSON.stringify({ ...good, windows: { ...good.windows, ['__proto__']: win(1, 2) }, images: { ...good.images, ['__proto__']: { open: PNG } }, pipSizes: { BTC: 0, ETH: -1, SOL: 0.5, ['__proto__']: 3 } });
        const parsed = parseBackup(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(Object.keys(parsed.backup.windows)).toEqual(['a', 'o']);
        expect(Object.keys(parsed.backup.images)).toEqual(['a']);
        expect(parsed.backup.pipSizes).toEqual({ SOL: 0.5 });
        expect(({} as Record<string, unknown>).open).toBeUndefined();
        expect(Object.getPrototypeOf(parsed.backup.windows)).toBe(Object.prototype);
    });

    it('does not trust extra keys on a trade', () => {
        const good = buildBackup(fullInput());
        const parsed = parseBackup(JSON.stringify({ ...good, trades: [{ ...good.trades[0]!, extra: 'x' }] }));
        expect(parsed.ok && parsed.backup.trades[0]).not.toHaveProperty('extra');
    });

    it('accepts only small image data URLs', () => {
        expect(isImageUrl(PNG)).toBe(true);
        expect(isImageUrl(WEBP)).toBe(true);
        expect(isImageUrl('data:image/jpeg;base64,CCCC')).toBe(true);
        expect(isImageUrl('data:image/svg+xml;base64,CCCC')).toBe(false);
        expect(isImageUrl('https://x/y.png')).toBe(false);
        expect(isImageUrl(5)).toBe(false);
    });
});

describe('dataset file', () => {
    const lines = (text: string): Array<Record<string, unknown>> => text.trimEnd().split('\n').map((l) => JSON.parse(l));

    it('writes one line per trade with the plan, the result, and the candles', () => {
        const text = buildDataset({ trades: [trade()], orders: [], windows: { a: win(1, 20) } });
        expect(text.endsWith('\n')).toBe(true);
        const [row] = lines(text);
        expect(row).toEqual(expect.objectContaining({
            schema: DATASET_SCHEMA, id: 'a', symbol: 'BTC', timeframe: '60', side: 'long', entry: 100, initial_sl: 90, final_sl: 95, tp: 120,
            trail_pct: 1, pip: 1, placed_time: 10, open_time: 12, close_time: 15, bars_held: 3, planned_rr: 2, outcome: 'sl', result_r: -0.5,
            mfe_r: 2, mae_r: 0.5, stop_moved: true, tags: ['x'], note: 'n',
        }));
        const context = row!.context as number[][];
        const traded = row!.trade as number[][];
        expect(context[context.length - 1]![0]).toBe(10);
        expect(traded[0]![0]).toBe(11);
        expect(Math.max(...context.map((c) => c[0]!))).toBeLessThan(Math.min(...traded.map((c) => c[0]!)));
    });

    it('writes empty candles and null counts for a trade saved without a window', () => {
        const [row] = lines(buildDataset({ trades: [trade({ tags: undefined, note: undefined, trailPct: undefined })], orders: [], windows: {} }));
        expect(row).toEqual(expect.objectContaining({ context: [], trade: [], bars_held: null, tags: [], note: null, trail_pct: null }));
    });

    it('writes orders that never filled with empty results', () => {
        const [row] = lines(buildDataset({ trades: [], orders: [order()], windows: { o: win(1, 14) } }));
        expect(row).toEqual(expect.objectContaining({ id: 'o', outcome: 'cancelled', open_time: null, close_time: 14, placed_time: 10, result_r: null, mfe_r: null, mae_r: null, bars_held: null, stop_moved: false, planned_rr: 2 }));
        expect((row!.context as number[][]).length).toBe(10);
        expect((row!.trade as number[][]).length).toBe(4);
    });

    it('writes trades first, then orders, one line each', () => {
        const text = buildDataset({ trades: [trade(), trade({ id: 'b' })], orders: [order()], windows: {} });
        expect(lines(text).map((r) => r.id)).toEqual(['a', 'b', 'o']);
    });

    it('is empty text for nothing to write', () => {
        expect(buildDataset({ trades: [], orders: [], windows: {} })).toBe('');
    });
});

import { MemoryEvidenceStore, createIndexedDbStore, type EvidenceStore } from '../src/widget/trading-sim/evidence-store';
import { TradeEvidence } from '../src/widget/trading-sim/trade-evidence';
import { fitWidth, afterPaint } from '../src/widget/trading-sim/trade-shot';

const failingStore = (): EvidenceStore => {
    const boom = (): Promise<never> => Promise.reject(new Error('quota'));
    return { putWindow: boom, getWindow: boom, putShot: boom, getShot: boom, removeShot: boom, remove: boom, clear: boom };
};

describe('evidence store', () => {
    it('keeps windows and shots by trade id', async () => {
        const s = new MemoryEvidenceStore();
        await s.putWindow('a', [candle(1)]);
        await s.putShot('a', 'open', PNG);
        await s.putShot('a', 'close', WEBP);
        expect(await s.getWindow('a')).toEqual([candle(1)]);
        expect(await s.getShot('a', 'open')).toBe(PNG);
        expect(await s.getShot('b', 'open')).toBeUndefined();
        await s.removeShot('a', 'open');
        expect(await s.getShot('a', 'open')).toBeUndefined();
        expect(await s.getShot('a', 'close')).toBe(WEBP);
        await s.remove('a');
        expect(await s.getWindow('a')).toBeUndefined();
        expect(await s.getShot('a', 'close')).toBeUndefined();
        await s.putWindow('x', [candle(2)]);
        await s.clear();
        expect(await s.getWindow('x')).toBeUndefined();
    });

    it('has no IndexedDB store where the browser offers none', () => {
        expect(createIndexedDbStore(undefined)).toBeNull();
    });
});

describe('trade evidence', () => {
    it('saves the context and every later candle of its market', async () => {
        const store = new MemoryEvidenceStore();
        const ev = new TradeEvidence(store, () => {});
        ev.begin('a', 'BTC', '60', 10, Promise.resolve(win(1, 10)));
        ev.append('BTC', '60', candle(10));
        ev.append('BTC', '60', candle(11));
        ev.append('ETH', '60', candle(12));
        ev.append('BTC', '60', candle(12));
        await ev.finish('a');
        expect((await store.getWindow('a'))!.map((c) => c[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        ev.append('BTC', '60', candle(13));
        await ev.finish('a');
        expect(lastTime((await store.getWindow('a'))!)).toBe(12);
    });

    it('a context later than the placement bar is cut at the placement bar', async () => {
        const store = new MemoryEvidenceStore();
        const ev = new TradeEvidence(store, () => {});
        ev.begin('a', 'BTC', '60', 5, Promise.resolve(win(1, 9)));
        await ev.finish('a');
        expect(lastTime((await store.getWindow('a'))!)).toBe(5);
    });

    it('stores nothing for a discarded trade', async () => {
        const store = new MemoryEvidenceStore();
        const ev = new TradeEvidence(store, () => {});
        ev.begin('a', 'BTC', '60', 10, Promise.resolve(win(1, 10)));
        ev.discard('a');
        await ev.finish('a');
        expect(await store.getWindow('a')).toBeUndefined();
    });

    it('reports a failing store once and keeps working', async () => {
        let errors = 0;
        const ev = new TradeEvidence(failingStore(), () => (errors += 1));
        ev.begin('a', 'BTC', '60', 10, Promise.resolve(win(1, 10)));
        await expect(ev.finish('a')).resolves.toBeUndefined();
        await expect(ev.saveShot('a', 'open', PNG)).resolves.toBeUndefined();
        await expect(ev.remove('a')).resolves.toBeUndefined();
        await expect(ev.clear()).resolves.toBeUndefined();
        await expect(ev.shot('a', 'open')).resolves.toBeUndefined();
        expect(errors).toBe(1);
    });

    it('treats a context that fails to load as empty and reports it', async () => {
        const store = new MemoryEvidenceStore();
        let errors = 0;
        const ev = new TradeEvidence(store, () => (errors += 1));
        ev.begin('a', 'BTC', '60', 10, Promise.reject(new Error('offline')));
        ev.append('BTC', '60', candle(11));
        await ev.finish('a');
        expect((await store.getWindow('a'))!.map((c) => c[0])).toEqual([11]);
        expect(errors).toBe(1);
    });

    it('saves no screenshot when they are off or the capture failed', async () => {
        const store = new MemoryEvidenceStore();
        const ev = new TradeEvidence(store, () => {});
        ev.screenshots = false;
        await ev.saveShot('a', 'open', PNG);
        expect(await store.getShot('a', 'open')).toBeUndefined();
        ev.screenshots = true;
        await ev.saveShot('a', 'open', null);
        expect(await store.getShot('a', 'open')).toBeUndefined();
        await ev.saveShot('a', 'open', PNG);
        expect(await ev.shot('a', 'open')).toBe(PNG);
    });

    it('does nothing without a store', async () => {
        const ev = new TradeEvidence(null, () => {});
        ev.begin('a', 'BTC', '60', 10, Promise.resolve([]));
        await expect(ev.finish('a')).resolves.toBeUndefined();
        await expect(ev.saveShot('a', 'open', PNG)).resolves.toBeUndefined();
        expect(await ev.read(['a'])).toEqual({ windows: {}, images: {} });
    });

    it('reads and writes the data of a set of trades', async () => {
        const ev = new TradeEvidence(new MemoryEvidenceStore(), () => {});
        await ev.write({ windows: { a: win(1, 3) }, images: { a: { open: PNG }, b: { close: WEBP } } });
        expect(await ev.read(['a', 'b', 'c'])).toEqual({ windows: { a: win(1, 3) }, images: { a: { open: PNG }, b: { close: WEBP } } });
    });
});

describe('screenshots', () => {
    it('shrinks wide images and leaves narrow ones', () => {
        expect(fitWidth(3200, 1600)).toEqual({ width: 1600, height: 800 });
        expect(fitWidth(800, 600)).toEqual({ width: 800, height: 600 });
    });

    it('waits for the given number of animation frames', async () => {
        let frames = 0;
        await afterPaint({ requestAnimationFrame: (cb: FrameRequestCallback) => { frames += 1; cb(0); return frames; } });
        expect(frames).toBe(2);
    });
});
