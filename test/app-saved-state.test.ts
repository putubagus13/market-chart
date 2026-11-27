import { describe, expect, it } from 'vitest';
import { sanitizeSavedState, sanitizingStorage } from '../app/saved-state';
import { SOURCES, type Reachability } from '../app/source';

const HYPERLIQUID = SOURCES[1]!;
const allUp: Reachability = { binance: true, hyperliquid: true, coinbase: true };
const binanceBlocked: Reachability = { binance: false, hyperliquid: true, coinbase: false };
const LIGHT = '#ffffff';

/** A saved workspace document the way VelaWorkspace writes it, one chart saved on the dark theme. */
const saved = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        version: 1,
        layout: '1',
        charts: [
            {
                id: 'c1',
                symbol: 'binance:BTCUSDT',
                provider: 'binance',
                timeframe: '240',
                priceStyle: 'candles',
                drawings: [{ kind: 'line' }],
                indicators: [{ id: 'ema' }],
                rendererConfig: { version: 1, layout: { background: '#151619', textColor: '#b2b5be' }, grid: { vertLines: { color: '#20222c' } } },
                ...over,
            },
        ],
    });
const chart = (raw: string, i = 0) => (JSON.parse(raw) as { charts: Record<string, unknown>[] }).charts[i]!;

describe('sanitizeSavedState: the theme asked for wins over the one saved', () => {
    it('drops the saved renderer colours when they belong to another theme, and keeps everything else', () => {
        const c = chart(sanitizeSavedState(saved(), { themeBackground: LIGHT, reachable: allUp, fallback: null }));
        expect(c.rendererConfig).toBeUndefined();
        expect(c).toMatchObject({ id: 'c1', timeframe: '240', priceStyle: 'candles', drawings: [{ kind: 'line' }], indicators: [{ id: 'ema' }] });
    });

    it('keeps the saved renderer settings when they already match the requested theme', () => {
        const c = chart(sanitizeSavedState(saved(), { themeBackground: '#151619', reachable: allUp, fallback: null }));
        expect(c.rendererConfig).toBeDefined();
    });

    it('compares colours without caring about letter case', () => {
        const c = chart(sanitizeSavedState(saved(), { themeBackground: '#151619'.toUpperCase(), reachable: allUp, fallback: null }));
        expect(c.rendererConfig).toBeDefined();
    });
});

describe('sanitizeSavedState: a saved symbol from a blocked source must not strand the chart', () => {
    const ctx = { themeBackground: '#151619', reachable: binanceBlocked, fallback: HYPERLIQUID };

    it('moves a chart whose source is unreachable to the source that works, keeping its timeframe', () => {
        const c = chart(sanitizeSavedState(saved(), ctx));
        expect(c).toMatchObject({ symbol: 'hyperliquid:BTC', provider: 'hyperliquid', timeframe: '240' });
    });

    it('leaves a chart alone while its source is reachable (the visitor’s own choice stands)', () => {
        const c = chart(sanitizeSavedState(saved({ symbol: 'hyperliquid:ETH', provider: 'hyperliquid' }), ctx));
        expect(c).toMatchObject({ symbol: 'hyperliquid:ETH', provider: 'hyperliquid' });
    });

    it('has nowhere to move it when nothing is reachable, so it leaves the chart as saved', () => {
        const c = chart(sanitizeSavedState(saved(), { ...ctx, fallback: null, reachable: { binance: false, hyperliquid: false, coinbase: false } }));
        expect(c).toMatchObject({ symbol: 'binance:BTCUSDT', provider: 'binance' });
    });

    it('does not touch a provider it does not know', () => {
        const c = chart(sanitizeSavedState(saved({ symbol: 'acme:X', provider: 'acme' }), ctx));
        expect(c).toMatchObject({ symbol: 'acme:X', provider: 'acme' });
    });

    it('treats every saved chart, not just the first', () => {
        const doc = JSON.parse(saved()) as { charts: Record<string, unknown>[] };
        doc.charts.push({ ...doc.charts[0], id: 'c2', symbol: 'coinbase:ETH-USD', provider: 'coinbase' });
        const out = sanitizeSavedState(JSON.stringify(doc), ctx);
        expect(chart(out, 0).provider).toBe('hyperliquid');
        expect(chart(out, 1).provider).toBe('hyperliquid');
    });
});

describe('sanitizeSavedState: input it cannot read is passed through untouched', () => {
    const ctx = { themeBackground: LIGHT, reachable: binanceBlocked, fallback: HYPERLIQUID };
    it.each(['', 'not json', '[]', '{"version":1}', '{"charts":"nope"}', 'null'])('%j', (raw) => {
        expect(sanitizeSavedState(raw, ctx)).toBe(raw);
    });
});

describe('sanitizingStorage', () => {
    const ctx = { themeBackground: LIGHT, reachable: binanceBlocked, fallback: HYPERLIQUID };

    it('sanitizes what the workspace reads and leaves what it writes alone', () => {
        const writes: [string, string][] = [];
        const store = sanitizingStorage({ get: () => saved(), set: (k, v) => void writes.push([k, v]) }, ctx);
        const c = chart(store.get('chartlab') as string);
        expect(c).toMatchObject({ provider: 'hyperliquid' });
        expect(c.rendererConfig).toBeUndefined();
        store.set('chartlab', 'x');
        expect(writes).toEqual([['chartlab', 'x']]);
    });

    it('handles an asynchronous backing store and an empty one', async () => {
        const asyncStore = sanitizingStorage({ get: () => Promise.resolve(saved()), set: () => undefined }, ctx);
        expect(chart((await asyncStore.get('k')) as string).provider).toBe('hyperliquid');
        expect(sanitizingStorage({ get: () => null, set: () => undefined }, ctx).get('k')).toBeNull();
    });
});
